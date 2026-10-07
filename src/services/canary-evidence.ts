import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { canaries, offers, providers } from "../db/schema.ts";
import { slashEvidence } from "./evidence-schema.ts";
import { evidenceRootOf } from "./shadow.ts";
import { uid } from "../lib/util.ts";

// Canary → evidence (docs/Trellis_Backend.md §5.3, "Quantization swap (3/3 canaries): 25% + delist"). The canary job
// (src/services/canaries.ts) writes one row per model x provider per run into the `canaries` table and is not changed
// here: this job reads that table and, when a provider's three most recent canaries for a model all mismatched within
// the last 24 hours, writes one slash_evidence row with reason "quantization_swap" for the slasher to pick up. The row
// is keyed by the Merkle root of the three canary rows, so one run of three failures produces one row however often
// the job runs; a fourth failure (a new window of three) produces a new row.

export const QUANT_SWAP_REASON = "quantization_swap";
export const QUANT_SWAP_BPS = 2_500;
const DAY_MS = 86_400_000;
const NEEDED = 3;

type CanaryRow = typeof canaries.$inferSelect;

/** The three most recent canaries per model for one provider, newest first, within the window. */
async function recentCanaries(ctx: Ctx, providerId: string, modelIds: string[], since: Date) {
  const map = new Map<string, CanaryRow[]>();
  if (!modelIds.length) return map;
  const rows = await ctx.db
    .select()
    .from(canaries)
    .where(and(eq(canaries.providerId, providerId), inArray(canaries.modelId, modelIds), gte(canaries.ts, since)))
    .orderBy(desc(canaries.ts));
  for (const r of rows) {
    const list = map.get(r.modelId) ?? [];
    if (list.length < NEEDED) list.push(r);
    map.set(r.modelId, list);
  }
  return map;
}

export type CanaryEvidenceResult = { checked: number; written: { provider: string; model: string; evidence_root: string }[] };

/** One pass over the canaries table for every live or shadow provider. */
export async function runCanaryEvidence(ctx: Ctx, now = Date.now()): Promise<CanaryEvidenceResult> {
  const since = new Date(now - DAY_MS);
  const live = await ctx.db.select({ id: providers.id }).from(providers).where(inArray(providers.status, ["live", "shadow"]));
  const out: CanaryEvidenceResult = { checked: 0, written: [] };
  for (const p of live) {
    const modelIds = (await ctx.db.select({ m: offers.modelId }).from(offers).where(eq(offers.providerId, p.id))).map((r) => r.m);
    const recent = await recentCanaries(ctx, p.id, modelIds, since);
    for (const [modelId, list] of recent) {
      out.checked++;
      if (list.length !== NEEDED || !list.every((c) => c.quantMatch === false)) continue;
      // Hashes, ids, codes and numbers only: the canary prompts are fixed public strings and are not copied here.
      const items = list.map((c) => ({ model: modelId, provider: p.id, ts: c.ts.toISOString(), guess: c.quantGuess, distance: c.distance, declared: (c.detail as { declared?: string } | null)?.declared ?? null }));
      const root = evidenceRootOf(items);
      const windowFrom = list[NEEDED - 1].ts;
      const windowTo = list[0].ts;
      const inserted = await ctx.db
        .insert(slashEvidence)
        .values({ id: uid("slev_"), providerId: p.id, modelId, reason: QUANT_SWAP_REASON, bps: QUANT_SWAP_BPS, delist: true, evidenceRoot: root, evidence: { items, window: { from: windowFrom.toISOString(), to: windowTo.toISOString() } }, windowFrom, windowTo })
        .onConflictDoNothing()
        .returning({ id: slashEvidence.id });
      if (inserted.length) out.written.push({ provider: p.id, model: modelId, evidence_root: root });
    }
  }
  return out;
}

/** Registers the job on a worker: a cheap read of the canaries table every ten minutes. Call before ctx.jobs.start(). */
export function registerCanaryEvidenceJob(ctx: Ctx, everyMs = 600_000) {
  ctx.jobs.register("canary-evidence", everyMs, () => runCanaryEvidence(ctx));
}
