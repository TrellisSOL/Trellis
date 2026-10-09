import type { Ctx } from "../context.ts";
import { billingWarnings } from "./billing-watch.ts";

// The readiness warnings added by the round-4 fix pass, gathered for services/readiness.ts.
export async function round4Warnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const parts = await Promise.all([
    billingWarnings(ctx).catch(() => []),
    import("./closure-watch.ts").then((m) => m.closureWarnings(ctx)).catch(() => []),
    import("./job-watch.ts").then((m) => m.jobWarnings(ctx)).catch(() => []),
    import("./settlement.ts").then((m) => m.restoreWarnings(ctx)).catch(() => []), // R5-08: a database behind the chain
  ]);
  // R4-06: this process's event loop was held (hardening/budget.ts); the log line names the routes that were in flight.
  const blocked = (await import("../hardening/budget.ts")).eventLoopBlocked();
  const loop = blocked ? [{ code: "event_loop_blocked", reason: "stall", message: `The event loop was blocked for ${blocked.ms} ms at ${new Date(blocked.at).toISOString()} with ${blocked.routes.length} route(s) in flight.` }] : [];
  return [...parts.flat(), ...loop];
}
