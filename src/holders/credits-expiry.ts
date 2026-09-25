import type { Ctx } from "../context.ts";
import { lookupHolder, walletOfAccount } from "../solana/tiers.ts";

// Credits that do not expire for holders. Expiry lives on chain (trellis_credits: expires_at, notice_expiry,
// sweep_expired) and only the settlement authority can act on it, so the perk is the router not acting: the expiry job
// (services/settlement.ts expireCredits) asks here before every notice_expiry and every sweep_expired.
//
// A key is exempt while a wallet bound to it holds a tier with `credits_never_expire`, read fresh at that moment (not
// from the hour's cache). The wallets bound to a key are the wallet of its account (a wallet sign-in account,
// w_<address>) and the key's on-chain authority (the wallet that made the first deposit). A balance that cannot be read
// also exempts the key for this run, so nothing is noticed or swept on a guess.

export type ExpiryExemption = { reason: "holder_exempt" | "tier_unreadable"; tier?: string };

export async function creditsExpiryExemption(ctx: Ctx, key: { accountId: string | null; authority?: string | null }): Promise<ExpiryExemption | null> {
  if (!ctx.cfg.holders.enabled || !ctx.cfg.holders.tiers.some((t) => t.creditsNeverExpire)) return null;
  const wallets = [...new Set([walletOfAccount(key.accountId), key.authority ?? null].filter((w): w is string => !!w))];
  let unreadable = false;
  for (const wallet of wallets) {
    const look = await lookupHolder(ctx, wallet, { fresh: true });
    if (look.error) unreadable = true;
    else if (look.tier?.creditsNeverExpire) return { reason: "holder_exempt", tier: look.tier.name };
  }
  return unreadable ? { reason: "tier_unreadable" } : null;
}

// ---- the owner's notice ---------------------------------------------------------------------------------------------
// One kv marker per on-chain notice_expiry, written by the expiry job and shown in the account's inbox
// (src/inbox/credits-expiry.ts). `noticeAt` is the program's notice time, `recordedAt` when the marker was written and
// `sweepAfter` the earliest moment the job may sweep: a whole grace period after the later of the two.
export type ExpiryNotice = { accountId: string; keyHash: string; noticeAt: string; recordedAt: string; sweepAfter: string; amount: string; tx: string | null };
export const expiryNoticePrefix = (ctx: Pick<Ctx, "cfg">) => `credits-expiry-notice:${ctx.cfg.chain.id}:`;
export const expiryNoticeKey = (ctx: Pick<Ctx, "cfg">, chainKeyHash: string, noticeAt: bigint) => `${expiryNoticePrefix(ctx)}${chainKeyHash}:${noticeAt}`;
