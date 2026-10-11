import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { AddressLookupTableAccount, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getScaledUiAmountConfig, unpackAccount, unpackMint } from "@solana/spl-token";
import type { Ctx } from "../context.ts";
import { kv, paywithDebts, paywithSwaps, type keys } from "../db/schema.ts";
import { post as postLedger } from "../ledger/ledger.ts";
import { fail } from "../lib/errors.ts";
import type { Pico } from "../lib/money.ts";
import { PICO_PER_USD, picoToUsd, picoToUsdc, usdToPico, usdcToPico } from "../lib/money.ts";
import { decrypt, encrypt, log, uid } from "../lib/util.ts";
import { ADDRESS_RE, base58Decode, base58Encode } from "./constants.ts";
import { confirmSignature, withRetry } from "./rpc.ts";
import { authorizeSessionInstructions, jupiterInstruction, readSwig, revokeSessionInstructions, sessionLive, sessionRole, sessionTransaction, signWithSession, swigAddressFor, swigIdFor, type JupiterInstruction, type SwigState } from "./swig.ts";
import { parseTokenAmount } from "./tiers.ts";

// Pay with a tokenized stock (docs/Trellis_Backend.md §6). `X-Pay-With: <mint or symbol>` bills a key's usage to a
// pay-with session instead of its prepaid balance: usage accrues as debt (paywith_debts), and the aggregator job swaps
// the token for exactly the USDC owed through Jupiter (ExactOut) once the debt reaches PAYWITH_THRESHOLD_USD or is
// PAYWITH_MAX_AGE_H old, with the USDC landing in the router's payTo account.
//
// The session is one of two signers, PAYWITH_SESSION_MODE:
//   `swig` (docs §6, the production path): the owner authorises a Swig smart-wallet role for the router's per-key session
//   key, with the per-day token cap on the stock mint enforced by the Swig program (src/solana/swig.ts). The tokens stay in
//   the owner's Swig wallet; the router signs Jupiter ExactOut swaps as inner instructions of a Swig `sign` with the session
//   key. Opening a session hands the owner the unsigned authorise transaction (create the wallet if needed, add the role,
//   start the session); closing it hands back an unsigned remove_authority.
//   `delegate` (fallback): a per-key delegate keypair with a per-day cap tracked by the router, held sealed (APP_SECRET)
//   in the kv table; the owner funds the delegate's token account (and a little SOL for fees) and closing the session
//   sends the rest back.
// Both keep the sealed session secret in kv and share the quote / price-sanity / guard / fallback pipeline below; only
// the signer and the way the cap is enforced differ. A session records the mode it was opened in.
//
// Guards: Token-2022 Scaled UI Amount (a multiplier change effective within 24h of now -> fall back to credits), price
// sanity (the Jupiter fill must be within PAYWITH_MAX_SLIP_BPS of raw x multiplier x Pyth price), the daily cap, the open
// debt ceiling (PAYWITH_MAX_DEBT_USD). A swap that fails after the debt is past its age is charged to the key's prepaid
// credits instead; when those run out the next request is a 402 (docs §6: failure -> prepaid credits -> 402).
//
// Every network call goes through `paywithDeps.fetch`, so tests run offline with fixtures.

type KeyRow = typeof keys.$inferSelect;
export type PaywithGrant = { symbol: string; token: string; decimals: number; fairPrice18: bigint; creditLine: Pico; multiplier: number };

export const MAX_AUTHORIZATION_WINDOW_S = 7 * 86_400;
export const CHARGE_TTL_S = 24 * 3_600;
export const SCALED_UI_GUARD_S = 24 * 3_600;
export const PAYWITH_KIND = "paywith";
export const FALLBACK_SWAP_ID = "credits";
/** How many consecutive swap failures a batch may have before its debts are charged to prepaid credits (docs §6). */
export const MAX_SWAP_FAILURES = 3;

/** Injectable network calls (Jupiter, Pyth); tests replace `fetch`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const paywithDeps: { fetch: FetchLike; now: () => number } = { fetch: (input, init) => globalThis.fetch(input, init), now: () => Date.now() };

// ---- Sessions ----------------------------------------------------------------------------------------------------------

export type PaywithSessionMode = "delegate" | "swig";
export type PaywithSession = {
  chainKeyHash: string;
  /** The owner's wallet: the Swig role's root key (swig), or where a closed session sends what is left (delegate). */
  wallet: string;
  token: string;
  symbol: string;
  decimals: number;
  /** The session key (the delegate in delegate mode): its address, and its secret sealed under APP_SECRET. */
  delegate: string;
  delegateEnc: string;
  capRawPerDay: string;
  spentRawToday: string;
  dayStart: string; // ISO day the counter belongs to
  active: boolean;
  createdAt: string;
  closedAt: string | null;
  /** delegate: the refund transaction's signature. swig: null (nothing to send back). */
  closeTx: string | null;
  /** Sessions opened before the mode existed are delegate sessions. */
  mode?: PaywithSessionMode;
  /** swig: the owner's Swig wallet (PDA of swigId), the role id the authorise transaction creates, and the unsigned transactions the owner signs. */
  swig?: string;
  swigId?: string;
  roleId?: number;
  authorizeTx?: string | null;
  revokeTx?: string | null;
};
export const sessionMode = (s: Pick<PaywithSession, "mode">): PaywithSessionMode => s.mode ?? "delegate";

export const sessionKey = (network: string, chainKeyHash: string) => `paywith-session:${network}:${chainKeyHash}`;

export async function readSession(ctx: Ctx, chainKeyHash: string): Promise<PaywithSession | null> {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, sessionKey(ctx.cfg.chain.network, chainKeyHash)));
  return (row?.value as PaywithSession | undefined) ?? null;
}
async function writeSession(ctx: Ctx, s: PaywithSession) {
  await ctx.db.insert(kv).values({ key: sessionKey(ctx.cfg.chain.network, s.chainKeyHash), value: s }).onConflictDoUpdate({ target: kv.key, set: { value: s, updatedAt: new Date() } });
  return s;
}

/** The configured token named by a mint address or a symbol (case-insensitive), or null. */
export function tokenFor(ctx: Ctx, nameOrMint: string) {
  const v = nameOrMint.trim();
  return ctx.cfg.paywith.tokens.find((t) => t.address === v || t.symbol.toLowerCase() === v.toLowerCase()) ?? null;
}

/** The delegate's Keypair (never logged; the secret lives only in the sealed kv value). */
export function delegateKeypair(ctx: Ctx, s: PaywithSession): Keypair {
  return Keypair.fromSecretKey(base58Decode(decrypt(ctx.cfg.appSecret, s.delegateEnc)));
}

/**
 * Open (or replace) the key's pay-with session: a fresh session keypair with a per-day cap in the token. In swig mode the
 * session also carries the owner's unsigned authorise transaction (fee payer = the owner's wallet); `o.swig` names an
 * existing Swig wallet of the owner's instead of the one Trellis derives for the key.
 */
export async function openSession(ctx: Ctx, key: KeyRow, o: { token: string; wallet: string; capPerDay: string; swig?: string }): Promise<PaywithSession> {
  const token = tokenFor(ctx, o.token);
  if (!token) fail(400, `Unknown pay-with token ${o.token}: this router accepts ${ctx.cfg.paywith.tokens.map((t) => t.symbol).join(", ") || "none"}.`, "invalid_request");
  if (!ADDRESS_RE.test(o.wallet)) fail(400, "wallet must be the owner's base58 Solana address (where a closed session refunds).", "invalid_request");
  let cap: bigint;
  try { cap = parseTokenAmount(o.capPerDay, token.decimals); } catch { fail(400, "cap_per_day must be a decimal token amount.", "invalid_request"); }
  if (cap! <= 0n) fail(400, "cap_per_day must be above 0.", "invalid_request");
  const maxCapUsd = ctx.cfg.paywith.maxDailyCapUsd;
  if (maxCapUsd !== null && token.feed) {
    const fair = await fairPrice(ctx, token.address).catch(() => null);
    if (fair && picoToUsd(rawToPico(cap!, token.decimals, fair)) > maxCapUsd) fail(400, `cap_per_day is worth more than the PAYWITH_MAX_DAILY_CAP_USD ceiling of $${maxCapUsd}.`, "invalid_request");
  }
  const existing = await readSession(ctx, key.chainKeyHash);
  if (existing?.active) fail(409, "This key already has an open pay-with session; close it first.", "paywith_session_open");
  if (o.swig !== undefined && !ADDRESS_RE.test(o.swig)) fail(400, "swig must be the base58 address of the owner's Swig wallet.", "invalid_request");
  const kp = Keypair.generate();
  const mode = ctx.cfg.paywith.sessionMode;
  const s: PaywithSession = {
    chainKeyHash: key.chainKeyHash, wallet: o.wallet, token: token.address, symbol: token.symbol, decimals: token.decimals,
    delegate: kp.publicKey.toBase58(), delegateEnc: encrypt(ctx.cfg.appSecret, base58Encode(kp.secretKey)),
    capRawPerDay: cap!.toString(), spentRawToday: "0", dayStart: new Date(paywithDeps.now()).toISOString().slice(0, 10), active: true, createdAt: new Date(paywithDeps.now()).toISOString(), closedAt: null, closeTx: null,
    mode,
  };
  if (mode === "swig") Object.assign(s, await swigAuthorization(ctx, { owner: new PublicKey(o.wallet), chainKeyHash: key.chainKeyHash, sessionKey: kp.publicKey, mint: new PublicKey(token.address), capRaw: cap!, swig: o.swig }));
  return writeSession(ctx, s);
}

/**
 * The swig half of a new session: the owner's Swig wallet (the one Trellis derives for the key unless `swig` names another),
 * the role id the authorise transaction creates, and that transaction, unsigned, base64, fee payer = owner.
 */
async function swigAuthorization(ctx: Ctx, a: { owner: PublicKey; chainKeyHash: string; sessionKey: PublicKey; mint: PublicKey; capRaw: bigint; swig?: string }): Promise<Pick<PaywithSession, "swig" | "swigId" | "roleId" | "authorizeTx" | "revokeTx">> {
  const conn = ctx.chain.connection;
  const id = swigIdFor(ctx.cfg.chain.network, a.chainKeyHash);
  const address = a.swig ? new PublicKey(a.swig) : swigAddressFor(id);
  let state: SwigState | null;
  try { state = await readSwig(conn, address); } catch (e) { fail(400, `swig: ${(e as Error).message}.`, "invalid_request"); }
  if (a.swig && !state!) fail(400, "swig names an account that is not an existing Swig wallet; omit it to let Trellis derive one for this key.", "invalid_request");
  const [slot, { blockhash }] = await Promise.all([withRetry(() => conn.getSlot(ctx.cfg.solana.commitment)), withRetry(() => conn.getLatestBlockhash(ctx.cfg.solana.commitment))]);
  let built: Awaited<ReturnType<typeof authorizeSessionInstructions>>;
  try {
    built = await authorizeSessionInstructions({ owner: a.owner, id: state ? new Uint8Array(state.swig.id) : id, state, sessionKey: a.sessionKey, mint: a.mint, capRawPerDay: a.capRaw, currentSlot: BigInt(slot) });
  } catch (e) {
    fail(400, `The Swig wallet cannot take a Trellis role: ${(e as Error).message}.`, "invalid_request");
  }
  const tx = new Transaction({ feePayer: a.owner, recentBlockhash: blockhash }).add(...built!.instructions);
  return { swig: built!.swig.toBase58(), swigId: Buffer.from(state ? state.swig.id : id).toString("hex"), roleId: built!.roleId, authorizeTx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), revokeTx: null };
}

/**
 * Close the session: nothing more is billed to it. delegate: what the delegate still holds goes back to the owner's
 * wallet (best effort). swig: the tokens never left the owner's wallet; the owner gets an unsigned remove_authority for
 * the Trellis role (best effort: null when the role was never authorised).
 */
export async function closeSession(ctx: Ctx, chainKeyHash: string): Promise<PaywithSession> {
  const s = await readSession(ctx, chainKeyHash);
  if (!s || !s.active) fail(404, "No open pay-with session for this key.", "not_found");
  let closeTx: string | null = null;
  let revokeTx: string | null = null;
  try {
    if (sessionMode(s) === "swig") revokeTx = await swigRevocation(ctx, s);
    else closeTx = await refundDelegate(ctx, s);
  } catch (e) {
    log.warn("pay-with session close step failed", { mode: sessionMode(s), error: (e as Error).message.slice(0, 160) });
  }
  return writeSession(ctx, { ...s, active: false, closedAt: new Date(paywithDeps.now()).toISOString(), closeTx, ...(sessionMode(s) === "swig" ? { revokeTx } : {}) });
}

/** The owner's unsigned remove_authority for the session's Swig role, or null when the chain holds no such role. */
async function swigRevocation(ctx: Ctx, s: PaywithSession): Promise<string | null> {
  const conn = ctx.chain.connection;
  const state = await readSwig(conn, new PublicKey(s.swig!));
  const role = state && sessionRole(state, new PublicKey(s.delegate), new PublicKey(s.token));
  if (!state || !role) return null;
  const [slot, { blockhash }] = await Promise.all([withRetry(() => conn.getSlot(ctx.cfg.solana.commitment)), withRetry(() => conn.getLatestBlockhash(ctx.cfg.solana.commitment))]);
  const ixs = await revokeSessionInstructions({ state, role, currentSlot: BigInt(slot) });
  return new Transaction({ feePayer: role.owner, recentBlockhash: blockhash }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/** Send the delegate's remaining tokens back to the owner's wallet. Returns the signature, or null when nothing was held. */
async function refundDelegate(ctx: Ctx, s: PaywithSession): Promise<string | null> {
  const { createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
  const { Transaction } = await import("@solana/web3.js");
  const mint = new PublicKey(s.token);
  const program = await tokenProgramOf(ctx, mint);
  const kp = delegateKeypair(ctx, s);
  const from = getAssociatedTokenAddressSync(mint, kp.publicKey, true, program);
  const info = await withRetry(() => ctx.chain.connection.getAccountInfo(from));
  const held = info ? unpackAccount(from, info as never, program).amount : 0n;
  if (held <= 0n) return null;
  const owner = new PublicKey(s.wallet);
  const to = getAssociatedTokenAddressSync(mint, owner, true, program);
  const tx = new Transaction({ feePayer: kp.publicKey });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, to, owner, mint, program), createTransferCheckedInstruction(from, mint, to, kp.publicKey, held, s.decimals, [], program));
  const { sendAndConfirm } = await import("./rpc.ts");
  return (await sendAndConfirm(ctx.chain.connection, tx, [kp], ctx.cfg.solana.commitment)).signature;
}

export function sessionJson(s: PaywithSession) {
  const mode = sessionMode(s);
  const base = { mode, token: s.token, symbol: s.symbol, decimals: s.decimals, delegate: s.delegate, session_key: s.delegate, wallet: s.wallet, cap_per_day_raw: s.capRawPerDay, spent_today_raw: s.spentRawToday, day: s.dayStart, active: s.active, created_at: s.createdAt, closed_at: s.closedAt, close_tx: s.closeTx };
  if (mode === "swig") {
    return {
      ...base,
      swig: s.swig ?? null, swig_id: s.swigId ?? null, role_id: s.roleId ?? null,
      authorize_transaction: s.authorizeTx ?? null, revoke_transaction: s.revokeTx ?? null,
      fund: `Sign authorize_transaction with ${s.wallet} (it creates your Swig wallet ${s.swig} if needed, adds a Trellis role capped at the daily amount in ${s.symbol}, and starts the session); keep ${s.symbol} in the Swig wallet and send a little SOL for fees to the session key ${s.delegate}. Closing the session hands you revoke_transaction; your tokens never leave your wallet.`,
    };
  }
  return { ...base, fund: `Send ${s.symbol} (up to the daily cap) and a little SOL for fees to ${s.delegate}; close the session to get the rest back.` };
}

// ---- Mint reads: token program and the Scaled UI Amount guard ----------------------------------------------------------------

const mintCache = new Map<string, { at: number; program: PublicKey; decimals: number; scaled: { multiplier: number; newMultiplier: number; effectiveAt: bigint } | null }>();
export const clearMintCache = () => mintCache.clear();

async function readMint(ctx: Ctx, mint: PublicKey) {
  const k = `${ctx.cfg.chain.network}:${mint.toBase58()}`;
  const hit = mintCache.get(k);
  if (hit && paywithDeps.now() - hit.at < 3_600_000) return hit;
  const info = await withRetry(() => ctx.chain.connection.getAccountInfo(mint));
  if (!info) throw new Error("mint account not found");
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = unpackMint(mint, info as never, program);
  const cfg = program.equals(TOKEN_2022_PROGRAM_ID) ? getScaledUiAmountConfig(m) : null;
  const entry = { at: paywithDeps.now(), program, decimals: m.decimals, scaled: cfg ? { multiplier: cfg.multiplier, newMultiplier: cfg.newMultiplier, effectiveAt: BigInt(cfg.newMultiplierEffectiveTimestamp) } : null };
  mintCache.set(k, entry);
  return entry;
}

export const tokenProgramOf = async (ctx: Ctx, mint: PublicKey) => (await readMint(ctx, mint)).program;

export type ScaledUiCheck = { ok: true; multiplier: number } | { ok: false; reason: "multiplier_change_pending" | "mint_unreadable"; effectiveAt?: string };

/**
 * The Scaled UI Amount guard (docs §6): the multiplier in force now, or a refusal when `new_multiplier_effective_timestamp`
 * is within 24 hours of now (either side): a split or reverse split landing around the swap makes the UI amount unreliable.
 */
export async function scaledUiGuard(ctx: Ctx, mint: string, now = Math.floor(paywithDeps.now() / 1000)): Promise<ScaledUiCheck> {
  let m: Awaited<ReturnType<typeof readMint>>;
  try { m = await readMint(ctx, new PublicKey(mint)); } catch { return { ok: false, reason: "mint_unreadable" }; }
  if (!m.scaled) return { ok: true, multiplier: 1 };
  const eff = Number(m.scaled.effectiveAt);
  if (eff > 0 && Math.abs(eff - now) <= SCALED_UI_GUARD_S) return { ok: false, reason: "multiplier_change_pending", effectiveAt: new Date(eff * 1000).toISOString() };
  return { ok: true, multiplier: eff > 0 && now >= eff ? m.scaled.newMultiplier : m.scaled.multiplier };
}

// ---- Oracle (Pyth Hermes) ------------------------------------------------------------------------------------------------

const fairCache = new Map<string, { at: number; price18: bigint }>();
export const clearFairCache = () => fairCache.clear();
export const FAIR_TTL_MS = 60_000;

/** USD per whole UI token with 18 decimals from Pyth Hermes (the token's `feed` id), cached a minute; null without a feed or on failure. */
export async function fairPrice(ctx: Ctx, token: string): Promise<bigint | null> {
  const t = ctx.cfg.paywith.tokens.find((x) => x.address === token);
  if (!t?.feed) return null;
  const hit = fairCache.get(t.feed);
  if (hit && paywithDeps.now() - hit.at < FAIR_TTL_MS) return hit.price18;
  try {
    const res = await paywithDeps.fetch(`${ctx.cfg.paywith.pythUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(pythFeedId(t.feed))}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { parsed?: { id: string; price: { price: string; expo: number; publish_time: number } }[] };
    const p = j.parsed?.[0]?.price;
    if (!p || !/^-?\d+$/.test(String(p.price))) return null;
    if (Math.abs(Math.floor(paywithDeps.now() / 1000) - Number(p.publish_time)) > ctx.cfg.escrow.maxPriceAgeS) return null;
    const price18 = scalePrice(BigInt(p.price), Number(p.expo));
    if (price18 <= 0n) return null;
    fairCache.set(t.feed, { at: paywithDeps.now(), price18 });
    return price18;
  } catch {
    return null;
  }
}

/** A Pyth feed id as Hermes names it (0x + 64 hex); a base58 32-byte feed address is converted. */
export const pythFeedId = (feed: string) => (/^0x[0-9a-fA-F]{64}$/.test(feed) ? feed.toLowerCase() : "0x" + Buffer.from(base58Decode(feed)).toString("hex"));

/** price x 10^expo as an 18-decimal integer. */
export const scalePrice = (price: bigint, expo: number) => (expo >= -18 ? price * 10n ** BigInt(18 + expo) : price / 10n ** BigInt(-18 - expo));

/** Raw units of a token (with a UI multiplier) worth `pico`, and back. fair18 is USD per whole UI token. */
export const rawToPico = (raw: bigint, decimals: number, fair18: bigint, multiplier = 1) => (raw * fair18 * PICO_PER_USD * mul18(multiplier)) / (10n ** BigInt(decimals) * 10n ** 18n * 10n ** 18n);
export const picoToRaw = (pico: Pico, decimals: number, fair18: bigint, multiplier = 1) => {
  const den = fair18 * PICO_PER_USD * mul18(multiplier);
  return (pico * 10n ** BigInt(decimals) * 10n ** 18n * 10n ** 18n + den - 1n) / den;
};
const mul18 = (m: number) => BigInt(Math.round(m * 1e9)) * 10n ** 9n;

// ---- Grants and debt -----------------------------------------------------------------------------------------------------

export async function openDebt(ctx: Ctx, chainKeyHash: string): Promise<Pico> {
  const rows = await ctx.db.select({ amount: paywithDebts.amount }).from(paywithDebts).where(and(eq(paywithDebts.chainKeyHash, chainKeyHash), isNull(paywithDebts.swapId)));
  return rows.reduce((s, r) => s + r.amount, 0n);
}

/**
 * Whether this key may bill the request to `symbol` (a symbol or mint): an active session in that token, the mint's
 * Scaled UI guard, an oracle price, headroom under the daily cap and the open-debt ceiling. Otherwise the reason, and
 * the call falls back to prepaid credits.
 */
export async function grantFor(ctx: Ctx, key: KeyRow, symbol: string): Promise<{ grant: PaywithGrant | null; reason?: string }> {
  const token = tokenFor(ctx, symbol);
  if (!token) return { grant: null, reason: `Paying with ${symbol} is not available on this router. Use prepaid credits.` };
  const s = await readSession(ctx, key.chainKeyHash);
  if (!s || !s.active || s.token !== token.address) return { grant: null, reason: `No open ${token.symbol} pay-with session for this key (POST /api/v1/paywith/session). Charged to prepaid credits.` };
  const guard = await scaledUiGuard(ctx, token.address);
  if (!guard.ok) return { grant: null, reason: guard.reason === "multiplier_change_pending" ? `${token.symbol}'s UI multiplier changes at ${guard.effectiveAt}; pay-with pauses for 24 hours around it. Charged to prepaid credits.` : `${token.symbol}'s mint could not be read. Charged to prepaid credits.` };
  const fair = await fairPrice(ctx, token.address);
  if (!fair) return { grant: null, reason: `No current oracle price for ${token.symbol}. Charged to prepaid credits.` };
  const debt = await openDebt(ctx, key.chainKeyHash);
  const maxDebt = usdToPico(ctx.cfg.paywith.maxDebtUsd, "floor");
  if (debt >= maxDebt) return { grant: null, reason: `Open ${token.symbol} debt of $${picoToUsd(debt)} is at the ceiling of $${ctx.cfg.paywith.maxDebtUsd} until the next swap. Charged to prepaid credits.` };
  const today = rollDay(s);
  const headroomRaw = BigInt(today.capRawPerDay) - BigInt(today.spentRawToday);
  if (headroomRaw <= 0n) return { grant: null, reason: `The ${token.symbol} session's daily cap is spent. Charged to prepaid credits.` };
  const headroom = rawToPico(headroomRaw, token.decimals, fair, guard.multiplier);
  const haircut = (headroom * BigInt(10_000 - ctx.cfg.paywith.capHaircutBps)) / 10_000n;
  const creditLine = minPico(maxDebt - debt, haircut);
  if (creditLine <= 0n) return { grant: null, reason: `The ${token.symbol} session cannot cover more usage today. Charged to prepaid credits.` };
  return { grant: { symbol: token.symbol, token: token.address, decimals: token.decimals, fairPrice18: fair, creditLine, multiplier: guard.multiplier } };
}
const minPico = (a: Pico, b: Pico) => (a < b ? a : b);

/** The session's day counter, rolled to today when the day changed (not written: the aggregator writes). */
function rollDay(s: PaywithSession) {
  const day = new Date(paywithDeps.now()).toISOString().slice(0, 10);
  return s.dayStart === day ? s : { ...s, dayStart: day, spentRawToday: "0" };
}

/** Record a settled call as debt on the session; returns the raw estimate at the fair price. */
export async function recordDebt(ctx: Ctx, d: { key: KeyRow; generationId: string; amount: Pico; grant: PaywithGrant }): Promise<bigint> {
  const raw = picoToRaw(d.amount, d.grant.decimals, d.grant.fairPrice18, d.grant.multiplier);
  if (d.amount > 0n) await ctx.db.insert(paywithDebts).values({ id: uid("pwd_"), chainKeyHash: d.key.chainKeyHash, accountId: d.key.accountId, generationId: d.generationId, token: d.grant.token, amount: d.amount, rawEstimate: raw, fairPrice18: d.grant.fairPrice18.toString() });
  return raw;
}

export async function forgetAllowance(ctx: Ctx, chainKeyHash: string) {
  const s = await readSession(ctx, chainKeyHash);
  if (s?.active) await writeSession(ctx, { ...s, active: false, closedAt: new Date(paywithDeps.now()).toISOString() });
}

// ---- Jupiter ---------------------------------------------------------------------------------------------------------------

export type JupiterQuote = { inAmount: bigint; outAmount: bigint; raw: Record<string, unknown> };

/** GET /swap/v1/quote with swapMode=ExactOut: how much `inputMint` buys exactly `outAmount` of `outputMint`. */
export async function jupiterQuote(ctx: Ctx, q: { inputMint: string; outputMint: string; outAmount: bigint; slippageBps: number }): Promise<JupiterQuote> {
  const url = new URL(`${ctx.cfg.paywith.jupiterUrl}/swap/v1/quote`);
  url.searchParams.set("inputMint", q.inputMint);
  url.searchParams.set("outputMint", q.outputMint);
  url.searchParams.set("amount", q.outAmount.toString());
  url.searchParams.set("swapMode", "ExactOut");
  url.searchParams.set("slippageBps", String(q.slippageBps));
  const res = await paywithDeps.fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jupiter quote answered ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  if (typeof j.inAmount !== "string" || typeof j.outAmount !== "string" || !/^\d+$/.test(j.inAmount) || !/^\d+$/.test(j.outAmount)) throw new Error("jupiter quote is malformed");
  return { inAmount: BigInt(j.inAmount), outAmount: BigInt(j.outAmount), raw: j };
}

/** POST /swap/v1/swap: the transaction for a quote, signed by `userPublicKey`, with the USDC sent to `destinationTokenAccount`. */
export async function jupiterSwapTransaction(ctx: Ctx, quote: JupiterQuote, userPublicKey: string, destinationTokenAccount: string): Promise<VersionedTransaction> {
  const res = await paywithDeps.fetch(`${ctx.cfg.paywith.jupiterUrl}/swap/v1/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: quote.raw, userPublicKey, destinationTokenAccount, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jupiter swap answered ${res.status}`);
  const j = (await res.json()) as { swapTransaction?: string };
  if (typeof j.swapTransaction !== "string") throw new Error("jupiter swap answer carries no transaction");
  return VersionedTransaction.deserialize(new Uint8Array(Buffer.from(j.swapTransaction, "base64")));
}

/** A route from POST /swap/v1/swap-instructions: the pieces of the swap as instructions, for a Swig `sign` to wrap. */
export type JupiterRoute = { computeBudget: import("@solana/web3.js").TransactionInstruction[]; setup: import("@solana/web3.js").TransactionInstruction[]; swap: import("@solana/web3.js").TransactionInstruction; cleanup: import("@solana/web3.js").TransactionInstruction[]; lookupTables: string[] };

/** POST /swap/v1/swap-instructions: the swap for a quote as separate instructions, `userPublicKey` being the Swig wallet. */
export async function jupiterSwapInstructions(ctx: Ctx, quote: JupiterQuote, userPublicKey: string, destinationTokenAccount: string): Promise<JupiterRoute> {
  const res = await paywithDeps.fetch(`${ctx.cfg.paywith.jupiterUrl}/swap/v1/swap-instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: quote.raw, userPublicKey, destinationTokenAccount, wrapAndUnwrapSol: false, dynamicComputeUnitLimit: true }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jupiter swap-instructions answered ${res.status}`);
  const j = (await res.json()) as { computeBudgetInstructions?: JupiterInstruction[]; setupInstructions?: JupiterInstruction[]; swapInstruction?: JupiterInstruction; cleanupInstruction?: JupiterInstruction | null; addressLookupTableAddresses?: string[] };
  if (!j.swapInstruction || typeof j.swapInstruction.programId !== "string" || !Array.isArray(j.swapInstruction.accounts)) throw new Error("jupiter swap-instructions answer carries no swap instruction");
  const list = (v: JupiterInstruction[] | undefined) => (Array.isArray(v) ? v.map(jupiterInstruction) : []);
  return { computeBudget: list(j.computeBudgetInstructions), setup: list(j.setupInstructions), swap: jupiterInstruction(j.swapInstruction), cleanup: j.cleanupInstruction ? [jupiterInstruction(j.cleanupInstruction)] : [], lookupTables: Array.isArray(j.addressLookupTableAddresses) ? j.addressLookupTableAddresses.filter((a): a is string => typeof a === "string") : [] };
}

/** The address lookup tables a route compiles against (none on a connection that cannot read them, as in tests). */
async function lookupTables(ctx: Ctx, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const conn = ctx.chain.connection;
  if (!addresses.length) return [];
  if (!conn.getAddressLookupTable) throw new Error("the RPC connection cannot read address lookup tables");
  const out: AddressLookupTableAccount[] = [];
  for (const a of addresses) {
    const r = await withRetry(() => conn.getAddressLookupTable!(new PublicKey(a)));
    if (!r.value) throw new Error(`address lookup table ${a} not found`);
    out.push(r.value);
  }
  return out;
}

/**
 * Price sanity (docs §6): the fill (`inRaw` for `outUsdc`) must be within `maxSlipBps` of the oracle value
 * raw x multiplier x price. Returns the deviation in bps (positive = paying more than fair).
 */
export function fillDeviationBps(inRaw: bigint, decimals: number, fair18: bigint, multiplier: number, outUsdc: bigint): number {
  const fairPico = rawToPico(inRaw, decimals, fair18, multiplier);
  const owedPico = usdcToPico(outUsdc);
  if (owedPico <= 0n) return 0;
  return Number(((fairPico - owedPico) * 10_000n) / owedPico);
}

// ---- The aggregator job ----------------------------------------------------------------------------------------------------

export type AggregatorResult = { batches: number; swapped: number; failed: number; fallback: number; skipped?: string };

/** The "paywith-aggregator" job: swap each key's open debt once it reaches the threshold or the age limit. */
export async function runPaywithAggregator(ctx: Ctx, now = paywithDeps.now()): Promise<AggregatorResult> {
  const out: AggregatorResult = { batches: 0, swapped: 0, failed: 0, fallback: 0 };
  if (!ctx.cfg.paywith.tokens.length) return { ...out, skipped: "no pay-with tokens configured" };
  const open = await ctx.db.select().from(paywithDebts).where(isNull(paywithDebts.swapId)).orderBy(asc(paywithDebts.createdAt));
  const byKey = new Map<string, typeof open>();
  for (const d of open) byKey.set(d.chainKeyHash, [...(byKey.get(d.chainKeyHash) ?? []), d]);
  const threshold = usdToPico(ctx.cfg.paywith.thresholdUsd, "floor");
  const maxAgeMs = ctx.cfg.paywith.maxAgeH * 3_600_000;
  for (const [chainKeyHash, debts] of byKey) {
    const total = debts.reduce((s, d) => s + d.amount, 0n);
    const oldest = Math.min(...debts.map((d) => d.createdAt.getTime()));
    if (total < threshold && now - oldest < maxAgeMs) continue;
    out.batches++;
    const r = await settleBatch(ctx, chainKeyHash, debts, now);
    if (r === "swapped") out.swapped++;
    else if (r === "fallback") out.fallback++;
    else out.failed++;
  }
  return out;
}

async function settleBatch(ctx: Ctx, chainKeyHash: string, debts: (typeof paywithDebts.$inferSelect)[], now: number): Promise<"swapped" | "failed" | "fallback"> {
  const total = debts.reduce((s, d) => s + d.amount, 0n);
  const usdcOut = picoToUsdc(total, "ceil");
  const token = debts[0].token;
  const t = ctx.cfg.paywith.tokens.find((x) => x.address === token);
  const session = await readSession(ctx, chainKeyHash);
  const failures = await recentFailures(ctx, chainKeyHash, now);
  const giveUp = async (error: string) => {
    log.warn("pay-with swap failed", { key: chainKeyHash.slice(0, 8), token: t?.symbol ?? token, error });
    await ctx.db.insert(paywithSwaps).values({ id: uid("pws_"), keyHash: chainKeyHash, token, usdcOut, status: "failed", error, allocations: debts.map((d) => d.id) });
    // docs §6: failure -> prepaid credits (-> 402 when those run out). After MAX_SWAP_FAILURES, or once the batch is past
    // its age, the debts are charged to the key's own balance and closed.
    const oldest = Math.min(...debts.map((d) => d.createdAt.getTime()));
    if (failures + 1 >= MAX_SWAP_FAILURES || now - oldest >= 2 * ctx.cfg.paywith.maxAgeH * 3_600_000) {
      await fallbackToCredits(ctx, debts);
      return "fallback" as const;
    }
    return "failed" as const;
  };
  if (!t) return giveUp("token no longer configured");
  if (!session || !session.active || session.token !== token) return giveUp("no active session");
  const guard = await scaledUiGuard(ctx, token, Math.floor(now / 1000));
  if (!guard.ok) return giveUp(guard.reason);
  const fair = await fairPrice(ctx, token);
  if (!fair) return giveUp("no oracle price");
  const payTo = ctx.cfg.x402.payTo ?? ctx.chain.roleAddress("router");
  if (!payTo) return giveUp("no USDC destination (X402_PAY_TO or router key)");
  let quote: JupiterQuote;
  try {
    quote = await jupiterQuote(ctx, { inputMint: token, outputMint: ctx.cfg.chain.usdc, outAmount: usdcOut, slippageBps: ctx.cfg.paywith.maxSlipBps });
  } catch (e) {
    return giveUp(`quote: ${(e as Error).message}`);
  }
  if (quote.outAmount < usdcOut) return giveUp("quote is below the amount owed");
  const deviation = fillDeviationBps(quote.inAmount, t.decimals, fair, guard.multiplier, usdcOut);
  if (deviation > ctx.cfg.paywith.maxSlipBps) return giveUp(`fill is ${deviation} bps above the oracle value`);
  const day = rollDay(session);
  if (BigInt(day.spentRawToday) + quote.inAmount > BigInt(day.capRawPerDay)) return giveUp("daily cap reached");
  const kp = delegateKeypair(ctx, session);
  const destination = getAssociatedTokenAddressSync(new PublicKey(ctx.cfg.chain.usdc), new PublicKey(payTo), true);
  // swig: the role must exist, its session must be live, and the chain's own window must still have room for the fill.
  let swigRoute: { state: SwigState; role: NonNullable<ReturnType<typeof sessionRole>>; slot: bigint } | null = null;
  if (sessionMode(session) === "swig") {
    if (!session.swig) return giveUp("swig session without a wallet");
    let state: SwigState | null;
    try { state = await readSwig(ctx.chain.connection, new PublicKey(session.swig)); } catch (e) { return giveUp(`swig: ${(e as Error).message}`); }
    if (!state) return giveUp("swig wallet not created yet (authorize_transaction not signed)");
    const role = sessionRole(state, kp.publicKey, new PublicKey(token));
    if (!role) return giveUp("swig role not authorised (authorize_transaction not signed)");
    const slot = BigInt(await withRetry(() => ctx.chain.connection.getSlot(ctx.cfg.solana.commitment)));
    if (!sessionLive(role, slot)) return giveUp("swig session expired");
    if (role.tokenCapRaw === null) return giveUp("swig role has no cap on this token");
    const windowOpen = role.lastResetSlot !== null && role.windowSlots !== null && slot >= role.lastResetSlot + role.windowSlots; // the program resets the window on the next spend
    if (!windowOpen && role.tokenRemainingRaw !== null && quote.inAmount > role.tokenRemainingRaw) return giveUp("daily cap reached (swig)");
    if (quote.inAmount > role.tokenCapRaw) return giveUp("daily cap reached (swig)");
    swigRoute = { state, role, slot };
  }
  const swapId = uid("pws_");
  await ctx.db.insert(paywithSwaps).values({ id: swapId, keyHash: chainKeyHash, token, rawSpent: quote.inAmount, fairPrice: fair.toString(), usdcOut, status: "pending", allocations: debts.map((d) => d.id) });
  try {
    let tx: VersionedTransaction;
    let blockhashInfo: { blockhash: string; lastValidBlockHeight: number };
    if (swigRoute) {
      const route = await jupiterSwapInstructions(ctx, quote, swigRoute.state.address.toBase58(), destination.toBase58());
      const wrapped = await signWithSession({ state: swigRoute.state, role: swigRoute.role, inner: [...route.setup, route.swap, ...route.cleanup], currentSlot: swigRoute.slot });
      const tables = await lookupTables(ctx, route.lookupTables);
      blockhashInfo = await withRetry(() => ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment));
      tx = sessionTransaction({ sessionKey: kp, instructions: [...route.computeBudget, ...wrapped], recentBlockhash: blockhashInfo.blockhash, lookupTables: tables });
    } else {
      tx = await jupiterSwapTransaction(ctx, quote, kp.publicKey.toBase58(), destination.toBase58());
      tx.sign([kp]);
      blockhashInfo = { blockhash: tx.message.recentBlockhash, lastValidBlockHeight: (await withRetry(() => ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment))).lastValidBlockHeight };
    }
    const raw = Buffer.from(tx.serialize());
    const signature = await withRetry(() => ctx.chain.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: ctx.cfg.solana.commitment, maxRetries: 3 }));
    await ctx.db.update(paywithSwaps).set({ status: "submitted", tx: signature }).where(eq(paywithSwaps.id, swapId));
    await confirmSignature(ctx.chain.connection, signature, blockhashInfo, ctx.cfg.solana.commitment);
    await ctx.db.update(paywithSwaps).set({ status: "confirmed" }).where(eq(paywithSwaps.id, swapId));
    // Allocate the raw spent across the debts in proportion to their amounts.
    let left = quote.inAmount;
    for (const [i, d] of debts.entries()) {
      const share = i === debts.length - 1 ? left : (quote.inAmount * d.amount) / total;
      left -= share;
      await ctx.db.update(paywithDebts).set({ swapId, rawAllocated: share }).where(eq(paywithDebts.id, d.id));
    }
    await writeSession(ctx, { ...day, spentRawToday: (BigInt(day.spentRawToday) + quote.inAmount).toString() });
    log.info("pay-with swap settled", { key: chainKeyHash.slice(0, 8), mode: sessionMode(session), token: t.symbol, usdc: usdcOut.toString(), raw: quote.inAmount.toString(), tx: signature });
    return "swapped";
  } catch (e) {
    await ctx.db.update(paywithSwaps).set({ status: "failed", error: (e as Error).message.slice(0, 200) }).where(eq(paywithSwaps.id, swapId));
    return giveUp(`swap: ${(e as Error).message}`);
  }
}

async function recentFailures(ctx: Ctx, chainKeyHash: string, now: number) {
  const since = new Date(now - 2 * ctx.cfg.paywith.maxAgeH * 3_600_000);
  const rows = await ctx.db.select({ status: paywithSwaps.status }).from(paywithSwaps).where(and(eq(paywithSwaps.keyHash, chainKeyHash), gte(paywithSwaps.ts, since)));
  return rows.filter((r) => r.status === "failed").length;
}

/** Charge the batch to the key's prepaid balance (ledger kind "paywith", ref paywith-fallback:<debt>) and close the debts. */
async function fallbackToCredits(ctx: Ctx, debts: (typeof paywithDebts.$inferSelect)[]) {
  for (const d of debts) {
    await postLedger(ctx.db, { accountId: d.accountId, amount: -d.amount, kind: PAYWITH_KIND, ref: `paywith-fallback:${d.id}`, generationId: d.generationId, description: "pay-with swap failed: charged to credits" });
    await ctx.db.update(paywithDebts).set({ swapId: FALLBACK_SWAP_ID, rawAllocated: 0n }).where(eq(paywithDebts.id, d.id));
  }
}

/** A month's pay-with statement for a key: every debt (with its swap or fallback) and the swaps. */
export async function statement(ctx: Ctx, chainKeyHash: string, month: string) {
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const debts = await ctx.db.select().from(paywithDebts).where(and(eq(paywithDebts.chainKeyHash, chainKeyHash), gte(paywithDebts.createdAt, from), lt(paywithDebts.createdAt, to))).orderBy(asc(paywithDebts.createdAt));
  const swaps = await ctx.db.select().from(paywithSwaps).where(and(eq(paywithSwaps.keyHash, chainKeyHash), gte(paywithSwaps.ts, from), lt(paywithSwaps.ts, to))).orderBy(asc(paywithSwaps.ts));
  const total = debts.reduce((s, d) => s + d.amount, 0n);
  return {
    month, chain_key_hash: chainKeyHash, available: true,
    charges: debts.map((d) => ({ id: d.id, generation_id: d.generationId, token: d.token, usd: picoToUsd(d.amount), raw_estimate: d.rawEstimate?.toString() ?? null, raw_allocated: d.rawAllocated?.toString() ?? null, fair_price18: d.fairPrice18, swap_id: d.swapId, status: d.swapId === FALLBACK_SWAP_ID ? "charged_to_credits" : d.swapId ? "swapped" : "open", at: d.createdAt.toISOString() })),
    swaps: swaps.map((s) => ({ id: s.id, token: s.token, raw_spent: s.rawSpent?.toString() ?? null, usdc_out: s.usdcOut.toString(), tx: s.tx, status: s.status, error: s.error, at: s.ts.toISOString() })),
    total_usd: picoToUsd(total),
  };
}

/** The public `paywith` section of /api/v1/status. */
export function paywithStatus(ctx: Ctx) {
  const p = ctx.cfg.paywith;
  const session = p.sessionMode === "swig"
    ? "Swig smart-wallet role per API key: the owner authorises the router's session key with a per-day token cap the Swig program enforces (POST /api/v1/paywith/session returns the transaction to sign)"
    : "delegate key per API key with a per-day cap (POST /api/v1/paywith/session); PAYWITH_SESSION_MODE=swig is the production path";
  return { tokens: p.tokens.map((t) => t.symbol), configured: p.tokens.length > 0, header: "X-Pay-With", session_mode: p.sessionMode, session, swap: "jupiter ExactOut", oracle: "pyth hermes", threshold_usd: p.thresholdUsd, max_age_hours: p.maxAgeH, max_debt_usd: p.maxDebtUsd, max_slip_bps: p.maxSlipBps, scaled_ui_guard_s: SCALED_UI_GUARD_S };
}
