import { retainedMargin } from "./retained-margin.ts";
import { accrueNetworkHours } from "../network/accrual.ts";
import { runMakegood } from "./makegood.ts"; // V6 R
import { addPendingNetworkPayouts, networkPayout, type PayoutTransport } from "../network/payout.ts";
import { skipSanctionedPayout } from "../network/sanctions.ts";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { idHash, type Hex } from "../lib/hash.ts";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, generations, holds, keys, kv, ledger, models, payouts, providers, royalties, settlements, slashes, spentRoots } from "../db/schema.ts";
import { creditClosures, feeDistributions, serviceFees, type RefundPlanItem } from "../solana/credits-schema.ts";
import { buildPayRefundInstructions, creditAccountAddress, creditsAccounts, creditsProgram, readCreditAccount, readCreditsConfig, readDepositorShare, readRefundRequest, readSettleLimiter, type CreditsProgram } from "../solana/credits.ts";
import { allowanceNow, expiredSweptEvents, hourOf, noticeExpiryIx, sweepExpiredIx } from "../solana/programs/credits.ts";
import { chainKeyHashBytes } from "../solana/keys.ts";
import { creditsExpiryExemption, expiryNoticeKey, type ExpiryNotice } from "../holders/credits-expiry.ts";
import { distributeIx, feeRouterPdas, fundFeeVaultIx, isTreasuryOnly, TREASURY_BPS, updateFeeConfigIx, weekPeriod, WORKERS_BPS } from "../solana/programs/fee-router.ts";
import { withRetry } from "../solana/rpc.ts";
import { readVerifiedAccount } from "../solana/verified-account.ts";
import { feeConfigSpec } from "../solana/account-specs.ts";
import { cancelPlannedClosure, markClosureCancelled, reconcileDeposits, reconcileKey } from "../solana/credits-indexer.ts";
import { allocateRefund, refundOrder, sharesAndLots } from "../solana/credits-shares.ts";
import { DEPOSIT_RECONCILIATION_KEY } from "./readiness.ts";
import { assertNotSanctioned, isSanctioned, sanctionsListCurrent } from "../network/sanctions.ts";
import { post } from "../ledger/ledger.ts";
import { mulBps, picoToUsdc, picoToUsdString, usdcToPico } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { SpentTree } from "../receipts/merkle.ts";

// settlement (hourly):
//  1. provider invoices from receipts (per provider per hour): upstream cost, the provider-side fee (PROVIDER_FEE_BPS: 0, zero markup)
//  2. weekly USDC payouts to providers that opted into on-chain payout: trellis_credits::settle_to_host(amount,
//     hour_root_ref) from the credits vault, which the program bounds by spent_total - settled_total (so hosts are only
//     ever paid out of spend a committed root covers). Hosts are paid their list price (the invoice net of the
//     provider-side fee, which is 0 by default); that fee goes the same way into the fee router's vault for the weekly distribute (6). Payout
//     addresses are screened against the sanctions list first; a payout the committed spend does not cover yet stays
//     pending for the next run. There is no worker pool allocated by receipts.
//  3. creator royalty streams per model per hour (ledger only on Solana; no royalty program in build-order steps 1-3)
//  4. prepaid spent roots: every funded key's cumulative on-chain spend in a tree sorted by key hash, committed
//     hourly to trellis_credits as commit_spent_root(hour, root, spent_delta) (one SpentRoot per hour, hours strictly
//     increasing; spent_delta advances config.spent_total, which bounds host settlement) so closure refunds and disputes
//     are provably bounded. Credits are spend-only: the root bounds what a closure may refund, never a withdrawal.
//  5. account-closure refunds after the program's refund delay and a sanctions check (payClosureRefunds)
//  6. weekly fee distribution through trellis_fee_router::distribute (distributeFees): no fee split, 100% to the
//     treasury (workers 0 / treasury 10,000 bps)
//  7. weekly flat service fees to relay operators and canary runners (SERVICE_FEE_RECIPIENTS) from the treasury
//     settlement wallet, sanctions-screened (payServiceFees)
//  8. credits expiry, only with CREDITS_EXPIRY_ENABLED (expireCredits): notice_expiry for an expired balance (with an
//     inbox notice for the owner), then sweep_expired(amount = the key's unspent balance) after the grace period (30
//     days at least); never for a key whose wallet holds a tier with credits_never_expire

const hourKey = (d: Date) => d.toISOString().slice(0, 13);
const USAGE_KINDS = new Set(["usage"]);
/** Chain events that take a key's deposit back out of the vault to its owner: the EVM-era `Withdrawn`, and `RefundPaid` (pay_refund after close_account). */
const OUTFLOW_EVENTS = ["Withdrawn", "RefundPaid"];
/**
 * Ledger kinds that mirror on-chain money rather than usage or an off-chain credit: deposits and credits come in through
 * the vault, and the rest are the ledger's copy of USDC that left the vault without being spent (a closure refund paid
 * to the owner, expired credits swept to the treasury). None of them is spend: a closure refund counted as spend would
 * raise spent_total by money that is no longer in the vault, and settle_to_host could then pay hosts out of other keys'
 * deposits.
 */
const VAULT_MIRROR_KINDS = new Set(["deposit", "credit", "paywith", "withdrawal_lock", "withdrawal_release", "withdrawal", "closure_refund", "credit_expiry"]);

async function getKv<T>(ctx: Ctx, k: string): Promise<T | null> {
  const [r] = await ctx.db.select().from(kv).where(eq(kv.key, k));
  return (r?.value as T) ?? null;
}
async function setKv(ctx: Ctx, k: string, v: unknown) {
  await ctx.db.insert(kv).values({ key: k, value: v }).onConflictDoUpdate({ target: kv.key, set: { value: v, updatedAt: new Date() } });
}

/** 1 + 3: close every complete hour that has unsettled generations. */
export async function settleHours(ctx: Ctx, now = new Date()) {
  const networkHosts = await accrueNetworkHours(ctx, now);
  const currentHour = hourKey(now);
  const rows = await ctx.db
    .select({ id: generations.id, ts: generations.ts, providerId: generations.providerId, modelId: generations.modelId, tokensIn: generations.tokensIn, tokensOut: generations.tokensOut, upstream: generations.upstreamCost, royalty: generations.royalty, margin: generations.margin, mode: generations.mode })
    .from(generations)
    .where(and(isNull(generations.settledPeriod), lt(generations.ts, new Date(currentHour + ":00:00.000Z"))))
    .orderBy(asc(generations.ts))
    .limit(100_000);
  if (!rows.length) return { periods: 0 };
  const inv = new Map<string, { providerId: string; period: string; tokens: bigint; requests: number; upstream: bigint }>();
  const roy = new Map<string, { modelId: string; period: string; amount: bigint }>();
  let margin = 0n;
  for (const g of rows) {
    const period = hourKey(g.ts);
    if (g.mode !== "cache" && g.mode !== "byok" && g.providerId !== "cache" && !networkHosts.has(g.providerId)) {
      const k = `${g.providerId}|${period}`;
      const e = inv.get(k) ?? { providerId: g.providerId, period, tokens: 0n, requests: 0, upstream: 0n };
      e.tokens += BigInt(g.tokensIn + g.tokensOut);
      e.requests++;
      e.upstream += g.upstream;
      inv.set(k, e);
    }
    if (g.royalty > 0n) {
      const k = `${g.modelId}|${period}`;
      const e = roy.get(k) ?? { modelId: g.modelId, period, amount: 0n };
      e.amount += g.royalty;
      roy.set(k, e);
    }
    margin += g.margin;
  }
  await ctx.db.transaction(async (tx) => {
    for (const e of inv.values()) {
      const fee = mulBps(e.upstream, ctx.cfg.fees.providerFeeBps, "floor");
      const owed = picoToUsdc(e.upstream - fee, "floor");
      await tx
        .insert(settlements)
        .values({ providerId: e.providerId, period: e.period, tokens: e.tokens, requests: e.requests, upstream: e.upstream, fee, usdcOwed: owed })
        .onConflictDoUpdate({
          target: [settlements.providerId, settlements.period],
          set: {
            tokens: sql`${settlements.tokens} + ${e.tokens}`,
            requests: sql`${settlements.requests} + ${e.requests}`,
            upstream: sql`${settlements.upstream} + ${e.upstream}`,
            fee: sql`${settlements.fee} + ${fee}`,
            usdcOwed: sql`${settlements.usdcOwed} + ${owed}`,
          },
        });
      margin += fee;
    }
    const creators = await tx.select({ id: models.id, creator: models.creator }).from(models);
    const cm = new Map(creators.map((m) => [m.id, m.creator]));
    for (const e of roy.values()) {
      await tx
        .insert(royalties)
        .values({ modelId: e.modelId, period: e.period, amount: e.amount, usdc: picoToUsdc(e.amount, "floor"), creator: cm.get(e.modelId) ?? null })
        .onConflictDoUpdate({ target: [royalties.modelId, royalties.period], set: { amount: sql`${royalties.amount} + ${e.amount}`, usdc: sql`${royalties.usdc} + ${picoToUsdc(e.amount, "floor")}` } });
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const ids = rows.slice(i, i + 1000).map((r) => r.id);
      await tx.update(generations).set({ settledPeriod: sql`to_char(${generations.ts} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')` }).where(inArray(generations.id, ids));
    }
    const prev = BigInt(((await tx.select().from(kv).where(eq(kv.key, "margin_unsent")))[0]?.value as string) ?? "0");
    await tx.insert(kv).values({ key: "margin_unsent", value: (prev + margin).toString() }).onConflictDoUpdate({ target: kv.key, set: { value: (prev + margin).toString(), updatedAt: new Date() } });
  });
  return { periods: inv.size, royalties: roy.size, generations: rows.length };
}

/**
 * 4: Spent-root allocation. On-chain, each key hash k has deposited_k (Deposited + Credited) and
 * withdrawn_k; Credits lets k withdraw deposited_k - spent_k - withdrawn_k. Off-chain an account may
 * own several key hashes and also hold off-chain-only credits (refunds, per-call change) that are not
 * withdrawable. We allocate each account's usage to its key hashes FIFO, after first consuming the
 * off-chain credits, and ratchet the on-chain consumption so it never decreases:
 *   U_on = max(previous U_on, usage - offchainCredits),   spent_k filled in deposit order.
 * Then sum_k(withdrawable_k) = D - W - U_on <= off-chain balance, so withdrawals can never exceed
 * what the account really has, and totalSpent (sum of U_on) is monotonic as Credits requires.
 *
 * On Solana the only way a deposit returns to its owner is the closure refund (close_account, then
 * pay_refund): its `RefundPaid` event counts as a withdrawal of that key, and its ledger row
 * (`closure_refund`) is neither usage nor an off-chain credit. Expired credits swept to the treasury
 * (`credit_expiry`) are treated the same way on the ledger side.
 *
 * No leaf ever exceeds its key's deposits minus withdrawals (Credits' rule), withdrawals made with an
 * absence proof included. Usage beyond the account's net on-chain funding (a credit line, or spend a
 * root omitted before the key exited) is `uncovered`: the operator's loss unless the account funds it
 * later, and never part of `settledTotal`, the usage settlement may sweep.
 */
export async function computeSpentLeaves(ctx: Ctx, only?: { accountId: string }, opts: { /** Count open holds as spent (only for what a closure may refund; never for a root). */ holds?: boolean } = {}) {
  const keyHashArg = sql<string>`lower(${chainEvents.args}->>'keyHash')`;
  const deposits = await ctx.db
    .select({ keyHash: keyHashArg, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)`, first: sql<string>`min(${chainEvents.blockNumber})` })
    .from(chainEvents)
    // An event the chain does not back (`deposit_not_on_chain`) is not funding. Deposits credited from chain state whose
    // events were never read are on file as one "Credited" row per key (src/solana/credits-indexer.ts).
    .where(and(eq(chainEvents.contract, "credits"), inArray(chainEvents.event, ["Deposited", "Credited"]), sql`${chainEvents.error} is distinct from 'deposit_not_on_chain'`))
    .groupBy(keyHashArg);
  const withdrawnRows = await ctx.db
    .select({ keyHash: keyHashArg, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)` })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "credits"), inArray(chainEvents.event, OUTFLOW_EVENTS)))
    .groupBy(keyHashArg);
  // Chain events carry the key hash as 0x-hex; keys.chainKeyHash is bare hex. Leaves keep the 0x form (sorted as numbers).
  const bare = (h: string) => h.toLowerCase().replace(/^0x/, "");
  const leafId = (h: string) => `0x${bare(h)}`;
  const withdrawn = new Map(withdrawnRows.map((r) => [bare(r.keyHash), BigInt(r.amount)]));
  const keyRows = await ctx.db.select({ chainKeyHash: keys.chainKeyHash, accountId: keys.accountId }).from(keys);
  const accountOf = new Map(keyRows.map((k) => [bare(k.chainKeyHash), k.accountId]));
  if (only) for (const [h, a] of accountOf) if (a !== only.accountId) accountOf.delete(h);
  const byAccount = new Map<string, { keyHash: string; deposited: bigint; withdrawn: bigint; first: bigint }[]>();
  const orphan: string[] = [];
  for (const d of deposits) {
    const acct = accountOf.get(bare(d.keyHash));
    if (!acct) {
      if (!only) orphan.push(leafId(d.keyHash));
      continue;
    }
    const list = byAccount.get(acct) ?? [];
    list.push({ keyHash: leafId(d.keyHash), deposited: BigInt(d.amount), withdrawn: withdrawn.get(bare(d.keyHash)) ?? 0n, first: BigInt(d.first) });
    byAccount.set(acct, list);
  }
  const ratchet = (await getKv<Record<string, string>>(ctx, "spent_ratchet")) ?? {};
  let settledTotal = 0n; // settled on-chain usage that deposits cover: the most settlement may ever sweep
  const uncovered = new Map<string, bigint>(); // account -> settled usage beyond its keys' net funding (USDC)
  const leaves: [string, bigint][] = orphan.map((h) => [h, 0n]); // funded but unclaimed keys: nothing spent
  for (const [acct, list] of byAccount) {
    list.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.keyHash < b.keyHash ? -1 : a.keyHash > b.keyHash ? 1 : 0));
    const rows = await ctx.db
      .select({ kind: ledger.kind, pos: sql<string>`coalesce(sum(case when ${ledger.amount} > 0 then ${ledger.amount} else 0 end), 0)`, neg: sql<string>`coalesce(sum(case when ${ledger.amount} < 0 then -${ledger.amount} else 0 end), 0)` })
      .from(ledger)
      .where(eq(ledger.accountId, acct))
      .groupBy(ledger.kind);
    let usage = 0n; // pico
    let offchain = 0n; // pico: credits not backed by this account's on-chain deposits
    for (const r of rows) {
      if (USAGE_KINDS.has(r.kind)) usage += BigInt(r.neg) - BigInt(r.pos);
      else if (!VAULT_MIRROR_KINDS.has(r.kind)) offchain += BigInt(r.pos) - BigInt(r.neg);
    }
    const usageUsdc = picoToUsdc(usage - offchain > 0n ? usage - offchain : 0n, "ceil");
    const settledOnchain = BigInt(ratchet[acct] ?? "0") > usageUsdc ? BigInt(ratchet[acct] ?? "0") : usageUsdc;
    ratchet[acct] = settledOnchain.toString();
    // Security review R4-24: a root commits SETTLED spend only. Open holds used to be added (worst case), but the
    // program's spent_total only rises and a hold is several times real usage (R3-02): holds that were later released
    // left spent_total above real spend, which weakens the bound on host payouts and can make the next root fail.
    // What a closure may refund still excludes open holds: withdrawableFor asks for them (`holds`), and the refund
    // plan is capped by the account's available balance under its row lock.
    const [{ held }] = opts.holds ? await ctx.db.select({ held: accounts.held }).from(accounts).where(eq(accounts.id, acct)) : [{ held: 0n }];
    const onchain = settledOnchain + picoToUsdc(held > 0n ? held : 0n, "ceil");
    const funded = list.reduce((a, k) => a + (k.deposited - k.withdrawn > 0n ? k.deposited - k.withdrawn : 0n), 0n);
    settledTotal += settledOnchain < funded ? settledOnchain : funded;
    if (settledOnchain > funded) uncovered.set(acct, settledOnchain - funded);
    // Each leaf is capped at its key's deposits minus withdrawals, so every key of an account whose
    // usage outruns its funding is already at zero withdrawable; the excess is on no leaf at all.
    let remaining = onchain;
    for (const k of list) {
      const capacity = k.deposited - k.withdrawn > 0n ? k.deposited - k.withdrawn : 0n;
      const spent = remaining < capacity ? remaining : capacity;
      remaining -= spent;
      leaves.push([k.keyHash, spent]);
    }
  }
  leaves.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
  return { leaves, ratchet, settledTotal, uncovered, capacity: byAccount };
}

/** What `chainKeyHash` could withdraw on-chain right now (USDC base units): its own deposits minus
 *  what it already withdrew minus the usage (incl. open holds) allocated to it. */
export async function withdrawableFor(ctx: Ctx, accountId: string, chainKeyHash: string) {
  const { leaves, capacity } = await computeSpentLeaves(ctx, { accountId }, { holds: true });
  const kh = `0x${chainKeyHash.toLowerCase().replace(/^0x/, "")}`;
  const k = capacity.get(accountId)?.find((x) => x.keyHash === kh);
  if (!k) return 0n;
  const spent = leaves.find(([h]) => h === kh)?.[1] ?? 0n;
  const w = k.deposited - k.withdrawn - spent;
  return w > 0n ? w : 0n;
}

/** The on-chain hour a candidate root is committed under (its as-of time floored to the hour). */
export const spentRootHour = (asOf: Date) => hourOf(Math.floor(asOf.getTime() / 1000));

/** Retain the exact candidate while governance reviews it; retries never silently replace its leaves. */
async function submitSpentRoot(ctx: Ctx, row: typeof spentRoots.$inferSelect, landedTotal: bigint) {
  const hour = spentRootHour(row.asOf);
  const spentDelta = row.totalSpentUsdc > landedTotal ? row.totalSpentUsdc - landedTotal : 0n;
  const approval = ctx.chain.spentRootApproval(row.epoch, row.root as Hex, hour, spentDelta);
  if (!await ctx.chain.isSpentRootApproved(row.root as Hex, hour, spentDelta)) {
    await ctx.db.update(spentRoots).set({ status: "awaiting_approval" }).where(eq(spentRoots.epoch, row.epoch));
    return { posted: false, reason: "awaiting independent approval", epoch: row.epoch, root: row.root, approval };
  }
  await ctx.db.update(spentRoots).set({ status: "pending" }).where(eq(spentRoots.epoch, row.epoch));
  try {
    const r = await ctx.chain.postSpentRoot(row.root as Hex, hour, spentDelta);
    await ctx.db.update(spentRoots).set({ status: "confirmed", txHash: r.hash }).where(eq(spentRoots.epoch, row.epoch));
    return { posted: true, epoch: row.epoch, root: row.root, hour: hour.toString(), spent_delta: spentDelta.toString(), total_spent_usdc: row.totalSpentUsdc.toString(), tx: r.hash };
  } catch (e) {
    log.error("postSpentRoot failed", { epoch: row.epoch, error: (e as Error).message });
    return { posted: false, reason: "submission failed; candidate retained", epoch: row.epoch, root: row.root, tx: null };
  }
}

// ---- After a database restore (security review R5-08) ---------------------------------------------------------------
//
// A database restored from a backup is BEHIND the chain: the debits made since the backup are gone, so every balance
// in it is too high, and a refund or a payout computed from it pays out money that was already spent. The one thing
// that reliably shows it is the spent root: the chain holds a root (a later hour, or a larger total) this database
// does not know. From the moment that is seen, or from the moment the restore procedure says so itself
// (scripts/restore-db.sh sets the same row), EVERY vault outflow computed from the ledger is frozen: the spent root,
// closure refunds, host payouts, fees, the expiry sweep. Nothing in the router clears it: an operator runs
// scripts/restore-reconcile.ts, which rebuilds what can be rebuilt from the chain, reports what cannot, and unfreezes
// only when the gap that is left has been acknowledged. Raised as the readiness warning `restore_pending`.
//
// The freeze is a kv row, not process state: it survives restarts and holds on every worker. It is set, never cleared,
// by the router; a wrong freeze costs refunds a delay and an operator a command, a missing one costs the vault.

export const RESTORE_STATE_KEY = "restore_state";
export type RestoreState = { frozen: boolean; since: string; reason: string; chain?: { hour: string; root: string; total_spent: string }; database?: { hour: string; total_spent: string } | null };
export const RESTORE_PENDING_LOG = "settlement: vault outflows frozen, this database is behind the chain (restored from a backup?)";
const RESTORE = { skipped: "restore_pending" } as const;

export const restoreState = (ctx: Ctx): Promise<RestoreState | null> => getKv<RestoreState>(ctx, RESTORE_STATE_KEY);

/** Freeze vault outflows. Idempotent: an existing freeze keeps its first reason and time. */
export async function freezeForRestore(ctx: Ctx, state: Omit<RestoreState, "frozen" | "since">): Promise<RestoreState> {
  const existing = await restoreState(ctx);
  if (existing?.frozen) return existing;
  const next: RestoreState = { frozen: true, since: new Date().toISOString(), ...state };
  await setKv(ctx, RESTORE_STATE_KEY, next);
  log.error(RESTORE_PENDING_LOG, { event: "restore_pending", reason: state.reason, chain_hour: state.chain?.hour ?? null, database_hour: state.database?.hour ?? null });
  return next;
}

/** The readiness warning for a pending restore (services/round4-warnings.ts). */
export async function restoreWarnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const r = await restoreState(ctx);
  if (!r?.frozen) return [];
  return [{ code: "restore_pending", reason: r.reason.slice(0, 120), message: `Vault outflows (spent roots, closure refunds, payouts, sweeps) have been frozen since ${r.since}: ${r.reason}. Run scripts/restore-reconcile.ts (MAINNET.md, "The database is lost"); nothing else clears this.` }];
}

/**
 * The chain's spent root and this database's do not agree. When the CHAIN is ahead (a later hour, or a larger total),
 * the database is behind it: freeze before throwing, so the steps after this one are not run from a stale ledger.
 */
async function spentRootMismatch(ctx: Ctx, landed: { hour: bigint; root: string; totalSpent: bigint }, last: { asOf: Date; totalSpentUsdc: bigint } | undefined): Promise<never> {
  const lastHour = last ? spentRootHour(last.asOf) : 0n;
  if (landed.hour > lastHour || landed.totalSpent > (last?.totalSpentUsdc ?? 0n))
    await freezeForRestore(ctx, { reason: "the chain holds a spent root this database does not know", chain: { hour: landed.hour.toString(), root: landed.root, total_spent: landed.totalSpent.toString() }, database: last ? { hour: lastHour.toString(), total_spent: last.totalSpentUsdc.toString() } : null });
  throw new Error("Spent-root chain/database mismatch; reconcile before proposing another root");
}

export async function postSpentRoot(ctx: Ctx) {
  const onChain = !!(ctx.chain.address("credits") && ctx.chain.roleAddress("settlement"));
  let [last] = await ctx.db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1);
  let landedTotal = 0n;
  let landedHour = 0n;
  if (onChain) {
    // An RPC failure must never delete a candidate or masquerade as an unposted root.
    const landed = await ctx.chain.latestSpentRoot();
    landedTotal = landed.totalSpent;
    landedHour = landed.hour;
    const lastHour = last ? spentRootHour(last.asOf) : 0n;
    if (last && ["pending", "awaiting_approval"].includes(last.status)) {
      if (landed.hour === lastHour && landed.root === last.root && landed.totalSpent === last.totalSpentUsdc) {
        await ctx.db.update(spentRoots).set({ status: "confirmed" }).where(eq(spentRoots.epoch, last.epoch));
        last = { ...last, status: "confirmed" };
      } else if (landed.hour < lastHour) {
        // Not landed yet: the candidate's delta is what it adds to what the chain holds now.
        const [prev] = await ctx.db.select().from(spentRoots).where(eq(spentRoots.status, "confirmed")).orderBy(desc(spentRoots.epoch)).limit(1);
        if (prev && (landed.hour !== spentRootHour(prev.asOf) || landed.totalSpent !== prev.totalSpentUsdc)) await spentRootMismatch(ctx, landed, prev);
        return submitSpentRoot(ctx, last, landed.totalSpent);
      } else await spentRootMismatch(ctx, landed, last);
    }
    if (last && (landed.hour !== lastHour || landed.root !== last.root || landed.totalSpent !== last.totalSpentUsdc)) await spentRootMismatch(ctx, landed, last);
    if (!last && landed.hour !== 0n) await spentRootMismatch(ctx, landed, undefined);
  }
  const { leaves, ratchet, settledTotal, uncovered } = await computeSpentLeaves(ctx);
  if (!leaves.length) return { posted: false, reason: "no funded keys" };
  const tree = new SpentTree(leaves);
  const lastTotal = last ? last.totalSpentUsdc : 0n;
  const total = leaves.reduce((a, [, s]) => a + s, 0n);
  const totalSpent = total > lastTotal ? total : lastTotal;
  if (last && last.root === tree.root) return { posted: false, reason: "unchanged", epoch: last.epoch };
  const epoch = (last?.epoch ?? 0) + 1;
  let asOfSec = Math.floor(Date.now() / 1000);
  if (onChain) asOfSec = Math.min(asOfSec, await ctx.chain.latestBlockTime());
  if (last && asOfSec <= Math.floor(last.asOf.getTime() / 1000)) return { posted: false, reason: "chain time has not advanced past the last root", epoch: last.epoch };
  // One SpentRoot per hour on chain: the next candidate waits for the next hour.
  if (onChain && hourOf(asOfSec) <= landedHour) return { posted: false, reason: "the chain already holds a root for this hour", epoch: last?.epoch ?? 0, hour: landedHour.toString() };
  const [row] = await ctx.db.insert(spentRoots).values({ epoch, root: tree.root, asOf: new Date(asOfSec * 1000), totalSpentUsdc: totalSpent, leaves: tree.entries().map(([h, s]) => [h, s.toString()]), status: "pending" }).returning();
  await setKv(ctx, "spent_ratchet", ratchet);
  // Holds can be included in the root. Approvers must cap transfers at independently verified settled
  // usage that deposits cover; usage beyond them is the operator's loss, recorded per root.
  await setKv(ctx, `spent_settled:${epoch}`, settledTotal.toString());
  const uncoveredTotal = [...uncovered.values()].reduce((a, b) => a + b, 0n);
  await setKv(ctx, `spent_uncovered:${epoch}`, uncoveredTotal.toString());
  if (uncoveredTotal > 0n) log.warn("usage exceeds on-chain funds; uncovered amount absorbed by operator unless the accounts fund it", { epoch, accounts: uncovered.size, uncovered_usdc: uncoveredTotal.toString() });
  if (onChain) return submitSpentRoot(ctx, row, landedTotal);
  await ctx.db.update(spentRoots).set({ status: "local" }).where(eq(spentRoots.epoch, epoch));
  return { posted: true, epoch, root: tree.root, keys: leaves.length, total_spent_usdc: totalSpent.toString(), tx: null };
}

/**
 * What the credits vault may still pay hosts: the latest committed SpentRoot's hour (settle_to_host must reference one)
 * and spent_total - settled_total. Null when the credits program or the settlement key is not configured.
 */
export async function settlementAllowance(ctx: Ctx): Promise<{ hourRef: bigint; available: bigint } | null> {
  if (!ctx.chain.address("credits") || !ctx.chain.roleAddress("settlement")) return null;
  const c = await ctx.chain.creditsConfigOnChain();
  if (!c || c.latestHour <= 0n) return { hourRef: 0n, available: 0n };
  return { hourRef: c.latestHour, available: c.spentTotal > c.settledTotal ? c.spentTotal - c.settledTotal : 0n };
}

/**
 * 2: weekly payouts for providers paid in USDC on-chain, each a settle_to_host from the credits vault; the fee share of
 * what was paid follows into the fee router's vault. Invoice providers are just marked. A payout stays pending while
 * committed spend does not cover it, or while no root is committed at all; the next run retries it.
 */
export async function runPayouts(ctx: Ctx, minAgeMs = 7 * 86_400_000, deps: { transport?: PayoutTransport } = {}) {
  const cutoff = hourKey(new Date(Date.now() - minAgeMs));
  const due = await ctx.db
    .select({ providerId: settlements.providerId, owed: sql<string>`sum(${settlements.usdcOwed})` })
    .from(settlements)
    .where(and(isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`))
    .groupBy(settlements.providerId);
  // Payouts held back earlier (committed spend did not cover them) are retried before new claims.
  const held = await ctx.db.select({ providerId: payouts.providerId }).from(payouts).innerJoin(providers, eq(providers.id, payouts.providerId)).where(and(eq(providers.networkHost, false), eq(payouts.status, "pending")));
  for (const hp of held) if (!due.some((d) => d.providerId === hp.providerId)) due.push({ providerId: hp.providerId, owed: "0" });
  await addPendingNetworkPayouts(ctx, due);
  const out: unknown[] = [];
  let allowance: Awaited<ReturnType<typeof settlementAllowance>> | undefined;
  let feePico = 0n; // the provider fee (PROVIDER_FEE_BPS, 0 by default) of the invoices paid this run, bound for the fee router's vault
  for (const d of due) {
    const [p] = await ctx.db.select().from(providers).where(eq(providers.id, d.providerId));
    if (!p) continue;
    if (await skipSanctionedPayout(ctx, p, out)) continue;
    if (await networkPayout(ctx, p, cutoff, out, deps.transport)) continue;
    const onchain = p.payoutMode === "usdc" && !!p.payoutAddress && !!ctx.chain.roleAddress("settlement");
    let [row] = await ctx.db.select().from(payouts).where(and(eq(payouts.providerId, p.id), eq(payouts.status, "pending"))).limit(1);
    if (row) {
      // Fold newly due invoices into the held payout so one transfer settles everything the host is owed.
      const fresh = BigInt(d.owed);
      if (fresh > 0n) {
        await ctx.db.update(settlements).set({ payoutId: row.id }).where(and(eq(settlements.providerId, p.id), isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`));
        [row] = await ctx.db.update(payouts).set({ usdc: row.usdc + fresh }).where(eq(payouts.id, row.id)).returning();
      }
      if (row.to !== p.payoutAddress) { out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: "payout address changed; reconcile the held payout" }); continue; }
    } else {
      const amount = BigInt(d.owed);
      if (amount <= 0n) continue;
      [row] = await ctx.db.insert(payouts).values({ id: uid("pay_"), providerId: p.id, usdc: amount, to: p.payoutAddress, status: onchain ? "pending" : "invoice" }).returning();
      await ctx.db.update(settlements).set({ payoutId: row.id }).where(and(eq(settlements.providerId, p.id), isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`));
    }
    if (!onchain || row.usdc <= 0n) { out.push({ provider: p.id, usdc: row.usdc.toString(), status: "invoice" }); continue; }
    allowance ??= await settlementAllowance(ctx);
    if (!allowance) { out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: "credits program not configured" }); continue; }
    if (allowance.hourRef <= 0n) { out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: "no spent root committed yet" }); continue; }
    const [{ fee }] = await ctx.db.select({ fee: sql<string>`coalesce(sum(${settlements.fee}), 0)` }).from(settlements).where(eq(settlements.payoutId, row.id));
    const invoiceFee = BigInt(fee);
    // The host's share and its fee both leave the vault, so both must fit under spent_total - settled_total.
    if (row.usdc + picoToUsdc(invoiceFee, "floor") > allowance.available) {
      log.warn("provider payout held: committed spend does not cover it yet", { provider: p.id, usdc: row.usdc.toString(), available: allowance.available.toString() });
      out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: "exceeds committed spend", available_usdc: allowance.available.toString() });
      continue;
    }
    try {
      const r = await ctx.chain.settleToHost(p.payoutAddress!, row.usdc, allowance.hourRef);
      allowance.available -= row.usdc;
      feePico += invoiceFee;
      await ctx.db.update(payouts).set({ status: "paid", tx: r.hash }).where(eq(payouts.id, row.id));
      await ctx.db.update(settlements).set({ paidTx: r.hash }).where(eq(settlements.payoutId, row.id));
      out.push({ provider: p.id, usdc: row.usdc.toString(), tx: r.hash, hour_root_ref: allowance.hourRef.toString() });
    } catch (e) {
      log.error("provider payout failed; held for the next run", { provider: p.id, error: (e as Error).message });
      out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: "submission_failed" });
    }
  }
  const fee = await settleFeeShare(ctx, feePico, allowance ?? null);
  return { payouts: out, ...(fee ? { fee } : {}) };
}

/**
 * The provider fee (PROVIDER_FEE_BPS; 0 by default, so normally nothing) of the invoices just paid, from the credits vault into trellis_fee_router's fee vault by the same
 * settle_to_host (bounded the same way), and off `margin_unsent` so distributeFees does not move it twice.
 */
async function settleFeeShare(ctx: Ctx, feePico: bigint, allowance: { hourRef: bigint; available: bigint } | null) {
  const feeRouter = ctx.cfg.solana.programs.feeRouter;
  const amount = picoToUsdc(feePico, "floor");
  if (amount <= 0n || !feeRouter || !allowance || allowance.hourRef <= 0n) return null;
  if (amount > allowance.available) return { usdc: amount.toString(), status: "pending", reason: "exceeds committed spend" };
  try {
    const r = await ctx.chain.settleToTokenAccount(feeRouterPdas(new PublicKey(feeRouter)).feeVault, amount, allowance.hourRef);
    allowance.available -= amount;
    const unsent = BigInt((await getKv<string>(ctx, "margin_unsent")) ?? "0");
    const moved = usdcToPico(amount);
    await setKv(ctx, "margin_unsent", (unsent > moved ? unsent - moved : 0n).toString());
    return { usdc: amount.toString(), tx: r.hash, hour_root_ref: allowance.hourRef.toString() };
  } catch (e) {
    log.error("fee share settlement failed; it stays in margin_unsent", { error: (e as Error).message });
    return { usdc: amount.toString(), status: "failed" };
  }
}

/** 3b: stream accrued royalties on-chain for models with a registered creator. */
export async function streamRoyalties(ctx: Ctx) {
  if (!ctx.chain.address("royalty") || !ctx.chain.roleAddress("settlement")) return { streamed: 0 };
  const due = await ctx.db
    .select({ modelId: royalties.modelId, usdc: sql<string>`sum(${royalties.usdc})` })
    .from(royalties)
    .where(and(isNull(royalties.streamTx), sql`${royalties.creator} IS NOT NULL`))
    .groupBy(royalties.modelId);
  let n = 0;
  for (const d of due) {
    const amount = BigInt(d.usdc);
    if (amount <= 0n) continue;
    try {
      const r = await ctx.chain.streamRoyalty(idHash(d.modelId), amount);
      await ctx.db.update(royalties).set({ streamTx: r.hash }).where(and(eq(royalties.modelId, d.modelId), isNull(royalties.streamTx)));
      n++;
    } catch (e) {
      log.error("royalty stream failed", { model: d.modelId, error: (e as Error).message });
    }
  }
  return { streamed: n };
}

// ---- 5: account-closure refunds (docs/Trellis_Backend.md §5.1) ------------------------------------------------------
// A closure sits in credit_closures. `queued`: the close_account transaction (signed by the key) was handed out; the job
// checks the chain for its RefundRequest (the indexer's CloseRequested event does the same) and marks it `registered`
// with the on-chain payable time (RefundRequest.payable_at: requested_at + the refund delay as it stood, 72h). From
// `registered` on the key is frozen: the ledger refuses new holds for it (src/ledger/ledger.ts), so its spending can
// only drain. A closure taken back on chain (cancel_close) becomes `cancelled` and the key is free again.
//
// WHERE a refund goes is not the key's choice (security re-review RR-05). close_account names no destination; the
// program pays a refund only to a wallet that deposited to the key, to the token account that wallet named
// (DepositorShare.refund_to, by default the account it paid from), and at most what that wallet put in. Whoever holds a
// leaked API key can close the account and nothing else: the money goes back where it came from.
//
// Once payable, in this order (security review TR-08, TR-14):
//  1. the key's open holds must have drained (a request still in flight has reserved part of the balance);
//  2. a closure whose key has been DISABLED at the router is held (`key_disabled`) until an owner of the account
//     releases it (POST /api/v1/credits/close/release) or the key is enabled again: revoking a leaked key stops the
//     closure it started, and the balance stays in the account for its other keys;
//  3. every deposit the chain holds for the key is brought into the ledger (reconcileKey), so the amount below cannot
//     miss one the indexer has not reached;
//  4. the key's depositors are read from the chain (their DepositorShare accounts, each owner- and PDA-checked), and for
//     each the token account that would be paid: its owner, the account and the depositor are screened against the
//     sanctions list. A sanctioned depositor is left out; an account that cannot receive waits;
//  5. under the closure's and the ledger account's row locks, in one database transaction: the refund is the least of
//     what the request still owes, the per-key cap, the account's AVAILABLE balance (balance minus every open hold) and
//     what this key's own deposits can still give back after the usage allocated to them (withdrawableFor). It is split
//     over the depositors LARGEST remaining share first, each capped at what the chain says that depositor can still be
//     refunded (security review round 3, R3-22: round 2 paid the most recent deposit first, which let a stranger queue
//     any number of small recent shares in front of the key's owner). Only the shares the refund can reach are read and
//     screened, and one run sends at most MAX_REFUND_SENDS_PER_CLOSURE payments per closure. The ledger debit and the
//     plan are written in that same transaction, before anything is sent, and the plan records the on-chain request it
//     was made for;
//  6. pay_refund sends each planned amount, within the program's refund allowance (the rest follows on a later run:
//     `refund_rate_limited`). What a depositor has already been paid is read from the chain (DepositorShare.refunded),
//     so a run that dies anywhere is finished by the next one; nothing is computed or debited twice;
//  7. a closure taken back on chain AFTER its refund was debited (cancel_close can land any time before the first
//     payment, also between the debit and the send) is undone as a whole: cancelPlannedClosure puts the debit back and
//     marks the closure cancelled in one transaction. A debited refund is either paid or reversed, never left frozen
//     (R3-06). A request that was cancelled and asked for again is a new closure with a new plan.

/** The most pay_refund transactions one run sends for one closure; the rest follow on later runs (R3-22). */
export const MAX_REFUND_SENDS_PER_CLOSURE = 16;

/** What the token account at `address` is, when it is a token account of `mint` that can receive: its owner. Null otherwise. */
async function refundDestination(ctx: Ctx, address: PublicKey, mint: PublicKey): Promise<{ owner: PublicKey } | null> {
  const info = await withRetry(() => ctx.chain.connection.getAccountInfo(address));
  if (!info || info.data.length < AccountLayout.span) return null;
  // Only an account a token program owns is a token account, whatever its bytes say (TR-02).
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const a = AccountLayout.decode(new Uint8Array(info.data).subarray(0, AccountLayout.span));
  if (!a.mint.equals(mint) || a.state !== 1) return null; // not this mint, uninitialised or frozen
  return { owner: a.owner };
}

/** What pay_refund may move right now: the program's refund allowance, from the limiter and the vault as they stand. */
async function refundAllowance(ctx: Ctx, program: CreditsProgram, now: Date): Promise<bigint> {
  const rpc = ctx.chain.connection;
  const limiter = await readSettleLimiter(rpc, program);
  if (!limiter) return 0n;
  const info = await withRetry(() => rpc.getAccountInfo(creditsAccounts(program).vault));
  const vault = info && info.data.length >= AccountLayout.span ? AccountLayout.decode(new Uint8Array(info.data).subarray(0, AccountLayout.span)).amount : 0n;
  // A few seconds behind the wall clock, so the program (which uses the cluster's clock) never has less than this.
  return allowanceNow(limiter, "refund", vault, BigInt(Math.floor(now.getTime() / 1000) - 5));
}

export async function payClosureRefunds(ctx: Ctx, now = new Date(), opts: { /** R5-08: keys whose deposits could not be read this run: their closures wait, everyone else's go on. */ skipKeys?: ReadonlySet<string> } = {}) {
  const program = creditsProgram(ctx.cfg);
  if (!program || !ctx.chain.roleAddress("settlement")) return { skipped: "credits program or settlement key not configured" };
  const rpc = ctx.chain.connection;
  // Security review R4-04. The job used to look at the 50 oldest open closures and at nothing else, so 50 requests that
  // never completed (asked for at the API and never signed, or held for any reason) stopped every later refund. Now:
  //   1. requests nobody signed are not work: one that is not on chain CLOSURE_UNSIGNED_TTL_S after it was asked for is
  //      cancelled (`expired_unsigned`); one that is on chain is registered. Younger ones are left alone.
  //   2. payable closures (registered, past their delay) are the work, oldest first, at most CLOSURE_RUN_BUDGET a run. A
  //      run that does not reach the end leaves a cursor, and the next run continues after it and wraps: a closure that
  //      cannot progress is passed, not waited on, and every payable closure is examined within ceil(n / budget) runs.
  //   3. closures still inside their delay get a small share of each run (a request taken back on chain is noticed).
  // services/closure-watch.ts alarms when the queue grows or a closure is unpaid a day after it became payable.
  const started = Date.now();
  const expiredUnsigned = await expireUnsignedClosures(ctx, program, now);
  const { due, cursors } = await closureWorkList(ctx, now);
  const out: unknown[] = [];
  let budget: bigint | null = null; // the refund allowance left for this run
  let lastPayable: typeof creditClosures.$inferSelect | null = null;
  let screeningReady: boolean | null = null; // whether a current sanctions list is loaded (read once a run)
  let stoppedEarly = false;
  for (const r of due) {
    // A run is bounded in time as well as in rows; what is left is the next run's first work.
    if (Date.now() - started > CLOSURE_RUN_MS) { stoppedEarly = true; break; }
    if (r.payableAt <= now) lastPayable = r;
    if (r.keyHash && opts.skipKeys?.has(r.keyHash)) { out.push({ id: r.id, waiting: "deposit_unreadable" }); continue; }
    const mark = (set: Partial<typeof creditClosures.$inferInsert>) => ctx.db.update(creditClosures).set(set).where(eq(creditClosures.id, r.id));
    let plan: RefundPlanItem[] | null = r.plan ?? null;
    try {
      const request = await readRefundRequest(rpc, program, r.chainKeyHash);
      // The request this closure's plan was made for (R3-06). A plan from before this field has none and stays bound to
      // whatever request is on chain.
      const boundTo = plan?.find((i) => i.request)?.request ?? null;
      const replaced = !!request && !!boundTo && boundTo !== request.requestedAt.toString();
      if (!request || replaced) {
        // Not signed yet, or taken back on chain: an open account with no request behind a registered closure, or a
        // request that is not the one this closure planned for (cancelled and asked for again).
        if (r.status === "registered" || plan) {
          const credit = replaced ? null : await readCreditAccount(rpc, program, r.chainKeyHash);
          if (replaced || (credit && !credit.closed)) {
            if (plan) {
              const undone = await cancelPlannedClosure(ctx, program, r.id);
              if (undone) { out.push({ id: r.id, cancelled: true, reversed: undone.reversed.toString() }); continue; }
            } else { await markClosureCancelled(ctx, { chainKeyHash: r.chainKeyHash, txHash: null }); out.push({ id: r.id, cancelled: true }); continue; }
          }
        }
        out.push({ id: r.id, waiting: plan ? "request_gone_refund_debited" : "close_account_not_signed" });
        continue;
      }
      // The chain fixed when it becomes payable (a later change of the delay does not move it).
      const payableAt = new Date(Number(request.payableAt) * 1000);
      if (r.status === "queued" || r.payableAt.getTime() !== payableAt.getTime()) await mark({ status: "registered", payableAt });
      // Paid in full on chain by something other than this job's own plan: nothing more can be sent.
      if (!plan && request.paid) { await mark({ status: "paid", amount: request.paidAmount, paidAt: new Date() }); out.push({ id: r.id, paid: request.paidAmount.toString(), tx: r.payTx }); continue; }
      if (payableAt > now) { out.push({ id: r.id, waiting: "refund_delay" }); continue; }
      // R4-26: with screening on, nothing is planned or paid against a missing or stale list (it would match nobody).
      if (ctx.cfg.sanctions.enabled) {
        screeningReady ??= await sanctionsListCurrent(ctx).catch(() => false);
        if (!screeningReady) { await mark({ reason: "sanctions_list_unavailable" }); out.push({ id: r.id, waiting: "sanctions_list_unavailable" }); continue; }
      }
      const [k] = await ctx.db.select({ accountId: keys.accountId, keyHash: keys.keyHash, chainKeyHash: keys.chainKeyHash, keyAddress: keys.keyAddress, disabled: keys.disabled }).from(keys).where(eq(keys.chainKeyHash, r.chainKeyHash));
      if (!plan) {
        // Open disputes on this key's generations block the refund until they resolve.
        const [disputed] = await ctx.db.select({ id: slashes.id }).from(slashes).innerJoin(generations, eq(generations.providerId, slashes.providerId)).innerJoin(keys, eq(keys.keyHash, generations.keyHash)).where(and(eq(keys.chainKeyHash, r.chainKeyHash), eq(slashes.status, "disputed"))).limit(1);
        if (disputed) { out.push({ id: r.id, waiting: "open_dispute" }); continue; }
        // The key is frozen since the closure was registered; requests it had in flight must finish first.
        if (k) {
          const [inflight] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(holds).where(and(eq(holds.keyHash, k.keyHash), eq(holds.status, "held")));
          if (inflight?.n) { out.push({ id: r.id, waiting: "open_holds" }); continue; }
        }
        // RR-05: a key that was revoked at the router does not get its closure paid until an owner says so.
        if (k?.disabled && !r.releasedAt) { await mark({ reason: "key_disabled" }); out.push({ id: r.id, waiting: "key_disabled" }); continue; }
        // Every deposit the chain holds for the key is in the ledger before the amount is computed.
        if (k) await reconcileKey(ctx, k, rpc);
        // The reconciliation (or the indexer, meanwhile) may have closed this row. Nothing is planned, debited or sent
        // for a closure that is no longer open: a debit on a dropped row would never be paid out or put back.
        const [still] = await ctx.db.select({ status: creditClosures.status }).from(creditClosures).where(eq(creditClosures.id, r.id));
        if (!still || (still.status !== "queued" && still.status !== "registered")) { out.push({ id: r.id, waiting: "closure_changed" }); continue; }
        const { shares } = await sharesAndLots(ctx, program, r.chainKeyHash);
        // TR-14: screen who would actually be paid: the depositor, the account it named, and that account's owner.
        // R3-22: largest remaining share first, and only as many shares as the refund can reach (it is never more than
        // the request still owes), so shares a stranger added to the key cost nothing unless the refund extends to them.
        const owed = request.amount > request.paidAmount ? request.amount - request.paidAmount : 0n;
        const mostRefundable = owed < ctx.cfg.solana.caps.creditsUnits ? owed : ctx.cfg.solana.caps.creditsUnits;
        const room: { depositor: string; room: bigint }[] = [];
        const owners = new Map<string, string | null>();
        const refusedDepositors: string[] = [];
        let reach = 0n;
        for (const candidate of refundOrder(shares)) {
          if (reach >= mostRefundable) break;
          const share = shares.get(candidate.depositor)!;
          const destination = await refundDestination(ctx, share.refundTo, program.mint);
          owners.set(candidate.depositor, destination?.owner.toBase58() ?? null);
          if (ctx.cfg.sanctions.enabled) {
            let hit = false;
            for (const address of new Set([candidate.depositor, share.refundTo.toBase58(), ...(destination ? [destination.owner.toBase58()] : [])])) if (await isSanctioned(ctx, address)) { hit = true; break; }
            if (hit) { refusedDepositors.push(candidate.depositor); continue; }
          }
          room.push(candidate);
          reach += candidate.room;
        }
        if (!room.length) {
          if (refusedDepositors.length) { await mark({ status: "refused", reason: "sanctioned_address" }); out.push({ id: r.id, refused: "sanctioned_address" }); }
          else { await mark({ reason: "depositors_unknown" }); out.push({ id: r.id, waiting: "depositors_unknown" }); }
          continue;
        }
        // TR-08: the amount, its split and its ledger debit, under the closure's and the account's row locks. Computed
        // once; a retry reuses the plan.
        plan = await ctx.db.transaction(async (tx) => {
          const [row] = await tx.select().from(creditClosures).where(eq(creditClosures.id, r.id)).for("update");
          if (row?.plan) return row.plan;
          if (!row || (row.status !== "queued" && row.status !== "registered")) return null; // closed since it was selected: no debit
          // The key may have been registered here a moment ago (RR-12): look again, inside the lock that its crediting takes.
          const [key] = await tx.select({ accountId: keys.accountId, keyHash: keys.keyHash, keyAddress: keys.keyAddress }).from(keys).where(eq(keys.chainKeyHash, r.chainKeyHash));
          let refund = owed < ctx.cfg.solana.caps.creditsUnits ? owed : ctx.cfg.solana.caps.creditsUnits;
          if (key) {
            const [acct] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, key.accountId)).for("update");
            // Every open hold on the account is money a request may still charge: it is not refundable.
            const available = acct ? picoToUsdc(acct.balance - acct.held > 0n ? acct.balance - acct.held : 0n, "floor") : 0n;
            if (refund > available) refund = available;
            // Never more than this key's own deposits still cover after the usage (and holds) allocated to them.
            const withdrawable = await withdrawableFor({ ...ctx, db: tx } as unknown as Ctx, key.accountId, r.chainKeyHash);
            if (refund > withdrawable) refund = withdrawable;
          }
          const split = await allocateRefund(refund, room);
          const items: RefundPlanItem[] = [...split].map(([depositor, units]) => ({ depositor, refundTo: shares.get(depositor)!.refundTo.toBase58(), owner: owners.get(depositor) ?? null, units: units.toString(), refundedBefore: shares.get(depositor)!.refunded.toString(), status: "planned", request: request.requestedAt.toString() }));
          const total = items.reduce((a, i) => a + BigInt(i.units), 0n);
          if (key && total > 0n) await post(tx, { accountId: key.accountId, amount: -usdcToPico(total), kind: "closure_refund", ref: `closure:${r.id}`, keyHash: key.keyHash, description: "Account closure refund" });
          await tx.update(creditClosures).set({ amount: total, plan: items, ledgerBound: !!key, keyHash: key?.keyHash ?? row?.keyHash ?? "", keyAddress: key?.keyAddress ?? row?.keyAddress ?? "", refundTo: [...new Set(items.map((i) => i.owner ?? i.depositor))].join(","), reason: null }).where(eq(creditClosures.id, r.id));
          return items;
        });
      }
      if (!plan) { out.push({ id: r.id, waiting: "closure_changed" }); continue; }
      // Send what the plan still owes each depositor. The chain says what each has already received.
      let pending: string | null = null;
      let lastTx: string | null = r.payTx;
      let paidTotal = 0n;
      let sends = 0;
      let takenBack = false;
      for (const item of plan) {
        if (item.status !== "planned") { if (item.status === "paid") paidTotal += BigInt(item.units); continue; }
        if (sends >= MAX_REFUND_SENDS_PER_CLOSURE) { item.reason = "refund_work_capped"; pending ??= "refund_work_capped"; continue; }
        const depositor = new PublicKey(item.depositor);
        const share = await readDepositorShare(rpc, program, r.chainKeyHash, depositor);
        if (!share) { item.reason = "share_missing"; pending ??= "share_missing"; continue; }
        const received = share.refunded > BigInt(item.refundedBefore) ? share.refunded - BigInt(item.refundedBefore) : 0n;
        const toSend = BigInt(item.units) - received;
        if (toSend <= 0n) { item.status = "paid"; item.reason = null; paidTotal += BigInt(item.units); continue; }
        // The account that is paid NOW (its depositor may have moved it since the plan): it must be able to receive,
        // and it is screened again.
        const destination = await refundDestination(ctx, share.refundTo, program.mint);
        if (!destination) { item.reason = "refund_destination_unavailable"; pending ??= "refund_destination_unavailable"; paidTotal += received; continue; }
        item.refundTo = share.refundTo.toBase58();
        item.owner = destination.owner.toBase58();
        if (ctx.cfg.sanctions.enabled) {
          let hit = false;
          for (const address of new Set([item.depositor, item.refundTo, item.owner])) if (await isSanctioned(ctx, address)) { hit = true; break; }
          if (hit) {
            // What was debited for this depositor and not sent is put back: nothing more will be sent for it.
            if (r.ledgerBound !== false && k) await post(ctx.db, { accountId: k.accountId, amount: usdcToPico(toSend), kind: "closure_refund", ref: `closure:${r.id}:reversed:${item.depositor}`, keyHash: k.keyHash, description: "Account closure refund refused" });
            item.status = "refused";
            item.reason = "sanctioned_address";
            paidTotal += received;
            continue;
          }
        }
        budget ??= await refundAllowance(ctx, program, now);
        const sendNow = toSend < budget ? toSend : budget;
        if (sendNow <= 0n) { item.reason = "refund_rate_limited"; pending ??= "refund_rate_limited"; paidTotal += received; continue; }
        const settlement = ctx.chain.wallet("settlement").keypair;
        try {
          lastTx = (await ctx.chain.send("settlement", buildPayRefundInstructions(program, { settlement: settlement.publicKey, chainKeyHash: r.chainKeyHash, depositor, refundToToken: share.refundTo, amount: sendNow }))).hash;
        } catch (e) {
          // R3-06: cancel_close may have landed between the debit above and this payment. If the request is gone and the
          // account is open again, the closure is undone now, in one transaction, instead of waiting debited and frozen.
          const still = await readRefundRequest(rpc, program, r.chainKeyHash).catch(() => undefined);
          const credit = still === null ? await readCreditAccount(rpc, program, r.chainKeyHash).catch(() => null) : null;
          if (still === null && credit && !credit.closed) { takenBack = true; break; }
          throw e;
        }
        sends++;
        budget -= sendNow;
        item.tx = lastTx;
        paidTotal += received + sendNow;
        if (sendNow < toSend) { item.reason = "refund_rate_limited"; pending ??= "refund_rate_limited"; }
        else { item.status = "paid"; item.reason = null; }
      }
      if (takenBack) {
        await mark({ plan });
        const undone = await cancelPlannedClosure(ctx, program, r.id);
        out.push(undone ? { id: r.id, cancelled: true, reversed: undone.reversed.toString() } : { id: r.id, waiting: "request_gone_refund_debited" });
        continue;
      }
      const recipients = [...new Set(plan.filter((i) => i.status === "paid").map((i) => i.owner ?? i.depositor))];
      if (pending) {
        await mark({ plan, payTx: lastTx, reason: pending });
        out.push({ id: r.id, waiting: pending, paid: paidTotal.toString() });
        continue;
      }
      const refusedAll = plan.length > 0 && plan.every((i) => i.status === "refused");
      await mark({ status: refusedAll ? "refused" : "paid", plan, payTx: lastTx, paidAt: new Date(), reason: refusedAll ? "sanctioned_address" : null, ...(recipients.length ? { refundTo: recipients.join(",") } : {}) });
      out.push(refusedAll ? { id: r.id, refused: "sanctioned_address" } : { id: r.id, paid: paidTotal.toString(), tx: lastTx, recipients });
    } catch (e) {
      await mark({ reason: "submission_failed", ...(plan ? { plan } : {}) }).catch(() => undefined);
      log.error("closure refund failed; will retry", { id: r.id, error: (e as Error).message });
      out.push({ id: r.id, error: "submission_failed" });
    }
  }
  await saveClosureCursor(ctx, cursors, lastPayable, stoppedEarly);
  return { closures: out, expired_unsigned: expiredUnsigned };
}

/** A run of the closure job stops taking new closures after this long; the cursor carries on from there. */
export const CLOSURE_RUN_MS = 5 * 60_000;
const CLOSURE_CURSOR_KEY = "closure-refund-cursor";
type ClosureCursor = { payable_at: string; id: string } | null;
type ClosureRow = typeof creditClosures.$inferSelect;

/**
 * R4-04, step 1. A `queued` row is a closure the API handed a transaction for; the indexer turns it into `registered`
 * when the request lands. One that is still `queued` after the unsigned lifetime is looked up on chain once: registered
 * if its request is there (the indexer was behind), cancelled if it is not. An RPC error leaves it for the next run.
 */
async function expireUnsignedClosures(ctx: Ctx, program: CreditsProgram, now: Date): Promise<number> {
  const cutoff = new Date(Date.now() - ctx.cfg.solana.closures.unsignedTtlMs);
  const stale = await ctx.db.select().from(creditClosures).where(and(eq(creditClosures.status, "queued"), isNull(creditClosures.plan), lte(creditClosures.requestedAt, cutoff))).orderBy(asc(creditClosures.requestedAt)).limit(500);
  let expired = 0;
  for (const r of stale) {
    try {
      const request = await readRefundRequest(ctx.chain.connection, program, r.chainKeyHash);
      if (request) await ctx.db.update(creditClosures).set({ status: "registered", payableAt: new Date(Number(request.payableAt) * 1000) }).where(and(eq(creditClosures.id, r.id), eq(creditClosures.status, "queued")));
      else {
        const done = await ctx.db.update(creditClosures).set({ status: "cancelled", reason: "expired_unsigned" }).where(and(eq(creditClosures.id, r.id), eq(creditClosures.status, "queued"), isNull(creditClosures.plan))).returning({ id: creditClosures.id });
        expired += done.length;
      }
    } catch (e) {
      log.warn("closure refund: an unsigned request could not be checked on chain; left for the next run", { id: r.id, error: (e as Error).message.slice(0, 160) });
    }
  }
  // A request signed a moment ago whose row is still `queued` (the indexer has not seen it yet) is registered here as
  // well, so its refund does not wait on the indexer: the newest few, a small fixed share of the run. Never cancelled here.
  const fresh = await ctx.db.select().from(creditClosures).where(and(eq(creditClosures.status, "queued"), isNull(creditClosures.plan), gt(creditClosures.requestedAt, cutoff))).orderBy(desc(creditClosures.requestedAt)).limit(25);
  for (const r of fresh) {
    try {
      const request = await readRefundRequest(ctx.chain.connection, program, r.chainKeyHash);
      if (request) await ctx.db.update(creditClosures).set({ status: "registered", payableAt: new Date(Number(request.payableAt) * 1000) }).where(and(eq(creditClosures.id, r.id), eq(creditClosures.status, "queued")));
    } catch { /* the indexer, or the next run, registers it */ }
  }
  void now;
  return expired;
}

/** R4-04, steps 2 and 3: this run's closures. Payable ones from the cursor on, wrapping, within the budget; then a few that are still waiting. */
async function closureWorkList(ctx: Ctx, now: Date): Promise<{ due: ClosureRow[]; cursors: { payable: ClosureCursor; all: boolean } }> {
  const budget = ctx.cfg.solana.closures.runBudget;
  const [saved] = await ctx.db.select().from(kv).where(eq(kv.key, CLOSURE_CURSOR_KEY));
  const cursor = (saved?.value as { payable?: ClosureCursor } | undefined)?.payable ?? null;
  const payable = and(eq(creditClosures.status, "registered"), lte(creditClosures.payableAt, now));
  const order = [asc(creditClosures.payableAt), asc(creditClosures.id)] as const;
  const after = cursor ? sql`(${creditClosures.payableAt}, ${creditClosures.id}) > (${new Date(cursor.payable_at)}, ${cursor.id})` : undefined;
  let rows = await ctx.db.select().from(creditClosures).where(after ? and(payable, after) : payable).orderBy(...order).limit(budget);
  let all = !cursor && rows.length < budget; // from the oldest, and the end was reached
  if (cursor && rows.length < budget) {
    // The end was reached: wrap to the oldest, up to (and including) where this cycle started.
    const upTo = sql`(${creditClosures.payableAt}, ${creditClosures.id}) <= (${new Date(cursor.payable_at)}, ${cursor.id})`;
    const head = await ctx.db.select().from(creditClosures).where(and(payable, upTo)).orderBy(...order).limit(budget - rows.length);
    rows = [...rows, ...head];
    all = rows.length < budget;
  }
  // Housekeeping for closures still inside their delay (a request taken back on chain, a changed payable time): a tenth of the budget.
  const waiting = await ctx.db.select().from(creditClosures).where(and(eq(creditClosures.status, "registered"), sql`${creditClosures.payableAt} > ${now}`)).orderBy(asc(creditClosures.payableAt), asc(creditClosures.id)).limit(Math.max(5, Math.floor(budget / 10)));
  // A debited closure whose row is still `queued` (a plan exists) is never abandoned.
  const planned = await ctx.db.select().from(creditClosures).where(and(eq(creditClosures.status, "queued"), isNotNull(creditClosures.plan))).limit(50);
  return { due: [...rows, ...planned, ...waiting.slice(0, Math.max(0, 5 + Math.floor(budget / 10)))], cursors: { payable: cursor, all } };
}

async function saveClosureCursor(ctx: Ctx, cursors: { payable: ClosureCursor; all: boolean }, last: ClosureRow | null, stoppedEarly: boolean) {
  // Every payable closure was examined from the oldest on: start from the oldest again. Otherwise continue after the last one.
  const next: ClosureCursor = cursors.all && !stoppedEarly ? null : last ? { payable_at: last.payableAt.toISOString(), id: last.id } : cursors.payable;
  const value = { payable: next, at: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key: CLOSURE_CURSOR_KEY, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

// ---- 6: weekly fee distribution through trellis_fee_router::distribute (§5.7; no fee split) -----------------------------
// The fee vault is fed two ways: runPayouts settles the provider fee of every paid host invoice (PROVIDER_FEE_BPS, 0 by default) straight from the credits vault
// (settle_to_host, so it is bounded by committed spend), and whatever protocol margin is still in `margin_unsent`
// (retained margin accrued by settleHours, fees of invoices not paid on chain) is moved by the settlement authority from
// its own USDC account, as far as that account holds it. distribute(period) then routes the whole vault balance to the
// treasury vault: protocol fees are not split (workers 0 / treasury 10,000 bps). When the on-chain FeeConfig still
// carries another split, the settlement authority (the fee router's authority) sets 0/10,000 with update_fee_config in
// the same transaction, so nothing ever lands in the workers vault. period = the closed ISO week's index, strictly
// increasing. One row per ISO week.

export const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
};

export async function distributeFees(ctx: Ctx, now = new Date()) {
  const programId = ctx.cfg.solana.programs.feeRouter;
  if (!programId || !ctx.chain.roleAddress("settlement")) return { skipped: "fee router or settlement key not configured" };
  const closed = new Date(now.getTime() - 7 * 86_400_000); // the week that just closed
  const period = isoWeek(closed);
  const [existing] = await ctx.db.select().from(feeDistributions).where(eq(feeDistributions.period, period));
  if (existing?.status === "sent") return { skipped: "already distributed", period };
  const unsent = BigInt(((await getKv<string>(ctx, "margin_unsent")) ?? "0"));
  const program = new PublicKey(programId);
  const { feeConfig: feeConfigPda, feeVault } = feeRouterPdas(program);
  // TR-02: the config is read through the shared helper (owned by the fee router program, at its PDA), never decoded
  // from whatever account sits at an address.
  const feeConfig = await withRetry(() => readVerifiedAccount(ctx.chain.connection, feeConfigPda, feeConfigSpec(program))).catch(() => null);
  if (!feeConfig) return { skipped: "fee router not initialised", period };
  const settlement = ctx.chain.wallet("settlement").keypair;
  const mint = new PublicKey(ctx.cfg.chain.usdc);
  const tokenBalance = async (account: PublicKey) => { const i = await withRetry(() => ctx.chain.connection.getAccountInfo(account)).catch(() => null); return i ? AccountLayout.decode(new Uint8Array(i.data)).amount : 0n; };
  const settlementAta = getAssociatedTokenAddressSync(mint, settlement.publicKey, true);
  const [inVault, onHand] = await Promise.all([tokenBalance(feeVault), tokenBalance(settlementAta)]);
  // Top the vault up with the unsent margin, as far as the settlement account holds it; the rest waits.
  const wanted = picoToUsdc(unsent > 0n ? unsent : 0n, "floor");
  const topUp = wanted < onHand ? wanted : onHand;
  const amount = inVault + topUp;
  if (amount <= 0n) return { skipped: "nothing to distribute", period };
  // Everything to the treasury. A FeeConfig with another split is set to 0/10,000 first (the settlement key is the authority).
  const workers = 0n, treasury = amount;
  const resetSplit = !isTreasuryOnly(feeConfig);
  const id = existing?.id ?? uid("fd_");
  if (!existing) await ctx.db.insert(feeDistributions).values({ id, period, amount, workers, treasury, status: "pending" });
  else await ctx.db.update(feeDistributions).set({ amount, workers, treasury, status: "pending" }).where(eq(feeDistributions.id, id));
  try {
    const ixs = [
      ...(resetSplit ? [updateFeeConfigIx(program, { authority: settlement.publicKey, workersBps: WORKERS_BPS, treasuryBps: TREASURY_BPS })] : []),
      ...(topUp > 0n ? [fundFeeVaultIx(program, { owner: settlement.publicKey, sourceToken: settlementAta, mint, amount: topUp })] : []),
      distributeIx(program, { authority: settlement.publicKey, period: weekPeriod(closed), workersVault: feeConfig.workersVault, treasuryVault: feeConfig.treasuryVault, feeMint: feeConfig.feeMint }),
    ];
    const r = await ctx.chain.send("settlement", ixs);
    await ctx.db.update(feeDistributions).set({ status: "sent", tx: r.hash }).where(eq(feeDistributions.id, id));
    if (topUp > 0n) await setKv(ctx, "margin_unsent", (unsent - usdcToPico(topUp)).toString());
    if (resetSplit) log.warn("fee router split reset to treasury-only", { period, was: `${feeConfig.workersBps}/${feeConfig.treasuryBps}` });
    return { period, amount: amount.toString(), from_vault: inVault.toString(), top_up: topUp.toString(), workers: workers.toString(), treasury: treasury.toString(), ...(resetSplit ? { split_reset: `${WORKERS_BPS}/${TREASURY_BPS}` } : {}), tx: r.hash };
  } catch (e) {
    await ctx.db.update(feeDistributions).set({ status: "failed" }).where(eq(feeDistributions.id, id));
    log.error("fee distribution failed", { period, error: (e as Error).message });
    return { period, error: "submission_failed" };
  }
}

// ---- 7: flat weekly service fees (SERVICE_FEE_RECIPIENTS) --------------------------------------------------------------
// Relay operators and canary runners are not paid from a worker pool by receipts: each configured recipient gets a flat
// USDC amount per ISO week from the treasury settlement wallet (the settlement key's USDC account), after a sanctions
// screen of the address (screening must be enabled; otherwise nothing is paid). One row per week per recipient (unique),
// written before the transfer, so a retry never pays a week twice:
//   paid     the transfer confirmed (tx)
//   failed   not sent: the transfer failed or the sanctions list is stale/unavailable; retried by the next run
//   refused  the address is on the sanctions list; never retried for that week
//   pending  claimed and the outcome is unknown (the run died mid-send); left for the operator to reconcile, never re-sent

export async function payServiceFees(ctx: Ctx, now = new Date()) {
  const recipients = ctx.cfg.serviceFees.recipients;
  if (!recipients.length) return { skipped: "no service fee recipients configured" };
  if (!ctx.cfg.sanctions.enabled) return { skipped: "sanctions screening disabled (service fees are only paid to screened addresses)" };
  if (!ctx.chain.roleAddress("settlement")) return { skipped: "settlement key not configured" };
  const period = isoWeek(new Date(now.getTime() - 7 * 86_400_000)); // the week that just closed
  const out: unknown[] = [];
  for (const r of recipients) {
    let [row] = await ctx.db.select().from(serviceFees).where(and(eq(serviceFees.period, period), eq(serviceFees.role, r.role), eq(serviceFees.address, r.address)));
    if (row && row.status !== "failed") { out.push({ role: r.role, address: r.address, usdc: row.usdc.toString(), status: row.status, ...(row.tx ? { tx: row.tx } : {}), ...(row.reason ? { reason: row.reason } : {}) }); continue; }
    // Claim the week: a new row, or a failed one moved back to pending only by the run that wins the update.
    if (!row) [row] = await ctx.db.insert(serviceFees).values({ id: uid("sf_"), period, role: r.role, address: r.address, usdc: r.usdcPerWeek, status: "pending" }).onConflictDoNothing().returning();
    else [row] = await ctx.db.update(serviceFees).set({ status: "pending", reason: null }).where(and(eq(serviceFees.id, row.id), eq(serviceFees.status, "failed"))).returning();
    if (!row) { out.push({ role: r.role, address: r.address, status: "pending", reason: "claimed_by_another_run" }); continue; }
    const id = row.id, usdc = row.usdc;
    const mark = (set: Partial<typeof serviceFees.$inferInsert>) => ctx.db.update(serviceFees).set(set).where(eq(serviceFees.id, id));
    try {
      await assertNotSanctioned(ctx, r.address, now);
    } catch (e) {
      const reason = ((e as { type?: string }).type ?? "sanctions_unavailable").toString();
      const status = reason === "sanctioned_address" ? "refused" : "failed";
      await mark({ status, reason });
      out.push({ role: r.role, address: r.address, usdc: usdc.toString(), status, reason });
      continue;
    }
    let tx: string;
    try {
      tx = (await ctx.chain.transferUsdc("settlement", r.address, usdc)).hash;
    } catch (e) {
      await mark({ status: "failed", reason: "submission_failed" });
      log.error("service fee payment failed; retried next run", { role: r.role, period, error: (e as Error).message });
      out.push({ role: r.role, address: r.address, usdc: usdc.toString(), status: "failed", reason: "submission_failed" });
      continue;
    }
    await mark({ status: "paid", tx, reason: null, paidAt: new Date() });
    out.push({ role: r.role, address: r.address, usdc: usdc.toString(), status: "paid", tx });
  }
  return { period, fees: out };
}

// ---- 8: credits expiry (trellis_credits notice_expiry / sweep_expired) ---------------------------------------------------
// A balance expires on chain 12 months after its latest deposit, but only moves when the settlement authority sends
// notice_expiry (which starts the grace period and is what the owner is told about) and, after that grace,
// sweep_expired (vault -> treasury). This job is the only sender of either, and it is off unless CREDITS_EXPIRY_ENABLED:
// while it is off the router never notices or sweeps any balance.
//
// Holder perk: a key whose wallet holds a tier with `credits_never_expire` at that moment is skipped for both
// instructions, on every run, for as long as it holds the tier (src/holders/credits-expiry.ts). A notice sent before
// the wallet reached the tier is simply never followed by a sweep while it holds it. A tier that cannot be read (RPC
// failure) also skips the key for this run: nothing is noticed or swept on a guess.
//
// The owner is told: a notice_expiry is recorded as an inbox notice (kv `credits-expiry-notice:<chain>:<key>:<notice
// time>`, read by src/inbox/credits-expiry.ts), and a balance is never swept before that inbox notice has stood for the
// whole grace period. The grace is the program's, and never shorter here than EXPIRY_MIN_GRACE_S (30 days).
//
// The ledger follows the chain, conservatively:
//  - the debit is written only for a sweep_expired the cluster confirmed (the send confirms; a send whose outcome was
//    lost is looked up on chain by its ExpiredSwept event before anything else is done for that key);
//  - it is idempotent per key and sweep signature (ledger.ref = credit-expiry:<chain key hash>:<signature>);
//  - it never takes more than the account's available balance (balance minus open holds), so it never drives a balance
//    negative and never eats funds a call in flight has reserved; a key whose account has open holds is not swept in
//    that run at all.
//
// Each run walks up to EXPIRY_BATCH keys in key-hash order from the cursor in kv (`credits-expiry-cursor`) and reads
// each CreditAccount from the chain, which is the only source of expires_at and the notice time.

export const EXPIRY_BATCH = 100;
/** The shortest time between the owner's notice and a sweep, whatever grace the program's config carries. */
export const EXPIRY_MIN_GRACE_S = 30n * 86_400n;
/** An unconfirmed sweep is looked for on chain this long before the key is considered again (its blockhash has long expired). */
export const EXPIRY_SWEEP_SETTLE_MS = 10 * 60_000;

/** Written before a sweep is sent: what the CreditAccount held then, so a lost outcome can be told from the chain. */
type SweepIntent = { accountId: string; keyHash: string; /** What the sweep moves (the unspent part). */ amount: string; /** The CreditAccount's whole balance then (older intents: absent, equal to `amount`). */ balance?: string; depositedTotal: string; noticeAt: string; at: string; tx: string | null };
export type ConfirmedSweep = { tx: string; amount: bigint };
export type ExpiryDeps = {
  /** R5-08: keys whose deposits could not be read this run: they are not swept. */
  skipKeys?: ReadonlySet<string>;
  /** The confirmed sweep_expired of a key since `sinceS`, or null: used when a send's outcome was lost. */
  findSweep?: (chainKeyHash: string, sinceS: number) => Promise<ConfirmedSweep | null>;
};

const sweepIntentKey = (ctx: Pick<Ctx, "cfg">, chainKeyHash: string) => `credits-expiry-sweep:${ctx.cfg.chain.id}:${chainKeyHash}`;
export const expiryLedgerRef = (chainKeyHash: string, signature: string) => `credit-expiry:${chainKeyHash}:${signature}`;
const isoOf = (unixS: bigint) => new Date(Number(unixS) * 1000).toISOString();

type ExpiryKey = { keyHash: string; chainKeyHash: string; accountId: string };

/** The inbox notice of an on-chain expiry notice: written once per (key, notice time), read back on later runs. */
async function ensureExpiryNotice(ctx: Ctx, k: ExpiryKey, credit: { balance: bigint; expiryNoticeAt: bigint }, grace: bigint, now: Date, tx: string | null): Promise<ExpiryNotice> {
  const key = expiryNoticeKey(ctx, k.chainKeyHash, credit.expiryNoticeAt);
  const nowS = BigInt(Math.floor(now.getTime() / 1000));
  const from = nowS > credit.expiryNoticeAt ? nowS : credit.expiryNoticeAt;
  const notice: ExpiryNotice = { accountId: k.accountId, keyHash: k.keyHash, noticeAt: isoOf(credit.expiryNoticeAt), recordedAt: now.toISOString(), sweepAfter: isoOf(from + grace), amount: picoToUsdString(usdcToPico(credit.balance)), tx };
  await ctx.db.insert(kv).values({ key, value: notice, updatedAt: now }).onConflictDoNothing();
  return (await getKv<ExpiryNotice>(ctx, key)) ?? notice;
}

/** A confirmed sweep_expired of this key in the credit account's recent transactions, by its ExpiredSwept event. */
async function findSweepOnChain(ctx: Ctx, program: NonNullable<ReturnType<typeof creditsProgram>>, chainKeyHash: string, sinceS: number): Promise<ConfirmedSweep | null> {
  const commitment = ctx.cfg.solana.commitment === "finalized" ? "finalized" : "confirmed";
  const sigs = await withRetry(() => ctx.chain.connection.getSignaturesForAddress(creditAccountAddress(program, chainKeyHash), { limit: 25 }, commitment));
  for (const s of sigs) {
    // Only a successful transaction dated after the sweep was sent: an undated one could be an earlier expiry's sweep.
    if (s.err || s.blockTime == null || s.blockTime < sinceS - 600) continue;
    const t = await withRetry(() => ctx.chain.connection.getTransaction(s.signature, { commitment, maxSupportedTransactionVersion: 0 }));
    if (!t || t.meta?.err) continue;
    const swept = expiredSweptEvents(program.programId, t.meta?.logMessages ?? []).find((e) => Buffer.from(e.keyHash).toString("hex") === chainKeyHash.replace(/^0x/, ""));
    if (swept) return { tx: s.signature, amount: swept.amount };
  }
  return null;
}

/**
 * Mirror a confirmed sweep on the ledger and close its intent, in one transaction under the account's row lock. The
 * debit is the swept amount, capped at what the account has available (balance minus open holds). Recording the same
 * (key, signature) again changes nothing.
 */
async function debitSweptCredits(ctx: Ctx, k: ExpiryKey, sweep: ConfirmedSweep): Promise<bigint> {
  return ctx.db.transaction(async (tx) => {
    const [acct] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, k.accountId)).for("update");
    const ref = expiryLedgerRef(k.chainKeyHash, sweep.tx);
    const [done] = await tx.select({ amount: ledger.amount }).from(ledger).where(eq(ledger.ref, ref));
    let debit = done ? -done.amount : 0n;
    if (!done) {
      const available = acct ? acct.balance - acct.held : 0n;
      const swept = usdcToPico(sweep.amount);
      debit = available <= 0n ? 0n : swept < available ? swept : available;
      if (debit < swept) log.warn("credits expiry: the ledger had less available than the chain swept", { key: k.keyHash.slice(0, 12), swept: swept.toString(), debited: debit.toString() });
      if (debit > 0n) await post(tx, { accountId: k.accountId, amount: -debit, kind: "credit_expiry", ref, keyHash: k.keyHash, description: `Expired credits swept ${sweep.tx.slice(0, 8)}` });
    }
    await tx.delete(kv).where(eq(kv.key, sweepIntentKey(ctx, k.chainKeyHash)));
    return debit;
  });
}

export async function expireCredits(ctx: Ctx, now = new Date(), deps: ExpiryDeps = {}) {
  if (!ctx.cfg.holders.creditsExpiryEnabled) return { skipped: "CREDITS_EXPIRY_ENABLED is off" };
  const program = creditsProgram(ctx.cfg);
  if (!program || !ctx.chain.roleAddress("settlement")) return { skipped: "credits program or settlement key not configured" };
  const config = await readCreditsConfig(ctx.chain.connection, program);
  if (!config) return { skipped: "credits config not initialised" };
  const grace = config.expiryGrace > EXPIRY_MIN_GRACE_S ? config.expiryGrace : EXPIRY_MIN_GRACE_S;
  const findSweep = deps.findSweep ?? ((chainKeyHash: string, sinceS: number) => findSweepOnChain(ctx, program, chainKeyHash, sinceS));
  const cursor = (await getKv<string>(ctx, "credits-expiry-cursor")) ?? "";
  const batch = await ctx.db.select({ keyHash: keys.keyHash, chainKeyHash: keys.chainKeyHash, accountId: keys.accountId }).from(keys).where(gt(keys.keyHash, cursor)).orderBy(asc(keys.keyHash)).limit(EXPIRY_BATCH);
  const nowS = BigInt(Math.floor(now.getTime() / 1000));
  const settlement = ctx.chain.wallet("settlement").keypair.publicKey;
  const out: unknown[] = [];
  for (const k of batch) {
    const short = k.keyHash.slice(0, 12);
    if (deps.skipKeys?.has(k.keyHash)) { out.push({ key: short, waiting: "deposit_unreadable" }); continue; }
    try {
      // A sweep an earlier run sent but could not record: settle that first. The ledger is only debited for a sweep the
      // cluster confirmed, found either in the intent (written after the confirmation) or on chain.
      const intentKey = sweepIntentKey(ctx, k.chainKeyHash);
      const intent = await getKv<SweepIntent>(ctx, intentKey);
      if (intent) {
        const sentS = Math.floor(Date.parse(intent.at) / 1000);
        const confirmed = intent.tx ? { tx: intent.tx, amount: BigInt(intent.amount) } : await findSweep(k.chainKeyHash, sentS);
        if (confirmed) {
          const debited = await debitSweptCredits(ctx, k, confirmed);
          out.push({ key: short, swept: confirmed.amount.toString(), debited: debited.toString(), tx: confirmed.tx, recovered: true });
          continue;
        }
        if (now.getTime() - Date.parse(intent.at) < EXPIRY_SWEEP_SETTLE_MS) { out.push({ key: short, waiting: "sweep_unconfirmed" }); continue; }
        // No confirmed sweep was found. It did not land if the account still holds what it held then (plus anything
        // deposited since); otherwise the balance moved without a signature to record, and an operator reconciles.
        const state = await readCreditAccount(ctx.chain.connection, program, k.chainKeyHash);
        const untouched = !!state && !state.closed && state.balance - (state.depositedTotal - BigInt(intent.depositedTotal)) === BigInt(intent.balance ?? intent.amount);
        if (!untouched) {
          log.error("credits expiry: a sweep's outcome could not be confirmed; nothing was debited", { key: short });
          out.push({ key: short, error: "sweep_unreconciled" });
          continue;
        }
        await ctx.db.delete(kv).where(eq(kv.key, intentKey));
      }
      const credit = await readCreditAccount(ctx.chain.connection, program, k.chainKeyHash);
      if (!credit || credit.closed || credit.balance <= 0n || nowS < credit.expiresAt) continue;
      const exempt = await creditsExpiryExemption(ctx, { accountId: k.accountId, authority: credit.authority.toBase58() });
      if (exempt) { out.push({ key: short, skipped: exempt.reason, ...(exempt.tier ? { tier: exempt.tier } : {}) }); continue; }
      const keyHash = chainKeyHashBytes(k.chainKeyHash);
      if (credit.expiryNoticeAt === 0n) {
        const tx = (await ctx.chain.send("settlement", [noticeExpiryIx(program.programId, { settlement, keyHash })])).hash;
        // The inbox notice carries the notice time the program recorded; if it cannot be read back yet, the next run
        // writes it (and the grace period then counts from that run).
        const noticed = await readCreditAccount(ctx.chain.connection, program, k.chainKeyHash).catch(() => null);
        if (noticed && noticed.expiryNoticeAt !== 0n) await ensureExpiryNotice(ctx, k, noticed, grace, now, tx);
        out.push({ key: short, noticed: credit.balance.toString(), tx });
        continue;
      }
      // Noticed on chain. The owner's inbox notice must have stood for the whole grace period before anything moves.
      const notice = await ensureExpiryNotice(ctx, k, credit, grace, now, null);
      const recordedS = BigInt(Math.floor(Date.parse(notice.recordedAt) / 1000));
      const sweepAt = (recordedS > credit.expiryNoticeAt ? recordedS : credit.expiryNoticeAt) + grace;
      if (nowS < sweepAt) { out.push({ key: short, waiting: "grace_period", sweep_after: isoOf(sweepAt) }); continue; }
      // Calls in flight have reserved part of this balance: leave the key for a later run.
      const [acct] = await ctx.db.select({ held: accounts.held }).from(accounts).where(eq(accounts.id, k.accountId));
      if (acct && acct.held > 0n) { out.push({ key: short, waiting: "open_holds" }); continue; }
      // TR-09: what moves to the treasury is what the key has NOT spent. The on-chain balance is the key's gross
      // deposits; the part it spent is owed to hosts and stays in the vault for settle_to_host.
      // Three bounds: the key's on-chain balance, what its own deposits still cover after the usage allocated to them
      // (withdrawableFor, from the indexed deposits), and what the account has available on the ledger right now.
      const [avail] = await ctx.db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, k.accountId));
      const available = avail ? picoToUsdc(avail.balance - avail.held > 0n ? avail.balance - avail.held : 0n, "floor") : 0n;
      const unspent = await withdrawableFor(ctx, k.accountId, k.chainKeyHash);
      const sweep = [unspent, available].reduce((a, b) => (b < a ? b : a), credit.balance);
      const sweepIntent: SweepIntent = { accountId: k.accountId, keyHash: k.keyHash, amount: sweep.toString(), balance: credit.balance.toString(), depositedTotal: credit.depositedTotal.toString(), noticeAt: isoOf(credit.expiryNoticeAt), at: now.toISOString(), tx: null };
      await setKv(ctx, intentKey, sweepIntent);
      const tx = (await ctx.chain.send("settlement", [sweepExpiredIx(program.programId, { settlement, keyHash, amount: sweep, treasuryToken: config.treasuryTokenAccount, mint: config.usdcMint })])).hash;
      // Confirmed. Note the signature first, so a failure below is settled from the intent on the next run.
      await setKv(ctx, intentKey, { ...sweepIntent, tx }).catch(() => {});
      const debited = await debitSweptCredits(ctx, k, { tx, amount: sweep });
      out.push({ key: short, swept: sweep.toString(), onchain_balance: credit.balance.toString(), debited: debited.toString(), tx });
    } catch (e) {
      log.error("credits expiry step failed; retried on a later run", { key: short, error: (e as Error).message });
      out.push({ key: short, error: "submission_failed" });
    }
  }
  await setKv(ctx, "credits-expiry-cursor", batch.length < EXPIRY_BATCH ? "" : batch.at(-1)!.keyHash);
  return { checked: batch.length, expiry: out };
}

const HALTED = { skipped: "deposit_reconciliation_failed" } as const;

/**
 * The settlement job. Before anything leaves the credits vault it reconciles the ledger's deposits with the chain
 * (security review TR-01): if any key has been credited deposits its on-chain CreditAccount.deposited_total does not
 * back, or an account cannot be read, every step that moves vault funds or commits to moving them (the spent root,
 * closure refunds, host payouts, the fee distribution, the expiry sweep) is skipped for this run and reported as
 * `deposit_reconciliation_failed`. Balance credited from something that never reached the vault must not become a
 * payout or a refund; an operator resolves the difference (the reconciliation lists the keys) and the next run goes on.
 */
export async function runSettlement(ctx: Ctx) {
  const reconciliation = await reconcileDeposits(ctx).catch((e) => ({ ok: false, checked: 0, mismatches: [] as Awaited<ReturnType<typeof reconcileDeposits>>["mismatches"], error: (e as Error).message }));
  // Security review R5-08. Three different things used to be one `halted`:
  //   - a key credited more than its on-chain deposits back (or the reconciliation itself failing): nothing leaves;
  //   - a key whose account could not be READ this run: only what depends on that key waits (its own refund, its own
  //     sweep, and the steps that are about every key at once: the spent root, payouts, fees). With thousands of keys
  //     one failed read an hour used to stop every refund;
  //   - a database that is behind the chain (restore_pending, above): nothing leaves until an operator has reconciled.
  const unbacked = "error" in reconciliation || reconciliation.mismatches.some((m) => m.kind === "ledger_exceeds_chain");
  const unreadable = new Set(reconciliation.mismatches.filter((m) => m.kind === "unreadable").map((m) => m.keyHash));
  const halted = unbacked;
  const everyKey = halted || unreadable.size > 0; // steps that commit to, or pay from, every key's figures at once
  // Structured and alertable: the readiness check `deposit_reconciliation` reads this row, and the log line carries a
  // fixed event name (`deposit_reconciliation_failed`) with the counts and nothing that identifies a key.
  const backed = reconciliation.mismatches.filter((m) => m.kind !== "chain_exceeds_ledger").length;
  await setKv(ctx, DEPOSIT_RECONCILIATION_KEY, { ok: reconciliation.ok, checked: reconciliation.checked, mismatches: backed, at: new Date().toISOString() }).catch(() => undefined);
  if (!reconciliation.ok) log.error("settlement: vault outflows skipped, the ledger's deposits are not backed by the chain", { event: "deposit_reconciliation_failed", keys: backed, checked: reconciliation.checked, unreadable: unreadable.size, all_outflows: halted });
  let frozen = (await restoreState(ctx))?.frozen === true;
  const makegood = await runMakegood(ctx).catch((e) => ({ error: (e as Error).message })); // V6 R: before spent roots
  const hours = await settleHours(ctx);
  // R5-08: the spent-root step no longer decides whether anything after it runs. Its failure is kept and thrown at the
  // END of the run, so the job still shows as failing (the alarm that names it), after every other step had its turn.
  let rootFailure: Error | null = null;
  const roots = everyKey ? HALTED : frozen ? RESTORE : await postSpentRoot(ctx).catch((e) => { rootFailure = e as Error; return { error: (e as Error).message }; });
  // The root step is where a database behind the chain is noticed: read the freeze again before anything is paid.
  frozen = frozen || (await restoreState(ctx))?.frozen === true;
  const royaltiesResult = await streamRoyalties(ctx).catch((e) => ({ error: (e as Error).message }));
  const margin = await retainedMargin(ctx).catch((e) => ({ error: (e as Error).message }));
  const closures = halted ? HALTED : frozen ? RESTORE : await payClosureRefunds(ctx, new Date(), { skipKeys: unreadable }).catch((e) => ({ error: (e as Error).message }));
  const weeklyDue = new Date().getUTCDay() === 1 && new Date().getUTCHours() === 0;
  const notDue = { skipped: "weekly (Mondays 00 UTC)" };
  const weekly = everyKey ? HALTED : frozen ? RESTORE : weeklyDue ? await runPayouts(ctx) : notDue;
  const fees = everyKey ? HALTED : frozen ? RESTORE : weeklyDue ? await distributeFees(ctx).catch((e) => ({ error: (e as Error).message })) : notDue;
  const serviceFeesResult = weeklyDue ? await payServiceFees(ctx).catch((e) => ({ error: (e as Error).message })) : notDue;
  const expiry = halted ? HALTED : frozen ? RESTORE : await expireCredits(ctx, new Date(), { skipKeys: unreadable }).catch((e) => ({ error: (e as Error).message }));
  for (const [step, result] of Object.entries({ closures, fees, expiry })) if (result && typeof result === "object" && "error" in result) log.error("settlement: a step failed; the other steps ran", { event: "settlement_step_failed", step, error: String((result as { error: unknown }).error).slice(0, 200) });
  const result = { reconciliation: { ok: reconciliation.ok, checked: reconciliation.checked, mismatches: reconciliation.mismatches.length, unreadable: unreadable.size, ...("skipped" in reconciliation && reconciliation.skipped ? { skipped: reconciliation.skipped } : {}) }, ...(frozen ? { restore: "pending" } : {}), makegood, hours, roots, royalties: royaltiesResult, margin, closures, payouts: weekly, fees, service_fees: serviceFeesResult, credits_expiry: expiry };
  // A freeze has its own alarm (restore_pending); any other failure of the root step fails the run (the job shows as
  // failing), with what the other steps did attached.
  if (rootFailure && !frozen) throw Object.assign(rootFailure as Error, { settlement: result });
  return result;
}

export { desc };
