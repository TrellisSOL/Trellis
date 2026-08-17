import { describe, expect, test } from "bun:test";
import { canonicalBytes, fetchReceiptKeys, hexToBytes, parseKeySet, sha256Sync, receiptLeaf, verifyMerkleProof, verifyReceipt, verifySidecarReceipt, type BoundIdentity, type ReceiptEnvelope } from "../src/index.js";
import { MEMO_PROGRAM, anchorerKeysProblem, fetchAnchorKeys, jsonRpc, rootMemoLine, verifyHostAnchor, verifyPostedRoot, type AnchorerKey, type HostAnchorProof, type PostedAnchorProof, type SolanaRpc } from "../src/index.js";
import * as clientApi from "../src/index.js";
import { base58Encode, compileLegacyMessage, serializeTransaction, signerFromSeed, type Instruction, type KeypairSigner } from "../src/solana.js";
import { evaluateAttestation } from "../src/index.js";
import { HAS_REAL_EVIDENCE, json, makeRouterKey, real, signReceipt, stubFetch } from "./helpers.js";

const ok = (v: { checks: { id: string; status: string }[] }, id: string) => v.checks.find((c) => c.id === id)?.status;

describe.skipIf(!HAS_REAL_EVIDENCE)("a real receipt from a TDX deployment", () => {
  const boundKey = () => real.boot().bindings.receipt_pubkey as string;

  test("verifies under the receipt key the quote commits to, and its leaf recomputes", async () => {
    const v = await verifyReceipt(real.receipt(), { publicKeyHex: boundKey() });
    expect(v.valid).toBe(true);
    expect(ok(v, "signature")).toBe("pass");
    expect(ok(v, "key")).toBe("pass");
    expect(ok(v, "leaf")).toBe("pass");
    // No anchor proof came with it, and the report says so instead of implying inclusion.
    expect(v.anchor).toBe("no_proof");
    expect(ok(v, "anchor_proof")).toBe("not_checked");
    expect(v.notChecked.join(" ")).toMatch(/on chain/);
  });

  test("fails when any signed field is changed", async () => {
    for (const change of [{ status: 500 }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { model_digest: "sha256:" + "0".repeat(64) }, { extra: true }]) {
      const r = real.receipt();
      const v = await verifyReceipt({ ...r, payload: { ...r.payload, ...change } }, { publicKeyHex: boundKey() });
      expect(v.valid).toBe(false);
      expect(ok(v, "signature")).toBe("fail");
    }
  });

  test("fails under a different key, a different key id or a broken signature", async () => {
    const other = makeRouterKey();
    expect((await verifyReceipt(real.receipt(), { publicKeyHex: Buffer.from(other.raw).toString("hex") })).valid).toBe(false);
    expect((await verifyReceipt({ ...real.receipt(), key_id: "0000000000000000" }, { publicKeyHex: boundKey() })).valid).toBe(false);
    const bad = Buffer.from(real.receipt().sig, "base64");
    bad[3] ^= 1;
    expect((await verifyReceipt({ ...real.receipt(), sig: bad.toString("base64") }, { publicKeyHex: boundKey() })).valid).toBe(false);
    expect((await verifyReceipt({ ...real.receipt(), leaf: "0x" + "11".repeat(32) }, { publicKeyHex: boundKey() })).valid).toBe(false);
  });

  test("verifySidecarReceipt also ties the receipt to the verified attestation", async () => {
    const result = await evaluateAttestation({ providerId: "example-provider", router: real.router(), boot: real.boot(), certificate: real.certPem() }, { now: () => real.now });
    const bound = result.bound as BoundIdentity;
    const v = await verifySidecarReceipt(real.receipt(), bound);
    expect(v.valid).toBe(true);
    expect(ok(v, "sidecar.attestation_ref")).toBe("pass");
    expect(ok(v, "sidecar.model_digest")).toBe("pass");
    // Same signature, but the attestation the client verified is a different one: refuse.
    const v2 = await verifySidecarReceipt(real.receipt(), { ...bound, attestationRef: "ab".repeat(32) });
    expect(v2.valid).toBe(false);
    expect(ok(v2, "sidecar.attestation_ref")).toBe("fail");
    const v3 = await verifySidecarReceipt(real.receipt(), { ...bound, modelDigest: "sha256:" + "ab".repeat(32) });
    expect(v3.valid).toBe(false);
  });
});

describe("router receipts and the published key set", () => {
  const payload = { v: 1, id: "gen-1", issued: "2026-09-15T10:00:00.000Z", model: "m", provider: "p", tokens: { prompt: 3, completion: 4 }, cost: "0.00001" };

  test("verifies against the JWKS the router publishes, and only that key", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const v = await verifyReceipt(r, { keys: { keys: [jwk] } });
    expect(v.valid).toBe(true);
    expect(ok(v, "key_window")).toBe("pass");
    // Unknown key id, or a key set that does not contain it.
    expect((await verifyReceipt(r, { keys: { keys: [] } })).valid).toBe(false);
    const other = await makeRouterKey().ready;
    expect((await verifyReceipt(r, { keys: { keys: [other] } })).valid).toBe(false);
  });

  test("a receipt that records the provider's attestation (attested council, attested dual verification) verifies, and the record is signed", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const ref = { provider: "p", tee: "tdx", report_hash: "aa".repeat(32), attested_at: "2026-09-15T09:59:00.000Z", tls_pin: { spki_sha256: "bb".repeat(32), attestation_ref: "cc".repeat(32) } };
    const withRef = { ...payload, attestation: ref.report_hash, attestation_ref: ref, council: { role: "judge", attested: true, attestation_refs: [{ role: "judge", receipt_id: "gen-1", ...ref }] } };
    const r = await signReceipt(k.privateKey, jwk.kid, withRef);
    expect((await verifyReceipt(r, { keys: { keys: [jwk] } })).valid).toBe(true);
    // Receipts made before the field existed verify the same way.
    expect((await verifyReceipt(await signReceipt(k.privateKey, jwk.kid, payload), { keys: { keys: [jwk] } })).valid).toBe(true);
    // Changing the reference, or the council's list of them, breaks the signature.
    const forgedOwn = { ...r, payload: { ...withRef, attestation_ref: { ...ref, report_hash: "00".repeat(32) } } };
    const forgedList = { ...r, payload: { ...withRef, council: { ...withRef.council, attestation_refs: [] } } };
    for (const forged of [forgedOwn, forgedList]) {
      const v = await verifyReceipt(forged, { keys: { keys: [jwk] } });
      expect(v.valid).toBe(false);
      expect(ok(v, "signature")).toBe("fail");
    }
  });

  test("a key entry whose id does not match its bytes is rejected", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const liar = { ...jwk, x: (await makeRouterKey().ready).x };
    const v = await verifyReceipt(r, { keys: { keys: [liar] } });
    expect(v.valid).toBe(false);
    expect(ok(v, "key")).toBe("fail");
  });

  test("a receipt dated outside its key's window is flagged", async () => {
    const k = makeRouterKey("2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    const jwk = await k.ready;
    const late = await signReceipt(k.privateKey, jwk.kid, { ...payload, issued: "2026-09-20T00:00:00.000Z" });
    const v = await verifyReceipt(late, { keys: [jwk] });
    expect(v.valid).toBe(false);
    expect(ok(v, "key_window")).toBe("fail");
    const inside = await signReceipt(k.privateKey, jwk.kid, { ...payload, issued: "2026-09-05T00:00:00.000Z" });
    expect((await verifyReceipt(inside, { keys: [jwk] })).valid).toBe(true);
  });

  test("malformed input is a failed verification, not an exception", async () => {
    for (const bad of [null, {}, { payload: {}, sig: "", key_id: "" }, { payload: 5, sig: "x", key_id: "y" }] as unknown as ReceiptEnvelope[]) {
      const v = await verifyReceipt(bad, { keys: [] });
      expect(v.valid).toBe(false);
    }
  });

  test("a runtime without Ed25519 reports not_checked and never valid", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const { UnsupportedCrypto } = await import("../src/index.js");
    const v = await verifyReceipt(r, {
      keys: [jwk],
      ed25519: async () => {
        throw new UnsupportedCrypto("no Ed25519 here");
      },
    });
    expect(ok(v, "signature")).toBe("not_checked");
    expect(v.valid).toBe(false);
  });

  test("fetchReceiptKeys reads the well-known path and validates the shape", async () => {
    const jwk = await makeRouterKey().ready;
    const { fetch, calls } = stubFetch({ "/.well-known/trellis-receipt-keys.json": () => json({ keys: [jwk] }) });
    expect((await fetchReceiptKeys("https://router.test/", fetch)).keys[0].kid).toBe(jwk.kid);
    expect(calls[0].url).toBe("https://router.test/.well-known/trellis-receipt-keys.json");
    expect(() => parseKeySet({ nope: 1 })).toThrow();
    expect(() => parseKeySet({ keys: [{ kid: "a" }] })).toThrow();
    const failing = stubFetch({});
    await expect(fetchReceiptKeys("https://router.test", failing.fetch)).rejects.toThrow(/404/);
  });
});

describe("anchor inclusion", () => {
  const pair = (a: Uint8Array, b: Uint8Array) => {
    const cmp = Buffer.compare(a, b) < 0;
    return sha256Sync(Buffer.concat(cmp ? [a, b] : [b, a]));
  };
  const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

  test("verifies sorted-pair proofs and rejects wrong roots, leaves and proofs", () => {
    const leaves = [1, 2, 3, 4].map((n) => sha256Sync(new Uint8Array([n])));
    const l01 = pair(leaves[0], leaves[1]);
    const l23 = pair(leaves[2], leaves[3]);
    const root = pair(l01, l23);
    expect(verifyMerkleProof(hex(leaves[2]), [hex(leaves[3]), hex(l01)], hex(root))).toBe(true);
    expect(verifyMerkleProof(hex(leaves[2]), [hex(leaves[3]), hex(l23)], hex(root))).toBe(false);
    expect(verifyMerkleProof(hex(leaves[1]), [hex(leaves[3]), hex(l01)], hex(root))).toBe(false);
    expect(verifyMerkleProof(hex(leaves[2]), [], hex(leaves[2]))).toBe(true);
    expect(verifyMerkleProof("nothex", [], hex(root))).toBe(false);
  });

  test("a receipt with a proof reports proof_valid; a tampered proof fails the receipt", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, { v: 1, id: "g", issued: "2026-09-15T00:00:00.000Z" });
    const sibling = sha256Sync(new Uint8Array([9]));
    const leaf = hexToBytes(r.leaf!);
    const root = pair(leaf, sibling);
    const anchored = { ...r, anchor: { root: hex(root), proof: [hex(sibling)], index: 7, leaf_index: 0 } };
    const v = await verifyReceipt(anchored, { keys: [jwk] });
    expect(v.anchor).toBe("proof_valid");
    expect(v.valid).toBe(true);
    const wrong = await verifyReceipt({ ...anchored, anchor: { ...anchored.anchor, proof: [hex(sha256Sync(new Uint8Array([10])))] } }, { keys: [jwk] });
    expect(wrong.anchor).toBe("proof_invalid");
    expect(wrong.valid).toBe(false);
  });

  test("receiptLeaf is the double sha256 of payload and signature", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, { v: 1, id: "leaf" });
    const bytes = Buffer.concat([canonicalBytes(r.payload), Buffer.from(r.sig, "base64")]);
    expect(r.leaf).toBe("0x" + Buffer.from(sha256Sync(sha256Sync(bytes))).toString("hex"));
    expect(receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64"))).toBe(r.leaf!);
  });
});

// A posted root, checked against the chain through its transaction. The RPC here is a few lines of memory that hold
// real signed transactions (built with this package's own encoder) and answer getTransaction and getSignaturesForAddress
// the way a Solana node does. The router-side tests (test/anchor-memo.test.ts) run the router's verifier and the proof
// pack script against the same kind of cluster; tests/integration/anchor-memo.ts does it against a real validator.
describe("a posted root against the chain", () => {
  const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const HOUR = 1_790_002_800;
  const ROOT = "0x" + "ab".repeat(32);
  const OTHER = "0x" + "cd".repeat(32);
  const seed = (n: number) => signerFromSeed(new Uint8Array(32).fill(n));
  const addr = (s: KeypairSigner) => base58Encode(s.publicKey);

  const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  /** What the caller of the verifier trusts: its own settings, never the proof's. */
  const MEMO = { mode: "memo" as const, network: NETWORK };

  type Landed = { signature: string; raw: Uint8Array; blockTime: number; slot: number; err: unknown; keys: string[]; memo: string | null };
  function cluster() {
    const txs: Landed[] = [];
    const pruned = new Set<string>();
    let slot = 10, memoField = true;
    /** The node: which cluster it serves, how far back it keeps its ledger, whether its signature lists work, how much of a list it still has. */
    const node = { genesis: DEVNET_GENESIS, firstAvailableSlot: 0, firstAvailableTime: 0, failLists: false, listKeeps: null as number | null };
    const land = async (instructions: Instruction[], signers: KeypairSigner[], at: number, fail = false) => {
      const m = compileLegacyMessage({ feePayer: signers[0].publicKey, recentBlockhash: base58Encode(sha256Sync(new Uint8Array([slot]))), instructions });
      const sigs: Uint8Array[] = [];
      for (let i = 0; i < m.numRequiredSignatures; i++) sigs.push(await signers.find((s) => addr(s) === m.accountKeys[i])!.sign(m.bytes));
      const signature = base58Encode(sigs[0]);
      const memos = instructions.filter((i) => i.programId === MEMO_PROGRAM).map((i) => { const t = new TextDecoder().decode(i.data); return `[${t.length}] ${t}`; });
      txs.push({ signature, raw: serializeTransaction(m.bytes, sigs), blockTime: at, slot: ++slot, err: fail ? { InstructionError: [0, "Custom"] } : null, keys: m.accountKeys, memo: memos.length ? memos.join("; ") : null });
      return signature;
    };
    const rpc: SolanaRpc = async (method, params) => {
      if (method === "getTransaction") {
        const t = txs.find((x) => x.signature === params[0]);
        return t && !pruned.has(t.signature) ? { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err }, transaction: [Buffer.from(t.raw).toString("base64"), "base64"] } : null;
      }
      if (method === "getSignaturesForAddress") {
        if (node.failLists) throw new Error("getSignaturesForAddress failed: node is behind");
        const o = (params[1] ?? {}) as { before?: string; until?: string; limit?: number };
        let list = txs.filter((t) => t.keys.includes(params[0] as string)).sort((a, b) => b.slot - a.slot);
        if (node.listKeeps !== null) list = list.slice(0, node.listKeeps);
        if (o.before) list = list.slice(list.findIndex((t) => t.signature === o.before) + 1);
        if (o.until) { const end = list.findIndex((t) => t.signature === o.until); if (end >= 0) list = list.slice(0, end); }
        return list.slice(0, o.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: t.err, memo: memoField ? t.memo : null }));
      }
      if (method === "getGenesisHash") return node.genesis;
      if (method === "getFirstAvailableBlock") return node.firstAvailableSlot;
      if (method === "getBlockTime") return node.firstAvailableTime;
      throw new Error(`${method} is not served`);
    };
    return { land, rpc, pruned, txs, node, hideMemoField: () => void (memoField = false) };
  }
  const memo = (text: string, signers: KeypairSigner[]): Instruction => ({ programId: MEMO_PROGRAM, keys: signers.map((s) => ({ pubkey: addr(s), isSigner: true, isWritable: false })), data: new TextEncoder().encode(text) });
  const proofFor = (tx: string, over: Partial<PostedAnchorProof> = {}): PostedAnchorProof => ({ root: ROOT, proof: [], status: "confirmed", tx, mode: "memo", hour: HOUR, count: 5, network: NETWORK, contract: null, ...over });
  const line = (over: Partial<PostedAnchorProof> = {}) => rootMemoLine({ root: ROOT, hour: HOUR, count: 5, network: NETWORK, ...over })!.line;
  const failed = (v: { checks: { id: string; status: string; detail: string }[] }) => v.checks.find((c) => c.status === "fail")?.detail ?? "";

  test("the line is the documented one", () => {
    expect(line()).toBe(`trellis:root:v1:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${HOUR}:5:${"ab".repeat(32)}`);
    expect(rootMemoLine({ root: ROOT, hour: HOUR + 1, count: 5, network: NETWORK })).toBeNull();
    expect(rootMemoLine({ root: "0x12", hour: HOUR, count: 5, network: NETWORK })).toBeNull();
  });

  test("memo mode: signed by the published anchorer, finalized, exact, and the earliest for its hour", async () => {
    const anchorer = await seed(1), stranger = await seed(2);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const tx = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    const v = await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO, anchorers });
    expect(v).toMatchObject({ valid: true, status: "verified", mode: "memo", anchorer: addr(anchorer), earliest: true, late: false, conflicts: [] });
    expect(v.checks.map((x) => [x.id, x.status])).toEqual([["posted.cluster", "pass"], ["posted.anchorer", "pass"], ["posted.transaction", "pass"], ["posted.content", "pass"], ["posted.time", "pass"], ["posted.earliest", "pass"]]);
    // Pinning: the right first key passes, another fails. No published key at all fails.
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO, anchorers, pinnedAnchorer: addr(anchorer) })).valid).toBe(true);
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO, anchorers, pinnedAnchorer: addr(stranger) })).valid).toBe(false);
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO })).valid).toBe(false);
    // Without a mode and a network of the caller's own nothing verifies: the proof's are the router's statement.
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, anchorers })).valid).toBe(false);
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, mode: "memo", anchorers })).valid).toBe(false);
    // Another root, count, hour or cluster than the signed line.
    for (const over of [{ root: OTHER }, { count: 6 }, { hour: HOUR - 3600 }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }]) expect((await verifyPostedRoot(proofFor(tx, over), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
    // The same text from another key is not a root; neither is a memo the anchorer only paid for.
    const forged = await c.land([memo(line(), [stranger])], [stranger], HOUR + 3700);
    expect(failed(await verifyPostedRoot(proofFor(forged), { rpc: c.rpc, ...MEMO, anchorers }))).toMatch(/not signed by the anchorer key/);
    // Not posted, failed on chain, or no longer served by the RPC.
    expect((await verifyPostedRoot(proofFor(tx, { status: "pending" }), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
    const reverted = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700, true);
    expect(failed(await verifyPostedRoot(proofFor(reverted), { rpc: c.rpc, ...MEMO, anchorers }))).toMatch(/failed on chain/);
    c.pruned.add(tx);
    expect(failed(await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO, anchorers }))).toMatch(/does not serve the transaction/);
    c.pruned.clear();
    // A node that does not index memos gives the same verdict.
    c.hideMemoField();
    expect((await verifyPostedRoot(proofFor(tx), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(true);
    // A changed byte in the served transaction breaks its signature.
    const t = c.txs.find((x) => x.signature === tx)!;
    t.raw = Uint8Array.from(t.raw);
    t.raw[t.raw.length - 1] ^= 1;
    expect(failed(await verifyPostedRoot(proofFor(tx, { root: "0x" + "ab".repeat(31) + "aa" }), { rpc: c.rpc, ...MEMO, anchorers }))).toMatch(/does not verify|does not parse/);
  });

  test("memo mode: an earlier other line refutes a proof; a later one is reported; a second copy is harmless", async () => {
    const anchorer = await seed(3);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const first = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    const second = await c.land([memo(line({ root: OTHER, count: 9 }), [anchorer])], [anchorer], HOUR + 3800);
    const copy = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3900);
    const good = await verifyPostedRoot(proofFor(first), { rpc: c.rpc, ...MEMO, anchorers });
    expect(good).toMatchObject({ valid: true, earliest: true, conflicts: [second] });
    const refuted = await verifyPostedRoot(proofFor(second, { root: OTHER, count: 9 }), { rpc: c.rpc, ...MEMO, anchorers });
    expect(refuted).toMatchObject({ valid: false, earliest: false });
    expect(failed(refuted)).toContain(first);
    expect(await verifyPostedRoot(proofFor(copy), { rpc: c.rpc, ...MEMO, anchorers })).toMatchObject({ valid: true, earliest: false, conflicts: [second] });
    const quick = await verifyPostedRoot(proofFor(second, { root: OTHER, count: 9 }), { rpc: c.rpc, ...MEMO, anchorers, walkHistory: false });
    expect(quick.valid).toBe(true);
    expect(quick.notChecked.join(" ")).toMatch(/earlier, different line/);
  });

  test("rotation: each key answers for its own hours, and a hand-over needs both signatures", async () => {
    const a = await seed(4), b = await seed(5);
    const c = cluster();
    const from = HOUR + 4 * 3600;
    const oldRoot = await c.land([memo(line(), [a])], [a], HOUR + 3700);
    const rotation = await c.land([memo(`trellis:anchorer:v1:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${from}:${addr(b)}`, [a, b])], [a, b], from - 600);
    const keys: AnchorerKey[] = [{ key: addr(a), from_hour: 0, rotation_tx: null }, { key: addr(b), from_hour: from, rotation_tx: rotation }];
    expect(anchorerKeysProblem(keys)).toBeNull();
    expect(await verifyPostedRoot(proofFor(oldRoot), { rpc: c.rpc, ...MEMO, anchorers: keys })).toMatchObject({ valid: true, anchorer: addr(a) });
    const newRoot = await c.land([memo(line({ hour: from }), [b])], [b], from + 3700);
    expect(await verifyPostedRoot(proofFor(newRoot, { hour: from }), { rpc: c.rpc, ...MEMO, anchorers: keys })).toMatchObject({ valid: true, anchorer: addr(b) });
    const stale = await c.land([memo(line({ hour: from + 3600 }), [a])], [a], from + 7300);
    expect((await verifyPostedRoot(proofFor(stale, { hour: from + 3600 }), { rpc: c.rpc, ...MEMO, anchorers: keys })).valid).toBe(false);
    // The new key announcing itself is not a rotation.
    const self = await c.land([memo(`trellis:anchorer:v1:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${from}:${addr(b)}`, [b])], [b], from - 600);
    const broken = await verifyPostedRoot(proofFor(newRoot, { hour: from }), { rpc: c.rpc, ...MEMO, anchorers: [keys[0], { ...keys[1], rotation_tx: self }] });
    expect(failed(broken)).toMatch(/not signed by the key before it/);
    expect(anchorerKeysProblem([{ key: addr(a), from_hour: 3600, rotation_tx: null }])).toMatch(/does not follow/);
  });

  test("program mode: the posting transaction carries post_root with exactly the proof's values", async () => {
    const authority = await seed(6), stranger = await seed(7);
    const c = cluster();
    const program = base58Encode(new Uint8Array(32).fill(7));
    const data = (root: string, count: number) => { const d = new Uint8Array(56); d.set([154, 210, 156, 158, 199, 27, 174, 35]); new DataView(d.buffer).setBigInt64(8, BigInt(HOUR), true); d.set(hexToBytes(root.slice(2)), 16); new DataView(d.buffer).setBigUint64(48, BigInt(count), true); return d; };
    const post = (s: KeypairSigner, root = ROOT, count = 5): Instruction => ({ programId: program, keys: [{ pubkey: addr(s), isSigner: true, isWritable: true }], data: data(root, count) });
    const tx = await c.land([post(authority)], [authority], HOUR + 3700);
    const proof = proofFor(tx, { mode: "program", contract: program, anchorer: addr(authority) });
    const mine = { rpc: c.rpc, mode: "program" as const, network: NETWORK, programId: program, anchorers: [{ key: addr(authority), from_hour: 0, rotation_tx: null }] };
    expect(await verifyPostedRoot(proof, mine)).toMatchObject({ valid: true, mode: "program", anchorer: addr(authority) });
    expect((await verifyPostedRoot({ ...proof, root: OTHER }, mine)).valid).toBe(false);
    expect((await verifyPostedRoot({ ...proof, count: 6 }, mine)).valid).toBe(false);
    expect((await verifyPostedRoot({ ...proof, contract: MEMO_PROGRAM }, mine)).valid).toBe(false);
    const other = await c.land([post(stranger)], [stranger], HOUR + 3700);
    expect(failed(await verifyPostedRoot({ ...proof, tx: other }, mine))).toMatch(/not by the anchorer key/);
    // Without a program id and a key of the caller's own there is nothing to compare with: not a pass.
    expect((await verifyPostedRoot(proof, { rpc: c.rpc, mode: "program", network: NETWORK, anchorers: mine.anchorers })).valid).toBe(false);
    expect((await verifyPostedRoot(proof, { rpc: c.rpc, mode: "program", network: NETWORK, programId: program })).valid).toBe(false);
  });

  // ---- Security review round 3: R3-04, R3-05, R3-13, R3-14 --------------------------------------------------------------
  // Each of these passed a forged or unverifiable proof on the code before the fix.

  test("R3-04 (a, d): a stranger-signed memo with the right text fails; the genuine one verifies under the caller's settings", async () => {
    const anchorer = await seed(11), stranger = await seed(12);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const genuine = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    expect(await verifyPostedRoot(proofFor(genuine, { memo: line(), anchorer: addr(anchorer) }), { rpc: c.rpc, ...MEMO, anchorers })).toMatchObject({ valid: true, earliest: true });
    const forged = await c.land([memo(line(), [stranger]), { programId: "11111111111111111111111111111111", keys: [{ pubkey: addr(stranger), isSigner: true, isWritable: true }, { pubkey: addr(anchorer), isSigner: false, isWritable: true }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }], [stranger], HOUR + 3700);
    expect((await verifyPostedRoot(proofFor(forged, { memo: line(), anchorer: addr(stranger) }), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
  });

  test("R3-04 (b, c): a proof that claims program mode with a stranger's program and authority, and names the attacker as anchorer, fails", async () => {
    const anchorer = await seed(13), attacker = await seed(14);
    const c = cluster();
    const program = base58Encode(new Uint8Array(32).fill(9));
    const d = new Uint8Array(56);
    d.set([154, 210, 156, 158, 199, 27, 174, 35]);
    new DataView(d.buffer).setBigInt64(8, BigInt(HOUR), true);
    d.set(hexToBytes(ROOT.slice(2)), 16);
    new DataView(d.buffer).setBigUint64(48, 5n, true);
    const tx = await c.land([{ programId: program, keys: [{ pubkey: addr(attacker), isSigner: true, isWritable: true }], data: d }], [attacker], HOUR + 3700);
    const forged = proofFor(tx, { mode: "program", contract: program, anchorer: addr(attacker) });
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    // (b) The caller expects memo mode: the proof does not get to pick another mode and its own program.
    expect((await verifyPostedRoot(forged, { rpc: c.rpc, ...MEMO })).valid).toBe(false);
    expect((await verifyPostedRoot(forged, { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
    // (c) The anchorer a proof names is not a key: with no key of the caller's own, or with the real one, it fails.
    expect((await verifyPostedRoot(forged, { rpc: c.rpc })).valid).toBe(false);
    expect((await verifyPostedRoot(forged, { rpc: c.rpc, mode: "program", network: NETWORK, programId: program })).valid).toBe(false);
    expect((await verifyPostedRoot(forged, { rpc: c.rpc, mode: "program", network: NETWORK, programId: program, anchorers })).valid).toBe(false);
    // And a pinned program that is not the proof's.
    expect((await verifyPostedRoot(forged, { rpc: c.rpc, mode: "program", network: NETWORK, programId: base58Encode(new Uint8Array(32).fill(8)), anchorers: [{ key: addr(attacker), from_hour: 0, rotation_tx: null }] })).valid).toBe(false);
  });

  test("R3-04: a host root proof cannot choose program mode and its own program either", async () => {
    const attacker = await seed(15);
    const c = cluster();
    const key = makeRouterKey();
    const jwk = await key.ready;
    const receipt = await signReceipt(key.privateKey, jwk.kid, { type: "trellis.sidecar.receipt", id: "rcpt_sample", ts: 1_790_000_000_000, attestation_ref: "ab".repeat(32) });
    const program = base58Encode(new Uint8Array(32).fill(9));
    const pid = "0x" + Buffer.from(sha256Sync(new TextEncoder().encode("sample-host"))).toString("hex");
    const data = new Uint8Array(8 + 32 + 8 + 32 + 8);
    data.set([25, 195, 127, 184, 90, 53, 223, 102]);
    data.set(hexToBytes(pid.slice(2)), 8);
    new DataView(data.buffer).setBigInt64(40, BigInt(HOUR), true);
    data.set(hexToBytes(receipt.leaf!.slice(2)), 48);
    new DataView(data.buffer).setBigInt64(80, 1n, true);
    const tx = await c.land([{ programId: program, keys: [{ pubkey: addr(attacker), isSigner: true, isWritable: true }], data }], [attacker], HOUR + 3700);
    const proof: HostAnchorProof = { leaf: receipt.leaf!, rooted: true, anchored: true, status: "confirmed", provider: "sample-host", provider_id_hash: pid, attestation_ref: "ab".repeat(32), receipt_key: { key_id: jwk.kid, public_key: Buffer.from(key.raw).toString("hex") }, root: receipt.leaf!, leaf_index: 0, proof: [], count: 1, anchor_hour: HOUR, tx, block: 1, mode: "program", contract: program, anchorer: addr(attacker), network: NETWORK };
    const v = await verifyHostAnchor(receipt, proof, { rpc: c.rpc, requireOnChain: true, ...MEMO });
    expect(v.checks.find((x) => x.id === "host.inclusion")?.status).toBe("pass");
    expect(v).toMatchObject({ valid: false });
    expect((await verifyHostAnchor(receipt, proof, { rpc: c.rpc, requireOnChain: true })).valid).toBe(false);
    expect((await verifyHostAnchor(receipt, proof, { rpc: c.rpc, requireOnChain: true, mode: "program", network: NETWORK, programId: program })).valid).toBe(false);
  });

  test("R3-05: an unreadable, pruned or cut-short history is `unknown`, never `earliest: true`", async () => {
    const anchorer = await seed(16);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const tx = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    const mine = { rpc: c.rpc, ...MEMO, anchorers };
    c.node.failLists = true;
    expect(await verifyPostedRoot(proofFor(tx), mine)).toMatchObject({ valid: false, status: "unknown", earliest: null });
    c.node.failLists = false;
    // A node that no longer lists this part of the address history, and says so through its first available block.
    c.node.listKeeps = 0;
    c.node.firstAvailableSlot = 9;
    c.node.firstAvailableTime = HOUR + 3600;
    expect(await verifyPostedRoot(proofFor(tx), mine)).toMatchObject({ valid: false, status: "unknown", earliest: null });
    c.node.listKeeps = null;
    c.node.firstAvailableSlot = 0;
    expect(await verifyPostedRoot(proofFor(tx), mine)).toMatchObject({ valid: true, earliest: true });
    // More history than the walk may read: two roots for the hour with other transactions between them.
    const filler = await seed(17);
    for (let i = 0; i < 3; i++) await c.land([memo(`filler ${i}`, [filler]), { programId: "11111111111111111111111111111111", keys: [{ pubkey: addr(filler), isSigner: true, isWritable: true }, { pubkey: addr(anchorer), isSigner: false, isWritable: true }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }], [filler], HOUR + 3750 + i);
    const second = await c.land([memo(line({ root: OTHER, count: 9 }), [anchorer])], [anchorer], HOUR + 3800);
    c.hideMemoField(); // every transaction has to be read, and the caller allows two
    const cut = await verifyPostedRoot(proofFor(second, { root: OTHER, count: 9 }), { ...mine, maxReads: 2 });
    expect(cut.valid).toBe(false);
    expect(cut.earliest).not.toBe(true);
    expect(await verifyPostedRoot(proofFor(second, { root: OTHER, count: 9 }), mine)).toMatchObject({ valid: false, earliest: false });
  });

  test("R3-13: the RPC must serve the cluster the caller's network names", async () => {
    const anchorer = await seed(18);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const dev = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    const main = await c.land([memo(line({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", root: OTHER }), [anchorer])], [anchorer], HOUR + 3800);
    expect((await verifyPostedRoot(proofFor(dev), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(true);
    // The same hour under mainnet's name, read from an RPC that serves devnet: refused, so the two do not both verify.
    expect((await verifyPostedRoot(proofFor(main, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", root: OTHER }), { rpc: c.rpc, mode: "memo", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", anchorers })).valid).toBe(false);
    c.node.genesis = MAINNET_GENESIS;
    expect((await verifyPostedRoot(proofFor(dev), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
  });

  test("R3-14: a late line is refused unless allowed, and a retired key signs nothing after its hand-over", async () => {
    const a = await seed(19), b = await seed(20);
    const c = cluster();
    const first: AnchorerKey[] = [{ key: addr(a), from_hour: 0, rotation_tx: null }];
    const late = await c.land([memo(line(), [a])], [a], HOUR + 3600 + 4 * 3600);
    expect(await verifyPostedRoot(proofFor(late), { rpc: c.rpc, ...MEMO, anchorers: first, maxLateSeconds: 2 * 3600 })).toMatchObject({ valid: false, late: true });
    expect(await verifyPostedRoot(proofFor(late), { rpc: c.rpc, ...MEMO, anchorers: first, maxLateSeconds: 2 * 3600, allowLate: true })).toMatchObject({ valid: true, late: true });
    expect(await verifyPostedRoot(proofFor(late), { rpc: c.rpc, ...MEMO, anchorers: first })).toMatchObject({ valid: true, late: false });
    const from = HOUR + 2 * 3600;
    const rotation = await c.land([memo(`trellis:anchorer:v1:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${from}:${addr(b)}`, [a, b])], [a, b], from - 600);
    const keys: AnchorerKey[] = [...first, { key: addr(b), from_hour: from, rotation_tx: rotation }];
    const backfill = await c.land([memo(line({ hour: HOUR - 3600, root: OTHER }), [a])], [a], from + 3600 + 60);
    const refused = await verifyPostedRoot(proofFor(backfill, { hour: HOUR - 3600, root: OTHER }), { rpc: c.rpc, ...MEMO, anchorers: keys, maxLateSeconds: 86_400 });
    expect(refused.valid).toBe(false);
    expect(failed(refused)).toMatch(/retired/);
  });

  test("R3-05: a v2 line names the previous root's transaction, and the link is checked", async () => {
    const anchorer = await seed(21), stranger = await seed(22);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const REF = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const before = await c.land([memo(`trellis:root:v2:${REF}:${HOUR - 3600}:2:${"cd".repeat(32)}:0`, [anchorer])], [anchorer], HOUR + 30);
    const text = `trellis:root:v2:${REF}:${HOUR}:5:${"ab".repeat(32)}:${before}`;
    const tx = await c.land([memo(text, [anchorer])], [anchorer], HOUR + 3700);
    expect(await verifyPostedRoot(proofFor(tx, { memo: text }), { rpc: c.rpc, ...MEMO, anchorers, memoV2FromHour: HOUR })).toMatchObject({ valid: true, earliest: true, link: "verified" });
    // A memo line in the proof that says another root than the proof does is not taken.
    expect((await verifyPostedRoot(proofFor(tx, { memo: text, root: OTHER }), { rpc: c.rpc, ...MEMO, anchorers })).valid).toBe(false);
    // After the switch a v1 line is no longer a root.
    const v1 = await c.land([memo(line({ hour: HOUR + 3600 }), [anchorer])], [anchorer], HOUR + 7300);
    expect((await verifyPostedRoot(proofFor(v1, { hour: HOUR + 3600 }), { rpc: c.rpc, ...MEMO, anchorers, memoV2FromHour: HOUR })).valid).toBe(false);
    expect((await verifyPostedRoot(proofFor(v1, { hour: HOUR + 3600 }), { rpc: c.rpc, ...MEMO, anchorers, memoV2FromHour: HOUR + 7200 })).valid).toBe(true);
    // A link to something that is not an earlier root line of the anchorer.
    const junk = await c.land([memo(`trellis:root:v1:${REF}:${HOUR + 3600}:1:${"cd".repeat(32)}`, [stranger])], [stranger], HOUR + 7400);
    const forked = `trellis:root:v2:${REF}:${HOUR + 7200}:1:${"ab".repeat(32)}:${junk}`;
    const bad = await c.land([memo(forked, [anchorer])], [anchorer], HOUR + 10_900);
    const v = await verifyPostedRoot(proofFor(bad, { memo: forked, hour: HOUR + 7200, count: 1 }), { rpc: c.rpc, ...MEMO, anchorers });
    expect(v.valid).toBe(false);
    expect(failed(v)).toMatch(/previous root/);
    expect(typeof (clientApi as Record<string, unknown>).anchorTrustFromDocument).toBe("function");
  });

  // ---- Security review round 4 (security/REVIEW-ROUND4-2026-10.md): R4-09, R4-10, R4-12 (the R3-14 residual), R4-28 ----

  test("R4-09: a flood of look-alike transactions in the hour does not make an honest root unknown; a cap is the caller's choice", async () => {
    const anchorer = await seed(31), stranger = await seed(32);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    await c.land([memo("funding", [stranger]), { programId: "11111111111111111111111111111111", keys: [{ pubkey: addr(stranger), isSigner: true, isWritable: true }, { pubkey: addr(anchorer), isSigner: false, isWritable: true }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }], [stranger], HOUR - 86_400);
    // 2,001 transactions that name the anchorer, each with a look-alike line for the hour signed by a stranger.
    const junk = `trellis:root:v1:x:${HOUR}:0:${"0".repeat(64)}`;
    for (let i = 0; i < 2_001; i++) await c.land([memo(`${junk}`, [stranger]), { programId: "11111111111111111111111111111111", keys: [{ pubkey: addr(stranger), isSigner: true, isWritable: true }, { pubkey: addr(anchorer), isSigner: false, isWritable: true }], data: new Uint8Array([2, 0, 0, 0, 1 + (i & 0x7f), i >> 7, 0, 0, 0, 0, 0, 0]) }], [stranger], HOUR + 5 + i);
    const tx = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    let inFlight = 0, peak = 0;
    const rpc: SolanaRpc = async (m, p) => { if (m !== "getTransaction") return c.rpc(m, p); peak = Math.max(peak, ++inFlight); try { await Promise.resolve(); return await c.rpc(m, p); } finally { inFlight--; } };
    expect(await verifyPostedRoot(proofFor(tx), { rpc, ...MEMO, anchorers })).toMatchObject({ valid: true, status: "verified", earliest: true });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(await verifyPostedRoot(proofFor(tx), { rpc, ...MEMO, anchorers, maxReads: 100 })).toMatchObject({ valid: false, status: "unknown", earliest: null });
  }, 120_000);

  test("R4-10: two different roots for one hour in ONE transaction are a conflict, whichever of them the proof names", async () => {
    const anchorer = await seed(33);
    const c = cluster();
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const both = await c.land([memo(line(), [anchorer]), memo(line({ root: OTHER, count: 9 }), [anchorer])], [anchorer], HOUR + 3700);
    for (const proof of [proofFor(both), proofFor(both, { root: OTHER, count: 9 })]) {
      const v = await verifyPostedRoot(proof, { rpc: c.rpc, ...MEMO, anchorers });
      expect(v).toMatchObject({ valid: false, status: "failed", earliest: false, conflicts: [both] });
      expect(failed(v)).toMatch(/two different roots/);
      expect((await verifyPostedRoot(proof, { rpc: c.rpc, ...MEMO, anchorers, walkHistory: false })).valid).toBe(false);
    }
    // The same line twice is no conflict; a later copy of a root whose first transaction also carried another root is refused.
    const copy = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3800);
    expect(await verifyPostedRoot(proofFor(copy), { rpc: c.rpc, ...MEMO, anchorers })).toMatchObject({ valid: false, earliest: false, conflicts: [both] });
    const d = cluster();
    const twice = await d.land([memo(line(), [anchorer]), memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    expect(await verifyPostedRoot(proofFor(twice), { rpc: d.rpc, ...MEMO, anchorers })).toMatchObject({ valid: true, earliest: true, conflicts: [] });
  });

  test("R4-28: a candidate the node lists and does not serve is UNKNOWN; a link must name the actual previous root", async () => {
    const anchorer = await seed(34);
    const REF = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const anchorers: AnchorerKey[] = [{ key: addr(anchorer), from_hour: 0, rotation_tx: null }];
    const mine = (c: ReturnType<typeof cluster>) => ({ rpc: c.rpc, ...MEMO, anchorers, memoV2FromHour: 0 });
    const v2 = (hour: number, root: string, count: number, prev: string | null) => `trellis:root:v2:${REF}:${hour}:${count}:${root.slice(2)}:${prev ?? "0"}`;
    // (a) an earlier, different line whose transaction the node no longer serves.
    const c = cluster();
    const first = await c.land([memo(line({ root: OTHER, count: 1 }), [anchorer])], [anchorer], HOUR + 3610);
    const second = await c.land([memo(line(), [anchorer])], [anchorer], HOUR + 3700);
    expect(await verifyPostedRoot(proofFor(second), { rpc: c.rpc, ...MEMO, anchorers })).toMatchObject({ valid: false, status: "failed", earliest: false });
    c.pruned.add(first);
    expect(await verifyPostedRoot(proofFor(second), { rpc: c.rpc, ...MEMO, anchorers })).toMatchObject({ valid: false, status: "unknown", earliest: null });
    // (b) an honest chain of three hourly roots.
    const d = cluster();
    const h1 = HOUR, h2 = HOUR + 3600, h3 = HOUR + 7200, h4 = HOUR + 10_800;
    const l1 = v2(h1, ROOT, 1, null), t1 = await d.land([memo(l1, [anchorer])], [anchorer], h1 + 3620);
    const l2 = v2(h2, OTHER, 2, t1), t2 = await d.land([memo(l2, [anchorer])], [anchorer], h2 + 3620);
    const l3 = v2(h3, ROOT, 3, t2), t3 = await d.land([memo(l3, [anchorer])], [anchorer], h3 + 3620);
    expect(await verifyPostedRoot(proofFor(t1, { hour: h1, count: 1, memo: l1 }), mine(d))).toMatchObject({ valid: true, link: "verified" });
    expect(await verifyPostedRoot(proofFor(t3, { hour: h3, count: 3, memo: l3 }), mine(d))).toMatchObject({ valid: true, earliest: true, link: "verified" });
    // `0` while the anchorer has earlier roots, and a link that skips the root before it: refused.
    const orphan = v2(h4, ROOT, 4, null), tOrphan = await d.land([memo(orphan, [anchorer])], [anchorer], h4 + 3620);
    const o = await verifyPostedRoot(proofFor(tOrphan, { hour: h4, count: 4, memo: orphan }), mine(d));
    expect(o).toMatchObject({ valid: false, status: "failed" });
    expect(failed(o)).toMatch(/no previous root/);
    const e = cluster();
    const u1 = await e.land([memo(l1, [anchorer])], [anchorer], h1 + 3620);
    expect(u1).toBe(t1);
    await e.land([memo(l2, [anchorer])], [anchorer], h2 + 3620);
    const skipping = v2(h3, ROOT, 3, t1), tSkip = await e.land([memo(skipping, [anchorer])], [anchorer], h3 + 3620);
    const k = await verifyPostedRoot(proofFor(tSkip, { hour: h3, count: 3, memo: skipping }), mine(e));
    expect(k).toMatchObject({ valid: false, status: "failed" });
    expect(failed(k)).toMatch(/previous root/);
    // A link that cannot be followed is unknown, with and without the history walk.
    d.pruned.add(t2);
    for (const walkHistory of [true, false]) expect(await verifyPostedRoot(proofFor(t3, { hour: h3, count: 3, memo: l3 }), { ...mine(d), walkHistory })).toMatchObject({ valid: false, status: "unknown", link: "not_checked" });
  });

  test("R4-12 / R3-14: a key document that has expired, or is older than a version already seen, is not a key source", async () => {
    const key = await seed(35);
    const anchorer = addr(await seed(36));
    const now = Date.parse("2026-10-13T12:00:00Z");
    const doc = { mode: "memo", network: NETWORK, anchorers: [{ key: anchorer, from_hour: 0, rotation_tx: null }], issued_at: "2026-10-13T11:00:00.000Z", expires_at: "2026-10-14T11:00:00.000Z" };
    expect(clientApi.anchorTrustFromDocument(doc, { now })).toMatchObject({ mode: "memo", network: NETWORK });
    expect(() => clientApi.anchorTrustFromDocument(doc, { now: now + 2 * 86_400_000 })).toThrow(/expired/);
    expect(() => clientApi.anchorTrustFromDocument(doc, { now, minVersion: 2 })).toThrow(/older version/);
    expect(() => clientApi.anchorTrustFromDocument({ ...doc, version: 2 }, { now })).toThrow(/does not count/);
    expect(clientApi.anchorTrustFromDocument({ ...doc, version: 1 }, { now, minVersion: 1 })).toMatchObject({ mode: "memo" });
    // A document from a router that publishes neither field is not refused for that.
    expect(clientApi.anchorTrustFromDocument({ mode: "memo", network: NETWORK, anchorers: doc.anchorers })).toMatchObject({ mode: "memo" });
    // The receipt keys: the set carries its version and expiry, and verifyReceipt honours them.
    const kid = Buffer.from(sha256Sync(key.publicKey)).toString("hex").slice(0, 16);
    const set = clientApi.parseKeySet({ version: 1, issued_at: doc.issued_at, expires_at: doc.expires_at, keys: [{ kty: "OKP", crv: "Ed25519", x: Buffer.from(key.publicKey).toString("base64url"), kid }] });
    expect(set).toMatchObject({ version: 1, expires_at: doc.expires_at });
    const payload = { v: 1, id: "gen-1", ts: now };
    const receipt = { payload, sig: Buffer.from(await key.sign(canonicalBytes(payload))).toString("base64"), key_id: kid };
    expect((await clientApi.verifyReceipt(receipt, { keys: set, now })).valid).toBe(true);
    const stale = await clientApi.verifyReceipt(receipt, { keys: set, now: now + 2 * 86_400_000 });
    expect(stale.valid).toBe(false);
    expect(stale.checks.find((c) => c.id === "key_document")).toMatchObject({ status: "fail" });
    expect((await clientApi.verifyReceipt(receipt, { keys: set, now, minKeyVersion: 2 })).valid).toBe(false);
    expect((await clientApi.verifyReceipt(receipt, { keys: { ...set, version: 5 }, now })).valid).toBe(false);
    // A bare list of pinned keys has no expiry of its own: that is the caller's pin.
    expect((await clientApi.verifyReceipt(receipt, { keys: set.keys, now: now + 2 * 86_400_000 })).valid).toBe(true);
  });

  test("jsonRpc and fetchAnchorKeys speak to an endpoint and a router", async () => {
    const calls: unknown[] = [];
    const { fetch: f } = stubFetch({
      "POST /": async ({ init }) => { calls.push(JSON.parse(String(init?.body))); return json({ jsonrpc: "2.0", id: 1, result: null }); },
      "/.well-known/trellis-receipt-keys.json": () => json({ keys: [], anchor: { mode: "memo", anchorers: [{ key: "k", from_hour: 0, rotation_tx: null }] } }),
    });
    expect(await jsonRpc("https://rpc.example/", f)("getTransaction", ["sig"])).toBeNull();
    expect(calls[0]).toMatchObject({ method: "getTransaction", params: ["sig"] });
    expect(await fetchAnchorKeys("https://router.example", f)).toMatchObject({ mode: "memo", anchorers: [{ key: "k" }] });
  });
});
