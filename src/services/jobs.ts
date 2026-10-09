import { redactRpcError, redactRpcText } from "../solana/rpc-redaction.ts";
import { createHash } from "node:crypto";
import { log } from "../lib/util.ts";

// Recurring background jobs. In-process (single router) by default; with REDIS_URL each job is
// a BullMQ repeatable job so exactly one replica runs it per tick.

// Watchdog (security review round 4, R4-01). A job run that never returned used to stop that job for good: `running`
// stayed true and every later tick was skipped (a stalled attestation endpoint stopped the attestor, and the attested
// lane with it, until the worker was restarted). Every run now has a deadline:
//   - per-run timeout: `timeoutMs` (default jobTimeout(everyMs)). At the deadline the run's AbortSignal fires, the run is
//     recorded as failed ("timed out"), and whoever awaited it gets the error.
//   - overlap guard: a run that ignores the signal is still in flight, so the job is marked `stuck` and no second run is
//     started beside it (two settlement runs at once would be worse than none). It clears when the run finally returns.
//   - liveness: `status()` carries `stuck`, `timeouts` and `running_since`; `liveness()` lists stuck and overdue jobs.
//     The `job-watchdog` job (services/job-watch.ts) publishes that as the readiness warning `job_stuck` / `job_overdue`,
//     and the worker heartbeat (worker-heartbeat.ts) is withheld while a run exceeds its bound, so the container is
//     restarted.
export type JobFn = (signal?: AbortSignal) => Promise<unknown>;
export type JobSnapshot = { name: string; every_ms: number; running: boolean; runs: number; last_run: string | null; last_duration_ms: number | null; last_error: string | null; last_success: string | null; stuck?: boolean; timeouts?: number; timeout_ms?: number; running_since?: string | null };
type JobState = { name: string; everyMs: number; fn: JobFn; running: boolean; atStart: boolean; lastRun?: number; lastSuccess?: number; lastError?: string; lastDurationMs?: number; runs: number; timeoutMs: number; stuck: boolean; timeouts: number; startedAt?: number };

/** A run's default deadline: three intervals, at least two minutes and at most fifteen. */
export const jobTimeout = (everyMs: number) => Math.min(15 * 60_000, Math.max(120_000, everyMs * 3));

export class Jobs {
  private jobs = new Map<string, JobState>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private bull: { queue: import("bullmq").Queue; worker: import("bullmq").Worker } | null = null;
  private started = false;
  private startedAt: number | undefined;

  /**
   * `surfaceAllows`: the launch surface's job allow-list (src/surface/surface.ts). In LAUNCH_SURFACE=core a job whose name
   * is not on it is never stored here, so it cannot be scheduled or run by name, whatever registered it.
   */
  constructor(private redisUrl?: string, private report?: (state: JobSnapshot) => Promise<void>, private allowedJobs?: string[], private surfaceAllows?: (name: string) => boolean) {}

  /** atStart: also run once shortly after start (for jobs whose interval is long, e.g. attestation). */
  register(name: string, everyMs: number, fn: JobFn, opts: { atStart?: boolean; timeoutMs?: number } = {}) {
    if (this.surfaceAllows && !this.surfaceAllows(name)) return;
    if (this.allowedJobs && !this.allowedJobs.includes(name)) return;
    this.jobs.set(name, { name, everyMs, fn, running: false, atStart: !!opts.atStart, runs: 0, timeoutMs: opts.timeoutMs ?? jobTimeout(everyMs), stuck: false, timeouts: 0 });
  }

  async run(name: string) {
    const j = this.jobs.get(name);
    if (!j) throw new Error(`unknown job ${name}`);
    // Overlap guard: one run of a job at a time, including a run that timed out and has not returned yet.
    if (j.running) return { skipped: true, ...(j.stuck ? { stuck: true } : {}) };
    j.running = true;
    const t = Date.now();
    j.startedAt = t;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let inFlight: Promise<unknown>;
    try {
      inFlight = Promise.resolve().then(() => j.fn(ctl.signal));
    } catch (e) {
      inFlight = Promise.reject(e);
    }
    // The run itself, whenever it ends: this is what frees the job for its next run.
    void inFlight.then(() => undefined, () => undefined).then(() => {
      j.running = false;
      j.startedAt = undefined;
      if (j.stuck) {
        j.stuck = false;
        log.warn("job run returned after its deadline", { job: name, ms: Date.now() - t });
        void this.report?.(this.status().find((state) => state.name === name)!).catch(() => undefined);
      }
    });
    try {
      const result = await Promise.race([
        inFlight,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const err = new Error(`job ${name} timed out after ${j.timeoutMs} ms`);
            j.stuck = true;
            j.timeouts++;
            ctl.abort(err); // a run that honours its signal ends here, and clears `stuck` as it returns
            reject(err);
          }, j.timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      j.lastError = undefined;
      j.lastSuccess = Date.now();
      return result;
    } catch (e) {
      j.lastError = redactRpcText(e instanceof Error ? e.message : String(e));
      log.error(timedOut ? "job timed out" : "job failed", { job: name, error: j.lastError });
      throw redactRpcError(e);
    } finally {
      clearTimeout(timer);
      j.lastRun = t;
      j.lastDurationMs = Date.now() - t;
      j.runs++;
      if (this.report) await this.report(this.status().find((state) => state.name === name)!).catch(() => undefined);
    }
  }

  /** Jobs whose run is past its deadline and still in flight, and jobs that have not succeeded for three intervals. */
  liveness(now = Date.now()) {
    const stuck: string[] = [];
    const overdue: string[] = [];
    for (const j of this.jobs.values()) {
      if (j.stuck) stuck.push(j.name);
      const reference = j.lastSuccess ?? this.startedAt ?? now;
      if (this.startedAt !== undefined && now - reference > Math.max(j.everyMs * 3, 5 * 60_000) + j.timeoutMs) overdue.push(j.name);
    }
    return { stuck, overdue };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    for (const j of this.jobs.values())
      if (j.atStart && !this.redisUrl) {
        const t = setTimeout(() => void this.run(j.name).catch(() => undefined), 1_000);
        t.unref?.();
        this.timers.push(t as unknown as ReturnType<typeof setInterval>);
      }
    if (this.redisUrl) {
      const { Queue, Worker } = await import("bullmq");
      const connection = { url: this.redisUrl } as never;
      const group = this.allowedJobs ? createHash("sha256").update([...this.allowedJobs].sort().join(",")).digest("hex").slice(0, 16) : "all";
      const queueName = `trellis-jobs-${group}`;
      const queue = new Queue(queueName, { connection });
      await queue.setGlobalConcurrency(1);
      for (const j of this.jobs.values())
        await queue.upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name, opts: { removeOnComplete: 100, removeOnFail: 100 } });
      const worker = new Worker(queueName, async (job) => this.run(job.name), { connection, concurrency: 4 });
      this.bull = { queue, worker };
      worker.on("error", (error) => log.error("job worker error", { error: error.message }));
      for (const j of this.jobs.values()) if (j.atStart) await queue.add(j.name, {}, { jobId: `startup-${j.name}-${Math.floor(Date.now() / 10000)}`, removeOnComplete: 100, removeOnFail: 100 });
      log.info("jobs started (bullmq)", { jobs: [...this.jobs.keys()] });
      return;
    }
    for (const j of this.jobs.values()) {
      const t = setInterval(() => void this.run(j.name).catch(() => undefined), j.everyMs);
      t.unref?.();
      this.timers.push(t);
    }
    log.info("jobs started (in-process)", { jobs: [...this.jobs.keys()] });
  }

  status(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      every_ms: j.everyMs,
      running: j.running,
      runs: j.runs,
      last_run: j.lastRun ? new Date(j.lastRun).toISOString() : null,
      last_duration_ms: j.lastDurationMs ?? null,
      last_error: j.lastError ?? null,
      last_success: j.lastSuccess ? new Date(j.lastSuccess).toISOString() : null,
      stuck: j.stuck,
      timeouts: j.timeouts,
      timeout_ms: j.timeoutMs,
      running_since: j.running && j.startedAt ? new Date(j.startedAt).toISOString() : null,
    }));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.bull) {
      await this.bull.worker.close();
      await this.bull.queue.close();
    }
    const deadline = Date.now() + 10_000;
    while ([...this.jobs.values()].some((j) => j.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}
