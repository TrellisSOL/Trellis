import { z } from "zod";

// Bushels (docs/Trellis_Backend.md §5.6): prepaid capacity sold against a bonded host's capacity commitment. Off unless
// BUSHELS_ENABLED. While the programs are unaudited the value of prepaid capacity outstanding is capped (§10): the cap
// may be lowered, never raised above BUSHEL_ISSUANCE_CAP_CEILING_USD.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const opt = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

export const BUSHEL_ISSUANCE_CAP_CEILING_USD = 250_000;

export const bushelEnv = {
  BUSHELS_ENABLED: bool.default(false),
  BUSHEL_ISSUANCE_CAP_USD: z.coerce.number().default(BUSHEL_ISSUANCE_CAP_CEILING_USD),
  /** Comma list of commitment accounts offered for sale. Empty: every open commitment the RPC lists for the program. */
  BUSHEL_COMMITMENTS: opt,
  /** Requests for the same commitment arriving within this many milliseconds are served together, in priority order. */
  BUSHEL_SALE_WINDOW_MS: z.coerce.number().int().min(0).max(5_000).default(250),
  BUSHEL_MIN_TOKENS: z.coerce.number().int().min(1).default(100_000),
  /** Which role key signs report_shortfall, rehome_lot and claim_lot_shortfall (the program authority). */
  BUSHEL_AUTHORITY_ROLE: z.enum(["settlement", "slasher", "keeper"]).default("settlement"),
  /** A host whose share of successful health samples inside the window is below this under-delivered (the bond schedule's 95%). */
  BUSHEL_MIN_UPTIME: z.coerce.number().min(0).max(1).default(0.95),
  BUSHEL_SHORTFALL_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  /**
   * Seconds after a commitment's window_end at which trellis_capacity accepts release_commitment (the program's
   * CLAIM_PERIOD: 14 days in the default build, 30 s in the devnet build). The job releases a reported commitment then,
   * which frees the host's bond lock; the program decides, this only says when it is worth asking.
   */
  BUSHEL_CLAIM_PERIOD_S: z.coerce.number().int().min(1).max(90 * 86_400).default(14 * 86_400),
};

const bushelEnvShape = z.object(bushelEnv);
type BushelEnv = z.infer<typeof bushelEnvShape>;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function bushelSettings(e: BushelEnv) {
  if (!(e.BUSHEL_ISSUANCE_CAP_USD > 0) || e.BUSHEL_ISSUANCE_CAP_USD > BUSHEL_ISSUANCE_CAP_CEILING_USD) throw new Error(`BUSHEL_ISSUANCE_CAP_USD must be above 0 and at most ${BUSHEL_ISSUANCE_CAP_CEILING_USD} (the pre-audit cap).`);
  const commitments = (e.BUSHEL_COMMITMENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (commitments.some((a) => !ADDRESS.test(a))) throw new Error("BUSHEL_COMMITMENTS must be a comma list of account addresses.");
  return {
    enabled: e.BUSHELS_ENABLED,
    /** Cap on the purchase price of all lots whose window is still open, in USDC base units. */
    issuanceCapUnits: BigInt(Math.round(e.BUSHEL_ISSUANCE_CAP_USD * 1e6)),
    commitments: [...new Set(commitments)],
    saleWindowMs: e.BUSHEL_SALE_WINDOW_MS,
    minTokens: BigInt(e.BUSHEL_MIN_TOKENS),
    authorityRole: e.BUSHEL_AUTHORITY_ROLE,
    minUptime: e.BUSHEL_MIN_UPTIME,
    shortfallIntervalMs: e.BUSHEL_SHORTFALL_INTERVAL_MS,
    claimPeriodS: e.BUSHEL_CLAIM_PERIOD_S,
  };
}
export type BushelSettings = ReturnType<typeof bushelSettings>;
