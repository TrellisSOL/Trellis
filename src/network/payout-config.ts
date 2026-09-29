import { z } from "zod";

// Network payouts. NETWORK_FEE_BPS of each host payout may be kept as a protocol fee (0 by default: zero markup); it is
// only accounted for in the fee ledger and the host's invoice. Nothing is swapped, bought or burned with it: the only
// $TRLS burn is trellis_fee_router::burn_inference_payment, which burns $TRLS paid for inference
// (src/solana/programs/fee-router.ts).

const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false);
export const networkPayoutEnv = {
  NETWORK_PAYOUTS_ENABLED: flag,
  NETWORK_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(0),
};
type Input = z.infer<z.ZodObject<typeof networkPayoutEnv>> & { SANCTIONS_SCREENING_ENABLED: boolean; HOST_ANCHOR_ENABLED: boolean; SETTLEMENT_PRIVATE_KEY?: string; RUNTIME_ROLE: string; WORKER_JOBS: string; PAYMENTS_MODE: string };
export function networkPayoutSettings(e: Input, production: boolean) {
  const jobs = e.WORKER_JOBS.split(",").map(s => s.trim());
  if (e.NETWORK_PAYOUTS_ENABLED && (!e.SANCTIONS_SCREENING_ENABLED || !e.HOST_ANCHOR_ENABLED)) throw new Error("NETWORK_PAYOUTS_ENABLED requires SANCTIONS_SCREENING_ENABLED and HOST_ANCHOR_ENABLED.");
  if (e.NETWORK_PAYOUTS_ENABLED && e.PAYMENTS_MODE === "escrow") throw new Error("Network payments require contract payments mode.");
  if (production && e.RUNTIME_ROLE === "worker") {
    if (e.NETWORK_PAYOUTS_ENABLED && jobs.includes("settlement") && !e.SETTLEMENT_PRIVATE_KEY) throw new Error("Network payouts require the settlement signer.");
  }
  return { enabled: e.NETWORK_PAYOUTS_ENABLED, feeBps: e.NETWORK_FEE_BPS };
}
