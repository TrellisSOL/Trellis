// Fixed-window counters for requests/minute and tokens/minute, and continuously refilled budgets (`spend`) for what
// must hold over ANY interval (the SOL a fee payer spends for strangers). In-process by default; Redis-backed when
// REDIS_URL is set so limits hold across router replicas.

export interface RateLimiter {
  take(key: string, amount: number, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterMs: number; remaining: number }>;
  /**
   * A continuously refilled budget (no window to straddle): over ANY interval of `windowMs` at most `capPerWindow` is
   * taken. At most a quarter of the cap is available at once (`budgetBurst`); the other three quarters arrive evenly
   * over the window, the same construction as the credits program's outflow limiter. A budget that was never used
   * starts with its burst. Fixed windows let two budgets be spent back to back across a boundary; this does not.
   */
  spend(key: string, amount: number, capPerWindow: number, windowMs: number): Promise<{ ok: boolean; retryAfterMs: number; remaining: number }>;
  /** Hand back `amount` that `spend` took for something that then did not happen. Never above the burst. */
  unspend(key: string, amount: number, capPerWindow: number, windowMs: number): Promise<void>;
  close(): Promise<void>;
}

/** The most a continuous budget holds at once: a quarter of the window's cap, and never less than one unit. */
export const budgetBurst = (capPerWindow: number) => Math.max(1, Math.floor(capPerWindow / 4));
/** What a continuous budget holds at `now`, given what it held at `at` (the arithmetic both limiters share). */
export function budgetLevel(level: number, at: number, now: number, capPerWindow: number, windowMs: number): number {
  const burst = budgetBurst(capPerWindow);
  const elapsed = Math.min(Math.max(now - at, 0), windowMs);
  return Math.min(burst, level + ((capPerWindow - burst) * elapsed) / windowMs);
}

export class MemoryRateLimiter implements RateLimiter {
  private budgets = new Map<string, { level: number; at: number }>();
  private windows = new Map<string, { start: number; used: number }>();
  private sweep = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, w] of this.windows) if (w.start < cutoff) this.windows.delete(k);
    // A continuous budget untouched for more than its longest window (a day) is full again: forgetting it changes nothing.
    const stale = Date.now() - 25 * 3_600_000;
    for (const [k, b] of this.budgets) if (b.at < stale) this.budgets.delete(k);
  }, 60_000);
  constructor(private readonly now: () => number = () => Date.now()) {
    this.sweep.unref?.();
  }
  async take(key: string, amount: number, limit: number, windowMs: number) {
    if (!limit || limit <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const now = this.now();
    const start = now - (now % windowMs);
    const w = this.windows.get(key);
    const cur = w && w.start === start ? w : { start, used: 0 };
    if (cur.used + amount > limit) return { ok: false, retryAfterMs: start + windowMs - now, remaining: Math.max(0, limit - cur.used) };
    cur.used += amount;
    this.windows.set(key, cur);
    return { ok: true, retryAfterMs: 0, remaining: limit - cur.used };
  }
  async spend(key: string, amount: number, capPerWindow: number, windowMs: number) {
    if (!capPerWindow || capPerWindow <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const now = this.now();
    const b = this.budgets.get(key);
    const level = b ? budgetLevel(b.level, b.at, now, capPerWindow, windowMs) : budgetBurst(capPerWindow);
    if (amount > level) {
      const rate = (capPerWindow - budgetBurst(capPerWindow)) / windowMs;
      return { ok: false, retryAfterMs: rate > 0 && amount <= budgetBurst(capPerWindow) ? Math.ceil((amount - level) / rate) : windowMs, remaining: Math.floor(level) };
    }
    this.budgets.set(key, { level: level - amount, at: now });
    return { ok: true, retryAfterMs: 0, remaining: Math.floor(level - amount) };
  }
  async unspend(key: string, amount: number, capPerWindow: number, windowMs: number) {
    const now = this.now();
    const b = this.budgets.get(key);
    if (!b) return;
    this.budgets.set(key, { level: Math.min(budgetBurst(capPerWindow), budgetLevel(b.level, b.at, now, capPerWindow, windowMs) + amount), at: now });
  }
  async close() {
    clearInterval(this.sweep);
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: import("ioredis").Redis) {}
  async take(key: string, amount: number, limit: number, windowMs: number) {
    if (!limit || limit <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const now = Date.now();
    const start = now - (now % windowMs);
    const k = `rl:${key}:${start}`;
    const used = await this.redis.incrby(k, amount);
    if (used === amount) await this.redis.pexpire(k, windowMs + 1000);
    if (used > limit) {
      await this.redis.decrby(k, amount);
      return { ok: false, retryAfterMs: start + windowMs - now, remaining: Math.max(0, limit - (used - amount)) };
    }
    return { ok: true, retryAfterMs: 0, remaining: limit - used };
  }
  // One script per call, so replicas sharing a budget never read and write it in two steps. KEYS[1] holds "level:at".
  private static BUDGET = `
local cap, window, amount, now, give = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5] == "1"
local burst = math.max(1, math.floor(cap / 4))
local level = burst
local call = redis.call
local raw = call("GET", KEYS[1])
if raw then
  local sep = string.find(raw, ":", 1, true)
  local held, at = tonumber(string.sub(raw, 1, sep - 1)), tonumber(string.sub(raw, sep + 1))
  local elapsed = math.min(math.max(now - at, 0), window)
  level = math.min(burst, held + (cap - burst) * elapsed / window)
elseif give then
  return {1, tostring(level)}
end
if give then
  level = math.min(burst, level + amount)
elseif amount > level then
  return {0, tostring(level)}
else
  level = level - amount
end
call("SET", KEYS[1], tostring(level) .. ":" .. tostring(now), "PX", window + 1000)
return {1, tostring(level)}`;
  private async budget(key: string, amount: number, capPerWindow: number, windowMs: number, give: boolean): Promise<[number, number]> {
    const k = `rb:${key}`;
    const r = (await this.redis.eval(RedisRateLimiter.BUDGET, 1, k, capPerWindow, windowMs, amount, Date.now(), give ? "1" : "0")) as [number, string];
    return [Number(r[0]), Number(r[1])];
  }
  async spend(key: string, amount: number, capPerWindow: number, windowMs: number) {
    if (!capPerWindow || capPerWindow <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const [ok, level] = await this.budget(key, amount, capPerWindow, windowMs, false);
    if (ok) return { ok: true, retryAfterMs: 0, remaining: Math.floor(level) };
    const rate = (capPerWindow - budgetBurst(capPerWindow)) / windowMs;
    return { ok: false, retryAfterMs: rate > 0 && amount <= budgetBurst(capPerWindow) ? Math.ceil((amount - level) / rate) : windowMs, remaining: Math.floor(level) };
  }
  async unspend(key: string, amount: number, capPerWindow: number, windowMs: number) {
    await this.budget(key, amount, capPerWindow, windowMs, true);
  }
  async close() {}
}
