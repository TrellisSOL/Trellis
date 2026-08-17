// Solana payments: encodings against @solana/web3.js as the reference (PDAs, legacy messages), the checks the router's
// inspectExactTransaction makes on an x402 payment, vouchers, headers, and the 402 -> X-PAYMENT retry on a stub fetch.
// Addresses are placeholders computed from repeated bytes; keypairs are derived from constant seeds. No network.
import { describe, expect, test } from "bun:test";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM, EMPTY_BODY_HASH, MAX_TAB_LIFETIME_SECONDS, OPEN_TAB_DISCRIMINATOR, RECLAIM_DISCRIMINATOR, SOLANA_DEVNET, SYSTEM_PROGRAM, TAB_ACCOUNT_DISCRIMINATOR, TOKEN_PROGRAM, TOP_UP_DISCRIMINATOR, USDC_MINT, VOUCHER_DOMAIN, VOUCHER_MESSAGE_LENGTH,
  REFUND_DESTINATION_FIXED, TabSession, Trellis, TrellisError, address, chatRequestHash, fetchTabAccount, parseVoucherMessage, reclaimInstruction, rulesConfigAddress, tabEnforcerAddress, walletAuthMessage, associatedTokenAddress, base58Decode, base58Encode, buildExactPayment, bytesToBase64, compileLegacyMessage, decodeTabAccount, findProgramAddress, generateSessionKey, isOnCurve, keypairSigner, openTabInstruction, openTabTransaction, parsePaymentRequired, parsePaymentResponse, parseTransaction, parseVoucherHeader, payPerCall, signTransaction, signVoucher, signerFromSeed, tabAddress, tabPdas, topUpInstruction, utf8, verifyVoucher, voucherMessage, walletAuthHeader, x402PaymentHeader,
  type ExactPayment, type Instruction, type X402Requirement,
} from "../src/index.js";
import { json, stubFetch } from "./helpers.js";

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const edVerifyRaw = (pub: Uint8Array, message: Uint8Array, sig: Uint8Array) => edVerify(null, message, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" }), sig);

const filled = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const payerKp = Keypair.fromSeed(new Uint8Array(32).fill(7));
const feePayerKp = Keypair.fromSeed(new Uint8Array(32).fill(9));
const payer = keypairSigner(payerKp.secretKey);
const PAY_TO = filled(3);
const PROGRAM = filled(5);
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(42));
const toIx = (ix: Instruction) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });
const le64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
/** "Now" for the tab expiry checks (a tab may live 30 days at most). */
const NOW = 1_799_999_000;

const requirement = (over: Partial<X402Requirement> = {}): X402Requirement => ({ scheme: "exact", network: SOLANA_DEVNET, maxAmountRequired: "12300", resource: "https://router.test/api/v1/chat/completions", description: "Pay-per-call inference", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC_MINT, extra: { feePayer: feePayerKp.publicKey.toBase58(), decimals: 6 }, ...over });

describe("base58 and curve", () => {
  test("round-trips and agrees with web3.js", () => {
    for (const n of [0, 1, 7, 255]) {
      const bytes = new Uint8Array(32).fill(n);
      expect(base58Encode(bytes)).toBe(new PublicKey(bytes).toBase58());
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58Decode("112")).toEqual(new Uint8Array([0, 0, 1]));
    expect(() => base58Decode("0OIl")).toThrow();
  });

  test("isOnCurve matches web3.js on random and real keys", () => {
    expect(isOnCurve(payerKp.publicKey.toBytes())).toBe(true);
    expect(isOnCurve(new PublicKey(SYSTEM_PROGRAM).toBytes())).toBe(PublicKey.isOnCurve(new PublicKey(SYSTEM_PROGRAM).toBytes()));
    for (let i = 0; i < 300; i++) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      expect(isOnCurve(b)).toBe(PublicKey.isOnCurve(b));
    }
  });

  test("program-derived addresses equal findProgramAddressSync", () => {
    for (let i = 0; i < 40; i++) {
      const seed = crypto.getRandomValues(new Uint8Array(1 + (i % 32)));
      const [ref, bump] = PublicKey.findProgramAddressSync([seed], new PublicKey(PROGRAM));
      const got = findProgramAddress([seed], PROGRAM);
      expect(got.address).toBe(ref.toBase58());
      expect(got.bump).toBe(bump);
    }
    const [ata] = PublicKey.findProgramAddressSync([new PublicKey(PAY_TO).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(USDC_MINT).toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM));
    expect(associatedTokenAddress(PAY_TO)).toBe(ata.toBase58());
  });
});

describe("signers", () => {
  test("keypairSigner uses the Keypair layout and signs verifiably", async () => {
    expect(address(payer.publicKey)).toBe(payerKp.publicKey.toBase58());
    const sig = await payer.sign(utf8("hello"));
    expect(sig.length).toBe(64);
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8("hello"), sig)).toBe(true);
    expect(keypairSigner(payerKp).publicKey).toEqual(payerKp.publicKey.toBytes());
    expect(() => keypairSigner(new Uint8Array(32))).toThrow(/64 bytes/);
  });

  test("signerFromSeed derives the public key; generateSessionKey is fresh and restorable", async () => {
    const s = await signerFromSeed(new Uint8Array(32).fill(7));
    expect(address(s.publicKey)).toBe(payerKp.publicKey.toBase58());
    const a = await generateSessionKey();
    const b = await generateSessionKey();
    expect(a.secretKey.length).toBe(64);
    expect(address(a.publicKey)).not.toBe(address(b.publicKey));
    expect(Keypair.fromSecretKey(a.secretKey).publicKey.toBytes()).toEqual(a.publicKey);
    const restored = keypairSigner(a.secretKey);
    const sig = await restored.sign(utf8("m"));
    expect(edVerifyRaw(a.publicKey, utf8("m"), sig)).toBe(true);
  });
});

describe("tabs", () => {
  const payee = filled(2);
  const session = Keypair.fromSeed(new Uint8Array(32).fill(11));
  const payerPk = payerKp.publicKey.toBase58();

  test("PDAs match web3.js", () => {
    const pid = new PublicKey(PROGRAM);
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
    const [tab] = PublicKey.findProgramAddressSync([Buffer.from("tab"), payerKp.publicKey.toBuffer(), new PublicKey(payee).toBuffer(), le64(77n)], pid);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), tab.toBuffer()], pid);
    const pdas = tabPdas(PROGRAM, payerPk, payee, 77n);
    expect(pdas).toMatchObject({ config: config.toBase58(), tab: tab.toBase58(), escrow: escrow.toBase58() });
    expect(tabAddress(PROGRAM, payerKp.publicKey, payee, 77)).toBe(tab.toBase58());
  });

  test("open_tab: discriminator, Borsh args and the program's account order", () => {
    const { instruction, tab, pdas, tabId } = openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 5_000_000n, expiry: 1_800_000_000n, sessionKey: session.publicKey, tabId: 77n, now: NOW });
    expect(tabId).toBe(77n);
    expect(instruction.programId).toBe(PROGRAM);
    expect(Buffer.from(instruction.data)).toEqual(Buffer.concat([Buffer.from(OPEN_TAB_DISCRIMINATOR), le64(77n), le64(5_000_000n), le64(1_800_000_000n), session.publicKey.toBuffer()]));
    expect(instruction.data.length).toBe(8 + 8 + 8 + 8 + 32);
    expect(instruction.keys).toEqual([
      { pubkey: payerPk, isSigner: true, isWritable: true },
      { pubkey: payee, isSigner: false, isWritable: false },
      { pubkey: pdas.config, isSigner: false, isWritable: false },
      { pubkey: tab, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: pdas.escrow, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(payerPk), isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: false }, // no rulebook: Anchor's None is the program id
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PROGRAM, isSigner: false, isWritable: false }, // no rules config
      { pubkey: PROGRAM, isSigner: false, isWritable: false }, // no rules program
      { pubkey: tabEnforcerAddress(PROGRAM), isSigner: false, isWritable: false },
    ]);
    // A rulebook-bound tab names the rulebook (writable: its daily total is updated), the rules config and the rules program.
    const rules = { rulebook: filled(8), rulesProgram: filled(6) };
    const withRules = openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 1, expiry: 1_800_000_000n, sessionKey: session.publicKey, tabId: 1, rulebook: rules, now: NOW });
    expect(withRules.instruction.keys[7]).toEqual({ pubkey: filled(8), isSigner: false, isWritable: true });
    expect(withRules.instruction.keys.slice(10).map((k) => k.pubkey)).toEqual([rulesConfigAddress(filled(6)), filled(6), tabEnforcerAddress(PROGRAM)]);
    expect(rulesConfigAddress(filled(6))).toBe(PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(filled(6)))[0].toBase58());
    expect(tabEnforcerAddress(PROGRAM)).toBe(PublicKey.findProgramAddressSync([Buffer.from("enforcer")], new PublicKey(PROGRAM))[0].toBase58());
    expect(() => openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 0, expiry: 1_800_000_000n, sessionKey: session.publicKey, now: NOW })).toThrow(/cap/);
    // The program bounds a tab's life: an expiry in the past or more than 30 days out is refused before a wallet is asked to sign.
    expect(() => openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 1, expiry: NOW - 1, sessionKey: session.publicKey, now: NOW })).toThrow(/past/);
    expect(() => openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 1, expiry: NOW + MAX_TAB_LIFETIME_SECONDS + 1, sessionKey: session.publicKey, now: NOW })).toThrow(/30 days/);
    expect(openTabInstruction({ programId: PROGRAM, payer: payerPk, payee, cap: 1, expiry: NOW + MAX_TAB_LIFETIME_SECONDS, sessionKey: session.publicKey, now: NOW }).instruction.keys).toHaveLength(13);
  });

  test("openTabTransaction serializes exactly what web3.js compiles, and the payer can sign it", async () => {
    const built = openTabTransaction({ programId: PROGRAM, payer: payerPk, payee, cap: 5_000_000n, expiry: 1_800_000_000n, sessionKey: session.publicKey, tabId: 77n, recentBlockhash: BLOCKHASH, now: NOW });
    const ref = new TransactionMessage({ payerKey: payerKp.publicKey, recentBlockhash: BLOCKHASH, instructions: [toIx(built.instruction)] }).compileToLegacyMessage();
    expect(Buffer.from(built.message)).toEqual(Buffer.from(ref.serialize()));
    const legacy = Transaction.from(Buffer.from(built.transaction, "base64"));
    expect(legacy.feePayer?.toBase58()).toBe(payerPk);
    expect(legacy.instructions).toHaveLength(1);
    expect(legacy.instructions[0].programId.toBase58()).toBe(PROGRAM);
    expect(legacy.signatures[0].signature).toBeNull();
    const signed = Transaction.from(Buffer.from(await signTransaction(built.transaction, payer), "base64"));
    expect(signed.verifySignatures()).toBe(true);
    await expect(signTransaction(built.transaction, keypairSigner(feePayerKp.secretKey))).rejects.toThrow(/not a required signer/);
  });

  test("top_up instruction", () => {
    const tab = tabAddress(PROGRAM, payerPk, payee, 77n);
    const ix = topUpInstruction({ programId: PROGRAM, payer: payerPk, tab, amount: 250_000 });
    expect(Buffer.from(ix.data)).toEqual(Buffer.concat([Buffer.from(TOP_UP_DISCRIMINATOR), le64(250_000n)]));
    expect(ix.keys.map((k) => k.pubkey)).toEqual([payerPk, tabPdas(PROGRAM, payerPk, payee, 77n).config, tab, USDC_MINT, tabPdas(PROGRAM, payerPk, payee, 77n).escrow, associatedTokenAddress(payerPk), TOKEN_PROGRAM, PROGRAM, PROGRAM, PROGRAM, tabEnforcerAddress(PROGRAM)]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[true, false], [false, false], [false, true], [false, false], [false, true], [false, true], [false, false], [false, false], [false, false], [false, false], [false, false]]);
    // A rulebook-bound tab tops up under its rulebook.
    const bound = topUpInstruction({ programId: PROGRAM, payer: payerPk, tab, amount: 250_000, rulebook: { rulebook: filled(8), rulesProgram: filled(6) } });
    expect(bound.keys.slice(7)).toEqual([{ pubkey: filled(8), isSigner: false, isWritable: true }, { pubkey: rulesConfigAddress(filled(6)), isSigner: false, isWritable: false }, { pubkey: filled(6), isSigner: false, isWritable: false }, { pubkey: tabEnforcerAddress(PROGRAM), isSigner: false, isWritable: false }]);
  });

  test("reclaim needs nobody's signature and no rulebook", () => {
    const tab = tabAddress(PROGRAM, payerPk, payee, 77n);
    const ix = reclaimInstruction({ programId: PROGRAM, payer: payerPk, payee, tab });
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(RECLAIM_DISCRIMINATOR));
    expect(ix.keys.some((k) => k.isSigner)).toBe(false);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([payerPk, tab, tabPdas(PROGRAM, payerPk, payee, 77n).config, USDC_MINT, tabPdas(PROGRAM, payerPk, payee, 77n).escrow, associatedTokenAddress(payerPk), associatedTokenAddress(payee), TOKEN_PROGRAM]);
  });

  test("decodeTabAccount reads the Anchor layout", () => {
    const bytes = Buffer.concat([Buffer.from(TAB_ACCOUNT_DISCRIMINATOR), payerKp.publicKey.toBuffer(), new PublicKey(payee).toBuffer(), session.publicKey.toBuffer(), new PublicKey(USDC_MINT).toBuffer(), le64(77n), le64(5_000_000n), le64(120n), le64(3n), le64(1_800_000_000n), le64(1_700_000_000n), Buffer.from([1]), new PublicKey(filled(8)).toBuffer(), Buffer.from([254, 253])]);
    expect(decodeTabAccount(bytes)).toEqual({ payer: payerPk, payee, sessionKey: session.publicKey.toBase58(), mint: USDC_MINT, tabId: 77n, cap: 5_000_000n, postedUsed: 120n, postedSeq: 3n, expiry: 1_800_000_000n, createdAt: 1_700_000_000n, rulebook: filled(8), bump: 254, escrowBump: 253 });
    const none = Buffer.concat([bytes.subarray(0, 184), Buffer.from([0, 255, 255])]);
    expect(decodeTabAccount(none.toString("base64"))?.rulebook).toBeNull();
    expect(decodeTabAccount(new Uint8Array(300))).toBeNull();
  });

  test("vouchers: the 110-byte domain-separated message, session-key signature, headers and wire form", async () => {
    const tab = tabAddress(PROGRAM, payerPk, payee, 77n);
    const key = keypairSigner(session.secretKey);
    const CREATED_AT = 1_799_990_000n;
    const scope = { programId: PROGRAM, createdAt: CREATED_AT };
    const s = new TabSession({ tab, ...scope, sessionKey: key, cap: 5_000_000n });
    const v1 = await s.voucher(1_500);
    expect(v1.seq).toBe(1n);
    expect(v1.message.length).toBe(VOUCHER_MESSAGE_LENGTH);
    expect(VOUCHER_MESSAGE_LENGTH).toBe(110);
    expect(Buffer.from(v1.message)).toEqual(Buffer.concat([Buffer.from(VOUCHER_DOMAIN), new PublicKey(PROGRAM).toBuffer(), new PublicKey(tab).toBuffer(), le64(CREATED_AT), le64(1_500n), le64(1n)]));
    expect(edVerifyRaw(session.publicKey.toBytes(), v1.message, v1.signature)).toBe(true);
    expect(v1.headers["X-Trellis-Tab"]).toBe(tab);
    expect(v1.headers["X-Trellis-Tab-Voucher"]).toBe(`${bytesToBase64(v1.message)}.${bytesToBase64(v1.signature)}`);
    expect(v1.wire).toEqual({ tab, cumulative_used: "1500", seq: "1", signature: base58Encode(v1.signature), session_key: session.publicKey.toBase58() });
    expect(await verifyVoucher(v1, scope)).toBe(true);
    expect(await verifyVoucher(v1.wire, scope)).toBe(true);
    expect(await verifyVoucher(v1.headers["X-Trellis-Tab-Voucher"], scope, session.publicKey)).toBe(true);
    expect(await verifyVoucher(v1.headers["X-Trellis-Tab-Voucher"], scope, payerKp.publicKey)).toBe(false);
    expect(await verifyVoucher({ ...v1.wire, cumulative_used: "1501" }, scope)).toBe(false);
    // The verifier's scope decides: the same voucher is nothing for another program or another opening of the tab.
    expect(await verifyVoucher(v1, { programId: filled(6), createdAt: CREATED_AT })).toBe(false);
    expect(await verifyVoucher(v1.wire, { programId: PROGRAM, createdAt: CREATED_AT + 1n })).toBe(false);
    expect(parseVoucherHeader(v1.headers["X-Trellis-Tab-Voucher"])).toMatchObject({ tab, programId: PROGRAM, createdAt: CREATED_AT, cumulativeUsed: 1_500n, seq: 1n });
    expect(parseVoucherMessage(v1.message)).toEqual({ programId: PROGRAM, tab, createdAt: CREATED_AT, cumulativeUsed: 1_500n, seq: 1n });
    // The retired 48-byte form is not a voucher message.
    expect(() => parseVoucherMessage(Buffer.concat([new PublicKey(tab).toBuffer(), le64(1_500n), le64(1n)]))).toThrow(/retired/);
    const v2 = await s.add(500);
    expect([v2.seq, v2.cumulativeUsed]).toEqual([2n, 2_000n]);
    expect(s.state).toEqual({ tab, programId: PROGRAM, createdAt: CREATED_AT, seq: 2n, cumulativeUsed: 2_000n, cap: 5_000_000n });
    await expect(s.voucher(1_999)).rejects.toThrow(/below/);
    await expect(s.voucher(5_000_001)).rejects.toThrow(/cap/);
    const resumed = new TabSession({ ...s.state, sessionKey: key });
    expect((await resumed.voucher(2_000)).seq).toBe(3n);
    expect(voucherMessage({ tab, cumulativeUsed: 0n, seq: 0n }, scope).subarray(94)).toEqual(new Uint8Array(16));
    expect((await signVoucher(key, { tab, cumulativeUsed: 1n, seq: 9n }, scope)).wire.seq).toBe("9");
    // Without the program id and created_at there is nothing to sign for.
    expect(() => new TabSession({ tab, sessionKey: key } as never)).toThrow(/created_at/);
  });

  test("TabSession.open reads created_at, the cap and the posted counters from the tab account", async () => {
    const tab = tabAddress(PROGRAM, payerPk, payee, 77n);
    const key = keypairSigner(session.secretKey);
    const data = Buffer.concat([Buffer.from(TAB_ACCOUNT_DISCRIMINATOR), payerKp.publicKey.toBuffer(), new PublicKey(payee).toBuffer(), session.publicKey.toBuffer(), new PublicKey(USDC_MINT).toBuffer(), le64(77n), le64(5_000_000n), le64(120n), le64(3n), le64(1_800_000_000n), le64(1_799_990_000n), Buffer.from([0, 254, 253])]);
    const calls: unknown[] = [];
    const rpc = (async (_url: unknown, init?: { body?: unknown }) => { const req = JSON.parse(String(init?.body)); calls.push(req); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: req.params[0] === tab ? { data: [data.toString("base64"), "base64"] } : null } })); }) as never;
    expect((await fetchTabAccount(tab, { rpcUrl: "https://rpc.test", fetch: rpc }))?.createdAt).toBe(1_799_990_000n);
    expect(await fetchTabAccount(filled(4), { rpcUrl: "https://rpc.test", fetch: rpc })).toBeNull();
    const opened = await TabSession.open({ tab, programId: PROGRAM, sessionKey: key, rpcUrl: "https://rpc.test", fetch: rpc });
    expect(opened.state).toEqual({ tab, programId: PROGRAM, createdAt: 1_799_990_000n, seq: 3n, cumulativeUsed: 120n, cap: 5_000_000n });
    expect((calls[0] as { method: string }).method).toBe("getAccountInfo");
    await expect(TabSession.open({ tab: filled(4), programId: PROGRAM, sessionKey: key, rpcUrl: "https://rpc.test", fetch: rpc })).rejects.toMatchObject({ code: "tab_not_found" });
    await expect(TabSession.open({ tab, programId: PROGRAM, sessionKey: payer, rpcUrl: "https://rpc.test", fetch: rpc })).rejects.toThrow(/session key/);
  });
});

describe("x402 exact", () => {
  test("parsePaymentRequired reads the v1 body, or the v2 PAYMENT-REQUIRED header", async () => {
    const req = requirement();
    const body = { x402Version: 1, error: "Payment required", accepts: [req], price_usdc: "0.0123", model: "example/model" };
    const v2 = { x402Version: 2, error: "Payment required", resource: { url: req.resource, description: req.description, mimeType: "application/json" }, accepts: [{ scheme: "exact", network: req.network, amount: req.maxAmountRequired, asset: req.asset, payTo: req.payTo, maxTimeoutSeconds: 60, extra: req.extra }] };
    const header = Buffer.from(JSON.stringify(v2)).toString("base64");
    const fromBody = await parsePaymentRequired(json(body, 402, { "payment-required": header }));
    expect(fromBody).toEqual({ x402Version: 1, error: "Payment required", accepts: [req], priceUsdc: "0.0123", model: "example/model", paymentError: undefined });
    const fromHeader = await parsePaymentRequired(new Response("", { status: 402, headers: { "payment-required": header } }));
    expect(fromHeader?.x402Version).toBe(2);
    expect(fromHeader?.accepts[0]).toEqual(req);
    expect(await parsePaymentRequired(json({ error: { message: "no" } }, 402))).toBeNull();
    const rejected = await parsePaymentRequired({ headers: new Headers() }, { ...body, payment_error: "payment_already_claimed" });
    expect(rejected?.paymentError).toBe("payment_already_claimed");
  });

  test("buildExactPayment passes every check inspectExactTransaction makes", async () => {
    const req = requirement();
    let asked = 0;
    const connection = { getLatestBlockhash: async () => (asked++, { blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) };
    const p = await buildExactPayment({ requirement: req, signer: payer, connection });
    expect(asked).toBe(1);
    expect(p.amount).toBe(12_300n);
    expect(p.feePayer).toBe(feePayerKp.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    const msg = tx.message;
    expect(msg.addressTableLookups).toHaveLength(0);
    const keys = msg.staticAccountKeys;
    expect(keys[0].toBase58()).toBe(req.extra!.feePayer!);
    const transfers = msg.compiledInstructions.filter((ix) => keys[ix.programIdIndex].toBase58() === TOKEN_PROGRAM);
    expect(msg.compiledInstructions).toHaveLength(1);
    expect(transfers).toHaveLength(1);
    const [ix] = transfers;
    expect(ix.data.length).toBe(10);
    expect(ix.data[0]).toBe(12);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true)).toBe(12_300n);
    expect(ix.data[9]).toBe(6);
    const [source, mint, dest, owner] = ix.accountKeyIndexes.map((i) => keys[i].toBase58());
    expect(source).toBe(associatedTokenAddress(payerKp.publicKey));
    expect(mint).toBe(USDC_MINT);
    expect(dest).toBe(associatedTokenAddress(PAY_TO));
    expect(owner).toBe(payerKp.publicKey.toBase58());
    expect(msg.isAccountWritable(ix.accountKeyIndexes[0])).toBe(true);
    expect(msg.isAccountWritable(ix.accountKeyIndexes[2])).toBe(true);
    // The payer signed at an index >= 1; the fee payer slot is empty.
    const n = msg.header.numRequiredSignatures;
    const payerIndex = keys.findIndex((k) => k.equals(payerKp.publicKey));
    expect(payerIndex).toBeGreaterThanOrEqual(1);
    expect(payerIndex).toBeLessThan(n);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true);
    for (let i = 1; i < n; i++) expect(edVerifyRaw(keys[i].toBytes(), msg.serialize(), tx.signatures[i])).toBe(true);
    expect(msg.recentBlockhash).toBe(BLOCKHASH);
    // Same bytes as web3.js compiles for the same instructions and fee payer.
    const ref = new TransactionMessage({ payerKey: feePayerKp.publicKey, recentBlockhash: BLOCKHASH, instructions: [toIx(compileLegacyMessageInput(req).instructions[0])] }).compileToLegacyMessage();
    expect(Buffer.from(p.message)).toEqual(Buffer.from(ref.serialize()));
  });

  function compileLegacyMessageInput(req: X402Requirement) {
    return { instructions: [{ programId: TOKEN_PROGRAM, keys: [{ pubkey: associatedTokenAddress(payerKp.publicKey), isSigner: false, isWritable: true }, { pubkey: req.asset, isSigner: false, isWritable: false }, { pubkey: associatedTokenAddress(req.payTo), isSigner: false, isWritable: true }, { pubkey: payerKp.publicKey.toBase58(), isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([12]), le64(BigInt(req.maxAmountRequired)), Buffer.from([6])]) }] };
  }

  test("createDestinationAta adds one idempotent ATA creation for payTo, funded by the payer", async () => {
    const p = await buildExactPayment({ requirement: requirement(), signer: payer, recentBlockhash: BLOCKHASH, createDestinationAta: true, amount: 20_000n });
    const tx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    const [create, transfer] = tx.message.compiledInstructions;
    expect(keys[create.programIdIndex].toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM);
    expect([...create.data]).toEqual([1]);
    expect(create.accountKeyIndexes.map((i) => keys[i].toBase58())).toEqual([payerKp.publicKey.toBase58(), associatedTokenAddress(PAY_TO), PAY_TO, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM]);
    expect(keys[transfer.programIdIndex].toBase58()).toBe(TOKEN_PROGRAM);
    expect(new DataView(transfer.data.buffer, transfer.data.byteOffset).getBigUint64(1, true)).toBe(20_000n);
    expect(keys[0].equals(feePayerKp.publicKey)).toBe(true);
    const payerIndex = keys.findIndex((k) => k.equals(payerKp.publicKey));
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), tx.message.serialize(), tx.signatures[payerIndex])).toBe(true);
    const ref = new TransactionMessage({ payerKey: feePayerKp.publicKey, recentBlockhash: BLOCKHASH, instructions: tx.message.compiledInstructions.map((ix) => new TransactionInstruction({ programId: keys[ix.programIdIndex], keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys[i], isSigner: tx.message.isAccountSigner(i), isWritable: tx.message.isAccountWritable(i) })), data: Buffer.from(ix.data) })) }).compileToLegacyMessage();
    expect(Buffer.from(p.message)).toEqual(Buffer.from(ref.serialize()));
  });

  test("refuses when there is no fee payer, the scheme or network is foreign, or the amount is short", async () => {
    await expect(buildExactPayment({ requirement: requirement({ extra: { feePayer: null, decimals: 6 } }), signer: payer, recentBlockhash: BLOCKHASH })).rejects.toThrow(/fee payer/);
    await expect(buildExactPayment({ requirement: requirement({ scheme: "tab" }), signer: payer, recentBlockhash: BLOCKHASH })).rejects.toThrow(/scheme/);
    await expect(buildExactPayment({ requirement: requirement({ network: "eip155:8453" }), signer: payer, recentBlockhash: BLOCKHASH })).rejects.toThrow(/network/);
    await expect(buildExactPayment({ requirement: requirement(), signer: payer, recentBlockhash: BLOCKHASH, amount: 1n })).rejects.toThrow(/below/);
    await expect(buildExactPayment({ requirement: requirement(), signer: payer })).rejects.toThrow(/rpcUrl/);
  });

  test("latestBlockhash over JSON-RPC when only rpcUrl is given", async () => {
    const { fetch, calls } = stubFetch({ "POST /": () => json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 2 } } }) });
    const p = await buildExactPayment({ requirement: requirement(), signer: payer, rpcUrl: "https://rpc.test/", fetch });
    expect(p.recentBlockhash).toBe(BLOCKHASH);
    expect(JSON.parse(String(calls[0].init!.body)).method).toBe("getLatestBlockhash");
  });

  test("x402PaymentHeader and parsePaymentResponse", () => {
    const h = x402PaymentHeader({ network: SOLANA_DEVNET, transaction: "AQID" });
    expect(JSON.parse(Buffer.from(h, "base64").toString())).toEqual({ x402Version: 1, scheme: "exact", network: SOLANA_DEVNET, payload: { transaction: "AQID" } });
    const r = parsePaymentResponse(new Headers({ "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "5xyz", network: SOLANA_DEVNET, payer: PAY_TO })).toString("base64") }));
    expect(r).toEqual({ success: true, transaction: "5xyz", network: SOLANA_DEVNET, payer: PAY_TO });
    expect(parsePaymentResponse(new Headers())).toBeNull();
  });

  /** A router stub: 402 without X-PAYMENT, 200 with a well-formed one (the same checks as inspectExactTransaction). */
  function paidRouter(price = "12300") {
    const req = requirement({ maxAmountRequired: price });
    const chat: { headers: Record<string, string>; body: string }[] = [];
    const stub = stubFetch({
      "POST /api/v1/chat/completions": ({ init }) => {
        const headers = (init!.headers ?? {}) as Record<string, string>;
        chat.push({ headers, body: String(init!.body) });
        const pay = headers["x-payment"];
        if (!pay) return json({ x402Version: 1, error: "Payment required", accepts: [req], price_usdc: "0.0123", model: "example/model" }, 402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: {}, accepts: [] })).toString("base64") });
        const j = JSON.parse(Buffer.from(pay, "base64").toString());
        const tx = VersionedTransaction.deserialize(Buffer.from(j.payload.transaction, "base64"));
        const keys = tx.message.staticAccountKeys;
        const ok = j.x402Version === 1 && j.scheme === "exact" && j.network === req.network && keys[0].equals(feePayerKp.publicKey) && tx.message.compiledInstructions.length === 1 && tx.message.compiledInstructions[0].data.length === 10;
        if (!ok) return json({ x402Version: 1, error: "Payment rejected", accepts: [req], payment_error: "invalid_exact_svm_payload_transaction" }, 402);
        const payerIndex = keys.findIndex((k) => k.equals(payerKp.publicKey));
        if (!edVerifyRaw(payerKp.publicKey.toBytes(), tx.message.serialize(), tx.signatures[payerIndex])) return json({ x402Version: 1, error: "bad signature", accepts: [req], payment_error: "invalid_exact_svm_payload_transaction_payer_signature" }, 402);
        return json({ id: "gen-paid", choices: [{ message: { role: "assistant", content: "paid" } }] }, 200, { "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "5sig", network: req.network, payer: payerKp.publicKey.toBase58() })).toString("base64"), "x-generation-id": "gen-paid" });
      },
    });
    return { ...stub, chat, req };
  }

  test("payPerCall answers a 402 once with X-PAYMENT and the same body", async () => {
    const r = paidRouter();
    const payments: bigint[] = [];
    const f = payPerCall(r.fetch, payer, { recentBlockhash: BLOCKHASH, onPayment: (p: ExactPayment) => payments.push(p.amount) } as any);
    const res = await f("https://router.test/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "example/model" }) });
    expect(res.status).toBe(200);
    expect(r.chat).toHaveLength(2);
    expect(r.chat[0].headers["x-payment"]).toBeUndefined();
    expect(r.chat[1].body).toBe(r.chat[0].body);
    expect(r.chat[1].headers["content-type"]).toBe("application/json");
    expect(payments).toEqual([12_300n]);
    expect(parsePaymentResponse(res.headers)?.transaction).toBe("5sig");
    // A second 402 (the payment was rejected) is returned, not paid again.
    const strict = payPerCall(async (input, init) => { const res = await r.fetch(input, init); return res.status === 200 ? json({ x402Version: 1, error: "rejected", accepts: [r.req], payment_error: "payment_already_claimed" }, 402) : res; }, payer, { recentBlockhash: BLOCKHASH } as any);
    const again = await strict("https://router.test/api/v1/chat/completions", { method: "POST", body: "{}" });
    expect(again.status).toBe(402);
    expect((await parsePaymentRequired(again))?.paymentError).toBe("payment_already_claimed");
  });

  test("payPerCall leaves other answers alone and honours maxAmount", async () => {
    const r = paidRouter("2000000");
    const f = payPerCall(r.fetch, payer, { recentBlockhash: BLOCKHASH, maxAmount: 1_000_000n } as any);
    await expect(f("https://router.test/api/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "payment_too_large", status: 402 });
    expect(r.chat).toHaveLength(1);
    const plain = payPerCall(stubFetch({ "GET /x": () => json({ ok: 1 }) }).fetch, payer, {});
    expect((await plain("https://router.test/x")).status).toBe(200);
    expect((await plain("https://router.test/missing")).status).toBe(404);
  });

  test("Trellis({ payer }) pays for chat and reports the settlement", async () => {
    const r = paidRouter();
    const c = new Trellis({ baseUrl: "https://router.test", fetch: r.fetch, payer: { signer: payer, recentBlockhash: BLOCKHASH } as any, verifyReceipts: false });
    const out = await c.chat.completions.create({ model: "example/model", messages: [] });
    expect((out.choices?.[0] as any).message.content).toBe("paid");
    expect(out.trellis.payment).toEqual({ success: true, transaction: "5sig", network: SOLANA_DEVNET, payer: payerKp.publicKey.toBase58() });
    expect(r.chat).toHaveLength(2);
    expect(r.chat[0].headers.authorization).toBeUndefined();
  });
});

describe("wallet auth and credits", () => {
  test("walletAuthHeader signs the v2 message: method, host, path, time and the hash the route binds", async () => {
    const body = { poll_id: "p1", option: "yes" };
    const h = await walletAuthHeader(payer, { method: "post", url: "https://Router.Test/api/v1/holders/polls/p1/vote?x=1", json: body, now: 1_760_000_000 });
    const [addr, ts, sig] = h.split(":");
    expect(h.split(":")).toHaveLength(3);
    expect(addr).toBe(payerKp.publicKey.toBase58());
    expect(ts).toBe("1760000000");
    const sha = Buffer.from(await crypto.subtle.digest("SHA-256", utf8('{"option":"yes","poll_id":"p1"}') as unknown as BufferSource)).toString("hex");
    const message = `trellis:wallet-auth:v2\nPOST\nrouter.test\n/api/v1/holders/polls/p1/vote?x=1\n1760000000\n${sha}`;
    expect(walletAuthMessage({ method: "post", host: "Router.Test", path: "/api/v1/holders/polls/p1/vote?x=1", timestamp: 1_760_000_000, sha256: sha })).toBe(message);
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(message), base58Decode(sig))).toBe(true);
    // The retired v1 text is not what was signed, and neither is the same request on another route, method or host.
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(`trellis:1760000000:${sha}`), base58Decode(sig))).toBe(false);
    for (const other of [message.replace("POST", "PUT"), message.replace("router.test", "other.test"), message.replace("/vote?x=1", "/vote")]) expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(other), base58Decode(sig))).toBe(false);
    // host + path instead of a url; a body-less request hashes the empty string.
    const get = await walletAuthHeader(payer, { method: "GET", host: "router.test:8443", path: "/api/v1/refunds", now: 1_760_000_000 });
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(`trellis:wallet-auth:v2\nGET\nrouter.test:8443\n/api/v1/refunds\n1760000000\n${EMPTY_BODY_HASH}`), base58Decode(get.split(":")[2]))).toBe(true);
    await expect(walletAuthHeader(payer, { method: "GET" })).rejects.toThrow(/url/);
    expect(() => walletAuthMessage({ method: "GET", host: "router.test", path: "/a\nb", timestamp: 1, sha256: EMPTY_BODY_HASH })).toThrow(/line breaks/);
  });

  test("Trellis({ walletAuth }) signs each chat request for its method, host, path and request hash", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const { fetch } = stubFetch({ "POST /api/v1/chat/completions": ({ init }) => { seen = { headers: init!.headers as Record<string, string>, body: String(init!.body) }; return json({ id: "g", choices: [] }); } });
    const c = new Trellis({ baseUrl: "https://router.test", fetch, walletAuth: payer, verifyReceipts: false });
    await c.chat.completions.create({ model: "example/model", messages: [], temperature: 0.5 });
    const h = seen!.headers["x-wallet-auth"];
    const [addr, ts, sig] = h.split(":");
    expect(addr).toBe(payerKp.publicKey.toBase58());
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    // The router hashes the canonical JSON of the body it received, without stream and stream_options.
    const sha = chatRequestHash(JSON.parse(seen!.body));
    expect(chatRequestHash({ ...JSON.parse(seen!.body), stream: true, stream_options: { include_usage: true } })).toBe(sha);
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(`trellis:wallet-auth:v2\nPOST\nrouter.test\n/api/v1/chat/completions\n${ts}\n${sha}`), base58Decode(sig))).toBe(true);
    expect(seen!.headers.authorization).toBeUndefined();
    // A client that reaches the router under another name signs for the router's public host.
    const proxied = new Trellis({ baseUrl: "https://router.test", fetch, walletAuth: payer, walletAuthHost: "public.router.example", verifyReceipts: false });
    await proxied.chat.completions.create({ model: "example/model", messages: [] });
    const [, ts2, sig2] = seen!.headers["x-wallet-auth"].split(":");
    expect(edVerifyRaw(payerKp.publicKey.toBytes(), utf8(`trellis:wallet-auth:v2\nPOST\npublic.router.example\n/api/v1/chat/completions\n${ts2}\n${chatRequestHash(JSON.parse(seen!.body))}`), base58Decode(sig2))).toBe(true);
  });

  test("depositTx, closeCredits and creditClosures call the credits routes with the key", async () => {
    const unsigned = new Transaction({ feePayer: payerKp.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: new PublicKey(PAY_TO), lamports: 1 })).serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const bodies: unknown[] = [];
    const me = payerKp.publicKey.toBase58();
    const { fetch, calls } = stubFetch({
      "POST /api/v1/credits/deposit-tx": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: { transaction: unsigned, message: "Deposit 12.5 USDC", network: SOLANA_DEVNET, amount_usdc: "12.5", amount_units: "12500000", accounts: { vault: PAY_TO, share: PAY_TO }, refund_to: PAY_TO, expires_at_block_height: 99, key_hash: "0xabab", note: "n" } }); },
      "POST /api/v1/credits/close": ({ init }) => { bodies.push(JSON.parse(String(init!.body))); return json({ data: { id: "close_1", status: "queued", payer: me, authority: me, payable_at: "2026-10-13T00:00:00.000Z", transaction: unsigned, message: "Close", accounts: {}, expires_at_block_height: 99, signed_by_key: true, refunds: [{ depositor: me, refund_to: PAY_TO, deposited_units: "12500000", refunded_units: "0" }], note: "n" } }, 201); },
      "/api/v1/credits/close": () => json({ data: [{ id: "close_1", status: "queued", reason: null, refund_to: null, refunds: [], payable_at: "2026-10-13T00:00:00.000Z" }] }),
    });
    const c = new Trellis({ baseUrl: "https://router.test", apiKey: "sk-test", fetch });
    const d = await c.depositTx("12.5", me);
    expect(d.amount_units).toBe("12500000");
    expect(d.refund_to).toBe(PAY_TO); // where a closure refund of this deposit returns
    expect(bodies[0]).toEqual({ amount: "12.5", payer: me });
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    // The wallet signs what the router built.
    const signed = Transaction.from(Buffer.from(await signTransaction(d.transaction, payer), "base64"));
    expect(signed.verifySignatures()).toBe(true);
    expect(parseTransaction(d.transaction).accountKeys[0]).toBe(me);
    // A closure is asked for with the payer and nothing else: no destination is sent.
    const close = await c.closeCredits({ payer: me });
    expect(close.status).toBe("queued");
    expect(bodies[1]).toEqual({ payer: me });
    expect(close.refunds).toEqual([{ depositor: me, refund_to: PAY_TO, deposited_units: "12500000", refunded_units: "0" }]);
    expect((await c.creditClosures())[0].id).toBe("close_1");
    // The older call shapes named a destination. They throw before anything is sent, and say where refunds go.
    const sent = bodies.length;
    for (const call of [
      () => (c.closeCredits as unknown as (...a: unknown[]) => Promise<unknown>)(PAY_TO),
      () => (c.closeCredits as unknown as (...a: unknown[]) => Promise<unknown>)(PAY_TO, { payer: me }),
      () => (c.closeCredits as unknown as (...a: unknown[]) => Promise<unknown>)({ payer: me, refund_to: PAY_TO }),
      () => (c.closeCredits as unknown as (...a: unknown[]) => Promise<unknown>)({ payer: me, refundTo: PAY_TO }),
      () => (c.closeCreditsWith as unknown as (...a: unknown[]) => Promise<unknown>).call(c, payer, PAY_TO),
    ]) {
      const e = (await Promise.resolve().then(call).catch((x) => x)) as TrellisError;
      expect(e).toBeInstanceOf(TrellisError);
      expect(e.code).toBe(REFUND_DESTINATION_FIXED);
      expect(e.message).toMatch(/returns to the wallets that funded the key/);
    }
    expect(() => (c.closeCredits as unknown as (...a: unknown[]) => unknown)({})).toThrow(/needs \{ payer \}/);
    expect(() => (c.closeCredits as unknown as (...a: unknown[]) => unknown)()).toThrow(/needs \{ payer \}/);
    expect(bodies.length).toBe(sent);
    const failing = new Trellis({ baseUrl: "https://router.test", apiKey: "sk-test", fetch: stubFetch({ "POST /api/v1/credits/deposit-tx": () => json({ error: { message: "above the cap", type: "deposit_refused" } }, 400) }).fetch });
    await expect(failing.depositTx("1", PAY_TO)).rejects.toMatchObject({ code: "deposit_refused", status: 400 });
  });
});

test("the solana module imports without @solana/web3.js at runtime", async () => {
  // The module resolves its own encodings; the reference library is only a test dependency here.
  const mod = await import("../src/solana.js");
  expect(typeof mod.buildExactPayment).toBe("function");
  expect(Object.keys(mod)).not.toContain("PublicKey");
});
