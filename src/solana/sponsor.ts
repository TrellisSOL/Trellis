import { and, eq, gt, sql } from "drizzle-orm";
import type { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { facilitatorSettlements } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { withRetry } from "./rpc.ts";

// Sponsored network fees (security review round 3, R3-01 and R3-17).
//
// Two keys of this router pay the fee of transactions other people sign: the router key on the per-call x402 path and
// the relay of the hosted facilitator. A stranger chooses how many such transactions there are, so everything here is
// about one question: how much SOL can a caller make the fee payer spend, and what does it cost the caller?
//
//  - Per transaction the fee payer pays at most `worstCaseLamports` (the verifier bounds signatures and priority fee and
//    refuses anything that would create an account at the fee payer's cost, src/solana/x402.ts).
//  - Before the fee payer signs, `sponsorAdmit` takes that worst case from budgets nobody can stretch by choosing
//    addresses (per minute and per day), from the payer's own daily share, and counts the payer and the source address
//    against per-minute limits. The fee payer's balance must be above its floor.
//  - The transaction is simulated first. One that would fail is not sent, and `release()` hands the budgets back: a
//    caller whose payments cannot succeed spends nothing of the operator's and uses up nobody's budget (R3-17).
//  - A payer whose payment failed after it was sent (it passed simulation and was then made to fail: the fee is paid for
//    nothing) is not sponsored again for `failedPayerBlockDays`. Repeating that takes a new funded address every time.
//  - On the per-call path the payer bears the network fee of its own payment (src/solana/percall.ts): the quote names
//    the most it can be, and what is kept back is the fee of the transaction as it was signed, no more. A payment that
//    succeeds therefore costs the operator nothing and its sender the fee.
//
// The lamport budgets are continuously refilled (RateLimiter.spend), like the credits program's outflow limiter: over
// ANY minute and ANY 24 hours at most the configured amount, at most a quarter of it at once. There is no window
// boundary across which two budgets could be spent back to back. The per-address counts (payments a minute by one
// payer, one seller, one source) are ordinary per-minute rate limits: they are keyed by what the caller chooses and
// bound nobody's money; the budgets do.

export type SponsorScope = "x402" | "relay";
export type SponsorRefusal = { ok: false; reason: "rate_limited" | "facilitator_unavailable" | "payer_not_sponsored"; status: 429 | 503 | 403 };
export type SponsorAdmission = { ok: true; /** Hand the budgets back: nothing was sent. */ release(): Promise<void> } | SponsorRefusal;

const DAY = 86_400_000;
export const FAILED_ON_CHAIN = "failed_on_chain";

/** Whether a sponsored payment of `payer` failed after it was sent within the block period. */
export async function payerBlocked(ctx: Ctx, payer: string): Promise<boolean> {
  const since = new Date(Date.now() - ctx.cfg.facilitator.sponsor.failedPayerBlockDays * DAY);
  const [row] = await ctx.db.select({ id: facilitatorSettlements.id }).from(facilitatorSettlements).where(and(eq(facilitatorSettlements.payer, payer), eq(facilitatorSettlements.status, "failed"), eq(facilitatorSettlements.error, FAILED_ON_CHAIN), gt(facilitatorSettlements.createdAt, since))).limit(1);
  return !!row;
}

/**
 * Whether `feePayer` may sign a transaction for `payer` now. Order matters: what is keyed by the caller's own addresses
 * comes first, the shared budgets last, so a caller that is refused for its own reasons takes nothing from anyone else.
 */
export async function sponsorAdmit(ctx: Ctx, o: { scope: SponsorScope; feePayer: PublicKey; payer: string; /** The per-source count limit, taken where the caller's address is in hand; false refuses. */ sourceOk?: () => Promise<boolean>; seller?: string; worstCaseLamports: number }): Promise<SponsorAdmission> {
  const f = ctx.cfg.facilitator, s = f.sponsor;
  const relay = o.scope === "relay";
  if (await payerBlocked(ctx, o.payer)) return { ok: false, reason: "payer_not_sponsored", status: 403 };
  const limited: SponsorRefusal = { ok: false, reason: "rate_limited", status: 429 };
  if (!(await ctx.limiter.take(`sponsor-payer:${o.scope}:${o.payer}`, 1, relay ? f.payerPerMin : s.payerPerMin, 60_000)).ok) return limited;
  if (relay && o.seller && !(await ctx.limiter.take(`sponsor-seller:${o.seller}`, 1, f.sellerPerMin, 60_000)).ok) return limited;
  if (o.sourceOk && !(await o.sourceOk())) return limited;
  // The floor before any budget is touched: a fee payer that will not sign must not use up budget either.
  const floor = relay ? f.relayFloorLamports : s.floorLamports;
  if (floor > 0n) {
    const balance = await withRetry(() => ctx.chain.connection.getBalance(o.feePayer, ctx.cfg.solana.commitment)).catch(() => null);
    if (balance === null || BigInt(balance) < floor) {
      log.error("sponsored fees: the fee payer is below its SOL balance floor (or its balance cannot be read); nothing is signed", { scope: o.scope, balance_lamports: balance, floor_lamports: floor.toString() });
      return { ok: false, reason: "facilitator_unavailable", status: 503 };
    }
  }
  // Three continuously refilled budgets, each handed back if a later one refuses or nothing is sent in the end.
  const cost = o.worstCaseLamports;
  const perMin = relay ? f.relayLamportsPerMin : s.perMinLamports, perDay = relay ? f.relayLamportsPerDay : s.perDayLamports;
  const undo: (() => Promise<void>)[] = [];
  const release = async () => { for (const back of undo.splice(0)) await back().catch(() => undefined); };
  if (!(await ctx.limiter.spend(`sponsor-payer-lamports:${o.scope}:${o.payer}`, cost, s.payerLamportsPerDay, 86_400_000)).ok) return limited;
  undo.push(() => ctx.limiter.unspend(`sponsor-payer-lamports:${o.scope}:${o.payer}`, cost, s.payerLamportsPerDay, 86_400_000));
  if (!(await ctx.limiter.spend(`sponsor-budget-minute:${o.scope}`, cost, perMin, 60_000)).ok) {
    await release();
    log.warn("sponsored fees: the fee budget is used up; payment refused", { scope: o.scope, budget: "minute", limit_lamports: perMin });
    return limited;
  }
  undo.push(() => ctx.limiter.unspend(`sponsor-budget-minute:${o.scope}`, cost, perMin, 60_000));
  if (!(await ctx.limiter.spend(`sponsor-budget-day:${o.scope}`, cost, perDay, 86_400_000)).ok) {
    await release();
    log.warn("sponsored fees: the fee budget is used up; payment refused", { scope: o.scope, budget: "day", limit_lamports: perDay });
    return limited;
  }
  undo.push(() => ctx.limiter.unspend(`sponsor-budget-day:${o.scope}`, cost, perDay, 86_400_000));
  return { ok: true, release };
}

/**
 * The network-fee account of the per-call path over the last `days`: what the router key paid in lamports for payments
 * that settled, what was kept back from those payments in USDC, and what was paid for payments that failed on chain
 * (recovered from nobody). Zero markup means the USDC kept back is the SOL paid, at the SOL price the operator
 * configured (X402_SOL_USDC) and nothing on top: `recovered_usdc_units` is exactly `sum(ceil(lamports x price))`.
 * If that price is above what the operator really pays for SOL, the difference is the operator's to see here and to
 * remove by lowering the setting: this report shows it as `recovered_usdc_units` against `fee_lamports_paid` at the
 * real SOL price. It is money earmarked for the fee payer, not revenue.
 */
export async function networkFeeAccount(ctx: Ctx, days = 30) {
  const since = new Date(Date.now() - days * DAY);
  const [row] = await ctx.db
    .select({
      settled: sql<number>`count(*) filter (where ${facilitatorSettlements.status} = 'settled' and ${facilitatorSettlements.feeLamports} is not null)::int`,
      paid: sql<string>`coalesce(sum(${facilitatorSettlements.feeLamports}) filter (where ${facilitatorSettlements.status} = 'settled'), 0)::text`,
      recovered: sql<string>`coalesce(sum(${facilitatorSettlements.gasDebit}) filter (where ${facilitatorSettlements.status} = 'settled' and ${facilitatorSettlements.feeLamports} is not null), 0)::text`,
      failed: sql<number>`count(*) filter (where ${facilitatorSettlements.error} = ${FAILED_ON_CHAIN})::int`,
      lost: sql<string>`coalesce(sum(${facilitatorSettlements.feeLamports}) filter (where ${facilitatorSettlements.error} = ${FAILED_ON_CHAIN}), 0)::text`,
    })
    .from(facilitatorSettlements)
    .where(gt(facilitatorSettlements.createdAt, since));
  const s = ctx.cfg.facilitator.sponsor;
  return {
    days,
    basis: "pass-through of the Solana network fee of each sponsored payment, at cost: no margin, no buffer",
    sol_usdc_units: s.solUsdc.toString(),
    settled_payments: row?.settled ?? 0,
    fee_lamports_paid: row?.paid ?? "0",
    recovered_usdc_units: row?.recovered ?? "0",
    failed_on_chain: row?.failed ?? 0,
    unrecovered_lamports: row?.lost ?? "0",
    quote_max_usdc_units: s.maxFeeUnits.toString(),
    min_payment_usdc_units: s.minPaymentUnits.toString(),
  };
}
