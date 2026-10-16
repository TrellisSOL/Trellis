import { PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Ctx } from "../context.ts";
import { base58Decode, base58Encode, isAddress, SIGNATURE_RE } from "../solana/constants.ts";
import { recentSignatures, withRetry } from "../solana/rpc.ts";
import type { ToolsBuyer } from "./config.ts";

// The buyer side of x402: read a seller's 402, pick an offer this router can pay (scheme exact, USDC on this chain),
// sign the USDC transfer from the buyer wallet to the seller's payTo, and read the seller's settlement answer.
// The Solana `exact` payload is a partially signed transaction: fee payer = the seller's facilitator (`extra.feePayer`),
// one SPL TransferChecked from the buyer's USDC account to payTo's, signed by the buyer. Both wire versions are spoken:
//   v1  402 JSON body { x402Version: 1, accepts: [{ maxAmountRequired, payTo, asset, network, extra.feePayer ... }] }
//       paid retry carries X-PAYMENT, the answer carries X-PAYMENT-RESPONSE
//   v2  402 PAYMENT-REQUIRED header (base64 JSON { x402Version: 2, resource, accepts: [{ amount, ... }] })
//       paid retry carries PAYMENT-SIGNATURE, the answer carries PAYMENT-RESPONSE
// The buyer never needs the seller's facilitator: the seller settles with whichever facilitator it uses.

const MAX_HEADER = 64 * 1024;
const MAX_U64 = (1n << 64n) - 1n;
export const MAX_PAYMENT_VALIDITY_S = 120;

export type Offer = {
  version: 1 | 2;
  network: string;
  amount: bigint; // USDC base units
  asset: string;
  payTo: string;
  /** The facilitator account that co-signs and pays the fee; a Solana `exact` offer without one cannot be paid. */
  feePayer: string | null;
  maxTimeoutSeconds: number;
  mimeType: string | null;
  /** The requirement exactly as the seller sent it (echoed back as `accepted` in a v2 payment). */
  raw: Record<string, unknown>;
  /** v2 resource info, echoed back in the payment. */
  resource: Record<string, unknown> | null;
};
export type PaymentRequired = { version: 1 | 2; accepts: unknown[]; resource: Record<string, unknown> | null };

const decodeHeader = (value: string | null): unknown => {
  if (!value || value.length > MAX_HEADER) return null;
  try {
    return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The seller's payment requirements: the v2 PAYMENT-REQUIRED header first, then a v1 (or v2) JSON body. */
export function readPaymentRequired(headers: Headers, body: string | null): PaymentRequired | null {
  const fromHeader = obj(decodeHeader(headers.get("payment-required")));
  let doc = fromHeader;
  if (!doc && body) {
    try {
      doc = obj(JSON.parse(body));
    } catch {
      doc = null;
    }
  }
  if (!doc || !Array.isArray(doc.accepts)) return null;
  const version = Number(doc.x402Version) === 2 || fromHeader ? 2 : Number(doc.x402Version) === 1 ? 1 : null;
  if (!version) return null;
  return { version, accepts: doc.accepts.slice(0, 32), resource: obj(doc.resource) };
}

/** True when `network` names this router's chain, as X402_NETWORK or as the CAIP-2 name of the configured cluster. */
export const ourNetwork = (ctx: Ctx, network: unknown) => typeof network === "string" && (network === ctx.cfg.x402.network || network === ctx.cfg.chain.network);

/**
 * The first offer the router can pay: scheme exact, this chain, USDC, a real payTo, a fee payer and a positive amount.
 * Returns the reason none fits otherwise (a fixed code).
 */
export function chooseOffer(ctx: Ctx, pr: PaymentRequired): { offer: Offer } | { problem: string } {
  let problem = "no_offer";
  for (const raw of pr.accepts) {
    const a = obj(raw);
    if (!a) continue;
    if (a.scheme !== "exact") { problem = "unsupported_scheme"; continue; }
    if (!ourNetwork(ctx, a.network)) { problem = "unsupported_network"; continue; }
    if (typeof a.asset !== "string" || a.asset !== ctx.cfg.chain.usdc) { problem = "unsupported_asset"; continue; }
    if (!isAddress(a.payTo)) { problem = "invalid_pay_to"; continue; }
    const amountRaw = pr.version === 2 ? a.amount : a.maxAmountRequired;
    if (typeof amountRaw !== "string" || !/^\d{1,20}$/.test(amountRaw) || BigInt(amountRaw) <= 0n || BigInt(amountRaw) > MAX_U64) { problem = "invalid_amount"; continue; }
    const extra = obj(a.extra);
    const feePayer = extra && isAddress(extra.feePayer) ? extra.feePayer : null;
    if (!feePayer) { problem = "missing_fee_payer"; continue; }
    const timeout = Number(a.maxTimeoutSeconds);
    const mime = pr.version === 2 ? pr.resource?.mimeType : a.mimeType;
    return {
      offer: {
        version: pr.version,
        network: String(a.network),
        amount: BigInt(amountRaw),
        asset: a.asset,
        payTo: a.payTo,
        feePayer,
        maxTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 120,
        mimeType: typeof mime === "string" && mime.trim() ? mime.trim().toLowerCase() : null,
        raw: a,
        resource: pr.resource,
      },
    };
  }
  return { problem };
}

export type SignedPayment = { header: [string, string]; nonce: string; validBefore: Date; from: string; transaction: string };

/**
 * Sign the payment for one offer: a transaction the seller's facilitator co-signs. Valid for at most two minutes (or the
 * seller's shorter timeout): the blockhash it carries expires on its own, and the nonce is the buyer's signature.
 */
export async function signPayment(ctx: Ctx, buyer: ToolsBuyer, offer: Offer, now = Date.now(), blockhash?: string): Promise<SignedPayment> {
  if (!offer.feePayer) throw new Error("the offer names no fee payer");
  const mint = new PublicKey(offer.asset);
  const payTo = new PublicKey(offer.payTo);
  const recentBlockhash = blockhash ?? (await withRetry(() => ctx.chain.connection.getLatestBlockhash("confirmed"))).blockhash;
  const tx = new Transaction({ feePayer: new PublicKey(offer.feePayer), recentBlockhash });
  tx.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, buyer.publicKey, true), mint, getAssociatedTokenAddressSync(mint, payTo, true), buyer.publicKey, offer.amount, 6));
  buyer.sign(tx);
  const sig = tx.signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature;
  if (!sig) throw new Error("buyer signature missing");
  const transaction = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  const payload = { transaction };
  const body = offer.version === 2
    ? { x402Version: 2, scheme: "exact", network: offer.network, accepted: offer.raw, ...(offer.resource ? { resource: offer.resource } : {}), payload }
    : { x402Version: 1, scheme: "exact", network: offer.network, payload };
  const value = Buffer.from(JSON.stringify(body)).toString("base64");
  const validBefore = new Date(now + Math.min(MAX_PAYMENT_VALIDITY_S, offer.maxTimeoutSeconds) * 1000);
  return { header: [offer.version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT", value], nonce: base58Encode(new Uint8Array(sig)), validBefore, from: buyer.address, transaction };
}

/** The seller's settlement answer (PAYMENT-RESPONSE or X-PAYMENT-RESPONSE). Only a well-formed transaction signature is kept. */
export function readPaymentResponse(headers: Headers): { success: boolean; transaction: string | null; network: string | null } | null {
  const doc = obj(decodeHeader(headers.get("payment-response") ?? headers.get("x-payment-response")));
  if (!doc) return null;
  const tx = typeof doc.transaction === "string" && SIGNATURE_RE.test(doc.transaction) ? doc.transaction : null;
  return { success: doc.success === true, transaction: tx, network: typeof doc.network === "string" ? doc.network.slice(0, 64) : null };
}

/**
 * Whether the seller collected a payment the buyer signed: the buyer's signature (`nonce`, base58) appears among the
 * signatures of a successful transaction on the buyer's USDC token account since `since`. There is no on-chain
 * authorization nonce on Solana (the payment is a plain transfer the seller's facilitator co-signs), so the check walks
 * the buyer account's recent transactions; `maxSignatures` bounds one check.
 */
export async function authorizationUsed(ctx: Ctx, o: { payer: string; nonce: string; asset: string; since: Date; maxSignatures?: number }): Promise<boolean> {
  const nonce = Buffer.from(base58Decode(o.nonce));
  const ata = getAssociatedTokenAddressSync(new PublicKey(o.asset), new PublicKey(o.payer), true);
  const sigs = await recentSignatures(ctx.chain.connection, ata, Math.min(1000, o.maxSignatures ?? 200));
  const sinceS = Math.floor(o.since.getTime() / 1000) - 60;
  for (const s of sigs) {
    if (s.err || (s.blockTime != null && s.blockTime < sinceS)) continue;
    const tx = await withRetry(() => ctx.chain.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
    if (!tx || tx.meta?.err) continue;
    const signatures = tx.transaction.signatures as (string | Uint8Array)[];
    if (signatures.some((sig) => (typeof sig === "string" ? Buffer.from(base58Decode(sig)) : Buffer.from(sig)).equals(nonce))) return true;
  }
  return false;
}
