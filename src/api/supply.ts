// Supply (docs/Trellis_Backend.md §2): the warm pool on rented GPU networks, and catalogue auto-listing with the licence rule.
//   GET  /api/v1/catalog/licences                       public: the licence table and the rule
//   GET  /api/v1/admin/supply                           operator: the pool's models, deployments and hourly cost
//   GET  /api/v1/admin/supply/capacity                  operator: what each switched-on adapter could rent now
//   POST /api/v1/admin/supply/quote                     operator: {model, replicas, hours} -> a price per adapter
//   POST /api/v1/admin/supply/run                       operator: run the warm pool now
//   GET  /api/v1/admin/catalog/candidates[?status=]     operator: auto-listing candidates
//   POST /api/v1/admin/catalog/candidates               operator: submit a candidate (licence rule applied at once)
//   POST /api/v1/admin/catalog/candidates/:id/approve   operator: the licence check of a needs_review candidate
//   POST /api/v1/admin/catalog/candidates/:id/evaluate  operator: run evaluation, canaries and listing now
// No route here returns an adapter credential, an endpoint key or an endpoint address.
import type { Hono } from "hono";
import { z } from "zod";
import { approveCandidate, candidateInput, listCandidates, processCandidate, submitCandidate } from "../catalog/auto-list.ts";
import { licenceTable } from "../catalog/licences.ts";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { runWarmPool, supplyAdapters, supplyStatus } from "../supply/warm-pool.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";

const quoteBody = z.strictObject({ model: z.string().min(3).max(200), replicas: z.number().int().min(1).max(64).default(1), hours: z.number().int().min(1).max(720).default(1) });
const approveBody = z.strictObject({ by: z.string().trim().min(1).max(64).optional() });
const STATUSES = ["submitted", "needs_review", "approved", "listed", "blocked"] as const;

export function supplyRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/catalog/licences", (c) => c.json({ data: licenceTable() }, 200, { "cache-control": "public, max-age=3600" }));

  app.get("/api/v1/admin/supply", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await supplyStatus(ctx) });
  });
  app.get("/api/v1/admin/supply/capacity", async (c) => {
    requireOperator(ctx, c);
    const data = [];
    for (const a of supplyAdapters(ctx)) {
      try { data.push({ adapter: a.name, offers: await a.listCapacity() }); } catch { data.push({ adapter: a.name, offers: [], unavailable: true }); }
    }
    return c.json({ data });
  });
  app.post("/api/v1/admin/supply/quote", async (c) => {
    requireOperator(ctx, c);
    const input = quoteBody.parse(await readJson(c));
    const spec = ctx.cfg.supply.models.find((m) => m.modelId === input.model);
    if (!spec) fail(404, "That model is not in SUPPLY_MODELS.", "not_found");
    const data = [];
    for (const a of supplyAdapters(ctx).filter((x) => spec.adapters.includes(x.name))) {
      try { data.push(await a.quote(spec, input.replicas, input.hours)); } catch { data.push({ adapter: a.name, unavailable: true }); }
    }
    return c.json({ data });
  });
  app.post("/api/v1/admin/supply/run", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await runWarmPool(ctx) });
  });

  app.get("/api/v1/admin/catalog/candidates", async (c) => {
    requireOperator(ctx, c);
    const status = z.enum(STATUSES).optional().parse(c.req.query("status"));
    return c.json({ data: await listCandidates(ctx, status) });
  });
  app.post("/api/v1/admin/catalog/candidates", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await submitCandidate(ctx, candidateInput.parse(await readJson(c))) }, 201);
  });
  app.post("/api/v1/admin/catalog/candidates/:id/approve", async (c) => {
    requireOperator(ctx, c);
    const input = approveBody.parse(await readJson(c));
    return c.json({ data: await approveCandidate(ctx, c.req.param("id"), input.by) });
  });
  app.post("/api/v1/admin/catalog/candidates/:id/evaluate", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await processCandidate(ctx, c.req.param("id")) });
  });
}
