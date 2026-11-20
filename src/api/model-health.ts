import type { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { health } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { NOT_ENABLED } from "../surface/surface.ts";

// Model health (update 17, `model-health` in src/features.json): how each model has been doing over the last 24 hours,
// from the router's own records of the calls it sent (the `health` table: one row per provider attempt).
//
//   GET /api/v1/models/health[?model=<author/slug>]   public: per model, the share of attempts that succeeded and the
//                                                      median and p95 time to the first response of the ones that did
//
// What is counted: attempts on real traffic (source `traffic`; the router's own probes are left out). Attempts refused
// for the caller's own request (`rejected`), cut off by the caller (`cancelled`), rate-limited by the provider
// (`rate_limited`) and the extra row of an over-report (`over_report`, recorded next to the call's own row) are not
// counted, as in a provider's uptime (src/services/health.ts). No figure is published for fewer than MIN_ATTEMPTS.
// The route reads a 60-second cached answer; it carries no account, key, caller or provider detail.

export const HEALTH_WINDOW_MS = 24 * 3_600_000;
/** Below this many counted attempts (or timed successes) the rate (or the latency) is null: too few to say. */
export const MIN_ATTEMPTS = 5;
const CACHE_MS = 60_000;
const NOT_COUNTED = ["rejected", "cancelled", "rate_limited", "over_report"] as const;
/** A model id as the catalogue writes them: author/slug, with dots, colons, dashes and underscores. */
const MODEL_ID = /^[A-Za-z0-9._:-]{1,100}(?:\/[A-Za-z0-9._:-]{1,100}){0,2}$/;

export const modelHealthEnabled = (ctx: Ctx) => ctx.cfg.updates["model-health"] === true;

export type ModelHealth = {
  model: string;
  attempts: number;
  succeeded: number;
  failed: number;
  /** succeeded / attempts, 0..1 to four places; null under MIN_ATTEMPTS. */
  success_rate: number | null;
  /** Milliseconds to the first response of the attempts that succeeded; null under MIN_ATTEMPTS timed successes. */
  latency_ms: { p50: number; p95: number } | null;
};

const num = (v: unknown) => (v == null ? null : Number(v));

/** The figures for every model with counted attempts in the window ending at `now`, sorted by model id. */
export async function modelHealth(ctx: Pick<Ctx, "db">, now = Date.now()): Promise<ModelHealth[]> {
  const rows = await ctx.db
    .select({
      model: health.modelId,
      succeeded: sql<number>`count(*) FILTER (WHERE ${health.ok})`,
      failed: sql<number>`count(*) FILTER (WHERE NOT ${health.ok})`,
      timed: sql<number>`count(${health.latencyMs}) FILTER (WHERE ${health.ok})`,
      p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${health.latencyMs}) FILTER (WHERE ${health.ok} AND ${health.latencyMs} IS NOT NULL)`,
      p95: sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${health.latencyMs}) FILTER (WHERE ${health.ok} AND ${health.latencyMs} IS NOT NULL)`,
    })
    .from(health)
    .where(and(
      gte(health.ts, new Date(now - HEALTH_WINDOW_MS)),
      eq(health.source, "traffic"),
      sql`(${health.ok} OR ${health.errorKind} IS NULL OR ${health.errorKind} NOT IN (${sql.join(NOT_COUNTED.map((k) => sql`${k}`), sql`, `)}))`,
    ))
    .groupBy(health.modelId);
  return rows
    .map((r) => {
      const succeeded = Number(r.succeeded), failed = Number(r.failed), attempts = succeeded + failed, timed = Number(r.timed);
      const p50 = num(r.p50), p95 = num(r.p95);
      return {
        model: r.model,
        attempts,
        succeeded,
        failed,
        success_rate: attempts >= MIN_ATTEMPTS ? Math.round((succeeded / attempts) * 10_000) / 10_000 : null,
        latency_ms: timed >= MIN_ATTEMPTS && p50 != null && p95 != null ? { p50: Math.round(p50), p95: Math.round(p95) } : null,
      };
    })
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

const cache = new WeakMap<object, { at: number; data: ModelHealth[] }>();

export function modelHealthRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/models/health", async (c) => {
    if (!modelHealthEnabled(ctx)) fail(404, "Model health is not enabled on this router.", NOT_ENABLED);
    const model = c.req.query("model");
    if (model !== undefined && !MODEL_ID.test(model)) fail(400, "`model` must be a model id such as author/slug.", "invalid_request");
    const now = Date.now();
    let hit = cache.get(ctx);
    if (!hit || now - hit.at > CACHE_MS) { hit = { at: now, data: await modelHealth(ctx, now) }; cache.set(ctx, hit); }
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      object: "list",
      window: "24h",
      since: new Date(hit.at - HEALTH_WINDOW_MS).toISOString(),
      generated_at: new Date(hit.at).toISOString(),
      measure: "attempts the router sent to a provider on real traffic; latency is the time to the first response (first token for streams), measured at the router",
      min_attempts: MIN_ATTEMPTS,
      data: model === undefined ? hit.data : hit.data.filter((m) => m.model === model),
    });
  });
}
