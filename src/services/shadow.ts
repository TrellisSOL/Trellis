import { and, eq, isNull } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Candidate } from "../catalog/catalog.ts";
import { generations, measurements } from "../db/schema.ts";
import { shadowEvidence, shadowRuns, slashEvidence } from "./evidence-schema.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { estimatePromptTokens, maxItemLimits, maxOutputTokens } from "../router/pricing.ts";
import { hash256, type Hex } from "../lib/hash.ts";
import { tokenCost } from "../lib/money.ts";
import { canonicalJson, decrypt, encrypt, log, sha256, uid } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { loadShadowConfig, type ShadowConfig } from "./shadow-config.ts";

// Shadow re-execution (docs/Trellis_Backend.md §3, "Verifiable inference"): a configurable 1–2% sample of SEALED-lane
// (lane "attested") generations is re-issued, unchanged, to a different attested host that serves the same model
// digest. The sealed host generates seeded and batch-invariant (VLLM_BATCH_INVARIANT=1), so the same request, digest
// and seed must give the same bytes: the receipt's response hash of the caller's answer is compared with the hash of
// the shadow answer, and a difference is slash evidence under §5.3 ("Shadow re-execution mismatch": 50% + ejection).
//
// No prompt is stored anywhere (§10). The request bytes exist only in memory at request time, so the hook below
// (noteSealedGeneration) is called from the call finaliser with the body it already holds, seals the bytes under
// APP_SECRET and the generation id, and parks them in Redis (or the router's memory without Redis) for a few minutes
// at most. The shadow job takes them out exactly once, zeroes its copy after the call, and records hashes only.
//
// Wiring (owned by src/api/chat.ts): after `await ctx.db.insert(generations).values({...})` in finalize(), add
//   void noteSealedGeneration(ctx, { generationId: id, lane: p.disc.lane, modelId: r.model.id, providerId: r.candidate.providerId, body: p.body, requestSha256: p.bodySha, responseSha256: payload.response_sha256 });
// The call never throws and never awaits the upstream; the caller's response is not delayed and never billed for it.
// Shadow calls are paid from treasury: `shadow_runs.cost` records what each one cost.

export const SHADOW_REASON = "shadow_mismatch";
const SEALED_LANES = new Set(["attested"]);

export type ShadowSample = {
  generationId: string;
  lane: string;
  modelId: string;
  providerId: string;
  /** The request as it went upstream (in memory only). */
  body: Record<string, unknown>;
  path?: "/chat/completions" | "/completions";
  requestSha256: string;
  /** The receipt's response_sha256: sha256 of the answer text the caller received. */
  responseSha256: string;
};

// ---- the queue ---------------------------------------------------------------------------------------------------

/** Where the sealed request bytes wait between the request and the shadow job. Entries expire on their own. */
export interface ShadowStore {
  put(id: string, sealed: string, ttlMs: number): Promise<void>;
  /** Returns the sealed bytes once and removes them; null when they expired or were already taken. */
  take(id: string): Promise<string | null>;
  push(id: string): Promise<void>;
  pop(max: number): Promise<string[]>;
  close(): Promise<void>;
}

export class MemoryShadowStore implements ShadowStore {
  private entries = new Map<string, { buf: Buffer; expires: number }>();
  private queue: string[] = [];
  async put(id: string, sealed: string, ttlMs: number) {
    this.sweep();
    this.entries.set(id, { buf: Buffer.from(sealed, "utf8"), expires: Date.now() + ttlMs });
  }
  async take(id: string) {
    this.sweep();
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    const out = e.buf.toString("utf8");
    e.buf.fill(0); // zero the parked copy; the caller zeroes its own after use
    return out;
  }
  async push(id: string) {
    this.queue.push(id);
  }
  async pop(max: number) {
    return this.queue.splice(0, max);
  }
  async close() {
    for (const e of this.entries.values()) e.buf.fill(0);
    this.entries.clear();
    this.queue = [];
  }
  private sweep() {
    const now = Date.now();
    for (const [id, e] of this.entries)
      if (e.expires <= now) {
        e.buf.fill(0);
        this.entries.delete(id);
      }
  }
  get size() {
    return this.entries.size;
  }
}

type RedisLike = { set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<unknown>; getdel(key: string): Promise<string | null>; rpush(key: string, value: string): Promise<unknown>; lpop(key: string, count: number): Promise<string[] | null>; quit(): Promise<unknown> };

/** Redis-backed queue: shadow:req:<generation id> holds the sealed bytes with a TTL; shadow:queue lists the ids. */
export class RedisShadowStore implements ShadowStore {
  constructor(private redis: RedisLike, private owned = false) {}
  async put(id: string, sealed: string, ttlMs: number) {
    await this.redis.set(`shadow:req:${id}`, sealed, "PX", ttlMs, "NX");
  }
  async take(id: string) {
    // GETDEL: read and delete in one step, so a second worker never re-executes the same generation.
    return this.redis.getdel(`shadow:req:${id}`);
  }
  async push(id: string) {
    await this.redis.rpush("shadow:queue", id);
  }
  async pop(max: number) {
    return (await this.redis.lpop("shadow:queue", max)) ?? [];
  }
  async close() {
    if (this.owned) await this.redis.quit().catch(() => undefined);
  }
}

const stores = new WeakMap<Ctx, Promise<ShadowStore>>();

/** The queue of this router: Redis when REDIS_URL is set (shared by the api and worker roles), memory otherwise. */
export function shadowStore(ctx: Ctx): Promise<ShadowStore> {
  let p = stores.get(ctx);
  if (!p) {
    p = (async () => {
      if (!ctx.cfg.redisUrl) return new MemoryShadowStore();
      const { Redis } = await import("ioredis");
      return new RedisShadowStore(new Redis(ctx.cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) as unknown as RedisLike, true);
    })();
    stores.set(ctx, p);
  }
  return p;
}

/** Tests and embedders: use this store for `ctx` instead of the default. */
export function setShadowStore(ctx: Ctx, store: ShadowStore) {
  stores.set(ctx, Promise.resolve(store));
}

// ---- request time --------------------------------------------------------------------------------------------------

/** Whether one SEALED-lane generation is sampled: a coin at the configured rate; other lanes are never sampled. */
export function shouldShadow(cfg: ShadowConfig, lane: string, rand: () => number = Math.random) {
  if (!cfg.enabled || !SEALED_LANES.has(lane) || cfg.sampleRate <= 0) return false;
  return rand() < cfg.sampleRate;
}

const sealKey = (ctx: Ctx, generationId: string) => `${ctx.cfg.appSecret}:shadow:${generationId}`;

/**
 * Fire-and-forget hook for the call finaliser. Seals the in-memory request and parks it for the shadow job. Resolves
 * true when the generation was sampled. Never throws: a queue failure is logged (without the request) and the
 * caller's response is unaffected.
 */
export async function noteSealedGeneration(ctx: Ctx, sample: ShadowSample, cfg: ShadowConfig = loadShadowConfig()): Promise<boolean> {
  try {
    if (ctx.surface?.core) return false; // shadow re-execution is not on the core launch surface: nothing is parked
    if (!shouldShadow(cfg, sample.lane, ctx.rand ?? Math.random)) return false;
    const store = await shadowStore(ctx);
    const parked = { path: sample.path ?? "/chat/completions", modelId: sample.modelId, providerId: sample.providerId, requestSha256: sample.requestSha256, responseSha256: sample.responseSha256, body: sample.body };
    await store.put(sample.generationId, encrypt(sealKey(ctx, sample.generationId), JSON.stringify(parked)), cfg.requestTtlMs);
    await store.push(sample.generationId);
    return true;
  } catch (e) {
    log.warn("shadow enqueue failed", { generation: sample.generationId, reason: (e as Error).name });
    return false;
  }
}

// ---- the job -------------------------------------------------------------------------------------------------------

type Parked = { path: "/chat/completions" | "/completions"; modelId: string; providerId: string; requestSha256: string; responseSha256: string; body: Record<string, unknown> };

/** Current model digest per provider (measurements with a verified quote), used to pair hosts that serve the same bytes. */
async function currentDigests(ctx: Ctx) {
  const rows = await ctx.db.select({ providerId: measurements.providerId, digest: measurements.modelDigest }).from(measurements).where(and(isNull(measurements.supersededAt), isNull(measurements.revokedAt)));
  return new Map(rows.map((r) => [r.providerId, r.digest]));
}

/** The attested hosts, other than `hostA`, that serve `modelId` under the same digest and are not in an outage. */
export async function shadowPeers(ctx: Ctx, modelId: string, hostA: string): Promise<{ digest: string; peers: Candidate[] }> {
  await ctx.catalog.ensureFresh();
  const digests = await currentDigests(ctx);
  const digestOf = (providerId: string) => digests.get(providerId) ?? `model:${modelId}`;
  const digest = digestOf(hostA);
  const peers = ctx.catalog
    .offers(modelId)
    .filter((c) => c.providerId !== hostA && c.status === "live" && c.provider.status === "live" && c.provider.attested && !!c.provider.teeKind)
    .filter((c) => digestOf(c.providerId) === digest && !ctx.health.outage(modelId, c.providerId));
  return { digest, peers };
}

const answerText = (json: any): string => (json?.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : (ch?.text ?? ""))).join("");

export function evidenceRootOf(items: unknown[]): Hex {
  const leaves = (items.length ? items : [{ empty: true }]).map((i) => hash256(hash256(canonicalJson(i))));
  return new MerkleTree(leaves).root;
}

async function executeOne(ctx: Ctx, cfg: ShadowConfig, generationId: string, store: ShadowStore) {
  const sealed = await store.take(generationId);
  if (!sealed) {
    const [gen] = await ctx.db.select({ modelId: generations.modelId, providerId: generations.providerId }).from(generations).where(eq(generations.id, generationId));
    await ctx.db.insert(shadowRuns).values({ id: uid("shadow_"), generationId, modelId: gen?.modelId ?? "", digest: "", hostA: gen?.providerId ?? "", status: "expired" }).onConflictDoNothing();
    return "expired" as const;
  }
  let parked: Parked | null = null;
  try {
    const plain = decrypt(sealKey(ctx, generationId), sealed);
    parked = JSON.parse(plain) as Parked;
  } catch {
    parked = null;
  }
  if (!parked) {
    await ctx.db.insert(shadowRuns).values({ id: uid("shadow_"), generationId, modelId: "", digest: "", hostA: "", status: "failed" }).onConflictDoNothing();
    return "failed" as const;
  }
  const [gen] = await ctx.db.select({ id: generations.id, modelId: generations.modelId, providerId: generations.providerId, responseSha256: generations.responseSha256 }).from(generations).where(eq(generations.id, generationId));
  const hostA = gen?.providerId ?? parked.providerId;
  const modelId = gen?.modelId ?? parked.modelId;
  const hashA = gen?.responseSha256 ?? parked.responseSha256;
  const seed = typeof parked.body.seed === "number" && Number.isInteger(parked.body.seed) ? parked.body.seed : null;
  const { digest, peers } = await shadowPeers(ctx, modelId, hostA);
  const runId = uid("shadow_");
  if (!peers.length) {
    parked = null;
    await ctx.db.insert(shadowRuns).values({ id: runId, generationId, modelId, digest, seed, hostA, status: "no_peer", hashA }).onConflictDoNothing();
    return "no_peer" as const;
  }
  const peer = peers[Math.floor((ctx.rand ?? Math.random)() * peers.length) % peers.length];
  const requestSha256 = parked.requestSha256;
  // The identical request (same seed when the caller set one), as a single JSON answer so the whole text is hashed.
  // Identical includes the output cap: host A was sent an explicit limit (security review R3-02: the smallest of the
  // caller's own, host A's catalog limit and the context room after the prompt bound), so the peer is sent that same
  // limit. This call is paid by the operator, and a request with no cap of its own must not run unbounded here either.
  const model = ctx.catalog.models.get(modelId);
  const offers = ctx.catalog.offers(modelId);
  const bound = estimatePromptTokens(parked.body, { items: maxItemLimits(offers), settings: ctx.cfg.holds.bound, lenient: true });
  const cap = model ? maxOutputTokens(parked.body, offers.find((o) => o.providerId === hostA) ?? peer, model, bound, ctx.cfg.holds) : undefined;
  const body = upstreamBody(peer, { ...parked.body, model: peer.modelId, stream: false }, false, cap).body;
  delete (body as Record<string, unknown>).stream_options;
  const r = await callUpstream({
    health: ctx.health,
    appSecret: ctx.cfg.appSecret,
    candidate: peer,
    path: parked.path,
    body,
    stream: false,
    apiKey: providerKey(peer, ctx.cfg.appSecret),
    signal: AbortSignal.timeout(cfg.timeoutMs),
    timeoutMs: cfg.timeoutMs,
    firstTokenTimeoutMs: cfg.timeoutMs,
    production: ctx.cfg.production,
  });
  // Drop the parked copy as soon as the call is out; only hashes live past this point.
  for (const k of Object.keys(parked.body)) delete parked.body[k];
  parked = null;
  ctx.health.record({ modelId, providerId: peer.providerId, ok: r.ok, errorKind: r.ok ? null : r.errorKind, latencyMs: r.latencyMs, source: "probe" });
  if (!r.ok || r.kind !== "json") {
    await ctx.db.insert(shadowRuns).values({ id: runId, generationId, modelId, digest, seed, hostA, hostB: peer.providerId, status: "failed", hashA, latencyMs: Math.round(r.latencyMs) }).onConflictDoNothing();
    return "failed" as const;
  }
  const json = r.json;
  const hashB = sha256(answerText(json));
  const usage = json?.usage ?? {};
  const tokensIn = Number(usage.prompt_tokens ?? 0) || 0;
  const tokensOut = Number(usage.completion_tokens ?? 0) || 0;
  const cost = tokenCost(tokensIn, peer.pricePrompt) + tokenCost(tokensOut, peer.priceCompletion) + peer.priceRequest;
  const matched = hashA === hashB;
  await ctx.db.insert(shadowRuns).values({ id: runId, generationId, modelId, digest, seed, hostA, hostB: peer.providerId, status: matched ? "match" : "mismatch", hashA, hashB, cost, latencyMs: Math.round(r.latencyMs) }).onConflictDoNothing();
  if (matched) return "match" as const;
  const createdAt = new Date();
  await ctx.db.insert(shadowEvidence).values({ id: uid("shev_"), generationId, hostA, hostB: peer.providerId, digest, seed, hashA, hashB, createdAt }).onConflictDoNothing();
  // Hand-off to the slasher: one §5.3 row per mismatch. Which of the two hosts lied is for the dispute window; the row
  // names the serving host (host_a) as the §3 text does, and carries both hashes so the other host can be checked too.
  const item = { generation_id: generationId, host_a: hostA, host_b: peer.providerId, digest, seed, hash_a: hashA, hash_b: hashB, request_sha256: requestSha256 };
  await ctx.db
    .insert(slashEvidence)
    .values({ id: uid("slev_"), providerId: hostA, modelId, reason: SHADOW_REASON, bps: cfg.slashBps, delist: true, evidenceRoot: evidenceRootOf([item]), evidence: { items: [item], window: { from: createdAt.toISOString(), to: createdAt.toISOString() } }, windowFrom: createdAt, windowTo: createdAt })
    .onConflictDoNothing();
  log.warn("shadow re-execution mismatch", { generation: generationId, host_a: hostA, host_b: peer.providerId });
  return "mismatch" as const;
}

export type ShadowRunResult = { executed: number; match: number; mismatch: number; no_peer: number; failed: number; expired: number };

/** The shadow job: drains the queue (SHADOW_BATCH entries per run) and re-executes each sampled generation once. */
export async function runShadow(ctx: Ctx, cfg: ShadowConfig = loadShadowConfig()): Promise<ShadowRunResult> {
  const out: ShadowRunResult = { executed: 0, match: 0, mismatch: 0, no_peer: 0, failed: 0, expired: 0 };
  if (!cfg.enabled) return out;
  const store = await shadowStore(ctx);
  const ids = await store.pop(cfg.batch);
  for (const id of ids) {
    try {
      const status = await executeOne(ctx, cfg, id, store);
      out.executed++;
      out[status]++;
    } catch (e) {
      out.failed++;
      log.error("shadow re-execution failed", { generation: id, reason: (e as Error).name });
    }
  }
  return out;
}

/** Registers the job on a worker. Call before ctx.jobs.start(). */
export function registerShadowJob(ctx: Ctx, cfg: ShadowConfig = loadShadowConfig()) {
  if (!cfg.enabled) return;
  ctx.jobs.register("shadow", cfg.intervalMs, () => runShadow(ctx, cfg));
}
