// Honest Ledger (docs/Trellis_Backend.md §9): GET /api/v1/ledger/honest answers daily x402 volume through Trellis after
// the wash filter, with the filter and its parameters, the gross figures and what each rule removed.
//
// Public, unauthenticated and read-only. No body is read; the only input is ?days= (1 to 366, 30 unless given).
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { honestLedgerView } from "../stats/honest-ledger.ts";

export function ledgerRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/ledger/honest", async (c) => {
    const days = z.coerce.number().int().min(1).max(366).default(30).parse(c.req.query("days") ?? undefined);
    return c.json(await honestLedgerView(ctx, days), 200, { "cache-control": "public, max-age=300" });
  });
}
