import { resolveSurface } from "../surface/config.ts";
import { z } from "zod";

// HVX index settings (docs/Trellis_Backend.md §5.6). Kept apart from src/config.ts: the service reads the environment
// through this fragment, and tests pass overrides directly.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const hvxEnv = {
  /** Off by default: the hourly job computes nothing until an operator turns it on. The read route still answers. */
  HVX_ENABLED: bool.default(false),
  /** Receipts charged below this (USD) are not index input: dust and probe-sized payments carry no price signal. */
  HVX_MIN_PAYMENT_USD: z.coerce.number().min(0).default(0.001),
  /** Daily filtered volume (USD) under which a grade's point is flagged THIN. */
  HVX_THIN_DAILY_USD: z.coerce.number().min(0).default(50_000),
  /** Parameter-count boundaries (billions): below the first is G-S, below the second G-M, the rest G-L. */
  HVX_GRADE_SMALL_MAX_B: z.coerce.number().positive().default(20),
  HVX_GRADE_MEDIUM_MAX_B: z.coerce.number().positive().default(100),
  /** How many whole hours each run recomputes (the current hour is always recomputed; earlier ones catch late rows). */
  HVX_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(48).default(2),
  /** Publish each completed hour's point to trellis_capacity's HvxFeed (publish_hvx). Off: the points stay in the
   *  database and on GET /api/v1/hvx only. Needs TRELLIS_CAPACITY_PROGRAM_ID and the key of HVX_AUTHORITY_ROLE. */
  HVX_PUBLISH_ONCHAIN: bool.default(false),
  /** Which role key signs publish_hvx. It must be the capacity config's hvx_authority. */
  HVX_AUTHORITY_ROLE: z.enum(["keeper", "settlement", "anchorer", "slasher"]).default("keeper"),
};

export type HvxConfig = { enabled: boolean; minPaymentUsd: number; thinDailyUsd: number; smallMaxB: number; mediumMaxB: number; lookbackHours: number; publishOnchain: boolean; authorityRole: "keeper" | "settlement" | "anchorer" | "slasher" };

const schema = z.object(hvxEnv);

/** Settings from process.env with `overrides` on top, as src/config.ts does for everything else. */
export function loadHvxConfig(overrides: Record<string, unknown> = {}): HvxConfig {
  // LAUNCH_SURFACE=core refuses (production) or drops this feature's switch, as src/config.ts does for the rest.
  const parsed = schema.safeParse(resolveSurface({ ...process.env, ...overrides }).env);
  if (!parsed.success) throw new Error(`Invalid HVX configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  if (e.HVX_GRADE_SMALL_MAX_B >= e.HVX_GRADE_MEDIUM_MAX_B) throw new Error("HVX_GRADE_SMALL_MAX_B must be below HVX_GRADE_MEDIUM_MAX_B.");
  return { enabled: e.HVX_ENABLED, minPaymentUsd: e.HVX_MIN_PAYMENT_USD, thinDailyUsd: e.HVX_THIN_DAILY_USD, smallMaxB: e.HVX_GRADE_SMALL_MAX_B, mediumMaxB: e.HVX_GRADE_MEDIUM_MAX_B, lookbackHours: e.HVX_LOOKBACK_HOURS, publishOnchain: e.HVX_PUBLISH_ONCHAIN, authorityRole: e.HVX_AUTHORITY_ROLE };
}
