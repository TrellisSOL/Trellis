import { eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations, kv, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, picoToUsdString, usdToPico, type Pico } from "../lib/money.ts";
import { decrypt, genId, log, sha256 } from "../lib/util.ts";
import { release, reserve, settle } from "../ledger/ledger.ts";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { NOT_ENABLED } from "../surface/surface.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";

// Images and video (update 6, `media` in src/features.json): generation through the upstream that carries a media
// catalogue, paid from the caller's prepaid balance, with a signed receipt for every finished generation.
//
//   GET  /api/v1/media/models?type=image|video    the catalogue: ids, what each model accepts, its price range
//   POST /api/v1/images/generations               one to four images; answers when they are ready
//   GET  /api/v1/images/generations/:id           the same result again, or the state of one the caller stopped waiting for
//   POST /api/v1/videos/generations               starts a job (202); a video takes minutes
//   GET  /api/v1/videos/generations/:id           the job: pending, completed with its file, or failed
//   GET  /api/v1/media/files/:id/:n               the bytes of a finished file, for 24 hours
//
// Money. A media model is priced per generation, and the catalogue gives its highest price. That figure (times the
// number of images) is held on the caller's balance before the upstream is asked; the upstream reports what the
// generation cost, and that is what is charged, never more than the hold. A request the upstream refuses is charged
// nothing and its hold is released. A generation that was accepted and whose result is not known yet (a video in
// progress, an image whose connection ran out) stays a pending job with its hold in place: the result is fetched by
// the caller's next read or by the `media-jobs` job, so a caller who walks away is still charged for what was made.
// A job with no result after MEDIA_JOB_MAX_AGE_MS is given up: its hold is released and the event is logged as an
// error, because the upstream may still bill it.
//
// Files. The upstream hands out signed addresses on its own host. They never reach the caller: the router keeps them
// with the job and serves the bytes itself under the generation's id, which is the capability (80 random bits).
//
// Per-call (x402) payment is not offered here: a generation's price is known only when it has finished.

type Kind = "image" | "video";
type MediaFile = { url: string; content_type: string };
type Job = {
  id: string; kind: Kind; status: "pending" | "completed" | "failed";
  accountId: string; keyHash: string; payer: string | null;
  model: string; count: number; upstreamId: string | null;
  holdPico: string; chargedPico: string | null; requestSha256: string;
  files: MediaFile[]; reason: string | null; createdAt: string; finishedAt: string | null;
  receipt: { id: string; sig: string; key_id: string; alg: "Ed25519"; payload: Record<string, unknown> } | null;
};
type CatalogueModel = { id: string; name: string; type: Kind; category: string | null; capabilities: Record<string, unknown>; pricing: { currency: "USD"; min: number | null; max: number; variants: unknown } };

export const MEDIA_JOB = "media-jobs";
export const MEDIA_FILE_TTL_MS = 24 * 3_600_000;
export const MEDIA_JOB_MAX_AGE_MS = 6 * 3_600_000;
const CATALOGUE_TTL_MS = 5 * 60_000;
const IMAGE_TIMEOUT_MS = 240_000;
const MAX_IMAGES = 4;
/** No single generation is held above this (USD), whatever a catalogue says. */
const MAX_PRICE_USD = 25;
/** Request fields passed on to the upstream, by endpoint. Everything else is dropped. */
const FIELDS: Record<Kind, readonly string[]> = {
  image: ["prompt", "size", "aspect_ratio", "resolution", "quality", "negative_prompt", "output_format", "image_url"],
  video: ["prompt", "aspect_ratio", "duration", "resolution", "quality", "image_url"],
};
const jobKey = (id: string) => `media-job:${id}`;
const ID = /^gen-\d+-[A-Za-z0-9_-]{8,40}$/;

export const mediaEnabled = (ctx: Ctx) => ctx.cfg.updates.media === true;

async function upstream(ctx: Ctx) {
  const [p] = await ctx.db.select().from(providers).where(eq(providers.id, ctx.cfg.media.providerId));
  if (!p || p.status !== "live" || !p.apiKeyEnc) fail(503, "Media generation has no provider on this router.", "media_unavailable");
  const base = p!.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${decrypt(ctx.cfg.appSecret, p!.apiKeyEnc!)}`, accept: "application/json" };
  const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production };
  const call = (path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) =>
    providerFetch(base + path, { method: init.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 30_000), headers: { ...headers, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, policy);
  return { id: p!.id, origin: new URL(base).origin, call, fetchFile: (url: string) => providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000), headers: { authorization: headers.authorization } }, policy) };
}
type Upstream = Awaited<ReturnType<typeof upstream>>;

// ---- Catalogue --------------------------------------------------------------------------------------------------------
const catalogues = new WeakMap<Ctx, Map<Kind, { at: number; models: CatalogueModel[] }>>();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** A media model as this router lists it: only models with a usable highest price, which is what a hold needs. */
export function parseMediaCatalogue(json: unknown, kind: Kind): CatalogueModel[] {
  const rows = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: unknown[] }).data) : [];
  const out: CatalogueModel[] = [];
  for (const row of rows) {
    const m = row as Record<string, unknown>;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const max = num(pricing.max_price) ?? num(pricing.base_price);
    if (typeof m.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(m.id) || m.type !== kind || pricing.currency !== "USD" || max === null || max <= 0 || max > MAX_PRICE_USD) continue;
    out.push({ id: m.id, name: typeof m.name === "string" ? m.name.slice(0, 120) : m.id, type: kind, category: typeof m.category === "string" ? m.category : null, capabilities: (m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {}) as Record<string, unknown>, pricing: { currency: "USD", min: num(pricing.min_price), max, variants: pricing.variants ?? null } });
  }
  return out;
}

async function catalogue(ctx: Ctx, kind: Kind): Promise<CatalogueModel[]> {
  const cache = catalogues.get(ctx) ?? catalogues.set(ctx, new Map()).get(ctx)!;
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.models;
  const up = await upstream(ctx);
  const res = await up.call(`/models?type=${kind}`);
  if (!res.ok) { await res.body?.cancel(); if (hit) return hit.models; fail(502, "The media catalogue could not be read.", "media_unavailable"); }
  const models = parseMediaCatalogue(await boundedJson(res, 4 * 1024 * 1024), kind);
  cache.set(kind, { at: Date.now(), models });
  return models;
}

// ---- Jobs -------------------------------------------------------------------------------------------------------------
const loadJob = async (ctx: Ctx, id: string): Promise<Job | null> => (ID.test(id) ? (((await ctx.db.select().from(kv).where(eq(kv.key, jobKey(id))))[0]?.value as Job | undefined) ?? null) : null);
const saveJob = (ctx: Ctx, job: Job) => ctx.db.insert(kv).values({ key: jobKey(job.id), value: job }).onConflictDoUpdate({ target: kv.key, set: { value: job, updatedAt: new Date() } });

/** Only files on the upstream's own origin are kept: a result that points anywhere else is not served. */
function filesOf(up: Upstream, data: unknown): MediaFile[] {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const out: MediaFile[] = [];
  for (const item of list) {
    const f = item as { url?: unknown; content_type?: unknown };
    if (typeof f.url !== "string") continue;
    let u: URL;
    try { u = new URL(f.url); } catch { continue; }
    if (u.origin !== up.origin) continue;
    out.push({ url: u.href, content_type: typeof f.content_type === "string" && /^(image|video)\/[a-z0-9.+-]{1,40}$/i.test(f.content_type) ? f.content_type.toLowerCase() : "application/octet-stream" });
  }
  return out;
}

/** A finished generation: charge what it cost (never above the hold), sign the receipt, record it. Idempotent per job. */
async function complete(ctx: Ctx, up: Upstream, job: Job, result: { files: MediaFile[]; costUsd: unknown; latencyMs: number }): Promise<Job> {
  if (job.status !== "pending") return job;
  const hold = BigInt(job.holdPico);
  // The upstream's own figure. One it does not report, or cannot be read, is charged at the hold: the most this
  // generation can have cost by the catalogue it was ordered from.
  const reported = num(result.costUsd);
  const priced: Pico = reported === null ? hold : usdToPico(reported.toFixed(6));
  const settled = await settle(ctx.db, job.id, priced, { description: `${job.model} ${job.kind} via ${up.id}`, generationId: job.id });
  const charged = settled.charged;
  if (settled.uncovered > 0n) log.error("media: the upstream reported a cost above the hold; the caller is charged the hold", { generation: job.id, model: job.model, reported: picoToUsdString(priced), charged: picoToUsdString(charged) });
  const payload = {
    v: 1, id: job.id, issued: new Date().toISOString(), router: ctx.cfg.publicUrl, model: job.model, provider: up.id,
    media: { kind: job.kind, count: result.files.length, cost_reported: reported !== null },
    tokens: { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false },
    cost: picoToUsdString(charged), cost_details: { upstream: picoToUsdString(charged), royalty: picoToUsdString(0n), margin: picoToUsdString(0n) },
    paid_with: null, latency_ms: Math.round(result.latencyMs), mode: "prepaid", lane: "public", payer: job.payer, payment_tx: null,
    request_sha256: job.requestSha256, response_sha256: sha256(JSON.stringify(result.files.map((f) => [sha256(f.url), f.content_type]))),
  };
  const signed = ctx.signer.sign(payload);
  await ctx.db.insert(generations).values({ id: job.id, keyHash: job.keyHash, accountId: job.accountId, modelId: job.model, providerId: up.id, cost: charged, upstreamCost: charged, mode: "prepaid", latencyMs: Math.round(result.latencyMs), generationTimeMs: Date.now() - Date.parse(job.createdAt), finishReason: "stop", receiptId: job.id, receiptSig: signed.sig, receiptKeyId: signed.keyId, receipt: payload, receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes), requestSha256: payload.request_sha256, responseSha256: payload.response_sha256 }).onConflictDoNothing();
  const done: Job = { ...job, status: "completed", files: result.files, chargedPico: charged.toString(), finishedAt: new Date().toISOString(), receipt: { id: job.id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload } };
  await saveJob(ctx, done);
  return done;
}

async function failJob(ctx: Ctx, job: Job, reason: string): Promise<Job> {
  if (job.status !== "pending") return job;
  await release(ctx.db, job.id);
  const failed: Job = { ...job, status: "failed", reason: reason.slice(0, 200), finishedAt: new Date().toISOString() };
  await saveJob(ctx, failed);
  return failed;
}

/** Ask the upstream where a pending job stands, and finish it if it has an answer. */
async function advance(ctx: Ctx, job: Job): Promise<Job> {
  if (job.status !== "pending") return job;
  const age = Date.now() - Date.parse(job.createdAt);
  const up = await upstream(ctx);
  // An image is found again by the idempotency key it was ordered with (this router's id for it); a video by its job id.
  const res = await up.call(job.kind === "video" ? `/videos/${encodeURIComponent(job.upstreamId ?? "")}` : `/images/generations/by-key/${encodeURIComponent(job.id)}`).catch(() => null);
  if (res?.status === 200) {
    const json = (await boundedJson(res).catch(() => null)) as { status?: unknown; data?: unknown; cost?: unknown; error?: unknown } | null;
    const files = filesOf(up, json?.data);
    if (json && (json.status === undefined || json.status === "completed") && files.length) return complete(ctx, up, job, { files, costUsd: json.cost, latencyMs: age });
    if (json?.status === "failed") return failJob(ctx, job, "The generation failed. Nothing was charged.");
  } else await res?.body?.cancel();
  if (res && job.kind === "image" && res.status === 404 && age > IMAGE_TIMEOUT_MS + 60_000) return failJob(ctx, job, "The generation was not found after its time limit. Nothing was charged.");
  if (age > MEDIA_JOB_MAX_AGE_MS) {
    log.error("media: a job had no result after the maximum age and was given up; its hold is released, and the upstream may still bill it", { generation: job.id, kind: job.kind, model: job.model, hold: picoToUsdString(BigInt(job.holdPico)) });
    return failJob(ctx, job, "The generation did not finish in time. Nothing was charged.");
  }
  return job;
}

/** The `media-jobs` job: every pending generation is followed to its end, whether or not its caller comes back for it. */
export async function runMediaJobs(ctx: Ctx, limit = 25) {
  if (!mediaEnabled(ctx)) return { skipped: "media is off" };
  const rows = await ctx.db.select({ value: kv.value }).from(kv).where(sql`${kv.key} like 'media-job:%' and ${kv.value}->>'status' = 'pending'`).limit(limit);
  let completed = 0, failed = 0;
  for (const row of rows) {
    const after = await advance(ctx, row.value as Job).catch((e) => { log.warn("media: a pending job could not be followed", { error: (e as Error).message.slice(0, 160) }); return null; });
    if (after?.status === "completed") completed++; else if (after?.status === "failed") failed++;
  }
  return { pending: rows.length - completed - failed, completed, failed };
}

const fileUrl = (ctx: Ctx, id: string, n: number) => `${ctx.cfg.publicUrl.replace(/\/$/, "")}/api/v1/media/files/${id}/${n}`;
const view = (ctx: Ctx, job: Job) => ({
  id: job.id, object: `${job.kind}.generation`, status: job.status, model: job.model, created: Math.floor(Date.parse(job.createdAt) / 1000),
  ...(job.status === "completed" ? { data: job.files.map((f, n) => ({ url: fileUrl(ctx, job.id, n), content_type: f.content_type })), expires_at: new Date(Date.parse(job.finishedAt!) + MEDIA_FILE_TTL_MS).toISOString(), usage: { cost: picoToUsd(BigInt(job.chargedPico!)) }, receipt: job.receipt } : {}),
  ...(job.status === "failed" ? { error: { type: "generation_failed", message: job.reason } } : {}),
  ...(job.status === "pending" ? { held: picoToUsd(BigInt(job.holdPico)) } : {}),
});

// ---- Routes -----------------------------------------------------------------------------------------------------------
export function mediaRoutes(app: Hono, ctx: Ctx) {
  const gate = () => { if (!mediaEnabled(ctx)) fail(404, "Images and video are not enabled on this router.", NOT_ENABLED); };
  const caller = async (c: Context) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    const lim = await ctx.limiter.take(`media:${key.accountId}`, 1, ctx.cfg.media.perMinute, 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    return key;
  };
  const owned = async (c: Context, kind: Kind) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const job = await loadJob(ctx, c.req.param("id") ?? "");
    if (!job || job.kind !== kind || job.accountId !== key.accountId) fail(404, "No such generation.", "not_found");
    return job!;
  };

  app.get("/api/v1/media/models", async (c) => {
    gate();
    const type = c.req.query("type");
    if (type !== "image" && type !== "video") fail(400, "`type` must be image or video.", "invalid_request");
    return c.json({ object: "list", data: await catalogue(ctx, type as Kind) });
  });

  /** Validate an order, hold its highest price, and give back what the upstream is to be sent. */
  const order = async (c: Context, kind: Kind) => {
    gate();
    const key = await caller(c);
    const body = (await readJson(c)) as Record<string, unknown>;
    if (typeof body.model !== "string") fail(400, "`model` is required.", "invalid_request");
    const model = (await catalogue(ctx, kind)).find((m) => m.id === body.model);
    if (!model) fail(404, `Model ${String(body.model).slice(0, 120)} is not a ${kind} model on this router.`, "model_not_found");
    if (key.allowedModels?.length && !key.allowedModels.includes(model!.id)) fail(403, "This key may not use that model.", "model_not_allowed");
    const requiresPrompt = model!.capabilities.requires_prompt !== false;
    if (requiresPrompt && (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8_000)) fail(400, "`prompt` is required (at most 8000 characters).", "invalid_request");
    const count = kind === "image" ? (body.n === undefined ? 1 : Number(body.n)) : 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) fail(400, `\`n\` must be 1 to ${MAX_IMAGES}.`, "invalid_request");
    if (body.image_url !== undefined && !(typeof body.image_url === "string" && /^https:\/\/\S{1,2000}$/.test(body.image_url))) fail(400, "`image_url` must be an https address.", "invalid_request");
    const sent: Record<string, unknown> = { model: model!.id };
    for (const field of FIELDS[kind]) if (typeof body[field] === "string" || typeof body[field] === "number") sent[field] = body[field];
    if (kind === "image") sent.n = count;
    const id = genId();
    sent.client_request_id = id; // the upstream's idempotency key: a generation is made, and billed, once
    const hold = usdToPico((model!.pricing.max * count).toFixed(6)) + 1n;
    await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: hold, ttlMs: kind === "video" ? MEDIA_JOB_MAX_AGE_MS : IMAGE_TIMEOUT_MS + 5 * 60_000 });
    const job: Job = { id, kind, status: "pending", accountId: key.accountId, keyHash: key.keyHash, payer: key.chainKeyHash ?? null, model: model!.id, count, upstreamId: null, holdPico: hold.toString(), chargedPico: null, requestSha256: sha256(JSON.stringify(body)), files: [], reason: null, createdAt: new Date().toISOString(), finishedAt: null, receipt: null };
    return { job, sent };
  };
  /** The upstream said no before it made anything: nothing is charged. */
  const refused = async (job: Job, status: number): Promise<never> => {
    await release(ctx.db, job.id);
    return fail(status === 400 || status === 422 ? 400 : 502, status === 400 || status === 422 ? "The model did not accept this request. Check the parameters it supports. Nothing was charged." : "The generation could not be started. Nothing was charged.", status === 400 || status === 422 ? "invalid_request" : "provider_unavailable");
  };

  app.post("/api/v1/images/generations", async (c) => {
    const { job, sent } = await order(c, "image");
    const up = await upstream(ctx);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await up.call("/images/generations", { method: "POST", body: sent, timeoutMs: IMAGE_TIMEOUT_MS });
    } catch {
      // The request may have reached the upstream: the job stays pending with its hold and is followed to its end.
      await saveJob(ctx, job);
      return c.json(view(ctx, job), 202, { "retry-after": "10" });
    }
    if (!res.ok) { await res.body?.cancel(); return refused(job, res.status); }
    const json = (await boundedJson(res).catch(() => null)) as { data?: unknown; cost?: unknown } | null;
    const files = filesOf(up, json?.data);
    if (!files.length) { await saveJob(ctx, job); return c.json(view(ctx, job), 202, { "retry-after": "10" }); }
    return c.json(view(ctx, await complete(ctx, up, job, { files, costUsd: json?.cost, latencyMs: Date.now() - t0 })));
  });
  app.get("/api/v1/images/generations/:id", async (c) => { gate(); return c.json(view(ctx, await advance(ctx, await owned(c, "image")))); });

  app.post("/api/v1/videos/generations", async (c) => {
    const { job, sent } = await order(c, "video");
    const up = await upstream(ctx);
    let res: Response;
    try {
      res = await up.call("/videos", { method: "POST", body: sent, timeoutMs: 60_000 });
    } catch {
      // Without the upstream's job id there is nothing to follow, and nothing was acknowledged: the hold is released.
      await release(ctx.db, job.id);
      return fail(502, "The generation could not be started. Nothing was charged.", "provider_unavailable");
    }
    if (res.status !== 200 && res.status !== 202) { await res.body?.cancel(); return refused(job, res.status); }
    const json = (await boundedJson(res).catch(() => null)) as { id?: unknown } | null;
    if (typeof json?.id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(json.id)) { await release(ctx.db, job.id); return fail(502, "The generation could not be started. Nothing was charged.", "provider_unavailable"); }
    const started: Job = { ...job, upstreamId: json.id };
    await saveJob(ctx, started);
    return c.json(view(ctx, started), 202, { "retry-after": "10" });
  });
  app.get("/api/v1/videos/generations/:id", async (c) => { gate(); return c.json(view(ctx, await advance(ctx, await owned(c, "video")))); });

  // The bytes. The id is the capability (it is given only to the key that ordered the generation), as with a signed
  // address: an <img> or <video> element cannot send an Authorization header.
  app.get("/api/v1/media/files/:id/:n", async (c) => {
    gate();
    const job = await loadJob(ctx, c.req.param("id") ?? "");
    const file = job?.status === "completed" ? job.files[Number(c.req.param("n"))] : undefined;
    if (!job || !file || !/^\d{1,2}$/.test(c.req.param("n") ?? "") || Date.now() - Date.parse(job.finishedAt!) > MEDIA_FILE_TTL_MS) return fail(404, "No such file, or it has expired.", "not_found");
    const up = await upstream(ctx);
    const res = await up.fetchFile(file.url).catch(() => null);
    if (!res?.ok || !res.body) { await res?.body?.cancel(); return fail(502, "The file could not be read. Try again.", "provider_unavailable"); }
    const length = res.headers.get("content-length");
    return new Response(res.body, { status: 200, headers: { "content-type": file.content_type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${job.id}-${c.req.param("n")}.${file.content_type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin"}"`, ...(length && /^\d+$/.test(length) ? { "content-length": length } : {}) } });
  });
}
