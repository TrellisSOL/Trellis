import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { log } from "../lib/util.ts";

// Job liveness (security review round 4, R4-01): the `job-watchdog` job reads the runner's own view (services/jobs.ts
// `liveness`) once a minute and publishes it, so an API replica can report what the worker sees: the readiness
// warnings `job_stuck` (a run is past its deadline and has not returned) and `job_overdue` (a job has not succeeded for
// three intervals). Metric: trellis_readiness_warning{warning="job_stuck"}; alert TrellisJobStuck.

export const JOB_LIVENESS_KEY = "job-liveness";
export const JOB_WATCH_INTERVAL_MS = 60_000;
type Liveness = { at: string; role: string; stuck: string[]; overdue: string[] };

export async function runJobWatchdog(ctx: Ctx) {
  const { stuck, overdue } = ctx.jobs.liveness();
  const value: Liveness = { at: new Date().toISOString(), role: ctx.cfg.runtimeRole, stuck, overdue };
  if (stuck.length) log.error("job watchdog: a run is past its deadline and has not returned", { jobs: stuck });
  if (overdue.length) log.error("job watchdog: a job has not succeeded for three intervals", { jobs: overdue });
  const key = `${JOB_LIVENESS_KEY}:${ctx.cfg.runtimeRole}:${ctx.cfg.workerJobs.slice().sort().join(",") || "all"}`.slice(0, 500);
  await ctx.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  return { stuck, overdue };
}

export async function jobWarnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const { like } = await import("drizzle-orm");
  const rows = await ctx.db.select().from(kv).where(like(kv.key, `${JOB_LIVENESS_KEY}:%`));
  const fresh = rows.map((r) => r.value as Liveness).filter((v) => v?.at && Date.now() - Date.parse(v.at) <= 5 * JOB_WATCH_INTERVAL_MS);
  // This process's own runner counts too (a combined role, or the API's in-process jobs).
  const own = ctx.jobs.liveness();
  const stuck = [...new Set([...fresh.flatMap((v) => v.stuck), ...own.stuck])];
  const overdue = [...new Set([...fresh.flatMap((v) => v.overdue), ...own.overdue])];
  const out: { code: string; reason: string; message: string }[] = [];
  if (stuck.length) out.push({ code: "job_stuck", reason: "run_past_deadline", message: `Job run(s) past their deadline that have not returned: ${stuck.join(", ")}. No second run is started beside one; the worker's heartbeat is withheld and its container restarts.` });
  if (overdue.length) out.push({ code: "job_overdue", reason: "no_success", message: `Job(s) that have not succeeded for three intervals: ${overdue.join(", ")}.` });
  return out;
}
void eq;
