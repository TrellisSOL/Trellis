// The client against the router's own contract fixtures (sdks/fixtures/contracts.json, written by the router's code:
// sdks/fixtures/generate.ts). Every message, signature, instruction and transaction the client produces here has to be
// byte for byte what the router's verifier produced or accepted. Test keys are derived from labels; no secret is stored.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CREDITS_CLOSING, EXACT_LIMITS, MAX_TAB_LIFETIME_SECONDS, NOTHING_TO_CANCEL, PAYMENT_NOT_BOUND, REFUND_DESTINATION_FIXED, REFUND_IN_PROGRESS, VOUCHER_DOMAIN, VOUCHER_MESSAGE_LENGTH, WALLET_AUTH_VERSION, WALLET_SIGN_IN_VERSION,
  TabSession, Trellis, TrellisError, address, base58Decode, base58Encode, buildExactPayment, bytesToBase64, canonicalBodyHash, canonicalJson, chatRequestHash, checkWalletChallenge, decodeTabAccount, hostResourceHash, isClosureHeld, isCreditsClosing,
  landedPaymentHeaders, openTabInstruction, parseTransaction, parseVoucherHeader, parseWalletSignInMessage, priorityFeeLamports, reclaimInstruction, signCreditClosure, signCreditClosureCancel, signRefundDestination, signVoucher, signerFromSeed, tabPdas, topUpInstruction, verifyVoucher,
  voucherMessage, walletAuthHeader, walletAuthMessage, walletSignIn, walletSignInBody, x402PaymentHeader,
  type Instruction, type KeypairSigner, type WalletChallenge, type X402Requirement,
} from "../src/index.js";
import * as solana from "../src/solana.js";
import { json, stubFetch } from "./helpers.js";

const F = JSON.parse(readFileSync(new URL("../../../sdks/fixtures/contracts.json", import.meta.url), "utf8"));
const signerOf = (label: string): Promise<KeypairSigner> => signerFromSeed(new Uint8Array(createHash("sha256").update(F.keys.seed_prefix + label).digest()));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ixJson = (ix: Instruction) => ({ program_id: ix.programId, keys: ix.keys.map((k) => ({ pubkey: k.pubkey, is_signer: k.isSigner, is_writable: k.isWritable })), data_hex: hex(ix.data) });
const same = (ix: Instruction, want: { program_id: string; keys: unknown[]; data_hex: string }) => expect(ixJson(ix) as unknown).toEqual({ program_id: want.program_id, keys: want.keys, data_hex: want.data_hex });

describe("the fixture's keys", () => {
  test("each label derives the address the router derived", async () => {
    for (const key of [F.keys.wallet, F.keys.session, F.keys.fee_payer, F.keys.payee, F.keys.refund_to, F.keys.second_depositor]) expect(address((await signerOf(key.label)).publicKey)).toBe(key.address);
  });
});

describe("wallet sign-in (trellis:wallet:v2)", () => {
  const S = F.sign_in;
  test("the wallet signs challenge.message exactly as the router returned it", async () => {
    const wallet = await signerOf("wallet");
    expect(WALLET_SIGN_IN_VERSION).toBe(S.version);
    const body = await walletSignInBody(wallet, S.challenge as WalletChallenge, { host: S.expected_host, name: S.request.name, now: F.now * 1000 });
    expect(body).toEqual(S.request);
    expect(body.signature).toBe(S.signature);
    expect(body).not.toHaveProperty("timestamp");
    expect(parseWalletSignInMessage(S.challenge.message)).toMatchObject({ domain: S.challenge.domain, address: F.keys.wallet.address, uri: S.challenge.uri, chainId: S.challenge.chain_id, nonce: S.challenge.nonce, issuedAt: S.challenge.issued_at, expirationTime: S.challenge.expires_at });
  });

  test("a challenge for another site, another wallet, an expired one or a non-sign-in text is not signed", async () => {
    const wallet = await signerOf("wallet");
    const now = F.now * 1000;
    let signed = 0;
    const counting = { publicKey: wallet.publicKey, sign: async (m: Uint8Array) => { signed++; return wallet.sign(m); } };
    const refused = (challenge: unknown, host = S.expected_host, at = now) => expect(walletSignInBody(counting, challenge as WalletChallenge, { host, now: at })).rejects.toMatchObject({ code: "sign_in_refused" });
    await refused(S.other_domain_challenge); // a challenge another site obtained and passed on
    await refused({ ...S.challenge, message: S.other_domain_challenge.message }); // this site's envelope around the other site's text
    await refused(S.challenge, "another-router.example");
    await refused(S.challenge, S.expected_host, (F.now + 301) * 1000);
    await refused({ ...S.challenge, message: S.retired_v1_message });
    await refused({ ...S.challenge, nonce: "0".repeat(48) });
    await expect(walletSignInBody(await signerOf("session"), S.challenge as WalletChallenge, { host: S.expected_host, now })).rejects.toMatchObject({ code: "sign_in_refused" });
    expect(signed).toBe(0);
    expect(() => checkWalletChallenge(S.challenge, { host: S.expected_host, address: wallet.publicKey, now })).not.toThrow();
    // The v1 message is not something this client can build any more.
    expect(Object.keys(solana)).not.toContain("walletSignInMessage");
  });

  test("walletSignIn: challenge, check, sign, exchange for the key", async () => {
    const wallet = await signerOf("wallet");
    const bodies: unknown[] = [];
    const { fetch } = stubFetch({
      "POST /api/v1/auth/wallet/challenge": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: S.challenge }); },
      "POST /api/v1/auth/wallet": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: { hash: "0xkey" }, key: "issued-key" }, 201); },
    });
    const out = await walletSignIn({ baseUrl: `https://${S.expected_host}/`, signer: wallet, name: S.request.name, fetch, now: F.now * 1000 });
    expect(out).toEqual({ key: "issued-key", data: { hash: "0xkey" } });
    expect(bodies).toEqual([{ address: F.keys.wallet.address }, S.request]);
    // Talking to another host than the one the challenge names: nothing is signed, nothing is posted.
    const phish = stubFetch({ "POST /api/v1/auth/wallet/challenge": () => json({ data: S.challenge }), "POST /api/v1/auth/wallet": () => { throw new Error("must not be reached"); } });
    await expect(walletSignIn({ baseUrl: "https://phish.example", signer: wallet, fetch: phish.fetch, now: F.now * 1000 })).rejects.toMatchObject({ code: "sign_in_refused" });
  });
});

describe("X-Wallet-Auth (trellis:wallet-auth:v2)", () => {
  const W = F.wallet_auth;
  test("every case: the message, the signature and the header the router computed", async () => {
    const wallet = await signerOf("wallet");
    expect(WALLET_AUTH_VERSION).toBe(W.version);
    expect(solana.EMPTY_BODY_HASH).toBe(W.empty_sha256);
    for (const c of W.cases) {
      expect(walletAuthMessage({ method: c.method, host: c.host, path: c.path, timestamp: c.timestamp, sha256: c.sha256 }), c.name).toBe(c.message);
      expect(await walletAuthHeader(wallet, { method: c.method, host: c.host, path: c.path, sha256: c.sha256, now: c.timestamp }), c.name).toBe(c.header);
      // From the URL and the body, as a caller has them.
      const bound = c.name === "chat_request" ? { chat: c.body } : c.name === "host_resource" ? { sha256: hostResourceHash(c.host_id) } : c.body ? { json: c.body } : {};
      expect(await walletAuthHeader(wallet, { method: c.method.toLowerCase(), url: c.url.replace("https://", "HTTPS://").replace(c.host, c.host.toUpperCase()), ...bound, now: c.timestamp }), c.name).toBe(c.header);
      if (c.canonical_json) expect(canonicalJson(c.name === "chat_request" ? (({ stream: _s, stream_options: _o, ...rest }) => rest)(c.body) : c.body), c.name).toBe(c.canonical_json);
    }
    const chat = W.cases.find((c: { name: string }) => c.name === "chat_request");
    expect(chatRequestHash(chat.body)).toBe(chat.sha256);
    expect(chatRequestHash({ ...chat.body, stream: false, stream_options: undefined })).toBe(chat.sha256);
    expect(canonicalBodyHash(W.cases.find((c: { name: string }) => c.name === "json_body").body)).toBe(W.cases.find((c: { name: string }) => c.name === "json_body").sha256);
  });

  test("the retired v1 message is not what the client signs", async () => {
    const wallet = await signerOf("wallet");
    const c = W.cases[0];
    const v1 = base58Encode(await wallet.sign(new TextEncoder().encode(W.retired_v1_message)));
    expect(c.header.endsWith(v1)).toBe(false);
    expect((await walletAuthHeader(wallet, { method: c.method, url: c.url, now: c.timestamp })).endsWith(v1)).toBe(false);
  });

  test("Trellis({ walletAuth }) sends the header the router expects for a chat call", async () => {
    const wallet = await signerOf("wallet");
    const chat = W.cases.find((c: { name: string }) => c.name === "chat_request");
    let header = "";
    const { fetch } = stubFetch({ "POST /api/v1/chat/completions": ({ init }) => { header = (init!.headers as Record<string, string>)["x-wallet-auth"]; return json({ id: "g", choices: [] }); } });
    const realNow = Date.now;
    Date.now = () => chat.timestamp * 1000;
    try {
      const { stream: _s, stream_options: _o, ...body } = chat.body;
      await new Trellis({ baseUrl: `https://${chat.host}`, fetch, walletAuth: wallet, verifyReceipts: false }).chat.completions.create(body);
    } finally { Date.now = realNow; }
    expect(header).toBe(chat.header);
  });

  test("a per-call payment retry does not resend the wallet header the first attempt spent", async () => {
    const wallet = await signerOf("wallet");
    const seen: Record<string, string>[] = [];
    const { fetch } = stubFetch({ "POST /api/v1/chat/completions": ({ init }) => { const h = init!.headers as Record<string, string>; seen.push(h); return h["x-payment"] ? json({ id: "g", choices: [] }) : json({ x402Version: 1, error: "pay", accepts: [F.x402.requirement] }, 402); } });
    const c = new Trellis({ baseUrl: `https://${F.host}`, fetch, walletAuth: wallet, payer: { signer: wallet, connection: { getLatestBlockhash: async () => ({ blockhash: F.x402.recent_blockhash }) } }, verifyReceipts: false });
    await c.chat.completions.create({ model: "m", messages: [] });
    expect(seen).toHaveLength(2);
    expect(seen[0]["x-wallet-auth"]).toBeDefined();
    expect(seen[1]["x-wallet-auth"]).toBeUndefined(); // single use: the router would refuse it as a replay
    expect(seen[1]["x-payment"]).toBeDefined();
  });

  test("a landed payment is presented with the payer's wallet header; the router's refusal without it keeps its code", async () => {
    const wallet = await signerOf("wallet");
    const chat = W.cases.find((c: { name: string }) => c.name === "chat_request");
    const headers = await landedPaymentHeaders(wallet, "5".repeat(88), { method: "POST", url: chat.url, chat: chat.body, now: chat.timestamp });
    expect(headers).toEqual({ "x-payment": "5".repeat(88), "x-wallet-auth": chat.header });
    const E = F.errors.payment_not_bound_to_caller;
    const c = new Trellis({ baseUrl: "https://router.example", fetch: stubFetch({ "POST /api/v1/chat/completions": () => json(E.body, E.status) }).fetch, verifyReceipts: false });
    const e = await c.chat.completions.create({ model: "m", messages: [] }, { headers: { "x-payment": "5".repeat(88) } }).catch((x) => x);
    expect(e).toBeInstanceOf(TrellisError);
    expect([e.status, e.code]).toEqual([401, PAYMENT_NOT_BOUND]);
  });
});

describe("tabs and vouchers (trellis:tab:voucher:v1)", () => {
  const T = F.tab;
  const now = Number(T.tab_account.created_at);
  const rulebook = { rulebook: T.rulebook.rulebook, rulesProgram: T.rulebook.rules_program };
  const base = { programId: T.program_id, payer: T.payer, payee: T.payee, mint: T.mint };

  test("open_tab, top_up and reclaim: the router's account lists and data, with and without a rulebook", () => {
    const open = { ...base, cap: BigInt(T.cap), expiry: BigInt(T.expiry), sessionKey: T.session, tabId: BigInt(T.tab_id), now };
    const plain = openTabInstruction(open);
    expect(plain.tab).toBe(T.tab);
    expect(tabPdas(T.program_id, T.payer, T.payee, BigInt(T.tab_id))).toMatchObject(T.pdas);
    same(plain.instruction, T.instructions.open_tab);
    same(openTabInstruction({ ...open, rulebook }).instruction, T.instructions.open_tab_with_rulebook);
    same(topUpInstruction({ ...base, tab: T.tab, amount: BigInt(T.instructions.top_up.amount) }), T.instructions.top_up);
    same(topUpInstruction({ ...base, tab: T.tab, amount: BigInt(T.instructions.top_up_with_rulebook.amount), rulebook }), T.instructions.top_up_with_rulebook);
    const reclaim = reclaimInstruction({ ...base, tab: T.tab });
    same(reclaim, T.instructions.reclaim);
    expect(reclaim.keys.some((k) => k.isSigner)).toBe(false);
    // The rulebook group is in open_tab and top_up only: the payee's close and post_voucher (router side) carry none of it.
    const groups = [T.rulebook.rulebook, T.rulebook.rules_config, T.rulebook.rules_program];
    for (const ix of [...T.instructions.close.instructions, ...T.instructions.post_voucher.instructions, T.instructions.reclaim]) for (const k of ix.keys) expect(groups).not.toContain(k.pubkey);
    // The program refuses a tab that lives longer than 30 days; so does the client.
    expect(MAX_TAB_LIFETIME_SECONDS).toBe(T.max_lifetime_seconds);
    expect(() => openTabInstruction({ ...open, expiry: now + T.max_lifetime_seconds + 1 })).toThrow(/30 days/);
  });

  test("the Tab account decodes to the created_at the vouchers sign", () => {
    const account = decodeTabAccount(T.tab_account.data_base64)!;
    expect(account).toMatchObject({ payer: T.payer, payee: T.payee, sessionKey: T.session, mint: T.mint, tabId: BigInt(T.tab_id), cap: BigInt(T.cap), expiry: BigInt(T.expiry), createdAt: BigInt(T.tab_account.created_at), postedUsed: 0n, postedSeq: 0n, rulebook: null });
  });

  test("every voucher case: the 110-byte message, the signature, the headers and the wire form", async () => {
    const session = await signerOf("session");
    expect([VOUCHER_DOMAIN, VOUCHER_MESSAGE_LENGTH]).toEqual([T.voucher.domain, T.voucher.length]);
    for (const c of T.voucher.cases) {
      const v = { tab: T.tab, cumulativeUsed: BigInt(c.cumulative_used), seq: BigInt(c.seq) };
      const scope = { programId: c.program_id, createdAt: BigInt(c.created_at) };
      expect(hex(voucherMessage(v, scope))).toBe(c.message_hex);
      const signed = await signVoucher(session, v, scope);
      expect(bytesToBase64(signed.message)).toBe(c.message_base64);
      expect(base58Encode(signed.signature)).toBe(c.signature_base58);
      expect(signed.headers).toEqual(c.headers);
      expect({ tab: signed.wire.tab, cumulative_used: signed.wire.cumulative_used, seq: signed.wire.seq, signature: signed.wire.signature }).toEqual(c.wire);
      expect(parseVoucherHeader(c.headers["X-Trellis-Tab-Voucher"])).toMatchObject({ tab: T.tab, programId: c.program_id, createdAt: BigInt(c.created_at), cumulativeUsed: v.cumulativeUsed, seq: v.seq });
      expect(await verifyVoucher(c.wire, scope, T.session)).toBe(true);
      expect(await verifyVoucher(c.headers["X-Trellis-Tab-Voucher"], scope, T.session)).toBe(true);
    }
  });

  test("a session opened from the chain produces the fixture's vouchers in order", async () => {
    const session = await signerOf("session");
    const rpc = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { data: [T.tab_account.data_base64, "base64"] } } }))) as never;
    const s = await TabSession.open({ tab: T.tab, programId: T.program_id, sessionKey: session, rpcUrl: "https://rpc.example", fetch: rpc });
    expect(s.createdAt).toBe(BigInt(T.tab_account.created_at));
    const [first, second] = T.voucher.cases;
    expect((await s.voucher(BigInt(first.cumulative_used))).headers).toEqual(first.headers);
    expect((await s.voucher(BigInt(second.cumulative_used))).headers).toEqual(second.headers);
  });

  test("a voucher for an earlier opening of the tab, for another program, or in the 48-byte form does not verify", async () => {
    const scope = { programId: T.program_id, createdAt: BigInt(T.tab_account.created_at) };
    const N = T.voucher.not_for_this_tab;
    for (const other of [N.reopened_later, N.another_program]) {
      expect(await verifyVoucher(other.wire, scope, T.session)).toBe(false);
      expect(await verifyVoucher(other.headers["X-Trellis-Tab-Voucher"], scope, T.session)).toBe(false);
      // It is a genuine voucher of the session key, for what it names: only the verifier's scope keeps it out.
      expect(await verifyVoucher(other.wire, { programId: other.program_id, createdAt: BigInt(other.created_at) }, T.session)).toBe(true);
    }
    const legacy = `${N.retired_48_byte_form.message_base64}.${N.retired_48_byte_form.signature_base64}`;
    expect(() => parseVoucherHeader(legacy)).toThrow(/retired/);
    expect(await verifyVoucher(legacy, scope, T.session)).toBe(false);
    expect(await verifyVoucher({ tab: T.tab, cumulative_used: "20000", seq: "1", signature: N.retired_48_byte_form.signature_base58 }, scope, T.session)).toBe(false);
  });
});

describe("x402 exact: inside what the router's fee payer signs", () => {
  const X = F.x402;
  const requirement = X.requirement as X402Requirement;

  test("the limits are the router's", () => {
    expect({ max_compute_unit_limit: EXACT_LIMITS.maxComputeUnitLimit, max_compute_unit_price_micro_lamports: EXACT_LIMITS.maxComputeUnitPriceMicroLamports.toString(), max_priority_fee_lamports: EXACT_LIMITS.maxPriorityFeeLamports.toString(), allow_ata_creation: true }).toEqual(X.limits);
    for (const e of X.priority_fee_examples) expect(priorityFeeLamports(e.compute_unit_limit, BigInt(e.compute_unit_price_micro_lamports)).toString()).toBe(e.lamports);
  });

  test("each payment the router accepts is what the client builds from the same options, byte for byte", async () => {
    const wallet = await signerOf("wallet");
    for (const a of X.accepted) {
      const o = a.options as { create_destination_ata?: boolean; compute_unit_limit?: number; compute_unit_price_micro_lamports?: string };
      const p = await buildExactPayment({ requirement, signer: wallet, recentBlockhash: X.recent_blockhash, createDestinationAta: o.create_destination_ata, computeUnitLimit: o.compute_unit_limit, computeUnitPrice: o.compute_unit_price_micro_lamports === undefined ? undefined : BigInt(o.compute_unit_price_micro_lamports) });
      expect(p.transaction, a.name).toBe(a.transaction);
      expect(x402PaymentHeader(p), a.name).toBe(a.payment_header);
      const t = parseTransaction(p.transaction);
      expect(t.accountKeys[0]).toBe(X.fee_payer);
      expect(t.header.numRequiredSignatures).toBe(2);
      expect(t.signatures[0].every((b) => b === 0)).toBe(true); // the fee payer's slot is the router's to fill
      expect([p.source, p.destination, p.payer, p.feePayer]).toEqual([X.source, X.destination, X.payer, X.fee_payer]);
    }
  });

  test("createDestinationAta 'auto' asks the cluster and funds the account from the payer only when it is missing", async () => {
    const wallet = await signerOf("wallet");
    const rpc = (exists: boolean) => (async (_u: unknown, init?: { body?: unknown }) => { const req = JSON.parse(String(init?.body)); expect(req.method).toBe("getAccountInfo"); expect(req.params[0]).toBe(X.destination); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: exists ? { data: ["", "base64"] } : null } })); }) as never;
    const byName = (n: string) => X.accepted.find((a: { name: string }) => a.name === n).transaction;
    expect((await buildExactPayment({ requirement, signer: wallet, recentBlockhash: X.recent_blockhash, createDestinationAta: "auto", rpcUrl: "https://rpc.example", fetch: rpc(true) })).transaction).toBe(byName("transfer_only"));
    expect((await buildExactPayment({ requirement, signer: wallet, recentBlockhash: X.recent_blockhash, createDestinationAta: "auto", rpcUrl: "https://rpc.example", fetch: rpc(false) })).transaction).toBe(byName("with_destination_ata"));
  });

  test("a payment the router would refuse is never built", async () => {
    const wallet = await signerOf("wallet");
    const build = (o: Record<string, unknown>) => buildExactPayment({ requirement, signer: wallet, recentBlockhash: X.recent_blockhash, ...o });
    const refused = X.refused.map((r: { name: string }) => r.name);
    expect(refused).toEqual(expect.arrayContaining(["ata_funded_by_fee_payer", "compute_limit_above_cap", "compute_price_above_cap", "priority_fee_above_cap", "price_without_limit_above_cap", "two_transfers"]));
    await expect(build({ computeUnitLimit: EXACT_LIMITS.maxComputeUnitLimit + 1 })).rejects.toMatchObject({ code: "payment_out_of_bounds" });
    await expect(build({ computeUnitLimit: 1_000, computeUnitPrice: EXACT_LIMITS.maxComputeUnitPriceMicroLamports + 1n })).rejects.toMatchObject({ code: "payment_out_of_bounds" });
    await expect(build({ computeUnitLimit: EXACT_LIMITS.maxComputeUnitLimit, computeUnitPrice: EXACT_LIMITS.maxComputeUnitPriceMicroLamports })).rejects.toMatchObject({ code: "payment_out_of_bounds" });
    await expect(build({ computeUnitPrice: EXACT_LIMITS.maxComputeUnitPriceMicroLamports })).rejects.toMatchObject({ code: "payment_out_of_bounds" });
    // With the ATA creation there are two instructions, so a price with no explicit limit is charged on 400,000 units.
    await expect(build({ createDestinationAta: true, computeUnitPrice: 30_000n })).rejects.toMatchObject({ code: "payment_out_of_bounds" });
    await expect(build({ createDestinationAta: true, computeUnitPrice: 25_000n })).resolves.toBeDefined();
    // The fee payer never funds payTo's token account and is never the payer: no option expresses either, and no built
    // transaction equals a refused one.
    const built = new Set<string>();
    for (const o of [{}, { createDestinationAta: true }, { computeUnitLimit: 60_000, computeUnitPrice: 100_000n }]) built.add((await build(o)).transaction);
    for (const r of X.refused) expect(built.has(r.transaction)).toBe(false);
    await expect(buildExactPayment({ requirement, signer: await signerOf("fee-payer"), recentBlockhash: X.recent_blockhash })).rejects.toThrow(/fee payer/);
  });
});

describe("credits closure: the transaction arrives signed by the key", () => {
  const C = F.closure;
  test("the payer adds its signature in slot 0 and the key's signature is untouched", async () => {
    const wallet = await signerOf("wallet");
    const before = parseTransaction(C.response.transaction);
    expect(before.accountKeys.slice(0, before.header.numRequiredSignatures)).toEqual(C.signers);
    expect(before.signatures[0].every((b) => b === 0)).toBe(true);
    expect(base58Encode(before.signatures[C.key_signature_index])).toBe(C.key_signature_base58);
    const signed = await signCreditClosure(C.response.transaction, wallet);
    expect(signed).toBe(C.signed_transaction);
    const after = parseTransaction(signed);
    expect(base58Encode(after.signatures[C.key_signature_index])).toBe(C.key_signature_base58);
    expect(base58Encode(after.signatures[0])).toBe(C.payer_signature_base58);
    expect(bytesToBase64(after.message)).toBe(C.message_base64);
  });

  test("another wallet cannot stand in for the payer, and a closure without the key's signature is not signed", async () => {
    await expect(signCreditClosure(C.response.transaction, await signerOf("refund-to"))).rejects.toThrow(/fee payer/);
    const t = parseTransaction(C.response.transaction);
    const stripped = bytesToBase64(solana.serializeTransaction(t.message, t.signatures.map(() => null)));
    await expect(signCreditClosure(stripped, await signerOf("wallet"))).rejects.toThrow(/key's signature/);
  });

  test("closeCreditsWith: request with the payer and nothing else, sign, and hand back what to send; nothing to sign once registered", async () => {
    const wallet = await signerOf("wallet");
    const bodies: unknown[] = [];
    let answer: unknown = C.response;
    const { fetch, calls } = stubFetch({ "POST /api/v1/credits/close": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: answer }, 201); } });
    const c = new Trellis({ baseUrl: "https://router.example", apiKey: "the-key-being-closed", fetch });
    const out = await c.closeCreditsWith(wallet);
    expect(bodies[0]).toEqual(C.request);
    expect(Object.keys(bodies[0] as object)).toEqual(["payer"]); // no destination is ever sent
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer the-key-being-closed");
    expect(out.closure).toMatchObject({ id: C.response.id, status: "queued", payer: C.payer, signed_by_key: true });
    expect(out.signed).toBe(C.signed_transaction);
    // Where the refund goes is the router's answer, not the caller's choice: the wallets that paid in.
    expect(out.closure.refunds).toEqual(C.response.refunds);
    expect(out.closure.refunds!.map((r) => r.depositor)).toEqual([F.keys.wallet.address, F.keys.second_depositor.address]);
    expect("refund_to" in out.closure).toBe(false);
    expect(out.closure.accounts).toEqual(C.response.accounts);
    answer = C.response_already_registered;
    const again = await c.closeCreditsWith(wallet);
    expect(again.signed).toBeNull();
    expect(again.closure.refunds).toEqual(C.response_already_registered.refunds);
  });

  test("a call that names a destination throws before it is sent; the router refuses one that still arrives", async () => {
    const wallet = await signerOf("wallet");
    const R = C.refused_with_refund_to;
    let sent = 0;
    const { fetch } = stubFetch({ "POST /api/v1/credits/close": ({ init }) => { sent++; return "refund_to" in JSON.parse(String(init!.body)) ? json(R.body, R.status) : json({ data: C.response }, 201); } });
    const c = new Trellis({ baseUrl: "https://router.example", apiKey: "the-key-being-closed", fetch });
    const loose = c as unknown as { closeCredits(...a: unknown[]): Promise<unknown>; closeCreditsWith(...a: unknown[]): Promise<unknown>; cancelCreditClosure(...a: unknown[]): Promise<unknown>; cancelCreditClosureWith(...a: unknown[]): Promise<unknown> };
    for (const call of [
      () => loose.closeCredits(R.request.refund_to),
      () => loose.closeCredits(R.request.refund_to, { payer: R.request.payer }),
      () => loose.closeCredits(R.request),
      () => loose.closeCreditsWith(wallet, R.request.refund_to),
      () => loose.cancelCreditClosure(R.request),
      () => loose.cancelCreditClosureWith(wallet, R.request.refund_to),
    ]) {
      const e = (await Promise.resolve().then(call).catch((x) => x)) as TrellisError;
      expect(e).toBeInstanceOf(TrellisError);
      expect([e.code, e.status]).toEqual([REFUND_DESTINATION_FIXED, undefined]);
      expect(e.message).toMatch(/returns to the wallets that funded the key/);
    }
    expect(sent).toBe(0);
    // The router's own refusal (a client that bypasses the method) carries the same code.
    expect(R.body.error.type).toBe(REFUND_DESTINATION_FIXED);
    const raw = await fetch("https://router.example/api/v1/credits/close", { method: "POST", body: JSON.stringify(R.request) });
    expect([raw.status, ((await raw.json()) as typeof R.body).error.type]).toEqual([400, REFUND_DESTINATION_FIXED]);
  });

  test("sendTransaction posts the signed transaction to the cluster as base64", async () => {
    let sent: { method: string; params: unknown[] } | null = null;
    const rpc = (async (_u: unknown, init?: { body?: unknown }) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: C.payer_signature_base58 })); }) as never;
    expect(await solana.sendTransaction(C.signed_transaction, { rpcUrl: "https://rpc.example", fetch: rpc })).toBe(C.payer_signature_base58);
    expect(sent!.method).toBe("sendTransaction");
    expect(sent!.params[0]).toBe(C.signed_transaction);
    expect(sent!.params[1]).toMatchObject({ encoding: "base64" });
  });
});

describe("credits closure: cancel, release, refund destination, list", () => {
  const C = F.closure;
  const client = (routes: Parameters<typeof stubFetch>[0], apiKey = "the-key-being-closed") => { const s = stubFetch(routes); return { ...s, c: new Trellis({ baseUrl: "https://router.example", apiKey, fetch: s.fetch }) }; };

  test("cancelCreditClosureWith: the cancel transaction arrives signed by the key; the payer adds its signature and nothing else changes", async () => {
    const K = C.cancel;
    const wallet = await signerOf("wallet");
    const bodies: unknown[] = [];
    const { c, calls } = client({ "POST /api/v1/credits/close/cancel": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: K.response }); } });
    const before = parseTransaction(K.response.transaction);
    expect(before.accountKeys.slice(0, before.header.numRequiredSignatures)).toEqual(K.signers);
    expect(before.signatures[0].every((b) => b === 0)).toBe(true);
    const out = await c.cancelCreditClosureWith(wallet);
    expect(bodies).toEqual([K.request]);
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer the-key-being-closed");
    expect(out.cancel).toEqual(K.response);
    expect(out.signed).toBe(K.signed_transaction);
    const after = parseTransaction(out.signed);
    expect(base58Encode(after.signatures[K.key_signature_index])).toBe(K.key_signature_base58);
    expect(base58Encode(after.signatures[0])).toBe(K.payer_signature_base58);
    expect(bytesToBase64(after.message)).toBe(K.message_base64);
    expect((await c.cancelCreditClosure({ payer: K.payer })).transaction).toBe(K.response.transaction);
    // Another wallet cannot stand in for the payer, and a cancellation without the key's signature is not signed.
    await expect(signCreditClosureCancel(K.response.transaction, await signerOf("refund-to"))).rejects.toThrow(/fee payer/);
    const stripped = bytesToBase64(solana.serializeTransaction(before.message, before.signatures.map(() => null)));
    await expect(signCreditClosureCancel(stripped, wallet)).rejects.toThrow(/key's signature/);
  });

  test("cancel: nothing to cancel (400) and a refund already under way (409) surface the router's code", async () => {
    for (const [E, code] of [[C.cancel.errors.nothing_to_cancel, NOTHING_TO_CANCEL], [C.cancel.errors.refund_in_progress, REFUND_IN_PROGRESS]] as const) {
      let calls = 0;
      const { c } = client({ "POST /api/v1/credits/close/cancel": () => { calls++; return json(E.body, E.status); } });
      const e = await c.cancelCreditClosureWith(await signerOf("wallet")).catch((x) => x);
      expect(e).toBeInstanceOf(TrellisError);
      expect([e.status, e.code, e.message]).toEqual([E.status, code, E.body.error.message]);
      expect(calls).toBe(1);
    }
  });

  test("releaseCreditClosure: an owner releases a closure held because its key was disabled, by the key's hash", async () => {
    const R = C.release;
    const bodies: unknown[] = [];
    const { c, calls } = client({ "POST /api/v1/credits/close/release": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: R.response }); } }, "an-owner-key");
    expect(await c.releaseCreditClosure(R.request.key)).toEqual(R.response);
    expect(bodies).toEqual([R.request]);
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer an-owner-key");
    // The hash names the key; the key itself (or anything else) is never posted in its place.
    for (const bad of ["sk-tr-v1-" + "0".repeat(64), R.request.key.toUpperCase(), R.request.key.slice(1), ""]) expect(() => c.releaseCreditClosure(bad)).toThrow(/key's hash/);
    expect(bodies.length).toBe(1);
    const none = client({ "POST /api/v1/credits/close/release": () => json(R.errors.not_found.body, R.errors.not_found.status) }, "an-owner-key");
    await expect(none.c.releaseCreditClosure(R.request.key)).rejects.toMatchObject({ status: 404, code: "not_found" });
    // What disabling the key answered: the closure it started is on hold, and this is the route that lets it go.
    expect(R.key_disabled_response.data.closure_held).toEqual({ id: R.response[0].id, reason: "key_disabled", release: "POST /api/v1/credits/close/release" });
  });

  test("setRefundDestinationWith: only the depositor's own wallet signs, and the API key is not in the transaction", async () => {
    const D = C.refund_destination;
    const wallet = await signerOf("wallet");
    const bodies: unknown[] = [];
    const { c } = client({ "POST /api/v1/credits/refund-destination-tx": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: D.response }); } });
    const out = await c.setRefundDestinationWith(wallet, D.request.refund_to);
    expect(bodies).toEqual([D.request]);
    expect(out.request).toEqual(D.response);
    expect(out.signed).toBe(D.signed_transaction);
    const unsigned = parseTransaction(D.response.transaction), after = parseTransaction(out.signed);
    expect(unsigned.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true);
    expect(unsigned.accountKeys.slice(0, unsigned.header.numRequiredSignatures)).toEqual(D.signers);
    expect(D.signers).toEqual([F.keys.wallet.address]);
    expect(unsigned.accountKeys).not.toContain(C.key_address);
    expect(base58Encode(after.signatures[0])).toBe(D.depositor_signature_base58);
    expect(bytesToBase64(after.message)).toBe(D.message_base64);
    expect((await c.refundDestinationTx({ depositor: D.request.depositor, refundTo: D.request.refund_to })).current_refund_to).toBe(D.response.current_refund_to);
    expect(bodies[1]).toEqual(D.request);
    // No other wallet can sign it, and a transaction that wants the key's signature too is not a destination change.
    await expect(signRefundDestination(D.response.transaction, await signerOf("refund-to"))).rejects.toThrow(/only the wallet that deposited/);
    await expect(signRefundDestination(C.response.transaction, wallet)).rejects.toThrow(/depositor alone/);
    // A wallet that never deposited to the key has nothing to move.
    const N = D.errors.not_found;
    const none = client({ "POST /api/v1/credits/refund-destination-tx": () => json(N.body, N.status) });
    await expect(none.c.refundDestinationTx({ depositor: N.request.depositor, refundTo: N.request.refund_to })).rejects.toMatchObject({ status: 404, code: "not_found", message: N.body.error.message });
  });

  test("creditClosures: who was paid, a held closure, a cancelled one", async () => {
    const L = C.list;
    const { c } = client({ "/api/v1/credits/close": () => json({ data: L.response }) });
    const rows = await c.creditClosures();
    expect(rows).toEqual(L.response);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["amount_units", "cancel_tx", "id", "paid_at", "pay_tx", "payable_at", "reason", "refund_to", "refunds", "register_tx", "released_at", "requested_at", "status"]);
      expect(L.statuses).toContain(r.status);
      if (r.reason !== null) expect(L.reasons).toContain(r.reason);
      for (const p of r.refunds) { expect(Object.keys(p).sort()).toEqual(["amount_units", "depositor", "owner", "reason", "refund_to", "status", "tx"]); expect(L.refund_statuses).toContain(p.status); }
    }
    expect(rows.filter(isClosureHeld).map((r) => r.id)).toEqual(["close_fixture_4"]);
    const byStatus = (st: string) => rows.filter((r) => r.status === st);
    expect(byStatus("cancelled").map((r) => [r.reason, typeof r.cancel_tx])).toEqual([["cancelled_on_chain", "string"]]);
    const [paid] = byStatus("paid");
    expect(paid.refund_to!.split(",")).toEqual(paid.refunds.map((p) => p.owner!));
    expect(paid.refunds.map((p) => p.depositor)).toEqual([F.keys.wallet.address, F.keys.second_depositor.address]);
    // Released closures are no longer held, whatever their reason says.
    expect(isClosureHeld({ status: "registered", reason: "key_disabled", released_at: "2026-09-24T15:13:20.000Z" })).toBe(false);
    expect(isClosureHeld({ status: "cancelled", reason: "key_disabled" })).toBe(false);
  });

  test("depositTx: the answer says where a closure refund of this deposit returns", async () => {
    const D = C.deposit;
    const bodies: unknown[] = [];
    const { c } = client({ "POST /api/v1/credits/deposit-tx": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: D.response }); } });
    const d = await c.depositTx(D.request.amount, D.request.payer);
    expect(bodies).toEqual([D.request]);
    expect(d).toEqual(D.response);
    expect(d.refund_to).toBe(d.accounts.depositorToken);
    expect(d.refund_to).toBe(C.response.refunds[0].refund_to);
    expect(d.accounts.share).toBe(C.refund_destination.response.accounts.share);
    expect(parseTransaction(d.transaction).accountKeys[0]).toBe(D.request.payer);
  });
});

describe("409 credits_closing: the key is frozen while its closure is paid", () => {
  const E = F.errors.credits_closing;
  test("a chat call, a streamed call and an API call all surface the router's code, once", async () => {
    let calls = 0;
    const { fetch } = stubFetch({
      "POST /api/v1/chat/completions": () => { calls++; return json(E.body, E.status); },
      "POST /api/v1/credits/deposit-tx": () => { calls++; return json(E.body, E.status); },
    });
    const c = new Trellis({ baseUrl: "https://router.example", apiKey: "frozen-key", fetch, verifyReceipts: false });
    const chat = await c.chat.completions.create({ model: "m", messages: [] }).catch((x) => x);
    expect(chat).toBeInstanceOf(TrellisError);
    expect([chat.status, chat.code, chat.message]).toEqual([409, CREDITS_CLOSING, E.body.error.message]);
    expect(chat.details).toEqual(E.body.error.metadata);
    expect(isCreditsClosing(chat)).toBe(true);
    const stream = await c.chat.completions.stream({ model: "m", messages: [] }).catch((x) => x);
    expect(isCreditsClosing(stream)).toBe(true);
    expect(isCreditsClosing(await c.depositTx("1", F.keys.wallet.address).catch((x) => x))).toBe(true);
    expect(calls).toBe(3); // each call was made once: a frozen key is not retried
    expect(isCreditsClosing(new TrellisError("x", "rate_limited", 429))).toBe(false);
  });

  test("a payer configured for per-call payments does not answer it with a payment", async () => {
    const wallet = await signerOf("wallet");
    let calls = 0;
    const { fetch } = stubFetch({ "POST /api/v1/chat/completions": () => { calls++; return json(E.body, E.status); } });
    const c = new Trellis({ baseUrl: "https://router.example", apiKey: "frozen-key", fetch, payer: { signer: wallet, recentBlockhash: F.x402.recent_blockhash } as never, verifyReceipts: false });
    expect(isCreditsClosing(await c.chat.completions.create({ model: "m", messages: [] }).catch((x) => x))).toBe(true);
    expect(calls).toBe(1);
  });
});

test("base58 helpers agree with the fixture's addresses", () => {
  for (const key of Object.values(F.keys) as { address?: string }[]) if (key && typeof key === "object" && key.address) expect(base58Encode(base58Decode(key.address))).toBe(key.address);
});
