// Chat export with receipts (update 21, `chat-receipts` in src/features.json).
//
// POST /api/v1/receipts/batch { ids: [...] }: the signed receipts of up to 50 answers in one call, with the receipt
// keys they are checked against, so the Chat page can put each answer's receipt into an exported conversation and the
// file can be checked later without the router. A receipt carries only hashes and amounts and is public by id
// (GET /api/v1/receipts/:id); this is the same answer for several ids at once, without the anchor proofs, which are
// built per hour and stay on the single read. No key: the anonymous rate limit of the edge applies.
import type { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { NOT_ENABLED } from "../surface/surface.ts";
import { readJson } from "./common.ts";

export const chatReceiptsEnabled = (ctx: Pick<Ctx, "cfg">) => ctx.cfg.updates["chat-receipts"] === true;
export const MAX_BATCH_IDS = 50;
/** The receipt ids the site accepts (web/lib/privacy.js): a plain token of at most 128 characters. */
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const Body = z.object({ ids: z.array(z.string().regex(RECEIPT_ID, "not a receipt id")).min(1).max(MAX_BATCH_IDS) }).strict();

export function receiptBatchRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/receipts/batch", async (c) => {
    if (!chatReceiptsEnabled(ctx)) fail(404, "Exporting receipts in a batch is not enabled on this router.", NOT_ENABLED);
    const ids = [...new Set(Body.parse(await readJson(c)).ids)];
    const rows = await ctx.db
      .select({ id: generations.id, receipt: generations.receipt, sig: generations.receiptSig, keyId: generations.receiptKeyId, cose: generations.receiptCose, claims: generations.receiptV2 })
      .from(generations)
      .where(inArray(generations.id, ids));
    const found = new Map(rows.filter((g) => g.receipt && g.sig).map((g) => [g.id, g]));
    const receipts = ids.flatMap((id) => {
      const g = found.get(id);
      if (!g) return [];
      const v2 = g.cose ? { alg: "EdDSA", kid: g.keyId, content_type: COSE_CONTENT_TYPE, cose: g.cose, claims: g.claims } : null;
      return [{ id: g.id, version: v2 ? 2 : 1, payload: g.receipt, sig: g.sig, key_id: g.keyId, v2 }];
    });
    c.header("Cache-Control", "no-store");
    return c.json({ data: { receipts, missing: ids.filter((id) => !found.has(id)), keys: await ctx.signer.jwks() } });
  });
}
