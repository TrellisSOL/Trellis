import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { log } from "../lib/util.ts";

// A time budget per request (security review round 4, R4-06).
//
// JavaScript cannot take the processor away from a running function, so "CPU budget" is enforced in the three ways that
// are possible, together:
//   1. Inputs are bounded before anything walks them: body caps per route (hardening/body.ts), a nesting limit
//      (api/common.ts), length limits on the strings a pattern is run on, and patterns that are linear
//      (test/security-r4-06-input-cost.test.ts holds every parser of request-controlled input to that).
//   2. Wall clock: a request to any route but inference is answered 504 `request_timeout` once REQUEST_BUDGET_MS has
//      passed, so a handler stuck on a slow dependency does not keep its caller (and its connection). Inference routes
//      are exempt: they are bounded by the provider timeouts and by the deadline of the hold they took.
//   3. Detection: a watchdog timer notices when the event loop itself was held for EVENT_LOOP_BLOCK_MS, logs the routes
//      that were in flight (names, never content) and raises the readiness warning `event_loop_blocked`.

/** Routes with their own deadlines: inference (and its streams) and media orders, which are bounded by the upstream timeout and their hold. Everything else gets the request budget. */
const OWN_DEADLINE = /^\/(?:api\/v1|v1)\/(?:chat\/completions|completions|embeddings|responses|messages|rerank|rag|batches|images\/generations|videos\/generations)(?:\/|$)|^\/(?:ollama|mcp|trpc)(?:\/|$)|^\/api\/v1\/(?:e2ee|ohttp|characters\/[^/]{1,128}\/chat)(?:\/|$)/;

export function budgetFor(method: string, path: string, cfg: Pick<Config, "hardening">): number | null {
  if (method === "OPTIONS" || path === "/health") return null;
  if (path.length <= 512 && OWN_DEADLINE.test(path)) return null;
  return cfg.hardening.requestBudgetMs;
}

const inFlight = new Map<number, string>();
let seq = 0;
let lastBlock: { at: number; ms: number; routes: string[] } | null = null;
let monitor: ReturnType<typeof setInterval> | null = null;

/** The last stall of the event loop this process saw, if it was within `windowMs`. */
export function eventLoopBlocked(windowMs = 10 * 60_000) {
  return lastBlock && Date.now() - lastBlock.at <= windowMs ? lastBlock : null;
}

function startMonitor(thresholdMs: number) {
  if (monitor) return;
  const every = 100;
  let expected = performance.now() + every;
  monitor = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + every;
    if (late < thresholdMs) return;
    const routes = [...new Set(inFlight.values())].slice(0, 20);
    lastBlock = { at: Date.now(), ms: Math.round(late), routes };
    log.error("event loop was blocked", { ms: Math.round(late), in_flight: inFlight.size, routes });
  }, every);
  (monitor as { unref?: () => void }).unref?.();
}

const routeName = (c: { req: { method: string; path: string } }) => `${c.req.method} ${c.req.path.slice(0, 80)}`;

export const requestBudgetMiddleware = (ctx: Ctx): MiddlewareHandler => {
  startMonitor(ctx.cfg.hardening.eventLoopBlockMs);
  return async (c, next) => {
    const id = ++seq;
    // The route as a name: the method and the path (never the query string), cut short.
    const route = routeName(c);
    inFlight.set(id, route);
    const budget = budgetFor(c.req.method, c.req.path, ctx.cfg);
    try {
      if (budget === null) return await next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), budget); });
      const done = next().then(() => "done" as const);
      const first = await Promise.race([done, late]);
      clearTimeout(timer);
      if (first === "done") return;
      // The handler is still running and cannot be stopped; its result is discarded and its error, if any, logged.
      done.catch((e) => log.warn("a request failed after its time budget", { route, error: (e as Error)?.message?.slice(0, 160) }));
      log.error("request exceeded its time budget", { route, budget_ms: budget });
      c.res = c.json({ error: { code: 504, type: "request_timeout", message: `The request did not finish within ${budget} ms.` } }, 504);
    } finally {
      inFlight.delete(id);
    }
  };
};
