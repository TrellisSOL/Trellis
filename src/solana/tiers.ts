import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import type { HolderTier } from "../config.ts";
import type { Ctx } from "../context.ts";
import { log } from "../lib/util.ts";
import { ADDRESS_RE } from "./constants.ts";
import { withRetry } from "./rpc.ts";

// Holder tiers (docs/Trellis_Overview.md §4): a live read of the wallet's $TRLS balance, no staking program. A request
// made with a key that belongs to a wallet account (w_<address>, from wallet sign-in), paid per call by a wallet or
// billed to a tab gets the highest tier whose `min` that balance reaches. Tiers are membership levels with fixed
// thresholds; their perks are access and priority (higher limits, SEALED-lane and Bushel purchase priority, early
// access to new models, advisory votes, credits that do not expire, a profile badge), never money: Trellis charges
// zero markup, so there is no fee to discount, and no tier grants credits, cashback or rebates. $TRLS is Token-2022
// (no extensions): the balance is the wallet's associated token account under the Token-2022 program (the classic
// Token program is read as a fallback so a test mint under either works). Reads are cached per wallet for an hour; an
// RPC failure yields no tier (fail closed).

export type HolderLookup = { balance: bigint | null; decimals: number | null; tier: HolderTier | null; error: boolean };

export const HOLDER_CACHE_MS = 3_600_000;
type CacheEntry = { at: number; look: HolderLookup };
const caches = new WeakMap<Ctx, Map<string, CacheEntry>>();
const cacheOf = (ctx: Ctx) => { let m = caches.get(ctx); if (!m) caches.set(ctx, (m = new Map())); return m; };

export function clearHolderCache(ctx: Ctx) {
  caches.delete(ctx);
}

/** The wallet behind a wallet account id (w_<base58 address>), else null. */
export const walletOfAccount = (accountId: string | null | undefined) => (accountId && accountId.startsWith("w_") && ADDRESS_RE.test(accountId.slice(2)) ? accountId.slice(2) : null);

/** `min` (a decimal token amount) in base units of a token with `decimals`. */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`not a decimal amount: ${amount}`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** The highest tier (tiers are sorted by min, ascending) whose min `balance` reaches. */
export function tierFor(tiers: HolderTier[], balance: bigint, decimals: number): HolderTier | null {
  let best: HolderTier | null = null;
  for (const t of tiers) if (balance >= parseTokenAmount(t.min, decimals)) best = t;
  return best;
}

/** A per-minute limit with the tier's multiplier applied (rpm or tpm). 0 / null (unlimited or unset) stay as they are. */
export function scaleLimit<T extends number | null | undefined>(limit: T, tier: HolderTier | null, which: "rpm" | "tpm" = "rpm"): T {
  return (limit && tier ? Math.floor(limit * (which === "tpm" ? tier.tpmMultiplier : tier.rpmMultiplier)) : limit) as T;
}

/**
 * A count limit (agent keys, saved routes, batch rows) for a tier: the tier's own number when it is higher than the
 * base, else the base. A tier never lowers a limit, and a base of 0 (no cap) stays 0.
 */
export function raisedLimit(base: number, tierMax: number | null | undefined): number {
  return base > 0 && tierMax != null && tierMax > base ? tierMax : base;
}

/**
 * A count limit for an account, with its wallet's tier applied. The tier is read only once `used` has reached the base
 * limit, so an account below it never costs a balance read. A base of 0 means no cap.
 */
export async function accountLimit(ctx: Ctx, accountId: string | null | undefined, base: number, used: number, pick: (t: HolderTier) => number | null): Promise<number> {
  if (base <= 0 || used < base) return base;
  const tier = await holderTier(ctx, walletOfAccount(accountId));
  return raisedLimit(base, tier ? pick(tier) : null);
}

/** The mint's decimals (checked against TRLS_TOKEN_DECIMALS) and the program that owns it, cached with the lookups. */
let mintInfo: { key: string; decimals: number; program: PublicKey } | null = null;
async function readMintInfo(ctx: Ctx, mint: PublicKey) {
  const key = `${ctx.cfg.chain.network}:${mint.toBase58()}`;
  if (mintInfo?.key === key) return mintInfo;
  const info = await withRetry(() => ctx.chain.connection.getAccountInfo(mint));
  if (!info) throw new Error("holder token mint not found");
  const program = info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const m = unpackMint(mint, info as never, program);
  const configured = ctx.cfg.trlsEscrow?.decimals;
  if (configured !== undefined && configured !== m.decimals) throw new Error(`holder token decimals ${m.decimals} differ from TRLS_TOKEN_DECIMALS ${configured}`);
  mintInfo = { key, decimals: m.decimals, program };
  return mintInfo;
}
export const clearHolderMintCache = () => { mintInfo = null; };

/** The wallet's $TRLS balance (its associated token account; 0 when none) and tier. Never throws; cached an hour. */
export async function lookupHolder(ctx: Ctx, wallet: string, opts: { fresh?: boolean } = {}): Promise<HolderLookup> {
  const token = ctx.cfg.holders.token;
  if (!token || !ADDRESS_RE.test(wallet)) return { balance: null, decimals: null, tier: null, error: false };
  const cache = cacheOf(ctx);
  const hit = cache.get(wallet);
  // `fresh` skips the hour's cache (a poll's close re-checks every voter's balance); the new read replaces the entry.
  if (!opts.fresh && hit && Date.now() - hit.at < HOLDER_CACHE_MS) return hit.look;
  let look: HolderLookup;
  try {
    const mint = new PublicKey(token.address);
    const { decimals, program } = await readMintInfo(ctx, mint);
    const ata = getAssociatedTokenAddressSync(mint, new PublicKey(wallet), true, program);
    const info = await withRetry(() => ctx.chain.connection.getAccountInfo(ata));
    const balance = info ? unpackAccount(ata, info as never, program).amount : 0n;
    look = { balance, decimals, tier: ctx.cfg.holders.enabled ? tierFor(ctx.cfg.holders.tiers, balance, decimals) : null, error: false };
  } catch (e) {
    log.warn("holder balance read failed", { error: (e as Error).message.slice(0, 160) });
    look = { balance: null, decimals: null, tier: null, error: true };
  }
  // A failed read is not cached for the hour: the next request tries again.
  if (!look.error) cache.set(wallet, { at: Date.now(), look });
  return look;
}

/** The tier for a request by `wallet`, or null (tiers off, no wallet, below every tier, or unreadable balance). */
export async function holderTier(ctx: Ctx, wallet: string | null | undefined): Promise<HolderTier | null> {
  if (!ctx.cfg.holders.enabled || !wallet) return null;
  return (await lookupHolder(ctx, wallet)).tier;
}

/** A tier as the API shows it (GET /api/v1/holders/tiers, /holders/me, /status). No field is an amount of money. */
export const tierJson = (t: HolderTier) => ({
  name: t.name,
  min: t.min,
  rpm_multiplier: t.rpmMultiplier,
  tpm_multiplier: t.tpmMultiplier,
  max_agent_keys: t.maxAgentKeys,
  max_saved_routes: t.maxSavedRoutes,
  max_batch_rows: t.maxBatchRows,
  sealed_priority: t.sealedPriority,
  early_access_hours: t.earlyAccessHours,
  vote_weight: t.voteWeight,
  credits_never_expire: t.creditsNeverExpire,
  badge: t.badge,
});

/** The tier ladder position of a tier (0 = lowest), or -1 for no tier: tiers are sorted by `min`, ascending. */
export const tierRank = (tiers: HolderTier[], tier: HolderTier | null | undefined) => (tier ? tiers.findIndex((t) => t.name === tier.name) : -1);

/** The public `holders` section of /api/v1/status. */
export function holdersStatus(ctx: Ctx) {
  const h = ctx.cfg.holders;
  return {
    enabled: h.enabled,
    token: h.token ? { address: h.token.address, symbol: h.token.symbol, program: "token-2022" } : null,
    tiers: h.tiers.map(tierJson),
    cache_s: HOLDER_CACHE_MS / 1000,
    // Perks are access and priority only; `fee_discount` and `free_credits` are always false.
    perks: { fee_discount: false, free_credits: false },
    sealed_queue: { enabled: h.sealed.maxConcurrencyPerHost > 0, max_concurrency_per_host: h.sealed.maxConcurrencyPerHost || null, max_wait_ms: h.sealed.queueMaxWaitMs, non_holder_min_share: h.sealed.nonHolderMinShare },
    early_access: { window_hours: h.earlyAccessWindowHours },
    credits_expiry: { router_sends: h.creditsExpiryEnabled },
  };
}
