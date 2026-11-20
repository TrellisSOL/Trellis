import type { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { generations, keys } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, type Pico } from "../lib/money.ts";
import { COUNT, DAY_MS, DAY_SQL, SUM_COST, dailySpend, dayKey, scopeWhere, utcDay, type SpendScope } from "../services/spend-watch.ts";
import { NOT_ENABLED } from "../surface/surface.ts";
import { requireKey } from "./auth.ts";

// Usage breakdown (update 19, the `usage` release switch): what a key spent, by model and by day, in one answer. The
// dashboard draws it as a stacked daily chart; GET /api/v1/usage returns the same numbers.
//
// The figures are the cost charged per call (generations.cost), counted the way Spend Watch counts them: calls paid
// per call by a wallet with no key are not key spend. Billing metadata only; never content.
//
// Visibility: a key sees its own calls. A management key sees every key of its account, or one of them with key_hash.
// While the switch is off the route answers 404 not_enabled, in every environment.

export const usageEnabled = (ctx: Ctx) => ctx.cfg.updates.usage === true;

export const USAGE_MAX_DAYS = 90;
export const USAGE_MAX_TOP = 12;

const query = z
  .object({
    days: z.coerce.number().int().min(1).max(USAGE_MAX_DAYS).default(30),
    top: z.coerce.number().int().min(1).max(USAGE_MAX_TOP).default(6),
    key_hash: z.string().regex(/^[0-9a-f]{64}$/, "key_hash must be a key hash from /api/v1/keys").optional(),
  })
  .strict();

type Cell = { cost: Pico; requests: number };
const ZERO: Cell = { cost: 0n, requests: 0 };

/** Spend by model and by day over the last `days` UTC days (today included), the `top` models by cost named. */
export async function usageBreakdown(db: Db, scope: SpendScope, opts: { days: number; top: number; now: number }) {
  const { days, top, now } = opts;
  const end = utcDay(now) + DAY_MS;
  const from = end - days * DAY_MS;
  const dates = Array.from({ length: days }, (_, i) => dayKey(from + i * DAY_MS));
  const where = scopeWhere(db, scope, from, end);

  const daily = await dailySpend(db, scope, from, end);
  const ranked = await db
    .select({ model: generations.modelId, cost: SUM_COST, n: COUNT })
    .from(generations)
    .where(where)
    .groupBy(generations.modelId)
    .orderBy(desc(SUM_COST), generations.modelId)
    .limit(top);
  const [{ models: modelCount }] = await db.select({ models: sql<number>`count(distinct ${generations.modelId})::int` }).from(generations).where(where);
  const named = ranked.map((r) => r.model);
  const cells = new Map<string, Map<string, Cell>>(named.map((m) => [m, new Map()]));
  if (named.length) {
    const rows = await db
      .select({ model: generations.modelId, day: DAY_SQL, cost: SUM_COST, n: COUNT })
      .from(generations)
      .where(and(where, inArray(generations.modelId, named)))
      .groupBy(generations.modelId, DAY_SQL);
    for (const r of rows) cells.get(r.model)?.set(r.day, { cost: BigInt(r.cost), requests: Number(r.n) });
  }

  let total = 0n;
  let requests = 0;
  for (const d of dates) {
    const v = daily.get(d) ?? ZERO;
    total += v.cost;
    requests += v.requests;
  }
  const share = (cost: Pico) => (total > 0n ? Number((cost * 10_000n) / total) / 10_000 : 0);

  const models = ranked.map((r) => {
    const byDay = cells.get(r.model)!;
    return { id: r.model, cost_usd: picoToUsd(BigInt(r.cost)), requests: Number(r.n), share: share(BigInt(r.cost)), daily: dates.map((d) => picoToUsd((byDay.get(d) ?? ZERO).cost)) };
  });

  // Everything outside the named models, per day: the day's total less what the named models spent on it.
  const otherDaily = dates.map((d) => {
    const named = [...cells.values()].reduce((s, m) => ({ cost: s.cost + (m.get(d) ?? ZERO).cost, requests: s.requests + (m.get(d) ?? ZERO).requests }), ZERO);
    const all = daily.get(d) ?? ZERO;
    return { cost: all.cost - named.cost, requests: all.requests - named.requests };
  });
  const otherCost = otherDaily.reduce((s, v) => s + v.cost, 0n);
  const otherRequests = otherDaily.reduce((s, v) => s + v.requests, 0);
  const otherModels = Math.max(0, Number(modelCount) - named.length);

  return {
    scope: scope.keyHash ? ("key" as const) : ("account" as const),
    key_hash: scope.keyHash,
    range: { from: dates[0]!, to: dates[dates.length - 1]!, days },
    totals: { cost_usd: picoToUsd(total), requests, models: Number(modelCount) },
    daily: dates.map((d) => ({ date: d, cost_usd: picoToUsd((daily.get(d) ?? ZERO).cost), requests: (daily.get(d) ?? ZERO).requests })),
    models,
    other: otherModels > 0 ? { models: otherModels, cost_usd: picoToUsd(otherCost), requests: otherRequests, share: share(otherCost), daily: otherDaily.map((v) => picoToUsd(v.cost)) } : null,
  };
}

export function usageRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/usage", async (c) => {
    if (!usageEnabled(ctx)) fail(404, "The usage breakdown is not enabled on this router.", NOT_ENABLED);
    const k = await requireKey(ctx, c.req.header("authorization"));
    const q = query.parse(c.req.query());
    let keyHash: string | null = k.management ? null : k.keyHash;
    if (q.key_hash && q.key_hash !== k.keyHash) {
      if (!k.management) fail(403, "Only a management key can read another key's usage. Leave key_hash out to read this key's.", "forbidden");
      const [target] = await ctx.db.select({ keyHash: keys.keyHash }).from(keys).where(and(eq(keys.accountId, k.accountId), eq(keys.keyHash, q.key_hash)));
      if (!target) fail(404, "Key not found in this account.", "not_found");
    }
    if (q.key_hash) keyHash = q.key_hash;
    const data = await usageBreakdown(ctx.db, { accountId: k.accountId, keyHash }, { days: q.days, top: q.top, now: Date.now() });
    c.header("cache-control", "no-store");
    return c.json({ data });
  });
}
