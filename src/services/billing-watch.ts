import { eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import type { Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";

// Billing alarms of security review round 4 (R4-02). At zero markup every difference between what a provider bills
// and what the router charged is the operator's, so the two places such a difference can arise are counted and raised
// as readiness warnings (each has an alert rule in monitoring/):
//
//   estimated_settlements   a call settled without the provider's usage figures: at the conservative bound
//                           (router/pricing.ts unmeteredUsage), because the provider reported none, the router's own
//                           timeout cut it off, or its caller left. Counted in all and per provider.
//   provider_reconcile_gap  the daily reconciliation (services/reconcile.ts) found a provider owed more than its calls
//                           collected, or an invoice the operator recorded that differs from what the router recorded.

export const ESTIMATED_KEY = "estimated_settlements";
export const ESTIMATED_LOG = "settled at an estimate: the provider reported no usage for this call";
/** The warning stays up this long after the last estimated settlement. */
export const ESTIMATED_ALERT_WINDOW_MS = 3_600_000;
export const RECONCILE_STATUS_KEY = "provider_reconcile_status";

type Counter = { count: number; charged_pico: string; last_at: string; last_generation: string; last_reason: string };

export type EstimatedSettlement = { providerId: string; generationId: string; reason: "timeout" | "cancelled" | "oversize" | "no_usage"; charged: Pico };

async function bump(ctx: Ctx, key: string, e: EstimatedSettlement) {
  await ctx.db.transaction(async (tx) => {
    await tx.insert(kv).values({ key, value: { count: 0, charged_pico: "0", last_at: "", last_generation: "", last_reason: "" } satisfies Counter }).onConflictDoNothing();
    const [row] = await tx.select().from(kv).where(eq(kv.key, key)).for("update");
    const prev = row?.value as Counter | undefined;
    const value: Counter = { count: (prev?.count ?? 0) + 1, charged_pico: (BigInt(prev?.charged_pico ?? "0") + e.charged).toString(), last_at: new Date().toISOString(), last_generation: e.generationId, last_reason: e.reason };
    await tx.update(kv).set({ value, updatedAt: sql`now()` }).where(eq(kv.key, key));
  });
}

/** Count, log and alarm one settlement that used no provider-reported usage. Never throws. */
export async function noteEstimatedSettlement(ctx: Ctx, e: EstimatedSettlement): Promise<void> {
  log.warn(ESTIMATED_LOG, { generation: e.generationId, provider: e.providerId, reason: e.reason, charged: e.charged });
  try {
    await bump(ctx, ESTIMATED_KEY, e);
    await bump(ctx, `${ESTIMATED_KEY}:${e.providerId}`, e);
  } catch (err) {
    log.error("recording an estimated settlement failed", { generation: e.generationId, error: (err as Error).message.slice(0, 160) });
  }
}

// ---- Security review round 5 ---------------------------------------------------------------------------------------
//
//   withheld_unattested   R5-09: an answer that required attested hardware was withheld because the gateway's receipt
//                         was missing or did not show it. The caller was NOT charged and no generation row was written
//                         (nothing is owed to the provider), so if the gateway bills such calls the cost is the
//                         operator's until it is disputed: it is counted (in all and per provider), raised as a
//                         readiness warning, and after WITHHELD_BREAKER_AFTER in a row the provider is taken out of
//                         routing for WITHHELD_BREAKER_MS (HealthTracker.suspend), then tried again.
//   unrecorded_calls      R5-15: a call a provider answered was charged but could not be recorded (no generation row,
//                         no receipt): the provider's invoice will carry a call the router's books do not.
//
// The breaker's invariants: a suspension always ends by itself (it is a time, never a state someone must clear); only a
// withheld answer whose caller was still there counts (api/chat.ts: a caller who leaves is charged instead), so a caller
// cannot trip it by hanging up; a verified receipt resets the count.

export const WITHHELD_KEY = "withheld_unattested";
export const WITHHELD_LOG = "an answer that required attested hardware was withheld: the gateway's receipt is missing or does not show it; nothing was charged";
export const WITHHELD_BREAKER_AFTER = 3;
export const WITHHELD_BREAKER_MS = 5 * 60_000;
export const UNRECORDED_KEY = "unrecorded_calls";
type Simple = { count: number; last_at: string; last_generation: string; last_reason: string };

async function bumpSimple(ctx: Ctx, key: string, generationId: string, reason: string) {
  await ctx.db.transaction(async (tx) => {
    await tx.insert(kv).values({ key, value: { count: 0, last_at: "", last_generation: "", last_reason: "" } satisfies Simple }).onConflictDoNothing();
    const [row] = await tx.select().from(kv).where(eq(kv.key, key)).for("update");
    const prev = row?.value as Simple | undefined;
    await tx.update(kv).set({ value: { count: (prev?.count ?? 0) + 1, last_at: new Date().toISOString(), last_generation: generationId, last_reason: reason.slice(0, 200) } satisfies Simple, updatedAt: sql`now()` }).where(eq(kv.key, key));
  });
}

/** Withheld answers in a row, per provider, in this process (the breaker's state; reset by a verified receipt). */
const withheldRuns = new WeakMap<object, Map<string, number>>();
const runsOf = (ctx: Ctx) => {
  let m = withheldRuns.get(ctx.health);
  if (!m) withheldRuns.set(ctx.health, (m = new Map()));
  return m;
};

/** Count, log and alarm one withheld, uncharged answer; trip the breaker after a few in a row. Never throws. */
export async function noteWithheldAnswer(ctx: Ctx, e: { providerId: string; modelId: string; generationId: string; reason: string }): Promise<void> {
  log.error(WITHHELD_LOG, { generation: e.generationId, provider: e.providerId, reason: e.reason.slice(0, 200) });
  const runs = runsOf(ctx);
  const run = (runs.get(e.providerId) ?? 0) + 1;
  runs.set(e.providerId, run);
  if (run >= WITHHELD_BREAKER_AFTER) {
    runs.set(e.providerId, 0);
    ctx.health.suspend(e.providerId, WITHHELD_BREAKER_MS);
    log.error("gateway receipts keep failing: the provider is out of routing for a while", { provider: e.providerId, in_a_row: run, for_ms: WITHHELD_BREAKER_MS });
  }
  try {
    await bumpSimple(ctx, WITHHELD_KEY, e.generationId, e.reason);
    await bumpSimple(ctx, `${WITHHELD_KEY}:${e.providerId}`, e.generationId, e.reason);
  } catch (err) {
    log.error("recording a withheld answer failed", { generation: e.generationId, error: (err as Error).message.slice(0, 160) });
  }
}

/** A gateway receipt verified: the provider's run of withheld answers is over. */
export const noteVerifiedReceipt = (ctx: Ctx, providerId: string): void => { runsOf(ctx).delete(providerId); };

/** Count and alarm one call that was charged but could not be recorded (R5-15). Never throws. */
export async function noteUnrecordedCall(ctx: Ctx, e: { providerId: string; generationId: string; charged: Pico }): Promise<void> {
  try {
    await bumpSimple(ctx, UNRECORDED_KEY, e.generationId, `${e.providerId}: charged ${e.charged} pico-USD`);
  } catch (err) {
    log.error("recording an unrecorded call failed", { generation: e.generationId, error: (err as Error).message.slice(0, 160) });
  }
}

export type ReconcileStatus = { day: string; at: string; alarms: { provider: string; reason: string; gap_pico: string }[] };

export async function billingWarnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const out: { code: string; reason: string; message: string }[] = [];
  const [est] = await ctx.db.select().from(kv).where(eq(kv.key, ESTIMATED_KEY));
  const c = est?.value as Counter | undefined;
  if (c?.last_at && Date.now() - Date.parse(c.last_at) <= ESTIMATED_ALERT_WINDOW_MS)
    out.push({ code: "estimated_settlements", reason: c.last_reason || "no_usage", message: `${c.count} call(s) in all were settled without the provider's usage figures (last at ${c.last_at}, reason ${c.last_reason}); each was charged the conservative bound. Compare the provider's invoice: kv rows estimated_settlements:<provider>.` });
  for (const [key, code, text] of [
    [WITHHELD_KEY, "withheld_unattested", "answer(s) that required attested hardware were withheld and NOT charged because the gateway's receipt was missing or did not show it. If the gateway bills them, dispute its invoice; check the gateway's receipt store and this router's clock"],
    [UNRECORDED_KEY, "unrecorded_calls", "call(s) a provider answered were charged but could not be recorded (no generation row, no receipt). Find the cause in the log, and expect them on the provider's invoice"],
  ] as const) {
    const [row] = await ctx.db.select().from(kv).where(eq(kv.key, key));
    const w = row?.value as Simple | undefined;
    if (w?.last_at && Date.now() - Date.parse(w.last_at) <= ESTIMATED_ALERT_WINDOW_MS) out.push({ code, reason: w.last_reason || code, message: `${w.count} ${text} (last at ${w.last_at}: ${w.last_reason}).` });
  }
  const [rec] = await ctx.db.select().from(kv).where(eq(kv.key, RECONCILE_STATUS_KEY));
  const r = rec?.value as ReconcileStatus | undefined;
  if (r?.alarms?.length)
    out.push({ code: "provider_reconcile_gap", reason: r.alarms[0]!.reason, message: `The reconciliation of ${r.day} found ${r.alarms.length} provider(s) where what is owed, what was collected and what was invoiced do not agree: ${r.alarms.slice(0, 5).map((a) => `${a.provider} (${a.reason})`).join(", ")}.` });
  return out;
}
