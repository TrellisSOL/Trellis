import { gatewayOrigin, markFromGateway } from "../ohttp/origin.ts";
import type { Context } from "hono";
import type { Config } from "../config.ts";
const LARGE = 16 * 1024 * 1024;
/** Preserve existing image/file wire limits; their route-specific semantic caps still apply. */
export function requestCap(path: string, cfg: Config): number {
  if (path === "/mcp") return cfg.hardening.mcpMaxBytes;
  // R4-06, R5-06: the chat routes have their own, configured cap (INFERENCE_MAX_BYTES: 2 MiB by default; raise it where inline images are used).
  if (/^\/(api\/v1|v1)\/chat\/completions$/.test(path)) return cfg.hardening.inferenceMaxBytes;
  // R5-06: the routes below are not on the core launch surface. This middleware runs before the surface answers 404, so
  // in core they get no more than any other route: a body is never buffered for a route that does not exist.
  const large = cfg.surface === "core" ? cfg.hardening.requestMaxBytes : LARGE;
  if (/^\/(api\/v1|v1)\/(chat\/completions|responses|messages|rag|batches)$/.test(path) || /^\/ollama\/(api\/(chat|generate)|v1\/chat\/completions)$/.test(path)) return large;
  if (path === "/api/v1/skills/import") return large;
  if (path === "/api/v1/e2ee/chat/completions") return Math.min(1024 * 1024, large);
  if (path === "/api/v1/ohttp/gateway") return cfg.surface === "core" ? Math.min(cfg.ohttp.maxRequestBytes, large) : cfg.ohttp.maxRequestBytes;
  return cfg.hardening.requestMaxBytes;
}

/**
 * R5-06. The request-body bytes this process holds at one time, all requests together.
 *
 * Invariants (test/security-r5-06-body-budget.test.ts holds each over randomized sequences and outcomes):
 *   1. `inUse` is the sum of what the open leases hold, and 0 <= inUse <= total, always.
 *   2. One address's open leases together hold at most max(perAddress, the cap of the route asking): a quarter of the
 *      budget by default, so one address cannot fill it, and never less than one body of the route's own cap, so a
 *      configuration cannot make a legitimate body unsendable.
 *   3. A lease gives back everything it holds exactly once: `release` is idempotent, a released lease reserves nothing
 *      more, and with every lease released `inUse` is 0 and no address is remembered.
 * What it does NOT bound: a handler that keeps running after its response was produced (a request past its time
 * budget, a stream in progress) may still reference its body; the lease ends when the middleware chain returns.
 */
export class BodyBudget {
  private used = 0;
  private high = 0;
  private readonly byAddress = new Map<string, number>();
  constructor(readonly total: number, readonly perAddress = Math.floor(total / 4)) {}
  get inUse() { return this.used; }
  /** The most ever held at one time (for tests and for sizing the budget). */
  get peak() { return this.high; }
  get addresses() { return this.byAddress.size; }
  private fits(address: string | null, bytes: number, cap: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (this.used + bytes > this.total) return false;
    return address === null || (this.byAddress.get(address) ?? 0) + bytes <= Math.max(this.perAddress, cap);
  }
  private add(address: string | null, bytes: number) {
    this.used += bytes;
    if (this.used > this.high) this.high = this.used;
    if (address === null) return;
    const next = (this.byAddress.get(address) ?? 0) + bytes;
    if (next > 0) this.byAddress.set(address, next);
    else this.byAddress.delete(address);
  }
  /** One request's share. `address` null: no per-address limit (in-process dispatch, a direct private-network caller). */
  lease(address: string | null): BodyLease {
    let held = 0, open = true;
    return {
      get held() { return held; },
      admits: (bytes, cap) => open && this.fits(address, bytes, cap),
      reserve: (bytes, cap) => {
        if (!open || !this.fits(address, bytes, cap)) return false;
        this.add(address, bytes);
        held += bytes;
        return true;
      },
      release: () => {
        if (!open) return;
        open = false;
        this.add(address, -held);
        held = 0;
      },
    };
  }
}
export type BodyLease = {
  readonly held: number;
  /** Whether `bytes` more would be reserved right now (nothing is). */
  admits(bytes: number, cap: number): boolean;
  /** Reserve `bytes` more, or nothing at all. */
  reserve(bytes: number, cap: number): boolean;
  release(): void;
};

const budgets = new WeakMap<object, BodyBudget>();
/** The body budget of one router (one per `ctx`, made on first use). */
export function bodyBudget(ctx: { cfg: Pick<Config, "hardening"> }): BodyBudget {
  let budget = budgets.get(ctx);
  if (!budget) budgets.set(ctx, (budget = new BodyBudget(ctx.cfg.hardening.bodyBudgetBytes)));
  return budget;
}

// The three refusals end the connection: what is left of the upload is not read to keep it alive. `Connection: close`
// tells the proxy and the client; the runtime does not act on that header itself (measured on Bun 1.3.14), so the
// connection is also given one second to live through the server's own per-request timeout (Bun closes it within a
// few seconds, whether or not the client keeps sending). `c.env` is the server only under Bun.serve; elsewhere this is a no-op.
function refusal(c: Context, status: 408 | 413 | 503, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  try { (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 1); } catch { /* not a Bun server */ }
  return c.json({ error }, status, { Connection: "close", ...headers });
}
const tooLarge = (c: Context, cap: number) => refusal(c, 413, { type: "payload_too_large", message: `Request body exceeds ${cap} bytes.`, max_bytes: cap });

/** A declared Content-Length over the cap: 413 before anything else is done for the request (no key lookup, no limiter, no read). */
export function declaredTooLarge(c: Context, cap: number): Response | undefined {
  if (!(Number(c.req.header("content-length") ?? 0) > cap)) return;
  void c.req.raw.body?.cancel().catch(() => {});
  return tooLarge(c, cap);
}

/**
 * Read the request body into memory, bounded four ways (R5-06): the declared length (413), the bytes counted while
 * reading (413 at the chunk that crosses `cap`, which is not kept), the budget of bodies held at one time (503 with
 * Retry-After: before reading when the declared length does not fit, else at the chunk that does not), and a deadline
 * for the whole body (408). Each chunk is reserved in `lease` BEFORE it is kept, so what is kept never exceeds what is
 * reserved. The caller releases the lease when the request is over, however it ends.
 */
export async function capBody(c: Context, cap: number, lease?: BodyLease, readMs?: number): Promise<Response | undefined> {
  const declared = declaredTooLarge(c, cap);
  if (declared) return declared;
  const original = c.req.raw;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return;
  const busy = () => refusal(c, 503, { type: "server_busy", message: "The router is holding as many request bodies as it can. Retry shortly." }, { "Retry-After": "1" });
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = readMs ? new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), readMs); }) : null;
  try {
    // A declared length that has no place right now is refused before the first read. Nothing is reserved for a length
    // that was only declared: the budget counts bytes that arrived, so holding a share of it costs sending that much
    // (a caller that declares 2 MiB and sends nothing holds nothing).
    const length = Number(c.req.header("content-length") ?? 0);
    if (lease && length > 0 && !lease.admits(length, cap)) { void reader.cancel().catch(() => {}); return busy(); }
    for (;;) {
      const pending = reader.read();
      const next = late ? await Promise.race([pending, late]) : await pending;
      // Every refusal below gives back what this body held AT ONCE (the caller's release then finds nothing): uploads
      // that reach the limit together must not all fail waiting for each other's bytes to be returned.
      if (next === "late") {
        pending.catch(() => {}); // the abandoned read may reject once the stream is cancelled
        void reader.cancel().catch(() => {});
        lease?.release();
        return refusal(c, 408, { type: "request_timeout", message: `The request body did not arrive within ${readMs} ms.` });
      }
      if (next.done) break;
      const value = next.value;
      size += value.byteLength;
      if (size > cap) { void reader.cancel().catch(() => {}); lease?.release(); return tooLarge(c, cap); }
      if (lease && !lease.reserve(value.byteLength, cap)) { void reader.cancel().catch(() => {}); lease.release(); return busy(); }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* a read abandoned at the deadline is still pending */ }
  }
  // Retain at most cap bytes, and preserve cancellation, headers and the original URL for downstream handlers.
  c.req.raw = new Request(original.url, { method: original.method, headers: original.headers, body: Buffer.concat(chunks, size), signal: original.signal });
  const origin = gatewayOrigin(original); if (origin) markFromGateway(c.req.raw, origin);
}
