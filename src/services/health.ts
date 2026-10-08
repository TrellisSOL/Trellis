import { refreshUpstreamHealth } from "../rush/monitor.ts"; // ON3
import { sql } from "drizzle-orm";
import { refreshNetworkRouting } from "../network/routing.ts";
import type { Db } from "../db/client.ts";
import { health } from "../db/schema.ts";
import type { HealthView, Percentiles } from "../router/select.ts";
import { log, percentile } from "../lib/util.ts";

export type HealthEvent = {
  modelId: string;
  providerId: string;
  ok: boolean;
  latencyMs?: number | null; // time to first token (or full response for non-stream)
  tps?: number | null;
  empty200?: boolean;
  statusCode?: number | null;
  errorKind?: string | null; // http_5xx | timeout | connection | empty200 | rate_limited | rejected | unreadable
  source?: "traffic" | "probe" | "canary";
  caller?: string | null; // hashed account id: empty-200s only count when several callers see them
  at?: number;
};

/** Failure kinds a caller can order at will (R5-04): never an outage on traffic alone. */
const CALLER_ORDERED: ReadonlySet<string> = new Set(["timeout", "oversize", "cancelled"]);
// Client-caused rejections (4xx) never count against a provider.
const counts = (e: HealthEvent) => e.ok || e.errorKind !== "rejected";
const hardFailure = (e: HealthEvent) => !e.ok && e.errorKind !== "rejected";
// An over-report (usage above the hold: services/hold-watch.ts) is recorded next to the call's own event, so it is
// not counted a second time in uptime; like an empty answer it takes a provider out of routing only once two
// different callers have seen it, because a single caller chooses the requests it sends.
const countsForUptime = (e: HealthEvent) => e.ok || (e.errorKind !== "rejected" && e.errorKind !== "rate_limited" && e.errorKind !== "over_report");

export class HealthTracker implements HealthView {
  private recent = new Map<string, HealthEvent[]>();
  private uptimeMap = new Map<string, { ok: number; total: number }>();
  private qualityMap = new Map<string, number>();
  private pending: HealthEvent[] = [];
  private unflushed = new Map<string, { ok: number; total: number }>();
  /** Providers taken out of routing until a time (R5-09: gateway receipts that keep failing). Always ends by itself. */
  private suspended = new Map<string, number>();

  constructor(private outageWindowMs = 30_000, private historyMs = 60 * 60_000, private maxEvents = 2_000) {}

  private k = (m: string, p: string) => `${m}\u0000${p}`;

  record(e: HealthEvent) {
    const ev = { ...e, at: e.at ?? Date.now() };
    const key = this.k(e.modelId, e.providerId);
    const list = this.recent.get(key) ?? [];
    list.push(ev);
    const cutoff = Date.now() - this.historyMs;
    while (list.length && (list[0].at! < cutoff || list.length > this.maxEvents)) list.shift();
    this.recent.set(key, list);
    this.pending.push(ev);
    this.bump(ev, 1);
  }

  private bump(e: HealthEvent, sign: 1 | -1) {
    if (!countsForUptime(e)) return;
    const key = this.k(e.modelId, e.providerId);
    const u = this.unflushed.get(key) ?? { ok: 0, total: 0 };
    u.total += sign;
    if (e.ok) u.ok += sign;
    this.unflushed.set(key, u);
  }

  /**
   * Take a provider out of routing for `ms` (at most an hour), whatever its traffic looks like. For a fault traffic
   * health cannot see (services/billing-watch.ts). It ends by itself; a later call can only move the end forward.
   */
  suspend(providerId: string, ms: number) {
    const until = Date.now() + Math.min(Math.max(0, ms), 3_600_000);
    if (until > (this.suspended.get(providerId) ?? 0)) this.suspended.set(providerId, until);
  }

  /** Whether `suspend` currently holds the provider out of routing. */
  isSuspended(providerId: string) {
    const until = this.suspended.get(providerId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.suspended.delete(providerId);
    return false;
  }

  /**
   * Outage: suspended, or the most recent probe failed with no success since, or, in the last 30s, at least two hard
   * failures SEEN BY TWO DIFFERENT CALLERS and at least as many failures as successes.
   *
   * Security review R5-04: one caller chooses the requests it sends, so
   *   - no number of failures from ONE caller is an outage: traffic failures count only once two different callers have
   *     seen one inside the window (a caller-less traffic event is the anonymous caller "src:traffic": all of them
   *     together are one caller);
   *   - slowness and size are never an outage on traffic alone, from however many callers: a request that outlasts the
   *     router's timeout, an answer above the size it reads and a call its caller cancelled are what a caller orders
   *     (two accounts are as cheap as one). Whether the provider is really down is for the probe to say.
   */
  outage(modelId: string, providerId: string) {
    if (this.isSuspended(providerId)) return true;
    const list = this.recent.get(this.k(modelId, providerId));
    if (!list?.length) return false;
    const since = Date.now() - this.outageWindowMs;
    let fails = 0;
    let oks = 0;
    const callers = new Set<string>();
    for (let i = list.length - 1; i >= 0 && list[i].at! >= since; i--) {
      const e = list[i];
      if (!counts(e)) continue;
      if (e.ok) oks++;
      else if (e.source === "traffic" && CALLER_ORDERED.has(e.errorKind ?? "")) continue;
      else {
        fails++;
        callers.add(e.caller ?? `src:${e.source}`);
      }
    }
    if (callers.size >= 2 && fails >= 2 && fails >= oks) return true;
    const last = [...list].reverse().find(counts);
    return !!last && last.at! >= since && hardFailure(last) && last.source === "probe";
  }

  lastFailureKind(modelId: string, providerId: string) { // B121: distinguish availability from rate/policy outages without retaining new data.
    return this.recent.get(this.k(modelId, providerId))?.findLast(e => !e.ok && (e.at ?? 0) >= Date.now() - this.outageWindowMs)?.errorKind;
  }

  uptime30d(modelId: string, providerId: string) {
    const key = this.k(modelId, providerId);
    const agg = this.uptimeMap.get(key) ?? { ok: 0, total: 0 };
    const extra = this.unflushed.get(key) ?? { ok: 0, total: 0 }; // recorded but not yet aggregated
    const ok = agg.ok + extra.ok;
    const total = agg.total + extra.total;
    // Laplace-style prior: a new provider starts at ~0.95-1.0 rather than 0 or 1.
    return (ok + 19) / (total + 20);
  }

  /** Measured 30-day success rate (no prior), or null without observations. For display, not routing. */
  observedUptime(modelId: string, providerId: string): { rate: number; events: number } | null {
    const key = this.k(modelId, providerId);
    const agg = this.uptimeMap.get(key) ?? { ok: 0, total: 0 };
    const extra = this.unflushed.get(key) ?? { ok: 0, total: 0 };
    const total = agg.total + extra.total;
    return total ? { rate: (agg.ok + extra.ok) / total, events: total } : null;
  }

  quality(modelId: string, providerId: string) {
    const q = this.qualityMap.get(this.k(modelId, providerId));
    return q == null ? 1 : Math.min(1, Math.max(0.5, q));
  }

  setQuality(modelId: string, providerId: string, q: number) {
    this.qualityMap.set(this.k(modelId, providerId), Math.min(1, Math.max(0.5, q)));
  }

  stats(modelId: string, providerId: string): { latency: Percentiles; throughput: Percentiles } | null {
    const list = (this.recent.get(this.k(modelId, providerId)) ?? []).filter((e) => e.ok);
    if (list.length < 3) return null;
    const lat = list.map((e) => e.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b);
    const tps = list.map((e) => e.tps).filter((x): x is number => x != null).sort((a, b) => a - b);
    // For throughput, "p90" means the rate 90% of requests reach or exceed, so read from the low end.
    const low = (p: number) => percentile(tps, 100 - p) ?? undefined;
    return {
      latency: { p50: percentile(lat, 50) ?? undefined, p75: percentile(lat, 75) ?? undefined, p90: percentile(lat, 90) ?? undefined, p99: percentile(lat, 99) ?? undefined },
      throughput: { p50: low(50), p75: low(75), p90: low(90), p99: low(99) },
    };
  }

  snapshot(modelId: string, providerId: string) {
    return {
      outage: this.outage(modelId, providerId),
      uptime30d: this.uptime30d(modelId, providerId),
      quality: this.quality(modelId, providerId),
      stats: this.stats(modelId, providerId),
    };
  }

  /** Persist buffered events. */
  async flush(db: Db) {
    await refreshUpstreamHealth(this, db); // ON3
    if (!this.pending.length) { await refreshNetworkRouting(this, db).catch(() => undefined); return 0; }
    const batch = this.pending.splice(0, this.pending.length);
    try {
      for (let i = 0; i < batch.length; i += 500) {
        await db.insert(health).values(
          batch.slice(i, i + 500).map((e) => ({
            modelId: e.modelId,
            providerId: e.providerId,
            ts: new Date(e.at!),
            ok: e.ok,
            latencyMs: e.latencyMs == null ? null : Math.round(e.latencyMs),
            tps: e.tps ?? null,
            empty200: !!e.empty200,
            statusCode: e.statusCode ?? null,
            errorKind: e.errorKind ?? null,
            source: e.source ?? "traffic",
            caller: e.caller ?? null,
          })),
        );
      }
    } catch (err) {
      log.error("health flush failed", { error: (err as Error).message });
      this.pending.unshift(...batch);
      throw err;
    }
    await this.refreshAggregates(db);
    for (const e of batch) this.bump(e, -1);
    return batch.length;
  }

  /** Recompute 30-day uptime and latest canary quality per model x provider. */
  async refreshAggregates(db: Db) {
    await refreshNetworkRouting(this, db).catch(() => undefined);
    const up = await db.execute(sql`
      SELECT model_id, provider_id,
             count(*) FILTER (WHERE ok) AS ok,
             count(*) AS total
      FROM health
      WHERE ts > now() - interval '30 days'
        AND (ok OR (error_kind IS DISTINCT FROM 'rejected' AND error_kind IS DISTINCT FROM 'rate_limited' AND error_kind IS DISTINCT FROM 'over_report'))
      GROUP BY model_id, provider_id`);
    const rows = ((up as { rows?: unknown[] }).rows ?? up) as Array<{ model_id: string; provider_id: string; ok: number | string; total: number | string }>;
    const map = new Map<string, { ok: number; total: number }>();
    for (const r of rows) map.set(this.k(r.model_id, r.provider_id), { ok: Number(r.ok), total: Number(r.total) });
    this.uptimeMap = map;
    const q = await db.execute(sql`
      SELECT DISTINCT ON (model_id, provider_id) model_id, provider_id, quality
      FROM canaries WHERE quality IS NOT NULL
      ORDER BY model_id, provider_id, ts DESC`);
    const qrows = ((q as { rows?: unknown[] }).rows ?? q) as Array<{ model_id: string; provider_id: string; quality: number }>;
    for (const r of qrows) this.qualityMap.set(this.k(r.model_id, r.provider_id), Number(r.quality));
  }

  empty200Rate(modelId: string, providerId: string, windowMs = 24 * 3_600_000) {
    const since = Date.now() - windowMs;
    const list = (this.recent.get(this.k(modelId, providerId)) ?? []).filter((e) => e.at! >= since && e.source === "traffic");
    if (!list.length) return { rate: 0, n: 0 };
    return { rate: list.filter((e) => e.empty200).length / list.length, n: list.length };
  }
}
