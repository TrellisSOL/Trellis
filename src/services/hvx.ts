import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gt, gte, lt, notInArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, generations, models, providers } from "../db/schema.ts";
import { hvxPoints } from "./hvx-schema.ts";
import { picoToUsd, usdToPico, type Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { addressKey } from "../solana/constants.ts";
import { loadHvxConfig, type HvxConfig } from "./hvx-config.ts";

// HVX (docs/Trellis_Backend.md §5.6): an hourly $/1M-token index per grade (G-S small, G-M medium, G-L large by model
// parameter class), built only from receipts, wash-filtered, flagged THIN when daily volume is under $50k. A public
// statistic: nothing settles against it (§5.6, §11).
//
// Wash filter, per hour:
//  - self-dealing: the payer is the host it paid (the payer account, or its wallet, is the host's operator or payout
//    address);
//  - circular payments within two hops: in the graph payer -> host built from the hour's receipts, the host (or a host
//    it paid) paid the payer back inside the same hour;
//  - minimum payment size: receipts charged below HVX_MIN_PAYMENT_USD.
// Tokens are output-equivalent (§5.6): output and reasoning tokens count 1, prompt tokens 0.25, cached prompt tokens 0.05.

export const GRADES = ["G-S", "G-M", "G-L"] as const;
export type Grade = (typeof GRADES)[number];
export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HVX_FORMAT = "trellis.hvx/1";

export type HvxPoint = { grade: Grade; hour: string; usd_per_mtoken: number | null; thin: boolean; sample_count: number; excluded_count: number; tokens: string; volume_usd: string; daily_volume_usd: string; published_tx: string | null };

// ---- grades ---------------------------------------------------------------------------------------------------------

/**
 * Parameter count in billions from the catalog: `arch.parameters_b` when the catalogue entry carries it, else the
 * size written into the model id or name ("llama-3.3-70b", "gpt-oss-120B", "qwen3-32b", "mixtral-8x7b" = 56).
 * Null when the catalogue says nothing; such receipts are not index input.
 */
export function parameterCountB(m: { id: string; name?: string | null; arch?: unknown }): number | null {
  const arch = (m.arch ?? {}) as { parameters_b?: unknown };
  if (typeof arch.parameters_b === "number" && arch.parameters_b > 0) return arch.parameters_b;
  for (const text of [m.id, m.name ?? ""]) {
    const moe = /(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(text);
    if (moe) return Number(moe[1]) * Number(moe[2]);
    const plain = /(?<![a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(text);
    if (plain) return Number(plain[1]);
  }
  return null;
}

export function gradeOf(paramsB: number | null, cfg: Pick<HvxConfig, "smallMaxB" | "mediumMaxB">): Grade | null {
  if (paramsB == null || !(paramsB > 0)) return null;
  if (paramsB < cfg.smallMaxB) return "G-S";
  if (paramsB < cfg.mediumMaxB) return "G-M";
  return "G-L";
}

// ---- wash filter ----------------------------------------------------------------------------------------------------

export type HvxReceipt = {
  id: string;
  /** Payer account id (null for a blind or per-call payment with no account: kept, it cannot be self-dealing we can see). */
  accountId: string | null;
  providerId: string;
  grade: Grade | null;
  cost: Pico;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  cachedTokens: number;
};

/** Identity aliases: an account is itself and its wallet; a host is its provider id, operator and payout address. */
export type Identities = { accounts: Map<string, string[]>; hosts: Map<string, string[]> };

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    // Path compression: everything on the way now points at the root.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export const outputEquivalentTokens = (r: Pick<HvxReceipt, "tokensIn" | "tokensOut" | "reasoningTokens" | "cachedTokens">) => {
  const cached = Math.min(Math.max(0, r.cachedTokens), Math.max(0, r.tokensIn));
  return Math.max(0, r.tokensOut) + Math.max(0, r.reasoningTokens) + 0.25 * (Math.max(0, r.tokensIn) - cached) + 0.05 * cached;
};

export type WashResult = { kept: HvxReceipt[]; excluded: { id: string; reason: "self_dealing" | "circular" | "below_minimum" | "no_grade" }[] };

/** Applies the §5.6 filter to one hour's receipts. Pure, so the fixtures in test/hvx.test.ts can exercise it directly. */
export function washFilter(receipts: HvxReceipt[], ids: Identities, minPaymentPico: Pico): WashResult {
  const uf = new UnionFind();
  for (const [id, aliases] of ids.accounts) for (const a of aliases) if (a) uf.union(`acct:${id}`, `id:${a}`);
  for (const [id, aliases] of ids.hosts) for (const a of aliases) if (a) uf.union(`host:${id}`, `id:${a}`);
  const payerNode = (r: HvxReceipt) => (r.accountId ? uf.find(`acct:${r.accountId}`) : null);
  const hostNode = (r: HvxReceipt) => uf.find(`host:${r.providerId}`);
  // payer -> {hosts paid} over the hour, between distinct parties only.
  const paid = new Map<string, Set<string>>();
  for (const r of receipts) {
    const p = payerNode(r);
    const h = hostNode(r);
    if (!p || p === h) continue;
    const set = paid.get(p) ?? new Set<string>();
    set.add(h);
    paid.set(p, set);
  }
  const paysBack = (from: string, to: string) => {
    const direct = paid.get(from);
    if (!direct) return false;
    if (direct.has(to)) return true;
    for (const x of direct) if (paid.get(x)?.has(to)) return true;
    return false;
  };
  const out: WashResult = { kept: [], excluded: [] };
  for (const r of receipts) {
    if (!r.grade) {
      out.excluded.push({ id: r.id, reason: "no_grade" });
      continue;
    }
    if (r.cost < minPaymentPico) {
      out.excluded.push({ id: r.id, reason: "below_minimum" });
      continue;
    }
    const p = payerNode(r);
    const h = hostNode(r);
    if (p && p === h) {
      out.excluded.push({ id: r.id, reason: "self_dealing" });
      continue;
    }
    if (p && paysBack(h, p)) {
      out.excluded.push({ id: r.id, reason: "circular" });
      continue;
    }
    out.kept.push(r);
  }
  return out;
}

// ---- the hourly computation -----------------------------------------------------------------------------------------

export const hourStart = (t: number | Date) => new Date(Math.floor((typeof t === "number" ? t : t.getTime()) / HOUR_MS) * HOUR_MS);

async function loadIdentities(ctx: Ctx): Promise<Identities> {
  const [acc, hosts] = await Promise.all([
    ctx.db.select({ id: accounts.id, wallet: accounts.wallet }).from(accounts),
    ctx.db.select({ id: providers.id, operator: providers.operator, payout: providers.payoutAddress }).from(providers),
  ]);
  return {
    accounts: new Map(acc.map((a) => [a.id, [a.id, ...(a.wallet ? [addressKey(a.wallet)] : [])]])),
    hosts: new Map(hosts.map((h) => [h.id, [h.id, ...(h.operator ? [addressKey(h.operator)] : []), ...(h.payout ? [addressKey(h.payout)] : [])]])),
  };
}

/** The hour's paid, completed receipts with the grade of the model they were served on. */
async function loadReceipts(ctx: Ctx, cfg: HvxConfig, from: Date, to: Date): Promise<HvxReceipt[]> {
  const rows = await ctx.db
    .select({ id: generations.id, accountId: generations.accountId, providerId: generations.providerId, modelId: generations.modelId, cost: generations.cost, tokensIn: generations.tokensIn, tokensOut: generations.tokensOut, reasoningTokens: generations.reasoningTokens, cachedTokens: generations.cachedTokens })
    .from(generations)
    .where(and(gte(generations.ts, from), lt(generations.ts, to), gt(generations.cost, 0n), eq(generations.cancelled, false), notInArray(generations.mode, ["byok", "cache"]), sql`${generations.finishReason} IS DISTINCT FROM 'error'`));
  const modelRows = await ctx.db.select({ id: models.id, name: models.name, arch: models.arch }).from(models);
  const grades = new Map(modelRows.map((m) => [m.id, gradeOf(parameterCountB(m), cfg)]));
  return rows.map((r) => ({ id: r.id, accountId: r.accountId, providerId: r.providerId, grade: grades.get(r.modelId) ?? null, cost: r.cost, tokensIn: r.tokensIn, tokensOut: r.tokensOut, reasoningTokens: r.reasoningTokens, cachedTokens: r.cachedTokens }));
}

export type GradeSummary = { grade: Grade; sampleCount: number; excludedCount: number; tokens: number; volume: Pico; usdPerMtoken: number | null };

/** Index numbers per grade from one hour's receipts. */
export function summarizeHour(receipts: HvxReceipt[], ids: Identities, cfg: HvxConfig): GradeSummary[] {
  const washed = washFilter(receipts, ids, usdToPico(cfg.minPaymentUsd));
  return GRADES.map((grade) => {
    const kept = washed.kept.filter((r) => r.grade === grade);
    const excludedCount = receipts.filter((r) => r.grade === grade).length - kept.length;
    const tokens = kept.reduce((a, r) => a + outputEquivalentTokens(r), 0);
    const volume = kept.reduce((a, r) => a + r.cost, 0n);
    const usdPerMtoken = tokens > 0 ? (picoToUsd(volume) / tokens) * 1_000_000 : null;
    return { grade, sampleCount: kept.length, excludedCount, tokens, volume, usdPerMtoken };
  });
}

async function dailyVolume(ctx: Ctx, grade: Grade, hour: Date): Promise<Pico> {
  const [row] = await ctx.db
    .select({ v: sql<string>`coalesce(sum(${hvxPoints.volume}), 0)` })
    .from(hvxPoints)
    .where(and(eq(hvxPoints.grade, grade), gt(hvxPoints.hour, new Date(hour.getTime() - DAY_MS)), lt(hvxPoints.hour, new Date(hour.getTime() + HOUR_MS))));
  return BigInt(row?.v ?? "0");
}

const toPoint = (r: typeof hvxPoints.$inferSelect): HvxPoint => ({
  grade: r.grade as Grade,
  hour: r.hour.toISOString(),
  usd_per_mtoken: r.usdPerMtoken == null ? null : Number(r.usdPerMtoken.toFixed(6)),
  thin: r.thin,
  sample_count: r.sampleCount,
  excluded_count: r.excludedCount,
  tokens: r.tokens.toString(),
  volume_usd: picoToUsd(r.volume).toFixed(6),
  daily_volume_usd: picoToUsd(r.dailyVolume).toFixed(6),
  published_tx: r.publishedTx,
});

/** Computes and stores the points of one hour (upsert on grade + hour). */
export async function computeHour(ctx: Ctx, cfg: HvxConfig, hour: Date): Promise<HvxPoint[]> {
  const from = hourStart(hour);
  const to = new Date(from.getTime() + HOUR_MS);
  const [receipts, ids] = await Promise.all([loadReceipts(ctx, cfg, from, to), loadIdentities(ctx)]);
  const out: HvxPoint[] = [];
  for (const s of summarizeHour(receipts, ids, cfg)) {
    const now = new Date();
    const base = { usdPerMtoken: s.usdPerMtoken, sampleCount: s.sampleCount, excludedCount: s.excludedCount, tokens: BigInt(Math.round(s.tokens)), volume: s.volume, updatedAt: now };
    await ctx.db
      .insert(hvxPoints)
      .values({ grade: s.grade, hour: from, ...base, thin: true, dailyVolume: 0n })
      .onConflictDoUpdate({ target: [hvxPoints.grade, hvxPoints.hour], set: base });
    // Daily volume over the trailing 24 points of this grade, including the one just written.
    const daily = await dailyVolume(ctx, s.grade, from);
    const thin = picoToUsd(daily) < cfg.thinDailyUsd;
    const [row] = await ctx.db.update(hvxPoints).set({ dailyVolume: daily, thin }).where(and(eq(hvxPoints.grade, s.grade), eq(hvxPoints.hour, from))).returning();
    out.push(toPoint(row));
  }
  return out;
}

// ---- on-chain publication -------------------------------------------------------------------------------------------

/** What src/solana/hvx-publish.ts exports: posts one completed hour's point to its grade's HvxFeed account
 *  (trellis_capacity::publish_hvx), signed by the HVX authority. `tx` is null when it sent nothing. */
export interface HvxPublisher {
  publishHvx(point: HvxPoint, target?: { chain: Ctx["chain"]; programId: string | undefined; role: HvxConfig["authorityRole"]; commitment?: "confirmed" | "finalized" }): Promise<{ tx: string | null }>;
}

let publisher: Promise<HvxPublisher | null> | undefined;
/** The publisher in src/solana/hvx-publish.ts. Loaded on first use, and only when publication is on, so a router that
 *  never publishes never loads the chain client for it. */
export function hvxPublisher(): Promise<HvxPublisher | null> {
  publisher ??= (async () => {
    const url = new URL("../solana/hvx-publish.ts", import.meta.url);
    if (!existsSync(fileURLToPath(url))) return null;
    const mod = (await import(url.href)) as Partial<HvxPublisher>;
    return typeof mod.publishHvx === "function" ? { publishHvx: mod.publishHvx } : null;
  })();
  return publisher;
}

/** Publish the completed hours that are not on chain yet, oldest first, with HVX_PUBLISH_ONCHAIN. The feed keeps one
 *  value per grade and never goes back, so an unpublished hour older than the newest published hour of its grade is
 *  left as it is. A failure is logged and the hour is tried again on the next run. */
async function publishCompleted(ctx: Ctx, cfg: HvxConfig, before: Date) {
  if (!cfg.publishOnchain) return 0;
  const pub = await hvxPublisher();
  if (!pub) return 0;
  const due = await ctx.db.select().from(hvxPoints).where(and(lt(hvxPoints.hour, before), sql`${hvxPoints.publishedTx} IS NULL`, gt(hvxPoints.sampleCount, 0))).orderBy(hvxPoints.hour);
  if (!due.length) return 0;
  const published = await ctx.db.select({ grade: hvxPoints.grade, hour: sql<Date | string | null>`max(${hvxPoints.hour})` }).from(hvxPoints).where(sql`${hvxPoints.publishedTx} IS NOT NULL`).groupBy(hvxPoints.grade);
  const newest = new Map(published.map((p) => [p.grade, p.hour ? new Date(p.hour).getTime() : -Infinity]));
  const target = { chain: ctx.chain, programId: ctx.cfg.solana.programs.capacity, role: cfg.authorityRole, commitment: ctx.cfg.solana.commitment };
  let n = 0;
  for (const row of due) {
    if (row.hour.getTime() <= (newest.get(row.grade) ?? -Infinity)) continue;
    try {
      const { tx } = await pub.publishHvx(toPoint(row), target);
      if (tx) {
        await ctx.db.update(hvxPoints).set({ publishedTx: tx }).where(and(eq(hvxPoints.grade, row.grade), eq(hvxPoints.hour, row.hour)));
        newest.set(row.grade, row.hour.getTime());
        n++;
      }
    } catch (e) {
      log.error("hvx publish failed", { grade: row.grade, hour: row.hour.toISOString(), reason: (e as Error).name, error: (e as Error).message.slice(0, 200) });
    }
  }
  return n;
}

// ---- the job and the read model ------------------------------------------------------------------------------------

/** The hourly job: recomputes the current hour and HVX_LOOKBACK_HOURS - 1 earlier ones, then (with HVX_PUBLISH_ONCHAIN)
 *  publishes completed hours to the HvxFeed. */
export async function runHvx(ctx: Ctx, cfg: HvxConfig = loadHvxConfig(), now = Date.now()) {
  if (!cfg.enabled) return { skipped: "disabled" as const };
  const current = hourStart(now);
  const points: HvxPoint[] = [];
  for (let i = cfg.lookbackHours - 1; i >= 0; i--) points.push(...(await computeHour(ctx, cfg, new Date(current.getTime() - i * HOUR_MS))));
  const published = await publishCompleted(ctx, cfg, current);
  return { hours: cfg.lookbackHours, points: points.length, published };
}

/** Registers the job on a worker. Call before ctx.jobs.start(). */
export function registerHvxJob(ctx: Ctx, cfg: HvxConfig = loadHvxConfig()) {
  if (!cfg.enabled) return;
  ctx.jobs.register("hvx", HOUR_MS, () => runHvx(ctx, cfg), { atStart: true });
}

export type HvxView = { format: typeof HVX_FORMAT; unit: "usd_per_mtoken"; grades: readonly Grade[]; thin_below_daily_usd: number; latest: Record<Grade, HvxPoint | null>; series: HvxPoint[] };

/** The latest completed hour per grade and the last 24 hours of points, oldest first (GET /api/v1/hvx). */
export async function hvxView(ctx: Ctx, cfg: HvxConfig = loadHvxConfig(), now = Date.now()): Promise<HvxView> {
  const since = new Date(hourStart(now).getTime() - DAY_MS);
  const rows = await ctx.db.select().from(hvxPoints).where(gte(hvxPoints.hour, since)).orderBy(hvxPoints.hour, hvxPoints.grade);
  // The latest completed hour per grade: the current hour is still filling and is only in the series.
  const latestRows = await ctx.db.selectDistinctOn([hvxPoints.grade]).from(hvxPoints).where(lt(hvxPoints.hour, hourStart(now))).orderBy(hvxPoints.grade, desc(hvxPoints.hour));
  const latest = Object.fromEntries(GRADES.map((g) => [g, null])) as Record<Grade, HvxPoint | null>;
  for (const r of latestRows) latest[r.grade as Grade] = toPoint(r);
  return { format: HVX_FORMAT, unit: "usd_per_mtoken", grades: GRADES, thin_below_daily_usd: cfg.thinDailyUsd, latest, series: rows.map(toPoint) };
}
