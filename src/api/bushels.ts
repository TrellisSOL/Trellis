// Bushels (docs/Trellis_Backend.md §5.6): prepaid capacity for inference, bound to the buying key.
//   GET  /api/v1/bushels/commitments   public: the commitments prepaid capacity can be bought against, and the cap
//   POST /api/v1/bushels/buy           key: {commitment, tokens} -> a lot, paid from the key's prepaid balance
//   POST /api/v1/bushels/redeem        key: {lot} -> an allowance for inference on models of the lot's grade
//   GET  /api/v1/bushels/lots          key: this key's lots and allowances
//   GET  /api/v1/admin/bushels         operator: totals per status and the shortfalls examined
//   POST /api/v1/admin/bushels/shortfalls/run   operator: run the after-window check now
// There is no route that moves a lot to another key, pays one out or quotes a resale price: a lot ends by being used,
// by lapsing with its window, by being honoured on another host of the same grade, or by its purchase price coming
// back from the host's bond for the part that was not served.
import type { Hono } from "hono";
import { z } from "zod";
import { bushelStatus, listLots, listOpenCommitments, redeemLot, requestPurchase, runBushelShortfalls } from "../capacity/bushels.ts";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";

const buyBody = z.strictObject({
  commitment: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a commitment account address"),
  tokens: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)]).transform((v) => BigInt(v)),
});
const redeemBody = z.strictObject({ lot: z.string().regex(/^lot_[0-9a-f]{24}$/, "must be a lot id") });

export function bushelRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/bushels/commitments", async (c) => c.json(await listOpenCommitments(ctx), 200, { "cache-control": "public, max-age=15" }));

  app.post("/api/v1/bushels/buy", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const input = buyBody.parse(await readJson(c));
    const limit = await ctx.limiter.take(`bushel-buy:${key.keyHash}`, 1, 10, 60_000);
    if (!limit.ok) fail(429, "Too many prepaid capacity purchases from this key. Try again within a minute.", "rate_limited");
    return c.json({ data: await requestPurchase(ctx, key, input) }, 201);
  });

  app.post("/api/v1/bushels/redeem", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const input = redeemBody.parse(await readJson(c));
    return c.json({ data: await redeemLot(ctx, key, input.lot) });
  });

  app.get("/api/v1/bushels/lots", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    return c.json({ data: await listLots(ctx, key.keyHash) });
  });

  app.get("/api/v1/admin/bushels", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await bushelStatus(ctx) });
  });
  app.post("/api/v1/admin/bushels/shortfalls/run", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await runBushelShortfalls(ctx) });
  });
}
