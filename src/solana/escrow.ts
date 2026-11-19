import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getExtensionTypes, unpackMint } from "@solana/spl-token";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { escrowDeposits, kv } from "../db/schema.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { PICO_PER_USD, picoToUsd, usdToPico, type Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import type { EscrowFinality, EscrowTransfer } from "./chain-service.ts";
import { fastCreditAllows, recordFastDeposit, settleFastDeposit } from "./fast-credit-state.ts";
import { paywithDeps, pythFeedId, scalePrice } from "./paywith.ts";
import { oldestSignaturesSince, withRetry, type RpcLike } from "./rpc.ts";
import { lastPriceFailure, readSamples, windowPrice } from "./trls-price.ts";
import { burnState } from "./trls-burn.ts";

// Escrow deposits (docs/Trellis_Backend.md §Escrow deposits): a customer transfers an accepted SPL token from their own
// wallet to ESCROW_ADDRESS (the escrow wallet's associated token account for that mint); once the slot is finalized the
// sending wallet's account (w_<address>) is credited at the token's price minus the haircut. On Solana there is nothing
// to reorganise past finality, so the `creditable` slot is the finalized slot and a credited deposit is never re-verified.
//
// The indexer (pollEscrow, job "escrow-indexer") walks each accepted token's escrow token account by transaction
// signature at the finalized commitment, reads the transfer from the transaction's pre/post token balances (the escrow
// account's gain and the sending owner's loss in the same mint) and records one escrow_deposits row per transfer
// (<signature>:<index>). Fast credit (FAST_CREDIT_ENABLED) adds a second walk at the confirmed commitment that credits a
// deposit early, within the caps of fast-credit-state.ts; the finalized walk settles it, and a confirmed transaction the
// cluster never finalizes is reversed with a compensating debit and a review flag.
//
// Prices: Stock Tokens from their Pyth feed (18-decimal USD per whole UI token, no older than ESCROW_MAX_PRICE_AGE_S),
// $TRLS from the router's own samples of its market (trls-price.ts: the lowest of the window), USDC at par. A deposit without a price waits as
// `pending` (stage awaiting_price). Network reads go through the connection and paywithDeps.fetch, so tests run offline.

export type EscrowStatus = "provisional" | "pending_finality" | "pending" | "credited" | "orphaned" | "reversed";
export type EscrowPrice = { price18: bigint; updatedAt: number };
/** The chain's finality point plus `creditable`: the highest slot whose transfers may be credited. */
export type EscrowFinal = EscrowFinality & { creditable: bigint };

type TrlsEscrow = NonNullable<Config["trlsEscrow"]>;
type UsdcEscrow = NonNullable<Config["usdcEscrow"]>;

export const escrowEnabled = (ctx: Ctx) => !!ctx.cfg.escrow.address && (ctx.cfg.escrow.tokens.length > 0 || !!ctx.cfg.trlsEscrow || !!ctx.cfg.usdcEscrow);
export const escrowAccountId = (wallet: string) => `w_${wallet}`;
export const ESCROW_KIND = "escrow_deposit";
export const escrowRef = (id: string) => `escrow:${id}`;
export const escrowReversalRef = (id: string) => `escrow-reversal:${id}`;

/** A token escrow accepts: a priced token (its feed), $TRLS priced from its pools, or USDC at par. */
export type AcceptedToken = { symbol: string; address: string; decimals: number; haircutBps: number } & (
  | { kind: "stock"; feed: string; maxCredit: null }
  | { kind: "trls"; trls: TrlsEscrow; maxCredit: Pico }
  | { kind: "usdc"; usdc: UsdcEscrow; maxCredit: Pico }
);

/** Every token the escrow credits, from the configuration (empty when escrow is off). */
export function acceptedTokens(ctx: Ctx): AcceptedToken[] {
  if (!escrowEnabled(ctx)) return [];
  const out: AcceptedToken[] = ctx.cfg.escrow.tokens.map((t) => ({ kind: "stock" as const, symbol: t.symbol, address: t.address, decimals: t.decimals, haircutBps: ctx.cfg.escrow.haircutBps, feed: t.feed, maxCredit: null }));
  const trls = ctx.cfg.trlsEscrow;
  if (trls) out.push({ kind: "trls", symbol: trls.symbol, address: trls.address, decimals: trls.decimals, haircutBps: trls.haircutBps, trls, maxCredit: usdToPico(trls.maxUsdPerDeposit, "floor") });
  const usdc = ctx.cfg.usdcEscrow;
  if (usdc) out.push({ kind: "usdc", symbol: usdc.symbol, address: usdc.address, decimals: usdc.decimals, haircutBps: usdc.haircutBps, usdc, maxCredit: usdToPico(usdc.maxUsdPerDeposit, "floor") });
  return out;
}
export const acceptedToken = (ctx: Ctx, address: string) => acceptedTokens(ctx).find((t) => t.address === address) ?? null;

export const usdcParPrice = (): EscrowPrice => ({ price18: 10n ** 18n, updatedAt: Math.floor(Date.now() / 1000) });

/** Why $TRLS cannot be priced right now, as a stable code. */
export type TrlsPriceFailure = "pool_missing" | "history_short" | "market_moved" | "market_unreadable" | "market_thin" | "sol_price_stale" | "no_price" | "source_unreachable";
export type TrlsQuote =
  | { available: true; price18: string; spot: number; average: number; conservative: number; windowSeconds: number; samples: number }
  | { available: false; code: TrlsPriceFailure; message: string };

let lastTrlsQuote: { at: number; quote: TrlsQuote } | null = null;
export const TRLS_QUOTE_TTL_MS = 15_000;
export const clearEscrowCaches = () => { lastTrlsQuote = null; stockPriceCache.clear(); mintProgramCache.clear(); plainMints.clear(); };

/** The last $TRLS quote this process computed (never waits for a fresh one), or null when none was attempted. */
export function peekTrlsQuote(_ctx: Ctx): TrlsQuote | null {
  return lastTrlsQuote?.quote ?? null;
}

const usd = (p18: bigint) => Number(p18) / 1e18;

/** The $TRLS price of the sampled window (trls-price.ts; cached a few seconds), or the reason there is none. */
export async function trlsQuote(ctx: Ctx): Promise<TrlsQuote> {
  const a = ctx.cfg.trlsEscrow;
  if (!a) return { available: false, code: "pool_missing", message: "$TRLS is not accepted on this router." };
  if (lastTrlsQuote && Date.now() - lastTrlsQuote.at < TRLS_QUOTE_TTL_MS) return lastTrlsQuote.quote;
  let quote: TrlsQuote;
  try {
    const now = Math.floor(Date.now() / 1000);
    const w = windowPrice(await readSamples(ctx, a.address), now, a.price);
    if (w.available) quote = { available: true, price18: w.price18.toString(), spot: usd(w.spot18), average: usd(w.average18), conservative: usd(w.price18), windowSeconds: w.windowSeconds, samples: w.samples };
    else {
      // The window is short: say why the sampler is not filling it, when it said so recently.
      const failure = await lastPriceFailure(ctx, a.address);
      quote = failure && failure.at > now - a.price.sampleSeconds * 3 ? { available: false, code: failure.code, message: failure.message } : { available: false, code: w.code, message: w.message };
    }
  } catch {
    quote = { available: false, code: "source_unreachable", message: "The price readings could not be read." };
  }
  lastTrlsQuote = { at: Date.now(), quote };
  return quote;
}

export type PriceReason = { code: TrlsPriceFailure | "feed_stale" | "feed_unreadable"; message: string };

const stockPriceCache = new Map<string, { at: number; price: EscrowPrice }>();
/** A Stock Token's price from its Pyth feed: 18-decimal USD per whole token and the publish time; null when stale or unreadable. */
export async function stockPrice(ctx: Ctx, feed: string, now = Math.floor(Date.now() / 1000)): Promise<EscrowPrice | null> {
  const hit = stockPriceCache.get(feed);
  if (hit && Date.now() - hit.at < 60_000) return hit.price;
  try {
    const res = await paywithDeps.fetch(`${ctx.cfg.paywith.pythUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(pythFeedId(feed))}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { parsed?: { price: { price: string; expo: number; publish_time: number } }[] };
    const p = j.parsed?.[0]?.price;
    if (!p || !/^-?\d+$/.test(String(p.price))) return null;
    if (Math.abs(now - Number(p.publish_time)) > ctx.cfg.escrow.maxPriceAgeS) return null;
    const price18 = scalePrice(BigInt(p.price), Number(p.expo));
    if (price18 <= 0n) return null;
    const price = { price18, updatedAt: Number(p.publish_time) };
    stockPriceCache.set(feed, { at: Date.now(), price });
    return price;
  } catch {
    return null;
  }
}

/** The price an accepted token is credited at right now, or the reason there is none. */
export async function escrowPrice(ctx: Ctx, t: AcceptedToken): Promise<{ price: EscrowPrice } | { price: null; reason: PriceReason }> {
  if (t.kind === "usdc") return { price: usdcParPrice() };
  if (t.kind === "stock") {
    const price = await stockPrice(ctx, t.feed);
    return price ? { price } : { price: null, reason: { code: "feed_stale", message: `No current ${t.symbol} price from its feed.` } };
  }
  const q = await trlsQuote(ctx);
  if (!q.available) return { price: null, reason: { code: q.code, message: q.message } };
  // USD per whole $TRLS, 18 decimals: the lowest reading of the window.
  const price18 = BigInt(q.price18);
  return price18 > 0n ? { price: { price18, updatedAt: Math.floor(Date.now() / 1000) } } : { price: null, reason: { code: "no_price", message: "The pool gives no usable $TRLS price." } };
}

/** pico-USD credited for `raw` units of a token at `price18`, after the haircut, capped at `maxCredit` when set. */
export function creditFor(raw: bigint, t: Pick<AcceptedToken, "decimals" | "haircutBps" | "maxCredit">, price18: bigint): Pico {
  const gross = (raw * price18 * PICO_PER_USD) / (10n ** BigInt(t.decimals) * 10n ** 18n);
  const net = (gross * BigInt(10_000 - t.haircutBps)) / 10_000n;
  return t.maxCredit !== null && net > t.maxCredit ? t.maxCredit : net;
}

export function formatRaw(raw: bigint, decimals: number, maxFraction = 6) {
  const unit = 10n ** BigInt(decimals);
  const frac = (raw % unit).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${raw / unit}${frac ? "." + frac : ""}`;
}

/** The finalized slot and the slot transfers may be credited at (the same slot: finality is final on Solana). */
export async function escrowFinality(ctx: Ctx): Promise<EscrowFinal> {
  const f = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality);
  return { ...f, creditable: f.final };
}

// ---- Reading transfers -----------------------------------------------------------------------------------------------

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type TxLike = { slot: number; blockTime?: number | null; meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null };

/**
 * The transfers of `mint` into the escrow wallet one transaction made: the escrow's balance gain, attributed to the owner
 * whose balance of the same mint fell (the sender). One transfer per sender; index = position in that list.
 */
export function escrowTransfersOf(signature: string, tx: TxLike, mint: string, escrow: string): EscrowTransfer[] {
  if (!tx.meta || tx.meta.err) return [];
  const pre = new Map((tx.meta.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, b]));
  const post = (tx.meta.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const amount = (b: TokenBalance | undefined) => (b && /^\d+$/.test(b.uiTokenAmount.amount) ? BigInt(b.uiTokenAmount.amount) : 0n);
  let gained = 0n;
  const senders: { owner: string; lost: bigint }[] = [];
  for (const b of post) {
    const delta = amount(b) - amount(pre.get(b.accountIndex));
    if (b.owner === escrow && delta > 0n) gained += delta;
    else if (b.owner && b.owner !== escrow && delta < 0n) senders.push({ owner: b.owner, lost: -delta });
  }
  // A closed sender account has a pre but no post balance.
  for (const [idx, b] of pre) if (!post.some((p) => p.accountIndex === idx) && b.owner && b.owner !== escrow && amount(b) > 0n) senders.push({ owner: b.owner, lost: amount(b) });
  if (gained <= 0n || !senders.length) return [];
  const lostTotal = senders.reduce((s, x) => s + x.lost, 0n);
  // Attribute the gain to the senders in proportion to what each lost (one sender in the common case).
  let left = gained;
  return senders.map((s, i) => {
    const value = i === senders.length - 1 ? left : (gained * s.lost) / lostTotal;
    left -= value;
    return { token: mint, from: s.owner, value, txHash: signature, logIndex: i, blockNumber: BigInt(tx.slot), blockHash: "" };
  }).filter((t) => t.value > 0n);
}

/**
 * Security review R4-34: a Token-2022 mint can carry extensions that change what an amount means (a UI multiplier,
 * interest, a transfer fee, a hook). $TRLS is credited only while its mint is what the configuration says: the stated
 * decimals, and no extension beyond its own metadata. Returns the problem as a code, or null.
 */
const plainMints = new Set<string>();
const PLAIN_EXTENSIONS: ReadonlySet<ExtensionType> = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
export async function trlsMintProblem(conn: Pick<RpcLike, "getAccountInfo">, t: Pick<AcceptedToken, "address" | "decimals">): Promise<"mint_missing" | "mint_decimals" | "mint_unsupported" | null> {
  if (plainMints.has(t.address)) return null;
  const mint = new PublicKey(t.address);
  const info = await withRetry(() => conn.getAccountInfo(mint));
  if (!info) return "mint_missing";
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null;
  if (!program) return "mint_unsupported";
  const m = unpackMint(mint, info as never, program);
  if (m.decimals !== t.decimals) return "mint_decimals";
  if (program.equals(TOKEN_2022_PROGRAM_ID) && getExtensionTypes(m.tlvData).some((x) => !PLAIN_EXTENSIONS.has(x))) return "mint_unsupported";
  plainMints.add(t.address);
  return null;
}

/** pico-USD of $TRLS credits the day still has room for: TRLS_ESCROW_MAX_USD_PER_DAY less what the last 24 hours were credited. */
export async function trlsRoomToday(ctx: Ctx, t: Extract<AcceptedToken, { kind: "trls" }>): Promise<Pico> {
  const [row] = await ctx.db.select({ sum: sql<string>`coalesce(sum(${escrowDeposits.credited}), 0)` }).from(escrowDeposits).where(and(eq(escrowDeposits.token, t.address), isNotNull(escrowDeposits.credited), gt(escrowDeposits.creditedAt, new Date(Date.now() - 86_400_000))));
  const used = BigInt(String(row?.sum ?? "0").split(".")[0]);
  const room = usdToPico(t.trls.maxUsdPerDay, "floor") - used;
  return room > 0n ? room : 0n;
}

const mintProgramCache = new Map<string, PublicKey>();
async function mintProgram(conn: Pick<RpcLike, "getAccountInfo">, mint: PublicKey): Promise<PublicKey> {
  const hit = mintProgramCache.get(mint.toBase58());
  if (hit) return hit;
  const info = await withRetry(() => conn.getAccountInfo(mint));
  if (!info) throw new Error(`escrow mint ${mint.toBase58()} not found`);
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  unpackMint(mint, info as never, program); // throws when the account is not a mint
  mintProgramCache.set(mint.toBase58(), program);
  return program;
}

/** The escrow wallet's token account for `mint` (its associated token account under the mint's token program). */
export async function escrowTokenAccount(conn: Pick<RpcLike, "getAccountInfo">, escrow: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddressSync(mint, escrow, true, await mintProgram(conn, mint));
}

/**
 * New transfers of `mint` into the escrow since `cursor` (a signature; undefined = from the start), oldest first, at
 * `commitment`, with the last signature walked so the caller can advance its cursor.
 *
 * One pass takes the OLDEST `maxSignatures` since the cursor (the walk goes all the way back to it), so the cursor only
 * ever moves over transactions that were read (security review TR-16): before, a backlog longer than the page limit lost
 * its oldest part for good. When the walk cannot reach the cursor within `maxPages`, nothing is scanned, `last` is the
 * cursor unchanged and `pageLimitHit` is true. A transaction the node cannot show yet stops the pass at that point.
 */
export async function scanEscrowTransfers(conn: Pick<RpcLike, "getAccountInfo" | "getSignaturesForAddress" | "getTransaction">, o: { escrow: PublicKey; mint: PublicKey; cursor?: string; commitment: "confirmed" | "finalized"; maxSignatures?: number; maxPages?: number; pageSize?: number }): Promise<{ transfers: EscrowTransfer[]; last: string | undefined; scanned: number; pageLimitHit: boolean; backlog: number }> {
  const account = await escrowTokenAccount(conn, o.escrow, o.mint);
  const window = await oldestSignaturesSince(conn, account, o.cursor, { commitment: o.commitment, keep: o.maxSignatures ?? 200, maxPages: o.maxPages, limit: o.pageSize });
  if (!window.complete) return { transfers: [], last: o.cursor, scanned: 0, pageLimitHit: true, backlog: window.total };
  const transfers: EscrowTransfer[] = [];
  let last = o.cursor, scanned = 0;
  for (const s of window.signatures) {
    if (!s.err) {
      const tx = await withRetry(() => conn.getTransaction(s.signature, { commitment: o.commitment, maxSupportedTransactionVersion: 0 }));
      if (!tx) break; // not visible on this node yet: resume from here next pass instead of stepping over it
      transfers.push(...escrowTransfersOf(s.signature, tx as TxLike, o.mint.toBase58(), o.escrow.toBase58()));
    }
    last = s.signature;
    scanned++;
  }
  return { transfers, last, scanned, pageLimitHit: false, backlog: window.total };
}

// ---- The indexer --------------------------------------------------------------------------------------------------------

const cursorKey = (ctx: Ctx, commitment: string, mint: string) => `escrow-cursor:${ctx.cfg.chain.network}:${commitment}:${mint}`;
async function readCursor(ctx: Ctx, key: string): Promise<string | undefined> {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  return (row?.value as { signature?: string } | undefined)?.signature ?? undefined;
}
async function writeCursor(ctx: Ctx, key: string, signature: string) {
  await ctx.db.insert(kv).values({ key, value: { signature } }).onConflictDoUpdate({ target: kv.key, set: { value: { signature }, updatedAt: new Date() } });
}
const depositId = (t: EscrowTransfer) => `${t.txHash}:${t.logIndex}`;

/** Record new transfers as deposits; a transfer first seen at `confirmed` is `pending_finality`, at `finalized` `pending`. Returns the ids seen. */
async function recordTransfers(ctx: Ctx, t: AcceptedToken, transfers: EscrowTransfer[], commitment: "confirmed" | "finalized") {
  const ids: string[] = [];
  for (const tr of transfers) {
    const id = depositId(tr);
    ids.push(id);
    const [existing] = await ctx.db.select({ status: escrowDeposits.status }).from(escrowDeposits).where(eq(escrowDeposits.id, id));
    if (!existing) {
      await ctx.db.insert(escrowDeposits).values({ id, txHash: tr.txHash, logIndex: tr.logIndex, blockNumber: tr.blockNumber, token: t.address, symbol: t.symbol, fromAddress: tr.from, rawAmount: tr.value.toString(), status: commitment === "finalized" ? "pending" : "pending_finality", blockHash: tr.blockHash || null, accountId: escrowAccountId(tr.from) }).onConflictDoNothing();
    } else if (commitment === "finalized" && existing.status === "pending_finality") {
      // Finality reached: a provisional credit is settled, an uncredited row goes on to pricing.
      const settled = await settleFastDeposit(ctx, "escrow", tr.txHash, tr.logIndex, "final");
      await ctx.db.update(escrowDeposits).set({ status: settled?.status === "final" ? "credited" : "pending", checkedAt: new Date() }).where(eq(escrowDeposits.id, id));
    }
  }
  return ids;
}

/** Credit one priced deposit on the ledger (idempotent on the ref); the row then says `credited`. */
async function creditDeposit(ctx: Ctx, row: typeof escrowDeposits.$inferSelect, t: AcceptedToken, price: EscrowPrice, provisional: boolean) {
  const raw = BigInt(row.rawAmount);
  const credited = creditFor(raw, t, price.price18);
  const accountId = row.accountId ?? escrowAccountId(row.fromAddress);
  await ensureAccount(ctx.db, accountId, "wallet", row.fromAddress);
  if (credited > 0n) await post(ctx.db, { accountId, amount: credited, kind: ESCROW_KIND, ref: escrowRef(row.id), description: `${formatRaw(raw, t.decimals)} ${t.symbol} escrow deposit${provisional ? " (provisional)" : ""}` });
  await ctx.db.update(escrowDeposits).set({ status: provisional ? "pending_finality" : "credited", accountId, price18: price.price18.toString(), priceUpdatedAt: new Date(price.updatedAt * 1000), credited, creditedAt: new Date(), error: null }).where(eq(escrowDeposits.id, row.id));
  if (provisional) await recordFastDeposit(ctx, { accountId, lane: "escrow", txHash: row.txHash, logIndex: row.logIndex, amount: row.rawAmount, credited: credited.toString(), blockNumber: row.blockNumber.toString() });
  return credited;
}

/** Reverse a provisional credit whose transaction never finalized: a compensating debit, `reversed`, flagged for review. */
async function reverseDeposit(ctx: Ctx, row: typeof escrowDeposits.$inferSelect, reason: string) {
  const settled = await settleFastDeposit(ctx, "escrow", row.txHash, row.logIndex, "reversed");
  if (settled && row.credited && row.credited > 0n && row.accountId) await post(ctx.db, { accountId: row.accountId, amount: -row.credited, kind: ESCROW_KIND, ref: escrowReversalRef(row.id), description: `${row.symbol} escrow deposit reversed: ${reason}` });
  await ctx.db.update(escrowDeposits).set({ status: settled ? "reversed" : "orphaned", reversedAt: new Date(), reviewReason: reason, error: reason }).where(eq(escrowDeposits.id, row.id));
}

/**
 * One pass of the escrow indexer: walk each accepted token at finalized (and at confirmed with fast credit), price and
 * credit what is pending, settle or reverse provisional credits.
 */
export async function pollEscrow(ctx: Ctx, maxSignatures = 200) {
  if (!escrowEnabled(ctx)) return { skipped: "escrow not configured" };
  const conn = ctx.chain.connection;
  const escrow = new PublicKey(ctx.cfg.escrow.address!);
  const fast = ctx.cfg.fastCredit.enabled;
  let recorded = 0, scanned = 0, pageLimitHit = false;
  const finalizedSeen = new Set<string>();
  for (const t of acceptedTokens(ctx)) {
    const mint = new PublicKey(t.address);
    for (const commitment of fast ? (["finalized", "confirmed"] as const) : (["finalized"] as const)) {
      const key = cursorKey(ctx, commitment, t.address);
      try {
        const r = await scanEscrowTransfers(conn, { escrow, mint, cursor: await readCursor(ctx, key), commitment, maxSignatures });
        if (r.pageLimitHit) {
          pageLimitHit = true;
          log.error("escrow indexer: signature paging hit its page limit before reaching the cursor; nothing was scanned and the cursor did not move", { token: t.symbol, commitment, signatures_read: r.backlog });
          continue;
        }
        scanned += r.scanned;
        const ids = await recordTransfers(ctx, t, r.transfers, commitment);
        recorded += ids.length;
        if (commitment === "finalized") for (const id of ids) finalizedSeen.add(id);
        if (r.last && r.scanned) await writeCursor(ctx, key, r.last);
      } catch (e) {
        log.warn("escrow scan failed", { token: t.symbol, commitment, error: (e as Error).message.slice(0, 160) });
      }
    }
  }
  const credited = await creditPending(ctx);
  const reversed = await settleUnfinalized(ctx, finalizedSeen);
  return { scanned, recorded, page_limit_hit: pageLimitHit, ...credited, ...reversed };
}

/** Price and credit pending deposits; with fast credit, also pending_finality deposits within the caps (provisionally). */
async function creditPending(ctx: Ctx) {
  const rows = await ctx.db.select().from(escrowDeposits).where(and(inArray(escrowDeposits.status, ["pending", "pending_finality"]), isNull(escrowDeposits.credited))).orderBy(asc(escrowDeposits.blockNumber)).limit(200);
  let credited = 0, awaitingPrice = 0, provisional = 0;
  const prices = new Map<string, Awaited<ReturnType<typeof escrowPrice>>>();
  let trlsRoom: Pico | null = null;
  for (const row of rows) {
    const t = acceptedToken(ctx, row.token);
    if (!t) { await ctx.db.update(escrowDeposits).set({ error: "token_not_accepted" }).where(eq(escrowDeposits.id, row.id)); continue; }
    if (t.kind === "trls") {
      const problem = await trlsMintProblem(ctx.chain.connection, t).catch(() => "mint_missing" as const);
      if (problem) { awaitingPrice++; await ctx.db.update(escrowDeposits).set({ error: problem }).where(eq(escrowDeposits.id, row.id)); continue; }
    }
    if (!prices.has(t.address)) prices.set(t.address, await escrowPrice(ctx, t));
    const p = prices.get(t.address)!;
    if (!p.price) { awaitingPrice++; await ctx.db.update(escrowDeposits).set({ error: p.reason.code }).where(eq(escrowDeposits.id, row.id)); continue; }
    if (t.kind === "trls") {
      // The day's limit: a deposit that does not fit waits (uncredited, unburned) and is credited when there is room.
      const amount = creditFor(BigInt(row.rawAmount), t, p.price.price18);
      trlsRoom ??= await trlsRoomToday(ctx, t);
      if (amount > trlsRoom) { awaitingPrice++; await ctx.db.update(escrowDeposits).set({ error: "daily_limit" }).where(eq(escrowDeposits.id, row.id)); continue; }
      trlsRoom -= amount;
    }
    if (row.status === "pending_finality") {
      const amount = creditFor(BigInt(row.rawAmount), t, p.price.price18);
      if (!(await fastCreditAllows(ctx, row.accountId ?? escrowAccountId(row.fromAddress), amount))) continue; // waits for finality
      await creditDeposit(ctx, row, t, p.price, true);
      provisional++;
    } else {
      await creditDeposit(ctx, row, t, p.price, false);
      credited++;
    }
  }
  return { credited, provisional, awaiting_price: awaitingPrice };
}

/** Provisional deposits the finalized walk did not see once finality passed their slot by a margin: gone, so reversed (or orphaned). */
async function settleUnfinalized(ctx: Ctx, finalizedSeen: Set<string>) {
  const rows = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.status, "pending_finality")).limit(200);
  if (!rows.length) return { reversed: 0 };
  let fin: EscrowFinal;
  try { fin = await escrowFinality(ctx); } catch { return { reversed: 0 }; }
  const margin = BigInt(Math.max(32, ctx.cfg.fastCredit.confirmations));
  let reversed = 0;
  for (const row of rows) {
    if (finalizedSeen.has(row.id) || row.blockNumber + margin > fin.final) continue;
    const [status] = (await withRetry(() => ctx.chain.connection.getSignatureStatuses([row.txHash]))).value;
    if (status && !status.err && status.confirmationStatus === "finalized") {
      // Finalized after all (the finalized walk is behind): settle as final.
      const settled = await settleFastDeposit(ctx, "escrow", row.txHash, row.logIndex, "final");
      await ctx.db.update(escrowDeposits).set({ status: settled?.status === "final" ? "credited" : "pending", checkedAt: new Date() }).where(eq(escrowDeposits.id, row.id));
      continue;
    }
    if (status && !status.err) continue; // still confirmed, not yet final: wait
    await reverseDeposit(ctx, row, status?.err ? "transaction_failed" : "transaction_dropped");
    reversed++;
  }
  return { reversed };
}

/** Deposits flagged for an operator's review (a reversal) and not yet reconciled. */
export async function escrowReviewsOpen(db: Db): Promise<{ id: string; status: string; reason: string | null }[]> {
  const rows = await db.select({ id: escrowDeposits.id, status: escrowDeposits.status, reason: escrowDeposits.reviewReason }).from(escrowDeposits).where(and(isNotNull(escrowDeposits.reviewReason), isNull(escrowDeposits.reviewedAt))).limit(100);
  return rows;
}

export async function escrowInfo(ctx: Ctx) {
  if (!escrowEnabled(ctx)) return { enabled: false as const };
  const conn = ctx.chain.connection;
  const escrow = new PublicKey(ctx.cfg.escrow.address!);
  const tokens = [];
  for (const t of acceptedTokens(ctx)) {
    const account = await escrowTokenAccount(conn, escrow, new PublicKey(t.address)).then((a) => a.toBase58()).catch(() => null);
    // $TRLS: what has been burned so far and the transactions that did it (trls-burn.ts), so anyone can check the claim.
    const burn = t.kind === "trls" ? await burnState(ctx, t.address).catch(() => null) : null;
    tokens.push({ symbol: t.symbol, address: t.address, decimals: t.decimals, haircut_bps: t.haircutBps, kind: t.kind, deposit_account: account, max_usd_per_deposit: t.maxCredit === null ? null : picoToUsd(t.maxCredit), ...(t.kind === "trls" ? { max_usd_per_day: t.trls.maxUsdPerDay, burned: burn ? formatRaw(BigInt(burn.burned), t.decimals) : null, burns: (burn?.txs ?? []).slice(-5).reverse().map((b) => ({ tx: b.signature, amount: formatRaw(BigInt(b.amount), t.decimals), at: b.at })) } : {}) });
  }
  const fin = await escrowFinality(ctx).catch(() => null);
  return { enabled: true as const, address: ctx.cfg.escrow.address, finality: ctx.cfg.escrow.finality, tokens, head_slot: fin?.head.toString() ?? null, final_slot: fin?.final.toString() ?? null, fast_credit: ctx.cfg.fastCredit.enabled, note: "Send an accepted token from your own wallet to its deposit account; the sending wallet's account is credited once the slot is finalized." };
}

export type EscrowStage = "provisional" | "confirming" | "awaiting_price" | "crediting" | "credited" | "orphaned" | "reversed";
export const escrowStage = (status: EscrowStatus, awaitingPrice: boolean, provisional = false): EscrowStage =>
  status === "pending_finality" ? (provisional ? "provisional" : "confirming") : status === "pending" ? (awaitingPrice ? "awaiting_price" : "crediting") : status;

export type EscrowDepositView = { id: string; token: string; symbol: string | null; amount: string; credited_usd: number | null; status: EscrowStatus; stage: EscrowStage; block: string; tx_hash: string; reason: string | null };
export async function escrowDepositsFor(ctx: Ctx, accountId: string, limit = 50): Promise<EscrowDepositView[]> {
  const rows = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.accountId, accountId)).orderBy(desc(escrowDeposits.blockNumber)).limit(limit);
  return rows.map((r) => {
    const t = acceptedToken(ctx, r.token);
    const status = r.status as EscrowStatus;
    return { id: r.id, token: r.token, symbol: r.symbol, amount: t ? formatRaw(BigInt(r.rawAmount), t.decimals) : r.rawAmount, credited_usd: r.credited === null ? null : picoToUsd(r.credited), status, stage: escrowStage(status, !!r.error && r.credited === null, r.credited !== null), block: r.blockNumber.toString(), tx_hash: r.txHash, reason: r.reviewReason ?? r.error ?? null };
  });
}

export function usdcSummary(ctx: Ctx) {
  const u = ctx.cfg.usdcEscrow;
  if (!u || !escrowEnabled(ctx)) return { enabled: false, haircut_bps: null, max_usd_per_deposit: null };
  return { enabled: true, haircut_bps: u.haircutBps, max_usd_per_deposit: u.maxUsdPerDeposit };
}

/** $TRLS escrow terms for public status and payment instructions; null when TRLS is not accepted. */
export function trlsSummary(ctx: Ctx) {
  const a = ctx.cfg.trlsEscrow;
  if (!a || !escrowEnabled(ctx)) return null;
  return { symbol: a.symbol, address: a.address, decimals: a.decimals, haircut_bps: a.haircutBps, max_usd_per_deposit: a.maxUsdPerDeposit, max_usd_per_day: a.maxUsdPerDay, price_source: "window_low" as const, window_minutes: Math.round(a.price.windowSeconds / 60), market: a.price.vaults ? ("pool" as const) : ("launch_curve" as const) };
}

/** The rate $TRLS deposits are credited at right now, or why there is none. */
export async function trlsPriceInfo(ctx: Ctx) {
  const a = ctx.cfg.trlsEscrow;
  if (!a || !escrowEnabled(ctx)) return { enabled: false as const };
  const q = await trlsQuote(ctx);
  if (!q.available) return { enabled: true as const, symbol: a.symbol, available: false as const, reason: { code: q.code, message: q.message } };
  return { enabled: true as const, symbol: a.symbol, available: true as const, usd_per_token: q.conservative, spot: q.spot, average: q.average, window_seconds: q.windowSeconds, samples: q.samples, haircut_bps: a.haircutBps };
}
