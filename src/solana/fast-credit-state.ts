import { and, eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { picoToUsd, usdToPico, type Pico } from "../lib/money.ts";

// Fast credit (docs/Trellis_Backend.md §Escrow deposits): an escrow deposit credited early, at the confirmed commitment,
// before the cluster finalizes its slot, within a per-account and a global cap of provisional (not yet final) credit.
// The escrow indexer (escrow.ts) records every provisional credit here, settles it `final` once the finalized scan sees
// the same transfer, or `reversed` when the transaction never finalized (the ledger then carries the compensating
// debit). Rows live in the kv table under fast-credit:deposit:<network>:<lane>:<tx>:<index>; the caps are computed from
// the rows still `provisional`, so a crash between the credit and the record can at worst leave one deposit uncounted
// against the cap until the next pass (the credit itself is idempotent on the ledger ref).

export type FastDeposit = { id: string; accountId: string; lane: "escrow" | "usdc"; txHash: string; logIndex: number; amount: string; credited: string; status: "provisional" | "final" | "reversed"; blockNumber: string; at: string; settledAt?: string };

export const fastDepositKey = (ctx: Ctx, lane: string, tx: string, index: number) => `fast-credit:deposit:${ctx.cfg.chain.network}:${lane}:${tx}:${index}`;
const prefix = (ctx: Ctx) => `fast-credit:deposit:${ctx.cfg.chain.network}:`;

/** Fast credit runs when it is switched on and there is an escrow to credit from. */
export async function fastCreditActive(ctx: Ctx) {
  return ctx.cfg.fastCredit.enabled && !!ctx.cfg.escrow.address;
}

async function allDeposits(ctx: Ctx): Promise<FastDeposit[]> {
  const rows = await ctx.db.select({ value: kv.value }).from(kv).where(like(kv.key, `${prefix(ctx)}%`));
  return rows.map((r) => r.value as FastDeposit);
}

/** Provisional credit outstanding (pico-USD): for one account and for every account. */
export async function fastCreditOutstanding(ctx: Ctx, accountId?: string): Promise<{ account: Pico; global: Pico }> {
  let account = 0n, global = 0n;
  for (const d of await allDeposits(ctx)) {
    if (d.status !== "provisional") continue;
    global += BigInt(d.credited);
    if (accountId && d.accountId === accountId) account += BigInt(d.credited);
  }
  return { account, global };
}

/** Whether `credited` pico-USD may be credited early for `accountId` now: both caps have the room. */
export async function fastCreditAllows(ctx: Ctx, accountId: string, credited: Pico): Promise<boolean> {
  if (!(await fastCreditActive(ctx))) return false;
  const out = await fastCreditOutstanding(ctx, accountId);
  return out.account + credited <= usdToPico(ctx.cfg.fastCredit.accountMaxUsd, "floor") && out.global + credited <= usdToPico(ctx.cfg.fastCredit.globalMaxUsd, "floor");
}

/** Record a provisional credit (idempotent on the key). */
export async function recordFastDeposit(ctx: Ctx, d: Omit<FastDeposit, "status" | "at" | "id">): Promise<FastDeposit> {
  const key = fastDepositKey(ctx, d.lane, d.txHash, d.logIndex);
  const row: FastDeposit = { ...d, id: `${d.txHash}:${d.logIndex}`, status: "provisional", at: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key, value: row }).onConflictDoNothing();
  const [saved] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  return (saved?.value as FastDeposit) ?? row;
}

/** Settle a provisional credit: `final` once finalized, `reversed` when the transaction never did. */
export async function settleFastDeposit(ctx: Ctx, lane: FastDeposit["lane"], txHash: string, logIndex: number, status: "final" | "reversed"): Promise<FastDeposit | null> {
  const key = fastDepositKey(ctx, lane, txHash, logIndex);
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(and(eq(kv.key, key)));
  if (!row) return null;
  const d = row.value as FastDeposit;
  if (d.status !== "provisional") return d;
  const settled: FastDeposit = { ...d, status, settledAt: new Date().toISOString() };
  await ctx.db.update(kv).set({ value: settled, updatedAt: new Date() }).where(eq(kv.key, key));
  return settled;
}

/** The `fast_credit` block of an account's key listing: the caps and what this account still has settling. */
export async function fastCreditFields(ctx: Ctx, accountId?: string) {
  if (!ctx.cfg.fastCredit.enabled) return {};
  const out = await fastCreditOutstanding(ctx, accountId);
  return { fast_credit: { enabled: true, confirmations: ctx.cfg.fastCredit.confirmations, account_max_usd: ctx.cfg.fastCredit.accountMaxUsd, global_max_usd: ctx.cfg.fastCredit.globalMaxUsd, settling_usd: picoToUsd(accountId ? out.account : out.global) } };
}

/** One durable alert check per reversal in the last 24 hours: a reversal means a confirmed deposit never finalized. */
export async function fastCreditAlertChecks(ctx: Ctx): Promise<Record<string, boolean>> {
  if (!(await fastCreditActive(ctx))) return {};
  const since = Date.now() - 86_400_000;
  const checks: Record<string, boolean> = { fast_credit_no_recent_reversal: true };
  for (const d of await allDeposits(ctx)) {
    if (d.status !== "reversed" || !d.settledAt || new Date(d.settledAt).getTime() < since) continue;
    checks.fast_credit_no_recent_reversal = false;
    checks[`fast_credit_reversal:${d.id}`] = false;
  }
  return checks;
}
