/**
 * One computation at a time, its result served for `ttlMs` (security review R5-05: GET /ready, /ready/metrics and
 * /api/v1/status were recomputed, chain reads and a 30-day aggregate included, for every anonymous request).
 *
 * Invariants (test/security-r5-05-free-limits.test.ts holds them over random callers, durations, failures and clocks):
 *   1. At most one computation is in flight; a caller that arrives meanwhile gets that computation's outcome.
 *   2. A result is served only while less than `ttlMs` has passed since its computation FINISHED; then the next caller
 *      starts a new one. So what a caller sees is at most `ttlMs` plus one computation old, and computations start at
 *      most once per `ttlMs`. `ttlMs` 0 keeps nothing: every caller computes, still one at a time.
 *   3. A computation that throws is served to the callers that were waiting for it and to nobody else: it is not kept,
 *      the next caller computes again. A value that reports a failure (a readiness result that is not ok) is a value
 *      like any other and is kept exactly as long as a good one, never longer.
 * The clock is monotonic by default; a reading earlier than the result's own time counts as expired, not as fresh.
 */
export function singleFlight<T>(ttlMs: number, compute: () => Promise<T>, now: () => number = () => performance.now()): () => Promise<T> {
  let kept: { at: number; value: T } | null = null;
  let flight: Promise<T> | null = null;
  return () => {
    if (kept) {
      const age = now() - kept.at;
      if (age >= 0 && age < ttlMs) return Promise.resolve(kept.value);
      kept = null;
    }
    if (flight) return flight;
    const mine: Promise<T> = (async () => compute())().then(
      (value) => { kept = { at: now(), value }; flight = null; return value; },
      (error) => { flight = null; throw error; },
    );
    flight = mine;
    return mine;
  };
}
