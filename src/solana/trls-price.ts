import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { paywithDeps, scalePrice } from "./paywith.ts";
import { withRetry, type RpcLike } from "./rpc.ts";

// The price a $TRLS deposit is credited at (security review R4-33: the earlier price was read from a pool's last
// transactions, and a few swaps set it).
//
// The router samples the token's market itself, once a minute at a moment nobody else chooses, from FINALIZED account
// state: the reserves of the market (its launch bonding curve, or after that an AMM pool's two vaults), turned into
// dollars with the SOL/USD price account on chain. Samples are kept in the database. A deposit is credited at the LOWEST sample of the
// window (30 minutes by default), and only while the window is covered: enough samples, the oldest of them old enough
// and the newest fresh. So a price cannot be raised by a trade, a round trip or a burst of them: it has to be held up
// at every sample for the whole window, against everyone else free to sell into it. Pushing it down for one sample does
// lower what a deposit is credited, which costs depositors and never the operator. Without a covered window there is no
// price and deposits wait as `pending`. What a mistake here can cost is bounded separately, by the amount credited per
// deposit and per day (escrow.ts).

type TrlsEscrow = NonNullable<Config["trlsEscrow"]>;

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Anchor discriminator of the launch program's BondingCurve account. */
const CURVE_DISCRIMINATOR = "17b7f83760d8ac60";

export type PriceFailure = "market_moved" | "market_unreadable" | "market_thin" | "sol_price_stale";
export class TrlsPriceError extends Error {
  constructor(public code: PriceFailure, message: string) {
    super(message);
    this.name = "TrlsPriceError";
  }
}

/** One side-by-side reading of the market: raw token units against lamports, and the SOL actually held. */
export type Reserves = { source: "curve" | "pool"; token: bigint; lamports: bigint; liquidity: bigint };
/** USD per whole token, 18 decimals (a decimal string: it goes through JSON). */
export type PriceSample = { t: number; p: string };

export const pumpCurveAddress = (mint: string) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBytes()], new PublicKey(PUMP_PROGRAM))[0];

type Reader = Pick<RpcLike, "getAccountInfo" | "getMultipleAccountsInfo">;

/** The market's reserves at the finalized commitment. Throws TrlsPriceError when there is nothing to believe. */
export async function readReserves(conn: Reader, trls: Pick<TrlsEscrow, "address" | "price">): Promise<Reserves> {
  const vaults = trls.price.vaults;
  if (vaults) {
    const [base, quote] = await withRetry(() => conn.getMultipleAccountsInfo([new PublicKey(vaults.base), new PublicKey(vaults.quote)], "finalized"));
    const side = (info: typeof base, mint: string) => {
      if (!info || info.data.length < 72 || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new TrlsPriceError("market_unreadable", "a pool vault is not a token account");
      if (new PublicKey(info.data.subarray(0, 32)).toBase58() !== mint) throw new TrlsPriceError("market_unreadable", "a pool vault holds another token");
      return { authority: new PublicKey(info.data.subarray(32, 64)).toBase58(), amount: info.data.readBigUInt64LE(64) };
    };
    const b = side(base, trls.address), q = side(quote, WSOL_MINT);
    if (b.authority !== q.authority) throw new TrlsPriceError("market_unreadable", "the two vaults belong to different pools");
    return { source: "pool", token: b.amount, lamports: q.amount, liquidity: q.amount };
  }
  const info = await withRetry(() => conn.getAccountInfo(pumpCurveAddress(trls.address), "finalized"));
  if (!info || info.owner.toBase58() !== PUMP_PROGRAM || info.data.length < 49 || Buffer.from(info.data.subarray(0, 8)).toString("hex") !== CURVE_DISCRIMINATOR) throw new TrlsPriceError("market_unreadable", "the token's launch curve could not be read");
  // After the curve completes the token trades in a pool; the curve's last numbers are not a price any more.
  if (info.data[48] !== 0) throw new TrlsPriceError("market_moved", "the token left its launch curve: TRLS_POOL_VAULTS must name its pool before deposits are priced again");
  return { source: "curve", token: info.data.readBigUInt64LE(8), lamports: info.data.readBigUInt64LE(16), liquidity: info.data.readBigUInt64LE(32) };
}

export const SOL_PRICE_MAX_AGE_S = 120;
/** The program that owns verified price accounts, and the discriminator of one. */
export const PRICE_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const PRICE_ACCOUNT_DISCRIMINATOR = "22f123639d7ef4cd";

/**
 * USD per SOL, 18 decimals, from the SOL/USD price account on chain: the price less its confidence interval, fully
 * verified, for the feed the configuration names, no older than two minutes. Nothing off chain is asked.
 */
export async function solUsd18(conn: Pick<RpcLike, "getAccountInfo">, source: { account: string; feed: string }, now = Math.floor(paywithDeps.now() / 1000)): Promise<bigint> {
  const info = await withRetry(() => conn.getAccountInfo(new PublicKey(source.account), "finalized"));
  const d = info?.data;
  if (!info || !d || d.length < 101 || info.owner.toBase58() !== PRICE_RECEIVER_PROGRAM || Buffer.from(d.subarray(0, 8)).toString("hex") !== PRICE_ACCOUNT_DISCRIMINATOR) throw new TrlsPriceError("sol_price_stale", "the SOL price account could not be read");
  // write_authority (32), then the verification level: 1 = full (a partial level carries one more byte and is refused).
  if (d[40] !== 1 || "0x" + Buffer.from(d.subarray(41, 73)).toString("hex") !== source.feed.toLowerCase()) throw new TrlsPriceError("sol_price_stale", "the SOL price account is not the verified SOL/USD feed");
  const price = d.readBigInt64LE(73), conf = d.readBigUInt64LE(81), expo = d.readInt32LE(89), published = Number(d.readBigInt64LE(93));
  if (Math.abs(now - published) > SOL_PRICE_MAX_AGE_S) throw new TrlsPriceError("sol_price_stale", "the SOL price is stale");
  if (price <= 0n || conf >= price || expo > 0 || expo < -18) throw new TrlsPriceError("sol_price_stale", "the SOL price is unusable");
  return scalePrice(price - conf, expo);
}

/** USD per whole token (18 decimals) from reserves: lamports per raw unit, scaled by the token's decimals and the SOL price. */
export const usd18Of = (r: Pick<Reserves, "token" | "lamports">, decimals: number, sol18: bigint) => (r.token > 0n ? (r.lamports * 10n ** BigInt(decimals) * sol18) / (r.token * 10n ** 9n) : 0n);

const samplesKey = (ctx: Pick<Ctx, "cfg">, mint: string) => `trls-price:${ctx.cfg.chain.network}:${mint}`;

export async function readSamples(ctx: Pick<Ctx, "cfg" | "db">, mint: string): Promise<PriceSample[]> {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, samplesKey(ctx, mint)));
  const list = (row?.value as { samples?: PriceSample[] } | undefined)?.samples;
  return Array.isArray(list) ? list.filter((s) => Number.isFinite(s?.t) && /^\d+$/.test(String(s?.p))) : [];
}

/**
 * One pass of the sampler (job "trls-price"): wait a random part of the interval, read the market, keep the sample.
 * A reading that cannot be believed (a thin market, a stale SOL price, an unreadable account) is not kept, so the
 * window loses cover and deposits wait rather than being priced from it.
 */
export async function sampleTrlsPrice(ctx: Ctx, opts: { jitter?: boolean } = {}) {
  const trls = ctx.cfg.trlsEscrow;
  if (!trls || !ctx.cfg.escrow.address) return { skipped: "$TRLS is not accepted" };
  if (opts.jitter !== false) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * trls.price.sampleSeconds * 400)));
  let p: bigint;
  try {
    const reserves = await readReserves(ctx.chain.connection, trls);
    if (reserves.liquidity < trls.price.minLamports) throw new TrlsPriceError("market_thin", "the market holds too little SOL to price from");
    p = usd18Of(reserves, trls.decimals, await solUsd18(ctx.chain.connection, { account: trls.price.solAccount, feed: trls.price.solFeed }));
    if (p <= 0n) throw new TrlsPriceError("market_unreadable", "the market gives no price");
  } catch (e) {
    if (!(e instanceof TrlsPriceError)) throw e;
    await ctx.db.insert(kv).values({ key: samplesKey(ctx, trls.address) + ":last-failure", value: { code: e.code, message: e.message, at: Math.floor(Date.now() / 1000) } }).onConflictDoUpdate({ target: kv.key, set: { value: { code: e.code, message: e.message, at: Math.floor(Date.now() / 1000) }, updatedAt: new Date() } });
    return { sampled: false, reason: e.code };
  }
  const now = Math.floor(Date.now() / 1000);
  const kept = (await readSamples(ctx, trls.address)).filter((s) => s.t > now - trls.price.windowSeconds * 2 && s.t < now);
  const samples = [...kept, { t: now, p: p.toString() }];
  await ctx.db.insert(kv).values({ key: samplesKey(ctx, trls.address), value: { samples } }).onConflictDoUpdate({ target: kv.key, set: { value: { samples }, updatedAt: new Date() } });
  return { sampled: true, samples: samples.length };
}

export async function lastPriceFailure(ctx: Pick<Ctx, "cfg" | "db">, mint: string): Promise<{ code: PriceFailure; message: string; at: number } | null> {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, samplesKey(ctx, mint) + ":last-failure"));
  return (row?.value as { code: PriceFailure; message: string; at: number } | undefined) ?? null;
}

export type WindowPrice =
  | { available: true; price18: bigint; spot18: bigint; average18: bigint; samples: number; windowSeconds: number }
  | { available: false; code: "history_short"; message: string };

/**
 * The price of the window: the lowest sample, when the window is covered. Covered means enough samples
 * (`coverage` of one per interval), the oldest at least 80% of the window old, and the newest within three intervals.
 */
export function windowPrice(all: PriceSample[], now: number, o: { windowSeconds: number; sampleSeconds: number; coverage: number }): WindowPrice {
  const recent = all.filter((s) => s.t > now - o.windowSeconds && s.t <= now).sort((a, b) => a.t - b.t);
  const need = Math.max(2, Math.ceil((o.windowSeconds / o.sampleSeconds) * o.coverage));
  const short = (message: string): WindowPrice => ({ available: false, code: "history_short", message });
  if (recent.length < need) return short(`The price window has ${recent.length} of the ${need} readings it needs; deposits wait until it fills.`);
  if (recent[0].t > now - o.windowSeconds * 0.8) return short("The price window does not reach back far enough yet; deposits wait until it does.");
  if (recent[recent.length - 1].t < now - o.sampleSeconds * 3) return short("The latest price reading is too old; deposits wait for a fresh one.");
  const prices = recent.map((s) => BigInt(s.p));
  const min = prices.reduce((a, b) => (b < a ? b : a));
  return { available: true, price18: min, spot18: prices[prices.length - 1], average18: prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length), samples: prices.length, windowSeconds: o.windowSeconds };
}
