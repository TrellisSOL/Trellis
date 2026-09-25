import type { HolderTier } from "../config.ts";
import type { Ctx } from "../context.ts";

// Priority admission for the SEALED (attested) lane. Off by default: with SEALED_MAX_CONCURRENCY_PER_HOST=0 every call
// is admitted at once and nothing here keeps any state, which is how the lane ran before this existed.
//
// With a limit set, a host serves at most that many sealed-lane calls at a time (counted in this process: each router
// replica keeps its own count). A call that finds its host full waits in that host's queue:
//   - ordered by the caller's tier `sealed_priority`, higher first; first come, first served within a priority;
//   - callers with no tier (priority 0) are never starved: while both kinds wait, at least SEALED_NONHOLDER_MIN_SHARE
//     of admissions go to the oldest waiting caller with no tier (0.2 = every fifth);
//   - for at most SEALED_QUEUE_MAX_WAIT_MS, after which the call is not admitted to that host and routing goes on as
//     it does for a host that answers 429: the next attested host, then "providers unavailable". Nothing is charged
//     for a call that is not served.
// Priority is a place in a queue, never a price: every caller pays the host's own price whatever their tier.

export type SealedQueueSettings = { maxConcurrencyPerHost: number; queueMaxWaitMs: number; nonHolderMinShare: number };
export type Admission = { ok: true; release: () => void; waitedMs: number } | { ok: false; reason: "timeout" | "queue_full" | "aborted"; waitedMs: number };

type Waiter = { priority: number; seq: number; at: number; settle: (a: Admission) => void; timer: ReturnType<typeof setTimeout> | null; onAbort: (() => void) | null; signal?: AbortSignal };
type Host = { inFlight: number; waiting: Waiter[]; credit: number };

/** Waiting calls one host's queue holds at most; a call that finds it full is not admitted (as after a timeout). */
export const SEALED_QUEUE_MAX_LENGTH = 1000;
/** A slot nobody released (a stream nobody read to its end) frees itself after this long. */
export const SEALED_SLOT_MAX_HOLD_MS = 15 * 60_000;

export class SealedQueue {
  private hosts = new Map<string, Host>();
  private seq = 0;
  constructor(private settings: SealedQueueSettings, private now: () => number = Date.now, private maxHoldMs = SEALED_SLOT_MAX_HOLD_MS) {}

  get enabled() {
    return this.settings.maxConcurrencyPerHost > 0;
  }

  /** Calls in flight and waiting for `host`, for tests and the status page. */
  snapshot(host: string) {
    const h = this.hosts.get(host);
    return { in_flight: h?.inFlight ?? 0, waiting: h?.waiting.length ?? 0 };
  }

  /** A slot on `host` for a caller of `priority` (0 = no tier). Resolves when admitted, or not admitted; never rejects. */
  acquire(host: string, priority: number, signal?: AbortSignal): Promise<Admission> {
    if (!this.enabled) return Promise.resolve({ ok: true, release: () => {}, waitedMs: 0 });
    let h = this.hosts.get(host);
    if (!h) this.hosts.set(host, (h = { inFlight: 0, waiting: [], credit: 0 }));
    if (h.inFlight < this.settings.maxConcurrencyPerHost && !h.waiting.length) return Promise.resolve(this.admit(host, h, 0));
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted", waitedMs: 0 });
    if (this.settings.queueMaxWaitMs <= 0) return Promise.resolve({ ok: false, reason: "timeout", waitedMs: 0 });
    if (h.waiting.length >= SEALED_QUEUE_MAX_LENGTH) return Promise.resolve({ ok: false, reason: "queue_full", waitedMs: 0 });
    const state = h;
    return new Promise<Admission>((resolve) => {
      const w: Waiter = { priority: Math.max(0, priority), seq: ++this.seq, at: this.now(), settle: resolve, timer: null, onAbort: null, signal };
      const leave = (reason: "timeout" | "aborted") => {
        const i = state.waiting.indexOf(w);
        if (i < 0) return;
        state.waiting.splice(i, 1);
        this.clear(w);
        resolve({ ok: false, reason, waitedMs: this.now() - w.at });
        this.forget(host, state);
      };
      w.timer = setTimeout(() => leave("timeout"), this.settings.queueMaxWaitMs);
      if (signal) {
        w.onAbort = () => leave("aborted");
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      state.waiting.push(w);
    });
  }

  private clear(w: Waiter) {
    if (w.timer) clearTimeout(w.timer);
    if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
    w.timer = null;
    w.onAbort = null;
  }

  private admit(host: string, h: Host, waitedMs: number): Admission {
    h.inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(hold);
      h.inFlight = Math.max(0, h.inFlight - 1);
      this.drain(host, h);
    };
    const hold = setTimeout(release, this.maxHoldMs);
    (hold as { unref?: () => void }).unref?.();
    return { ok: true, release, waitedMs };
  }

  /** The next waiter to admit: the fairness share first, then priority, then arrival. */
  private next(h: Host): Waiter {
    const byPriority = (a: Waiter, b: Waiter) => b.priority - a.priority || a.seq - b.seq;
    const none = h.waiting.filter((w) => w.priority <= 0).sort((a, b) => a.seq - b.seq);
    const contended = none.length > 0 && none.length < h.waiting.length;
    if (contended) {
      h.credit += this.settings.nonHolderMinShare;
      if (h.credit >= 1 - 1e-9) {
        h.credit -= 1;
        return none[0];
      }
    }
    return [...h.waiting].sort(byPriority)[0];
  }

  private drain(host: string, h: Host) {
    while (h.inFlight < this.settings.maxConcurrencyPerHost && h.waiting.length) {
      const w = this.next(h);
      h.waiting.splice(h.waiting.indexOf(w), 1);
      this.clear(w);
      w.settle(this.admit(host, h, this.now() - w.at));
    }
    this.forget(host, h);
  }

  private forget(host: string, h: Host) {
    if (!h.inFlight && !h.waiting.length && this.hosts.get(host) === h) this.hosts.delete(host);
  }
}

const queues = new WeakMap<Ctx, SealedQueue>();
export function sealedQueueOf(ctx: Ctx): SealedQueue {
  let q = queues.get(ctx);
  if (!q) queues.set(ctx, (q = new SealedQueue(ctx.cfg.holders.sealed)));
  return q;
}

/**
 * The admission hook router/execute.ts calls before each provider attempt of a SEALED-lane request, or undefined when
 * the request is on another lane or no concurrency limit is set (then routing is exactly what it was).
 */
export function sealedAdmission(ctx: Ctx, lane: string, tier: HolderTier | null) {
  const q = sealedQueueOf(ctx);
  if (lane !== "attested" || !q.enabled) return undefined;
  const priority = tier?.sealedPriority ?? 0;
  return (host: string, signal: AbortSignal) => q.acquire(host, priority, signal);
}
