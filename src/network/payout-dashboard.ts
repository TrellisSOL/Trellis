import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { settlements } from "../db/schema.ts";
import { networkFeeLedger } from "./payout-schema.ts";
/** Called after the existing host route has authenticated the exact operator view. */
export async function networkPayoutDashboard(ctx: Ctx, providerId: string, networkHost: boolean, operator: boolean, band: (amount: bigint) => string) {
  if (!networkHost) return {};
  const [totals] = await ctx.db.select({ unpaid: sql<string>`coalesce(sum(${settlements.usdcOwed}) filter (where ${settlements.paidTx} is null),0)::text` }).from(settlements).innerJoin(networkFeeLedger, and(eq(networkFeeLedger.providerId, settlements.providerId), eq(networkFeeLedger.period, settlements.period))).where(eq(settlements.providerId, providerId));
  return { network_payout: { enabled: ctx.cfg.networkPayouts.enabled, fee_bps: ctx.cfg.networkPayouts.feeBps, accrued_net_band: band(BigInt(totals.unpaid)), basis: "Unpaid net USDC from receipts in confirmed per-host roots. Rounded down to USDC units per accrual hour.", ...(operator ? { accrued_net_usdc_units: totals.unpaid, decimals: 6 } : {}) } };
}
