import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { creditClosures } from "../solana/credits-schema.ts";

// Alarms on the closure refund queue (security review round 4, R4-04). A closure refund is the only way a depositor
// gets unspent USDC back, and the job that pays it stalled with nothing to say so. Two readiness warnings, each with
// an alert rule (monitoring/):
//   closure_overdue         a closure is unpaid CLOSURE_OVERDUE_MS after it became payable (whatever holds it: the
//                           refund limiter, a destination that cannot receive, a disabled key, a dispute, a job that
//                           is not running). The message says how many and names the reasons recorded on them.
//   closure_queue_growing   more than CLOSURE_QUEUE_ALARM closures are open, or more than CLOSURE_UNSIGNED_ALARM
//                           requests are waiting to be signed (someone is filling the queue).

export const CLOSURE_OVERDUE_MS = 24 * 3_600_000;
export const CLOSURE_QUEUE_ALARM = 200;
export const CLOSURE_UNSIGNED_ALARM = 100;

export async function closureWarnings(ctx: Ctx, now = new Date()): Promise<{ code: string; reason: string; message: string }[]> {
  if (!ctx.cfg.chain.credits) return [];
  const out: { code: string; reason: string; message: string }[] = [];
  const overdue = await ctx.db
    .select({ reason: creditClosures.reason, n: sql<number>`count(*)::int` })
    .from(creditClosures)
    .where(and(eq(creditClosures.status, "registered"), lt(creditClosures.payableAt, new Date(now.getTime() - CLOSURE_OVERDUE_MS))))
    .groupBy(creditClosures.reason);
  const total = overdue.reduce((a, r) => a + r.n, 0);
  if (total > 0)
    out.push({ code: "closure_overdue", reason: overdue.map((r) => r.reason ?? "not_processed").sort()[0]!, message: `${total} account closure(s) are unpaid more than 24 hours after they became payable (${overdue.map((r) => `${r.reason ?? "not processed"}: ${r.n}`).join(", ")}). A depositor is waiting for each.` });
  const open = await ctx.db.select({ status: creditClosures.status, n: sql<number>`count(*)::int` }).from(creditClosures).where(inArray(creditClosures.status, ["queued", "registered"])).groupBy(creditClosures.status);
  const queued = open.find((r) => r.status === "queued")?.n ?? 0;
  const all = open.reduce((a, r) => a + r.n, 0);
  if (all > CLOSURE_QUEUE_ALARM || queued > CLOSURE_UNSIGNED_ALARM)
    out.push({ code: "closure_queue_growing", reason: queued > CLOSURE_UNSIGNED_ALARM ? "unsigned_requests" : "open_closures", message: `${all} account closure(s) are open, ${queued} of them requests nobody has signed.` });
  return out;
}
