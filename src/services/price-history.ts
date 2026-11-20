// Price history (update 22, `price-history` in src/features.json).
//
// Each catalogue refresh (the `catalog-refresh` job) records, per listed model, its lowest live input and output price
// across the providers that serve it: the "from" prices of the model page. A row is written only when one of the two
// differs from the model's latest row, so the table holds the changes the router saw, and nothing in between is made
// up. GET /api/v1/models/:author/:slug/prices reads it back (src/api/models.ts).
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { priceSnapshots } from "../db/schema.ts";
import { picoToUsd } from "../lib/money.ts";
import { log } from "../lib/util.ts";

export const priceHistoryEnabled = (ctx: Pick<Ctx, "cfg">) => ctx.cfg.updates["price-history"] === true;

/** The window a caller can ask for, in days, and the most points one answer carries. */
export const PRICE_DAYS = { min: 1, max: 365, default: 90 } as const;
export const MAX_POINTS = 1000;

type Lowest = { prompt: bigint; completion: bigint; providers: number };

/** A model's lowest live input and output price, or null when no live provider serves it. Prices are pico-USD per token. */
export function lowestPrices(ctx: Pick<Ctx, "catalog">, modelId: string): Lowest | null {
  const live = (ctx.catalog.offersByModel.get(modelId) ?? []).filter((o) => o.status === "live" && o.provider.status === "live");
  if (!live.length) return null;
  let prompt = live[0]!.pricePrompt, completion = live[0]!.priceCompletion;
  for (const o of live) {
    if (o.pricePrompt < prompt) prompt = o.pricePrompt;
    if (o.priceCompletion < completion) completion = o.priceCompletion;
  }
  return { prompt, completion, providers: new Set(live.map((o) => o.providerId)).size };
}

/** One pass: a row for every listed model whose lowest price is not the one last recorded. Returns how many were written. */
export async function recordPriceSnapshots(ctx: Pick<Ctx, "catalog" | "db">, at = new Date()): Promise<number> {
  const result = await ctx.db.execute(sql`
    SELECT DISTINCT ON (model_id) model_id, price_prompt, price_completion
    FROM price_snapshots ORDER BY model_id, at DESC, id DESC`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as { model_id: string; price_prompt: string | number; price_completion: string | number }[];
  const last = new Map(rows.map((r) => [r.model_id, `${BigInt(r.price_prompt)}:${BigInt(r.price_completion)}`]));
  const changed: (typeof priceSnapshots.$inferInsert)[] = [];
  for (const m of ctx.catalog.models.values()) {
    if (m.hidden) continue;
    const low = lowestPrices(ctx, m.id);
    if (!low || last.get(m.id) === `${low.prompt}:${low.completion}`) continue;
    changed.push({ modelId: m.id, pricePrompt: low.prompt, priceCompletion: low.completion, providers: low.providers, at });
  }
  for (let i = 0; i < changed.length; i += 500) await ctx.db.insert(priceSnapshots).values(changed.slice(i, i + 500));
  return changed.length;
}

/** The catalogue refresh, then (with the update on) the snapshot. A failed snapshot is logged and never fails the refresh. */
export async function refreshCatalogAndPrices(ctx: Pick<Ctx, "catalog" | "db" | "cfg">): Promise<void> {
  await ctx.catalog.refresh();
  if (!priceHistoryEnabled(ctx)) return;
  try { await recordPriceSnapshots(ctx); } catch (e) { log.warn("price history: the snapshot after a catalogue refresh failed", { error: (e as Error).message }); }
}

/** USD per million tokens, from pico-USD per token. */
export const usdPerMillion = (picoPerToken: bigint) => picoToUsd(picoPerToken * 1_000_000n);

const point = (r: typeof priceSnapshots.$inferSelect) => ({
  at: r.at.toISOString(),
  input_usd_per_m: usdPerMillion(r.pricePrompt),
  output_usd_per_m: usdPerMillion(r.priceCompletion),
  providers: r.providers,
});
export type PricePoint = ReturnType<typeof point>;

/**
 * What the router recorded for one model over the last `days`: the price in force when the window opened (`before`,
 * null when nothing was recorded before it) and every change inside it, oldest first, at most MAX_POINTS (the latest).
 */
export async function priceHistory(ctx: Pick<Ctx, "db">, modelId: string, days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [before] = await ctx.db.select().from(priceSnapshots).where(and(eq(priceSnapshots.modelId, modelId), lt(priceSnapshots.at, since))).orderBy(desc(priceSnapshots.at), desc(priceSnapshots.id)).limit(1);
  const recent = await ctx.db.select().from(priceSnapshots).where(and(eq(priceSnapshots.modelId, modelId), gte(priceSnapshots.at, since))).orderBy(desc(priceSnapshots.at), desc(priceSnapshots.id)).limit(MAX_POINTS + 1);
  const truncated = recent.length > MAX_POINTS;
  const points = recent.slice(0, MAX_POINTS).reverse().map(point);
  return { since: since.toISOString(), before: before ? point(before) : null, points, truncated };
}
