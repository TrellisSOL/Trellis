// HVX index (docs/Trellis_Backend.md §5.6): GET /api/v1/hvx answers the latest point per grade and the 24-hour series.
//
// Mount (src/app.ts, owned elsewhere), one line next to the other read-only routes:
//   app.route("/api/v1/hvx", hvxRoutes(ctx));
//
// Public, unauthenticated and read-only: HVX is a public statistic and nothing settles against it. No body is read.
import { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { hvxView } from "../services/hvx.ts";
import { loadHvxConfig, type HvxConfig } from "../services/hvx-config.ts";

export function hvxRoutes(ctx: Ctx, cfg: HvxConfig = loadHvxConfig()) {
  const r = new Hono();
  r.get("/", async (c) => {
    const view = await hvxView(ctx, cfg);
    return c.json(view, 200, { "cache-control": "public, max-age=60" });
  });
  return r;
}
