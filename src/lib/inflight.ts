// Requests in flight per caller, in this process (security review R5-04): one key, or one source address without a key,
// holds at most a configured number of inference calls open at a time, so a single caller cannot occupy a provider (the
// one attested gateway, in the launch) with slow calls while everyone else waits.
//
// Invariants (test/security-r5-04-limits.test.ts holds each one over randomized acquire / release / abandon sequences):
//   (a) a caller never holds more than `limit` slots;
//   (b) a slot is given back exactly once, however often its release() is called;
//   (c) a slot nobody gave back frees itself after `maxHoldMs`: a leak can never lock a caller out for good;
//   (d) one caller's slots never count against another caller.
//
// Each router replica counts its own; the limit is per replica.

export type Slot = { release: () => void; /** Set by a streamed answer, which gives the slot back itself when the stream ends. */ deferred?: boolean };

export class InFlight {
  private held = new Map<string, Set<{ at: number }>>();
  constructor(private maxHoldMs: number, private now: () => number = Date.now) {}

  /** A slot for `key`, or null when it already holds `limit`. A limit of 0 (or less) means no limit. */
  acquire(key: string, limit: number): Slot | null {
    if (!(limit > 0)) return { release: () => {} };
    let set = this.held.get(key);
    if (set) {
      const cutoff = this.now() - this.maxHoldMs;
      for (const s of set) if (s.at < cutoff) set.delete(s);
    }
    if (set && set.size >= limit) return null;
    if (!set) this.held.set(key, (set = new Set()));
    const mine = set;
    const slot = { at: this.now() };
    mine.add(slot);
    return {
      release: () => {
        mine.delete(slot);
        if (!mine.size && this.held.get(key) === mine) this.held.delete(key);
      },
    };
  }

  /** Slots `key` holds now (expired ones are not counted). */
  count(key: string): number {
    const set = this.held.get(key);
    if (!set) return 0;
    const cutoff = this.now() - this.maxHoldMs;
    let n = 0;
    for (const s of set) if (s.at >= cutoff) n++;
    return n;
  }
}
