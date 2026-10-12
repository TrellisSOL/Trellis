import { PublicKey } from "@solana/web3.js";
import { withRetry, type RpcLike } from "./rpc.ts";

// Off-chain TWAP for pricing $TRLS from its pools (docs/Trellis_Backend.md §Escrow deposits). A leg is
// one AMM pool (Raydium, Orca or any program whose pool account owns one token account per side) that trades `base`
// against `quote`; the price history is the pool's own swap transactions: each swap moves the pool's base and quote
// vaults, and the pre/post token balances the cluster records give the amounts exchanged without knowing the pool
// program's layout. The quote is volume-weighted over `windowSeconds` of swaps (the "average"), compared with the latest
// swap (the "spot"); the conservative price is the lower of the two. Legs chain (TRLS -> X -> USDC) by multiplying.
// Reads go through the injected connection; nothing here signs or sends.

export type PoolKey = { pool: string; base: string; quote: string };
export type Leg = { key: PoolKey; sign: 1 | -1; minLiquidity?: string | number };

export type TwapFailure = "pool_uninitialized" | "thin_liquidity" | "spot_deviates" | "history_short" | "history_mismatch" | "malformed_history" | "unusable_price" | "no_head";
export type TwapFailureDetail = { leg?: number; deviation?: number; limit?: number; direction?: "above" | "below"; liquidity?: string; minLiquidity?: string };

export class TwapError extends Error {
  constructor(public code: TwapFailure, message: string, public detail: TwapFailureDetail = {}) {
    super(message);
    this.name = "TwapError";
  }
}

export const poolId = (k: PoolKey) => k.pool;

export type TwapResult = { spot: number; average: number; conservative: number; windowSeconds: number; block: number; swaps: number };

/** What the pool reader needs from a connection; anything else (an EVM-era client) cannot price a pool. */
export type PoolReader = Pick<RpcLike, "getSignaturesForAddress" | "getTransaction">;
const isPoolReader = (c: unknown): c is PoolReader => !!c && typeof (c as PoolReader).getSignaturesForAddress === "function" && typeof (c as PoolReader).getTransaction === "function";

/** One swap of a leg as its vault balances recorded it: how much base and quote the pool took in (positive) or paid out (negative). */
export type PoolSwap = { slot: number; blockTime: number; baseDelta: bigint; quoteDelta: bigint; baseDecimals: number; quoteDecimals: number; baseVaultAfter: bigint };

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };

/** The pool's vault movements in one transaction, or null when the transaction did not move both sides. */
export function poolSwapOf(key: PoolKey, tx: { slot: number; blockTime?: number | null; meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null }): PoolSwap | null {
  if (!tx.meta || tx.meta.err) return null;
  const side = (mint: string) => {
    const pre = tx.meta!.preTokenBalances?.find((b) => b.mint === mint && b.owner === key.pool);
    const post = tx.meta!.postTokenBalances?.find((b) => b.mint === mint && b.owner === key.pool);
    if (!post) return null;
    if (!/^\d+$/.test(post.uiTokenAmount.amount) || (pre && !/^\d+$/.test(pre.uiTokenAmount.amount))) throw new TwapError("malformed_history", "pool balance history is malformed");
    const after = BigInt(post.uiTokenAmount.amount);
    return { delta: after - BigInt(pre?.uiTokenAmount.amount ?? "0"), after, decimals: post.uiTokenAmount.decimals };
  };
  const base = side(key.base), quote = side(key.quote);
  if (!base || !quote || base.delta === 0n || quote.delta === 0n) return null;
  if ((base.delta > 0n) === (quote.delta > 0n)) return null; // a deposit or withdrawal, not a swap
  return { slot: tx.slot, blockTime: tx.blockTime ?? 0, baseDelta: base.delta, quoteDelta: quote.delta, baseDecimals: base.decimals, quoteDecimals: quote.decimals, baseVaultAfter: base.after };
}

const abs = (v: bigint) => (v < 0n ? -v : v);
/** Quote per base of one swap, in whole-token terms. */
export const swapPrice = (s: PoolSwap) => (Number(abs(s.quoteDelta)) / 10 ** s.quoteDecimals) / (Number(abs(s.baseDelta)) / 10 ** s.baseDecimals);

/** The swaps of a leg within the window, oldest first. */
export async function readPoolSwaps(rpc: PoolReader, key: PoolKey, windowSeconds: number, now = Math.floor(Date.now() / 1000), maxSignatures = 200): Promise<PoolSwap[]> {
  const pool = new PublicKey(key.pool);
  const since = now - windowSeconds;
  const sigs = await withRetry(() => rpc.getSignaturesForAddress(pool, { limit: Math.min(1000, maxSignatures) }, "confirmed"));
  const swaps: PoolSwap[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    if (s.blockTime != null && s.blockTime < since) break; // newest first: everything after is older still
    const tx = await withRetry(() => rpc.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    if (!tx) continue;
    const swap = poolSwapOf(key, tx);
    if (swap) swaps.push(swap);
  }
  return swaps.reverse();
}

/**
 * Price through one or more legs over `windowSeconds` of pool history. Throws a `TwapError`: no_head (the client cannot
 * read the chain), history_short (fewer than two swaps in the window), thin_liquidity (a leg's base vault is below its
 * `minLiquidity`), spot_deviates (the last swap is further than `maxDeviation` from the volume-weighted average),
 * unusable_price (zero or non-finite).
 */
export async function v4Twap(
  client: unknown,
  _poolManager: string | undefined,
  legs: Leg[],
  opts: { windowSeconds: number; maxDeviation: number; decimalsAdjust?: number; state?: { blockRate?: number }; now?: number; maxSignatures?: number },
): Promise<TwapResult> {
  if (!isPoolReader(client)) throw new TwapError("no_head", "the chain client cannot read pool history");
  if (!legs.length) throw new TwapError("pool_uninitialized", "no pool legs configured");
  let spot = 1, average = 1, block = 0, swapsTotal = 0;
  for (const [i, leg] of legs.entries()) {
    const swaps = await readPoolSwaps(client, leg.key, opts.windowSeconds, opts.now, opts.maxSignatures);
    if (swaps.length < 2) throw new TwapError("history_short", `pool ${leg.key.pool} has ${swaps.length} swap(s) in the window`, { leg: i });
    const last = swaps[swaps.length - 1];
    if (leg.minLiquidity !== undefined && last.baseVaultAfter < BigInt(leg.minLiquidity)) throw new TwapError("thin_liquidity", `pool ${leg.key.pool} holds too little liquidity`, { leg: i, liquidity: last.baseVaultAfter.toString(), minLiquidity: String(leg.minLiquidity) });
    // Volume-weighted by base amount; a leg with sign -1 prices quote in base, so its price is inverted.
    let volume = 0, value = 0;
    for (const s of swaps) {
      const v = Number(abs(s.baseDelta)) / 10 ** s.baseDecimals;
      volume += v;
      value += v * swapPrice(s);
    }
    const legAverage = value / volume, legSpot = swapPrice(last);
    if (!Number.isFinite(legAverage) || !Number.isFinite(legSpot) || legAverage <= 0 || legSpot <= 0) throw new TwapError("unusable_price", `pool ${leg.key.pool} gives no usable price`, { leg: i });
    const deviation = Math.abs(legSpot - legAverage) / legAverage;
    if (deviation > opts.maxDeviation) throw new TwapError("spot_deviates", `pool ${leg.key.pool}: the last swap is ${(deviation * 100).toFixed(2)}% from the window average`, { leg: i, deviation, limit: opts.maxDeviation, direction: legSpot > legAverage ? "above" : "below" });
    spot *= leg.sign === 1 ? legSpot : 1 / legSpot;
    average *= leg.sign === 1 ? legAverage : 1 / legAverage;
    block = Math.max(block, last.slot);
    swapsTotal += swaps.length;
  }
  return { spot, average, conservative: Math.min(spot, average), windowSeconds: opts.windowSeconds, block, swaps: swapsTotal };
}
