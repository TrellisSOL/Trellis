import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { base58Decode, base58Encode, bytesToHex, concatBytes, decodeHostRoot, fetchHostAnchorProof, hexToBytes, hostRootAddress, HOST_ROOT_DISCRIMINATOR, providerIdHash, readAttestedAnchor, sha256Sync, verifyHostAnchor, type AttestedAnchor, type BoundIdentity, type HostAnchorProof } from "../src/index.js";
import { HAS_REAL_EVIDENCE, json, real, stubFetch } from "./helpers.js";

// A sidecar receipt captured from a TDX deployment, under a per-host root built the way the router builds it, and the
// trellis_anchor HostRoot account the router posts it to (one per provider id hash and hour).

const status = (v: { checks: { id: string; status: string }[] }, id: string) => v.checks.find((c) => c.id === id)?.status;
const pair = (a: string, b: string) => {
  const [x, y] = [hexToBytes(a), hexToBytes(b)];
  return "0x" + bytesToHex(sha256Sync(bytesToHex(x) < bytesToHex(y) ? concatBytes(x, y) : concatBytes(y, x)));
};
const SIBLING = "0x" + "5a".repeat(32);
/** A localnet-shaped anchor program id and receipt signer (repeated bytes; nothing real). */
const PROGRAM_ID = base58Encode(new Uint8Array(32).fill(7));
const SIGNER = base58Encode(new Uint8Array(32).fill(9));
const HOUR = 1_790_000_000 - (1_790_000_000 % 3600);

/** HostRoot account bytes as Anchor lays them out: discriminator, provider_id_hash, hour, root, count, signer, posted_at, bump. */
function encodeHostRoot(a: AttestedAnchor & { bump?: number }): Uint8Array {
  const out = new Uint8Array(8 + 32 + 8 + 32 + 8 + 32 + 8 + 1);
  const view = new DataView(out.buffer);
  out.set(HOST_ROOT_DISCRIMINATOR, 0);
  out.set(hexToBytes(a.providerId.slice(2)), 8);
  view.setBigInt64(40, BigInt(a.hour), true);
  out.set(hexToBytes(a.root.slice(2)), 48);
  view.setBigUint64(80, BigInt(a.count), true);
  out.set(base58Decode(a.signer), 88);
  view.setBigInt64(120, BigInt(a.anchoredAt), true);
  out[128] = a.bump ?? 254;
  return out;
}

function fixture() {
  const receipt = real.receipt();
  const boot = real.boot();
  const proof: HostAnchorProof = {
    rid: receipt.payload.id as string,
    leaf: receipt.leaf!,
    rooted: true,
    anchored: true,
    status: "confirmed",
    provider: "example-provider",
    provider_id_hash: providerIdHash("example-provider"),
    attestation_ref: boot.attestation_ref,
    receipt_key: { key_id: boot.receipt_key.key_id, public_key: boot.bindings.receipt_pubkey },
    root_id: 1,
    root: pair(receipt.leaf!, SIBLING),
    leaf_index: 0,
    proof: [SIBLING],
    count: 2,
    anchor_index: null,
    anchor_hour: HOUR,
    tx: "5".repeat(88),
    block: 12,
    chain: "solana:mainnet",
    contract: PROGRAM_ID,
  };
  const onchain: AttestedAnchor = { providerId: proof.provider_id_hash, root: proof.root, hour: HOUR, count: 2, signer: SIGNER, anchoredAt: HOUR + 90 };
  const bound: BoundIdentity = {
    attestationRef: boot.attestation_ref,
    attestationSan: boot.attestation_san,
    tlsPubkey: boot.bindings.tls_pubkey,
    receiptPubkey: boot.bindings.receipt_pubkey,
    receiptKeyId: boot.receipt_key.key_id,
    hpkePubkey: null,
    imageDigest: boot.bindings.image_digest.slice(7),
    composeHash: boot.bindings.compose_hash.slice(7),
    modelDigest: boot.bindings.model_digest,
    measurements: null,
    teeKind: "tdx",
  };
  return { receipt, proof, onchain, bound };
}

describe.skipIf(!HAS_REAL_EVIDENCE)("verifyHostAnchor", () => {
  test("passes in order: signature under the bound key, the path to the root, the root on chain", async () => {
    const { receipt, proof, onchain, bound } = fixture();
    const v = await verifyHostAnchor(receipt, proof, { bound, readAnchor: async (ref) => (ref.hour === HOUR && ref.providerIdHash === proof.provider_id_hash ? onchain : null), requireOnChain: true, providerId: "example-provider" });
    expect(v.valid).toBe(true);
    expect(v.onChain).toBe("match");
    expect(v.leaf).toBe(receipt.leaf!);
    const ids = v.checks.map((c) => c.id);
    expect(ids.indexOf("signature")).toBeLessThan(ids.indexOf("host.inclusion"));
    expect(ids.indexOf("host.inclusion")).toBeLessThan(ids.indexOf("host.onchain"));
    // Everything passes except the key window, which a raw enclave key does not have.
    for (const c of v.checks) expect([c.id, c.status]).toEqual([c.id, c.id === "key_window" ? "not_checked" : "pass"]);
  });

  test("without a reader the root on chain is not checked, and a root kept off chain says so", async () => {
    const { receipt, proof } = fixture();
    const v = await verifyHostAnchor(receipt, proof);
    expect(v.valid).toBe(true);
    expect(status(v, "host.onchain")).toBe("not_checked");
    expect(v.notChecked.join(" ")).toMatch(/bound/);
    const local = { ...proof, anchored: false, status: "local", anchor_hour: null, tx: null, block: null };
    expect(await verifyHostAnchor(receipt, local)).toMatchObject({ valid: true, onChain: "off_chain" });
    expect(await verifyHostAnchor(receipt, local, { requireOnChain: true })).toMatchObject({ valid: false, onChain: "off_chain" });
    expect((await verifyHostAnchor(receipt, proof, { requireOnChain: true })).valid).toBe(false);
    // Anchored but without the hour the root was posted under: nothing to read.
    expect((await verifyHostAnchor(receipt, { ...proof, anchor_hour: null }, { readAnchor: async () => null })).valid).toBe(false);
  });

  test("fails for a changed receipt, a wrong path, another attestation, key or provider, and a different on-chain record", async () => {
    const { receipt, proof, onchain, bound } = fixture();
    const fails = async (r: typeof receipt, p: HostAnchorProof, o: Parameters<typeof verifyHostAnchor>[2] = {}) => expect((await verifyHostAnchor(r, p, o)).valid).toBe(false);
    await fails({ ...receipt, payload: { ...receipt.payload, status: 500 } }, proof);
    await fails(receipt, { ...proof, proof: ["0x" + "5b".repeat(32)] });
    await fails(receipt, { ...proof, root: "0x" + "00".repeat(32) });
    await fails(receipt, { ...proof, leaf: SIBLING });
    await fails(receipt, { ...proof, attestation_ref: "ee".repeat(32) });
    await fails(receipt, { ...proof, receipt_key: { ...proof.receipt_key, key_id: "0000000000000000" } }, { bound });
    await fails(receipt, { ...proof, provider_id_hash: providerIdHash("someone-else") });
    await fails(receipt, proof, { providerId: "someone-else" });
    await fails(receipt, proof, { bound: { ...bound, attestationRef: "ee".repeat(32) } });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, root: "0x" + "77".repeat(32) }) });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, providerId: providerIdHash("someone-else") }) });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, count: 3 }) });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, hour: HOUR + 3600 }) });
    await fails(receipt, proof, { readAnchor: async () => null });
    await fails(receipt, proof, { readAnchor: async () => Promise.reject(new Error("rpc down")) });
  });
});

describe("the anchor program's host roots", () => {
  const pid = providerIdHash("example-provider");

  test("hostRootAddress derives the HostRoot PDA [\"host_root\", provider_id_hash, hour LE] like @solana/web3.js", () => {
    const le = Buffer.alloc(8);
    le.writeBigInt64LE(BigInt(HOUR));
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("host_root"), Buffer.from(hexToBytes(pid.slice(2))), le], new PublicKey(PROGRAM_ID));
    expect(hostRootAddress(PROGRAM_ID, pid, HOUR)).toBe(expected.toBase58());
    expect(hostRootAddress(PROGRAM_ID, pid, HOUR + 3600)).not.toBe(expected.toBase58());
    expect(() => hostRootAddress(PROGRAM_ID, pid, HOUR + 1)).toThrow(/hour boundary/);
    expect(() => hostRootAddress(PROGRAM_ID, "0x" + "ab".repeat(16), HOUR)).toThrow(/32 bytes/);
  });

  test("decodeHostRoot reads the account layout and refuses other accounts", () => {
    const root: AttestedAnchor = { providerId: pid, root: "0x" + "c3".repeat(32), hour: HOUR, count: 2, signer: SIGNER, anchoredAt: HOUR + 90 };
    expect(decodeHostRoot(encodeHostRoot(root))).toEqual(root);
    const other = encodeHostRoot(root);
    other[0] ^= 1;
    expect(decodeHostRoot(other)).toBeNull();
    expect(decodeHostRoot(encodeHostRoot(root).slice(0, 100))).toBeNull();
  });

  test("readAttestedAnchor fetches the account over JSON-RPC and decodes it; a missing account is null; a foreign owner or a bad layout is an error", async () => {
    const root: AttestedAnchor = { providerId: pid, root: "0x" + "c3".repeat(32), hour: HOUR, count: 2, signer: SIGNER, anchoredAt: HOUR + 90 };
    const address = hostRootAddress(PROGRAM_ID, pid, HOUR);
    const answers = new Map<string, unknown>([[address, { data: [Buffer.from(encodeHostRoot(root)).toString("base64"), "base64"], owner: PROGRAM_ID, lamports: 1, executable: false }]]);
    const { fetch, calls } = stubFetch({
      "POST /": async ({ init }) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: [string, { encoding: string; commitment: string }] };
        expect(body.method).toBe("getAccountInfo");
        expect(body.params[1]).toEqual({ encoding: "base64", commitment: "confirmed" });
        return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: answers.get(body.params[0]) ?? null } });
      },
    });
    const read = readAttestedAnchor("https://rpc.example/", PROGRAM_ID, fetch);
    expect(await read({ providerIdHash: pid, hour: HOUR })).toEqual(root);
    expect(await read({ providerIdHash: pid, hour: HOUR + 3600 })).toBeNull();
    expect(calls).toHaveLength(2);
    answers.set(address, { data: [Buffer.from(encodeHostRoot(root)).toString("base64"), "base64"], owner: SIGNER });
    await expect(read({ providerIdHash: pid, hour: HOUR })).rejects.toThrow(/not owned by the anchor program/);
    answers.set(address, { data: [Buffer.from(new Uint8Array(40)).toString("base64"), "base64"], owner: PROGRAM_ID });
    await expect(read({ providerIdHash: pid, hour: HOUR })).rejects.toThrow(/not a HostRoot/);
    const failing = readAttestedAnchor("https://rpc.example/", PROGRAM_ID, stubFetch({ "POST /": () => json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "node is behind" } }) }).fetch);
    await expect(failing({ providerIdHash: pid, hour: HOUR })).rejects.toThrow(/node is behind/);
    await expect(read({ providerIdHash: pid, hour: -3600 })).rejects.toThrow(/hour boundary/);
  });
});

describe.skipIf(!HAS_REAL_EVIDENCE)("fetchHostAnchorProof", () => {
  test("fetches the proof by leaf or by receipt, and null when no root holds it", async () => {
    const { receipt, proof } = fixture();
    const { fetch, calls } = stubFetch({
      [`/api/v1/host-anchors/proof/${receipt.leaf}`]: () => json({ data: proof }),
      "POST /api/v1/host-anchors/proof": () => json({ data: proof }),
    });
    expect(await fetchHostAnchorProof("https://router.example/", receipt.leaf!, fetch)).toEqual(proof);
    expect(await fetchHostAnchorProof("https://router.example", receipt, fetch)).toEqual(proof);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ receipt });
    expect(await fetchHostAnchorProof("https://router.example", "0x" + "01".repeat(32), fetch)).toBeNull();
  });
});
