import { eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import type { Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import type { Cost } from "../router/pricing.ts";

// What happens when a provider reports more usage than was held for a call (security review R3-02).
//
// A hold is the bound of a request: the prompt bound at the dearest input price plus the output cap that was sent
// upstream. Usage priced above it means the provider ignored the cap, over-generated or over-reported. Then:
//   - the caller is charged the hold and no more (ledger.settle);
//   - the provider is owed, for that generation, no more than the caller was charged (payableWithin: this is what the
//     generation row records as upstream cost, which is what the settlement job pays from);
//   - the event is logged as an error under a stable message, counted here per provider (kv `hold_exceeded:<provider>`,
//     so repeat offenders can be listed), recorded against the provider's health as `over_report` (which takes it out
//     of routing once two different callers have seen it inside the outage window), and raised as the readiness
//     warning `hold_exceeded` (metric trellis_readiness_warning{warning="hold_exceeded"}, alert TrellisHoldExceeded).
// The operator absorbs nothing silently.

export const HOLD_EXCEEDED_KEY = "hold_exceeded";
export const PROVIDER_OVER_REPORT_LOG = "provider reported usage above the hold; caller charged the hold, provider not paid beyond it";
export const OVER_REPORT_KIND = "over_report";

type Split = Pick<Cost, "upstream" | "royalty" | "margin">;

/**
 * What a generation may pay out when the caller was charged less than its list cost because the hold capped it: the
 * provider first, then the royalty, then the margin, never more in total than `charged` (plus `covered`, the part a
 * prepaid-capacity allowance paid for). With nothing capped the split is returned unchanged.
 */
export function payableWithin(cost: Split, charged: Pico, covered: Pico = 0n): Split {
  const paid = charged + covered;
  if (cost.upstream + cost.royalty + cost.margin <= paid) return { upstream: cost.upstream, royalty: cost.royalty, margin: cost.margin };
  const upstream = cost.upstream < paid ? cost.upstream : paid;
  const royalty = cost.royalty < paid - upstream ? cost.royalty : paid - upstream;
  const rest = paid - upstream - royalty;
  return { upstream, royalty, margin: cost.margin < rest ? cost.margin : rest };
}

export type HoldExceeded = {
  generationId: string;
  providerId: string;
  modelId: string;
  /** The list price of the usage the provider reported, and what the caller was charged (the hold). */
  listCost: Pico;
  charged: Pico;
  usage: { prompt: number; completion: number };
  /** Truncated hash of the calling account, as health events carry it. */
  caller?: string | null;
};

type Counter = { count: number; excess_pico: string; last_at: string; last_generation: string; last_provider?: string; last_model?: string };

async function bump(ctx: Ctx, key: string, e: HoldExceeded, excess: Pico) {
  const next = (prev: Counter | undefined): Counter => ({
    count: (prev?.count ?? 0) + 1,
    excess_pico: (BigInt(prev?.excess_pico ?? "0") + excess).toString(),
    last_at: new Date().toISOString(),
    last_generation: e.generationId,
    last_provider: e.providerId,
    last_model: e.modelId,
  });
  await ctx.db.transaction(async (tx) => {
    await tx.insert(kv).values({ key, value: { count: 0, excess_pico: "0", last_at: "", last_generation: "" } satisfies Counter }).onConflictDoNothing();
    const [row] = await tx.select().from(kv).where(eq(kv.key, key)).for("update");
    await tx.update(kv).set({ value: next(row?.value as Counter | undefined), updatedAt: sql`now()` }).where(eq(kv.key, key));
  });
}

/** Record, log and alarm one over-report. Never throws: the call it belongs to is already settled. */
export async function noteHoldExceeded(ctx: Ctx, e: HoldExceeded): Promise<void> {
  const excess = e.listCost > e.charged ? e.listCost - e.charged : 0n;
  const [tokensIn, tokensOut] = [e.usage.prompt, e.usage.completion]; // counts only: nothing of the request itself is logged
  log.error(PROVIDER_OVER_REPORT_LOG, { generation: e.generationId, provider: e.providerId, model: e.modelId, list_cost: e.listCost, charged: e.charged, excess, tokens_in: tokensIn, tokens_out: tokensOut });
  ctx.health.record({ modelId: e.modelId, providerId: e.providerId, ok: false, errorKind: OVER_REPORT_KIND, source: "traffic", caller: e.caller ?? null });
  try {
    await bump(ctx, HOLD_EXCEEDED_KEY, e, excess);
    await bump(ctx, `${HOLD_EXCEEDED_KEY}:${e.providerId}`, e, excess);
  } catch (err) {
    log.error("recording a hold-exceeded event failed", { generation: e.generationId, provider: e.providerId, error: (err as Error).message.slice(0, 160) });
  }
}

/** The readiness warning: up while a provider reported more than was held within HOLD_EXCEEDED_ALERT_WINDOW_S. */
export async function holdWarnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, HOLD_EXCEEDED_KEY));
  const c = row?.value as Counter | undefined;
  if (!c?.last_at || Date.now() - Date.parse(c.last_at) > ctx.cfg.holds.exceededAlertWindowMs) return [];
  return [{ code: "hold_exceeded", reason: "provider_over_report", message: `A provider reported usage above the amount held (${c.count} time(s) in all, last at ${c.last_at}); callers were charged the hold and the provider is not paid beyond it. See the kv rows hold_exceeded:<provider>.` }];
}
