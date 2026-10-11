import { createPublicKey, verify as edVerify } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { x402PaidResults } from "../db/schema.ts";
import { canonicalJson, decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import { ADDRESS_RE, base58Decode } from "./constants.ts";

// x402 payment recovery (docs/Trellis_Backend.md §x402): a lost answer to a paid call is sent again, never paid twice.
// When a call paid with x402 is answered, the route keeps (`storePaidResult`) the request's hash, the answer's hash and the
// answer itself sealed with AES-256-GCM under a key derived from APP_SECRET, the payer, the payment nonce (the payer's
// transaction signature) and the request hash, in Redis (or this process's memory without Redis), for 24 hours; the row in
// x402_paid_results names the payer, the nonce, the two hashes and the sealed answer's key. A payer who never saw the
// answer sends the same request again with `PAYMENT-RECOVERY`: base64 JSON { payer, nonce, signature }, the signature
// being the payer wallet's ed25519 over the UTF-8 recovery message. The middleware checks the signature, finds the row,
// compares the request hash, opens the sealed answer, checks its hash and sends it byte for byte: no payment, no provider
// call. Expired rows and sealed answers go with the x402-recovery-expire job.

export const RECOVERY_TTL_MS = 24 * 3_600_000;
export const RECOVERY_HEADER = "payment-recovery";
export const recoveryMessage = (network: string, payer: string, nonce: string) => `trellis:x402-recovery:${network}:${payer}:${nonce}`;
/** The paid routes recovery answers on. */
export const RECOVERY_PATHS = ["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/embeddings", "/api/v1/rerank", "/api/v1/characters/:id/chat"];
const bodyRefOf = (payer: string, nonce: string) => `x402paid:${sha256(`${payer}:${nonce}`)}`;
const sealKey = (ctx: Ctx, payer: string, nonce: string, requestSha256: string) => sha256(`${ctx.cfg.appSecret}:${payer}:${nonce}:${requestSha256}`);
/** The request hash the receipts carry (src/api/chat.ts requestHash): sha256 of the canonical JSON body. */
export const recoveryRequestHash = (body: unknown) => sha256(canonicalJson(body));

type Sealed = { contentType: string; body: string };
/** Where sealed answers live: Redis when configured, else this process's memory (per-process, TTL-swept). */
export interface SealedStore { set(key: string, value: string, ttlMs: number): Promise<void>; get(key: string): Promise<string | null>; del(keys: string[]): Promise<void> }

class MemoryStore implements SealedStore {
  private m = new Map<string, { value: string; until: number }>();
  async set(key: string, value: string, ttlMs: number) { this.m.set(key, { value, until: Date.now() + ttlMs }); }
  async get(key: string) { const e = this.m.get(key); if (!e) return null; if (e.until < Date.now()) { this.m.delete(key); return null; } return e.value; }
  async del(keys: string[]) { for (const k of keys) this.m.delete(k); }
}
const stores = new WeakMap<object, SealedStore>();
export const recoveryDeps: { store: (ctx: Ctx) => Promise<SealedStore> } = {
  async store(ctx) {
    const hit = stores.get(ctx.cfg);
    if (hit) return hit;
    let store: SealedStore;
    if (ctx.cfg.redisUrl) {
      const { Redis } = await import("ioredis");
      const redis = new Redis(ctx.cfg.redisUrl, { maxRetriesPerRequest: 2 });
      store = { set: async (k, v, ttl) => { await redis.set(k, v, "PX", ttl); }, get: (k) => redis.get(k), del: async (ks) => { if (ks.length) await redis.del(...ks); } };
    } else store = new MemoryStore();
    stores.set(ctx.cfg, store);
    return store;
  },
};

/** Keep a paid call's answer for recovery (the route calls this once the answer was sent). Idempotent per (payer, nonce). */
export async function storePaidResult(ctx: Ctx, r: { payer: string; nonce: string; requestSha256: string; body: string; contentType?: string }) {
  const bodyRef = bodyRefOf(r.payer, r.nonce);
  const sealed: Sealed = { contentType: r.contentType ?? "application/json", body: r.body };
  await (await recoveryDeps.store(ctx)).set(bodyRef, encrypt(sealKey(ctx, r.payer, r.nonce, r.requestSha256), JSON.stringify(sealed)), RECOVERY_TTL_MS);
  await ctx.db.insert(x402PaidResults).values({ payer: r.payer, nonce: r.nonce, requestSha256: r.requestSha256, responseSha256: sha256(r.body), bodyRef }).onConflictDoNothing();
  return { bodyRef };
}

/** The largest answer kept for recovery (security review R5-07): a larger one is not kept, and its recovery answers 404. */
export const RECOVERY_MAX_BYTES = 1024 * 1024;

/**
 * What the paid routes call once a NON-STREAMED answer to an x402-paid call is ready (security review R5-07: before it,
 * nothing called storePaidResult, so PAYMENT-RECOVERY never had an answer). Bounded (RECOVERY_MAX_BYTES), bound to the
 * payer (the recovery signature) and the request (its hash), kept RECOVERY_TTL_MS. A streamed answer is not kept. Never
 * throws: failing to keep an answer must not fail the answer.
 */
export async function keepPaidAnswer(ctx: Ctx, r: { payer: string; nonce: string; requestSha256: string; body: string }): Promise<boolean> {
  if (Buffer.byteLength(r.body, "utf8") > RECOVERY_MAX_BYTES) return false;
  try {
    await storePaidResult(ctx, r);
    return true;
  } catch (e) {
    log.warn("x402 recovery: the answer could not be kept", { error: (e as Error).message.slice(0, 160) });
    return false;
  }
}

export type RecoveryClaim = { payer: string; nonce: string; signature: string };
/** The header's claim, or null when malformed. */
export function parseRecoveryHeader(value: string | undefined): RecoveryClaim | null {
  if (!value) return null;
  try {
    const j = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Partial<RecoveryClaim>;
    if (typeof j.payer !== "string" || typeof j.nonce !== "string" || typeof j.signature !== "string") return null;
    if (!ADDRESS_RE.test(j.payer) || !/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(j.nonce)) return null;
    return { payer: j.payer, nonce: j.nonce, signature: j.signature };
  } catch {
    return null;
  }
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** The payer wallet's ed25519 signature (base58, 64 bytes) over the recovery message. Never throws. */
export function verifyRecoverySignature(network: string, claim: RecoveryClaim): boolean {
  try {
    const sig = base58Decode(claim.signature);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(base58Decode(claim.payer))]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(recoveryMessage(network, claim.payer, claim.nonce), "utf8"), key, sig);
  } catch {
    return false;
  }
}

export type RecoveryOutcome = { ok: true; body: string; contentType: string } | { ok: false; status: number; reason: "bad_claim" | "bad_signature" | "not_found" | "request_mismatch" | "answer_gone" };

/** Look a claim up for `requestBody`: the sealed answer when the payer, nonce, signature and request all match. */
export async function recoverAnswer(ctx: Ctx, header: string | undefined, requestBody: unknown): Promise<RecoveryOutcome> {
  const claim = parseRecoveryHeader(header);
  if (!claim) return { ok: false, status: 400, reason: "bad_claim" };
  if (!verifyRecoverySignature(ctx.cfg.chain.network, claim)) return { ok: false, status: 401, reason: "bad_signature" };
  const [row] = await ctx.db.select().from(x402PaidResults).where(and(eq(x402PaidResults.payer, claim.payer), eq(x402PaidResults.nonce, claim.nonce)));
  if (!row || row.createdAt.getTime() < Date.now() - RECOVERY_TTL_MS) return { ok: false, status: 404, reason: "not_found" };
  const requestSha256 = recoveryRequestHash(requestBody);
  if (requestSha256 !== row.requestSha256) return { ok: false, status: 409, reason: "request_mismatch" };
  const sealed = await (await recoveryDeps.store(ctx)).get(row.bodyRef);
  if (!sealed) return { ok: false, status: 410, reason: "answer_gone" };
  try {
    const { contentType, body } = JSON.parse(decrypt(sealKey(ctx, claim.payer, claim.nonce, requestSha256), sealed)) as Sealed;
    if (sha256(body) !== row.responseSha256) return { ok: false, status: 410, reason: "answer_gone" };
    return { ok: true, body, contentType };
  } catch {
    return { ok: false, status: 410, reason: "answer_gone" };
  }
}

const MESSAGES: Record<Exclude<RecoveryOutcome, { ok: true }>["reason"], string> = {
  bad_claim: "PAYMENT-RECOVERY must be base64 JSON {payer, nonce, signature}.",
  bad_signature: "The recovery signature does not verify for the payer over the recovery message.",
  not_found: "No answer is kept for this payer and nonce (answers are kept 24 hours).",
  request_mismatch: "The recovery request differs from the request the payment paid for.",
  answer_gone: "The kept answer is no longer available; the payment was not charged again.",
};

/** PAYMENT-RECOVERY on the paid routes: a matching kept answer is sent again; every other request passes through untouched. */
export function paymentRecovery(app: Hono, ctx: Ctx) {
  const handler = async (c: Context, next: () => Promise<void>) => {
    const header = c.req.header(RECOVERY_HEADER);
    if (!header || c.req.method !== "POST") return next();
    let body: unknown;
    try { body = await c.req.raw.clone().json(); } catch { return c.json({ error: { code: 400, message: "A recovery request must carry the original JSON body.", type: "invalid_request" } }, 400); }
    const r = await recoverAnswer(ctx, header, body);
    c.header("Cache-Control", "no-store");
    if (!r.ok) {
      log.info("x402 recovery refused", { reason: r.reason });
      return c.json({ error: { code: r.status, message: MESSAGES[r.reason], type: `recovery_${r.reason}` } }, r.status as 400);
    }
    c.header("x-payment-recovered", "true");
    return c.body(r.body, 200, { "content-type": r.contentType });
  };
  for (const path of RECOVERY_PATHS) app.use(path, handler);
}

/** Delete what recovery keeps once its 24 hours have passed: the x402-recovery-expire job. */
export async function expirePaidResults(ctx: Ctx) {
  try {
    const gone = await ctx.db.delete(x402PaidResults).where(lt(x402PaidResults.createdAt, new Date(Date.now() - RECOVERY_TTL_MS))).returning({ ref: x402PaidResults.bodyRef });
    if (gone.length) await (await recoveryDeps.store(ctx)).del(gone.map((g) => g.ref)).catch(() => undefined);
    return { expired: gone.length };
  } catch (e) {
    log.warn("x402 recovery expiry failed", { error: (e as Error).message });
    return { expired: 0 };
  }
}
