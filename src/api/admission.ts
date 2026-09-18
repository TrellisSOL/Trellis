import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { InFlight, type Slot } from "../lib/inflight.ts";
import { sha256 } from "../lib/util.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { batchLineOf } from "../router/batch-line.ts";
import { bearer } from "./auth.ts";
import { addressBucket } from "./common.ts";

// Admission of an inference call (chat, completions, embeddings), before its body is read (security review R5-04):
//   - at most INFLIGHT_PER_KEY calls open at a time for one key, INFLIGHT_PER_SOURCE for one source address without a
//     key (src/lib/inflight.ts);
//   - at most SLOW_CALLS_PER_10MIN calls that the router had to cut off (its timeout, an answer above the size it
//     reads) for the same key or source inside ten minutes; further calls are refused until the window ends.
// The caller is identified by what it PRESENTS (the hash of its bearer secret, else its address), so nothing is looked
// up here. Who can exhaust a limit for others: nobody but callers sharing the same key, or the same address without a
// key (a NAT, a relay); a key always has its own count.

const pools = new WeakMap<object, InFlight>();
const poolOf = (ctx: Ctx) => {
  let p = pools.get(ctx.cfg);
  // A slot nobody gave back frees itself once no request could still be running under it.
  if (!p) pools.set(ctx.cfg, (p = new InFlight(ctx.cfg.holds.maxLifetimeMs)));
  return p;
};

/** Who a call is counted as: the digest of the key it presents, or (without a key) its source address. */
type Who = { key: string } | { address: string };
export type Admitted = Slot & { who: Who | null };

/** Take a slot for this call, or refuse it (429). A call the router dispatches to itself (a batch line, the OHTTP gateway) is not counted here. */
export async function admitInference(ctx: Ctx, c: Context): Promise<Admitted> {
  if (batchLineOf(c) || gatewayOrigin(c.req.raw)) return { release: () => {}, who: null };
  const secret = bearer(c.req.header("authorization"));
  const from = addressBucket(c, ctx.cfg);
  const who: Who = secret ? { key: sha256(secret).slice(0, 32) } : { address: from.id };
  const limit = secret ? ctx.cfg.limits.inflightPerKey : ctx.cfg.limits.inflightPerSource;
  const slow = ctx.cfg.limits.slowCallsPer10Min;
  if (slow > 0) {
    // Reads the count without adding to it: refused once `slow` cut-off calls are on record for this window.
    const r = secret ? await ctx.limiter.take(`slow-k:${sha256(secret).slice(0, 32)}`, 0, slow - 1, 600_000) : await ctx.limiter.take(`slow-ip:${from.id}`, 0, slow - 1, 600_000);
    if (!r.ok) fail(429, `Too many of this caller's recent calls had to be cut off by the router (${slow} in ten minutes). Lower max_tokens or stream, and retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
  }
  const slot = poolOf(ctx).acquire("key" in who ? `k:${who.key}` : `ip:${who.address}`, limit);
  if (!slot) fail(429, `Too many requests in flight for this ${secret ? "key" : "address"} (${limit} at a time). Wait for one to finish.`, "rate_limited", { in_flight_limit: limit }, { "retry-after": "1" });
  return Object.assign(slot!, { who });
}

/** Record one call the router had to cut off against its caller. Never throws: the call it belongs to is already settled. */
export async function noteCutOff(ctx: Ctx, a: Admitted | null | undefined): Promise<void> {
  const slow = ctx.cfg.limits.slowCallsPer10Min;
  if (!a?.who || !(slow > 0)) return;
  const who = a.who;
  const from = { id: "address" in who ? who.address : "" };
  if ("key" in who) await ctx.limiter.take(`slow-k:${who.key}`, 1, slow, 600_000).catch(() => undefined);
  else await ctx.limiter.take(`slow-ip:${from.id}`, 1, slow, 600_000).catch(() => undefined);
}

/** In-flight calls for a caller id, for tests. */
export const inFlightCount = (ctx: Ctx, who: string) => poolOf(ctx).count(who);
