import { resolveSurface } from "../surface/config.ts";
import { z } from "zod";

// Shadow re-execution settings (docs/Trellis_Backend.md §3, "Verifiable inference"). Kept apart from src/config.ts: the
// service reads the environment through this fragment, and tests pass overrides directly.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const shadowEnv = {
  /** Off by default: nothing is sampled or re-executed until an operator turns it on. */
  SHADOW_ENABLED: bool.default(false),
  /** Share of SEALED-lane (lane "attested") generations re-executed on a second host. The design value is 1–2%. */
  SHADOW_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.015),
  /** Seconds the sealed request bytes may wait in the queue before they expire unexecuted (minutes, never hours). */
  SHADOW_REQUEST_TTL_S: z.coerce.number().int().min(30).max(1_800).default(300),
  /** How often the shadow job drains the queue. */
  SHADOW_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** Queue entries executed per job run. */
  SHADOW_BATCH: z.coerce.number().int().min(1).max(500).default(25),
  /** Upstream timeout of one shadow call. */
  SHADOW_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** Basis points of the bond proposed for a mismatch (§5.3: 50% + ejection). */
  SHADOW_SLASH_BPS: z.coerce.number().int().min(0).max(10_000).default(5_000),
};

export type ShadowConfig = {
  enabled: boolean;
  sampleRate: number;
  requestTtlMs: number;
  intervalMs: number;
  batch: number;
  timeoutMs: number;
  slashBps: number;
};

const schema = z.object(shadowEnv);

/** Settings from process.env with `overrides` on top, as src/config.ts does for everything else. */
export function loadShadowConfig(overrides: Record<string, unknown> = {}): ShadowConfig {
  // LAUNCH_SURFACE=core refuses (production) or drops this feature's switch, as src/config.ts does for the rest.
  const parsed = schema.safeParse(resolveSurface({ ...process.env, ...overrides }).env);
  if (!parsed.success) throw new Error(`Invalid shadow configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  return { enabled: e.SHADOW_ENABLED, sampleRate: e.SHADOW_SAMPLE_RATE, requestTtlMs: e.SHADOW_REQUEST_TTL_S * 1000, intervalMs: e.SHADOW_INTERVAL_MS, batch: e.SHADOW_BATCH, timeoutMs: e.SHADOW_TIMEOUT_MS, slashBps: e.SHADOW_SLASH_BPS };
}
