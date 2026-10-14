import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { generations, offers, providers } from "../db/schema.ts";
import { usdToPico } from "../lib/money.ts";
import { encrypt, log } from "../lib/util.ts";
import { syncProvider } from "../services/registry.ts";
import type { SupplyModel, SupplySettings } from "./config.ts";
import { ionetAdapter } from "./ionet-adapter.ts";
import { nosanaAdapter } from "./nosana-adapter.ts";
import { supplyDeployments } from "./schema.ts";
import { endpointKey, servedModelName, type AdapterName, type SupplyAdapter, type SupplyDeployment } from "./types.ts";

// The warm pool (docs/Trellis_Backend.md §2): every SUPPLY_INTERVAL_MS it reads the last hour's demand per model from
// the generations table, decides how many replicas of each configured model to keep on which adapter under
// SUPPLY_HOURLY_BUDGET_USD, asks the adapters for them, and registers the endpoints that answer as providers through
// the registry (providers row with a static model list -> syncProvider -> offers). An endpoint the pool no longer wants
// is taken out of the registry (status suspended, offers disabled; rows are never deleted, generations reference them)
// and its deployment torn down. Off unless SUPPLY_NOSANA_ENABLED or SUPPLY_IONET_ENABLED.

const HOUR_MS = 3_600_000;
type Row = typeof supplyDeployments.$inferSelect;

// ---- demand ---------------------------------------------------------------------------------------------------------

/** Output-equivalent tokens per model served in [since, until): output and reasoning 1, input 0.25, cached input 0.05 (§5.6). */
export async function demandByModel(ctx: Pick<Ctx, "db">, since: Date, until: Date): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({
      modelId: generations.modelId,
      tokens: sql<string>`coalesce(sum(${generations.tokensOut} + ${generations.reasoningTokens} + 0.25 * (${generations.tokensIn} - least(${generations.cachedTokens}, ${generations.tokensIn})) + 0.05 * least(${generations.cachedTokens}, ${generations.tokensIn})), 0)`,
    })
    .from(generations)
    .where(and(gte(generations.ts, since), lt(generations.ts, until), eq(generations.cancelled, false), sql`${generations.finishReason} IS DISTINCT FROM 'error'`, sql`${generations.mode} <> 'cache'`))
    .groupBy(generations.modelId);
  return new Map(rows.map((r) => [r.modelId, Math.max(0, Number(r.tokens))]));
}

// ---- the plan (pure) ------------------------------------------------------------------------------------------------

export type AdapterPrice = { usdPerReplicaHour: number; available: number | null };
export type PlanTarget = { modelId: string; adapter: AdapterName | null; wanted: number; replicas: number; usdPerHour: number; demandTokens: number; reason: string | null };
export type Plan = { targets: PlanTarget[]; hourlyUsd: number; budgetUsd: number };

/**
 * Target replicas per model. A model wants ceil(demand x headroom / tokens_per_replica_hour) replicas, at least
 * min_replicas and at most max_replicas. io.net is considered only for a model whose demand reached the high-volume
 * threshold; among the adapters a model allows and that quoted a price, the cheapest per replica wins. The budget is
 * handed out one replica at a time, busiest model first, so a cap trims the tail of every model before it starves one.
 */
export function planWarmPool(input: { models: SupplyModel[]; demand: Map<string, number>; prices: Partial<Record<AdapterName, AdapterPrice>>; budgetUsd: number; headroom: number; ionetMinTokensPerHour: number }): Plan {
  const targets: PlanTarget[] = input.models.map((m) => {
    const demandTokens = input.demand.get(m.modelId) ?? 0;
    const wanted = Math.min(m.maxReplicas, Math.max(m.minReplicas, Math.ceil((demandTokens * input.headroom) / m.tokensPerReplicaHour)));
    const eligible = m.adapters
      .filter((a) => a !== "ionet" || demandTokens >= input.ionetMinTokensPerHour)
      .map((a) => ({ a, p: input.prices[a] }))
      .filter((x): x is { a: AdapterName; p: AdapterPrice } => !!x.p && x.p.usdPerReplicaHour > 0)
      .sort((x, y) => x.p.usdPerReplicaHour - y.p.usdPerReplicaHour || (x.a < y.a ? -1 : 1));
    const pick = eligible[0];
    return { modelId: m.modelId, adapter: pick?.a ?? null, wanted, replicas: 0, usdPerHour: 0, demandTokens, reason: wanted > 0 && !pick ? "no_adapter" : null };
  });
  const order = [...targets].sort((a, b) => b.demandTokens - a.demandTokens || (a.modelId < b.modelId ? -1 : 1));
  const left: Partial<Record<AdapterName, number>> = {};
  for (const a of Object.keys(input.prices) as AdapterName[]) left[a] = input.prices[a]!.available ?? Infinity;
  let spent = 0;
  for (let granted = true; granted; ) {
    granted = false;
    for (const t of order) {
      if (!t.adapter || t.replicas >= t.wanted) continue;
      const price = input.prices[t.adapter]!.usdPerReplicaHour;
      if (spent + price > input.budgetUsd + 1e-9) { t.reason ??= "budget"; continue; }
      if ((left[t.adapter] ?? 0) < 1) { t.reason ??= "no_capacity"; continue; }
      t.replicas++;
      t.usdPerHour += price;
      spent += price;
      left[t.adapter] = (left[t.adapter] ?? 0) - 1;
      granted = true;
    }
  }
  for (const t of targets) if (t.replicas >= t.wanted) t.reason = null;
  return { targets, hourlyUsd: spent, budgetUsd: input.budgetUsd };
}

// ---- adapters -------------------------------------------------------------------------------------------------------

const overrides = new WeakMap<object, SupplyAdapter[]>();
/** Replace the adapters of a router (offline fakes). */
export const setSupplyAdapters = (ctx: Pick<Ctx, "cfg">, adapters: SupplyAdapter[]) => void overrides.set(ctx.cfg, adapters);

/** The adapters this router has switched on. */
export function supplyAdapters(ctx: Pick<Ctx, "cfg">): SupplyAdapter[] {
  const fake = overrides.get(ctx.cfg);
  if (fake) return fake;
  const s: SupplySettings = ctx.cfg.supply;
  const out: SupplyAdapter[] = [];
  if (s.nosana.enabled) out.push(nosanaAdapter({ settings: s.nosana, appSecret: ctx.cfg.appSecret }));
  if (s.ionet.enabled) out.push(ionetAdapter({ settings: s.ionet, appSecret: ctx.cfg.appSecret }));
  return out;
}

// ---- registry -------------------------------------------------------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** Registry id of a deployment's i-th endpoint. Stable per adapter and model, so a new endpoint URL keeps its history. */
export const supplyProviderId = (adapter: AdapterName, modelId: string, i = 0) => `${adapter}-${slug(modelId).slice(0, 80)}${i ? `-r${i}` : ""}`;
const providerIds = (row: Pick<Row, "adapter" | "modelId">, n: number) => Array.from({ length: n }, (_, i) => supplyProviderId(row.adapter as AdapterName, row.modelId, i));

const perToken = (usdPerMtok: number) => (usdPerMtok / 1_000_000).toFixed(12).replace(/0+$/, "").replace(/\.$/, "") || "0";

/** The provider-spec entry the registry diffs into an offer for this model (src/services/registry.ts providerModelSpec). */
export function supplyStaticModel(spec: SupplyModel) {
  return {
    id: servedModelName(spec),
    name: spec.modelId,
    trellis: { slug: spec.modelId },
    hugging_face_id: spec.hfRepo,
    context_length: spec.contextLength,
    ...(spec.maxOutputTokens ? { max_completion_tokens: spec.maxOutputTokens } : {}),
    quantization: spec.quantization,
    pricing: { prompt: perToken(spec.pricePromptUsdPerMtok), completion: perToken(spec.priceCompletionUsdPerMtok) },
    supported_sampling_parameters: ["temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty"],
  };
}

const ADAPTER_LABEL: Record<AdapterName, string> = { nosana: "Nosana", ionet: "io.net" };

/**
 * Register a deployment's endpoints as providers: one providers row per endpoint with the model as its static list,
 * then the registry's own syncProvider creates the model and the offer. A new provider starts in SUPPLY_PROVIDER_STATUS
 * (shadow unless the operator chose live); one the pool had taken out returns with the status it had. `attested` is
 * never written here: an endpoint with an attestation URL is verified by the attestor like any other host.
 */
export async function registerEndpoints(ctx: Ctx, spec: SupplyModel, d: SupplyDeployment, row: Pick<Row, "listedStatus">): Promise<string[]> {
  const ids: string[] = [];
  const key = encrypt(ctx.cfg.appSecret, endpointKey(ctx.cfg.appSecret, d.adapter, spec));
  for (const [i, baseUrl] of d.endpoints.entries()) {
    const id = supplyProviderId(d.adapter, spec.modelId, i);
    const now = new Date();
    const [existing] = await ctx.db.select({ status: providers.status }).from(providers).where(eq(providers.id, id));
    const fresh = ctx.cfg.supply.providerStatus;
    const status = !existing ? fresh : existing.status === "suspended" && row.listedStatus ? row.listedStatus : existing.status;
    const values = {
      name: `${ADAPTER_LABEL[d.adapter]} · ${spec.modelId}${i ? ` #${i + 1}` : ""}`,
      baseUrl,
      apiKeyEnc: key,
      kind: "openai",
      // A rented GPU node: no training on requests and vLLM keeps none, but the node operator is not a zero-retention party.
      dataPolicy: { training: false, retains_prompts: false, zdr: false },
      staticModels: [supplyStaticModel(spec)],
      attestationUrl: d.attestation?.url ?? null,
      teeKind: d.attestation?.teeKind ?? null,
      updatedAt: now,
    };
    if (!existing) await ctx.db.insert(providers).values({ id, ...values, status, shadowUntil: status === "shadow" ? new Date(now.getTime() + ctx.cfg.canaries.shadowDays * 86_400_000) : null });
    else await ctx.db.update(providers).set({ ...values, status }).where(eq(providers.id, id));
    const [p] = await ctx.db.select().from(providers).where(eq(providers.id, id));
    // A provider an operator or the slasher suspended or delisted stays out: the pool only restores what it took out itself.
    if (p && ["shadow", "live"].includes(p.status)) {
      await syncProvider(ctx, p);
      ids.push(id);
    }
  }
  return ids;
}

/** Take providers out of the registry: suspended, offers disabled. Returns the status the first one had (to restore later). */
export async function deregisterEndpoints(ctx: Pick<Ctx, "db">, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const before = await ctx.db.select({ id: providers.id, status: providers.status }).from(providers).where(and(inArray(providers.id, ids), inArray(providers.status, ["shadow", "live"])));
  if (!before.length) return null;
  const now = new Date();
  await ctx.db.update(providers).set({ status: "suspended", updatedAt: now }).where(inArray(providers.id, before.map((p) => p.id)));
  await ctx.db.update(offers).set({ status: "disabled", updatedAt: now }).where(inArray(offers.providerId, before.map((p) => p.id)));
  return before.find((p) => p.id === ids[0])?.status ?? before[0].status;
}

// ---- the job --------------------------------------------------------------------------------------------------------

export type WarmPoolResult = { skipped?: string; plan?: Plan; ensured: number; registered: number; deregistered: number; torn_down: number; failed: number };

export async function runWarmPool(ctx: Ctx, now = Date.now()): Promise<WarmPoolResult> {
  const none = { ensured: 0, registered: 0, deregistered: 0, torn_down: 0, failed: 0 };
  const settings = ctx.cfg.supply;
  const adapters = supplyAdapters(ctx);
  if (!adapters.length) return { ...none, skipped: "disabled" };
  if (!settings.models.length) return { ...none, skipped: "no SUPPLY_MODELS" };
  const byName = new Map(adapters.map((a) => [a.name, a]));
  const demand = await demandByModel(ctx, new Date(now - HOUR_MS), new Date(now));

  // One replica-hour on each adapter: its price, and how many replicas it could start.
  const prices: Partial<Record<AdapterName, AdapterPrice>> = {};
  for (const a of adapters) {
    try {
      const offer = (await a.listCapacity())[0];
      if (offer?.usdPerReplicaHour) prices[a.name] = { usdPerReplicaHour: offer.usdPerReplicaHour, available: offer.available };
    } catch (e) {
      log.warn("supply adapter unavailable", { adapter: a.name, reason: (e as Error).message.slice(0, 120) });
    }
  }
  const rows = new Map((await ctx.db.select().from(supplyDeployments)).map((r) => [r.id, r]));
  // Capacity the pool already holds stays plannable even when the network reports nothing further to rent.
  for (const r of rows.values()) {
    const p = prices[r.adapter as AdapterName];
    if (p && p.available != null && ["starting", "running"].includes(r.status)) p.available += r.replicas;
  }
  const plan = planWarmPool({ models: settings.models, demand, prices, budgetUsd: settings.budgetUsdPerHour, headroom: settings.headroom, ionetMinTokensPerHour: settings.ionet.minTokensPerHour });
  const out: WarmPoolResult = { ...none, plan };
  const wanted = new Set<string>();

  for (const t of plan.targets) {
    if (!t.adapter || t.replicas < 1) continue;
    const spec = settings.models.find((m) => m.modelId === t.modelId)!;
    const adapter = byName.get(t.adapter)!;
    const id = `${t.adapter}:${t.modelId}`;
    wanted.add(id);
    const row = rows.get(id);
    const base = { adapter: t.adapter, modelId: t.modelId, digest: `sha256:${spec.weightsSha256}`, providerId: supplyProviderId(t.adapter, t.modelId), replicas: t.replicas, hourlyCost: usdToPico(t.usdPerHour.toFixed(6)), demandTokens: BigInt(Math.round(t.demandTokens)), updatedAt: new Date(now) };
    try {
      // Weights that changed since the deployment started mean a different deployment: the old one is not reused.
      const reuse = row?.externalId && row.digest === base.digest && row.status !== "stopped" ? { externalId: row.externalId } : null;
      const d = await adapter.ensureWarm(spec, t.replicas, reuse);
      out.ensured++;
      const healthy = d.status === "running" && d.endpoints.length > 0 && (await adapter.health(spec, d)).ok;
      const listed = healthy ? await registerEndpoints(ctx, spec, d, { listedStatus: row?.listedStatus ?? null }) : [];
      // Endpoints that went away (fewer replicas, or the deployment is not answering) leave the registry.
      const stale = providerIds(base, Math.max(row?.listedCount ?? 0, listed.length)).filter((p) => !listed.includes(p));
      const taken = await deregisterEndpoints(ctx, stale);
      out.registered += listed.length;
      if (taken) out.deregistered += stale.length;
      const values = { ...base, externalId: d.externalId, status: d.status, lane: d.lane, listedCount: listed.length, listedStatus: listed.length ? null : (taken ?? row?.listedStatus ?? null), fault: d.status === "running" && !healthy ? "unhealthy" : null, startedAt: row?.startedAt && reuse ? row.startedAt : new Date(now), stoppedAt: null };
      await ctx.db.insert(supplyDeployments).values({ id, ...values }).onConflictDoUpdate({ target: supplyDeployments.id, set: values });
    } catch (e) {
      out.failed++;
      log.warn("supply ensure failed", { adapter: t.adapter, model: t.modelId, reason: (e as Error).message.slice(0, 120) });
      const values = { ...base, status: row?.status ?? "failed", fault: "ensure_failed" };
      await ctx.db.insert(supplyDeployments).values({ id, ...values, status: "failed" }).onConflictDoUpdate({ target: supplyDeployments.id, set: values });
    }
  }

  // Deployments the plan no longer contains: out of the registry first, then torn down. Young ones are left to settle.
  for (const row of rows.values()) {
    if (wanted.has(row.id) || row.status === "stopped") continue;
    if (row.startedAt && now - row.startedAt.getTime() < settings.scaleDownAfterMs) continue;
    const adapter = byName.get(row.adapter as AdapterName);
    const taken = await deregisterEndpoints(ctx, providerIds(row, Math.max(1, row.listedCount)));
    if (taken) out.deregistered += row.listedCount;
    try {
      if (row.externalId && adapter) await adapter.tearDown(row.externalId);
      else if (row.externalId) throw new Error("adapter is switched off");
      out.torn_down++;
      await ctx.db.update(supplyDeployments).set({ status: "stopped", replicas: 0, listedCount: 0, listedStatus: taken ?? row.listedStatus, hourlyCost: 0n, fault: null, stoppedAt: new Date(now), updatedAt: new Date(now) }).where(eq(supplyDeployments.id, row.id));
    } catch (e) {
      out.failed++;
      log.warn("supply teardown failed", { adapter: row.adapter, model: row.modelId, reason: (e as Error).message.slice(0, 120) });
      await ctx.db.update(supplyDeployments).set({ listedCount: 0, listedStatus: taken ?? row.listedStatus, fault: "teardown_failed", updatedAt: new Date(now) }).where(eq(supplyDeployments.id, row.id));
    }
  }
  if (out.registered || out.deregistered) await ctx.catalog.refresh();
  return out;
}

/** Registers the job. Nothing is registered while both adapters are off. */
export function registerWarmPoolJob(ctx: Ctx) {
  const s = ctx.cfg.supply;
  if (!s.nosana.enabled && !s.ionet.enabled) return;
  ctx.jobs.register("supply-warm-pool", s.intervalMs, () => runWarmPool(ctx));
}

/** What GET /api/v1/admin/supply shows: the pool's rows, never a key or an endpoint. */
export async function supplyStatus(ctx: Ctx) {
  const rows = await ctx.db.select().from(supplyDeployments).orderBy(supplyDeployments.id);
  const s = ctx.cfg.supply;
  return {
    adapters: { nosana: s.nosana.enabled, ionet: s.ionet.enabled },
    budget_usd_per_hour: s.budgetUsdPerHour,
    committed_usd_per_hour: Number((Number(rows.filter((r) => ["starting", "running"].includes(r.status)).reduce((a, r) => a + r.hourlyCost, 0n)) / 1e12).toFixed(6)),
    models: s.models.map((m) => ({ model: m.modelId, hf_repo: m.hfRepo, revision: m.revision, weights_sha256: m.weightsSha256, image: m.image, adapters: m.adapters, min_replicas: m.minReplicas, max_replicas: m.maxReplicas })),
    deployments: rows.map((r) => ({ id: r.id, adapter: r.adapter, model: r.modelId, digest: r.digest, provider: r.providerId, replicas: r.replicas, listed: r.listedCount, status: r.status, lane: r.lane, usd_per_hour: Number((Number(r.hourlyCost) / 1e12).toFixed(6)), demand_tokens_last_hour: r.demandTokens.toString(), fault: r.fault, started_at: r.startedAt?.toISOString() ?? null, stopped_at: r.stoppedAt?.toISOString() ?? null })),
  };
}
