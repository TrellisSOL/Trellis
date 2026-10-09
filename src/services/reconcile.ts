import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { generations, kv } from "../db/schema.ts";
import { usdToPico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { RECONCILE_STATUS_KEY, type ReconcileStatus } from "./billing-watch.ts";

// The daily provider reconciliation (security review R4-02): job `provider-reconcile`.
//
// For each provider and the last complete UTC day it compares
//   payable    what the router recorded as owed to the provider (sum of generations.upstream_cost)
//   collected  what its calls charged their callers (sum of generations.cost)
//   invoiced   what the provider billed, when the operator recorded it (scripts/provider-invoice.ts, kv provider-invoice:<p>:<day>)
// and alarms (an error log line, the readiness warning `provider_reconcile_gap`, alert TrellisProviderReconcileGap) when
//   payable_above_collected   the provider is owed more than was collected: the operator is paying for calls;
//   invoice_above_payable     the provider billed more than the router recorded: work it metered that the router did not
//                             charge (aborted calls, a different usage format, an ignored output cap);
//   invoice_below_payable     it billed less: callers were charged for work the provider did not bill.
// by more than RECONCILE_GAP_ALARM_USD. It moves no money and changes no row.

export const RECONCILE_GAP_LOG = "provider reconciliation: what is owed, collected and invoiced do not agree";
const invoiceKey = (provider: string, day: string) => `provider-invoice:${provider}:${day}`;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Record what a provider invoiced for one UTC day (pico-USD as a decimal string). Replaces an earlier figure for that day. */
export async function recordProviderInvoice(ctx: Ctx, provider: string, day: string, pico: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,30}$/.test(pico) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider)) throw new Error("recordProviderInvoice: provider id, YYYY-MM-DD day and a pico-USD integer are required.");
  const value = { pico, recorded_at: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key: invoiceKey(provider, day), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export type ProviderDay = { provider: string; calls: number; estimated: number; payable_pico: string; collected_pico: string; gap_pico: string; invoiced_pico: string | null };

/** Reconcile the UTC day before `now`. */
export async function runProviderReconcile(ctx: Ctx, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  const day = dayOf(start);
  const rows = await ctx.db
    .select({
      provider: generations.providerId,
      calls: sql<number>`count(*)::int`,
      estimated: sql<number>`count(*) filter (where (${generations.receipt} -> 'tokens' ->> 'estimated') = 'true')::int`,
      payable: sql<string>`coalesce(sum(${generations.upstreamCost}), 0)::text`,
      collected: sql<string>`coalesce(sum(${generations.cost}), 0)::text`,
    })
    .from(generations)
    .where(and(gte(generations.ts, start), lt(generations.ts, end), eq(generations.isByok, false), sql`${generations.providerId} <> 'cache'`))
    .groupBy(generations.providerId);
  const threshold = usdToPico(ctx.cfg.routing.reconcileGapAlarmUsd);
  const providers: ProviderDay[] = [];
  const alarms: ReconcileStatus["alarms"] = [];
  for (const r of rows) {
    if (!r.provider) continue;
    const payable = BigInt(r.payable), collected = BigInt(r.collected);
    const gap = payable - collected;
    const [inv] = await ctx.db.select().from(kv).where(eq(kv.key, invoiceKey(r.provider, day)));
    const invoiced = inv ? BigInt((inv.value as { pico: string }).pico) : null;
    providers.push({ provider: r.provider, calls: r.calls, estimated: r.estimated, payable_pico: payable.toString(), collected_pico: collected.toString(), gap_pico: gap.toString(), invoiced_pico: invoiced?.toString() ?? null });
    if (gap > threshold) alarms.push({ provider: r.provider, reason: "payable_above_collected", gap_pico: gap.toString() });
    if (invoiced !== null && invoiced - payable > threshold) alarms.push({ provider: r.provider, reason: "invoice_above_payable", gap_pico: (invoiced - payable).toString() });
    if (invoiced !== null && payable - invoiced > threshold) alarms.push({ provider: r.provider, reason: "invoice_below_payable", gap_pico: (payable - invoiced).toString() });
  }
  for (const a of alarms) log.error(RECONCILE_GAP_LOG, { day, provider: a.provider, reason: a.reason, gap_pico: a.gap_pico });
  const status: ReconcileStatus = { day, at: new Date().toISOString(), alarms };
  await ctx.db.insert(kv).values({ key: RECONCILE_STATUS_KEY, value: status }).onConflictDoUpdate({ target: kv.key, set: { value: status, updatedAt: new Date() } });
  return { day, providers, alarms };
}
