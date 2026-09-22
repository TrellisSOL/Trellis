import { z } from "zod";

// Auto-listing (src/catalog/auto-list.ts). The job is off unless AUTOLIST_ENABLED; the admin routes work either way.
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const autoListEnv = {
  AUTOLIST_ENABLED: bool.default(false),
  AUTOLIST_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  /** A model is listed within this many hours of its release (docs/Trellis_Backend.md §2). */
  AUTOLIST_TARGET_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Share of the evaluation set a candidate must answer correctly. */
  AUTOLIST_MIN_EVAL_SCORE: z.coerce.number().min(0).max(1).default(0.8),
  /** Share of the canary exact-match set a candidate must answer correctly. */
  AUTOLIST_MIN_CANARY_ACCURACY: z.coerce.number().min(0).max(1).default(0.6),
};

const autoListEnvShape = z.object(autoListEnv);
type AutoListEnv = z.infer<typeof autoListEnvShape>;
export const autoListSettings = (e: AutoListEnv) => ({ enabled: e.AUTOLIST_ENABLED, intervalMs: e.AUTOLIST_INTERVAL_MS, targetHours: e.AUTOLIST_TARGET_HOURS, minEvalScore: e.AUTOLIST_MIN_EVAL_SCORE, minCanaryAccuracy: e.AUTOLIST_MIN_CANARY_ACCURACY });
export type AutoListSettings = ReturnType<typeof autoListSettings>;
