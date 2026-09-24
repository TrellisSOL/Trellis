import { MemoryRateLimiter } from "../lib/ratelimit.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { batchTooLarge, MCP_BATCH_MAX } from "./mcp-batch.ts";
import type { Context, MiddlewareHandler } from "hono";
import type { Ctx } from "../context.ts";
import { addressBucket, viaOnion } from "../api/common.ts";
import { bearer, resolveKey } from "../api/auth.ts";
import { balanceOf } from "../ledger/ledger.ts";
import { log } from "../lib/util.ts";
import { bodyBudget, capBody, declaredTooLarge, requestCap } from "./body.ts";
import { internalCaller, validOriginLock } from "./client.ts";
export const originLockMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => {
  c.set("hardening", ctx.cfg.hardening);
  c.set("onionIngress", viaOnion(c, ctx.cfg));
  const exempt = c.req.path === "/health" || c.req.path === "/ready";
  // Do not read any address on authenticated onion ingress.
  const internal = !!gatewayOrigin(c.req.raw) || (!c.get("onionIngress") && internalCaller(c));
  if (ctx.cfg.hardening.originLockEnabled && !exempt && !c.get("onionIngress") && !internal && !validOriginLock(c, ctx.cfg.hardening))
    return c.json({ error: { type: "origin_locked", message: "Use the public router address." } }, 403);
  c.set("internalCaller", internal);
  await next();
};
const localLimiter = new MemoryRateLimiter();
const tooMany = (c: Context, retryAfterMs: number, message = "Too many anonymous requests. Try again shortly.") => c.json({ error: { type: "rate_limited", message } }, 429, { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
/** The routes whose handlers count a keyed caller themselves, per key (`k:`) and per account: the only ones where a key lifts the per-address count in core. */
const INFERENCE = /^\/(?:api\/v1|v1)\/(?:chat\/completions|completions|embeddings)$/;
export const hardeningMiddleware = (ctx: Ctx): MiddlewareHandler => {
  const budget = bodyBudget(ctx);
  /**
   * Count `amount` against the caller's address unless a key speaks for the request. Returns the refusal, if any.
   *
   * R5-05, LAUNCH_SURFACE=core: a key speaks for a request only where it pays for it, which is an inference route called
   * with a key whose account holds a balance. Everywhere else (the routes that take no key, the key's own management
   * routes, any route with a key that was never funded, a balance that cannot be read) the caller is counted per source
   * address like anyone else, so a free key buys nothing and a funded one buys nothing on a route it does not pay for.
   * Outside core a known key lifts the count on every route, as before.
   */
  const limit = async (c: Context, amount: number): Promise<Response | undefined> => {
    const core = !!ctx.surface?.core;
    // In core a key travels as a bearer only (surface/request.ts refuses the rest): X-Api-Key lifts nothing there.
    const secret = bearer(c.req.header("authorization")) ?? (core ? undefined : c.req.header("x-api-key"));
    let key: Awaited<ReturnType<typeof resolveKey>> = null;
    if (secret) { try { key = await resolveKey(ctx, secret); } catch { /* invalid keys do not evade the anonymous limit */ } }
    if (key && !core) return;
    if (key && INFERENCE.test(c.req.path)) {
      let funded = false;
      try { funded = (await balanceOf(ctx.db, key.accountId)).balance > 0n; } catch { /* not known to be funded: counted per address */ }
      if (funded) {
        // R5-06: the handler takes the key's and the account's own limits (`k:`, `acct:` in api/chat.ts and
        // api/embeddings.ts) only after it has read and parsed the body. Look at those counts now (amount 0: nothing is
        // taken) and refuse a caller that has none left before a byte of its body is read. Holder tiers scale both
        // limits in the handler and are not on the core surface; where they are on, the handler decides alone.
        const rpm = key.rpm ?? ctx.cfg.limits.defaultRpm, accountRpm = ctx.cfg.limits.accountRpm;
        if (!ctx.cfg.holders.enabled) {
          try {
            if (rpm > 0 && (await ctx.limiter.take(`k:${key.keyHash}`, 0, rpm, 60_000)).remaining <= 0) return tooMany(c, 60_000 - (Date.now() % 60_000), `Rate limit exceeded (${rpm} requests/min).`);
            if (accountRpm > 0 && (await ctx.limiter.take(`acct:${key.accountId}`, 0, accountRpm, 60_000)).remaining <= 0) return tooMany(c, 60_000 - (Date.now() % 60_000), "Rate limit exceeded for this account.");
          } catch { /* the handler asks the limiter itself */ }
        }
        return;
      }
    }
    const from = addressBucket(c, ctx.cfg);
    try {
      const result = await ctx.limiter.take(`anon:${from.id}`, amount, from.scale(ctx.cfg.hardening.anonRatePerMin), 60_000);
      if (!result.ok) return tooMany(c, result.retryAfterMs);
    } catch {
      // R4-26: the shared limiter is unreachable. Do not fail open: this process's own limiter takes over (it bounds
      // one replica, which is weaker than the shared count and far stronger than none).
      log.warn("anonymous limiter unavailable; using this process's own limiter");
      const result = await localLimiter.take(`anon:${from.id}`, amount, from.scale(ctx.cfg.hardening.anonRatePerMin), 60_000);
      if (!result.ok) return tooMany(c, result.retryAfterMs);
    }
  };
  // R5-06, the order: (1) a declared length over the route's cap is refused with no I/O at all; (2) the limiter is asked
  // BEFORE the body is read, so a caller over its limit has no byte buffered; (3) the body is read against the cap, the
  // budget of bodies held at one time and a deadline (hardening/body.ts); (4) what the body reserved is given back when
  // the request is over, however it ends: the `finally` below is the only release and covers every path after the lease.
  return async (c, next) => {
    // R5-05: /health is answered here, before any middleware that looks a credential up or reads a body: no I/O at all,
    // whatever the request carries. (The route registered in api/public.ts answers the same document.)
    if (c.req.path === "/health" && (c.req.method === "GET" || c.req.method === "HEAD")) return c.json({ ok: true });
    const internal = c.get("internalCaller") === true;
    const cap = requestCap(c.req.path, ctx.cfg);
    const declared = declaredTooLarge(c, cap);
    if (declared) return declared;
    // Security review R4-26: every method, not only reads. An unkeyed POST (receipt verification, a wallet challenge, a
    // call that will be answered 402) costs the router as much as a GET does.
    // R5-05: /ready and /ready/metrics too. Their answer is cached (services/readiness.ts), and a caller from outside is
    // counted like on any public route; the monitor and the scraper reach the router directly on the private network
    // (an internal caller: no forwarding header, a private address) and are never counted, so they cannot page falsely.
    const publicRead = c.req.method !== "OPTIONS" && /^\/(api\/|v1\/|ollama\/|facilitator\/|\.well-known\/|keep\/inventory\.json$|ready(?:\/metrics)?$)/.test(c.req.path);
    const mcp = c.req.method === "POST" && c.req.path === "/mcp";
    const limited = !internal && (publicRead || mcp);
    // An MCP batch counts once per message, and only its body says how many there are: that one is counted after the read.
    if (limited && !mcp) { const refused = await limit(c, 1); if (refused) return refused; }
    // No per-address share for in-process dispatch and direct private-network callers: their address is not a client's.
    const lease = c.req.raw.body ? budget.lease(internal ? null : addressBucket(c, ctx.cfg).id) : undefined;
    try {
      const rejected = await capBody(c, cap, lease, ctx.cfg.hardening.bodyReadMs);
      if (rejected) return rejected;
      if (mcp) {
        let amount = 1;
        try { const msg = await c.req.json(); if (Array.isArray(msg)) { if (msg.length > MCP_BATCH_MAX) return batchTooLarge(c); amount = Math.max(1, msg.length); } } catch { /* route returns the JSON-RPC parse error */ }
        if (limited) { const refused = await limit(c, amount); if (refused) return refused; }
      }
      await next();
    } finally { lease?.release(); }
  };
};
