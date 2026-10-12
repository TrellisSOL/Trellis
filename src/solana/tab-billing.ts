import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import type { Tx } from "../db/client.ts";
import { kv, ledger } from "../db/schema.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsdc, usdcToPico, type Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { ADDRESS_RE } from "./constants.ts";
import { checkVoucherAgainstTab, isVerifiedAccountError, maxUnvouched, mayServe, readRulebook, readTab, readTabConfig, parseVoucherBytes, rulebookRefusal, supersedes, tabEscrowProblem, tabProgram, VOUCHER_MSG_LEN, type TabAccount, type TabProgram, type Voucher, type VoucherScope } from "./tab.ts";

// Tab billing in the chat path (docs/Trellis_Backend.md §5.2). A caller with an open trellis_tab sends
//   X-Trellis-Tab: <tab PDA>
//   X-Trellis-Tab-Voucher: <base64 110-byte message>.<base64 ed25519 signature>
// The message is "trellis:tab:voucher:v1" || tab program id || tab || Tab.created_at i64 LE || cumulative_used u64 LE ||
// seq u64 LE (src/solana/programs/tab.ts): it names the program and the opening of the tab it was signed for, and is
// signed by the session key registered on the tab.
// The router checks the voucher against the on-chain Tab (session key, cap, expiry, payee = this router's tab payee),
// keeps per-tab usage in the kv table (what was served, the highest voucher, the last request's cost) and applies the
// seller-exposure rule: it serves beyond the latest voucher by at most max(0.25 x last request cost, $0.05); past that it
// answers 402 with the cumulative_used the next voucher must carry. Money never moves per call: the tab's escrow is the
// balance, mirrored in the ledger as the internal account `tab_<pda>` (vouched amounts credited, usage settled against
// it) so holds, budgets and make-good work as for any account. The settlement side (tab-close.ts) posts the highest
// voucher with trellis_tab::close when the tab nears its cap or expiry; the escrow pays cumulative_used to the payee and
// refunds the rest to the payer.
//
// A tab bound to a trellis_rules rulebook (docs §5.5): the program counted its escrow against the rulebook's daily limit
// when it was opened, and never consults the rulebook at settlement. The router applies the per-call part: a killed or
// expired rulebook is refused with 402 before anything is served (kill() therefore stops the key here on the next
// request), and so is a request whose worst-case cost is above per_call_max. What was vouched before a kill is still
// collected by close.

export const TAB_HEADER = "x-trellis-tab";
export const TAB_VOUCHER_HEADER = "x-trellis-tab-voucher";
export const TAB_ACCOUNT_PREFIX = "tab_";
export const TAB_VOUCHER_KIND = "tab_voucher";
/** The highest voucher the usage record keeps is posted (close) once vouched usage reaches this share of the cap. */
export const CLOSE_AT_CAP_BPS = 9_000;
/** ... or within this many seconds of the tab's expiry. */
export const CLOSE_BEFORE_EXPIRY_S = 3_600;

export const tabAccountId = (pda: string) => `${TAB_ACCOUNT_PREFIX}${pda}`;
export const tabUsageKey = (network: string, pda: string) => `tab-usage:${network}:${pda}`;
export const tabVoucherRef = (pda: string, seq: bigint) => `tab:${pda}:voucher:${seq}`;

/** The per-tab usage record (kv value). Amounts are strings: USDC base units for voucher fields, pico-USD for usage. */
export type TabUsage = {
  payer: string;
  payee: string;
  cap: string; // units
  expiry: string; // unix seconds
  /** The highest voucher seen: cumulative_used (units), seq and its signature (base64), so the close job can post it. */
  cumulativeUsed: string;
  seq: string;
  signature: string | null;
  /** Vouched amount already credited to the ledger account (units), so each voucher delta is credited once. */
  credited: string;
  /** Usage settled against the tab (pico-USD) and the last request's charged cost (pico-USD). */
  served: string;
  lastRequestCost: string;
  requests: number;
  closed: { tx: string; at: string; reason: string } | null;
  updatedAt: string;
};

export type TabBilling = { pda: string; tab: PublicKey; payer: string; sessionKey: string; cap: bigint; expiry: bigint; voucher: Voucher; signature: Uint8Array; usage: TabUsage; maxUnvouched: bigint; /** The per-call maximum (USDC units) of the rulebook the tab is bound to, or null. */ perCallMax?: bigint | null };

/** The payee a tab must name: TAB_PAYEE, else the x402 payTo, else the router signing key (the one that can close). */
export function tabPayee(ctx: Ctx): string | null {
  return ctx.cfg.tab.payee ?? ctx.cfg.x402.payTo ?? ctx.chain.roleAddress("router") ?? null;
}

/** Tab billing is on when the tab program and a payee are configured. */
export const tabBillingEnabled = (ctx: Ctx) => !!tabProgram(ctx.cfg) && !!tabPayee(ctx);

export const hasTabHeaders = (c: Context) => !!c.req.header(TAB_HEADER) || !!c.req.header(TAB_VOUCHER_HEADER);

/** The wire form of a voucher: `<base64 message>.<base64 signature>`. */
export function encodeVoucherHeader(message: Uint8Array, signature: Uint8Array) {
  return `${Buffer.from(message).toString("base64")}.${Buffer.from(signature).toString("base64")}`;
}

export type ParsedVoucher = { voucher: Voucher; signature: Uint8Array; /** The program and tab opening the message names (what the payer signed for). */ scope: VoucherScope };

/** Decode the voucher header; null when malformed (wrong lengths, not base64, not a v1 voucher message, tab mismatch). */
export function parseVoucherHeader(value: string, tab: PublicKey): ParsedVoucher | null {
  const parts = value.trim().split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9+/=]+$/.test(parts[0]) || !/^[A-Za-z0-9+/=]+$/.test(parts[1])) return null;
  const message = Buffer.from(parts[0], "base64");
  const signature = Buffer.from(parts[1], "base64");
  if (message.length !== VOUCHER_MSG_LEN || signature.length !== 64) return null;
  const parsed = parseVoucherBytes(message);
  if (!parsed || !parsed.voucher.tab.equals(tab)) return null;
  return { voucher: { tab, cumulativeUsed: parsed.voucher.cumulativeUsed, seq: parsed.voucher.seq }, signature: new Uint8Array(signature), scope: parsed.scope };
}

export async function readTabUsage(ctx: Ctx, pda: string): Promise<TabUsage | null> {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, tabUsageKey(ctx.cfg.chain.network, pda)));
  return (row?.value as TabUsage | undefined) ?? null;
}

export async function writeTabUsage(ctx: Ctx, pda: string, u: TabUsage) {
  const value = { ...u, updatedAt: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key: tabUsageKey(ctx.cfg.chain.network, pda), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  return value;
}

// ---- One tab, one writer at a time (security review TR-15) ---------------------------------------------------------------
// The usage record is one kv row that several requests on the same tab read, change and write back. Done as separate
// statements that is a lost update: two requests with vouchers seq 1 (10 USDC) and seq 2 (20 USDC) both read
// `credited = 0` and credited 10 and 20, and a request that had read the record earlier wrote back an old `served` over
// what a finishing request had just recorded. Every change now happens inside one database transaction that first takes
// the row lock on the tab's kv row (`SELECT ... FOR UPDATE`; the row is created first when it is missing, so there is
// always a row to lock), then reads the record, and writes it before the lock is released.

/** Lock a tab's usage row for the rest of the transaction and return the record as it stands (`initial` when new). */
async function lockTabUsage(tx: Tx, ctx: Ctx, pda: string, initial: TabUsage): Promise<TabUsage> {
  const key = tabUsageKey(ctx.cfg.chain.network, pda);
  await tx.insert(kv).values({ key, value: initial }).onConflictDoNothing();
  const [row] = await tx.select().from(kv).where(eq(kv.key, key)).for("update");
  return (row?.value as TabUsage | undefined) ?? initial;
}

/** Write the usage record inside the transaction that holds its row lock. */
async function saveTabUsage(tx: Tx, ctx: Ctx, pda: string, u: TabUsage): Promise<TabUsage> {
  const value = { ...u, updatedAt: new Date().toISOString() };
  await tx.update(kv).set({ value, updatedAt: new Date() }).where(eq(kv.key, tabUsageKey(ctx.cfg.chain.network, pda)));
  return value;
}

/**
 * Change a tab's usage record atomically: `change` receives the record as it stands under the row lock and returns the
 * record to store. Use this (not read-then-`writeTabUsage`) for any change that depends on the current record, so a
 * concurrent request's update is never overwritten. `initial` is stored first when the tab has no record yet.
 */
export async function updateTabUsage(ctx: Ctx, pda: string, initial: TabUsage, change: (current: TabUsage) => TabUsage): Promise<TabUsage> {
  return ctx.db.transaction(async (tx) => saveTabUsage(tx, ctx, pda, change(await lockTabUsage(tx, ctx, pda, initial))));
}

/** USDC units the ledger has credited to a tab's account for vouchers so far (the sum of its `tab_voucher` rows). */
async function voucherCreditedUnits(tx: Tx, accountId: string): Promise<bigint> {
  const [row] = await tx.select({ pico: sql<string | null>`sum(${ledger.amount})::text` }).from(ledger).where(and(eq(ledger.accountId, accountId), eq(ledger.kind, TAB_VOUCHER_KIND)));
  return picoToUsdc(BigInt(row?.pico ?? "0"), "floor");
}

/** Every tab usage record on this network (the close job walks them). */
export async function listTabUsage(ctx: Ctx): Promise<{ pda: string; usage: TabUsage }[]> {
  const prefix = tabUsageKey(ctx.cfg.chain.network, "");
  const rows = await ctx.db.select().from(kv);
  return rows.filter((r) => r.key.startsWith(prefix)).map((r) => ({ pda: r.key.slice(prefix.length), usage: r.value as TabUsage }));
}

const freshUsage = (t: TabAccount): TabUsage => ({
  payer: t.payer.toBase58(), payee: t.payee.toBase58(), cap: t.cap.toString(), expiry: t.expiry.toString(),
  cumulativeUsed: t.postedUsed.toString(), seq: t.postedSeq.toString(), signature: null, credited: "0",
  served: "0", lastRequestCost: "0", requests: 0, closed: null, updatedAt: new Date().toISOString(),
});

const tabError = (status: number, message: string, type: string, meta: Record<string, unknown>) => new ApiError(status, message, type, meta);

/**
 * Resolve the tab a request pays with: headers, the on-chain Tab, the voucher check and the usage record. Throws 400 for
 * malformed headers, 503 when tabs are not configured, 402 when the voucher does not fit the tab.
 */
export async function resolveTab(ctx: Ctx, c: Context): Promise<TabBilling> {
  const program = tabProgram(ctx.cfg);
  const payee = tabPayee(ctx);
  if (!program || !payee) fail(503, "Tab payments are not configured on this router (TRELLIS_TAB_PROGRAM_ID and a payee).", "tab_unavailable");
  const pdaText = c.req.header(TAB_HEADER)?.trim() ?? "";
  if (!ADDRESS_RE.test(pdaText)) fail(400, "X-Trellis-Tab must be the tab's base58 address.", "invalid_tab");
  const tab = new PublicKey(pdaText);
  const pda = tab.toBase58();
  const voucherHeader = c.req.header(TAB_VOUCHER_HEADER);
  if (!voucherHeader) fail(400, "X-Trellis-Tab-Voucher is required with X-Trellis-Tab: <base64 110-byte message>.<base64 ed25519 signature>.", "invalid_tab_voucher");
  const parsed = parseVoucherHeader(voucherHeader, tab);
  if (!parsed) fail(400, "X-Trellis-Tab-Voucher is malformed: expected <base64 110-byte \"trellis:tab:voucher:v1\"||program||tab||created_at||cumulative_used||seq>.<base64 64-byte signature> for this tab. The 48-byte form (tab||cumulative_used||seq) is no longer accepted.", "invalid_tab_voucher");
  // The address comes from the request: it is a tab only if the tab program owns the account and it is the program's PDA
  // for its own (payer, payee, tab_id). An account that merely carries Tab-shaped bytes is refused here (TR-02).
  const onchain = await readTab(ctx.chain.connection, tab, program!).catch((e) => {
    if (isVerifiedAccountError(e)) throw tabError(402, "That address is not a tab of this router's tab program: open one with trellis_tab::open_tab.", e.code, { tab: pda, payee, program: program!.programId.toBase58() });
    log.warn("tab read failed", { error: (e as Error).message.slice(0, 120) });
    return undefined;
  });
  if (onchain === undefined) fail(503, "The tab could not be read from the chain; retry shortly.", "chain_unavailable");
  if (!onchain) throw tabError(402, "No open tab at that address: open one with trellis_tab::open_tab naming this router as payee.", "tab_not_found", { tab: pda, payee });
  // The escrow is what pays: a tab whose escrow holds less than its cap cannot be collected in full, so it is not served.
  const underfunded = tabEscrowProblem(onchain);
  if (underfunded) throw tabError(402, "The tab's escrow holds less USDC than its cap; it cannot be charged.", underfunded, { tab: pda, cap: onchain.cap.toString(), escrow: onchain.escrow.toBase58(), escrow_amount: onchain.escrowAmount.toString() });
  const config = await readTabConfig(ctx.chain.connection, program!).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  // What the payer signed for must be this program and this opening of the tab (TR-19). The signature check below uses
  // the chain's values whatever the message says; these two answers only tell an honest client what to fix.
  if (!parsed!.scope.programId.equals(program!.programId)) throw tabError(402, "The voucher was signed for another tab program (another cluster or deployment).", "voucher_wrong_program", { tab: pda, program: program!.programId.toBase58() });
  if (parsed!.scope.createdAt !== onchain.createdAt) throw tabError(402, "The voucher was signed for an earlier opening of this tab address; sign with the open tab's created_at.", "voucher_wrong_tab_opening", { tab: pda, created_at: onchain.createdAt.toString() });
  const problem = checkVoucherAgainstTab(onchain, parsed!.voucher, parsed!.signature, { programId: program!.programId, payee: new PublicKey(payee), mint: program.mint, now, reclaimGrace: config ? Number(config.reclaimGrace) : undefined });
  if (problem) throw tabError(402, voucherProblemText(problem), problem, { tab: pda, payee, cap: onchain.cap.toString(), expiry: onchain.expiry.toString(), posted_seq: onchain.postedSeq.toString(), posted_used: onchain.postedUsed.toString() });
  if (BigInt(now) > onchain.expiry) throw tabError(402, "The tab has expired; open a new one.", "tab_expired", { tab: pda, expiry: onchain.expiry.toString() });
  let perCallMax: bigint | null = null;
  if (onchain.rulebook) {
    // The rulebook is read on every request: its owner can kill it at any moment.
    // trellis_rules as the tab program's (verified) config names it, else TRELLIS_RULES_PROGRAM_ID: the rulebook must be
    // that program's account at its own PDA, or it is no rulebook at all (TR-02).
    const rulesProgram = config?.rulesProgram ?? (ctx.cfg.solana.programs.rules ? new PublicKey(ctx.cfg.solana.programs.rules) : null);
    if (!rulesProgram) fail(503, "The tab is bound to a rulebook and the rules program is not known to this router.", "chain_unavailable");
    const rulebook = await readRulebook(ctx.chain.connection, onchain.rulebook, rulesProgram!).catch((e) => {
      if (isVerifiedAccountError(e)) throw tabError(402, "The account this tab names as its rulebook is not a rulebook of the rules program: the tab cannot be charged.", e.code, { tab: pda, rulebook: onchain.rulebook!.toBase58() });
      log.warn("rulebook read failed", { error: (e as Error).message.slice(0, 120) });
      return undefined;
    });
    if (rulebook === undefined) fail(503, "The tab's rulebook could not be read from the chain; retry shortly.", "chain_unavailable");
    // A tab may only be bound to its payer's own rulebook (the program refuses anything else at open_tab; a tab opened
    // before that rule could name someone else's, and is not served).
    if (rulebook && !rulebook.owner.equals(onchain.payer)) throw tabError(402, "The tab is bound to a rulebook that is not its payer's own: the tab cannot be charged.", "rulebook_not_payers", { tab: pda, rulebook: onchain.rulebook.toBase58() });
    // Killed or expired stops the tab at once. The per-call maximum is checked against this request's own cost once it
    // is known (tabCreditLine); the daily maximum was applied by the program to the whole escrow when the tab was opened.
    const refusal = rulebook ? rulebookRefusal(rulebook, 0n, now) : "rulebook_killed";
    perCallMax = rulebook?.perCallMax ?? null;
    if (refusal) throw tabError(402, rulebookRefusalText(refusal), refusal, { tab: pda, rulebook: onchain.rulebook.toBase58(), ...(rulebook ? { per_call_max: rulebook.perCallMax.toString(), daily_max: rulebook.dailyMax.toString(), expiry: rulebook.expiry.toString(), killed: rulebook.killed } : {}) });
  }
  // ---- The tab's state changes under its row lock, in one transaction (TR-15) ----
  // Two requests on the same tab may be here at once. The record is read only after the lock is held, the amount to
  // credit is what the highest voucher vouches for minus what the LEDGER already holds for this tab's vouchers (not a
  // number remembered in the record), and the record is written before the lock is released.
  const accountId = tabAccountId(pda);
  const { usage, highest } = await ctx.db.transaction(async (tx) => {
    let u = await lockTabUsage(tx, ctx, pda, freshUsage(onchain!));
    if (u.closed) throw tabError(402, "This tab was closed; open a new one.", "tab_closed", { tab: pda, close_tx: u.closed.tx });
    // The highest voucher wins: a replayed older voucher is fine (it does not lower anything), a lower seq is ignored.
    const current: Voucher | null = u.signature ? { tab, cumulativeUsed: BigInt(u.cumulativeUsed), seq: BigInt(u.seq) } : null;
    const top = supersedes(current, parsed!.voucher) ? parsed!.voucher : current!;
    const topSig = top === parsed!.voucher ? Buffer.from(parsed!.signature).toString("base64") : u.signature;
    u = { ...u, cap: onchain!.cap.toString(), expiry: onchain!.expiry.toString(), cumulativeUsed: top.cumulativeUsed.toString(), seq: top.seq.toString(), signature: topSig };
    // Mirror the vouched amount in the ledger: the tab account's balance is what the payer has vouched for.
    await ensureAccount(tx, accountId, "tab", null);
    let credited = await voucherCreditedUnits(tx, accountId);
    if (top.cumulativeUsed > credited) {
      await post(tx, { accountId, amount: usdcToPico(top.cumulativeUsed - credited), kind: TAB_VOUCHER_KIND, ref: tabVoucherRef(pda, top.seq), description: `tab voucher #${top.seq}` });
      credited = await voucherCreditedUnits(tx, accountId);
    }
    u = { ...u, credited: credited.toString() };
    return { usage: await saveTabUsage(tx, ctx, pda, u), highest: top };
  });
  const lastCost = picoToUsdc(BigInt(usage.lastRequestCost), "ceil");
  return { pda, tab, payer: onchain.payer.toBase58(), sessionKey: onchain.sessionKey.toBase58(), cap: onchain.cap, expiry: onchain.expiry, voucher: highest, signature: highest === parsed!.voucher ? parsed!.signature : new Uint8Array(Buffer.from(usage.signature!, "base64")), usage, maxUnvouched: maxUnvouched(lastCost), perCallMax };
}

function rulebookRefusalText(code: string) {
  switch (code) {
    case "rulebook_killed": return "The rulebook this tab is bound to was killed by its owner: the tab can no longer be charged.";
    case "rulebook_expired": return "The rulebook this tab is bound to has expired: the tab can no longer be charged.";
    case "rulebook_per_call_max": return "This request could cost more than the per-call maximum of the rulebook the tab is bound to. Lower max_tokens.";
    default: return `The tab's rulebook refuses this request (${code}).`;
  }
}

function voucherProblemText(code: string) {
  switch (code) {
    case "tab_payee_mismatch": return "The tab names another payee; this router only serves tabs opened to its own payee address.";
    case "tab_asset_mismatch": return "The tab is not denominated in this router's USDC mint.";
    case "tab_expired": return "The tab has expired; open a new one.";
    case "voucher_exceeds_cap": return "The voucher's cumulative_used is above the tab's cap.";
    case "voucher_stale": return "The voucher is not newer than the one already posted on chain (seq and cumulative_used must increase).";
    case "invalid_voucher_signature": return "The voucher is not signed by the tab's session key.";
    default: return `The voucher was refused (${code}).`;
  }
}

/**
 * Seller exposure before a request is served: throws 402 (`voucher_required`, with the cumulative_used the next voucher
 * must carry) or (`tab_cap_exceeded`) when `hold` would take the tab past what the payee may serve unvouched. Returns the
 * ledger credit line (the unvouched allowance, pico) the hold may draw on.
 */
export function tabCreditLine(t: TabBilling, hold: Pico): Pico {
  const served = BigInt(t.usage.served);
  const servedUnits = picoToUsdc(served, "ceil");
  const holdUnits = picoToUsdc(hold, "ceil");
  const lastCost = picoToUsdc(BigInt(t.usage.lastRequestCost), "ceil");
  // The rulebook's per-call maximum binds one request: its worst-case cost, not the tab's running total.
  if (t.perCallMax != null && holdUnits > t.perCallMax) throw tabError(402, rulebookRefusalText("rulebook_per_call_max"), "rulebook_per_call_max", { tab: t.pda, hold: holdUnits.toString(), per_call_max: t.perCallMax.toString() });
  const r = mayServe({ cap: t.cap, vouched: t.voucher.cumulativeUsed, served: servedUnits, lastRequestCost: lastCost }, holdUnits);
  const allowance = maxUnvouched(lastCost > holdUnits ? lastCost : holdUnits);
  if (!r.ok) {
    const required = servedUnits + holdUnits;
    const meta = { tab: t.pda, cap: t.cap.toString(), vouched: t.voucher.cumulativeUsed.toString(), served: servedUnits.toString(), hold: holdUnits.toString(), max_unvouched: r.maxUnvouched.toString(), required_cumulative_used: required.toString(), next_seq: (t.voucher.seq + 1n).toString() };
    if (r.reason === "cap_exceeded") throw tabError(402, `This request may cost up to ${holdUnits} USDC units and the tab's remaining cap does not cover it: top up the tab or open a new one.`, "tab_cap_exceeded", meta);
    throw tabError(402, `A newer voucher is required: sign cumulative_used >= ${required} (seq ${t.voucher.seq + 1n}) with the tab's session key and resend as X-Trellis-Tab-Voucher.`, "voucher_required", meta);
  }
  return usdcToPico(allowance);
}

/** After settlement: what this request cost, so the next exposure check and the close job see it. */
export async function recordTabUsage(ctx: Ctx, t: TabBilling, charged: Pico) {
  // Under the tab's row lock (TR-15): `served` is added to the record as it stands now, not to a copy read earlier, so
  // requests finishing together each count and a request resolving the tab meanwhile cannot write an older total back.
  return updateTabUsage(ctx, t.pda, t.usage, (usage) => ({ ...usage, served: (BigInt(usage.served) + charged).toString(), lastRequestCost: charged.toString(), requests: usage.requests + 1 }));
}

/** Whether the close job should post the highest voucher now: near the cap, or near expiry, with something to collect. */
export function shouldClose(u: TabUsage, now = Math.floor(Date.now() / 1000)) {
  if (u.closed || !u.signature) return null;
  const used = BigInt(u.cumulativeUsed), cap = BigInt(u.cap);
  if (used <= 0n) return null;
  if (cap > 0n && used * 10_000n >= cap * BigInt(CLOSE_AT_CAP_BPS)) return "near_cap" as const;
  if (BigInt(now) + BigInt(CLOSE_BEFORE_EXPIRY_S) >= BigInt(u.expiry)) return "near_expiry" as const;
  return null;
}

/** The public `tabs` section of /api/v1/status. */
export function tabStatus(ctx: Ctx) {
  const program = ctx.cfg.solana.programs.tab ?? null;
  return { enabled: tabBillingEnabled(ctx), program, payee: tabPayee(ctx), headers: { tab: "X-Trellis-Tab", voucher: "X-Trellis-Tab-Voucher" }, voucher: "base64(\"trellis:tab:voucher:v1\" || program id || tab || created_at i64 LE || cumulative_used u64 LE || seq u64 LE) . base64(ed25519 signature by the session key)", voucher_version: "trellis:tab:voucher:v1", max_unvouched: "max(0.25 x last request cost, 0.05 USDC)", cap_usdc: Number(ctx.cfg.solana.caps.tabUnits) / 1e6, close_at_cap_bps: CLOSE_AT_CAP_BPS, close_before_expiry_s: CLOSE_BEFORE_EXPIRY_S };
}

export type { TabProgram };
