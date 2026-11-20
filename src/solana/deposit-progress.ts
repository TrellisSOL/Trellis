import { and, desc, eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { chainEvents, keys, kv, ledger } from "../db/schema.ts";
import { picoToUsd } from "../lib/money.ts";
import type { EscrowFinality } from "./chain-service.ts";
import { SIGNATURE_RE } from "./constants.ts";
import { DEPOSIT_KIND } from "./credits-indexer.ts";
import { formatUsdc } from "./credits.ts";
import { withRetry } from "./rpc.ts";

// Deposit progress for the dashboard (polled every 5 s): what became of the USDC deposits an account sent through
// trellis_credits. A wallet that has just sent a deposit registers its base58 signature (POST /api/v1/credits/deposits);
// the row lives in the kv table (deposit-watch:<network>:<account>:<signature>, at most 20 per account) until the credits
// indexer (credits-indexer.ts) has credited it. Stages, in order: submitted (registered, the cluster does not report it
// yet) -> confirming (confirmed, not finalized) -> detected (finalized, or its Deposited event is recorded, credit on the
// indexer's next tick) -> credited (a ledger deposit row exists). orphaned: the transaction failed; checking: the chain
// was not reachable. Credited deposits the account never registered are listed too (the ledger is the source of truth).

export type DepositLane = "escrow" | "usdc";
export type DepositWatch = { accountId: string; txHash: string; lane: DepositLane; submittedAt: string };
export const MAX_WATCHES = 20;
// Security review R4-19. A watch is a signature a caller typed: nothing says it is a transaction. Each used to cost one
// transaction-history lookup on the operator's RPC on every read, for ever. Now:
//   - a watch lives WATCH_TTL_MS (a deposit is finalized and credited within a minute or two); after that it is shown
//     once as not found and dropped, without asking the chain;
//   - the pending watches of an account are looked up in ONE batched call, and the answer is kept DEPOSIT_STATUS_CACHE_MS (10 s), so
//     however often an account reads, it costs at most one RPC call per cache period;
//   - reads are rate limited per account (api/deposits.ts), and all accounts together may make RPC_LOOKUPS_PER_MIN
//     lookups a minute (beyond it a watch reads as `checking`, with no call).
export const WATCH_TTL_MS = 30 * 60_000;
export const RPC_LOOKUPS_PER_MIN = 120;
type CachedStatus = { stage: DepositStage; block: bigint | null; note?: string };
const statusCache = new Map<string, { at: number; statuses: Map<string, CachedStatus> }>();
export const watchKey = (ctx: Ctx, account: string, hash: string) => `deposit-watch:${ctx.cfg.chain.network}:${account}:${hash}`;
const watchPrefix = (ctx: Ctx, account: string) => `deposit-watch:${ctx.cfg.chain.network}:${account}:`;

/** Register a submitted transaction signature for the account; false when it already watches MAX_WATCHES. */
export async function watchDeposit(ctx: Ctx, accountId: string, txHash: string, lane: DepositLane): Promise<boolean> {
  if (!SIGNATURE_RE.test(txHash)) return false;
  const existing = await ctx.db.select({ key: kv.key }).from(kv).where(like(kv.key, `${watchPrefix(ctx, accountId)}%`));
  if (existing.some((r) => r.key === watchKey(ctx, accountId, txHash))) return true;
  if (existing.length >= MAX_WATCHES) return false;
  const value: DepositWatch = { accountId, txHash, lane, submittedAt: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key: watchKey(ctx, accountId, txHash), value }).onConflictDoNothing();
  return true;
}

export async function watchedDeposits(ctx: Ctx, accountId: string): Promise<DepositWatch[]> {
  const rows = await ctx.db.select().from(kv).where(like(kv.key, `${watchPrefix(ctx, accountId)}%`));
  return rows.map((r) => r.value as DepositWatch).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** The slot transfers may be credited at: the finalized slot (Solana has no reorganization past finality). */
export function creditBlock(_ctx: Ctx, fin: EscrowFinality) {
  return fin.final;
}

export async function depositTiming(ctx: Ctx) {
  const head = await ctx.chain.blockNumber().catch(() => null);
  return { expected_credit_delay_s: 30, head_block: head?.toString() ?? null, credit_block: head?.toString() ?? null, explorer: ctx.cfg.chain.explorerUrl, confirmations: ctx.cfg.chain.confirmations, finality: "finalized" };
}

/** Approximate remaining time from the live head/finality slot gap, never a deadline. */
export function depositRemainingSeconds(block: bigint, fin: EscrowFinality, credit: bigint) {
  if (block <= credit) return 0;
  const gap = fin.head - fin.final;
  const delay = Math.max(0, fin.headTime - fin.finalTime);
  return gap > 0n && delay > 0 ? Math.ceil(Number(block - credit) / Number(gap) * delay) : null;
}

export type DepositStage = "submitted" | "confirming" | "detected" | "credited" | "orphaned" | "checking";
export type DepositProgress = { id: string; lane: DepositLane; tx_hash: string; tx_url: string; stage: DepositStage; block: string | null; amount: string | null; symbol: "USDC"; credited_usd: number | null; worth_usd: number | null; worth_fixed: boolean; submitted_at: string | null; credited_at: string | null; expected_final_at: string | null; note?: string };

/** A Solana transaction on the configured explorer, on devnet with its cluster named. */
export const explorerTx = (ctx: Pick<Ctx, "cfg">, sig: string) => {
  const cluster = ctx.cfg.chain.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" ? "?cluster=devnet" : "";
  return `${ctx.cfg.chain.explorerUrl.replace(/\/$/, "")}/tx/${sig}${cluster}`;
};

/** The account's deposits, watched ones first: registered signatures followed by the ledger's credited deposits. */
export async function accountDeposits(ctx: Ctx, accountId: string): Promise<DepositProgress[]> {
  const watches = await watchedDeposits(ctx, accountId);
  const credited = await ctx.db.select({ ref: ledger.ref, amount: ledger.amount, at: ledger.createdAt }).from(ledger).where(and(eq(ledger.accountId, accountId), eq(ledger.kind, DEPOSIT_KIND))).orderBy(desc(ledger.createdAt)).limit(50);
  const creditedBySig = new Map<string, { amount: bigint; at: Date }>();
  for (const c of credited) {
    const sig = c.ref.split(":")[1];
    if (!sig) continue;
    const prev = creditedBySig.get(sig);
    creditedBySig.set(sig, { amount: (prev?.amount ?? 0n) + c.amount, at: prev?.at ?? c.at });
  }
  const out: DepositProgress[] = [];
  const seen = new Set<string>();
  const pending: DepositWatch[] = [];
  for (const w of watches) {
    seen.add(w.txHash);
    const hit = creditedBySig.get(w.txHash);
    if (hit) {
      // Credited: the watch has done its job and is dropped (the ledger row stays).
      await ctx.db.delete(kv).where(eq(kv.key, watchKey(ctx, accountId, w.txHash)));
      out.push(view(ctx, w.txHash, w.lane, "credited", { creditedPico: hit.amount, creditedAt: hit.at, submittedAt: w.submittedAt }));
      continue;
    }
    if (!(Date.now() - Date.parse(w.submittedAt) <= WATCH_TTL_MS)) {
      // R4-19: past its lifetime and never credited. Shown once, dropped, and the chain is not asked.
      await ctx.db.delete(kv).where(eq(kv.key, watchKey(ctx, accountId, w.txHash)));
      out.push(view(ctx, w.txHash, w.lane, "orphaned", { submittedAt: w.submittedAt, note: "No deposit with this signature was credited within 30 minutes. If the transaction did land, the deposit is credited from chain state and appears below." }));
      continue;
    }
    pending.push(w);
  }
  const statuses = pending.length ? await pendingStatuses(ctx, accountId, pending) : new Map<string, CachedStatus>();
  for (const w of pending) out.push(await pendingView(ctx, accountId, w, statuses));
  for (const [sig, hit] of creditedBySig) {
    if (seen.has(sig)) continue;
    out.push(view(ctx, sig, "usdc", "credited", { creditedPico: hit.amount, creditedAt: hit.at, submittedAt: null }));
  }
  return out;
}

/** One batched status lookup for an account's pending watches, cached; bounded across all accounts. */
async function pendingStatuses(ctx: Ctx, accountId: string, pending: DepositWatch[]): Promise<Map<string, CachedStatus>> {
  const cached = statusCache.get(accountId);
  if (cached && Date.now() - cached.at < ctx.cfg.solana.depositStatusCacheMs && pending.every((w) => cached.statuses.has(w.txHash))) return cached.statuses;
  const statuses = new Map<string, CachedStatus>();
  const checking = () => { for (const w of pending) statuses.set(w.txHash, { stage: "checking", block: null }); return statuses; };
  try {
    const budget = await ctx.limiter.take("deposit-status-rpc", 1, RPC_LOOKUPS_PER_MIN, 60_000);
    if (!budget.ok) return checking();
  } catch { return checking(); }
  try {
    const sigs = pending.map((w) => w.txHash);
    const { value } = await withRetry(() => ctx.chain.connection.getSignatureStatuses(sigs, { searchTransactionHistory: true }), { attempts: 2 });
    pending.forEach((w, i) => {
      const s = value[i];
      if (s?.err) statuses.set(w.txHash, { stage: "orphaned", block: null, note: "The transaction failed on chain; nothing was deposited." });
      else if (s) statuses.set(w.txHash, { stage: s.confirmationStatus === "finalized" ? "detected" : "confirming", block: BigInt(s.slot) });
      else statuses.set(w.txHash, { stage: "submitted", block: null, ...(Date.now() - Date.parse(w.submittedAt) > 180_000 ? { note: "The cluster does not report this signature yet. Check the transaction in your wallet; do not send again while it is pending." } : {}) });
    });
  } catch {
    return checking();
  }
  if (statusCache.size > 5_000) statusCache.clear();
  statusCache.set(accountId, { at: Date.now(), statuses });
  return statuses;
}

async function pendingView(ctx: Ctx, accountId: string, w: DepositWatch, statuses: Map<string, CachedStatus>): Promise<DepositProgress> {
  // The indexer may have recorded the event (chain_events) before crediting it (the key may not exist here yet).
  const [event] = await ctx.db.select({ args: chainEvents.args, block: chainEvents.blockNumber, error: chainEvents.error }).from(chainEvents).where(and(eq(chainEvents.txHash, w.txHash), eq(chainEvents.event, "Deposited")));
  if (event) {
    const args = event.args as { amount?: string; keyHash?: string };
    const units = args.amount && /^\d+$/.test(args.amount) ? BigInt(args.amount) : null;
    const note = event.error === "unknown_key" ? "The deposit names a key this router does not know yet; it is credited once that key is created here." : undefined;
    return view(ctx, w.txHash, w.lane, "detected", { units, block: event.block, submittedAt: w.submittedAt, note });
  }
  void accountId;
  const s = statuses.get(w.txHash) ?? { stage: "checking" as DepositStage, block: null };
  return view(ctx, w.txHash, w.lane, s.stage, { block: s.block, submittedAt: w.submittedAt, note: s.note });
}

function view(ctx: Ctx, sig: string, lane: DepositLane, stage: DepositStage, o: { creditedPico?: bigint; creditedAt?: Date; units?: bigint | null; block?: bigint | null; submittedAt: string | null; note?: string }): DepositProgress {
  const units = o.units ?? (o.creditedPico !== undefined ? o.creditedPico / 1_000_000n : null);
  const usd = o.creditedPico !== undefined ? picoToUsd(o.creditedPico) : units !== null ? Number(formatUsdc(units)) : null;
  return {
    id: sig, lane, tx_hash: sig, tx_url: explorerTx(ctx, sig), stage, block: o.block?.toString() ?? null,
    amount: units !== null ? formatUsdc(units) : null, symbol: "USDC",
    credited_usd: stage === "credited" ? usd : null, worth_usd: usd, worth_fixed: true,
    submitted_at: o.submittedAt, credited_at: o.creditedAt?.toISOString() ?? null, expected_final_at: null,
    ...(o.note ? { note: o.note } : {}),
  };
}

/** The keys of an account (for callers that map a deposit's key hash back to the account). */
export const accountKeyHashes = async (ctx: Ctx, accountId: string) => (await ctx.db.select({ chainKeyHash: keys.chainKeyHash }).from(keys).where(eq(keys.accountId, accountId))).map((k) => k.chainKeyHash);
