import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { BadRequestError, CreditsClosingError, NOTHING_TO_CANCEL, REFUND_DESTINATION_FIXED, REFUND_IN_PROGRESS, Trellis, TrellisAPIError, TrellisError, NotFoundError, RateLimitError, TAB_ACCOUNT_DISCRIMINATOR, USDC_MINT, isCreditsClosing, keypairSigner, parseRetryAfter, parseTransaction, parseVoucherHeader, signerFromSeed, supportsLane, tabAddress, verifyReceiptV2, type Receipt } from "../src/index.js";
import { BLOCKHASH, CONTRACTS, FEE_PAYER, HOLDER_TIER, JWKS, KEY_SIGNER, NETWORK, PAY_TO, TAB_PROGRAM, V2, startFakeRouter } from "./fake-router.js";

let router: ReturnType<typeof startFakeRouter>;
let client: Trellis;
const noSleep = async () => {};

beforeAll(() => {
  router = startFakeRouter();
  client = new Trellis({ apiKey: "test-key", baseUrl: `${router.url}/api/v1`, sleep: noSleep });
});
afterAll(() => router.stop());
const last = (path: string) => [...router.seen].reverse().find((s) => s.path.startsWith(path))!;

describe("chat", () => {
  test("non-stream: verifies receipt v1 and v2, surfaces lane and receipt id", async () => {
    const r = await client.chat.completions.create({ model: "example/model", messages: [{ role: "user", content: "hi" }] }, { lane: "attested" });
    expect((r.choices?.[0] as any).message.content).toBe("Hello");
    expect(r.trellis.lane).toBe("attested");
    expect(r.trellis.generationId).toBe(V2.claims.rid);
    expect(r.trellis.receiptVerification?.valid).toBe(true);
    expect(r.trellis.receiptV2Verification?.valid).toBe(true);
    const sent = last("/api/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer test-key");
    expect(sent.headers.get("x-trellis-lane")).toBe("attested");
    expect(sent.body.provider.lane).toBe("attested");
  });

  test("a lane option never loosens a stricter lane already in the body", async () => {
    const pub = client.withLane("public");
    await pub.chat.completions.create({ model: "example/model", messages: [], provider: { lane: "attested" } });
    expect(last("/api/v1/chat/completions").body.provider.lane).toBe("attested");
  });

  test("stream: chunks, receipt, and the chunk chain verify", async () => {
    const s = await client.chat.completions.stream({ model: "example/model", messages: [{ role: "user", content: "hi" }] });
    let text = "";
    for await (const c of s) text += ((c as any).choices?.[0]?.delta?.content as string) ?? "";
    expect(text).toBe("Hello");
    const meta = await s.meta();
    expect(meta.receipt?.id).toBe(V2.claims.rid);
    expect(meta.receiptVerification?.valid).toBe(true);
    const chain = await s.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.head).toBe(V2.claims.resp.chain);
  });

  test("stream: an altered chunk breaks the chain at that event", async () => {
    router.state.tamperStream = true;
    try {
      const s = await client.chat.completions.stream({ model: "example/model", messages: [] });
      for await (const _ of s);
      const chain = await s.verifyChain();
      expect(chain.ok).toBe(false);
      expect(chain.firstMismatch).toBe(2);
    } finally {
      router.state.tamperStream = false;
    }
  });
});

describe("errors and retries", () => {
  test("429 is retried after Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const c = new Trellis({ apiKey: "k", baseUrl: router.url, sleep: async (ms) => void waits.push(ms) });
    router.state.rateLimitLeft = 1;
    const r = await c.chat.completions.create({ model: "example/model", messages: [] });
    expect(r.id).toBe(V2.claims.rid);
    expect(waits).toEqual([7000]);
  });

  test("429 without retries left throws RateLimitError with retryAfter", async () => {
    const c = new Trellis({ apiKey: "k", baseUrl: router.url, maxRetries: 0 });
    router.state.rateLimitLeft = 1;
    const e = await c.chat.completions.create({ model: "example/model", messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).toBeInstanceOf(TrellisAPIError);
    expect(e.status).toBe(429);
    expect(e.type).toBe("rate_limited");
    expect(e.retryAfter).toBe(7);
  });

  test("404 envelope becomes NotFoundError with the router's type", async () => {
    const e = await client.presets.get("nope").catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.type).toBe("preset_not_found");
  });

  test("parseRetryAfter reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(Date.parse("2026-09-30T12:00:10Z")).toUTCString(), Date.parse("2026-09-30T12:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("embeddings and rerank", () => {
  test("embeddings carry the receipt and lane", async () => {
    const r = await client.embeddings.create({ model: "example/embed", input: "hello" }, { lane: "attested" });
    expect(r.data[0].embedding).toEqual([0.1, 0.2]);
    expect(r.trellis.receiptId).toBe("gen-emb-1");
    expect(r.trellis.lane).toBe("attested");
  });

  test("rerank returns results best first", async () => {
    const r = await client.rerank.create({ model: "example/rerank", query: "cats", documents: ["dogs", "cats are great", "fish"], top_n: 2 });
    expect(r.results[0].index).toBe(1);
    expect(r.results).toHaveLength(2);
    expect(r.usage?.search_units).toBe(1);
    expect(r.trellis.receipt?.id).toBe("gen-rr-1");
  });
});

describe("batches", () => {
  test("create, wait, results", async () => {
    const b = await client.batches.create({ requests: [
      { custom_id: "q1", method: "POST", url: "/v1/chat/completions", body: { model: "example/model", messages: [{ role: "user", content: "2+2?" }] } },
      { custom_id: "q2", method: "POST", url: "/v1/chat/completions", body: { model: "missing/model", messages: [{ role: "user", content: "hi" }] } },
    ] });
    expect(b.status).toBe("validating");
    const polls: string[] = [];
    const { batch, ok, failed, byCustomId } = await client.batches.results(b.id, { pollIntervalMs: 1, onPoll: (x: any) => polls.push(x.status) } as any);
    expect(batch.status).toBe("completed");
    expect(batch.cost.discount_bps).toBe(5000);
    expect(ok[0].response?.body.choices[0].message.content).toBe("4");
    expect(failed[0].error?.code).toBe("model_not_found");
    expect(byCustomId.get("q1")?.response?.status_code).toBe(200);
    expect((await client.batches.list({ limit: 5 })).data).toHaveLength(1);
    expect(last("/api/v1/batches?").path).toBe("/api/v1/batches?limit=5");
    expect((await client.batches.cancel(b.id)).status).toBe("cancelling");
  });
});

describe("presets", () => {
  test("put, get, versions, diff, rollback, delete", async () => {
    const a = await client.presets.put("support-bot", { models: ["example/model"], system_prompt: "Be brief." });
    expect(a.changed).toBe(true);
    expect(a.model).toBe("@preset/support-bot");
    const same = await client.presets.put("support-bot", { models: ["example/model"], system_prompt: "Be brief." });
    expect(same.changed).toBe(false);
    await client.presets.put("support-bot", { models: ["example/open"], system_prompt: "Be brief." });
    expect((await client.presets.get("support-bot")).latest_version).toBe(2);
    expect((await client.presets.list()).map((p) => p.name)).toEqual(["support-bot"]);
    expect((await client.presets.versions("support-bot"))[0].version).toBe(2);
    expect((await client.presets.diff("support-bot", 1, 2)).identical).toBe(false);
    const back = await client.presets.rollback("support-bot", 1);
    expect(back.restored_from).toBe(1);
    expect(back.config.models).toEqual(["example/model"]);
    expect(client.presets.model("support-bot", 3)).toBe("@preset/support-bot@3");
    expect((await client.presets.delete("support-bot")).deleted).toBe(true);
  });
});

describe("models", () => {
  test("filters by lane and output modality", async () => {
    expect((await client.models.list()).length).toBe(3);
    const attested = await client.models.list({ lane: "attested" });
    expect(attested.map((m) => m.id)).toEqual(["example/model"]);
    expect(attested[0].attestation?.best).toBe("attested");
    expect(supportsLane(attested[0], "unlinkable")).toBe(false);
    expect((await client.models.list({ outputModalities: "rerank" })).map((m) => m.id)).toEqual(["example/rerank"]);
  });
});

describe("holder tiers", () => {
  test("tiers, me, polls and poll return the router's data", async () => {
    const tiers = await client.holders.tiers();
    expect(tiers.enabled).toBe(true);
    expect(tiers.token?.program).toBe("token-2022");
    expect(tiers.tiers).toEqual([HOLDER_TIER]);
    const me = await client.holders.me();
    expect(last("/api/v1/holders/me").headers.get("authorization")).toBe("Bearer test-key");
    expect([me.tier?.name, me.next_tier?.remaining, me.perks.limits.rpm, me.perks.vote_weight]).toEqual(["Seed", "75000", 120, 1]);
    expect((await client.holders.polls()).map((p) => p.status)).toEqual(["open", "closed"]);
    expect((await client.holders.polls({ status: "closed" })).map((p) => p.id)).toEqual(["poll_done1"]);
    const poll = await client.holders.poll("poll_open1");
    expect([poll.advisory, poll.results.final, poll.options.length]).toEqual([true, false, 2]);
    await expect(client.holders.poll("poll_nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("vote signs the canonical body with the wallet, sends no key, and is sent once", async () => {
    const wallet = keypairSigner(Keypair.fromSeed(new Uint8Array(32).fill(21)).secretKey);
    const vote = await client.holders.vote("poll_open1", "example/one", wallet);
    expect(vote).toEqual({ poll_id: "poll_open1", option: "example/one", tier: "Seed", weight: 1, voted_at: "2026-10-12T12:00:00.000Z" });
    const sent = last("/api/v1/holders/polls/poll_open1/vote");
    expect(sent.body).toEqual({ option: "example/one", poll_id: "poll_open1" });
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("x-wallet-auth")!.split(":")).toHaveLength(3);
    expect((await client.holders.poll("poll_open1")).results.total_votes).toBe(1);

    const before = router.seen.length;
    const again = await client.holders.vote("poll_open1", "example/two", wallet).catch((e) => e);
    expect(again).toBeInstanceOf(TrellisAPIError);
    expect([again.status, again.type]).toEqual([409, "already_voted"]);
    expect(router.seen.length - before).toBe(1); // a signature is single use: a refused vote is not retried
    const closed = await client.holders.vote("poll_done1", "example/one", wallet).catch((e) => e);
    expect([closed.status, closed.type]).toEqual([409, "poll_closed"]);
  });

  test("a model in early access carries its times, and a call before then is a 403 early_access", async () => {
    const open = (await client.models.list()).find((m) => m.id === "example/open")!;
    expect(open.early_access).toEqual({ until: "2026-10-14T12:00:00.000Z", your_access_at: "2026-10-14T00:00:00.000Z" });
    const e = await client.chat.completions.create({ model: "early/model", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(e).toBeInstanceOf(TrellisAPIError);
    expect([e.status, e.type, e.retryAfter]).toEqual([403, "early_access", 3600]);
    expect(e.details).toEqual({ model: "early/model", opens_at: "2026-10-14T12:00:00.000Z", early_access_until: "2026-10-14T12:00:00.000Z", tier: null });
  });
});

describe("receipts", () => {
  test("get + verify v1 and v2, and fetchAndVerify with the proof", async () => {
    const r = await client.receipts.get("gen-xyz");
    expect(r.version).toBe(2);
    const v = await client.receipts.verify(r);
    expect(v.valid).toBe(true);
    expect(v.v1?.valid).toBe(true);
    expect(v.v2?.valid).toBe(true);
    const f = await client.receipts.fetchAndVerify("gen-xyz");
    expect(f.valid).toBe(true);
    expect(f.v2?.anchor).toBe("proof_valid");
  });

  test("v2 with the streamed chunks checks the chain head", async () => {
    const v = await verifyReceiptV2(V2.cose, { keys: JWKS as any, chunks: V2.chunks });
    expect(v.valid).toBe(true);
    expect(v.checks.find((c) => c.id === "chain")?.status).toBe("pass");
  });

  test("a tampered v1 payload or v2 signature fails", async () => {
    const r = await client.receipts.get("gen-xyz");
    const badV1: Receipt = { ...r, payload: { ...r.payload, tokens_out: 999 } };
    expect((await client.receipts.verify(badV1)).valid).toBe(false);
    const bytes = Buffer.from(V2.cose, "base64");
    bytes[bytes.length - 1] ^= 1;
    const badV2: Receipt = { ...r, v2: { ...r.v2!, cose: bytes.toString("base64") } };
    const v = await client.receipts.verify(badV2);
    expect(v.valid).toBe(false);
    expect(v.v1?.valid).toBe(true);
    expect(v.v2?.checks.find((c) => c.id === "signature")?.status).toBe("fail");
  });
});

describe("solana payments", () => {
  // A payer wallet from a constant seed: a placeholder, not a real wallet.
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const signer = keypairSigner(wallet.secretKey);
  const connection = { getLatestBlockhash: async () => ({ blockhash: BLOCKHASH }) };

  test("a keyless call is paid per call: 402 -> X-PAYMENT -> 200 with the settlement", async () => {
    const paying = new Trellis({ apiKey: "", baseUrl: router.url, payer: { signer, connection }, sleep: noSleep });
    const before = router.seen.length;
    const r = await paying.chat.completions.create({ model: "example/model", messages: [{ role: "user", content: "hi" }] });
    expect((r.choices?.[0] as any).message.content).toBe("Paid");
    expect(r.trellis.payment).toEqual({ success: true, transaction: "sig1", network: NETWORK, payer: wallet.publicKey.toBase58() });
    expect(r.trellis.receiptVerification?.valid).toBe(true);
    const chats = router.seen.slice(before).filter((s) => s.path === "/api/v1/chat/completions");
    expect(chats).toHaveLength(2);
    expect(chats[0].headers.get("x-payment")).toBeNull();
    expect(chats[0].headers.get("authorization")).toBeNull();
    expect(chats[1].headers.get("x-payment")).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(chats[1].body).toEqual(chats[0].body);
    expect(router.state.payments.at(-1)).toEqual({ payer: wallet.publicKey.toBase58(), amount: 12300n });
  });

  test("without a payer, a keyless call throws the 402 as TrellisAPIError", async () => {
    const keyless = new Trellis({ apiKey: "", baseUrl: router.url, sleep: noSleep });
    const e = await keyless.chat.completions.create({ model: "example/model", messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(TrellisAPIError);
    expect(e.status).toBe(402);
    expect(e.message).toContain("USDC");
  });

  test("payer.maxAmount refuses a call priced above it before paying", async () => {
    const capped = new Trellis({ apiKey: "", baseUrl: router.url, payer: { signer, connection, maxAmount: 100n }, sleep: noSleep });
    const n = router.state.payments.length;
    const e = await capped.chat.completions.create({ model: "example/model", messages: [] }).catch((x) => x);
    expect(e.code).toBe("payment_too_large");
    expect(router.state.payments).toHaveLength(n);
  });

  test("credits.depositTx returns an unsigned transaction the wallet can sign; close and closures", async () => {
    const d = await client.credits.depositTx("12.5", wallet.publicKey.toBase58());
    expect(d.amount_units).toBe("12500000");
    expect(d.network).toBe(NETWORK);
    expect(last("/api/v1/credits/deposit-tx").body).toEqual({ amount: "12.5", payer: wallet.publicKey.toBase58() });
    expect(last("/api/v1/credits/deposit-tx").headers.get("authorization")).toBe("Bearer test-key");
    const signed = Transaction.from(Buffer.from(await client.tabs.signTransaction(d.transaction, signer), "base64"));
    expect(signed.feePayer?.equals(wallet.publicKey)).toBe(true);
    expect(signed.verifySignatures()).toBe(true);
    const refused = await client.credits.depositTx("5000", wallet.publicKey.toBase58()).catch((x) => x);
    expect(refused).toBeInstanceOf(TrellisAPIError);
    expect(refused.type).toBe("deposit_refused");
  });

  test("credits.close: only the payer is sent; the transaction arrives signed by the key and the answer says who is paid back", async () => {
    const me = wallet.publicKey.toBase58();
    const d = await client.credits.depositTx("12.5", me);
    expect(d.refund_to).toBe(d.accounts.depositorToken); // a closure refund of this deposit returns to the account it was paid from
    const { closure, signed } = await client.credits.closeWith(signer);
    expect(closure).toMatchObject({ status: "queued", payer: me, signed_by_key: true });
    expect(last("/api/v1/credits/close").body).toEqual({ payer: me });
    expect(last("/api/v1/credits/close").headers.get("authorization")).toBe("Bearer test-key");
    expect(closure.refunds).toEqual([{ depositor: me, refund_to: d.refund_to!, deposited_units: "12500000", refunded_units: "0" }]);
    expect("refund_to" in closure).toBe(false);
    const before = parseTransaction(closure.transaction!), after = parseTransaction(signed!);
    expect(before.accountKeys.slice(0, 2)).toEqual([me, KEY_SIGNER.publicKey.toBase58()]);
    expect(before.signatures[0].every((b) => b === 0)).toBe(true);
    expect(after.signatures[1]).toEqual(before.signatures[1]); // the key's signature, as issued
    expect(Transaction.from(Buffer.from(signed!, "base64")).verifySignatures()).toBe(true);
    // A wallet that is not the fee payer cannot finish it.
    await expect(client.credits.signClosure(closure.transaction!, keypairSigner(FEE_PAYER.secretKey))).rejects.toThrow(/fee payer/);
    // Already registered: nothing left to sign.
    const again = await client.credits.closeWith(signer);
    expect([again.closure.transaction, again.signed]).toEqual([null, null]);
    expect(again.closure.refunds).toEqual(closure.refunds);
    const rows = await client.credits.closures();
    expect(rows.map((x) => [x.id, x.status, x.refund_to])).toEqual([["close_1", "queued", null]]);
    expect(client.credits.isHeld(rows[0])).toBe(false);
  });

  test("credits.close: a call that names a destination throws before it is sent, and says where refunds go", async () => {
    const me = wallet.publicKey.toBase58();
    const loose = client.credits as unknown as Record<"close" | "closeWith" | "cancelClose" | "cancelCloseWith", (...a: unknown[]) => Promise<unknown>>;
    const before = router.seen.length;
    for (const call of [
      () => loose.close(PAY_TO),
      () => loose.close(PAY_TO, { payer: me }),
      () => loose.close({ payer: me, refund_to: PAY_TO }),
      () => loose.close({ payer: me, refundTo: PAY_TO }),
      () => loose.closeWith(signer, PAY_TO),
      () => loose.closeWith(signer, { refund_to: PAY_TO }),
      () => loose.cancelClose({ payer: me, refund_to: PAY_TO }),
      () => loose.cancelCloseWith(signer, PAY_TO),
    ]) {
      const e = (await Promise.resolve().then(call).catch((x) => x)) as TrellisError;
      expect(e).toBeInstanceOf(TrellisError);
      expect(e.code).toBe(REFUND_DESTINATION_FIXED);
      expect(e.message).toMatch(/returns to the wallets that funded the key/);
    }
    for (const call of [() => loose.close({}), () => loose.close(), () => loose.cancelClose({})]) expect(((await Promise.resolve().then(call).catch((x) => x)) as TrellisError).message).toMatch(/needs \{ payer \}/);
    expect(router.seen.length).toBe(before);
    // A request that reaches the router with a destination anyway is refused there with the same code (the fixture's envelope).
    const R = CONTRACTS.closure.refused_with_refund_to;
    const raw = await fetch(`${router.url}/api/v1/credits/close`, { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body: JSON.stringify(R.request) });
    expect([raw.status, await raw.json()]).toEqual([R.status, R.body]);
    expect(R.body.error.type).toBe(REFUND_DESTINATION_FIXED);
  });

  test("credits.close against the router's own fixture: the signed transaction is byte for byte the router's", async () => {
    const C = CONTRACTS.closure;
    const fixtureWallet = await signerFromSeed(new Uint8Array(createHash("sha256").update(CONTRACTS.keys.seed_prefix + "wallet").digest()));
    const { closure, signed } = await client.credits.closeWith(fixtureWallet);
    expect(last("/api/v1/credits/close").body).toEqual(C.request);
    expect(closure.transaction).toBe(C.response.transaction);
    expect(signed).toBe(C.signed_transaction);
    expect(closure.refunds).toEqual(C.response.refunds);
    expect(closure.accounts).toEqual(C.response.accounts);
  });

  test("credits.cancelClose: the cancellation arrives signed by the key; against the fixture it is byte for byte the router's", async () => {
    const K = CONTRACTS.closure.cancel;
    const fixtureWallet = await signerFromSeed(new Uint8Array(createHash("sha256").update(CONTRACTS.keys.seed_prefix + "wallet").digest()));
    const { cancel, signed } = await client.credits.cancelCloseWith(fixtureWallet);
    expect(last("/api/v1/credits/close/cancel").body).toEqual(K.request);
    expect(last("/api/v1/credits/close/cancel").headers.get("authorization")).toBe("Bearer test-key");
    expect(cancel).toEqual(K.response);
    expect(signed).toBe(K.signed_transaction);
    expect(parseTransaction(signed).signatures[K.key_signature_index]).toEqual(parseTransaction(K.response.transaction).signatures[K.key_signature_index]);
    await expect(client.credits.signCancel(K.response.transaction, keypairSigner(FEE_PAYER.secretKey))).rejects.toThrow(/fee payer/);
    // The open closure of the earlier test is taken back by its payer: the key is open again and can close anew.
    const mine = await client.credits.cancelCloseWith(signer);
    expect(last("/api/v1/credits/close/cancel").body).toEqual({ payer: wallet.publicKey.toBase58() });
    expect(Transaction.from(Buffer.from(mine.signed, "base64")).verifySignatures()).toBe(true);
    expect((await client.credits.closures()).map((x) => [x.id, x.status, x.reason])).toEqual([["close_1", "cancelled", "cancelled_on_chain"]]);
  });

  test("credits.cancelClose: nothing to cancel is a 400; a refund under way is a 409 that is thrown once, never retried", async () => {
    const E = CONTRACTS.closure.cancel.errors;
    const me = wallet.publicKey.toBase58();
    let before = router.seen.length;
    const none = await client.credits.cancelClose({ payer: me }).catch((x) => x);
    expect(none).toBeInstanceOf(BadRequestError);
    expect([none.status, none.type, none.message]).toEqual([400, NOTHING_TO_CANCEL, E.nothing_to_cancel.body.error.message]);
    expect(router.seen.length - before).toBe(1);
    await client.credits.close({ payer: me });
    router.state.refundStarted = true;
    try {
      before = router.seen.length;
      const late = await client.credits.cancelClose({ payer: me }).catch((x) => x);
      expect(late).toBeInstanceOf(TrellisAPIError);
      expect([late.status, late.type, late.message]).toEqual([409, REFUND_IN_PROGRESS, E.refund_in_progress.body.error.message]);
      expect(router.seen.length - before).toBe(1); // 409 is otherwise retried; this one cannot pass
    } finally { router.state.refundStarted = false; }
  });

  test("credits.releaseClose: an owner releases a held closure by the key's hash, never by the key", async () => {
    const R = CONTRACTS.closure.release;
    // The closure opened in the previous test is on hold because its key was disabled.
    Object.assign(router.state.closures[0], { status: "registered", reason: "key_disabled" });
    const held = await client.credits.closures();
    expect(held.filter(client.credits.isHeld).map((x) => x.id)).toEqual(["close_2"]);
    const before = router.seen.length;
    for (const bad of ["test-key", "sk-tr-v1-" + "0".repeat(64), R.request.key.toUpperCase(), ""]) await expect(client.credits.releaseClose(bad)).rejects.toThrow(/key's hash/);
    expect(router.seen.length).toBe(before);
    expect(await client.credits.releaseClose(R.request.key)).toEqual([{ id: "close_2", status: "registered", released: true, payable_at: "2026-10-13T12:00:00.000Z" }]);
    expect(last("/api/v1/credits/close/release").body).toEqual(R.request);
    const after = await client.credits.closures();
    expect(after.filter(client.credits.isHeld)).toEqual([]);
    expect(typeof after[0].released_at).toBe("string");
    // With no open closure left: the fixture's own answer for its key, and 404 for any other.
    Object.assign(router.state.closures[0], { status: "paid" });
    expect(await client.credits.releaseClose(R.request.key)).toEqual(R.response);
    const none = await client.credits.releaseClose("ab".repeat(32)).catch((x) => x);
    expect(none).toBeInstanceOf(NotFoundError);
    expect(none.message).toBe(R.errors.not_found.body.error.message);
  });

  test("credits.refundDestinationTx: only the depositor's own wallet signs; against the fixture it is byte for byte the router's", async () => {
    const D = CONTRACTS.closure.refund_destination;
    const fixtureWallet = await signerFromSeed(new Uint8Array(createHash("sha256").update(CONTRACTS.keys.seed_prefix + "wallet").digest()));
    const { request, signed } = await client.credits.setRefundDestinationWith(fixtureWallet, D.request.refund_to);
    expect(last("/api/v1/credits/refund-destination-tx").body).toEqual(D.request);
    expect(request).toEqual(D.response);
    expect(signed).toBe(D.signed_transaction);
    const t = parseTransaction(D.response.transaction);
    expect(t.accountKeys.slice(0, t.header.numRequiredSignatures)).toEqual(D.signers);
    expect(t.accountKeys).not.toContain(CONTRACTS.closure.key_address); // the API key has no part in it
    await expect(client.credits.signRefundDestination(D.response.transaction, signer)).rejects.toThrow(/only the wallet that deposited/);
    await expect(client.credits.signRefundDestination(CONTRACTS.closure.response.transaction, fixtureWallet)).rejects.toThrow(/depositor alone/);
    // A wallet that deposited moves its own destination; a closure then names the new account for it.
    const me = wallet.publicKey.toBase58();
    const moved = await client.credits.refundDestinationTx(me, PAY_TO);
    expect(last("/api/v1/credits/refund-destination-tx").body).toEqual({ depositor: me, refund_to: PAY_TO });
    expect([moved.depositor, moved.refund_to, moved.current_refund_to, moved.accounts.refundToToken]).toEqual([me, PAY_TO, me, PAY_TO]);
    expect((await client.credits.close({ payer: me })).refunds).toEqual([{ depositor: me, refund_to: PAY_TO, deposited_units: "12500000", refunded_units: "0" }]);
    // A wallet that never deposited to the key has nothing to move.
    const stranger = await client.credits.refundDestinationTx(FEE_PAYER.publicKey.toBase58(), PAY_TO).catch((x) => x);
    expect(stranger).toBeInstanceOf(NotFoundError);
    expect(stranger.message).toBe(D.errors.not_found.body.error.message);
  });

  test("a key whose credits are being closed is frozen: 409 credits_closing is thrown once, never retried", async () => {
    router.state.frozen = true;
    try {
      const before = router.seen.length;
      const e = await client.chat.completions.create({ model: "example/model", messages: [{ role: "user", content: "hi" }] }).catch((x) => x);
      expect(e).toBeInstanceOf(CreditsClosingError);
      expect([e.status, e.type, e.message]).toEqual([409, "credits_closing", CONTRACTS.errors.credits_closing.body.error.message]);
      expect(e.closure).toBe(CONTRACTS.errors.credits_closing.body.error.metadata.closure);
      expect(isCreditsClosing(e)).toBe(true);
      expect(router.seen.length - before).toBe(1); // 409 is otherwise retried; this one is final
      const stream = await client.chat.completions.stream({ model: "example/model", messages: [] }).catch((x: unknown) => x);
      expect(stream).toBeInstanceOf(CreditsClosingError);
      expect(await client.embeddings.create({ model: "example/embed", input: "x" }).catch((x) => x)).toBeInstanceOf(CreditsClosingError);
      expect(router.seen.length - before).toBe(3);
    } finally { router.state.frozen = false; }
  });

  test("tabs: program id from the facilitator, open_tab for the wallet to sign, vouchers per request", async () => {
    expect(await client.tabs.programId()).toBe(TAB_PROGRAM);
    const sessionKey = await client.tabs.generateSessionKey();
    const NOW = 1_799_999_000, CREATED_AT = 1_799_999_005n;
    const opened = await client.tabs.open({ payer: wallet.publicKey.toBase58(), payee: PAY_TO, cap: 5_000_000n, expiry: 1_800_000_000n, sessionKey: sessionKey.publicKey, tabId: 1n, recentBlockhash: BLOCKHASH, now: NOW });
    // A tab lives 30 days at most: the program refuses a later expiry, so the SDK does before a wallet is asked to sign.
    await expect(client.tabs.open({ payer: wallet.publicKey.toBase58(), payee: PAY_TO, cap: 1n, expiry: NOW + 31 * 86_400, sessionKey: sessionKey.publicKey, recentBlockhash: BLOCKHASH, now: NOW })).rejects.toThrow(/30 days/);
    expect(opened.tab).toBe(tabAddress(TAB_PROGRAM, wallet.publicKey, PAY_TO, 1n));
    const tx = Transaction.from(Buffer.from(opened.transaction, "base64"));
    expect(tx.feePayer?.equals(wallet.publicKey)).toBe(true);
    expect(tx.instructions[0].programId.equals(new PublicKey(TAB_PROGRAM))).toBe(true);
    expect(tx.instructions[0].keys[3].pubkey.toBase58()).toBe(opened.tab);
    expect(Transaction.from(Buffer.from(await client.tabs.signTransaction(opened.transaction, signer), "base64")).verifySignatures()).toBe(true);
    // Once open_tab has landed, the session reads the tab's created_at (and cap) from the cluster: vouchers are signed
    // for the tab program and for this opening of the tab.
    const le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
    const account = Buffer.concat([Buffer.from(TAB_ACCOUNT_DISCRIMINATOR), wallet.publicKey.toBuffer(), new PublicKey(PAY_TO).toBuffer(), Buffer.from(sessionKey.publicKey), new PublicKey(USDC_MINT).toBuffer(), le(1n), le(5_000_000n), le(0n), le(0n), le(1_800_000_000n), le(CREATED_AT), Buffer.from([0, 255, 254])]);
    const rpc = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: { value: { data: [account.toString("base64"), "base64"] } } })) as never;
    expect((await client.tabs.account(opened.tab, { rpcUrl: "https://rpc.test", fetch: rpc }))?.createdAt).toBe(CREATED_AT);
    const session = await client.tabs.resume({ tab: opened.tab, sessionKey, rpcUrl: "https://rpc.test", fetch: rpc });
    expect(session.state).toMatchObject({ programId: TAB_PROGRAM, createdAt: CREATED_AT, cap: 5_000_000n, seq: 0n });
    const scope = { programId: TAB_PROGRAM, createdAt: CREATED_AT };
    const v = await session.voucher(2_500);
    expect(v.headers["X-Trellis-Tab"]).toBe(opened.tab);
    expect(v.message).toHaveLength(110);
    expect(parseVoucherHeader(v.headers["X-Trellis-Tab-Voucher"])).toMatchObject({ tab: opened.tab, programId: TAB_PROGRAM, createdAt: CREATED_AT, cumulativeUsed: 2500n, seq: 1n });
    expect(await client.tabs.verifyVoucher(v.wire, scope)).toBe(true);
    expect(await client.tabs.verifyVoucher(v.headers["X-Trellis-Tab-Voucher"], scope, FEE_PAYER.publicKey)).toBe(false);
    // The same voucher is nothing for the tab address opened again later, or for another deployment of the program.
    expect(await client.tabs.verifyVoucher(v.wire, { programId: TAB_PROGRAM, createdAt: CREATED_AT + 60n })).toBe(false);
    expect(await client.tabs.verifyVoucher(v.wire, { programId: PAY_TO, createdAt: CREATED_AT })).toBe(false);
    expect(client.tabs.session({ tab: opened.tab, ...scope, sessionKey, cap: 5_000_000n }).state.createdAt).toBe(CREATED_AT);
    expect(client.tabs.reclaim({ programId: TAB_PROGRAM, payer: wallet.publicKey.toBase58(), payee: PAY_TO, tab: opened.tab }).keys.some((k) => k.isSigner)).toBe(false);
    // The headers ride on an ordinary request.
    await client.chat.completions.create({ model: "example/model", messages: [] }, { headers: v.headers });
    expect(last("/api/v1/chat/completions").headers.get("x-trellis-tab-voucher")).toBe(v.headers["X-Trellis-Tab-Voucher"]);
  });
});

test("reads TRELLIS_API_KEY and TRELLIS_BASE_URL from the environment", async () => {
  const before = { k: process.env.TRELLIS_API_KEY, u: process.env.TRELLIS_BASE_URL };
  process.env.TRELLIS_API_KEY = "env-key";
  process.env.TRELLIS_BASE_URL = `${router.url}/v1/`;
  try {
    const c = new Trellis({ sleep: noSleep });
    expect(c.baseUrl).toBe(router.url);
    await c.models.list();
    expect(last("/api/v1/models").headers.get("authorization")).toBe("Bearer env-key");
  } finally {
    process.env.TRELLIS_API_KEY = before.k;
    process.env.TRELLIS_BASE_URL = before.u;
    if (before.k === undefined) delete process.env.TRELLIS_API_KEY;
    if (before.u === undefined) delete process.env.TRELLIS_BASE_URL;
  }
});
