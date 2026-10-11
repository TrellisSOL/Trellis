import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { walletAuth } from "../api/auth.ts";
import { addressBucket } from "../api/common.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import type { Ctx } from "../context.ts";
import { facilitatorSettlements, kv } from "../db/schema.ts";
import { creditAccount } from "../ledger/ledger.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { type Pico, picoToUsdc, usdcToPico } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { SIGNATURE_RE } from "./constants.ts";
import { feeUnits, LAMPORTS_PER_SIGNATURE } from "./facilitator-config.ts";
import { withRetry } from "./rpc.ts";
import { FAILED_ON_CHAIN, sponsorAdmit } from "./sponsor.ts";
import { X402_VERSION, exactLimits, facilitatorClient, parseX402, paymentHeaderOf, settleExact, verifyExact, x402Body, x402Enabled, x402FailureHeader, x402Requirement, x402RequiredHeaders, x402ResponseHeader, type X402Payment } from "./x402.ts";

// HTTP 402 per-call payments for callers without a key (agents): the 402 carries x402 `accepts`, the retry carries the
// signed payment, and the served response carries the settlement headers. A redeemed payment is credited to the payer's
// wallet account (w_<address>); the call then reserves and settles against it like any prepaid key, so any unused part
// stays on that account as change. Settlement is idempotent by (payer, transaction signature).
//
// A payment pays for one request: the one that first redeems it. A landed transaction and its signature are public, so
// presenting either again proves nothing about who is asking: a replay is refused with 402 `payment_already_claimed`,
// moves nothing and credits nothing. The change of the first call stays on the payer's wallet account, which only the
// wallet itself can spend (a signed wallet request), never the bearer of an old payment.
//
// Who may present a payment (security review TR-07). The two header forms differ in what holding them proves:
//   x402 payload     a signed transaction that has not landed. Only the payer has it until the router submits it, and
//                    it can be claimed once, so presenting it is proof enough: no wallet signature is asked for.
//   bare signature   the signature of a transfer that already landed. It is on the public ledger the moment it lands:
//                    whoever sends it first would get the payer's request. It is therefore accepted only together
//                    with X-Wallet-Auth (src/api/auth.ts) from the wallet that is the token owner of that transfer;
//                    without it, or signed by another wallet, the answer is `payment_not_bound_to_caller` and nothing
//                    is credited or redeemed, so the payer can still present it.

const fmtUsdc = (units: bigint) => {
  const s = units.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

type Quote = { pricePico: Pico; bodySha: string; modelId: string };
type QuoteInfo = Quote & { resource: string; description: string; /** The per-source limit on sponsored payments, taken where the caller's address is in hand. */ sourceOk?: () => Promise<boolean> };

export const walletAccountId = (payer: string) => `w_${payer}`;
export const PERCALL_KIND = "percall";
export const percallRef = (signature: string) => `x402:${signature}`;

/**
 * Whether the router's own key pays the network fee of a per-call payment (it co-signs as fee payer). Not when an
 * external facilitator settles and the router holds no key for it.
 */
const routerSponsors = (ctx: Ctx) => !!ctx.chain.signer("router");

/**
 * What a per-call payment must be, in whole USDC base units (security review round 3, R3-01 and R3-19):
 * `price`, the request's worst-case price (refused above the per-call maximum); `maxNetworkFee`, the most the Solana
 * network fee of the payment can be when the router pays it (two signatures and the priority-fee ceiling, at the
 * configured SOL price), zero when the router does not sponsor; `total`, what the 402 quotes and the payment must
 * carry: price plus that maximum, and never less than the minimum payment.
 *
 * The network fee is pass-through cost recovery, not a charge of the router's (zero markup): what is kept back when the
 * payment settles is the fee of the transaction as the payer signed it (`networkFeeOf`), which is at most the quoted
 * maximum. Everything else is credited, and what the call does not use stays on the payer's wallet account as change.
 */
export function perCallQuote(ctx: Ctx, pricePico: Pico): { price: bigint; maxNetworkFee: bigint; total: bigint } {
  const price = picoToUsdc(pricePico, "ceil");
  if (price > BigInt(Math.round(ctx.cfg.fees.perCallMaxUsd * 1e6)))
    fail(400, `This request could cost more than the per-call maximum of $${ctx.cfg.fees.perCallMaxUsd}. Lower max_tokens or use a prepaid key.`, "per_call_too_large");
  const s = ctx.cfg.facilitator.sponsor;
  const maxNetworkFee = routerSponsors(ctx) ? s.maxFeeUnits : 0n;
  const sum = price + maxNetworkFee;
  return { price, maxNetworkFee, total: sum > s.minPaymentUnits ? sum : s.minPaymentUnits };
}
/** The network fee of one sponsored payment: what the fee payer is charged for it, and that amount in USDC. */
export type NetworkFee = { lamports: number; usdcUnits: bigint; solUsdc: bigint };
/**
 * The network fee as its own line on a receipt (zero markup: it is the Solana fee of the payment named in
 * `payment_tx`, passed through at cost, and no part of the price of the call). Kept once per payment, whatever number
 * of calls that payment paid for.
 */
export const networkFeeLine = (f: NetworkFee) => ({ lamports: f.lamports, usdc: fmtUsdc(f.usdcUnits), sol_usdc: fmtUsdc(f.solUsdc), basis: "pass_through" as const });
/**
 * The fee the router pays for `t` exactly as signed: 5,000 lamports per signature plus the priority fee the payer set
 * (compute-unit limit times price, which the cluster charges in full whatever the transaction uses). Converted at the
 * configured SOL price, rounded up to one USDC base unit.
 */
export function networkFeeOf(ctx: Ctx, t: { tx: { message: { header: { numRequiredSignatures: number } } }; priorityFeeLamports: bigint }): NetworkFee {
  const lamports = t.tx.message.header.numRequiredSignatures * LAMPORTS_PER_SIGNATURE + Number(t.priorityFeeLamports);
  const solUsdc = ctx.cfg.facilitator.sponsor.solUsdc;
  return { lamports, usdcUnits: feeUnits(lamports, solUsdc), solUsdc };
}
/** The amount a per-call payment must carry (see perCallQuote). */
const quotePrice = (ctx: Ctx, pricePico: Pico) => perCallQuote(ctx, pricePico).total;

export async function paymentRequired(ctx: Ctx, opts: QuoteInfo, failure?: { errorReason: string; payer: string }): Promise<never> {
  const priceUsdc = quotePrice(ctx, opts.pricePico);
  if (!x402Enabled(ctx)) fail(402, `This request costs ${fmtUsdc(priceUsdc)} USDC. Per-call payments are not available on this router yet; use a prepaid key.`, "payment_required", { price_usdc: fmtUsdc(priceUsdc), model: opts.modelId });
  const accepts = [await x402Requirement(ctx, { priceUsdc, resource: opts.resource, description: opts.description })];
  const error = failure ? `Payment rejected (${failure.errorReason}): send a fresh signed x402 payment.` : `Payment of ${fmtUsdc(priceUsdc)} USDC required: send the signed x402 payment as X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2).`;
  const headers = { ...x402RequiredHeaders(error, accepts), ...(failure ? x402FailureHeader({ errorReason: failure.errorReason, network: accepts[0].network, payer: failure.payer }) : {}) };
  throw new ApiError(402, error, "payment_required", undefined, headers, x402Body(error, accepts, { price_usdc: fmtUsdc(priceUsdc), network_fee_max_usdc: fmtUsdc(perCallQuote(ctx, opts.pricePico).maxNetworkFee), model: opts.modelId, x402Version: X402_VERSION, ...(failure ? { payment_error: failure.errorReason } : {}) }));
}

export type PaymentHeader = { kind: "tx"; signature: string } | { kind: "x402"; payment: X402Payment; raw: unknown };

/** A payment header is x402 JSON (base64) or a bare transaction signature of an earlier payment. */
export function parsePaymentHeader(v: string): PaymentHeader {
  if (SIGNATURE_RE.test(v)) return { kind: "tx", signature: v };
  let json: unknown;
  try { json = JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { fail(400, "X-PAYMENT must be a transaction signature or a base64 x402 payload.", "invalid_payment"); }
  return { kind: "x402", payment: parseX402(json), raw: json };
}

export type Redeemed = { accountId: string; payer: string; txHash: string; paymentResponse?: string; /** The network fee kept back from a payment the router sponsored: its own line on the receipt. */ networkFee?: NetworkFee };

/**
 * Credit a settled payment to the payer's wallet account once (ledger.ref = x402:<signature>). `fresh` is false when
 * that signature was credited before: the payment was already redeemed and must not buy another request.
 */
async function creditPayer(ctx: Ctx, payer: string, signature: string, units: bigint): Promise<{ accountId: string; fresh: boolean }> {
  const accountId = walletAccountId(payer);
  if (units <= 0n) return { accountId, fresh: true };
  const fresh = await creditAccount(ctx.db, { accountId, amount: usdcToPico(units), kind: PERCALL_KIND, ref: percallRef(signature), description: `x402 payment ${signature.slice(0, 8)}…` });
  return { accountId, fresh };
}

const ALREADY_CLAIMED = "payment_already_claimed";
export const NOT_BOUND = "payment_not_bound_to_caller";
const NOT_BOUND_TEXT = "A transaction signature in X-PAYMENT is accepted only together with X-Wallet-Auth signed by the wallet that paid: a landed payment is public, so the signature alone does not show who is asking. Send X-Wallet-Auth, or pay with a signed x402 payload.";

/** Verify, co-sign as fee payer (or hand to the external facilitator), submit and credit. */
export async function redeemX402(ctx: Ctx, p: X402Payment, o: QuoteInfo, raw?: unknown): Promise<Redeemed> {
  const priceUsdc = quotePrice(ctx, o.pricePico);
  const req = await x402Requirement(ctx, { priceUsdc, resource: o.resource, description: o.description });
  if (p.network !== req.network && p.network === ctx.cfg.chain.network) p = { ...p, network: req.network };
  const external = ctx.cfg.solana.facilitatorUrl;
  const feePayer = ctx.chain.signer("router");
  if (!feePayer && !external) fail(503, "Per-call payments are not available: no fee payer is configured.", "facilitator_unavailable");
  if (external && !feePayer) {
    // External facilitator (X402_FACILITATOR_URL): it verifies and settles; we only credit what it reports.
    const client = facilitatorClient(external);
    const payload = raw ?? { x402Version: p.version, scheme: p.scheme, network: p.network, payload: { transaction: p.transaction } };
    const v = await client.verify(payload, req).catch(() => ({ isValid: false, invalidReason: "facilitator_unavailable" as string | undefined, payer: undefined as string | undefined }));
    if (!v.isValid) return paymentRequired(ctx, o, { errorReason: v.invalidReason ?? "invalid_payment", payer: v.payer ?? "" });
    const s = await client.settle(payload, req).catch(() => ({ success: false as const, errorReason: "facilitator_unavailable", network: req.network, payer: v.payer ?? "" }));
    if (!s.success) return paymentRequired(ctx, o, { errorReason: s.errorReason, payer: s.payer });
    // A facilitator answers a replayed payment with the settlement it already made: credited once, redeemed once.
    const { accountId, fresh } = await creditPayer(ctx, s.payer, s.transaction, priceUsdc);
    if (!fresh) return paymentRequired(ctx, o, { errorReason: ALREADY_CLAIMED, payer: s.payer });
    return { accountId, payer: s.payer, txHash: s.transaction, paymentResponse: x402ResponseHeader({ transaction: s.transaction, network: s.network, payer: s.payer }) };
  }
  const verified = await verifyExact(p, req, { feePayer: feePayer!.publicKey, rpc: ctx.chain.connection, limits: exactLimits(ctx) });
  if (!verified.ok) return paymentRequired(ctx, o, { errorReason: verified.reason, payer: "" });
  const t = verified.transfer;
  const payer = t.payer.toBase58();
  // R3-01: what this payment can cost the router key, and whether the key may spend it. The worst case is taken from
  // the payment as signed (its signatures and its priority fee, both already bounded by the verifier).
  const fee = networkFeeOf(ctx, t);
  const worstCaseLamports = fee.lamports;
  const admission = await sponsorAdmit(ctx, { scope: "x402", feePayer: feePayer!.publicKey, payer, sourceOk: o.sourceOk, worstCaseLamports });
  if (!admission.ok) {
    if (admission.reason === "payer_not_sponsored") fail(403, "A sponsored payment from this wallet failed after it was sent, so this router no longer pays its network fees. Send the USDC transfer yourself and present its signature with X-Wallet-Auth.", "payer_not_sponsored");
    if (admission.reason === "facilitator_unavailable") fail(503, "Per-call payments are paused: the fee payer is below its balance floor.", "facilitator_unavailable");
    fail(429, "Too many sponsored payments right now. Retry shortly, or send the USDC transfer yourself and present its signature with X-Wallet-Auth.", "rate_limited");
  }
  // The payer's signature is the durable claim on this payment: a replayed transaction settles once and is redeemed once.
  const payerIndex = t.tx.message.staticAccountKeys.findIndex((k) => k.equals(t.payer));
  const nonce = Buffer.from(t.tx.signatures[payerIndex]).toString("base64");
  const claimed = await ctx.db.insert(facilitatorSettlements).values({ id: uid("fs_"), kind: "payment", scheme: "exact", payer, payTo: req.payTo, value: t.amount, nonce, status: "verified", x402Version: p.version }).onConflictDoNothing().returning({ id: facilitatorSettlements.id });
  if (!claimed.length) { await admission.release(); return paymentRequired(ctx, o, { errorReason: ALREADY_CLAIMED, payer }); }
  const settled = await settleExact(ctx.chain.connection, t, feePayer!, req.network, ctx.cfg.solana.commitment);
  if (!settled.success) {
    // Nothing left this process: the budgets are handed back and the claim is released, so the same signed payment can
    // be presented again once it can succeed. Sent and failed on chain: the fee was paid for nothing, the budget stays
    // spent and this payer is not sponsored again (sponsor.ts payerBlocked reads this row).
    if (settled.sent === false) {
      await admission.release();
      await ctx.db.delete(facilitatorSettlements).where(eq(facilitatorSettlements.id, claimed[0].id));
    } else {
      await ctx.db.update(facilitatorSettlements).set({ status: "failed", error: settled.onChain ? FAILED_ON_CHAIN : settled.errorReason, feeLamports: settled.onChain ? BigInt(fee.lamports) : null }).where(eq(facilitatorSettlements.id, claimed[0].id));
      if (settled.onChain) log.warn("x402: a sponsored payment failed after it was sent; the payer is no longer sponsored", { payer_prefix: payer.slice(0, 6) });
    }
    return paymentRequired(ctx, o, { errorReason: settled.errorReason, payer });
  }
  // Pass-through of the network fee (zero markup): kept back is the fee of THIS transaction, in lamports as charged,
  // at the configured SOL price; never the quoted maximum, never a margin. Both figures are recorded with the
  // settlement (fee_lamports, gas_debit) so what was paid in SOL and what was recovered in USDC can be compared.
  const recovered = fee.usdcUnits < t.amount ? fee.usdcUnits : t.amount;
  await ctx.db.update(facilitatorSettlements).set({ status: "settled", txHash: settled.transaction, settledAt: new Date(), gasDebit: recovered, feeLamports: BigInt(fee.lamports) }).where(eq(facilitatorSettlements.id, claimed[0].id));
  const { accountId } = await creditPayer(ctx, payer, settled.transaction, t.amount - recovered);
  log.info("x402 payment settled", { payer_prefix: payer.slice(0, 6), amount: t.amount.toString(), tx: settled.transaction });
  return { accountId, payer, txHash: settled.transaction, paymentResponse: x402ResponseHeader({ transaction: settled.transaction, network: req.network, payer }), networkFee: { ...fee, usdcUnits: recovered } };
}

/** How old (by block time) a transfer may be when its signature is presented: an hour is ample for "pay, then call". */
export const PAYMENT_SIGNATURE_MAX_AGE_S = 3_600;
/** kv row holding the unix time before which no transfer is redeemable: set by scripts/restore-reconcile.ts after a restore. */
export const PAYMENT_NOT_BEFORE_KEY = "x402_not_before";
/** The earliest block time a redeemable transfer may have: the later of the age limit and the restore watermark. */
export async function paymentNotBefore(ctx: Ctx, now = Date.now()): Promise<number> {
  const aged = Math.floor(now / 1000) - PAYMENT_SIGNATURE_MAX_AGE_S;
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, PAYMENT_NOT_BEFORE_KEY));
  const mark = typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : 0;
  return Math.max(aged, mark);
}

/**
 * A bare transaction signature: a USDC transfer to payTo the payer already sent (itself, or through a facilitator). Read
 * it at finalized, check the transfer, credit the payer once. The signature buys the request that first presents it: a
 * second presentation is refused (`payment_already_claimed`), because a signature on chain is public and says nothing
 * about who holds it. A signature that is not finalized yet has redeemed nothing and may be presented again.
 */
export async function redeemPayment(ctx: Ctx, signature: string, _bodySha: string, waitMs: number, quote: QuoteInfo | undefined, boundTo: string): Promise<Redeemed> {
  // `boundTo` is the wallet that proved itself with X-Wallet-Auth on this request: the payment is redeemed only if that
  // wallet is the token owner (payer) of the transfer. Required: there is no way to redeem a bare signature unbound.
  if (!boundTo) fail(401, NOT_BOUND_TEXT, NOT_BOUND);
  const payTo = ctx.cfg.x402.payTo;
  if (!payTo) fail(503, "Per-call payments are not configured on this router.", "facilitator_unavailable");
  const mint = new PublicKey(ctx.cfg.chain.usdc);
  const destination = getAssociatedTokenAddressSync(mint, new PublicKey(payTo), true);
  const deadline = Date.now() + waitMs;
  let tx: Awaited<ReturnType<typeof ctx.chain.connection.getTransaction>> = null;
  for (;;) {
    tx = await withRetry(() => ctx.chain.connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 })).catch(() => null);
    if (tx || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!tx) fail(402, "The payment transaction is not finalized yet; retry with the same signature in a moment.", "payment_pending", { tx: signature });
  // A transaction served without its outcome proves nothing about whether the transfer happened (review round 3,
  // R3-30): it has redeemed nothing and may be presented again once a node serves it whole.
  if (!tx.meta) fail(402, "The payment transaction's outcome is not available yet; retry with the same signature in a moment.", "payment_pending", { tx: signature });
  if (tx.meta.err) fail(402, "The payment transaction failed on chain.", "payment_failed", { tx: signature });
  // Security review R5-08: a landed transfer could be redeemed at any later time, and the only record that it had been
  // is a ledger row; a database restored from a backup has lost the rows of the gap, so every payment of the gap could
  // be redeemed a second time. Two bounds, both on the transaction's BLOCK time (the cluster's clock, not this one):
  // it must be recent (PAYMENT_SIGNATURE_MAX_AGE_S), and not older than the restore watermark the reconcile script
  // leaves (scripts/restore-reconcile.ts). A transaction with no block time cannot be placed and is refused.
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;
  const notBefore = await paymentNotBefore(ctx);
  if (blockTime === null || blockTime < notBefore) fail(402, "This payment transaction is too old to be redeemed. Send a fresh payment.", "payment_expired", { tx: signature, max_age_s: PAYMENT_SIGNATURE_MAX_AGE_S });
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  let found = null as { payer: string; amount: bigint } | null;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) || ix.data.length !== 10 || ix.data[0] !== 12) continue;
    const [, ixMint, dest, owner] = ix.accountKeyIndexes.map((i) => keys[i]);
    if (!ixMint?.equals(mint) || !dest?.equals(destination) || !owner) continue;
    const amount = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
    // Transfers by one token owner add up; a transaction paying from several owners is credited to none of them here
    // unless the caller is the one whose transfers these are (only the caller's own transfers are counted).
    if (owner.toBase58() !== boundTo) { found ??= { payer: owner.toBase58(), amount: 0n }; continue; }
    const prior: bigint = found && found.payer === boundTo ? found.amount : 0n;
    found = { payer: boundTo, amount: prior + amount };
  }
  if (!found) fail(402, "The transaction carries no USDC transfer to this router's payTo address.", "invalid_payment", { tx: signature });
  // The caller must be the payer. Checked before anything is credited: a refused presentation redeems nothing, so the
  // real payer's own (wallet-signed) presentation of the same signature still succeeds afterwards.
  if (found.payer !== boundTo) fail(402, "This payment was made by another wallet. A transaction signature is accepted only with X-Wallet-Auth signed by the wallet that paid.", NOT_BOUND, { tx: signature });
  const { accountId, fresh } = await creditPayer(ctx, found.payer, signature, found.amount);
  if (!fresh) {
    if (quote) return paymentRequired(ctx, quote, { errorReason: ALREADY_CLAIMED, payer: found.payer });
    fail(402, "This payment was already redeemed for another request. Send a fresh payment.", ALREADY_CLAIMED, { tx: signature });
  }
  return { accountId, payer: found.payer, txHash: signature };
}

/**
 * Pay for one request without a key: answer 402 with the quote, or redeem the payment the request carries. `wallet` is
 * the caller's wallet when the route has already verified X-Wallet-Auth for this request (the header is single use, so
 * it is not verified twice); otherwise a bare transaction signature makes this function verify the header itself, over
 * `bodySha`. A bare signature without a valid wallet signature from its payer is refused (`payment_not_bound_to_caller`).
 */
export async function payPerCall(ctx: Ctx, c: Context, o: Quote & { description?: string; wallet?: { wallet: string } | null }): Promise<Redeemed> {
  // A request that came through the Oblivious HTTP gateway has no client address of its own (the gateway limits it).
  const from = gatewayOrigin(c.req.raw) ? null : addressBucket(c, ctx.cfg);
  const sourceOk = from ? async () => (await ctx.limiter.take(`sponsor-source:${from.id}`, 1, from.scale(ctx.cfg.facilitator.sponsor.sourcePerMin), 60_000)).ok : undefined;
  const info: QuoteInfo = { pricePico: o.pricePico, bodySha: o.bodySha, modelId: o.modelId, resource: `${ctx.cfg.publicUrl}${new URL(c.req.url).pathname}`, description: o.description ?? `Pay-per-call inference: ${o.modelId}`, sourceOk };
  const pay = paymentHeaderOf(c);
  if (!pay) return paymentRequired(ctx, info);
  const header = parsePaymentHeader(pay);
  if (header.kind === "x402") return redeemX402(ctx, header.payment, info, header.raw);
  const auth = c.req.header("x-wallet-auth");
  const caller = o.wallet ?? (auth ? await walletAuth(ctx, auth, o.bodySha, c) : null);
  if (!caller) fail(401, NOT_BOUND_TEXT, NOT_BOUND, { tx: header.signature });
  return redeemPayment(ctx, header.signature, o.bodySha, ctx.cfg.fees.paymentWaitMs, info, caller.wallet);
}
