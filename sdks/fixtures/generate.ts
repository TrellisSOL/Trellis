// Contract fixtures for the client SDKs, produced by the router's own code.
//
//   bun sdks/fixtures/generate.ts            write sdks/fixtures/contracts.json
//   bun sdks/fixtures/generate.ts --check    exit 1 when the committed file differs from what the router produces now
//
// Every message, signature, instruction and transaction in the file comes from the module that verifies it on the
// server (src/lib/wallet-sig.ts, src/api/chat.ts requestHash, src/solana/tab.ts, src/solana/programs/tab.ts,
// src/solana/credits.ts, src/solana/x402.ts). Nothing is written by hand. The SDK suites (sdks/typescript, sdks/python,
// sdks/go, packages/client, packages/client-py, web) read this one file and must reproduce it byte for byte from the
// same inputs, so a change of a server contract that a client did not follow fails that client's tests.
//
// No secret is stored. Each test key is the ed25519 key whose 32-byte seed is SHA-256("trellis-sdk-fixture:" + label);
// the file names the label and the public address, and a suite derives the seed itself. test/sdk-fixtures.test.ts runs
// the --check in the router's own suite.
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { requestHash } from "../../src/api/chat.ts";
import { hostWalletHash } from "../../src/api/hosts.ts";
import { ApiError } from "../../src/lib/errors.ts";
import { canonicalJson, sha256 } from "../../src/lib/util.ts";
import { verifyWalletSignature, WALLET_AUTH_VERSION, WALLET_SIGN_IN_STATEMENT, WALLET_SIGN_IN_VERSION, walletAuthMessage, walletSignInMessage, type WalletAuthRequest, type WalletSignIn } from "../../src/lib/wallet-sig.ts";
import { base58Encode, USDC_MINT } from "../../src/solana/constants.ts";
import { buildCancelCloseTransaction, buildCloseAccountTransaction, buildDepositTransaction, buildSetRefundDestinationTransaction, creditsProgram } from "../../src/solana/credits.ts";
import { deriveKey } from "../../src/solana/keys.ts";
import { rulebookPda } from "../../src/solana/programs/rules.ts";
import { encodeTabAccount, MAX_TAB_LIFETIME_S, tabPdas, VOUCHER_DOMAIN, VOUCHER_MSG_LEN } from "../../src/solana/programs/tab.ts";
import { closeInstructions, openTabInstruction, postVoucherInstructions, reclaimInstruction, rulebookAccounts, signVoucher, topUpInstruction, verifyVoucher, voucherBytes, wireVoucher, type TabAccount, type TabProgram, type VoucherScope } from "../../src/solana/tab.ts";
import { encodeVoucherHeader, parseVoucherHeader } from "../../src/solana/tab-billing.ts";
import { DEFAULT_EXACT_LIMITS, inspectExactTransaction, priorityFeeLamports, type ExactLimits } from "../../src/solana/x402.ts";

export const FIXTURE_FILE = path.join(import.meta.dir, "contracts.json");
const SEED_PREFIX = "trellis-sdk-fixture:";

// ---- Test keys: derived from labels, never stored ------------------------------------------------------------------------
const seedOf = (label: string) => createHash("sha256").update(SEED_PREFIX + label).digest();
const keypairOf = (label: string) => Keypair.fromSeed(seedOf(label));
const rawSign = (kp: Keypair, message: Uint8Array) => new Uint8Array(edSign(null, message, createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" })));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ixJson = (ix: TransactionInstruction) => ({ program_id: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), is_signer: k.isSigner, is_writable: k.isWritable })), data_base64: b64(ix.data), data_hex: hex(ix.data) });

const wallet = keypairOf("wallet"); // signs in, signs X-Wallet-Auth, pays per call, opens tabs, deposits credits, pays the closure's fee
const session = keypairOf("session"); // the tab's session key
const feePayer = keypairOf("fee-payer"); // the router's x402 fee payer
const payee = keypairOf("payee"); // the router's tab payee and x402 payTo
const refundTo = keypairOf("refund-to"); // the wallet a depositor moves its own refund destination to (and a host payout address)
const secondDepositor = keypairOf("second-depositor"); // another wallet that deposited to the key: a closure pays it back too
// Program ids for the fixtures: the ones declared for localnet and devnet (Anchor.toml). A mainnet deployment has its own.
const TAB_PROGRAM_ID = new PublicKey("9ZmEvfrQrZuVXGc4PovskV83KNxVvpFpvSu3K6R9a9tL");
const RULES_PROGRAM_ID = new PublicKey("GAsF9tHESV7vWxK7nNQy8S7nGtGxGVd4SHNBvSVCjYj5");
const CREDITS_PROGRAM_ID = new PublicKey("dtwL4NqHvvF2QAB84y9VjfNdkEUGw6NWbNWRtgjifAi");
const MINT = new PublicKey(USDC_MINT);
const BLOCKHASH = "GfVcyD5RTBBWkMqHpVdPQ5NRTXxXW4KaLx3fx1p8HfJ3";
const NOW = 1_790_000_000; // 2026-09-21T13:46:40Z: every timestamp in the file is this or derived from it
const HOST = "router.example";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

// ---- 1. Wallet sign-in (trellis:wallet:v2, security review TR-17) -----------------------------------------------------
function signIn() {
  const fields = (domain: string): WalletSignIn => ({ domain, address: wallet.publicKey.toBase58(), statement: WALLET_SIGN_IN_STATEMENT, uri: `https://${domain}`, version: "1", chainId: NETWORK, nonce: sha256("sdk-fixture-nonce").slice(0, 48), issuedAt: new Date(NOW * 1000).toISOString(), expirationTime: new Date((NOW + 300) * 1000).toISOString() });
  const f = fields(HOST);
  const message = walletSignInMessage(f);
  const signature = base58Encode(rawSign(wallet, Buffer.from(message, "utf8")));
  if (!verifyWalletSignature(f.address, message, signature)) throw new Error("sign-in signature does not verify");
  const elsewhere = walletSignInMessage(fields("phish.example"));
  return {
    version: WALLET_SIGN_IN_VERSION,
    about: "POST /api/v1/auth/wallet/challenge {address} returns `challenge`. The wallet signs the UTF-8 bytes of challenge.message exactly as returned (base58 signature) and posts `request` to /api/v1/auth/wallet. A client checks that challenge.domain is the host it is talking to before it signs.",
    expected_host: HOST,
    /** The `data` of the challenge response, as src/api/keys.ts returns it. */
    challenge: { nonce: f.nonce, message, domain: f.domain, uri: f.uri, chain_id: f.chainId, issued_at: f.issuedAt, expires_at: f.expirationTime, version: WALLET_SIGN_IN_VERSION },
    /** The body of POST /api/v1/auth/wallet. */
    request: { address: f.address, nonce: f.nonce, signature, message, name: "SDK fixture key" },
    signature,
    /** The same challenge issued by another site: a client talking to `expected_host` must refuse to sign it. */
    other_domain_challenge: { nonce: f.nonce, message: elsewhere, domain: "phish.example", uri: "https://phish.example", chain_id: f.chainId, issued_at: f.issuedAt, expires_at: f.expirationTime, version: WALLET_SIGN_IN_VERSION },
    /** The retired v1 text. The router verifies only challenge.message; a signature over this signs nothing in. */
    retired_v1_message: `trellis:wallet:v1\n${f.nonce}\n${NOW}`,
  };
}

// ---- 2. X-Wallet-Auth (trellis:wallet-auth:v2, security review TR-20) ---------------------------------------------------
function walletAuthCases() {
  const one = (name: string, about: string, r: Omit<WalletAuthRequest, "bodySha"> & { bodySha: string }, extra: Record<string, unknown> = {}) => {
    const message = walletAuthMessage(r);
    const signature = base58Encode(rawSign(wallet, Buffer.from(message, "utf8")));
    if (!verifyWalletSignature(wallet.publicKey.toBase58(), message, signature)) throw new Error("wallet-auth signature does not verify");
    return { name, about, method: r.method, host: r.host, path: r.path, url: `https://${r.host}${r.path}`, timestamp: Number(r.timestamp), sha256: r.bodySha, ...extra, message, signature, header: `${wallet.publicKey.toBase58()}:${r.timestamp}:${signature}` };
  };
  const chat = { model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "Reply with one word: héllo ✓" }], temperature: 0.7, top_p: 1, max_tokens: 64, stream: true, stream_options: { include_usage: true }, usage: { include: true } };
  const vote = { poll_id: "poll_fixture", option: "yes" };
  const signup = { name: "Fixture host", endpoint: "https://sidecar.example", payout_address: refundTo.publicKey.toBase58(), models: ["org/model"] };
  const hostId = "fixture host/1";
  return {
    version: WALLET_AUTH_VERSION,
    about: "X-Wallet-Auth: <base58 address>:<unixSeconds>:<base58 ed25519 signature> over the UTF-8 bytes of `message`: the version line, METHOD, host, path (with the query string), unixSeconds and a SHA-256 hex, joined by \\n. `sha256` is what the route binds: for chat routes the SHA-256 of the canonical JSON (keys sorted, no spaces) of the body without `stream` and `stream_options`; for other JSON routes the SHA-256 of the canonical JSON of the body; for GET routes the SHA-256 of the empty string; for GET /api/v1/hosts/{id} the SHA-256 of \"GET /api/v1/hosts/<url-encoded id>\".",
    address: wallet.publicKey.toBase58(),
    empty_sha256: sha256(""),
    cases: [
      one("get_empty_body", "A GET with no body: sha256 of the empty string.", { method: "GET", host: HOST, path: "/api/v1/refunds", timestamp: NOW, bodySha: sha256("") }, { body: null }),
      one("get_with_query", "The query string is part of the signed path.", { method: "GET", host: HOST, path: "/api/v1/generation?id=gen_fixture_1", timestamp: NOW, bodySha: sha256("") }, { body: null }),
      one("chat_request", "Chat: sha256 of the canonical JSON of the body without stream and stream_options (the router's requestHash).", { method: "POST", host: HOST, path: "/api/v1/chat/completions", timestamp: NOW, bodySha: requestHash(chat) }, { body: chat, canonical_json: canonicalJson((({ stream: _s, stream_options: _o, ...rest }) => rest)(chat)) }),
      one("json_body", "A JSON route: sha256 of the canonical JSON of the body.", { method: "POST", host: HOST, path: `/api/v1/holders/polls/${vote.poll_id}/vote`, timestamp: NOW, bodySha: sha256(canonicalJson(vote)) }, { body: vote, canonical_json: canonicalJson(vote) }),
      one("host_signup", "Host signup, signed by the operator wallet.", { method: "POST", host: HOST, path: "/api/v1/network/hosts", timestamp: NOW, bodySha: sha256(canonicalJson(signup)) }, { body: signup, canonical_json: canonicalJson(signup) }),
      one("host_resource", "The operator reading its own host: the hash names the resource.", { method: "GET", host: HOST, path: `/api/v1/hosts/${encodeURIComponent(hostId)}`, timestamp: NOW, bodySha: hostWalletHash(hostId) }, { body: null, host_id: hostId, resource: `GET /api/v1/hosts/${encodeURIComponent(hostId)}` }),
      one("host_with_port", "A router on a port: the host carries it. Upper-case input is signed in lower case.", { method: "GET", host: "127.0.0.1:8787", path: "/api/v1/refunds", timestamp: NOW + 1, bodySha: sha256("") }, { body: null }),
    ],
    /** The retired v1 message for the first case: "trellis:<unixSeconds>:<sha256>". The router refuses a signature over it. */
    retired_v1_message: `trellis:${NOW}:${sha256("")}`,
  };
}

// ---- 3. Tabs: instructions and vouchers (trellis:tab:voucher:v1, security review TR-19) -------------------------------------
function tabs() {
  const program: TabProgram = { programId: TAB_PROGRAM_ID, mint: MINT };
  const tabId = 7_000_000_000_000_000_001n;
  const cap = 5_000_000n;
  const createdAt = BigInt(NOW);
  const expiry = BigInt(NOW + 86_400);
  const rulebook = rulebookPda(RULES_PROGRAM_ID, wallet.publicKey, 3n);
  const rules = rulebookAccounts(RULES_PROGRAM_ID, rulebook);
  const open = openTabInstruction(program, { payer: wallet.publicKey, payee: payee.publicKey, tabId, cap, expiry, sessionKey: session.publicKey, capUnits: 500_000_000n });
  const openBound = openTabInstruction(program, { payer: wallet.publicKey, payee: payee.publicKey, tabId, cap, expiry, sessionKey: session.publicKey, capUnits: 500_000_000n, rulebook, rulesProgram: RULES_PROGRAM_ID });
  const tab = open.tab;
  const pdas = tabPdas(TAB_PROGRAM_ID, wallet.publicKey, payee.publicKey, tabId);
  const tabIdLe = Buffer.alloc(8); tabIdLe.writeBigUInt64LE(tabId);
  const bumps = { tab: PublicKey.findProgramAddressSync([Buffer.from("tab"), wallet.publicKey.toBuffer(), payee.publicKey.toBuffer(), tabIdLe], TAB_PROGRAM_ID)[1], escrow: PublicKey.findProgramAddressSync([Buffer.from("escrow"), tab.toBuffer()], TAB_PROGRAM_ID)[1] };
  const account: TabAccount = { payer: wallet.publicKey, payee: payee.publicKey, sessionKey: session.publicKey, mint: MINT, tabId, cap, postedUsed: 0n, postedSeq: 0n, expiry, createdAt, rulebook: null };
  const scope: VoucherScope = { programId: TAB_PROGRAM_ID, createdAt };
  const voucher = (cumulativeUsed: bigint, seq: bigint, sc: VoucherScope = scope) => {
    const v = { tab, cumulativeUsed, seq };
    const message = voucherBytes(v, sc);
    const signature = signVoucher(session, v, sc);
    if (message.length !== VOUCHER_MSG_LEN || !verifyVoucher(v, signature, session.publicKey, sc)) throw new Error("voucher does not verify");
    const header = encodeVoucherHeader(message, signature);
    if (!parseVoucherHeader(header, tab)) throw new Error("voucher header does not parse");
    return { cumulative_used: cumulativeUsed.toString(), seq: seq.toString(), program_id: sc.programId.toBase58(), created_at: sc.createdAt.toString(), message_hex: hex(message), message_base64: b64(message), signature_base58: base58Encode(signature), signature_base64: b64(signature), headers: { "X-Trellis-Tab": tab.toBase58(), "X-Trellis-Tab-Voucher": header }, wire: wireVoucher(v, signature) };
  };
  const first = voucher(20_000n, 1n);
  const closeVoucher = { tab, cumulativeUsed: 1_250_000n, seq: 2n };
  const closeSig = signVoucher(session, closeVoucher, scope);
  const legacy = Buffer.concat([tab.toBuffer(), Buffer.from(voucherBytes({ tab, cumulativeUsed: 20_000n, seq: 1n }, scope).subarray(VOUCHER_MSG_LEN - 16))]);
  return {
    about: "trellis_tab. open_tab and top_up take the rulebook accounts when the tab is bound to a rulebook and leave them out otherwise; close, post_voucher and reclaim never take them. A voucher is the session key's ed25519 signature over `domain || program id (32) || tab (32) || created_at i64 LE || cumulative_used u64 LE || seq u64 LE`: created_at is the open tab's Tab.created_at, read from the chain after open_tab lands.",
    program_id: TAB_PROGRAM_ID.toBase58(),
    rules_program_id: RULES_PROGRAM_ID.toBase58(),
    mint: MINT.toBase58(),
    payer: wallet.publicKey.toBase58(),
    payee: payee.publicKey.toBase58(),
    session: session.publicKey.toBase58(),
    tab_id: tabId.toString(),
    cap: cap.toString(),
    expiry: expiry.toString(),
    max_lifetime_seconds: MAX_TAB_LIFETIME_S,
    tab: tab.toBase58(),
    pdas: { config: pdas.config.toBase58(), tab: pdas.tab.toBase58(), escrow: pdas.escrow.toBase58() },
    rulebook: { rulebook: rules.rulebook.toBase58(), rules_config: rules.rulesConfig.toBase58(), rules_program: rules.rulesProgram.toBase58() },
    instructions: {
      open_tab: ixJson(open.ix),
      open_tab_with_rulebook: ixJson(openBound.ix),
      top_up: { amount: "750000", ...ixJson(topUpInstruction(program, { payer: wallet.publicKey, tab, amount: 750_000n })) },
      top_up_with_rulebook: { amount: "750000", ...ixJson(topUpInstruction(program, { payer: wallet.publicKey, tab, amount: 750_000n, rules })) },
      reclaim: ixJson(reclaimInstruction(program, { payer: wallet.publicKey, payee: payee.publicKey }, tab)),
      /** What the payee sends: the Ed25519 instruction over the voucher bytes, then close / post_voucher. */
      close: { cumulative_used: closeVoucher.cumulativeUsed.toString(), seq: closeVoucher.seq.toString(), instructions: closeInstructions(program, account, closeVoucher, closeSig).map(ixJson) },
      post_voucher: { cumulative_used: closeVoucher.cumulativeUsed.toString(), seq: closeVoucher.seq.toString(), instructions: postVoucherInstructions(program, account, closeVoucher, closeSig).map(ixJson) },
    },
    /** The Tab account as the program stores it right after open_tab (getAccountInfo data, base64): decode created_at from it. */
    tab_account: { data_base64: b64(encodeTabAccount({ ...account, bump: bumps.tab, escrowBump: bumps.escrow })), created_at: createdAt.toString(), cap: cap.toString(), expiry: expiry.toString(), posted_used: "0", posted_seq: "0", rulebook: null },
    voucher: {
      domain: VOUCHER_DOMAIN,
      length: VOUCHER_MSG_LEN,
      layout: [{ field: "domain", offset: 0, length: 22 }, { field: "program_id", offset: 22, length: 32 }, { field: "tab", offset: 54, length: 32 }, { field: "created_at", offset: 86, length: 8, encoding: "i64 LE" }, { field: "cumulative_used", offset: 94, length: 8, encoding: "u64 LE" }, { field: "seq", offset: 102, length: 8, encoding: "u64 LE" }],
      cases: [first, voucher(1_250_000n, 2n), voucher(cap, 18_446_744_073_709_551_614n)],
      /** Same tab address and session key, signed for something else: each must NOT verify for the tab above. */
      not_for_this_tab: {
        reopened_later: voucher(20_000n, 1n, { programId: TAB_PROGRAM_ID, createdAt: createdAt + 3_600n }),
        another_program: voucher(20_000n, 1n, { programId: RULES_PROGRAM_ID, createdAt }),
        retired_48_byte_form: { message_hex: hex(legacy), message_base64: b64(legacy), signature_base58: base58Encode(rawSign(session, legacy)), signature_base64: b64(rawSign(session, legacy)) },
      },
    },
  };
}

// ---- 4. x402 `exact`: what the router's fee payer signs (security review TR-06) ---------------------------------------------
function x402(limits: ExactLimits = DEFAULT_EXACT_LIMITS) {
  const amount = 12_345n;
  const source = getAssociatedTokenAddressSync(MINT, wallet.publicKey, true);
  const destination = getAssociatedTokenAddressSync(MINT, payee.publicKey, true);
  const transfer = () => createTransferCheckedInstruction(source, MINT, destination, wallet.publicKey, amount, 6);
  const createAta = (funder: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(funder, destination, payee.publicKey, MINT);
  // Account order as every SDK compiles it: the fee payer, then accounts in order of first appearance within the usual
  // signer / writable groups (a legacy message compiled from a TransactionMessage).
  const build = (ixs: TransactionInstruction[], signer: Keypair = wallet) => {
    const message = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToLegacyMessage();
    const tx = new VersionedTransaction(message);
    tx.sign([signer]); // the fee payer's slot stays empty: the router co-signs
    return b64(tx.serialize());
  };
  const verdict = (transaction: string) => inspectExactTransaction(transaction, { feePayer: feePayer.publicKey, payTo: payee.publicKey, mint: MINT }, limits);
  const accepted = (name: string, about: string, ixs: TransactionInstruction[], options: Record<string, unknown>) => {
    const transaction = build(ixs);
    const v = verdict(transaction);
    if (!v.ok) throw new Error(`x402 fixture ${name} is refused by the router: ${v.reason}`);
    return { name, about, options, transaction, payment_header: b64(Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: NETWORK, payload: { transaction } }))), priority_fee_lamports: v.transfer.priorityFeeLamports.toString() };
  };
  const refused = (name: string, about: string, ixs: TransactionInstruction[]) => {
    const transaction = build(ixs);
    const v = verdict(transaction);
    if (v.ok) throw new Error(`x402 fixture ${name} should be refused by the router`);
    return { name, about, transaction, reason: v.reason };
  };
  const unitLimit = 60_000, unitPrice = 100_000n;
  return {
    about: "x402 `exact` on Solana. The payer builds a legacy transaction with the router's fee payer as account 0 (signature slot left empty) and signs it. The router's fee payer co-signs only what is inside `limits`: at most one SetComputeUnitLimit and one SetComputeUnitPrice within the caps (and their product within max_priority_fee_lamports), at most one idempotent creation of payTo's associated token account funded by the PAYER (never by the fee payer), exactly one TransferChecked, exactly two signatures, and the fee payer named by no instruction. `accepted` are transactions the router's verifier (src/solana/x402.ts inspectExactTransaction) accepts; `refused` are ones it refuses, with its reason.",
    network: NETWORK,
    recent_blockhash: BLOCKHASH,
    payer: wallet.publicKey.toBase58(),
    fee_payer: feePayer.publicKey.toBase58(),
    source,
    destination,
    requirement: { scheme: "exact", network: NETWORK, maxAmountRequired: amount.toString(), resource: `https://${HOST}/api/v1/chat/completions`, description: "fixture call", mimeType: "application/json", payTo: payee.publicKey.toBase58(), maxTimeoutSeconds: 60, asset: MINT.toBase58(), extra: { feePayer: feePayer.publicKey.toBase58(), decimals: 6 } },
    limits: { max_compute_unit_limit: limits.maxComputeUnitLimit, max_compute_unit_price_micro_lamports: limits.maxComputeUnitPriceMicroLamports.toString(), max_priority_fee_lamports: limits.maxPriorityFeeLamports.toString(), allow_ata_creation: limits.allowAtaCreation },
    accepted: [
      accepted("transfer_only", "The default: one TransferChecked, no compute-budget instruction (no priority fee).", [transfer()], {}),
      accepted("with_destination_ata", "payTo's token account does not exist yet: the PAYER funds its idempotent creation.", [createAta(wallet.publicKey), transfer()], { create_destination_ata: true }),
      accepted("with_compute_budget", "An explicit compute unit limit and price inside the caps.", [ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPrice }), transfer()], { compute_unit_limit: unitLimit, compute_unit_price_micro_lamports: unitPrice.toString() }),
      accepted("at_the_caps", "The largest limit, and the largest price whose fee stays within the priority-fee cap at that limit.", [ComputeBudgetProgram.setComputeUnitLimit({ units: limits.maxComputeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: (limits.maxPriorityFeeLamports * 1_000_000n) / BigInt(limits.maxComputeUnitLimit) }), transfer()], { compute_unit_limit: limits.maxComputeUnitLimit, compute_unit_price_micro_lamports: ((limits.maxPriorityFeeLamports * 1_000_000n) / BigInt(limits.maxComputeUnitLimit)).toString() }),
    ],
    refused: [
      refused("ata_funded_by_fee_payer", "The fee payer would pay the rent of payTo's token account.", [createAta(feePayer.publicKey), transfer()]),
      refused("compute_limit_above_cap", "SetComputeUnitLimit above the cap.", [ComputeBudgetProgram.setComputeUnitLimit({ units: limits.maxComputeUnitLimit + 1 }), transfer()]),
      refused("compute_price_above_cap", "SetComputeUnitPrice above the cap.", [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.maxComputeUnitPriceMicroLamports + 1n }), transfer()]),
      refused("priority_fee_above_cap", "Limit and price each within its cap, their product above the priority-fee cap.", [ComputeBudgetProgram.setComputeUnitLimit({ units: limits.maxComputeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.maxComputeUnitPriceMicroLamports }), transfer()]),
      refused("price_without_limit_above_cap", "A price with no explicit limit is charged on the runtime's default budget (200,000 units per instruction).", [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.maxComputeUnitPriceMicroLamports }), transfer()]),
      refused("two_transfers", "More than one transfer.", [transfer(), transfer()]),
    ],
    priority_fee_formula: "ceil(compute_unit_limit * micro_lamports_per_unit / 1_000_000) lamports; without SetComputeUnitLimit the limit is min(1_400_000, 200_000 * number of non-compute-budget instructions)",
    priority_fee_examples: [{ compute_unit_limit: unitLimit, compute_unit_price_micro_lamports: unitPrice.toString(), lamports: priorityFeeLamports(unitLimit, unitPrice).toString() }, { compute_unit_limit: 200_000, compute_unit_price_micro_lamports: "50001", lamports: priorityFeeLamports(200_000, 50_001n).toString() }],
  };
}

// ---- 5. Credits closure: signed by the key, refunded to the wallets that paid in (security review TR-05, re-review RR-05) ----
// The messages of the 400/404/409 answers and the `note` fields below are the texts src/api/keys.ts sends; the envelopes
// are ApiError's own. A closure names no destination anywhere: the key asks, the depositors are paid back.
function closure() {
  const secret = `sk-tr-v1-${sha256(SEED_PREFIX + "api-key")}`; // never written to the file
  const derived = deriveKey(secret);
  const program = creditsProgram({ chain: { credits: CREDITS_PROGRAM_ID.toBase58(), usdc: MINT.toBase58() } } as never)!;
  const lastValidBlockHeight = 314_159_265;
  const walletToken = getAssociatedTokenAddressSync(MINT, wallet.publicKey, true);
  const secondToken = getAssociatedTokenAddressSync(MINT, secondDepositor.publicKey, true);
  const movedToken = getAssociatedTokenAddressSync(MINT, refundTo.publicKey, true);
  const payable = new Date((NOW + 72 * 3600) * 1000).toISOString();
  const requested = new Date(NOW * 1000).toISOString();
  const envelope = (status: number, message: string, type: string, about: string, request?: Record<string, unknown>) => ({ about, ...(request ? { request } : {}), status, body: new ApiError(status, message, type).toJSON() });

  // A transaction the router signed as the key: the payer (fee payer, signature slot 0) adds its signature and sends it.
  // Nothing else may change, so the key's signature arrives as it was issued.
  const keySigned = (transaction: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const keyIndex = keys.indexOf(derived.keyAddress), payerIndex = keys.indexOf(wallet.publicKey.toBase58());
    if (payerIndex !== 0 || keyIndex < 1 || keyIndex >= tx.message.header.numRequiredSignatures) throw new Error("key-signed transaction has an unexpected signer layout");
    const keySignature = Buffer.from(tx.signatures[keyIndex]);
    if (!verifyWalletSignature(derived.keyAddress, tx.message.serialize(), base58Encode(keySignature))) throw new Error("the key's signature is not in place");
    if (!tx.signatures[0].every((b) => b === 0)) throw new Error("the payer slot should be empty");
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    signed.sign([wallet]);
    if (!Buffer.from(signed.signatures[keyIndex]).equals(keySignature)) throw new Error("signing as the payer changed the key's signature");
    return {
      payer: wallet.publicKey.toBase58(),
      /** The required signers in signature order: the payer (fee payer), then the API key's own address. */
      signers: keys.slice(0, tx.message.header.numRequiredSignatures),
      key_signature_index: keyIndex,
      key_signature_base58: base58Encode(keySignature),
      message_base64: b64(tx.message.serialize()),
      instruction_count: tx.message.compiledInstructions.length,
      /** The transaction after the payer signed it: what is sent to the cluster. */
      signed_transaction: b64(signed.serialize()),
      payer_signature_base58: base58Encode(signed.signatures[0]),
    };
  };

  // Who is paid back: one row per wallet that deposited to the key (trellis_credits DepositorShare). The first paid from
  // its own token account and left the destination alone; the second moved its destination with set_refund_destination.
  const refunds = [
    { depositor: wallet.publicKey.toBase58(), refund_to: walletToken.toBase58(), deposited_units: "25000000", refunded_units: "0" },
    { depositor: secondDepositor.publicKey.toBase58(), refund_to: movedToken.toBase58(), deposited_units: "5000000", refunded_units: "0" },
  ];

  const deposit = buildDepositTransaction(program, { depositor: wallet.publicKey, chainKeyHash: derived.chainKeyHash, amount: 25_000_000n, currentBalance: 0n, capUnits: 500_000_000n, recentBlockhash: BLOCKHASH, lastValidBlockHeight });
  if (deposit.refundTo !== walletToken.toBase58()) throw new Error("a deposit's default refund destination should be the token account it is paid from");

  const built = buildCloseAccountTransaction(program, { key: new PublicKey(derived.keyAddress), payer: wallet.publicKey, chainKeyHash: derived.chainKeyHash, recentBlockhash: BLOCKHASH, lastValidBlockHeight, signAsKey: derived.account.signBytes });
  const closeLayout = keySigned(built.transaction);
  if (closeLayout.instruction_count !== 1) throw new Error("a closure is one close_account instruction and nothing else");

  const cancelled = buildCancelCloseTransaction(program, { key: new PublicKey(derived.keyAddress), payer: wallet.publicKey, rentPayer: wallet.publicKey, chainKeyHash: derived.chainKeyHash, recentBlockhash: BLOCKHASH, lastValidBlockHeight, signAsKey: derived.account.signBytes });

  // set_refund_destination is the DEPOSITOR's: unsigned, fee payer and only signer = the depositor's wallet.
  const moved = buildSetRefundDestinationTransaction(program, { depositor: wallet.publicKey, refundTo: refundTo.publicKey, chainKeyHash: derived.chainKeyHash, recentBlockhash: BLOCKHASH, lastValidBlockHeight });
  const movedTx = VersionedTransaction.deserialize(Buffer.from(moved.transaction, "base64"));
  const movedKeys = movedTx.message.staticAccountKeys.map((k) => k.toBase58());
  if (movedTx.message.header.numRequiredSignatures !== 1 || movedKeys[0] !== wallet.publicKey.toBase58() || movedKeys.includes(derived.keyAddress)) throw new Error("a refund destination change is signed by the depositor alone, never by the key");
  if (!movedTx.signatures.every((s) => s.every((b) => b === 0))) throw new Error("the refund destination transaction should be unsigned");
  const movedSigned = VersionedTransaction.deserialize(Buffer.from(moved.transaction, "base64"));
  movedSigned.sign([wallet]);

  const response = { id: "close_fixture", status: "queued", payer: wallet.publicKey.toBase58(), authority: wallet.publicKey.toBase58(), payable_at: payable, transaction: built.transaction, message: built.message, accounts: built.accounts, expires_at_block_height: lastValidBlockHeight, signed_by_key: true, requested_by: "key", owner: null, refunds, note: "The transaction already carries the key's signature. Sign it with the payer wallet (any wallet; it pays the fee and a small rent) and send it before the blockhash expires. The refund is not sent to an address of your choosing: it returns to the wallets that deposited to this key (see refunds), after the dispute window and a sanctions check, never on demand. The key stops serving new calls once the closure is on chain. Until anything is paid you can take it back with POST /api/v1/credits/close/cancel: with the key once in 60 days, with the key's registered owner wallet at any time. If this key may have leaked, register an owner wallet first (POST /api/v1/credits/owner-tx) and close with as_owner." };
  const planned = (i: number, status: "planned" | "paid", tx: string | null = null, reason: string | null = null) => ({ depositor: refunds[i].depositor, refund_to: refunds[i].refund_to, owner: i === 0 ? wallet.publicKey.toBase58() : refundTo.publicKey.toBase58(), amount_units: i === 0 ? "20000000" : "4000000", status, reason, tx });
  const row = (over: Record<string, unknown>) => ({ id: "close_fixture", status: "registered", reason: null, refund_to: null, refunds: [], amount_units: null, requested_at: requested, payable_at: payable, paid_at: null, register_tx: null, pay_tx: null, cancel_tx: null, released_at: null, ...over });
  const txSig = (label: string) => base58Encode(rawSign(wallet, Buffer.from(SEED_PREFIX + label, "utf8"))); // a well-formed transaction signature, nothing more
  const paidAt = new Date((NOW + 73 * 3600) * 1000).toISOString();

  return {
    about: "POST /api/v1/credits/close {payer} with the key itself as the bearer. A closure names NO destination: what is left returns to the wallets that deposited to the key (`refunds`), each at most what it put in, to the token account that wallet named on chain (by default the one it paid from). The API key can ask for a closure and take it back; it cannot choose or change where the money goes, and a request that carries `refund_to` is refused (`refused_with_refund_to`). The returned transaction is one close_account instruction that already carries the key's signature (the key's own ed25519 keypair, derived from the API key by the router); the payer wallet adds its signature in slot 0 as fee payer and sends it before the blockhash expires. A client must not rebuild or re-sign anything else: the key's signature has to arrive unchanged. `transaction` is null when the closure is already registered on chain.",
    /** The 64-hex hash that names the key in the API (GET /api/v1/keys, DELETE /api/v1/keys/{hash}, close/release). */
    key_hash: derived.keyHash,
    key_address: derived.keyAddress,
    request: { payer: wallet.publicKey.toBase58() },
    /** The `data` of the 201 response, as src/api/keys.ts returns it. */
    response,
    /** The answer when the closure is already on chain: nothing to sign. */
    response_already_registered: { id: "close_fixture", status: "registered", payer: wallet.publicKey.toBase58(), authority: wallet.publicKey.toBase58(), payable_at: payable, transaction: null, refunds },
    refused_with_refund_to: envelope(400, "A closure refund returns to the wallets that deposited to this key, to the token account each of them named; the key cannot choose or change it. Send only { payer }. A depositor changes its own destination with POST /api/v1/credits/refund-destination-tx.", "refund_destination_fixed", "A close request that names a destination. A client never sends refund_to; one that still does is told so instead of believing it chose where the refund goes.", { payer: wallet.publicKey.toBase58(), refund_to: refundTo.publicKey.toBase58() }),
    ...closeLayout,
    deposit: {
      about: "POST /api/v1/credits/deposit-tx {amount, payer}: unsigned, for the payer's wallet. `refund_to` is the token account a closure refund of this deposit returns to (the one it is paid from) and `accounts.share` the on-chain record of what this wallet put into the key.",
      request: { amount: "25", payer: wallet.publicKey.toBase58() },
      response: { transaction: deposit.transaction, message: deposit.message, network: NETWORK, amount_usdc: "25", amount_units: "25000000", accounts: deposit.accounts, refund_to: deposit.refundTo, expires_at_block_height: lastValidBlockHeight, key_hash: derived.chainKeyHash, note: "If this key's credits are ever closed, what is left of this deposit is refunded to the token account it is paid from (refund_to). Only the paying wallet can change that, with POST /api/v1/credits/refund-destination-tx; the API key cannot." },
    },
    cancel: {
      about: "POST /api/v1/credits/close/cancel {payer} with the key itself as the bearer: takes a closure back while nothing has been paid. The transaction is one cancel_close instruction already signed by the key; the payer adds its signature in slot 0 and sends it, exactly as for the closure. Once it lands the key is open again with its balance. Who may cancel: whoever asked for the closure, or the key's registered owner wallet (as_owner: true returns the transaction unsigned for that wallet). The key itself only for a closure the key asked for, and once in 60 days. A depositor has no say over a closure.",
      request: { payer: wallet.publicKey.toBase58() },
      response: { transaction: cancelled.transaction, message: cancelled.message, accounts: cancelled.accounts, payer: wallet.publicKey.toBase58(), expires_at_block_height: lastValidBlockHeight, signed_by_key: true, note: "Sign with the payer wallet and send before the blockhash expires. Once it lands the key is open again with its balance and serves calls as before. The key can take a closure back once in 60 days; after this one, a further closure can only be taken back by the key's registered owner wallet." },
      ...keySigned(cancelled.transaction),
      errors: {
        nothing_to_cancel: envelope(400, "This key has no closure on chain to cancel.", "nothing_to_cancel", "No closure of this key is on chain."),
        refund_in_progress: envelope(409, "This closure has already been paid in part or in full and can no longer be cancelled.", "refund_in_progress", "A refund payment has already been sent: the closure can no longer be taken back."),
        cancel_cooldown: envelope(409, "This key has already taken a closure back in the last 60 days and cannot do so again yet. The key's registered owner wallet can (as_owner).", "cancel_cooldown", "The key used its one cancel of the period; error.metadata.retry_at says when it may cancel again. The owner wallet is not bound by this."),
        not_requester: envelope(403, "This closure was asked for by the key's owner wallet: only that wallet can take it back (send as_owner with payer = the owner wallet).", "not_requester", "A closure the owner wallet asked for cannot be cancelled with the API key."),
      },
    },
    release: {
      about: "POST /api/v1/credits/close/release {key} by an owner or admin of the account (`key` is the key's hash, not the key). A closure is not paid while its key is disabled: disabling a key (DELETE /api/v1/keys/{hash}) puts a closure it started on hold, and this lets it go ahead on purpose. The refund still only returns to the wallets that paid in.",
      request: { key: derived.keyHash },
      response: [{ id: "close_fixture", status: "registered", released: true, payable_at: payable }],
      /** The whole body of DELETE /api/v1/keys/{hash} when that key has an open closure: the closure is now held. */
      key_disabled_response: { deleted: true, data: { hash: derived.keyHash, deleted: true, closure_held: { id: "close_fixture", reason: "key_disabled", release: "POST /api/v1/credits/close/release" } } },
      errors: { not_found: envelope(404, "That key has no open closure.", "not_found", "The key has no queued or registered closure.") },
    },
    refund_destination: {
      about: "POST /api/v1/credits/refund-destination-tx {depositor, refund_to}: an UNSIGNED set_refund_destination transaction. Only the depositor's own wallet can sign it (it is the fee payer and the only signer; the API key signs nothing and is not in the transaction). From then on that wallet's share of a closure refund goes to `refund_to`'s USDC token account (`accounts.refundToToken`). It moves nothing now.",
      request: { depositor: wallet.publicKey.toBase58(), refund_to: refundTo.publicKey.toBase58() },
      response: { transaction: moved.transaction, message: moved.message, accounts: moved.accounts, depositor: wallet.publicKey.toBase58(), refund_to: refundTo.publicKey.toBase58(), current_refund_to: walletToken.toBase58(), expires_at_block_height: lastValidBlockHeight, note: "Only the depositor's own wallet can sign this. It changes where that wallet's deposits to this key are refunded; it moves nothing now." },
      signers: movedKeys.slice(0, movedTx.message.header.numRequiredSignatures),
      message_base64: b64(movedTx.message.serialize()),
      instruction_count: movedTx.message.compiledInstructions.length,
      signed_transaction: b64(movedSigned.serialize()),
      depositor_signature_base58: base58Encode(movedSigned.signatures[0]),
      errors: { not_found: envelope(404, "That wallet has not deposited to this key.", "not_found", "The wallet never deposited to this key, so it has no refund destination to move.", { depositor: refundTo.publicKey.toBase58(), refund_to: refundTo.publicKey.toBase58() }) },
    },
    list: {
      about: "GET /api/v1/credits/close: this key's closures, newest first. `refunds` is the payment plan once it exists (one row per depositor: where it is paid, the wallet that owns that token account, how much, and whether it was sent); `refund_to` is the wallets paid so far, comma-separated, or null. A row with status queued or registered and a `reason` is waiting, not failed: `key_disabled` is held until an owner releases it.",
      statuses: ["queued", "registered", "paid", "refused", "failed", "cancelled"],
      reasons: ["key_disabled", "refund_rate_limited", "refund_destination_unavailable", "depositors_unknown", "cancelled_on_chain", "sanctioned_address", "submission_failed", "refund_work_capped", "request_gone_refund_debited"],
      refund_statuses: ["planned", "paid", "refused", "reversed"],
      response: [
        row({ id: "close_fixture_4", status: "registered", reason: "key_disabled", register_tx: txSig("register-4") }),
        // Held while its key was disabled, released by an owner (released_at), and now being paid in parts.
        row({ id: "close_fixture_3", status: "registered", reason: "refund_rate_limited", refunds: [planned(0, "paid", txSig("pay-3")), planned(1, "planned", null, "refund_rate_limited")], amount_units: "24000000", register_tx: txSig("register-3"), pay_tx: txSig("pay-3"), released_at: paidAt }),
        row({ id: "close_fixture_2", status: "cancelled", reason: "cancelled_on_chain", register_tx: txSig("register-2"), cancel_tx: txSig("cancel-2") }),
        row({ id: "close_fixture_1", status: "paid", refund_to: `${wallet.publicKey.toBase58()},${refundTo.publicKey.toBase58()}`, refunds: [planned(0, "paid", txSig("pay-1a")), planned(1, "paid", txSig("pay-1b"))], amount_units: "24000000", paid_at: paidAt, register_tx: txSig("register-1"), pay_tx: txSig("pay-1b") }),
      ],
    },
  };
}

// ---- 6. Errors a client has to recognise ------------------------------------------------------------------------------------
function errors() {
  const closing = new ApiError(409, "This key's credits are being closed and refunded; it cannot start new calls.", "credits_closing", { closure: "close_fixture" });
  const notBound = new ApiError(401, "A transaction signature in X-PAYMENT is accepted only together with X-Wallet-Auth signed by the wallet that paid: a landed payment is public, so the signature alone does not show who is asking. Send X-Wallet-Auth, or pay with a signed x402 payload.", "payment_not_bound_to_caller", { tx: "5".repeat(88) });
  return {
    about: "Error envelopes as the router sends them (src/lib/errors.ts ApiError.toJSON).",
    credits_closing: { about: "Any call that would start new spending on a key whose closure is registered: the key is frozen until the refund is paid. Not retryable; use another key.", status: closing.status, body: closing.toJSON() },
    payment_not_bound_to_caller: { about: "A bare transaction signature in X-PAYMENT without X-Wallet-Auth from the wallet that paid (security review TR-07).", status: notBound.status, body: notBound.toJSON() },
  };
}

export function buildFixtures() {
  return {
    generated_by: "sdks/fixtures/generate.ts (bun sdks/fixtures/generate.ts). Do not edit: every value is produced by the router's own code.",
    keys: {
      about: `Each key is the ed25519 key whose 32-byte seed is SHA-256("${SEED_PREFIX}" + label), UTF-8. No seed is stored in this file.`,
      seed_prefix: SEED_PREFIX,
      wallet: { label: "wallet", address: wallet.publicKey.toBase58() },
      session: { label: "session", address: session.publicKey.toBase58() },
      fee_payer: { label: "fee-payer", address: feePayer.publicKey.toBase58() },
      payee: { label: "payee", address: payee.publicKey.toBase58() },
      refund_to: { label: "refund-to", address: refundTo.publicKey.toBase58() },
      second_depositor: { label: "second-depositor", address: secondDepositor.publicKey.toBase58() },
    },
    now: NOW,
    host: HOST,
    sign_in: signIn(),
    wallet_auth: walletAuthCases(),
    tab: tabs(),
    x402: x402(),
    closure: closure(),
    errors: errors(),
  };
}

export const renderFixtures = () => JSON.stringify(buildFixtures(), (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v), 2) + "\n";

if (import.meta.main) {
  const text = renderFixtures();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(FIXTURE_FILE, "utf8"); } catch { /* missing: differs */ }
    if (current !== text) { console.error("sdks/fixtures/contracts.json is not what the router produces now: run `bun sdks/fixtures/generate.ts` and update the SDKs."); process.exit(1); }
    console.log("sdks/fixtures/contracts.json matches the router");
  } else {
    writeFileSync(FIXTURE_FILE, text);
    console.log(`sdks/fixtures/contracts.json ${Buffer.byteLength(text)} bytes sha256 ${createHash("sha256").update(text).digest("hex")}`);
  }
}
