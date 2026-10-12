import { createPublicKey, verify as edVerify } from "node:crypto";
import type { Context } from "hono";
import { ComputeBudgetProgram, PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { isAddress } from "./constants.ts";
import { confirmSignature, signatureOutcome, withRetry, type RpcLike } from "./rpc.ts";

// x402, `exact` scheme on Solana (the shape Coinbase's facilitator speaks for `solana:*` networks): the payer builds a
// transaction with one SPL `TransferChecked` of USDC to payTo's associated token account, fee payer = the facilitator,
// partially signs it, and sends it base64 as `payload.transaction` in `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2).
// The facilitator verifies it (below), co-signs as fee payer, submits it and serves the call. No program sits in between:
// USDC moves from the payer straight to payTo. Fee sponsorship (§5.2): the facilitator pays the SOL fee and recovers it
// inside the settlement amount (`sponsorshipRecovery`).
//
// Both wire versions are read. A 402 carries the v1 JSON body and, beside it, the same requirement as a v2
// PaymentRequired in the `PAYMENT-REQUIRED` header; a settled call carries the settlement in `X-PAYMENT-RESPONSE` (v1)
// and `PAYMENT-RESPONSE` (v2). Networks are CAIP-2 ("solana:<genesis hash prefix>").

export const X402_VERSION = 1;
/** The x402 versions a payment may carry: v1 (`scheme`, `network` at the top) and v2 (`accepted` holds them). */
export const X402_VERSIONS: readonly number[] = [1, 2];
export const USDC_DECIMALS = 6;

/** The payment a request carries: `X-PAYMENT` (x402 v1) or `PAYMENT-SIGNATURE` (x402 v2). */
export const paymentHeaderOf = (c: Context) => c.req.header("x-payment") ?? c.req.header("payment-signature");

export type X402Requirement = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  /** `feePayer`: the account that co-signs and pays the transaction fee, as the Solana `exact` scheme publishes it. */
  extra: { feePayer: string | null; decimals: number };
};
/** The Solana `exact` payload: one base64 transaction, signed by the payer, that the facilitator co-signs and submits. */
export type X402Payment = { version: number; scheme: string; network: string; transaction: string };

/** x402 is on when a payTo address is configured and the router role can co-sign as fee payer. */
export const x402Enabled = (ctx: Ctx) => !!ctx.cfg.x402.payTo && (!!ctx.chain.roleAddress("router") || !!ctx.cfg.solana.facilitatorUrl);

/** The fee payer the 402 advertises: the router's own key, or none when an external facilitator settles. */
export const x402FeePayer = (ctx: Ctx) => ctx.chain.roleAddress("router") ?? null;

export async function x402Requirement(ctx: Ctx, o: { priceUsdc: bigint; resource: string; description: string }): Promise<X402Requirement> {
  return {
    scheme: "exact",
    network: ctx.cfg.x402.network,
    maxAmountRequired: o.priceUsdc.toString(),
    resource: o.resource,
    description: o.description,
    mimeType: "application/json",
    payTo: ctx.cfg.x402.payTo!,
    maxTimeoutSeconds: ctx.cfg.fees.quoteTtlS,
    asset: ctx.cfg.chain.usdc,
    extra: { feePayer: x402FeePayer(ctx), decimals: USDC_DECIMALS },
  };
}

/** The x402 PaymentRequirementsResponse body. `error` is a string, as x402 clients expect. */
export const x402Body = (error: string, accepts: X402Requirement[], extra: Record<string, unknown> = {}) => ({ x402Version: X402_VERSION, error, accepts, ...extra });

const base64Json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** The same requirements as an x402 v2 PaymentRequired: `amount` for maxAmountRequired, the resource apart, the CAIP-2 network. */
export function x402RequiredV2(error: string, accepts: X402Requirement[]) {
  const first = accepts[0];
  return {
    x402Version: 2,
    error,
    resource: { url: first.resource, description: first.description, mimeType: first.mimeType },
    accepts: accepts.map((r) => ({ scheme: r.scheme, network: r.network, amount: r.maxAmountRequired, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra })),
  };
}

/** Headers of a 402 that asks for an x402 payment: `PAYMENT-REQUIRED` (base64 JSON, v2) beside the v1 JSON body. */
export const x402RequiredHeaders = (error: string, accepts: X402Requirement[]): Record<string, string> => (accepts.length ? { "payment-required": base64Json(x402RequiredV2(error, accepts)) } : {});

/** Value of the settlement headers: base64 JSON {success, transaction, network, payer}. */
export const x402ResponseHeader = (r: { transaction: string; network: string; payer: string }) => base64Json({ success: true, ...r });

/** A settled call carries the same settlement in `X-PAYMENT-RESPONSE` (v1) and `PAYMENT-RESPONSE` (v2). */
export const x402ResponseHeaders = (value: string): Record<string, string> => ({ "x-payment-response": value, "payment-response": value });

/** A failed settlement, as x402 v2 reports it in `PAYMENT-RESPONSE` on the 402. */
export const x402FailureHeader = (r: { errorReason: string; network: string; payer: string }): Record<string, string> => ({ "payment-response": base64Json({ success: false, transaction: "", ...r }) });

/** Read the decoded X-PAYMENT or PAYMENT-SIGNATURE JSON (v1, or v2 with `accepted`). Malformed payloads are a 400. */
export function parseX402(j: any): X402Payment {
  const bad = (): never => fail(400, "The payment is not a valid x402 `exact` payload (payload.transaction: a base64 Solana transaction).", "invalid_payment");
  const tx = j?.payload?.transaction;
  if (typeof tx !== "string" || !/^[A-Za-z0-9+/=]{64,8192}$/.test(tx)) bad();
  // v2 moves scheme and network into `accepted`, the requirement the payer chose.
  const chosen = j.accepted && typeof j.accepted === "object" ? j.accepted : j;
  return { version: Number(j.x402Version), scheme: String(chosen.scheme), network: String(chosen.network), transaction: tx };
}

// ---- Transaction inspection -------------------------------------------------------------------------------------------

const TRANSFER_CHECKED = 12; // SPL Token instruction tag
const ATA_CREATE_IDEMPOTENT = 1;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const edVerifyRaw = (pub: Uint8Array, message: Uint8Array, sig: Uint8Array) => {
  try { return edVerify(null, message, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" }), sig); } catch { return false; }
};

export type ExactTransfer = { tx: VersionedTransaction; feePayer: PublicKey; payer: PublicKey; source: PublicKey; destination: PublicKey; mint: PublicKey; amount: bigint; decimals: number; recentBlockhash: string; tokenProgram: PublicKey; /** What the fee payer will be charged on top of the base fee, in lamports. */ priorityFeeLamports: bigint };

/** x402 error reasons for the `exact` SVM scheme, named as Coinbase's facilitator names them where one exists. */
export type ExactReason =
  | "invalid_exact_svm_payload_transaction"
  | "invalid_exact_svm_payload_transaction_address_lookup_tables"
  | "invalid_exact_svm_payload_transaction_fee_payer"
  | "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts"
  | "invalid_exact_svm_payload_transaction_signatures"
  | "invalid_exact_svm_payload_transaction_instructions"
  | "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction"
  | "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction"
  | "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high"
  | "invalid_exact_svm_payload_transaction_create_ata_instruction"
  | "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked"
  | "invalid_exact_svm_payload_transaction_amount_mismatch"
  | "invalid_exact_svm_payload_transaction_asset_mismatch"
  | "invalid_exact_svm_payload_transaction_pay_to_mismatch"
  | "invalid_exact_svm_payload_transaction_decimals_mismatch"
  | "invalid_exact_svm_payload_transaction_payer_signature"
  | "invalid_exact_svm_payload_transaction_blockhash_expired"
  | "invalid_exact_svm_payload_transaction_simulation_failed"
  | "invalid_network"
  | "unsupported_scheme"
  | "invalid_x402_version"
  | "invalid_pay_to";

// ---- What the fee payer agrees to pay (security review TR-06) -----------------------------------------------------------
// The fee payer signs whatever the payer built, so everything that costs it SOL is bounded before it signs: the base fee
// (exactly two signatures), the priority fee (compute unit limit x price, both decoded and capped, and the product
// capped again), and rent (an associated token account may only be created with the payer's own lamports). The fee
// payer's key appears nowhere but the fee payer slot.

export type ExactLimits = {
  /** The largest SetComputeUnitLimit accepted (compute units). */
  maxComputeUnitLimit: number;
  /** The largest SetComputeUnitPrice accepted (micro-lamports per compute unit). */
  maxComputeUnitPriceMicroLamports: bigint;
  /** The largest priority fee, ceil(limit x price / 1e6), the fee payer will pay (lamports). */
  maxPriorityFeeLamports: bigint;
  /** Whether the payer may create payTo's associated token account in the transaction (funded by the payer, never by the fee payer). */
  allowAtaCreation: boolean;
};
/** 200,000 CU, 5 lamports per CU, and never more than 10,000 lamports of priority fee: about two base fees. */
export const DEFAULT_EXACT_LIMITS: ExactLimits = { maxComputeUnitLimit: 200_000, maxComputeUnitPriceMicroLamports: 5_000_000n, maxPriorityFeeLamports: 10_000n, allowAtaCreation: true };

/** The limits this router runs with (X402_MAX_* settings), for the router's own per-call path and the hosted facilitator. */
export const exactLimits = (ctx: Pick<Ctx, "cfg">): ExactLimits => ctx.cfg.facilitator.exact ?? DEFAULT_EXACT_LIMITS;

const COMPUTE_SET_UNIT_LIMIT = 2; // ComputeBudget instruction tags; 0 (deprecated request), 1 (heap frame) and 4 (loaded data size) are refused
const COMPUTE_SET_UNIT_PRICE = 3;
/** The runtime's default budget when no limit is set: 200,000 CU per instruction, at most 1.4M. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000, MAX_TRANSACTION_UNITS = 1_400_000;
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/** The priority fee the runtime charges: ceil(compute unit limit x micro-lamports per unit / 1e6) lamports. */
export const priorityFeeLamports = (unitLimit: number, microLamportsPerUnit: bigint) => (BigInt(unitLimit) * microLamportsPerUnit + 999_999n) / 1_000_000n;

/**
 * Decode an `exact` transaction and pull out its single transfer without touching the network. The instruction set is
 * closed: at most one SetComputeUnitLimit and one SetComputeUnitPrice (within `limits`, and their product within the
 * priority fee cap), at most one idempotent creation of payTo's associated token account funded by the payer, and
 * exactly one SPL TransferChecked (Token or Token-2022). No address lookup tables; fee payer = `feePayer`, named by no
 * instruction; exactly two required signatures (fee payer and payer), the payer's present and valid.
 */
export function inspectExactTransaction(base64: string, expect: { feePayer: PublicKey; payTo: PublicKey; mint: PublicKey }, limits: ExactLimits = DEFAULT_EXACT_LIMITS): { ok: true; transfer: ExactTransfer } | { ok: false; reason: ExactReason } {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(base64, "base64"))); } catch { return { ok: false, reason: "invalid_exact_svm_payload_transaction" }; }
  const msg = tx.message;
  if (msg.addressTableLookups.length) return { ok: false, reason: "invalid_exact_svm_payload_transaction_address_lookup_tables" };
  const keys = msg.staticAccountKeys;
  if (!keys.length || !keys[0].equals(expect.feePayer)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_fee_payer" };
  // Exactly the fee payer and the payer sign: every further signature is 5,000 lamports more of the fee payer's SOL.
  const n = msg.header.numRequiredSignatures;
  if (n !== 2) return { ok: false, reason: "invalid_exact_svm_payload_transaction_signatures" };
  const destination = getAssociatedTokenAddressSync(expect.mint, expect.payTo, true);
  let transfer: Omit<ExactTransfer, "priorityFeeLamports"> | null = null;
  let unitLimit: number | null = null, unitPrice: bigint | null = null, ataFunder: PublicKey | null = null, budgeted = 0;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    // The fee payer signs for the fee and nothing else: not a funder, an authority, a source, a destination or a program.
    if (ix.programIdIndex === 0 || ix.accountKeyIndexes.some((i) => i === 0 || keys[i]?.equals(expect.feePayer))) return { ok: false, reason: "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts" };
    if (ix.accountKeyIndexes.some((i) => !keys[i])) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    if (program.equals(ComputeBudgetProgram.programId)) {
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (ix.data[0] === COMPUTE_SET_UNIT_LIMIT) {
        if (unitLimit !== null || ix.data.length !== 5 || ix.accountKeyIndexes.length) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction" };
        unitLimit = view.getUint32(1, true);
        if (unitLimit > limits.maxComputeUnitLimit) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction" };
      } else if (ix.data[0] === COMPUTE_SET_UNIT_PRICE) {
        if (unitPrice !== null || ix.data.length !== 9 || ix.accountKeyIndexes.length) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction" };
        unitPrice = view.getBigUint64(1, true);
        if (unitPrice > limits.maxComputeUnitPriceMicroLamports) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high" };
      } else return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" }; // heap frame, loaded-accounts size, deprecated request
      continue;
    }
    budgeted++;
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // create_associated_token_account_idempotent(funder, ata, owner, mint, system, token): once, only for the destination.
      const [funder, ata, owner, mint, system, token] = ix.accountKeyIndexes.map((i) => keys[i]);
      const shaped = ix.accountKeyIndexes.length === 6 && ix.data.length === 1 && ix.data[0] === ATA_CREATE_IDEMPOTENT && !!funder && !!ata?.equals(destination) && !!owner?.equals(expect.payTo) && !!mint?.equals(expect.mint) && !!system?.equals(SYSTEM_PROGRAM_ID) && !!token && (token.equals(TOKEN_PROGRAM_ID) || token.equals(TOKEN_2022_PROGRAM_ID));
      if (!limits.allowAtaCreation || ataFunder || !shaped) return { ok: false, reason: "invalid_exact_svm_payload_transaction_create_ata_instruction" };
      ataFunder = funder!;
      continue;
    }
    if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    if (transfer) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    if (ix.data.length !== 10 || ix.data[0] !== TRANSFER_CHECKED) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked" };
    // Exactly source, mint, destination, authority: no multisig signer list to hide further accounts in.
    if (ix.accountKeyIndexes.length !== 4) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    const [source, mint, dest, owner] = ix.accountKeyIndexes.map((i) => keys[i]);
    if (!source || !mint || !dest || !owner) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
    const amount = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
    transfer = { tx, feePayer: keys[0], payer: owner, source, destination: dest, mint, amount, decimals: ix.data[9], recentBlockhash: msg.recentBlockhash, tokenProgram: program };
  }
  if (!transfer) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked" };
  if (!transfer.mint.equals(expect.mint)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_asset_mismatch" };
  if (!transfer.destination.equals(destination)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_pay_to_mismatch" };
  if (transfer.decimals !== USDC_DECIMALS) return { ok: false, reason: "invalid_exact_svm_payload_transaction_decimals_mismatch" };
  // Rent for payTo's token account comes from the payer's own lamports, or the account is not created here.
  if (ataFunder && !ataFunder.equals(transfer.payer)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_create_ata_instruction" };
  // The priority fee the fee payer would be charged. Without an explicit limit the runtime budgets per instruction.
  const effectiveLimit = unitLimit ?? Math.min(MAX_TRANSACTION_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * budgeted);
  const priorityFee = unitPrice === null ? 0n : priorityFeeLamports(effectiveLimit, unitPrice);
  if (priorityFee > limits.maxPriorityFeeLamports) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high" };
  // The payer (token authority) is the one other required signer, and its signature over the message is valid.
  const payerIndex = keys.findIndex((k) => k.equals(transfer!.payer));
  if (payerIndex < 1 || payerIndex >= n) return { ok: false, reason: "invalid_exact_svm_payload_transaction_payer_signature" };
  const serialized = msg.serialize();
  for (let i = 1; i < n; i++) {
    const sig = tx.signatures[i];
    if (!sig || sig.every((b) => b === 0) || !edVerifyRaw(keys[i].toBytes(), serialized, sig)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_payer_signature" };
  }
  return { ok: true, transfer: { ...transfer, priorityFeeLamports: priorityFee } };
}

export type VerifyDeps = { rpc?: Pick<RpcLike, "isBlockhashValid" | "simulateTransaction">; feePayer: PublicKey; now?: number; simulate?: boolean; /** Fee and instruction bounds (default: DEFAULT_EXACT_LIMITS). */ limits?: ExactLimits };

/** Full verification: shape, amount, freshness of the blockhash and (optionally) a simulation. */
export async function verifyExact(p: X402Payment, req: X402Requirement, deps: VerifyDeps): Promise<{ ok: true; transfer: ExactTransfer } | { ok: false; reason: ExactReason }> {
  if (!X402_VERSIONS.includes(p.version)) return { ok: false, reason: "invalid_x402_version" };
  if (p.scheme !== "exact" || req.scheme !== "exact") return { ok: false, reason: "unsupported_scheme" };
  if (p.network !== req.network) return { ok: false, reason: "invalid_network" };
  if (!isAddress(req.payTo)) return { ok: false, reason: "invalid_pay_to" };
  const inspected = inspectExactTransaction(p.transaction, { feePayer: deps.feePayer, payTo: new PublicKey(req.payTo), mint: new PublicKey(req.asset) }, deps.limits);
  if (!inspected.ok) return inspected;
  const required = BigInt(req.maxAmountRequired);
  if (inspected.transfer.amount < required) return { ok: false, reason: "invalid_exact_svm_payload_transaction_amount_mismatch" };
  if (deps.rpc) {
    const fresh = await withRetry(() => deps.rpc!.isBlockhashValid(inspected.transfer.recentBlockhash, { commitment: "confirmed" })).catch(() => null);
    if (fresh && !fresh.value) return { ok: false, reason: "invalid_exact_svm_payload_transaction_blockhash_expired" };
    if (deps.simulate) {
      const sim = await withRetry(() => deps.rpc!.simulateTransaction(inspected.transfer.tx, { sigVerify: false, replaceRecentBlockhash: false })).catch(() => null);
      if (sim?.value.err) return { ok: false, reason: "invalid_exact_svm_payload_transaction_simulation_failed" };
    }
  }
  return inspected;
}

/** Verify a payment against the requirement without moving funds. Returns an x402 error reason, or null when valid. */
export async function verifyX402(ctx: Ctx, p: X402Payment, req: X402Requirement, rpc?: VerifyDeps["rpc"]): Promise<string | null> {
  if (p.network !== req.network && p.network === ctx.cfg.chain.network) p = { ...p, network: req.network };
  const feePayer = ctx.chain.roleAddress("router");
  if (!feePayer) return "facilitator_unavailable";
  const r = await verifyExact(p, req, { feePayer: new PublicKey(feePayer), rpc: rpc ?? ctx.chain.connection ?? undefined, limits: exactLimits(ctx) });
  return r.ok ? null : r.reason;
}

// ---- Settlement -------------------------------------------------------------------------------------------------------

/**
 * `sent` (on a failure): whether the transaction left this process. False means the fee payer paid nothing. `onChain`:
 * it landed and failed, so the fee payer paid the fee for nothing (security review round 3, R3-01).
 */
export type SettleResult = { success: true; transaction: string; network: string; payer: string } | { success: false; errorReason: string; network: string; payer: string; sent?: boolean; onChain?: boolean };

/**
 * Simulate, then co-sign as fee payer and submit. The transaction is sent exactly as the payer signed it.
 *
 * The simulation comes BEFORE the fee payer's signature: a payment that would fail (an unfunded payer, a closed token
 * account) is refused here, is never sent and costs the fee payer nothing. An RPC that cannot simulate is a refusal
 * too: a fee payer does not sign what it could not check.
 */
export async function settleExact(rpc: Pick<RpcLike, "sendRawTransaction" | "confirmTransaction" | "getLatestBlockhash"> & Partial<Pick<RpcLike, "simulateTransaction" | "getSignatureStatuses">>, transfer: ExactTransfer, feePayer: Keypair, network: string, commitment: "confirmed" | "finalized" = "confirmed"): Promise<SettleResult> {
  const payer = transfer.payer.toBase58();
  const classify = (m: string) => (/blockhash|expired/i.test(m) ? "invalid_exact_svm_payload_transaction_blockhash_expired" : /insufficient/i.test(m) ? "insufficient_funds" : "settle_transaction_failed");
  if (!rpc.simulateTransaction) return { success: false, errorReason: "settle_transaction_failed", network, payer, sent: false };
  try {
    const sim = await withRetry(() => rpc.simulateTransaction!(transfer.tx, { sigVerify: false, replaceRecentBlockhash: false, commitment }));
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).join(" ");
      // SPL Token's "insufficient funds" is custom error 1 of the transfer; anything else is a plain failed simulation.
      const insufficient = /insufficient/i.test(logs) || /"Custom":\s*1\b/.test(JSON.stringify(sim.value.err));
      return { success: false, errorReason: insufficient ? "insufficient_funds" : "invalid_exact_svm_payload_transaction_simulation_failed", network, payer, sent: false };
    }
  } catch (e) {
    return { success: false, errorReason: classify(String((e as Error).message ?? e)), network, payer, sent: false };
  }
  let signature: string;
  try {
    transfer.tx.sign([feePayer]);
    const raw = Buffer.from(transfer.tx.serialize());
    signature = await withRetry(() => rpc.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: commitment, maxRetries: 3 }));
  } catch (e) {
    // Refused by the node's own preflight or never accepted: nothing was broadcast.
    return { success: false, errorReason: classify(String((e as Error).message ?? e)), network, payer, sent: false };
  }
  try {
    const { lastValidBlockHeight } = await withRetry(() => rpc.getLatestBlockhash(commitment));
    await confirmSignature(rpc, signature, { blockhash: transfer.recentBlockhash, lastValidBlockHeight }, commitment);
    return { success: true, transaction: signature, network, payer };
  } catch (e) {
    const m = String((e as Error).message ?? e);
    // Did it land and fail (the fee is paid), or did it never land? Ask the cluster; unknown counts as not landed here
    // (the caller keeps the budget spent either way).
    const outcome = rpc.getSignatureStatuses ? await signatureOutcome(rpc as Pick<RpcLike, "getSignatureStatuses">, signature).catch(() => null) : null;
    return { success: false, errorReason: classify(m), network, payer, sent: true, onChain: outcome === "failed" };
  }
}

/**
 * Fee sponsorship recovery (§5.2): the facilitator pays `feeLamports` of SOL; priced at `solUsdc` (USDC base units per
 * SOL) and buffered by `bufferBps` (10000 = exactly), that cost is recovered from the settled amount. Never more than
 * the amount itself; zero when no SOL price is configured.
 */
export function sponsorshipRecovery(amount: bigint, feeLamports: bigint, solUsdc: bigint | null, bufferBps = 10_000): bigint {
  if (!solUsdc || solUsdc <= 0n || feeLamports <= 0n) return 0n;
  const usdc = (feeLamports * solUsdc * BigInt(bufferBps)) / (1_000_000_000n * 10_000n);
  return usdc > amount ? amount : usdc;
}

// ---- External facilitator (X402_FACILITATOR_URL) ------------------------------------------------------------------------
// The body shape Coinbase's facilitator takes: { x402Version, paymentPayload, paymentRequirements }.

export type FacilitatorClient = { verify(payload: unknown, req: X402Requirement): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>; settle(payload: unknown, req: X402Requirement): Promise<SettleResult> };

export function facilitatorClient(url: string, fetchImpl: typeof fetch = fetch): FacilitatorClient {
  const post = async (path: string, payload: unknown, req: X402Requirement) => {
    const res = await fetchImpl(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: (payload as { x402Version?: number })?.x402Version ?? X402_VERSION, paymentPayload: payload, paymentRequirements: req }), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON answer */ }
    if (!res.ok || !json) throw new Error(`facilitator ${path} answered ${res.status}`);
    return json;
  };
  return {
    verify: async (payload, req) => { const j = await post("/verify", payload, req); return { isValid: j.isValid === true, invalidReason: typeof j.invalidReason === "string" ? j.invalidReason : undefined, payer: typeof j.payer === "string" ? j.payer : undefined }; },
    settle: async (payload, req) => { const j = await post("/settle", payload, req); return j.success === true ? { success: true, transaction: String(j.transaction), network: String(j.network ?? req.network), payer: String(j.payer ?? "") } : { success: false, errorReason: String(j.errorReason ?? "settle_failed"), network: String(j.network ?? req.network), payer: String(j.payer ?? "") }; },
  };
}
