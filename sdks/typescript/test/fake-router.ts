// A local fake router (Bun.serve on a random port) that answers like the real one: receipts signed with the RFC 8032
// Section 7.1 test 1 key (public test vector), the v2 receipt from packages/client's fixture, SSE with chain comments.
import { createHash, createPrivateKey, createPublicKey, sign, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, EXACT_LIMITS, SOLANA_DEVNET, SYSTEM_PROGRAM, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress, base58Decode, base58Encode, bytesToBase64Url, canonicalBytes, hexToBytes, priorityFeeLamports, receiptLeaf, walletAuthMessage } from "@trellis/client";

/** The router's own contract fixtures (sdks/fixtures/contracts.json, written by sdks/fixtures/generate.ts from the router's code). */
export const CONTRACTS = JSON.parse(readFileSync(new URL("../../fixtures/contracts.json", import.meta.url), "utf8"));

export const V2 = JSON.parse(readFileSync(new URL("../../../packages/client/test/fixtures/receipt-v2.json", import.meta.url), "utf8")) as {
  public_key_hex: string;
  key_id: string;
  cose: string;
  leaf: string;
  claims: Record<string, any>;
  chunks: string[];
  chain_steps: string[];
};
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // RFC 8032 test 1 secret (public)
const pub = hexToBytes(V2.public_key_hex);
const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: bytesToBase64Url(hexToBytes(SEED_HEX)), x: bytesToBase64Url(pub) }, format: "jwk" });
export const JWKS = { keys: [{ kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(pub), kid: V2.key_id, use: "sig", alg: "EdDSA", valid_from: "2026-01-01T00:00:00.000Z", retired_at: null }] };

// Solana placeholders: the router's fee payer (a keypair from a constant seed), a payTo address and a tab program id
// made of repeated bytes. Not real wallets.
export const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(9));
export const PAY_TO = base58Encode(new Uint8Array(32).fill(3));
export const TAB_PROGRAM = base58Encode(new Uint8Array(32).fill(5));
export const BLOCKHASH = base58Encode(new Uint8Array(32).fill(42));
export const NETWORK = SOLANA_DEVNET;
export const PRICE_UNITS = "12300";
export const HOLDER_TIER = { name: "Seed", min: "10000", rpm_multiplier: 2, tpm_multiplier: 2, max_agent_keys: 25, max_saved_routes: 200, max_batch_rows: null, sealed_priority: 1, early_access_hours: 12, vote_weight: 1, credits_never_expire: false, badge: true };
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const edVerifyRaw = (pub: Uint8Array, message: Uint8Array, sig: Uint8Array) => edVerify(null, message, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" }), sig);
const requirement = () => ({ scheme: "exact", network: NETWORK, maxAmountRequired: PRICE_UNITS, resource: "/api/v1/chat/completions", description: "Pay-per-call inference: example/model", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC_MINT, extra: { feePayer: FEE_PAYER.publicKey.toBase58(), decimals: 6 } });
const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** The checks src/solana/x402.ts inspectExactTransaction makes, on the X-PAYMENT value. Returns the payer, or a reason. */
export function checkPayment(header: string): { ok: true; payer: string; amount: bigint } | { ok: false; reason: string } {
  let j: any;
  try { j = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { return { ok: false, reason: "invalid_payment" }; }
  if (j?.x402Version !== 1 || j.scheme !== "exact") return { ok: false, reason: "unsupported_scheme" };
  if (j.network !== NETWORK) return { ok: false, reason: "invalid_network" };
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(j.payload.transaction, "base64")); } catch { return { ok: false, reason: "invalid_exact_svm_payload_transaction" }; }
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (msg.addressTableLookups.length) return { ok: false, reason: "invalid_exact_svm_payload_transaction_address_lookup_tables" };
  if (!keys[0]?.equals(FEE_PAYER.publicKey)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_fee_payer" };
  // What the fee payer signs is bounded (src/solana/x402.ts, security review TR-06): exactly two signers, the fee payer in
  // no instruction, compute-budget instructions within the caps, payTo's token account created by the payer if at all.
  if (msg.header.numRequiredSignatures !== 2) return { ok: false, reason: "invalid_exact_svm_payload_transaction_signatures" };
  if (msg.compiledInstructions.some((ix) => ix.programIdIndex === 0 || ix.accountKeyIndexes.includes(0))) return { ok: false, reason: "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts" };
  const programOf = (ix: (typeof msg.compiledInstructions)[number]) => keys[ix.programIdIndex].toBase58();
  const budget = msg.compiledInstructions.filter((ix) => programOf(ix) === COMPUTE_BUDGET_PROGRAM);
  const limits = budget.filter((ix) => ix.data[0] === 2), prices = budget.filter((ix) => ix.data[0] === 3);
  if (budget.length !== limits.length + prices.length || limits.length > 1 || prices.length > 1) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
  const view = (ix: (typeof budget)[number]) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  const unitLimit = limits[0] ? view(limits[0]).getUint32(1, true) : null, unitPrice = prices[0] ? view(prices[0]).getBigUint64(1, true) : null;
  if (unitLimit !== null && unitLimit > EXACT_LIMITS.maxComputeUnitLimit) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction" };
  const atas = msg.compiledInstructions.filter((ix) => programOf(ix) === ASSOCIATED_TOKEN_PROGRAM);
  const others = msg.compiledInstructions.length - budget.length;
  if (unitPrice !== null && (unitPrice > EXACT_LIMITS.maxComputeUnitPriceMicroLamports || priorityFeeLamports(unitLimit ?? Math.min(1_400_000, 200_000 * others), unitPrice) > EXACT_LIMITS.maxPriorityFeeLamports)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high" };
  const transfers = msg.compiledInstructions.filter((ix) => programOf(ix) === TOKEN_PROGRAM);
  if (transfers.length !== 1 || atas.length > 1 || msg.compiledInstructions.length !== transfers.length + atas.length + budget.length) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instructions" };
  const [ix] = transfers;
  if (atas[0]) {
    const [funder, ata, owner, ataMint, system] = atas[0].accountKeyIndexes.map((i) => keys[i].toBase58());
    const payerOfTransfer = keys[ix.accountKeyIndexes[3]].toBase58();
    if (atas[0].data.length !== 1 || atas[0].data[0] !== 1 || funder !== payerOfTransfer || ata !== associatedTokenAddress(PAY_TO) || owner !== PAY_TO || ataMint !== USDC_MINT || system !== SYSTEM_PROGRAM) return { ok: false, reason: "invalid_exact_svm_payload_transaction_create_ata_instruction" };
  }
  if (ix.data.length !== 10 || ix.data[0] !== 12) return { ok: false, reason: "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked" };
  const [, mint, dest, owner] = ix.accountKeyIndexes.map((i) => keys[i]);
  if (mint.toBase58() !== USDC_MINT) return { ok: false, reason: "invalid_exact_svm_payload_transaction_asset_mismatch" };
  if (dest.toBase58() !== associatedTokenAddress(PAY_TO)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_pay_to_mismatch" };
  if (ix.data[9] !== 6) return { ok: false, reason: "invalid_exact_svm_payload_transaction_decimals_mismatch" };
  const amount = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
  if (amount < BigInt(PRICE_UNITS)) return { ok: false, reason: "invalid_exact_svm_payload_transaction_amount_mismatch" };
  const n = msg.header.numRequiredSignatures;
  const payerIndex = keys.findIndex((k) => k.equals(owner));
  if (payerIndex < 1 || payerIndex >= n) return { ok: false, reason: "invalid_exact_svm_payload_transaction_payer_signature" };
  for (let i = 1; i < n; i++) if (!tx.signatures[i] || tx.signatures[i].every((b) => b === 0) || !edVerifyRaw(keys[i].toBytes(), msg.serialize(), tx.signatures[i])) return { ok: false, reason: "invalid_exact_svm_payload_transaction_payer_signature" };
  return { ok: true, payer: owner.toBase58(), amount };
}

/** The keypair of the API key being closed in the fake router (a constant seed: a placeholder, not a real key). */
export const KEY_SIGNER = Keypair.fromSeed(new Uint8Array(32).fill(13));
/**
 * What POST /api/v1/credits/close (and close/cancel) returns: a transaction with `payer` as fee payer that ALREADY
 * carries the signature of the key's own keypair (security review TR-05); the payer's slot is empty. It names no
 * destination (re-review RR-05): the refund returns to the wallets that deposited.
 */
const keySignedFor = (payer: string, tag: number) => {
  const tx = new Transaction({ feePayer: new PublicKey(payer), recentBlockhash: BLOCKHASH }).add(new TransactionInstruction({ programId: new PublicKey(TAB_PROGRAM), keys: [{ pubkey: KEY_SIGNER.publicKey, isSigner: true, isWritable: false }, { pubkey: new PublicKey(payer), isSigner: true, isWritable: true }], data: Buffer.from([tag]) }));
  tx.partialSign(KEY_SIGNER);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
};
/** The associated USDC token account of a wallet in the fake router: any stable address will do, so the wallet's own stands in. */
const tokenOf = (wallet: string) => wallet;

/** An unsigned legacy transaction with `payer` as fee payer (what deposit-tx returns), base64. */
const unsignedFor = (payer: string) => new Transaction({ feePayer: new PublicKey(payer), recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(payer), toPubkey: new PublicKey(PAY_TO), lamports: 1 })).serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

export function receiptFor(id: string, extra: Record<string, unknown> = {}) {
  const payload = { id, model: "example/model", provider: "example-provider", ts: Date.parse("2026-09-30T12:00:00Z"), tokens_in: 5, tokens_out: 3, ...extra };
  const bytes = canonicalBytes(payload);
  const sig = new Uint8Array(sign(null, bytes, priv));
  return { id, sig: Buffer.from(sig).toString("base64"), key_id: V2.key_id, alg: "Ed25519", payload, leaf: receiptLeaf(bytes, sig), v2: { alg: "EdDSA", kid: V2.key_id, cose: V2.cose, claims: V2.claims, leaf: V2.leaf } };
}

export type Seen = { method: string; path: string; headers: Headers; body: any };

export function startFakeRouter() {
  const seen: Seen[] = [];
  const state = { batchPolls: 0, rateLimitLeft: 0, presets: new Map<string, any[]>(), tamperStream: false, payments: [] as { payer: string; amount: bigint }[], closures: [] as any[], /** Who deposited to the key and where each is refunded: the only places a closure pays. */ deposits: [] as { payer: string; refundTo: string; units: string }[], /** A refund payment was sent: the closure can no longer be cancelled. */ refundStarted: false, votes: new Set<string>(), /** The key's closure is registered on chain: anything that would spend is refused. */ frozen: false };
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
  const genHeaders = (id: string, lane: string) => ({ "x-generation-id": id, "x-receipt-id": id, "x-trellis-lane": lane, "x-trellis-disclosure": lane === "attested" ? "attested" : "policy" });
  const presetJson = (name: string) => {
    const versions = state.presets.get(name)!;
    const last = versions.at(-1);
    return { name, model: `@preset/${name}`, description: last.config.description ?? "", version: versions.length, hash: `h${versions.length}`, config: last.config, created_at: "2026-09-30T00:00:00.000Z", updated_at: "2026-09-30T00:00:00.000Z" };
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      seen.push({ method: req.method, path: p + url.search, headers: req.headers, body });
      const lane = (body?.provider?.lane as string) ?? req.headers.get("x-trellis-lane") ?? "public";

      if (p === "/.well-known/trellis-receipt-keys.json") return json(JWKS);

      // A key whose credits are being closed is frozen (src/ledger/ledger.ts): 409 credits_closing, as the router sends it.
      if (state.frozen && req.headers.get("authorization") && ["/api/v1/chat/completions", "/api/v1/embeddings", "/api/v1/rerank"].includes(p)) return json(CONTRACTS.errors.credits_closing.body, CONTRACTS.errors.credits_closing.status);

      if (p === "/api/v1/chat/completions") {
        // No key: pay per call (x402 exact). The 402 carries the v1 body and the v2 PAYMENT-REQUIRED header.
        if (!req.headers.get("authorization")) {
          const pay = req.headers.get("x-payment");
          const req402 = (error: string, extra: Record<string, unknown> = {}) => json({ x402Version: 1, error, accepts: [requirement()], price_usdc: "0.0123", model: body.model, ...extra }, 402, { "payment-required": b64json({ x402Version: 2, error, resource: { url: "/api/v1/chat/completions", description: "Pay-per-call inference", mimeType: "application/json" }, accepts: [{ ...requirement(), amount: PRICE_UNITS }] }) });
          if (!pay) return req402("Payment of 0.0123 USDC required: send the signed x402 payment as X-PAYMENT.");
          const checked = checkPayment(pay);
          if (!checked.ok) return req402(`Payment rejected (${checked.reason}): send a fresh signed x402 payment.`, { payment_error: checked.reason });
          state.payments.push({ payer: checked.payer, amount: checked.amount });
          const id = V2.claims.rid as string;
          return json({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Paid" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 }, receipt: receiptFor(id) }, 200, { ...genHeaders(id, lane), "x-payment-response": b64json({ success: true, transaction: `sig${state.payments.length}`, network: NETWORK, payer: checked.payer }), "payment-response": b64json({ success: true, transaction: `sig${state.payments.length}`, network: NETWORK, payer: checked.payer }) });
        }
        if (state.rateLimitLeft > 0) {
          state.rateLimitLeft--;
          return json({ error: { code: 429, message: "Rate limit exceeded.", type: "rate_limited" } }, 429, { "retry-after": "7" });
        }
        if (body.model === "early/model") return json({ error: { code: 403, message: "early/model is in early access. It opens to you from 2026-10-14T12:00:00.000Z.", type: "early_access", metadata: { model: "early/model", opens_at: "2026-10-14T12:00:00.000Z", early_access_until: "2026-10-14T12:00:00.000Z", tier: null } } }, 403, { "retry-after": "3600" });
        if (body.model === "missing/model") return json({ error: { code: 404, message: "Model missing/model is not available.", type: "model_not_found" } }, 404);
        const id = V2.claims.rid as string;
        if (!body.stream) {
          return json({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 }, receipt: receiptFor(id) }, 200, genHeaders(id, lane));
        }
        const chunks = state.tamperStream ? [V2.chunks[0], V2.chunks[1].replace("lo", "LO"), V2.chunks[2]] : V2.chunks;
        let sse = "";
        chunks.forEach((d, i) => (sse += `data: ${d}\n\n: trellis-chain ${i + 1} ${V2.chain_steps[i]}\n\n`));
        sse += `data: ${JSON.stringify({ receipt: receiptFor(id) })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream", ...genHeaders(id, lane) } });
      }

      if (p === "/api/v1/embeddings") return json({ object: "list", model: body.model, data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 }, receipt: receiptFor("gen-emb-1") }, 200, genHeaders("gen-emb-1", lane));
      if (p === "/api/v1/rerank") {
        const results = body.documents.map((d: any, index: number) => ({ index, relevance_score: typeof d === "string" && d.includes(body.query) ? 0.9 : 0.1 })).sort((a: any, b: any) => b.relevance_score - a.relevance_score).slice(0, body.top_n ?? undefined);
        return json({ id: "gen-rr-1", model: body.model, results, usage: { total_tokens: 12, search_units: 1, cost: 0.00001 }, cost: 0.00001, receipt: receiptFor("gen-rr-1") }, 200, genHeaders("gen-rr-1", lane));
      }

      // ---- batches ----
      const batch = (status: string) => ({ id: "batch_abc123", object: "batch", endpoint: "/v1/chat/completions", status, output_url: "/api/v1/batches/batch_abc123/output", errors_url: "/api/v1/batches/batch_abc123/errors", created_at: 1, in_progress_at: 2, expires_at: 3, completed_at: status === "completed" ? 4 : null, failed_at: null, expired_at: null, cancelled_at: status === "cancelled" ? 4 : null, request_counts: { total: 2, completed: status === "completed" ? 1 : 0, failed: status === "completed" ? 1 : 0 }, cost: { usd: 0.001, list_usd: 0.002, discount_bps: 5000 }, results_expire_at: 5 });
      if (p === "/api/v1/batches" && req.method === "POST") return json(batch("validating"));
      if (p === "/api/v1/batches" && req.method === "GET") return json({ object: "list", data: [batch("in_progress")], first_id: "batch_abc123", last_id: "batch_abc123", has_more: false });
      if (p === "/api/v1/batches/batch_abc123") return json(batch(++state.batchPolls >= 3 ? "completed" : "in_progress"));
      if (p === "/api/v1/batches/batch_abc123/cancel") return json(batch("cancelling"));
      if (p === "/api/v1/batches/batch_abc123/output")
        return new Response(JSON.stringify({ id: "batch_req_abc123_0", custom_id: "q1", response: { status_code: 200, request_id: "gen-b-1", body: { choices: [{ message: { content: "4" } }], receipt: receiptFor("gen-b-1") } }, error: null }) + "\n", { headers: { "content-type": "application/jsonl" } });
      if (p === "/api/v1/batches/batch_abc123/errors") return new Response(JSON.stringify({ id: "batch_req_abc123_1", custom_id: "q2", response: null, error: { code: "model_not_found", message: "no" } }) + "\n", { headers: { "content-type": "application/jsonl" } });

      // ---- presets ----
      const m = /^\/api\/v1\/presets(?:\/([a-z0-9-]+))?(?:\/(versions|diff|rollback))?$/.exec(p);
      if (m) {
        const [, name, sub] = m;
        if (!name) return json({ data: [...state.presets.keys()].map(presetJson), limit: 100 });
        if (!state.presets.has(name) && req.method !== "PUT") return json({ error: { code: 404, message: `No preset @preset/${name} in this account.`, type: "preset_not_found" } }, 404);
        if (req.method === "PUT") {
          const versions = state.presets.get(name) ?? [];
          const changed = JSON.stringify(versions.at(-1)?.config) !== JSON.stringify(body);
          if (changed) versions.push({ config: body });
          state.presets.set(name, versions);
          return json({ data: { ...presetJson(name), changed } }, versions.length === 1 && changed ? 201 : 200);
        }
        if (req.method === "DELETE") {
          const n = state.presets.get(name)!.length;
          state.presets.delete(name);
          return json({ data: { name, model: `@preset/${name}`, deleted: true, versions: n } });
        }
        if (sub === "versions") return json({ data: state.presets.get(name)!.map((_, i) => ({ version: i + 1, hash: `h${i + 1}`, model: `@preset/${name}@${i + 1}`, source: "put", created_at: "2026-09-30T00:00:00.000Z" })).reverse(), latest: state.presets.get(name)!.length });
        if (sub === "diff") return json({ data: { name, from: { version: Number(url.searchParams.get("from")) }, to: { version: Number(url.searchParams.get("to")) }, identical: false, changes: [{ path: "models", op: "replace" }] } });
        if (sub === "rollback") {
          const versions = state.presets.get(name)!;
          versions.push({ config: versions[Number(body.version) - 1].config });
          return json({ data: { ...presetJson(name), changed: true, restored_from: Number(body.version) } });
        }
        return json({ data: { ...presetJson(name), latest_version: state.presets.get(name)!.length } });
      }

      // ---- credits (deposit-tx, close, cancel, release, refund destination) and the facilitator's capabilities ----
      if (p === "/api/v1/credits/deposit-tx") {
        if (!req.headers.get("authorization")) return json({ error: { code: 401, message: "Missing API key.", type: "unauthorized" } }, 401);
        if (!/^\d+(\.\d{1,6})?$/.test(body?.amount ?? "") || typeof body?.payer !== "string") return json({ error: { code: 400, message: "amount must be a USDC amount with up to 6 decimals", type: "invalid_request" } }, 400);
        if (Number(body.amount) > 1000) return json({ error: { code: 400, message: "deposit would exceed the per-key cap", type: "deposit_refused" } }, 400);
        const units = BigInt(Math.round(Number(body.amount) * 1e6)).toString();
        if (!state.deposits.some((d) => d.payer === body.payer)) state.deposits.push({ payer: body.payer, refundTo: tokenOf(body.payer), units });
        return json({ data: { transaction: unsignedFor(body.payer), message: `Deposit ${body.amount} USDC to Trellis credits`, network: NETWORK, amount_usdc: body.amount, amount_units: units, accounts: { vault: PAY_TO, credit: PAY_TO, depositorToken: tokenOf(body.payer), share: PAY_TO }, refund_to: tokenOf(body.payer), expires_at_block_height: 1234, key_hash: "0x" + "ab".repeat(32), note: "If this key's credits are ever closed, what is left of this deposit is refunded to the token account it is paid from (refund_to)." } });
      }
      if (p.startsWith("/api/v1/credits/close") || p === "/api/v1/credits/refund-destination-tx") {
        if (!req.headers.get("authorization")) return json({ error: { code: 401, message: "Missing API key.", type: "unauthorized" } }, 401);
      }
      // The key does not choose where the refund goes: a closure request that names a destination is refused, as the router does.
      if (p === "/api/v1/credits/close" && req.method === "POST" && body?.refund_to !== undefined) return json(CONTRACTS.closure.refused_with_refund_to.body, CONTRACTS.closure.refused_with_refund_to.status);
      if ((p === "/api/v1/credits/close" || p === "/api/v1/credits/close/cancel") && req.method === "POST") {
        if (typeof body?.payer !== "string") return json({ error: { code: 400, message: "payer must be a base58 Solana address", type: "invalid_request" } }, 400);
      }
      if (p === "/api/v1/credits/close" && req.method === "POST") {
        // The fixture's own request gets the router's own answer: a close_account transaction signed by the key.
        if (body.payer === CONTRACTS.closure.request.payer) return json({ data: CONTRACTS.closure.response }, 201);
        const refunds = state.deposits.map((d) => ({ depositor: d.payer, refund_to: d.refundTo, deposited_units: d.units, refunded_units: "0" }));
        const existing = state.closures.find((c) => c.status === "queued" || c.status === "registered");
        if (existing) return json({ data: { id: existing.id, status: existing.status, payer: existing.authority, authority: existing.authority, payable_at: existing.payable_at, transaction: null, refunds } });
        const row = { id: `close_${state.closures.length + 1}`, status: "queued", reason: null as string | null, refund_to: null, refunds: [], amount_units: null, requested_at: "2026-10-10T12:00:00.000Z", payable_at: "2026-10-13T12:00:00.000Z", paid_at: null, register_tx: null, pay_tx: null, cancel_tx: null as string | null, released_at: null as string | null, authority: body.payer };
        state.closures.unshift(row);
        return json({ data: { id: row.id, status: row.status, payer: body.payer, authority: body.payer, payable_at: row.payable_at, transaction: keySignedFor(body.payer, 1), message: "Close credits", accounts: { refundRequest: PAY_TO }, expires_at_block_height: 1234, signed_by_key: true, refunds, note: "The transaction already carries the key's signature. Sign it with the payer wallet and send it." } }, 201);
      }
      if (p === "/api/v1/credits/close/cancel" && req.method === "POST") {
        if (body.payer === CONTRACTS.closure.cancel.request.payer) return json({ data: CONTRACTS.closure.cancel.response });
        const open = state.closures.find((c) => c.status === "queued" || c.status === "registered");
        if (!open) return json(CONTRACTS.closure.cancel.errors.nothing_to_cancel.body, CONTRACTS.closure.cancel.errors.nothing_to_cancel.status);
        if (state.refundStarted) return json(CONTRACTS.closure.cancel.errors.refund_in_progress.body, CONTRACTS.closure.cancel.errors.refund_in_progress.status);
        Object.assign(open, { status: "cancelled", reason: "cancelled_on_chain", cancel_tx: "5".repeat(88) }); // the fake has no chain: asking is landing
        return json({ data: { transaction: keySignedFor(body.payer, 2), message: "Take back the closure", accounts: { refundRequest: PAY_TO }, payer: body.payer, expires_at_block_height: 1234, signed_by_key: true, note: "Sign with the payer wallet and send before the blockhash expires." } });
      }
      if (p === "/api/v1/credits/close/release" && req.method === "POST") {
        if (!/^[0-9a-f]{64}$/.test(body?.key ?? "")) return json({ error: { code: 400, message: "key must be the key's hash (as listed by GET /api/v1/keys)", type: "invalid_request" } }, 400);
        const open = state.closures.filter((c) => c.status === "queued" || c.status === "registered");
        if (body.key === CONTRACTS.closure.release.request.key && !open.length) return json({ data: CONTRACTS.closure.release.response });
        if (!open.length) return json(CONTRACTS.closure.release.errors.not_found.body, CONTRACTS.closure.release.errors.not_found.status);
        for (const c of open) Object.assign(c, { released_at: "2026-10-11T12:00:00.000Z", reason: null });
        return json({ data: open.map((c) => ({ id: c.id, status: c.status, released: true, payable_at: c.payable_at })) });
      }
      if (p === "/api/v1/credits/refund-destination-tx" && req.method === "POST") {
        if (typeof body?.depositor !== "string" || typeof body?.refund_to !== "string") return json({ error: { code: 400, message: "depositor must be a base58 Solana address", type: "invalid_request" } }, 400);
        if (body.depositor === CONTRACTS.closure.refund_destination.request.depositor && body.refund_to === CONTRACTS.closure.refund_destination.request.refund_to) return json({ data: CONTRACTS.closure.refund_destination.response });
        const share = state.deposits.find((d) => d.payer === body.depositor);
        if (!share) return json(CONTRACTS.closure.refund_destination.errors.not_found.body, CONTRACTS.closure.refund_destination.errors.not_found.status);
        const current = share.refundTo;
        share.refundTo = tokenOf(body.refund_to);
        return json({ data: { transaction: unsignedFor(body.depositor), message: "Send my refunds elsewhere", accounts: { share: PAY_TO, refundToToken: tokenOf(body.refund_to) }, depositor: body.depositor, refund_to: body.refund_to, current_refund_to: current, expires_at_block_height: 1234, note: "Only the depositor's own wallet can sign this." } });
      }
      if (p === "/api/v1/credits/close") return json({ data: state.closures.map(({ authority: _a, ...row }) => row) });
      if (p === "/facilitator/supported") return json({ kinds: [{ x402Version: 1, scheme: "exact", network: NETWORK, extra: { feePayer: FEE_PAYER.publicKey.toBase58() } }, { x402Version: 1, scheme: "tab", network: NETWORK, extra: { program: TAB_PROGRAM, maxCapUnits: "100000000" } }], fee_bps: 0, networks: [NETWORK] });

      // ---- holder tiers: the tier table, the key's tier, advisory polls and a wallet-signed vote ----
      if (p === "/api/v1/holders/tiers") return json({ data: { enabled: true, token: { address: PAY_TO, symbol: "TRLS", program: "token-2022" }, cache_s: 3600, tiers: [HOLDER_TIER] } });
      if (p === "/api/v1/holders/me") {
        if (!req.headers.get("authorization")) return json({ error: { code: 401, message: "Missing API key.", type: "unauthorized" } }, 401);
        return json({ data: { enabled: true, token: { address: PAY_TO, symbol: "TRLS" }, wallet: PAY_TO, balance: "25000", balance_error: false, tier: HOLDER_TIER, next_tier: { name: "Vine", min: "100000", remaining: "75000" }, perks: { limits: { rpm: 120, tpm: null, agent_keys: 25, saved_routes: 200, presets: 200, batch_rows: 1000 }, sealed_priority: 1, early_access_hours: 12, vote_weight: 1, credits_never_expire: false, badge: true } } });
      }
      const pollJson = (status: "open" | "closed") => ({ id: status === "open" ? "poll_open1" : "poll_done1", kind: "model_listing", title: "Which model next?", options: ["example/one", "example/two"], status, created_at: "2026-10-10T00:00:00.000Z", closes_at: null, closed_at: status === "closed" ? "2026-10-11T00:00:00.000Z" : null, advisory: true, results: { options: [{ option: "example/one", votes: state.votes.size, weight: state.votes.size }, { option: "example/two", votes: 0, weight: 0 }], total_votes: state.votes.size, total_weight: state.votes.size, final: status === "closed" } });
      if (p === "/api/v1/holders/polls") {
        const status = url.searchParams.get("status");
        return json({ data: (["open", "closed"] as const).filter((x) => !status || x === status).map(pollJson) });
      }
      const pm = /^\/api\/v1\/holders\/polls\/(poll_[A-Za-z0-9_-]+)(\/vote)?$/.exec(p);
      if (pm) {
        const which = pm[1] === "poll_open1" ? "open" : pm[1] === "poll_done1" ? "closed" : null;
        if (!which) return json({ error: { code: 404, message: "Poll not found.", type: "not_found" } }, 404);
        if (!pm[2]) return json({ data: pollJson(which) });
        // The checks src/api/holders.ts makes: X-Wallet-Auth (v2: method, this router's host, the path, the time and the
        // sha256 of the canonical JSON body), the poll in the body, one vote per wallet.
        const [wallet, ts, sig] = (req.headers.get("x-wallet-auth") ?? "").split(":");
        if (!wallet || !ts || !sig) return json({ error: { code: 401, message: "X-Wallet-Auth is required to vote.", type: "invalid_wallet_auth" } }, 401);
        if (body?.poll_id !== pm[1]) return json({ error: { code: 400, message: "`poll_id` must be the poll in the path.", type: "invalid_request" } }, 400);
        const sha = createHash("sha256").update(JSON.stringify({ option: body.option, poll_id: body.poll_id })).digest("hex");
        if (!edVerifyRaw(base58Decode(wallet), Buffer.from(walletAuthMessage({ method: req.method, host: url.host, path: p + url.search, timestamp: ts, sha256: sha })), base58Decode(sig))) return json({ error: { code: 401, message: "X-Wallet-Auth signature does not match the address.", type: "invalid_wallet_auth" } }, 401);
        if (which === "closed") return json({ error: { code: 409, message: "This poll is closed.", type: "poll_closed" } }, 409);
        if (state.votes.has(wallet)) return json({ error: { code: 409, message: "This wallet has already voted in this poll.", type: "already_voted" } }, 409);
        state.votes.add(wallet);
        return json({ data: { poll_id: pm[1], option: body.option, tier: "Seed", weight: 1, voted_at: "2026-10-12T12:00:00.000Z" } }, 201);
      }

      if (p === "/api/v1/models") {
        const all = [
          { id: "example/model", name: "Example", lanes: ["public", "attested"], attested_available: true, attestation: { best: "attested", manifest_ref: null, exec_profile_id: null, policy_hash: null }, architecture: { output_modalities: ["text"] } },
          { id: "example/open", name: "Open", lanes: ["public"], attested_available: false, attestation: null, architecture: { output_modalities: ["text"] }, early_access: { until: "2026-10-14T12:00:00.000Z", your_access_at: "2026-10-14T00:00:00.000Z" } },
          { id: "example/rerank", name: "Rerank", lanes: ["public"], attested_available: false, attestation: null, architecture: { output_modalities: ["rerank"] } },
        ];
        const mod = url.searchParams.get("output_modalities");
        return json({ data: mod ? all.filter((x) => x.architecture.output_modalities.includes(mod)) : all });
      }

      const r = /^\/api\/v1\/receipts\/([^/]+)(\/proof)?$/.exec(p);
      if (r) {
        if (r[2]) return json({ data: { rid: r[1], leaf: V2.leaf, leaf_version: 2, rooted: true, anchored: false, root: V2.leaf, proof: [], status: "local" } });
        return json({ data: { ...receiptFor(r[1]), version: 2 } });
      }
      return json({ error: { code: 404, message: "Not found.", type: "not_found" } }, 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, state, stop: () => server.stop(true) };
}
