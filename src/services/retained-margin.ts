import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { picoToUsdc } from "../lib/money.ts";

/** Margin remains in its existing ledger and custody. Preserve the historical worker result. */
export async function retainedMargin(ctx: Ctx) {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, "margin_unsent"));
  const usdc = picoToUsdc(BigInt((row?.value as string) ?? "0"), "floor");
  if (usdc <= 0n) return { sent: "0" };
  // Internal compatibility label only; no transfer or retired contract lookup occurs.
  return { sent: "0", accrued_usdc: usdc.toString(), reason: "staking not configured" };
}
