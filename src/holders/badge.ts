import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { holderTier, walletOfAccount } from "../solana/tiers.ts";

// Holder badge on public agent profiles. A badge reveals the tier of the wallet behind a profile, so it is shown only
// when the profile's owner switched `show_holder_badge` on (off by default), the profile's key belongs to a wallet
// sign-in account, and that wallet holds a tier whose `badge` is on right now (the hourly balance cache). The badge is
// the tier's name: never the wallet, never the balance.

/** The tier name to show for the profile of `keyHash`, or null. */
export async function holderBadge(ctx: Ctx, keyHash: string, optedIn: boolean | undefined): Promise<string | null> {
  if (optedIn !== true || !ctx.cfg.holders.enabled) return null;
  const [k] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  const tier = await holderTier(ctx, walletOfAccount(k?.accountId));
  return tier?.badge ? tier.name : null;
}
