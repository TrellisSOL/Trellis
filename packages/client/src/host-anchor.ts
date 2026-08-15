import type { BoundIdentity } from "./attestation.js";
import { base64ToBytes, bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import type { Ed25519Verifier } from "./ed25519.js";
import { sha256SyncHex } from "./hash.js";
import { POST_HOST_ROOT_DISCRIMINATOR, canonicalBytes, hostRootMemoLine, keyIdOf, receiptLeaf, verifyMemoLine, verifyMerkleProof, verifyProgramPost, verifyReceipt, type AnchorerKey, type SolanaRpc } from "./receipts.js";
import { verifySidecarReceipt } from "./sidecar.js";
import { base58Encode, findProgramAddress, publicKeyBytes } from "./solana.js";
import type { Check, Fetch, ReceiptEnvelope } from "./types.js";

// Per-host anchors of enclave receipts. The router collects each attested host's sidecar receipt leaves, keeps those
// signed by the receipt key the host's attestation binds, and roots them per host and hour; where it runs with a
// configured chain it posts each root to the trellis_anchor program on Solana as post_host_root(sha256(provider id),
// hour, root, count), one HostRoot account per (host, hour) at the PDA ["host_root", provider_id_hash, hour LE]. This
// checks a sidecar receipt against the proof the router returns for it, in the spec's order: the signature, then the
// Merkle path to the root, then (where the root was posted) the root on chain, read straight from that account.
// A router in memo mode posts each host root as one memo line signed by its anchorer key instead
// (`trellis:hostroot:v1:<network>:<provider id hash>:<hour>:<count>:<root>`): there is no account to read, so the check
// goes through the transaction the proof names (receipts.ts `verifyMemoLine`, which also says how that is weaker than
// the program). The same transaction path confirms a program root whose account was closed after 400 days.
//
// Which of the two it is, on which network, under which program id and which anchorer keys, is the CALLER's setting
// (`mode`, `network`, `programId`, `anchorers`; receipts.ts `anchorTrustFromDocument`), never the proof's: the proof's
// `mode`, `contract`, `network` and `anchorer` are the router's statement and are only compared with the settings
// (security review round 3, R3-04).

export const HOST_ANCHOR_PROOF_PATH = "/api/v1/host-anchors/proof";

/** The answer of GET /api/v1/host-anchors/proof/{leaf} and POST /api/v1/host-anchors/proof (`data`). */
export type HostAnchorProof = {
  rid?: string;
  leaf: string;
  rooted: boolean;
  /** True only when the root was posted on chain and confirmed. */
  anchored: boolean;
  /** "confirmed" (on chain), "pending" (to be posted), "late" (posted after the lateness bound: not an anchor), "conflict" (the anchorer signed another root for the host and hour) or "local" (kept off chain). */
  status: string;
  provider: string;
  /** sha256 of the provider id's bytes, 0x-prefixed: the provider id the root is posted under. */
  provider_id_hash: string;
  /** 64 hex: SHA-256 of the boot quote the router verified. */
  attestation_ref: string;
  /** The key the router checked every leaf of this root against: the one the host's quote binds. */
  receipt_key: { key_id: string; public_key: string };
  root_id?: number;
  root: string;
  leaf_index: number;
  proof: string[];
  count?: number;
  window?: { from: string; to: string };
  /** Kept from the earlier proof shape; the Solana anchor program keys host roots by (provider id hash, hour), not by index. */
  anchor_index?: number | null;
  /** The on-chain hour (unix seconds, a multiple of 3600) the root was posted under, once posted. */
  anchor_hour?: number | null;
  /** Transaction signature of the anchoring transaction, once posted. */
  tx: string | null;
  /** Slot the anchoring transaction landed in. */
  block: number | null;
  /** CAIP-2 style chain name, e.g. "solana:mainnet". */
  chain?: string;
  /** The anchor program id the root was posted to. */
  contract?: string | null;
  /** How the root was posted: "program" (a HostRoot account), "memo" (a line signed by the anchorer), null when not posted. */
  mode?: "memo" | "program" | null;
  /** Memo mode: the anchorer key that signed the line, and the line itself. */
  anchorer?: string | null;
  memo?: string | null;
  memo_program?: string | null;
  /** The cluster's CAIP-2 id, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": part of every memo line. */
  network?: string;
};

/**
 * One host root as the anchor program stores it, hashes as 0x-prefixed hex: the provider id hash and the root, the hour
 * it was posted under, the leaf count, the receipt signer current at the time and the post time. Null when the program
 * holds no root for that (host, hour).
 */
export type AttestedAnchor = { providerId: string; root: string; hour: number; count: number; signer: string; anchoredAt: number };
export type AttestedAnchorRef = { providerIdHash: string; hour: number };
export type AttestedAnchorReader = (ref: AttestedAnchorRef) => Promise<AttestedAnchor | null>;

export type VerifyHostAnchorOptions = {
  /**
   * The identity verifyProvider established for the host. With it the receipt is checked against what this client
   * verified itself (signature under the bound key, same attestation, same model digest, not simulated). Without it
   * the signature is checked under the key the proof names, which is the router's statement.
   */
  bound?: BoundIdentity;
  /**
   * Reads a host root from the chain (readAttestedAnchor does it over Solana JSON-RPC, for the program id YOU give it).
   * Checks an anchored root on chain. Program mode only: with it and no `mode`, program mode is what you expect.
   */
  readAnchor?: AttestedAnchorReader;
  /**
   * A Solana JSON-RPC caller (receipts.ts `jsonRpc`). Checks a root through the transaction that posted it: the only way
   * in memo mode, and the way for a program root whose account was closed. Needs `mode`, `network` and `anchorers`, and
   * in program mode `programId`.
   */
  rpc?: SolanaRpc;
  /** The anchor mode and network you expect, and in program mode the trellis_anchor program id you trust. A proof's own are never used. */
  mode?: "memo" | "program";
  network?: string;
  programId?: string | null;
  genesisHash?: string;
  /** The anchorer keys you trust (receipts.ts `fetchAnchorKeys`, or your own), and optionally the first key you pinned. */
  anchorers?: AnchorerKey[];
  pinnedAnchorer?: string;
  /** Memo mode: how long after its hour closed a line may land (default 6 hours), and whether a later one is accepted. */
  maxLateSeconds?: number;
  allowLate?: boolean;
  /** Fail unless the root is on chain and matches it. */
  requireOnChain?: boolean;
  /** The provider the client expects the root to name. */
  providerId?: string;
  ed25519?: Ed25519Verifier;
};

export type HostAnchorVerification = {
  /** No check failed, the signature and the inclusion passed and, with requireOnChain, the root is on chain. */
  valid: boolean;
  leaf: string | null;
  /** "match": the on-chain record equals the proof's root, provider and attestation; "off_chain": kept off chain. */
  onChain: "match" | "mismatch" | "off_chain" | "not_checked";
  checks: Check[];
  notChecked: string[];
};

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const skip = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

export const providerIdHash = (providerId: string) => "0x" + sha256SyncHex(utf8(providerId));

export async function verifyHostAnchor(receipt: ReceiptEnvelope, proof: HostAnchorProof, opts: VerifyHostAnchorOptions = {}): Promise<HostAnchorVerification> {
  const checks: Check[] = [];
  const notChecked = ["That the host put every receipt it signed in its leaf feed: an anchor covers only the leaves it was given."];
  const payload = (receipt?.payload ?? {}) as Record<string, unknown>;
  const p = (proof ?? {}) as Partial<HostAnchorProof>;

  // 1. Signature: under the key the client verified itself when it has one, else under the key the proof names.
  if (opts.bound) {
    const v = await verifySidecarReceipt(receipt, opts.bound, { ed25519: opts.ed25519 });
    checks.push(...v.checks.filter((c) => c.id !== "anchor_proof"));
    const boundId = await keyIdOf(hexToBytes(opts.bound.receiptPubkey)).catch(() => "");
    checks.push(boundId && boundId === p.receipt_key?.key_id ? pass("host.receipt_key", "the router rooted this leaf under the key your attestation check bound") : fail("host.receipt_key", "The proof names a different receipt key than the attestation you verified binds."));
  } else if (typeof p.receipt_key?.public_key === "string") {
    const v = await verifyReceipt(receipt, { publicKeyHex: p.receipt_key.public_key, ed25519: opts.ed25519 });
    checks.push(...v.checks.filter((c) => c.id !== "anchor_proof"));
    checks.push(p.receipt_key.key_id === receipt?.key_id ? pass("host.receipt_key", `signed by ${receipt.key_id}, the key the proof names`) : fail("host.receipt_key", "The receipt names a different key than the proof."));
    notChecked.push("That the proof's receipt key is the one the host's quote binds: pass `bound` from verifyProvider to check it yourself.");
  } else {
    checks.push(fail("signature", "No key to check the signature: pass `bound`, or a proof that names its receipt key."));
  }

  // 2. The leaf this receipt makes, and that it is the leaf the proof is for.
  let leaf: string | null = null;
  try {
    leaf = receiptLeaf(canonicalBytes(payload), base64ToBytes(String(receipt?.sig ?? "")));
  } catch {
    leaf = null;
  }
  checks.push(leaf && leaf === lower(p.leaf) ? pass("host.leaf", "the proof is for this receipt's leaf") : fail("host.leaf", "The proof is for a different leaf than this receipt makes."));
  checks.push(payload.attestation_ref === p.attestation_ref ? pass("host.attestation_ref", "the root was built under the attestation this receipt names") : fail("host.attestation_ref", "The root was built under a different attestation than the receipt names."));
  const expectedHash = typeof p.provider === "string" ? providerIdHash(opts.providerId ?? p.provider) : "";
  if (opts.providerId && p.provider !== opts.providerId) checks.push(fail("host.provider", `The proof names provider ${String(p.provider)}, not ${opts.providerId}.`));
  else checks.push(expectedHash && expectedHash === lower(p.provider_id_hash) ? pass("host.provider", `rooted for provider ${p.provider}`) : fail("host.provider", "The proof's provider id hash is not sha256 of its provider id."));

  // 3. The Merkle path from the leaf to the root.
  const included = !!leaf && Array.isArray(p.proof) && typeof p.root === "string" && verifyMerkleProof(leaf, p.proof, p.root);
  checks.push(included ? pass("host.inclusion", `leaf is under root ${String(p.root).slice(0, 10)}…`) : fail("host.inclusion", "The Merkle path does not lead from this receipt's leaf to the root."));

  // 4. The root on chain, where it was posted. How it was posted is the caller's setting, not the proof's.
  let onChain: HostAnchorVerification["onChain"] = "not_checked";
  const mode = opts.mode ?? (opts.readAnchor ? "program" : null);
  if (!p.anchored) {
    onChain = "off_chain";
    const detail = `The root is kept off chain (status ${String(p.status)}): until it is posted it is only the router's statement.`;
    checks.push(opts.requireOnChain ? fail("host.onchain", detail) : skip("host.onchain", detail));
  } else if (!opts.rpc && !opts.readAnchor) {
    const detail = "Pass rpc with the mode, network and anchorer keys you expect (or readAnchor for a program root) to check the root on chain.";
    checks.push(opts.requireOnChain ? fail("host.onchain", detail) : skip("host.onchain", detail));
  } else if (!mode) {
    checks.push(fail("host.onchain", "Say which anchor mode you expect (`mode`): the mode a proof names is the router's statement and is not used."));
  } else if (p.mode && p.mode !== mode) {
    onChain = "mismatch";
    checks.push(fail("host.onchain", `The proof says its root was posted in ${p.mode} mode, but you expect ${mode} mode.`));
  } else if (mode === "memo" || !opts.readAnchor) {
    // Through the posting transaction: a memo line signed by the anchorer, or post_host_root for the program.
    const hour = p.anchor_hour, count = p.count;
    if (!opts.rpc || typeof hour !== "number" || typeof count !== "number" || typeof p.tx !== "string") {
      const detail = !opts.rpc ? "Pass rpc (and the anchorer keys you trust) to check the root's transaction on chain." : "The proof says anchored but gives no hour, count or transaction.";
      checks.push(fail("host.onchain", detail));
    } else if (!opts.network) {
      checks.push(fail("host.onchain", "Say which network you expect (`network`): the network a proof names is not used."));
    } else if (mode === "program" && (typeof opts.programId !== "string" || !opts.programId)) {
      checks.push(fail("host.onchain", "Program mode needs the anchor program id you trust (`programId`): the program a proof names is not used."));
    } else if (mode === "program" && typeof p.contract === "string" && p.contract !== opts.programId) {
      onChain = "mismatch";
      checks.push(fail("host.onchain", `The proof names anchor program ${p.contract}, but you trust ${opts.programId}.`));
    } else {
      const line = hostRootMemoLine({ network: opts.network, providerIdHash: String(p.provider_id_hash), hour, count, root: String(p.root) });
      let v: Awaited<ReturnType<typeof verifyMemoLine>> | null = null;
      if (mode === "memo") v = line ? await verifyMemoLine({ tx: p.tx, line: line.line }, { rpc: opts.rpc, mode, network: opts.network, genesisHash: opts.genesisHash, anchorers: opts.anchorers, pinnedAnchorer: opts.pinnedAnchorer, maxLateSeconds: opts.maxLateSeconds, allowLate: opts.allowLate, ed25519: opts.ed25519 }) : null;
      else if (line) {
        const pid = hexToBytes(String(p.provider_id_hash).replace(/^0x/, "")), rootBytes = hexToBytes(String(p.root).replace(/^0x/, ""));
        const le = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };
        v = await verifyProgramPost({ tx: p.tx, programId: opts.programId as string, hour, data: new Uint8Array([...POST_HOST_ROOT_DISCRIMINATOR, ...pid, ...le(hour), ...rootBytes, ...le(count)]) }, { rpc: opts.rpc, network: opts.network, genesisHash: opts.genesisHash, anchorers: opts.anchorers, pinnedAnchorer: opts.pinnedAnchorer, ed25519: opts.ed25519 });
      }
      if (!v) checks.push(fail("host.onchain", "The proof does not name a provider id hash, an hour, a count and a root to look for on chain."));
      else {
        onChain = v.valid ? "match" : v.status === "unknown" ? "not_checked" : "mismatch";
        const why = (v.checks.find((c) => c.status === "fail") ?? v.checks.find((c) => c.status === "not_checked"))?.detail;
        checks.push(v.valid ? pass("host.onchain", `the host root for hour ${hour} was posted in transaction ${p.tx.slice(0, 12)}… by ${v.anchorer}${v.conflicts.length ? `; the anchorer also signed a different line for this hour later (${v.conflicts.join(", ")})` : ""}`) : fail("host.onchain", why ?? "The root's transaction could not be confirmed."));
        notChecked.push(...v.notChecked);
        if (mode === "memo") notChecked.push("That no second line can ever be signed for this host and hour: in memo mode nothing on chain prevents it; the earliest finalized line is the root.");
      }
    }
  } else if (typeof p.anchor_hour !== "number") {
    checks.push(fail("host.onchain", "The proof says anchored but gives no anchor hour."));
  } else {
    try {
      const onchain = await opts.readAnchor({ providerIdHash: String(p.provider_id_hash), hour: p.anchor_hour });
      const same = !!onchain && lower(onchain.root) === lower(p.root) && lower(onchain.providerId) === lower(p.provider_id_hash) && onchain.hour === p.anchor_hour && (typeof p.count !== "number" || onchain.count === p.count);
      onChain = same ? "match" : "mismatch";
      checks.push(same ? pass("host.onchain", `the host root for hour ${p.anchor_hour} on chain holds this root for this provider`) : fail("host.onchain", onchain ? "The on-chain host root holds a different root, provider or count." : `The anchor program has no host root for this provider at hour ${p.anchor_hour}.`));
    } catch (e) {
      checks.push(fail("host.onchain", `Reading the on-chain anchor failed: ${(e as Error).message}`));
    }
  }

  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const valid = checks.every((c) => c.status !== "fail") && status("signature") === "pass" && status("host.inclusion") === "pass" && (!opts.requireOnChain || onChain === "match");
  return { valid, leaf, onChain, checks, notChecked };
}

/** The proof for a sidecar receipt (or its leaf) from a router. */
export async function fetchHostAnchorProof(baseUrl: string, receiptOrLeaf: ReceiptEnvelope | string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<HostAnchorProof | null> {
  const base = baseUrl.replace(/\/$/, "");
  const res =
    typeof receiptOrLeaf === "string"
      ? await fetchImpl(`${base}${HOST_ANCHOR_PROOF_PATH}/${receiptOrLeaf}`, { signal, headers: { accept: "application/json" } })
      : await fetchImpl(`${base}${HOST_ANCHOR_PROOF_PATH}`, { method: "POST", signal, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ receipt: receiptOrLeaf }) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${HOST_ANCHOR_PROOF_PATH} failed with ${res.status}`);
  return ((await res.json()) as { data: HostAnchorProof }).data;
}

// ---- The anchor program's HostRoot account -----------------------------------------------------------------------------

/** Anchor account discriminator of trellis_anchor::HostRoot (sha256("account:HostRoot")[0..8], from the program's IDL). */
export const HOST_ROOT_DISCRIMINATOR = new Uint8Array([205, 99, 22, 98, 22, 69, 138, 15]);
export const SECONDS_PER_HOUR = 3600;

/** The HostRoot PDA for (sha256(provider id), hour): ["host_root", provider_id_hash (32), hour as i64 LE]. */
export function hostRootAddress(programId: string, providerIdHash: string, hour: number): string {
  const pid = hexToBytes(providerIdHash.replace(/^0x/, ""));
  if (pid.length !== 32) throw new Error("provider id hash must be 32 bytes");
  if (!Number.isSafeInteger(hour) || hour < 0 || hour % SECONDS_PER_HOUR !== 0) throw new Error("anchor hour must be unix seconds on an hour boundary");
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigInt64(0, BigInt(hour), true);
  return findProgramAddress([utf8("host_root"), pid, le], publicKeyBytes(programId)).address;
}

/** Decode a HostRoot account's bytes; null when the data is another account type or too short. */
export function decodeHostRoot(data: Uint8Array): AttestedAnchor | null {
  // discriminator(8) provider_id_hash(32) hour i64 root(32) count u64 signer(32) posted_at i64 bump u8
  if (data.length < 8 + 32 + 8 + 32 + 8 + 32 + 8 + 1) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== HOST_ROOT_DISCRIMINATOR[i]) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  const providerId = "0x" + bytesToHex(data.slice(at, at + 32)); at += 32;
  const hour = Number(view.getBigInt64(at, true)); at += 8;
  const root = "0x" + bytesToHex(data.slice(at, at + 32)); at += 32;
  const count = Number(view.getBigUint64(at, true)); at += 8;
  const signer = base58Encode(data.slice(at, at + 32)); at += 32;
  const anchoredAt = Number(view.getBigInt64(at, true));
  return { providerId, root, hour, count, signer, anchoredAt };
}

/**
 * A reader of the anchor program's host roots over Solana JSON-RPC, with no library: point it at an RPC endpoint you
 * trust for the cluster you expect, with the trellis_anchor program id YOU trust (from your own configuration or the
 * router's key document; never the `contract` a proof names, which would let a proof choose its own program). It
 * derives the HostRoot address for (provider id hash, hour), fetches the account (getAccountInfo, base64) and decodes it.
 */
export function readAttestedAnchor(rpcUrl: string, programId: string, fetchImpl: Fetch = fetch, commitment: "confirmed" | "finalized" = "confirmed"): AttestedAnchorReader {
  return async ({ providerIdHash, hour }) => {
    const address = hostRootAddress(programId, providerIdHash, hour);
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment }] }) });
    const j = (await res.json().catch(() => null)) as { result?: { value?: { data?: [string, string]; owner?: string } | null }; error?: { message?: string } } | null;
    if (!j || j.error) throw new Error(`getAccountInfo failed: ${j?.error?.message ?? `HTTP ${res.status}`}`);
    const value = j.result?.value;
    if (!value) return null;
    if (value.owner && value.owner !== programId) throw new Error("the host root account is not owned by the anchor program");
    const data = Array.isArray(value.data) ? base64ToBytes(value.data[0]) : null;
    if (!data) throw new Error("getAccountInfo returned no account data");
    const root = decodeHostRoot(data);
    if (!root) throw new Error("the account at the host root address is not a HostRoot");
    return root;
  };
}
