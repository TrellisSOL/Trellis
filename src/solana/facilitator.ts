import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { facilitatorSettlements } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { log, uid } from "../lib/util.ts";
import { isAddress, SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from "./constants.ts";
import { addressBucket } from "../api/common.ts";
import { confirmSignature, withRetry } from "./rpc.ts";
import { FAILED_ON_CHAIN, sponsorAdmit } from "./sponsor.ts";
import { checkVoucherAgainstTab, inspectCloseTransaction, isVerifiedAccountError, parseWireVoucher, readTab, readTabConfig, tabEscrowProblem, tabProgram, type InspectedClose, type TabAccount } from "./tab.ts";
import { X402_VERSIONS, exactLimits, inspectExactTransaction, settleExact, type ExactTransfer, type X402Payment, type X402Requirement } from "./x402.ts";

// The hosted x402 facilitator (docs/Trellis_Backend.md §5.2): GET /facilitator/supported, POST /facilitator/verify,
// POST /facilitator/settle for schemes `exact` and `tab` on solana:mainnet (and devnet when the router runs there).
// Non-custodial: funds move payer -> payee. `exact`: the payer's signed transfer, co-signed by the relay as fee payer.
// `tab`: trellis_tab::close can only be signed by the tab's payee, so settlement is a relay of a payee-signed close:
// the seller sends the voucher plus `payload.transaction`, its `[Ed25519(voucher), close]` with the relay as fee payer
// and its own signature; the facilitator checks the voucher against the Tab, checks the transaction is exactly that
// close, co-signs as fee payer and submits (escrow -> payee, remainder -> payer). The relay key only ever pays fees.
// Fee: none, by construction (zero markup): FACILITATOR_FEE_BPS can only be 0 and nothing here charges one. The SOL fee
// the relay pays is recovered from a seller's prepaid fee float when a SOL price is configured (sponsorship).
// Request and answer shapes follow Coinbase's facilitator so any x402 seller library can point at this URL:
// { x402Version, paymentPayload, paymentRequirements } in, { isValid, invalidReason, payer } / { success, errorReason,
// transaction, network, payer } out.

export const SUPPORTED_NETWORKS: readonly string[] = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2];
export const SCHEMES = ["exact", "tab"] as const;
export type Scheme = (typeof SCHEMES)[number];

/** The hosted facilitator charges no fee (zero markup): there is no fee to waive. Kept for the status fields. */
export function feeWaived(_ctx: Ctx, _now = new Date()) {
  return true;
}
/** Always zero: no fee is charged on a settlement, whatever the configuration says. */
export const feeFor = (_ctx: Ctx, _amount: bigint, _now = new Date()) => 0n;

/** What /api/v1/status says about the facilitator. */
export function facilitatorStatus(ctx: Ctx) {
  const f = ctx.cfg.facilitator;
  const relay = f.relayAddress ?? ctx.chain.roleAddress("facilitator");
  return {
    enabled: f.enabled,
    url: f.enabled ? `${ctx.cfg.publicUrl}/facilitator` : null,
    networks: f.enabled ? [ctx.cfg.chain.network] : [],
    schemes: f.enabled ? [...SCHEMES] : [],
    fee_bps: f.feeBps,
    fee_waived: feeWaived(ctx),
    fee_waiver_until: ctx.cfg.solana.feeWaiverUntil?.toISOString() ?? null,
    min_settle_units: f.minSettle.toString(),
    fee_floats: false, // the relay pays network fees and recovers nothing from sellers or payers (2026-11-04)
    relay: f.enabled ? { address: relay ?? null, balance_floor_lamports: f.relayFloorLamports.toString(), above_floor: null, checked_at: null } : null,
    listings_screened: ctx.cfg.sanctions.enabled,
    tab_program: ctx.cfg.solana.programs.tab ?? null,
    /** `tab` settlement is a relay of the payee-signed close: the seller signs, the facilitator pays the fee. */
    tab_settlement: "payee_signed_close_relayed",
    ported: true,
  };
}

type Requirements = { scheme: string; network: string; payTo: string; asset: string; amount: bigint; maxTimeoutSeconds: number; extra: Record<string, unknown> };

/** Both v1 (`maxAmountRequired`) and v2 (`amount`) requirement shapes. */
function parseRequirements(j: any): Requirements | null {
  if (!j || typeof j !== "object") return null;
  const amountRaw = typeof j.maxAmountRequired === "string" ? j.maxAmountRequired : typeof j.amount === "string" ? j.amount : null;
  if (!amountRaw || !/^\d{1,20}$/.test(amountRaw)) return null;
  if (typeof j.scheme !== "string" || typeof j.network !== "string" || !isAddress(j.payTo) || !isAddress(j.asset)) return null;
  return { scheme: j.scheme, network: j.network, payTo: j.payTo, asset: j.asset, amount: BigInt(amountRaw), maxTimeoutSeconds: Number(j.maxTimeoutSeconds) || 60, extra: j.extra && typeof j.extra === "object" ? j.extra : {} };
}

type ParsedPayload = { version: number; scheme: string; network: string; payload: any };
function parsePayload(j: any): ParsedPayload | null {
  if (!j || typeof j !== "object" || !j.payload || typeof j.payload !== "object") return null;
  const chosen = j.accepted && typeof j.accepted === "object" ? j.accepted : j;
  const version = Number(j.x402Version);
  if (!X402_VERSIONS.includes(version) || typeof chosen.scheme !== "string" || typeof chosen.network !== "string") return null;
  return { version, scheme: chosen.scheme, network: chosen.network, payload: j.payload };
}

type Verified =
  | { ok: true; scheme: "exact"; payer: string; nonce: string; amount: bigint; transfer: ExactTransfer }
  | { ok: true; scheme: "tab"; payer: string; nonce: string; amount: bigint; tab: TabAccount; voucher: NonNullable<ReturnType<typeof parseWireVoucher>>; close: InspectedClose | null }
  | { ok: false; reason: string; payer?: string };

async function verifyRequest(ctx: Ctx, p: ParsedPayload, req: Requirements, forSettle = false): Promise<Verified> {
  const f = ctx.cfg.facilitator;
  const relay = ctx.chain.signer("facilitator");
  if (!relay) return { ok: false, reason: "facilitator_unavailable" };
  if (p.scheme !== req.scheme) return { ok: false, reason: "unsupported_scheme" };
  if (p.network !== req.network || p.network !== ctx.cfg.chain.network) return { ok: false, reason: "invalid_network" };
  if (req.asset !== ctx.cfg.chain.usdc) return { ok: false, reason: "unsupported_asset" };
  if (req.amount < f.minSettle) return { ok: false, reason: "amount_below_minimum" };
  if (p.scheme === "exact") {
    if (typeof p.payload.transaction !== "string") return { ok: false, reason: "invalid_exact_svm_payload_transaction" };
    const r = inspectExactTransaction(p.payload.transaction, { feePayer: relay.publicKey, payTo: new PublicKey(req.payTo), mint: new PublicKey(req.asset) }, exactLimits(ctx));
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.transfer.amount < req.amount) return { ok: false, reason: "invalid_exact_svm_payload_transaction_amount_mismatch", payer: r.transfer.payer.toBase58() };
    const fresh = await withRetry(() => ctx.chain.connection.isBlockhashValid(r.transfer.recentBlockhash, { commitment: "confirmed" })).catch(() => null);
    if (fresh && !fresh.value) return { ok: false, reason: "invalid_exact_svm_payload_transaction_blockhash_expired", payer: r.transfer.payer.toBase58() };
    const payerIndex = r.transfer.tx.message.staticAccountKeys.findIndex((k) => k.equals(r.transfer.payer));
    return { ok: true, scheme: "exact", payer: r.transfer.payer.toBase58(), nonce: Buffer.from(r.transfer.tx.signatures[payerIndex]).toString("base64"), amount: r.transfer.amount, transfer: r.transfer };
  }
  if (p.scheme === "tab") {
    const program = tabProgram(ctx.cfg);
    if (!program) return { ok: false, reason: "unsupported_scheme" };
    const v = parseWireVoucher(p.payload.voucher ?? p.payload);
    if (!v) return { ok: false, reason: "invalid_tab_voucher" };
    // The voucher names the tab: it is one only if the tab program owns the account at its own PDA, and it is worth
    // vouching for only if its escrow holds the cap (TR-02). A seller is never told a look-alike account is a valid tab.
    let tab: Awaited<ReturnType<typeof readTab>>;
    try { tab = await readTab(ctx.chain.connection, v.voucher.tab, program); } catch (e) { return { ok: false, reason: isVerifiedAccountError(e) ? e.code : "tab_not_found" }; }
    if (!tab) return { ok: false, reason: "tab_not_found" };
    const underfunded = tabEscrowProblem(tab);
    if (underfunded) return { ok: false, reason: underfunded, payer: tab.payer.toBase58() };
    const config = await readTabConfig(ctx.chain.connection, program).catch(() => null);
    const problem = checkVoucherAgainstTab(tab, v.voucher, v.signature, { programId: program.programId, payee: new PublicKey(req.payTo), mint: new PublicKey(req.asset), now: Math.floor(Date.now() / 1000), reclaimGrace: config ? Number(config.reclaimGrace) : undefined });
    if (problem) return { ok: false, reason: problem, payer: tab.payer.toBase58() };
    if (v.voucher.cumulativeUsed < req.amount) return { ok: false, reason: "voucher_below_amount", payer: tab.payer.toBase58() };
    let close: InspectedClose | null = null;
    if (typeof p.payload.transaction === "string") {
      const r = inspectCloseTransaction(p.payload.transaction, program, tab, { tab: v.voucher.tab, feePayer: relay.publicKey, voucher: v.voucher });
      if (!r.ok) return { ok: false, reason: r.reason, payer: tab.payer.toBase58() };
      const fresh = await withRetry(() => ctx.chain.connection.isBlockhashValid(r.close.recentBlockhash, { commitment: "confirmed" })).catch(() => null);
      if (fresh && !fresh.value) return { ok: false, reason: "invalid_tab_close_blockhash_expired", payer: tab.payer.toBase58() };
      close = r.close;
    } else if (forSettle) return { ok: false, reason: "tab_close_transaction_required", payer: tab.payer.toBase58() };
    return { ok: true, scheme: "tab", payer: tab.payer.toBase58(), nonce: Buffer.from(v.signature).toString("base64"), amount: v.voucher.cumulativeUsed, tab, voucher: v, close };
  }
  return { ok: false, reason: "unsupported_scheme" };
}

/**
 * Why the relay will not sign a settlement right now, or null: its SOL balance is below FACILITATOR_RELAY_FLOOR_LAMPORTS
 * (or cannot be read), the payer / the seller is past its per-minute limit (FACILITATOR_PAYER_PER_MIN,
 * FACILITATOR_SELLER_PER_MIN), or the relay's fee budget for the minute is spent (FACILITATOR_RELAY_LAMPORTS_PER_MIN). Checked before the claim and before the relay key touches the transaction.
 */
/** The most one settlement can cost the relay (base fee plus the capped priority fee): what the fee budget counts. */
export const RELAY_WORST_CASE_LAMPORTS = { exact: 20_000, tab: 15_000 } as const;

export async function relayRefusal(ctx: Ctx, relay: PublicKey, payer: string, seller: string, worstCaseLamports: number = RELAY_WORST_CASE_LAMPORTS.exact): Promise<{ reason: "facilitator_unavailable" | "rate_limited" | "payer_not_sponsored"; status: 503 | 429 | 403 } | null> {
  // The bounds are the shared ones of every sponsored fee (src/solana/sponsor.ts; security re-review RR-11, review
  // round 3 R3-01 and R3-17): per payer and per seller a minute, the payer's own daily share, the relay's balance floor
  // BEFORE any budget is touched, then the relay's budget per minute and per day, counted at the worst case.
  const admission = await sponsorAdmit(ctx, { scope: "relay", feePayer: relay, payer, seller, worstCaseLamports });
  return admission.ok ? null : { reason: admission.reason, status: admission.status };
}

export function facilitatorRoutes(app: Hono, ctx: Ctx) {
  const f = ctx.cfg.facilitator;
  const on = () => {
    if (!f.enabled) fail(503, "The facilitator is not switched on at this router.", "facilitator_disabled");
  };
  const readBody = async (c: Context) => {
    on();
    c.header("Cache-Control", "no-store");
    let j: any;
    try { j = await c.req.json(); } catch { fail(400, "The body must be JSON { x402Version, paymentPayload, paymentRequirements }.", "invalid_request"); }
    const payload = parsePayload(j?.paymentPayload ?? j);
    const req = parseRequirements(j?.paymentRequirements);
    if (!payload || !req) fail(400, "paymentPayload or paymentRequirements is malformed.", "invalid_request");
    return { payload: payload!, req: req! };
  };
  const kinds = () => {
    if (!f.enabled) return [];
    const out: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[] = [];
    for (const version of X402_VERSIONS) {
      out.push({ x402Version: version, scheme: "exact", network: ctx.cfg.chain.network, extra: { feePayer: f.relayAddress ?? null } });
      if (ctx.cfg.solana.programs.tab) out.push({ x402Version: version, scheme: "tab", network: ctx.cfg.chain.network, extra: { program: ctx.cfg.solana.programs.tab, feePayer: f.relayAddress ?? null, maxCapUnits: ctx.cfg.solana.caps.tabUnits.toString(), settlement: "payee_signed_close_relayed" } });
    }
    return out;
  };

  app.get("/facilitator/supported", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ kinds: kinds(), fee_bps: feeWaived(ctx) ? 0 : f.feeBps, fee_waiver_until: ctx.cfg.solana.feeWaiverUntil?.toISOString() ?? null, networks: f.enabled ? [ctx.cfg.chain.network] : [] });
  });

  app.post("/facilitator/verify", async (c) => {
    const { payload, req } = await readBody(c);
    const v = await verifyRequest(ctx, payload, req);
    if (!v.ok) return c.json({ isValid: false, invalidReason: v.reason, payer: v.payer ?? null });
    return c.json({ isValid: true, payer: v.payer });
  });

  app.post("/facilitator/settle", async (c) => {
    const { payload, req } = await readBody(c);
    const network = ctx.cfg.chain.network;
    const v = await verifyRequest(ctx, payload, req, true);
    if (!v.ok) return c.json({ success: false, errorReason: v.reason, transaction: "", network, payer: v.payer ?? "" }, 400);
    const relay = ctx.chain.signer("facilitator")!;
    // Before anything is claimed or signed (security review TR-06): the relay keeps a SOL floor, and one payer or one
    // seller cannot make it sign without bound. A refusal here leaves the payment unclaimed, so it can be settled later.
    const from = addressBucket(c, ctx.cfg);
    const admission = await sponsorAdmit(ctx, { scope: "relay", feePayer: relay.publicKey, payer: v.payer, seller: req.payTo, sourceOk: async () => (await ctx.limiter.take(`sponsor-source:${from.id}`, 1, from.scale(ctx.cfg.facilitator.sponsor.sourcePerMin), 60_000)).ok, worstCaseLamports: RELAY_WORST_CASE_LAMPORTS[v.scheme === "tab" ? "tab" : "exact"] });
    if (!admission.ok) return c.json({ success: false, errorReason: admission.reason, transaction: "", network, payer: v.payer }, admission.status);
    // (payer, nonce) is the durable claim: a replay settles once and gets the same answer.
    const claimed = await ctx.db.insert(facilitatorSettlements).values({ id: uid("fs_"), kind: "payment", scheme: v.scheme, payer: v.payer, payTo: req.payTo, value: v.amount, nonce: v.nonce, status: "verified", x402Version: payload.version, feeValue: feeFor(ctx, v.amount) }).onConflictDoNothing().returning({ id: facilitatorSettlements.id });
    if (!claimed.length) {
      await admission.release(); // nothing will be sent for this request
      const [existing] = await ctx.db.select().from(facilitatorSettlements).where(and(eq(facilitatorSettlements.payer, v.payer), eq(facilitatorSettlements.nonce, v.nonce)));
      if (existing?.status === "settled" && existing.txHash) return c.json({ success: true, transaction: existing.txHash, network, payer: v.payer });
      return c.json({ success: false, errorReason: existing?.status === "failed" ? "settle_transaction_failed" : "payment_already_claimed", transaction: "", network, payer: v.payer }, 409);
    }
    const id = claimed[0].id;
    // `sent`: whether anything left this process (R3-17). A settlement that was refused by simulation or by the node's
    // preflight cost the relay nothing: its budget is handed back and its claim released, so unfunded callers cannot
    // use up the minute for everyone else. `onChain`: it landed and failed; the payer is not sponsored again.
    let result: { success: true; transaction: string } | { success: false; errorReason: string; sent: boolean; onChain: boolean };
    let sent = false;
    try {
      if (v.scheme === "exact") {
        const s = await settleExact(ctx.chain.connection, v.transfer, relay, network, ctx.cfg.solana.commitment);
        result = s.success ? { success: true, transaction: s.transaction } : { success: false, errorReason: s.errorReason, sent: s.sent !== false, onChain: !!s.onChain };
      } else {
        // tab: the payee-signed close, co-signed by the relay as fee payer and sent exactly as the payee signed it.
        const tx = v.close!.tx;
        tx.partialSign(relay);
        // Simulated before it is sent: a close that would fail is not paid for.
        const sim = await withRetry(() => ctx.chain.connection.simulateTransaction(tx));
        if (sim.value.err) throw new Error("simulation failed");
        const raw = Buffer.from(tx.serialize());
        const signature = await withRetry(() => ctx.chain.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: ctx.cfg.solana.commitment, maxRetries: 3 }));
        sent = true;
        const { lastValidBlockHeight } = await withRetry(() => ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment));
        await confirmSignature(ctx.chain.connection, signature, { blockhash: v.close!.recentBlockhash, lastValidBlockHeight }, ctx.cfg.solana.commitment);
        result = { success: true, transaction: signature };
      }
    } catch (e) {
      result = { success: false, errorReason: /blockhash|expired/i.test(String((e as Error).message)) ? "invalid_exact_svm_payload_transaction_blockhash_expired" : "settle_transaction_failed", sent, onChain: sent && /failed: /.test(String((e as Error).message)) };
      log.warn("facilitator settle failed", { scheme: v.scheme, error: (e as Error).message.slice(0, 200) });
    }
    if (!result.success) {
      if (!result.sent) {
        await admission.release();
        await ctx.db.delete(facilitatorSettlements).where(eq(facilitatorSettlements.id, id));
      } else await ctx.db.update(facilitatorSettlements).set({ status: "failed", error: result.onChain ? FAILED_ON_CHAIN : result.errorReason }).where(eq(facilitatorSettlements.id, id));
      return c.json({ success: false, errorReason: result.errorReason, transaction: "", network, payer: v.payer }, 400);
    }
    // The relay pays the network fee of a hosted settlement and recovers nothing from the seller or the payer (the
    // facilitator charges no fee float: decided 2026-11-04 when it joined the launch). The row records what the relay
    // paid, read from the landed transaction, and `gas_debit` 0, so the status page's "recovered" figure stays true.
    const paid = await landedFeeLamports(ctx, result.transaction);
    await ctx.db.update(facilitatorSettlements).set({ status: "settled", txHash: result.transaction, settledAt: new Date(), gasDebit: 0n, feeLamports: paid }).where(eq(facilitatorSettlements.id, id));
    return c.json({ success: true, transaction: result.transaction, network, payer: v.payer });
  });
}

/** The fee the fee payer was charged for a landed transaction, in lamports; null when the RPC does not say. */
async function landedFeeLamports(ctx: Ctx, signature: string): Promise<bigint | null> {
  try {
    const t = await ctx.chain.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const fee = t?.meta?.fee;
    return typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? BigInt(fee) : null;
  } catch {
    return null;
  }
}

export type { X402Payment, X402Requirement };
