import { z } from "zod";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const bytes = (value: number) => z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(value);
const MIB = 1024 * 1024;
/** The most a production core router accepts for INFERENCE_MAX_BYTES (security review R5-06; the launch has no image models). */
export const CORE_INFERENCE_MAX_BYTES = 4 * MIB;
export const hardeningEnv = {
  REQUEST_MAX_BYTES: bytes(1024 * 1024), MCP_MAX_BYTES: bytes(256 * 1024),
  // Security review R4-06. INFERENCE_MAX_BYTES: the body cap of the chat routes; every other
  // route has REQUEST_MAX_BYTES. REQUEST_BUDGET_MS: the wall-clock budget of a request to any route but inference
  // (which has its provider timeouts and its hold's deadline); past it the caller is answered 504 request_timeout.
  // EVENT_LOOP_BLOCK_MS: a stall of the event loop this long is logged with the routes in flight and raised as a warning.
  // R5-06: 2 MiB by default (it was 16 MiB: one unauthenticated request at that cap held about 0.75 GiB). A production
  // core router refuses more than CORE_INFERENCE_MAX_BYTES; inline images need a higher value and the full surface.
  INFERENCE_MAX_BYTES: z.coerce.number().int().min(1024).max(16 * 1024 * 1024).default(2 * MIB),
  // R5-06. BODY_BUDGET_BYTES: the request-body bytes this process holds at one time, all requests together; past it a
  // request with a body is answered 503 with Retry-After (hardening/body.ts). One source address holds at most a quarter.
  // BODY_READ_MS: a request body must arrive whole within this long, or the request is answered 408 and dropped.
  // 32 MiB by default: measured, 32 MiB of worst-shape bodies in flight at once cost about 0.5 GiB of resident memory.
  BODY_BUDGET_BYTES: z.coerce.number().int().min(MIB).max(1024 * MIB).default(32 * MIB),
  BODY_READ_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  REQUEST_BUDGET_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  EVENT_LOOP_BLOCK_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  ANON_RATE_PER_MIN: z.coerce.number().int().min(1).max(100000).default(120),
  // R5-05. READY_CACHE_MS: how long one readiness computation answers GET /ready and /ready/metrics (0: every request
  // computes, still one at a time). Kept far below the shortest alert `for:` (2 m) and the scrape interval (30 s).
  // STATUS_CACHE_MS: the same for GET /api/v1/status. SUB_KEYS_MAX: live (not disabled, not expired) sub-keys one
  // account may have. SUB_KEYS_PER_HOUR: sub-keys one account may create in an hour, disabled ones included.
  READY_CACHE_MS: z.coerce.number().int().min(0).max(15_000).default(5_000),
  STATUS_CACHE_MS: z.coerce.number().int().min(0).max(60_000).default(10_000),
  SUB_KEYS_MAX: z.coerce.number().int().min(1).max(10_000).default(50),
  SUB_KEYS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(20),
  // R5-14. Operator routes: whether a loopback caller with no forwarding header is the operator. True only where no proxy
  // can reach the router over loopback (the shipped compose file: Caddy is another container). Unset: off in production.
  ADMIN_TRUST_LOOPBACK: flag.optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(16).default(1),
  ORIGIN_LOCK_ENABLED: flag.default(false), ORIGIN_LOCK_SECRET: z.string().optional(),
};
export function hardeningSettings(e: z.infer<z.ZodObject<typeof hardeningEnv>> & { TRELLIS_ENV?: string; LAUNCH_SURFACE?: string }) {
  if (e.ORIGIN_LOCK_ENABLED && (!e.ORIGIN_LOCK_SECRET || e.ORIGIN_LOCK_SECRET.length < 32)) throw new Error("ORIGIN_LOCK_SECRET must contain at least 32 characters when ORIGIN_LOCK_ENABLED is on.");
  const production = e.TRELLIS_ENV === "production";
  if (production && e.LAUNCH_SURFACE !== "all" && e.INFERENCE_MAX_BYTES > CORE_INFERENCE_MAX_BYTES) throw new Error(`INFERENCE_MAX_BYTES must be at most ${CORE_INFERENCE_MAX_BYTES} on the core launch surface in production (the launch has no image models).`);
  // One body of the largest configured cap must fit in one address's quarter of the budget, or it could never be sent.
  const largest = Math.max(e.INFERENCE_MAX_BYTES, e.REQUEST_MAX_BYTES, e.MCP_MAX_BYTES);
  if (e.BODY_BUDGET_BYTES < 4 * largest) throw new Error(`BODY_BUDGET_BYTES must be at least four times the largest body cap (${4 * largest} for the caps configured).`);
  return {
    inferenceMaxBytes: e.INFERENCE_MAX_BYTES, requestBudgetMs: e.REQUEST_BUDGET_MS, eventLoopBlockMs: e.EVENT_LOOP_BLOCK_MS, requestMaxBytes: e.REQUEST_MAX_BYTES, mcpMaxBytes: e.MCP_MAX_BYTES, anonRatePerMin: e.ANON_RATE_PER_MIN, trustProxyHops: e.TRUST_PROXY_HOPS, originLockEnabled: e.ORIGIN_LOCK_ENABLED, originLockSecret: e.ORIGIN_LOCK_SECRET,
    bodyBudgetBytes: e.BODY_BUDGET_BYTES, bodyReadMs: e.BODY_READ_MS, readyCacheMs: e.READY_CACHE_MS, statusCacheMs: e.STATUS_CACHE_MS, subKeysMax: e.SUB_KEYS_MAX, subKeysPerHour: e.SUB_KEYS_PER_HOUR,
    adminTrustLoopback: e.ADMIN_TRUST_LOOPBACK ?? !production,
  };
}
export type Hardening = ReturnType<typeof hardeningSettings>;
