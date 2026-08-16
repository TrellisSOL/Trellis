import { validRouteExplanation } from "./route-explanation.js"; // V84
import { base64ToBytes, bytesToHex, concatBytes, equalBytes, hexToBytes, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { defaultEd25519Verify, UnsupportedCrypto, type Ed25519Verifier } from "./ed25519.js";
import { sha256, sha256Sync } from "./hash.js";
import type { AnchorProof, Check, Fetch, JwkKey, KeySet, ReceiptEnvelope } from "./types.js";

// Receipt verification. A receipt is a JSON payload plus an Ed25519 signature over the payload's canonical JSON
// (keys sorted, no whitespace). The router publishes its signing keys at /.well-known/trellis-receipt-keys.json; a
// sidecar receipt is checked against the raw key its attestation binds. Nothing here talks to the server that issued
// the receipt except to fetch the key set, and a caller that pins keys never needs even that.

export const RECEIPT_KEYS_PATH = "/.well-known/trellis-receipt-keys.json";

/** Bytes that were signed: the canonical JSON of the payload. Same rule as the router (`canonicalBytes`). */
export const canonicalBytes = (payload: unknown): Uint8Array => utf8(canonicalJson(payload));

/** The key id the router derives: the first 16 hex characters of sha256(raw public key). */
export async function keyIdOf(rawPublicKey: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(rawPublicKey)).slice(0, 16);
}

/**
 * sha256(sha256(canonical bytes || signature)), 0x-prefixed. The router's receipt leaf (src/receipts/merkle.ts) and the
 * Solana anchor program must use the same rule; a mismatch makes every inclusion proof fail.
 */
export function receiptLeaf(canonical: Uint8Array, signature: Uint8Array): string {
  return "0x" + bytesToHex(sha256Sync(sha256Sync(concatBytes(canonical, signature))));
}

/** The deepest Merkle path the check follows (a tree of 2^64 leaves). */
export const MAX_PROOF_DEPTH = 64;
/**
 * Sorted-pair sha256 Merkle inclusion (node = sha256(min(a,b) || max(a,b))), the scheme the router's anchors use. The
 * leaf, the root and every sibling must be 32 bytes and the path at most `MAX_PROOF_DEPTH` long: anything else is no
 * path (false, never a throw).
 */
export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  try {
    if (!Array.isArray(proof) || proof.length > MAX_PROOF_DEPTH) return false;
    let h = hexToBytes(leaf);
    const r = hexToBytes(root);
    if (h.length !== 32 || r.length !== 32) return false;
    for (const p of proof) {
      const q = hexToBytes(p);
      if (q.length !== 32) return false;
      const [a, b] = compare(h, q) < 0 ? [h, q] : [q, h];
      h = sha256Sync(concatBytes(a, b));
    }
    return equalBytes(h, r);
  } catch {
    return false;
  }
}
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * The key document as the router publishes it: the keys, the version of the list (it counts the keys, so it rises with
 * every rotation) and how long this copy may be relied on. A copy past `expires_at` may miss a rotation: fetch it again.
 */
export type PublishedKeySet = KeySet & { version?: number; issued_at?: string; expires_at?: string };

/**
 * Why a key document (the whole document, or its `anchor` part) cannot be relied on, or null: it expired, its version
 * does not count the keys it lists, or it is older than `minVersion` (a version you have already seen). The version of
 * a list is the number of keys in it (keys are added, never removed), whether or not the document also states it. A
 * document without an expiry (an older router) is not refused for that.
 */
export function keyDocumentProblem(doc: unknown, o: { now?: number; list?: "keys" | "anchorers"; minVersion?: number; clockSkewMs?: number } = {}): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.expires_at !== undefined && d.expires_at !== null) {
    const until = typeof d.expires_at === "string" ? Date.parse(d.expires_at) : NaN;
    if (!Number.isFinite(until)) return "its expires_at is not a date";
    if (until + (o.clockSkewMs ?? 0) < (o.now ?? Date.now())) return `it expired at ${d.expires_at}: fetch it again from the router`;
  }
  const list = d[o.list ?? "keys"];
  const listed = Array.isArray(list) ? list.length : null;
  if (d.version !== undefined && d.version !== null) {
    if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 0) return "its version is not a whole number";
    if (listed !== null && d.version !== listed) return `its version (${d.version}) does not count the ${listed} key(s) it lists`;
  }
  const version = typeof d.version === "number" ? d.version : listed;
  if (o.minVersion !== undefined && version !== null && version < o.minVersion) return `it is an older version (${version} key(s)) than the one you have already seen (${o.minVersion})`;
  return null;
}

export async function fetchReceiptKeys(baseUrl: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<PublishedKeySet> {
  const res = await fetchImpl(baseUrl.replace(/\/$/, "") + RECEIPT_KEYS_PATH, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${RECEIPT_KEYS_PATH} failed with ${res.status}`);
  return parseKeySet(await res.json());
}

/** Accepts the published JWKS shape and drops nothing silently: a malformed set is an error. */
export function parseKeySet(json: unknown): PublishedKeySet {
  const keys = (json as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new Error("receipt key set has no keys array");
  for (const k of keys as Partial<JwkKey>[]) if (typeof k?.x !== "string" || typeof k?.kid !== "string") throw new Error("receipt key set contains a malformed key");
  // The version and the expiry travel with the keys, so every later use of the set can honour them (`verifyReceipt`).
  const d = json as { version?: unknown; issued_at?: unknown; expires_at?: unknown };
  return { keys: keys as JwkKey[], ...(typeof d.version === "number" ? { version: d.version } : {}), ...(typeof d.issued_at === "string" ? { issued_at: d.issued_at } : {}), ...(typeof d.expires_at === "string" ? { expires_at: d.expires_at } : {}) };
}

export type VerifyReceiptOptions = {
  /** The router's published keys: the set as fetched (`fetchReceiptKeys`: its version and expiry are honoured), or a bare list of keys you pinned. */
  keys?: PublishedKeySet | JwkKey[];
  /** A raw 32-byte Ed25519 public key in hex, for example a sidecar's `bindings.receipt_pubkey`. Used instead of `keys`. */
  publicKeyHex?: string;
  ed25519?: Ed25519Verifier;
  /** Tolerance when comparing a receipt's timestamp with its key's validity window. Default 5 minutes. */
  clockSkewMs?: number;
  /** The time a key document's `expires_at` is compared with (default: now), and the oldest `version` of it you accept. */
  now?: number;
  minKeyVersion?: number;
};

export type ReceiptVerification = {
  /** True only when the signature verifies under a key whose id is what it claims and no other check failed. */
  valid: boolean;
  keyId: string;
  checks: Check[];
  anchor: "proof_valid" | "proof_invalid" | "no_proof";
  /** What this function cannot establish on its own. */
  notChecked: string[];
};

const NOT_CHECKED_RECEIPT = [
  "That the signing key is the one registered on chain: compare the key id with ReceiptAnchor, or pin the key yourself.",
  "That the anchor root was posted on chain: an inclusion proof shows the receipt is under a root, not that the root was published, and the proof's own `status`, `tx` and `mode` are the router's statement. verifyPostedRoot checks that against the chain, under the mode, network and anchorer keys YOU configure.",
];

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const notChecked = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });

function payloadTime(payload: Record<string, unknown>): number | null {
  const ts = payload.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const issued = payload.issued;
  if (typeof issued === "string") {
    const t = Date.parse(issued);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export async function verifyReceipt(receipt: ReceiptEnvelope, opts: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  const checks: Check[] = [];
  const keyId = typeof receipt?.key_id === "string" ? receipt.key_id : "";
  const done = (anchor: ReceiptVerification["anchor"]): ReceiptVerification => ({
    valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signature" && c.status === "pass"),
    keyId,
    checks,
    anchor,
    notChecked: NOT_CHECKED_RECEIPT,
  });

  if (!receipt || typeof receipt !== "object" || typeof receipt.payload !== "object" || receipt.payload === null || typeof receipt.sig !== "string" || !keyId) {
    checks.push(fail("shape", "A receipt needs payload, sig and key_id."));
    return done("no_proof");
  }
  checks.push(receipt.alg === undefined || receipt.alg === "Ed25519" ? pass("alg", "Ed25519") : fail("alg", `unsupported algorithm ${String(receipt.alg)}`));

  if (receipt.payload.route !== undefined) checks.push(validRouteExplanation(receipt.payload.route, receipt.payload.provider) ? pass("route", "Versioned routing summary; the signature covers it, not an independent selection check.") : fail("route", "Invalid route explanation.")); // V84

  // Which public key does this receipt claim, and is it one we were given?
  let raw: Uint8Array | null = null;
  let window: { from: number | null; to: number | null } | null = null;
  if (opts.publicKeyHex) {
    try {
      raw = hexToBytes(opts.publicKeyHex);
      if (raw.length !== 32) throw new Error("wrong length");
    } catch {
      checks.push(fail("key", "The supplied public key is not 32 bytes of hex."));
    }
    if (raw) {
      const derived = await keyIdOf(raw);
      checks.push(derived === keyId ? pass("key", `key id ${keyId} matches the supplied key`) : fail("key", `receipt key id ${keyId} is not the supplied key's id (${derived})`));
    }
  } else {
    const list = Array.isArray(opts.keys) ? opts.keys : opts.keys?.keys ?? [];
    // A key document that has expired, or is older than a version already seen, may miss a rotation: not a key source.
    const stale = Array.isArray(opts.keys) ? null : keyDocumentProblem(opts.keys, { now: opts.now, list: "keys", minVersion: opts.minKeyVersion, clockSkewMs: opts.clockSkewMs ?? 300_000 });
    if (stale) checks.push(fail("key_document", `The key document is not usable: ${stale}.`));
    const jwk = list.find((k) => k.kid === keyId);
    if (!jwk) {
      checks.push(fail("key", `Key ${keyId} is not in the published key set.`));
    } else if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      checks.push(fail("key", "The published key is not an Ed25519 key."));
    } else {
      try {
        raw = base64ToBytes(jwk.x);
        if (raw.length !== 32) throw new Error("wrong length");
        const derived = await keyIdOf(raw);
        checks.push(derived === keyId ? pass("key", `key ${keyId} is in the published set and its id matches the key bytes`) : fail("key", `the published key's id does not match its bytes (${derived})`));
        window = { from: jwk.valid_from ? Date.parse(jwk.valid_from) : null, to: jwk.retired_at ? Date.parse(jwk.retired_at) : null };
      } catch {
        raw = null;
        checks.push(fail("key", "The published key is malformed."));
      }
    }
  }

  // Signature over the canonical JSON of the payload.
  let sigBytes: Uint8Array | null = null;
  try {
    sigBytes = base64ToBytes(receipt.sig);
  } catch {
    checks.push(fail("signature", "The signature is not valid base64."));
  }
  const bytes = canonicalBytes(receipt.payload);
  if (raw && sigBytes && !checks.some((c) => c.id === "key" && c.status === "fail")) {
    try {
      const ok = await (opts.ed25519 ?? defaultEd25519Verify)(raw, bytes, sigBytes);
      checks.push(ok ? pass("signature", "Ed25519 signature over the canonical payload verifies") : fail("signature", "The signature does not verify for this payload and key."));
    } catch (e) {
      checks.push(e instanceof UnsupportedCrypto ? notChecked("signature", `This runtime cannot verify Ed25519: ${e.message}`) : fail("signature", (e as Error).message));
    }
  } else if (!checks.some((c) => c.id === "signature")) {
    checks.push(fail("signature", "Not verified: there is no usable key or signature."));
  }

  // Key validity window (router keys rotate weekly and old keys stay published).
  const t = payloadTime(receipt.payload);
  if (window && t !== null && (window.from !== null || window.to !== null)) {
    const skew = opts.clockSkewMs ?? 300_000;
    const early = window.from !== null && t < window.from - skew;
    const late = window.to !== null && t > window.to + skew;
    checks.push(early || late ? fail("key_window", "The receipt is dated outside its signing key's validity window.") : pass("key_window", "The receipt time falls inside its key's validity window"));
  } else {
    checks.push(notChecked("key_window", "No key window or receipt time to compare."));
  }

  // Leaf: recompute from the canonical bytes and signature.
  if (receipt.leaf && sigBytes) {
    const leaf = receiptLeaf(bytes, sigBytes);
    checks.push(leaf === receipt.leaf.toLowerCase() ? pass("leaf", "leaf = sha256(sha256(payload || signature)) matches") : fail("leaf", "The leaf does not match the payload and signature."));
  } else {
    checks.push(notChecked("leaf", "The receipt carries no leaf."));
  }

  // Anchor inclusion proof, when the receipt came with one.
  let anchor: ReceiptVerification["anchor"] = "no_proof";
  const proof: AnchorProof | null | undefined = receipt.anchor;
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string" && receipt.leaf) {
    const ok = verifyMerkleProof(receipt.leaf, proof.proof, proof.root);
    anchor = ok ? "proof_valid" : "proof_invalid";
    checks.push(ok ? pass("anchor_proof", `leaf is included under root ${proof.root.slice(0, 10)}…`) : fail("anchor_proof", "The inclusion proof does not lead from the leaf to the stated root."));
  } else {
    checks.push(notChecked("anchor_proof", "No anchor proof supplied (a receipt is anchored within the hour; fetch it again later)."));
  }
  return done(anchor);
}

// ---- A posted root, against the chain ----------------------------------------------------------------------------------
//
// An inclusion proof shows a receipt is under a root. `verifyPostedRoot` shows the root was published: it reads the
// transaction the proof names (`tx`) over Solana JSON-RPC and checks it without trusting the RPC for anything it can
// check itself.
//
// What it TRUSTS it takes from its caller, never from the proof (security review round 3, R3-04): the anchor mode, the
// network, the anchor program id and the anchorer keys are options. Take them from your own configuration, or from the
// `anchor` part of /.well-known/trellis-receipt-keys.json fetched by you from the router's own origin (`fetchAnchorKeys`
// and `anchorTrustFromDocument`), and pin the first anchorer key to rely on more than the router's word. A proof that
// names another mode, program or network than yours fails; without a mode and a network of your own nothing verifies.
//
//   memo      one SPL Memo transaction per hour signed by the router's anchorer key, carrying the line
//             trellis:root:v2:<network>:<hour>:<count>:<root>:<previous root's transaction> (v1, without the link,
//             for hours before the router's `memo_v2_from_hour`). Checked: the RPC serves the cluster your network
//             names (getGenesisHash); the transaction is FINALIZED and succeeded; the anchorer's Ed25519 signature over
//             the message bytes verifies here; a Memo v2 instruction that names the anchorer carries exactly that line;
//             the anchorer was your key for that hour (every rotation signed by the key before it and by the new key,
//             and the FIRST hand-over that key ever signed: its history is walked back to its beginning, R5-19)
//             and had not been retired when the line landed; the line landed no earlier than its hour and no later than
//             the lateness bound after it closed; the transaction a v2 line names is an earlier root line of the
//             anchorer; and no earlier finalized line of that key names another root for the hour.
//   program   trellis_anchor::post_root(hour, root, count), one account per hour. Checked from the posting transaction
//             (which also works after the account was closed, 400 days on): finalized, succeeded, exact arguments for
//             YOUR program id, signed by its authority, which must be your anchorer key for that hour.
//
// "Earliest for the hour" fails closed (R3-05): the anchorer's history is read from the line back to before the hour
// began. If that walk errors, is cut short, or ends at a node that does not keep its ledger that far back, the result
// is `status: "unknown"`, `earliest: null` and `valid: false`. Memo mode is weaker than the program, and no client can
// change that: nothing on chain stops the anchorer from signing a second line for an hour (this function looks for one
// and reports it; the earliest finalized line is the root); the RPC must still serve the old transactions (many prune
// them); all the weight rests on the anchorer key you trust; and a key list that misses a rotation lets the retired key
// pass for hours the new key owns.

/** One anchorer key as the router publishes it. The first has `from_hour` 0 and no `rotation_tx`. */
export type AnchorerKey = { key: string; from_hour: number; rotation_tx: string | null };
/** The `anchor` part of /.well-known/trellis-receipt-keys.json. It is not signed: fetch it yourself, from the router's origin. */
export type AnchorKeyDocument = { mode?: string; network?: string; program?: string | null; memo_program?: string | null; anchorer?: string | null; anchorers: AnchorerKey[]; memo_v2_from_hour?: number | null; max_late_seconds?: number | null; /** The version of the list, when stated: the number of anchorer keys in it, which rises with every rotation. */ version?: number; issued_at?: string; /** After this the copy may miss a rotation: fetch it again (`fetchAnchorKeys` carries it over from the document). */ expires_at?: string };
/** An anchor proof with what the router says about where its root was posted. None of it is a setting: it is what gets checked. */
export type PostedAnchorProof = AnchorProof & { mode?: "memo" | "program" | null; hour?: number | null; count?: number; anchorer?: string | null; memo?: string | null; network?: string; late?: boolean };
/** A Solana JSON-RPC call: returns `result`, throws on an RPC error. */
export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>;

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** sha256("global:post_root")[0..8] and sha256("global:post_host_root")[0..8], from the trellis_anchor IDL. */
export const POST_ROOT_DISCRIMINATOR = new Uint8Array([154, 210, 156, 158, 199, 27, 174, 35]);
export const POST_HOST_ROOT_DISCRIMINATOR = new Uint8Array([25, 195, 127, 184, 90, 53, 223, 102]);
/** How long after its hour closed a root may land and still count, unless you say otherwise. */
export const DEFAULT_MAX_LATE_SECONDS = 6 * 3600;
/**
 * The most a KEY DOCUMENT can make the lateness bound: 24 hours. The document is the router's own unsigned statement,
 * and without a ceiling a document that said thirty days let a root posted three days late into a gap verify
 * (security review round 5, R5-22). A longer bound is yours to set (`maxLateSeconds`), not the document's.
 */
export const MAX_DOCUMENT_LATE_SECONDS = 24 * 3600;
/** Genesis hashes of the public clusters, for network names that are not a CAIP-2 reference. */
export const KNOWN_GENESIS: Readonly<Record<string, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
const HOUR_S = 3600;
const B58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const MEMO_LINE = /trellis:[a-z]+:v[12]:[A-Za-z0-9:-]+/g;
/** Transactions a history walk reads at once: what bounds its memory, whatever the history holds. */
export const WALK_READ_BATCH = 16;
/** Lines one walk keeps (the earliest it saw). */
const WALK_KEEP_LINES = 64;
/** The walk FORWARD from a line only reports later lines and never decides a verdict: it keeps a budget of its own. */
const LATER_WALK = { maxPages: 20, maxReads: 2_000 };

/** A `SolanaRpc` over fetch: point it at any RPC endpoint you trust for the cluster your network names. */
export function jsonRpc(rpcUrl: string, fetchImpl: Fetch = fetch): SolanaRpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!j || j.error) throw new Error(`${method} failed: ${j?.error?.message ?? `HTTP ${res.status}`}`);
    return j.result;
  };
}

/** The anchor part of a router's key document, fetched from the router's own origin; null when it publishes none. */
export async function fetchAnchorKeys(baseUrl: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<AnchorKeyDocument | null> {
  const res = await fetchImpl(baseUrl.replace(/\/$/, "") + RECEIPT_KEYS_PATH, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${RECEIPT_KEYS_PATH} failed with ${res.status}`);
  const doc = (await res.json()) as { anchor?: AnchorKeyDocument; issued_at?: unknown; expires_at?: unknown } | null;
  const anchor = doc?.anchor;
  if (!anchor || !Array.isArray(anchor.anchorers)) return null;
  // How long the copy may be relied on is said by the document the anchor part came in: it travels with the part.
  return { ...(typeof doc?.issued_at === "string" ? { issued_at: doc.issued_at } : {}), ...(typeof doc?.expires_at === "string" ? { expires_at: doc.expires_at } : {}), ...anchor };
}

/** What a caller trusts about a router's anchoring: the settings of `verifyPostedRoot` and `verifyHostAnchor`. */
export type AnchorTrust = {
  mode: "memo" | "program";
  /** The cluster's CAIP-2 id (solana:<first 32 characters of the genesis hash>), or mainnet-beta, devnet, testnet. */
  network: string;
  anchorers: AnchorerKey[];
  /** Program mode: the trellis_anchor program id you trust. */
  programId?: string | null;
  memoV2FromHour?: number | null;
  maxLateSeconds?: number;
};
/**
 * Turn a key document YOU fetched from the router's origin (`fetchAnchorKeys`) into settings. Never pass the key list
 * that rides inside a proof pack: it is the pack's own statement. Throws when the document names no mode or network,
 * when it has expired (`expires_at`), when a `version` it states does not count the anchorer keys it lists, or when it
 * lists fewer keys than `minVersion` (the number in a copy you have already seen): such a document may miss a key
 * rotation, and a verifier that misses one accepts the retired key for hours the new key owns.
 */
export function anchorTrustFromDocument(doc: AnchorKeyDocument, o: { now?: number; minVersion?: number } = {}): AnchorTrust {
  const stale = keyDocumentProblem(doc, { now: o.now, list: "anchorers", minVersion: o.minVersion });
  if (stale) throw new Error(`the key document is not usable: ${stale}`);
  if (doc.mode !== "memo" && doc.mode !== "program") throw new Error("the key document does not say whether roots are posted in memo or program mode");
  if (typeof doc.network !== "string" || !networkRef(doc.network)) throw new Error("the key document does not name the network");
  return {
    mode: doc.mode, network: doc.network, anchorers: doc.anchorers, programId: doc.mode === "program" ? doc.program ?? null : null,
    memoV2FromHour: validHour(doc.memo_v2_from_hour) ? doc.memo_v2_from_hour : null,
    ...(validCount(doc.max_late_seconds) ? { maxLateSeconds: Math.min(doc.max_late_seconds, MAX_DOCUMENT_LATE_SECONDS) } : {}),
  };
}

/** Why a list of anchorer keys cannot be used, or null. */
export function anchorerKeysProblem(keys: readonly AnchorerKey[] | undefined | null): string | null {
  if (!Array.isArray(keys) || !keys.length) return "no anchorer key is configured";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof k?.key !== "string" || !B58_KEY.test(k.key) || !Number.isSafeInteger(k.from_hour) || k.from_hour < 0 || k.from_hour % HOUR_S !== 0) return `anchorer key ${i} is malformed`;
    if (i === 0 ? k.from_hour !== 0 || !!k.rotation_tx : !k.rotation_tx || k.from_hour <= keys[i - 1].from_hour || k.key === keys[i - 1].key) return `anchorer key ${i} does not follow the key before it`;
  }
  return null;
}

const networkRef = (network: unknown): string | null => {
  const n = typeof network === "string" ? network : "";
  const ref = n.includes(":") ? n.slice(n.indexOf(":") + 1) : n;
  return /^[A-Za-z0-9-]{1,44}$/.test(ref) ? ref : null;
};
/** Whether a line's network name `ref` names the cluster with this genesis hash (`pinned`: the genesis hash you gave for your network). */
export function networkNamesGenesis(ref: string, genesis: string, pinned?: { ref: string; genesis: string } | null): boolean {
  if (!genesis) return false;
  if (pinned && pinned.ref === ref) return pinned.genesis === genesis;
  if (KNOWN_GENESIS[ref]) return KNOWN_GENESIS[ref] === genesis;
  return /^[1-9A-HJ-NP-Za-km-z]{32}$/.test(ref) && genesis.startsWith(ref);
}
const hex64 = (v: unknown): string | null => {
  const h = typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
};
const validHour = (h: unknown): h is number => typeof h === "number" && Number.isSafeInteger(h) && h >= 0 && h % HOUR_S === 0;
const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** `trellis:root:v1:<network>:<hour>:<count>:<root>` and the part of it that identifies the hour; null when a field is unusable. */
export function rootMemoLine(a: { network?: string; hour?: number | null; count?: number; root: string }): { line: string; prefix: string } | null {
  const ref = networkRef(a.network), root = hex64(a.root);
  if (!ref || !root || !validHour(a.hour) || !validCount(a.count)) return null;
  return { line: `trellis:root:v1:${ref}:${a.hour}:${a.count}:${root}`, prefix: `trellis:root:v1:${ref}:${a.hour}:` };
}
/** `trellis:hostroot:v1:<network>:<provider id hash>:<hour>:<count>:<root>`, for one attested host's root. */
export function hostRootMemoLine(a: { network?: string; providerIdHash: string; hour?: number | null; count?: number; root: string }): { line: string; prefix: string } | null {
  const ref = networkRef(a.network), root = hex64(a.root), pid = hex64(a.providerIdHash);
  if (!ref || !root || !pid || !validHour(a.hour) || !validCount(a.count)) return null;
  return { line: `trellis:hostroot:v1:${ref}:${pid}:${a.hour}:${a.count}:${root}`, prefix: `trellis:hostroot:v1:${ref}:${pid}:${a.hour}:` };
}

/** A root line as the router writes it: the router's own (v1, or v2 with the previous root's transaction) or one host's. */
export type RootLine = { kind: "root" | "hostroot"; version: 1 | 2; network: string; providerIdHash: string | null; hour: number; count: number; root: string; prev: string | null };
/** A hand-over line of an anchorer key: trellis:anchorer:v1:<network>:<from hour>:<new key>. */
export type HandOverLine = { network: string; fromHour: number; newAnchorer: string };
/** Strict, like the router's own parser: null for anything that is not exactly a hand-over line. */
export function parseHandOverLine(text: unknown): HandOverLine | null {
  const p = String(text ?? "").split(":");
  if (p.length !== 6 || p[0] !== "trellis" || p[1] !== "anchorer" || p[2] !== "v1" || !/^[A-Za-z0-9-]{1,44}$/.test(p[3]) || !/^(0|[1-9]\d{0,15})$/.test(p[4]) || !B58_KEY.test(p[5])) return null;
  const fromHour = Number(p[4]);
  return fromHour % HOUR_S === 0 ? { network: p[3], fromHour, newAnchorer: p[5] } : null;
}
/** Parse a root line strictly; null for anything else. */
export function parseRootLine(text: unknown): RootLine | null {
  const p = typeof text === "string" ? text.split(":") : [];
  const int = (v: string | undefined) => (v !== undefined && /^(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : null);
  if (p[0] !== "trellis" || !/^[A-Za-z0-9-]{1,44}$/.test(p[3] ?? "")) return null;
  if (p[1] === "root" && (p[2] === "v1" || p[2] === "v2")) {
    const hour = int(p[4]), count = int(p[5]);
    if (hour === null || count === null || hour % HOUR_S !== 0 || !/^[0-9a-f]{64}$/.test(p[6] ?? "")) return null;
    if (p[2] === "v1" && p.length === 7) return { kind: "root", version: 1, network: p[3], providerIdHash: null, hour, count, root: p[6], prev: null };
    if (p[2] === "v2" && p.length === 8 && (p[7] === "0" || B58_SIGNATURE.test(p[7]))) return { kind: "root", version: 2, network: p[3], providerIdHash: null, hour, count, root: p[6], prev: p[7] === "0" ? null : p[7] };
    return null;
  }
  if (p[1] === "hostroot" && p[2] === "v1" && p.length === 8) {
    const hour = int(p[5]), count = int(p[6]);
    if (hour === null || count === null || hour % HOUR_S !== 0 || !/^[0-9a-f]{64}$/.test(p[4]) || !/^[0-9a-f]{64}$/.test(p[7])) return null;
    return { kind: "hostroot", version: 1, network: p[3], providerIdHash: p[4], hour, count, root: p[7], prev: null };
  }
  return null;
}
const sameSubject = (a: RootLine, b: RootLine) => a.kind === b.kind && a.hour === b.hour && a.providerIdHash === b.providerIdHash;
const sameClaim = (a: RootLine, b: RootLine) => a.root === b.root && a.count === b.count;

type SignedTx = { slot: number; blockTime: number | null; signers: string[]; memos: { text: string; signers: string[] }[]; instructions: { programId: string; accounts: string[]; data: Uint8Array }[] };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

/** A transaction at finalized commitment, with every required signature verified here over the message bytes. `unavailable`: the RPC could not be asked at all. */
async function readSignedTransaction(rpc: SolanaRpc, signature: string, ed25519: Ed25519Verifier): Promise<{ ok: true; tx: SignedTx } | { ok: false; why: string; unavailable?: boolean; /** The transaction landed and failed: it carries no line. */ failedOnChain?: boolean }> {
  let t: { slot?: number; blockTime?: number | null; meta?: { err?: unknown } | null; transaction?: unknown } | null;
  try {
    t = (await rpc("getTransaction", [signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }])) as typeof t;
  } catch (e) {
    return { ok: false, unavailable: true, why: `the RPC could not be asked for the transaction (${(e as Error).message.slice(0, 100)})` };
  }
  if (!t) return { ok: false, why: "the RPC does not serve the transaction at finalized commitment: it is not final yet, or the endpoint no longer keeps that part of the history" };
  if (t.meta?.err) return { ok: false, failedOnChain: true, why: "the transaction failed on chain" };
  try {
    const raw = base64ToBytes(Array.isArray(t.transaction) ? String(t.transaction[0]) : "");
    let at = 0;
    const need = (n: number) => { if (at + n > raw.length) throw new Error("truncated transaction"); };
    const short = () => { let v = 0, shift = 0; for (;;) { need(1); const b = raw[at++]; v |= (b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7; if (shift > 14) throw new Error("bad length"); } };
    const take = (n: number) => { need(n); const out = raw.subarray(at, at + n); at += n; return out; };
    const signatures: Uint8Array[] = [];
    for (let n = short(); n > 0; n--) signatures.push(take(64));
    const message = raw.subarray(at);
    need(1);
    if (raw[at] & 0x80) { if ((raw[at] & 0x7f) !== 0) throw new Error("unsupported transaction version"); at++; }
    const required = take(3)[0];
    const keys: Uint8Array[] = [];
    for (let n = short(); n > 0; n--) keys.push(take(32));
    take(32); // recent blockhash
    const instructions: SignedTx["instructions"] = [];
    for (let n = short(); n > 0; n--) {
      const program = take(1)[0];
      const accounts = [...take(short())];
      const data = new Uint8Array(take(short()));
      // An instruction that reaches for an account loaded from a lookup table is not one this check reasons about.
      if (program < keys.length && accounts.every((i) => i < keys.length)) instructions.push({ programId: b58(keys[program]), accounts: accounts.map((i) => b58(keys[i])), data });
    }
    if (signatures.length !== required || keys.length < required) return { ok: false, why: "the transaction's signature count does not match its message" };
    if (b58(signatures[0]) !== signature) return { ok: false, why: "the RPC answered with a different transaction" };
    const signers: string[] = [];
    for (let i = 0; i < required; i++) {
      if (!(await ed25519(keys[i], message, signatures[i]))) return { ok: false, why: `signature ${i} does not verify over the transaction message` };
      signers.push(b58(keys[i]));
    }
    const memos = instructions.filter((ix) => ix.programId === MEMO_PROGRAM).map((ix) => ({ text: new TextDecoder().decode(ix.data), signers: ix.accounts.filter((a) => signers.includes(a)) }));
    return { ok: true, tx: { slot: Number(t.slot ?? 0), blockTime: typeof t.blockTime === "number" ? t.blockTime : null, signers, memos, instructions } };
  } catch (e) {
    return { ok: false, why: `the transaction does not parse (${(e as Error).message})` };
  }
}

export type PostedRootVerification = {
  /** No check failed, the transaction, its signer and its content were all confirmed, and nothing that matters stayed unknown. */
  valid: boolean;
  /** "verified", "failed" (a check refuted the proof or your settings do not cover it) or "unknown" (the RPC could not show what is needed). */
  status: "verified" | "failed" | "unknown";
  /** The mode YOU expected. */
  mode: "memo" | "program" | null;
  /** The key that signed the root's transaction. */
  anchorer: string | null;
  /** Memo mode: true when no earlier finalized line of the anchorer exists for the hour; null when that is not known. */
  earliest: boolean | null;
  /** Memo mode: the line landed after the lateness bound. */
  late: boolean;
  /** Memo mode, v2 lines: "verified" when the line names the actual previous root of the anchorer (or rightly says there is none); "not_checked" when that could not be established. */
  link: "verified" | "not_checked" | null;
  /** Memo mode: transactions in which the anchorer signed a different line for the same hour (a double post). */
  conflicts: string[];
  checks: Check[];
  notChecked: string[];
};
export type VerifyPostedRootOptions = {
  rpc: SolanaRpc;
  /** The anchor mode you expect. Required: a proof's own `mode` is never used. */
  mode?: "memo" | "program";
  /** The network you expect (CAIP-2 id, or mainnet-beta, devnet, testnet). Required: the RPC must serve it and the line must name it. */
  network?: string;
  /** The anchorer keys you trust, oldest first (`fetchAnchorKeys`, or your own). Required. */
  anchorers?: AnchorerKey[];
  /** The first anchorer key you pinned; the list must start with it. */
  pinnedAnchorer?: string;
  /** Program mode: the trellis_anchor program id you trust. Required there: a proof's own `contract` is never used. */
  programId?: string | null;
  /** The genesis hash of a network whose name is neither a CAIP-2 reference nor a public cluster's name. */
  genesisHash?: string;
  /** Root lines of this hour and later must be v2 lines (the key document's `memo_v2_from_hour`). */
  memoV2FromHour?: number | null;
  /** How long after its hour closed a line may land (default 6 hours), and whether a later one is accepted all the same. */
  maxLateSeconds?: number;
  allowLate?: boolean;
  ed25519?: Ed25519Verifier;
  /** false skips the walk through the anchorer's history (and with it the earliest-line rule). Default true. */
  walkHistory?: boolean;
  /**
   * Limits of your own on the walk back through the anchorer's history: pages of 1,000 signatures, and transactions
   * read. Unset (the default): none, the walk goes to the start of the hour, reading a bounded number of transactions
   * at a time. A walk a limit cuts short answers `status: "unknown"`, so a default limit would let a few thousand
   * transactions that merely name the anchorer make an honest proof unknowable (security review round 4, R4-09).
   */
  maxPages?: number;
  maxReads?: number;
};

/**
 * Check one line of one anchorer: on the cluster you expect, signed, exact, under the key you trust for its hour, in
 * time, linked, and the earliest for it. `verifyPostedRoot` and `verifyHostAnchor` both go through here.
 */
export async function verifyMemoLine(a: { tx: string; line: string; /** Accepted and ignored: the network is `opts.network`, the hour is read from the line. */ network?: string; hour?: number; prefix?: string }, opts: VerifyPostedRootOptions): Promise<PostedRootVerification> {
  const ed = opts.ed25519 ?? defaultEd25519Verify;
  const checks: Check[] = [];
  const notCheckedList: string[] = [];
  let unknown = false;
  const out = (over: Partial<PostedRootVerification> = {}): PostedRootVerification => {
    const failedAny = checks.some((c) => c.status === "fail");
    const valid = !failedAny && !unknown && checks.some((c) => c.id === "posted.content" && c.status === "pass");
    return { valid, status: valid ? "verified" : failedAny || !unknown ? "failed" : "unknown", mode: "memo", anchorer: null, earliest: null, late: false, link: null, conflicts: [], checks, notChecked: notCheckedList, ...over };
  };
  const dontKnow = (id: string, detail: string) => { unknown = true; checks.push(notChecked(id, detail)); notCheckedList.push(detail); };
  const claim = parseRootLine(a.line);
  const ref = networkRef(opts.network);
  if (!ref) { checks.push(fail("posted.config", "Say which network you expect (`network`): the line must name it and the RPC must serve it.")); return out(); }
  if (!claim || claim.network !== ref) { checks.push(fail("posted.content", `The expected line is not a root line for the network you configured (${opts.network}).`)); return out(); }
  const hour = claim.hour;
  const keys = opts.anchorers ?? [];
  const problem = anchorerKeysProblem(keys);
  if (problem) { checks.push(fail("posted.anchorer", `${problem}: in memo mode the anchorer key is what makes a line a root.`)); return out(); }
  if (opts.pinnedAnchorer && keys[0].key !== opts.pinnedAnchorer) { checks.push(fail("posted.anchorer", `The first anchorer key in your list is ${keys[0].key}, not the one you pinned.`)); return out(); }
  // The cluster: the same line on another cluster, or under another cluster's name, says nothing here.
  const pinnedGenesis = opts.genesisHash ? { ref, genesis: opts.genesisHash } : null;
  let genesis: string;
  try {
    genesis = String(await opts.rpc("getGenesisHash", []));
  } catch (e) {
    dontKnow("posted.cluster", `The RPC could not be asked which cluster it serves (${(e as Error).message.slice(0, 100)}).`);
    return out();
  }
  if (!networkNamesGenesis(ref, genesis, pinnedGenesis)) { checks.push(fail("posted.cluster", `The RPC serves the cluster with genesis hash ${genesis}, which is not the cluster your network (${opts.network}) names.`)); return out(); }
  checks.push(pass("posted.cluster", `the RPC serves the cluster ${opts.network} names`));
  // Walking a key's history. Only lines read from their own transaction, in a memo the key signed, count: the list's
  // memo field only picks which transactions to read, and only on a node shown to list memo text. No limit applies
  // unless you set one (R4-09); the candidates of a page are read WALK_READ_BATCH at a time, so memory does not grow
  // with the history.
  type Listed = { signature: string; blockTime?: number | null; err?: unknown; memo?: string | null };
  type Found<T = RootLine> = { signature: string; slot: number; blockTime: number | null; claim: T };
  type Walk<T = RootLine> = { found: Found<T>[]; complete: boolean; why: string | null; more: boolean };
  const none: Walk<never> = { found: [], complete: false, why: null, more: false };
  const onCluster = (c: { network: string }) => networkNamesGenesis(c.network, genesis, pinnedGenesis);
  const list = async (address: string, o: Record<string, unknown>) => {
    const batch = (await opts.rpc("getSignaturesForAddress", [address, { commitment: "finalized", ...o }])) as Listed[];
    if (!Array.isArray(batch)) throw new Error("the RPC did not return a signature list");
    return batch;
  };
  /** Does the node list memo text for this address? Asked about the entry of a transaction of it that carries a memo. */
  const listsMemos = async (address: string, signature: string) => {
    const newer = await list(address, { limit: 1000, until: signature });
    if (newer.length >= 1000) return false;
    const own = await list(address, { limit: 1, ...(newer.length ? { before: newer[newer.length - 1].signature } : {}) });
    return own[0]?.signature === signature && typeof own[0].memo === "string";
  };
  const ledgerReachesBefore = async (time: number) => {
    try {
      const slot = await opts.rpc("getFirstAvailableBlock", []);
      if (slot === 0) return true;
      if (typeof slot !== "number") return false;
      const t = await opts.rpc("getBlockTime", [slot]);
      return typeof t === "number" && t < time;
    } catch {
      return false;
    }
  };
  /**
   * The lines `address` signed that `wanted` picks (read by `parse`: root lines, or a key's hand-overs), oldest first.
   * `until`: from the newest signature back to that one. Otherwise back (from `before`, or the newest) to the first
   * entry from before `floor`. A candidate that cannot be read makes the walk incomplete (R4-28) and the walk goes on
   * past it, so a conflicting line that can be read is found.
   */
  const walkOf = async <T extends { network: string }>(parse: (text: unknown) => T | null, address: string, wanted: (c: T | null) => boolean, o: { before?: string; until?: string; floor: number; indexed: boolean; maxPages?: number; maxReads?: number }): Promise<Walk<T>> => {
    const found: Found<T>[] = [];
    let more = false, unread: string | null = null;
    const done = (complete: boolean, why: string | null = null): Walk<T> => ({ found: found.reverse(), complete: complete && !unread, why: why ?? unread, more });
    const maxPages = o.maxPages === undefined ? Infinity : Math.max(1, o.maxPages), maxReads = o.maxReads === undefined ? Infinity : Math.max(1, o.maxReads);
    const toFloor = !o.until;
    let before = o.before, reads = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await list(address, { limit: 1000, ...(before ? { before } : {}), ...(o.until ? { until: o.until } : {}) });
      const candidates: string[] = [];
      let reachedFloor = false;
      for (const s of batch) {
        if (toFloor && typeof s.blockTime === "number" && s.blockTime < o.floor) { reachedFloor = true; break; }
        if (s.err) continue;
        if (o.indexed && typeof s.memo !== "string") continue;
        if (typeof s.memo === "string" && !(s.memo.match(MEMO_LINE) ?? []).some((t) => wanted(parse(t)))) continue;
        candidates.push(s.signature);
      }
      for (let i = 0; i < candidates.length; i += WALK_READ_BATCH) {
        const chunk = candidates.slice(i, i + WALK_READ_BATCH);
        if (reads + chunk.length > maxReads) return done(false, `more than ${maxReads} transactions would have to be read`);
        reads += chunk.length;
        const read = await Promise.all(chunk.map((signature) => readSignedTransaction(opts.rpc, signature, ed)));
        for (let j = 0; j < chunk.length; j++) {
          const t = read[j];
          if (!t.ok) {
            if (t.unavailable) return done(false, t.why);
            if (!t.failedOnChain) unread ??= `transaction ${chunk[j]} is in the anchorer's history and could not be read: ${t.why}`;
            continue;
          }
          for (const m of t.tx.memos) {
            const c = parse(m.text);
            if (!c || !wanted(c) || !m.signers.includes(address) || !onCluster(c)) continue;
            found.push({ signature: chunk[j], slot: t.tx.slot, blockTime: t.tx.blockTime, claim: c });
            if (found.length > WALK_KEEP_LINES) { found.shift(); more = true; }
          }
        }
      }
      if (reachedFloor) return done(true);
      if (batch.length < 1000) {
        if (!toFloor) return done(true);
        return (await ledgerReachesBefore(o.floor)) ? done(true) : done(false, "the signature list ended before the range began, and the RPC does not keep its ledger back that far");
      }
      before = batch[batch.length - 1].signature;
    }
    return done(false, `the anchorer's history is longer than ${maxPages} pages for this range`);
  };
  const walk = (address: string, wanted: (c: RootLine | null) => boolean, o: Parameters<typeof walkOf>[3]) => walkOf(parseRootLine, address, wanted, o);
  const indexAt = (h: number) => { let at = -1; for (let i = 0; i < keys.length; i++) if (keys[i].from_hour <= h) at = i; return at; };
  const at = indexAt(hour);
  for (let i = 1; i <= at; i++) {
    const k = keys[i], prev = keys[i - 1];
    const r = await readSignedTransaction(opts.rpc, k.rotation_tx!, ed);
    const line = `trellis:anchorer:v1:${ref}:${k.from_hour}:${k.key}`;
    const memo = r.ok ? r.tx.memos.find((m) => m.text === line) : undefined;
    const why = !r.ok ? r.why : !memo ? `its rotation transaction does not carry the line ${line}` : !memo.signers.includes(prev.key) ? "its rotation was not signed by the key before it" : !memo.signers.includes(k.key) ? "its rotation was not signed by the new key itself" : r.tx.blockTime === null ? "its rotation has no block time" : r.tx.blockTime > k.from_hour + HOUR_S ? "its rotation was announced after the hour it starts in" : null;
    if (why || !r.ok) { checks.push(fail("posted.anchorer", `Anchorer key ${i} is not a verified successor: ${why}.`)); return out(); }
    // A key's EARLIEST finalized hand-over is its only one (security review round 5, R5-19): the rotation your list
    // names must be the first hand-over the key before it ever signed on this cluster. Its history is walked from the
    // rotation back to its beginning; what cannot be read is unknown, never a pass.
    const same = (c: HandOverLine) => c.newAnchorer === k.key && c.fromHour === k.from_hour;
    if (r.tx.memos.some((m) => { const c = parseHandOverLine(m.text); return !!c && m.signers.includes(prev.key) && onCluster(c) && !same(c); })) { checks.push(fail("posted.anchorer", `Anchorer key ${i} is not a verified successor: its rotation transaction carries a second, different hand-over signed by the key before it: neither is a hand-over.`)); return out(); }
    if (opts.walkHistory === false) { if (i === at) notCheckedList.push("Whether an earlier anchorer key signed another hand-over before the rotation in your key list (its history was not walked)."); continue; }
    let w: Walk<HandOverLine>;
    try {
      const indexed = await listsMemos(prev.key, k.rotation_tx!).catch(() => false);
      w = await walkOf(parseHandOverLine, prev.key, (c) => !!c, { before: k.rotation_tx!, floor: 0, indexed, maxPages: opts.maxPages, maxReads: opts.maxReads });
    } catch (e) {
      w = { ...none, why: `its history could not be read (${(e as Error).message.slice(0, 100)})` };
    }
    const earlier = w.found.find((m) => m.signature !== k.rotation_tx && !same(m.claim));
    if (earlier) { checks.push(fail("posted.anchorer", `Anchorer key ${i} is not a verified successor: the key before it signed an earlier hand-over, to ${earlier.claim.newAnchorer} from hour ${earlier.claim.fromHour} (transaction ${earlier.signature}): a key's earliest hand-over is its only one, so the rotation in your list is none.`)); return out(); }
    if (!w.complete) { dontKnow("posted.anchorer", `Whether the key before anchorer key ${i} handed over earlier is not known: its history was not read to its beginning (${w.why ?? "the walk was cut short"}).`); return out(); }
  }
  const anchorer = keys[at].key;
  checks.push(pass("posted.anchorer", `${anchorer} is your anchorer key for hour ${hour}${at > 0 ? ` (rotation ${at} of ${keys.length - 1} verified back to the first key)` : ""}`));
  const r = await readSignedTransaction(opts.rpc, a.tx, ed);
  if (!r.ok) {
    if (r.unavailable) dontKnow("posted.transaction", `The posting transaction could not be read: ${r.why}.`);
    else checks.push(fail("posted.transaction", `The posting transaction could not be confirmed: ${r.why}.`));
    return out({ anchorer });
  }
  checks.push(pass("posted.transaction", `transaction ${a.tx.slice(0, 12)}… is finalized, succeeded, and its signatures verify`));
  const memo = r.tx.memos.find((m) => m.text === a.line);
  if (!memo) { checks.push(fail("posted.content", "The transaction carries no memo with exactly the expected line (another root, count, hour or network).")); return out({ anchorer }); }
  if (!memo.signers.includes(anchorer)) { checks.push(fail("posted.content", `The memo was not signed by the anchorer key configured for that hour (${anchorer}): not signed by the anchorer key. Anyone can write the same text; only that signature makes it a root.`)); return out({ anchorer }); }
  // Every memo line of this very transaction (R4-10): a second line the anchorer signed in it for the same subject
  // with another root or count is a conflict, and there is no "earlier" between two lines of one transaction.
  if (r.tx.memos.some((m) => { const c = parseRootLine(m.text); return m.signers.includes(anchorer) && !!c && sameSubject(c, claim) && onCluster(c) && !sameClaim(c, claim); })) {
    checks.push(fail("posted.earliest", "The transaction itself carries two different roots for this hour, both signed by the anchorer: a conflict, and neither line is the root of the hour."));
    return out({ anchorer, earliest: false, conflicts: [a.tx] });
  }
  checks.push(pass("posted.content", "the anchorer signed exactly this line"));
  // When it landed: not before its hour, not after the key was retired, not later than the lateness bound.
  const landed = r.tx.blockTime;
  if (landed === null) { dontKnow("posted.time", "The RPC gave no block time for the transaction, so neither its hour nor its lateness can be checked."); return out({ anchorer }); }
  if (landed < hour) { checks.push(fail("posted.time", "The memo was posted before the hour it claims to cover.")); return out({ anchorer }); }
  const next = keys[at + 1];
  if (next && landed >= next.from_hour + HOUR_S) { checks.push(fail("posted.time", `The memo was signed by a retired key: ${anchorer} handed over at hour ${next.from_hour}, and this line landed after that hand-over took effect.`)); return out({ anchorer }); }
  if (claim.kind === "root" && claim.version !== 2 && validHour(opts.memoV2FromHour) && hour >= opts.memoV2FromHour) { checks.push(fail("posted.content", `A v1 line for an hour at or after the switch to linked (v2) lines (hour ${opts.memoV2FromHour}).`)); return out({ anchorer }); }
  const bound = opts.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS;
  const late = landed > hour + HOUR_S + bound;
  if (late && !opts.allowLate) { checks.push(fail("posted.time", `The memo landed ${landed - hour - HOUR_S} seconds after its hour closed, later than the bound of ${bound} seconds: a late line is not an anchor.`)); return out({ anchorer, late }); }
  checks.push(pass("posted.time", late ? "the line landed after the lateness bound, and you allowed late lines" : "the line landed after its hour began and within the lateness bound"));
  // The link of a v2 line (R4-28): the transaction it names must be read, must be a root line of the anchorer for an
  // EARLIER hour that landed BEFORE this one, and must be the actual previous root: the anchorer signed no root that
  // counts for an hour between the two. `0` says there is no previous root at all, and is checked in the same way.
  let link: PostedRootVerification["link"] = null;
  let linkUnknown: string | null = null;
  let between: number | null = null;
  if (claim.kind === "root" && claim.version === 2) {
    if (claim.prev) {
      const p = await readSignedTransaction(opts.rpc, claim.prev, ed);
      if (!p.ok && p.failedOnChain) { checks.push(fail("posted.link", "The line's link does not hold: the transaction it names as the previous root failed on chain.")); return out({ anchorer, late }); }
      if (!p.ok) linkUnknown = `the transaction the line names as the previous root could not be read (${p.why})`;
      else {
        let previous = -1;
        for (const m of p.tx.memos) {
          const c = parseRootLine(m.text);
          if (!c || c.kind !== "root" || c.hour >= hour || !onCluster(c)) continue;
          const i = indexAt(c.hour);
          if (i >= 0 && i <= at && m.signers.includes(keys[i].key) && p.tx.slot < r.tx.slot) previous = Math.max(previous, c.hour);
        }
        if (previous < 0) { checks.push(fail("posted.link", "The line's link does not hold: the transaction it names as the previous root is not an earlier root line of the anchorer.")); return out({ anchorer, late }); }
        between = previous + HOUR_S;
      }
    } else between = 0;
  }
  if (opts.walkHistory === false) {
    if (linkUnknown) { link = "not_checked"; dontKnow("posted.link", `Whether the line's link to the previous root holds is not known: ${linkUnknown}.`); return out({ anchorer, late, link }); }
    if (between !== null) { link = claim.prev ? "verified" : "not_checked"; notCheckedList.push(claim.prev ? "Whether the root the line links to is the one directly before it (the history was not walked)." : "Whether the line is rightly the first root (the history was not walked)."); }
    notCheckedList.push("Whether the anchorer signed an earlier, different line for the same hour (the history was not walked).");
    checks.push(notChecked("posted.earliest", "The anchorer's history was not walked."));
    return out({ anchorer, late, link });
  }
  // The earliest finalized line for the hour is the root: look back to before the hour began (and as far as the link
  // reaches), and forward for a later line that contradicts this one (`walk`, above).
  const from = linkUnknown || between === null ? hour : Math.min(hour, Math.max(between, keys[at].from_hour));
  const about = (c: RootLine | null) => !!c && sameSubject(c, claim);
  const passedOver = (c: RootLine | null) => !!c && c.kind === "root" && c.hour >= from && c.hour < hour;
  try {
    // Does the node list memo text for this address? Asked about the entry of this very transaction, which has one.
    const indexed = await listsMemos(anchorer, a.tx);
    const back = await walk(anchorer, (c) => about(c) || passedOver(c), { before: a.tx, floor: from, indexed, maxPages: opts.maxPages, maxReads: opts.maxReads });
    const forward = back.complete ? await walk(anchorer, about, { until: a.tx, floor: hour, indexed, maxPages: opts.maxPages ?? LATER_WALK.maxPages, maxReads: opts.maxReads ?? LATER_WALK.maxReads }).catch((e) => ({ ...none, why: (e as Error).message.slice(0, 100) })) : none;
    // A line that landed before the hour began is no line for it (the walk reaches back that far only for the link).
    const before = back.found.filter((m) => m.signature !== a.tx && about(m.claim) && !(m.blockTime !== null && m.blockTime < hour));
    const conflicts = [...new Set([...before, ...forward.found.filter((m) => m.signature !== a.tx)].filter((m) => !sameClaim(m.claim, claim)).map((m) => m.signature))];
    // The earliest TRANSACTION decides, with every line in it: one that carries another root refutes the proof.
    const first = before.filter((m) => m.signature === before[0].signature).find((m) => !sameClaim(m.claim, claim));
    if (first) {
      checks.push(fail("posted.earliest", `An earlier finalized line of the anchorer names another root for this hour (transaction ${first.signature}); the earliest line is the root.`));
      return out({ anchorer, late, link, earliest: false, conflicts });
    }
    // The link, second half: a root of the anchorer that counts, for an hour between the one the line names and its own.
    const counts = (m: Found, i: number) => m.signature !== a.tx && m.signature !== claim.prev && m.slot < r.tx.slot && indexAt(m.claim.hour) === i && m.blockTime !== null && m.blockTime >= m.claim.hour
      && !(keys[i + 1] && m.blockTime >= keys[i + 1].from_hour + HOUR_S) && m.blockTime <= m.claim.hour + HOUR_S + bound;
    const linkBroken = (m: Found) => { checks.push(fail("posted.link", `The line's link does not hold: it ${claim.prev ? "names an older transaction as the previous root" : "says there is no previous root"}, but the anchorer signed a root for hour ${m.claim.hour} before this line (transaction ${m.signature}).`)); return out({ anchorer, late, conflicts }); };
    const skipped = back.found.find((m) => passedOver(m.claim) && counts(m, at));
    if (skipped) return linkBroken(skipped);
    if (!back.complete) {
      dontKnow("posted.earliest", `Whether this is the earliest line for its hour is not known: the anchorer's history was not read back to before the hour began (${back.why ?? "the walk was cut short"}).`);
      return out({ anchorer, late, link, conflicts });
    }
    if (linkUnknown) { dontKnow("posted.link", `Whether the line's link to the previous root holds is not known: ${linkUnknown}.`); return out({ anchorer, late, link: "not_checked", conflicts }); }
    if (between !== null) {
      // Hours between the two that an EARLIER key owned are looked for in that key's own history.
      for (let i = at - 1; i >= 0 && between < keys[i + 1].from_hour; i--) {
        const lo = Math.max(between, keys[i].from_hour), hi = Math.min(hour, keys[i + 1].from_hour);
        if (lo >= hi) continue;
        const w = await walk(keys[i].key, (c) => !!c && c.kind === "root" && c.hour >= lo && c.hour < hi, { floor: lo, indexed: false, maxPages: opts.maxPages, maxReads: opts.maxReads }).catch((e) => ({ ...none, why: (e as Error).message.slice(0, 100) }));
        const bad = w.found.find((m) => counts(m, i));
        if (bad) return linkBroken(bad);
        if (!w.complete) { dontKnow("posted.link", `Whether the line's link names the actual previous root is not known: the history of an earlier anchorer key was not read (${w.why ?? "the walk was cut short"}).`); return out({ anchorer, late, link: "not_checked", conflicts }); }
      }
      link = "verified";
      checks.push(pass("posted.link", claim.prev ? "the line names the previous root of the anchorer: an earlier root line, with no root of the anchorer between the two" : "the line says there is no previous root, and the anchorer's history shows none"));
    }
    if (back.more || forward.more) notCheckedList.push(`The anchorer signed more than ${WALK_KEEP_LINES} lines for this range; only the earliest are listed.`);
    if (!forward.complete) notCheckedList.push("Whether the anchorer signed a different line for this hour later: the history after this line was not read to its end.");
    checks.push(conflicts.length ? pass("posted.earliest", `this is the root of the hour, but the anchorer also signed a different line later (${conflicts.join(", ")}): evidence of a double post`) : pass("posted.earliest", before.length ? "an earlier copy of the same line exists; no other root was signed for this hour" : "no other line of the anchorer exists for this hour"));
    return out({ anchorer, late, link, earliest: before.length === 0, conflicts });
  } catch (e) {
    dontKnow("posted.earliest", `Whether this is the earliest line for its hour is not known: the anchorer's history could not be read (${(e as Error).message.slice(0, 100)}).`);
    return out({ anchorer, late, link });
  }
}

/**
 * A root posted to trellis_anchor, confirmed from the transaction that posted it (`data` is the exact instruction
 * data). `programId` is the program YOU trust; the posting authority must be the anchorer key you trust for `hour`.
 */
export async function verifyProgramPost(a: { tx: string; programId: string; data: Uint8Array; hour: number }, opts: Pick<VerifyPostedRootOptions, "rpc" | "ed25519" | "anchorers" | "pinnedAnchorer" | "network" | "genesisHash">): Promise<PostedRootVerification> {
  const checks: Check[] = [];
  const notCheckedList: string[] = [];
  let unknown = false;
  const out = (over: Partial<PostedRootVerification> = {}): PostedRootVerification => {
    const failedAny = checks.some((c) => c.status === "fail");
    const valid = !failedAny && !unknown && checks.some((c) => c.id === "posted.content" && c.status === "pass") && checks.some((c) => c.id === "posted.anchorer" && c.status === "pass");
    return { valid, status: valid ? "verified" : failedAny || !unknown ? "failed" : "unknown", mode: "program", anchorer: null, earliest: null, late: false, link: null, conflicts: [], checks, notChecked: notCheckedList, ...over };
  };
  const keys = opts.anchorers ?? [];
  const problem = anchorerKeysProblem(keys);
  if (problem) { checks.push(fail("posted.anchorer", `${problem}: without a key of yours to compare the posting authority with, any program that accepts these bytes from anyone would pass.`)); return out(); }
  if (opts.pinnedAnchorer && keys[0].key !== opts.pinnedAnchorer) { checks.push(fail("posted.anchorer", `The first anchorer key in your list is ${keys[0].key}, not the one you pinned.`)); return out(); }
  if (typeof a.programId !== "string" || !B58_KEY.test(a.programId)) { checks.push(fail("posted.config", "Program mode needs the anchor program id you trust (`programId`); the one a proof names is not used.")); return out(); }
  const ref = networkRef(opts.network);
  if (ref) {
    try {
      const genesis = String(await opts.rpc("getGenesisHash", []));
      if (!networkNamesGenesis(ref, genesis, opts.genesisHash ? { ref, genesis: opts.genesisHash } : null)) { checks.push(fail("posted.cluster", `The RPC serves the cluster with genesis hash ${genesis}, which is not the cluster your network (${opts.network}) names.`)); return out(); }
      checks.push(pass("posted.cluster", `the RPC serves the cluster ${opts.network} names`));
    } catch (e) {
      unknown = true;
      checks.push(notChecked("posted.cluster", `The RPC could not be asked which cluster it serves (${(e as Error).message.slice(0, 100)}).`));
      return out();
    }
  } else notCheckedList.push("That the RPC serves the cluster you expect: no network was given.");
  const r = await readSignedTransaction(opts.rpc, a.tx, opts.ed25519 ?? defaultEd25519Verify);
  if (!r.ok) {
    if (r.unavailable) { unknown = true; checks.push(notChecked("posted.transaction", `The posting transaction could not be read: ${r.why}.`)); }
    else checks.push(fail("posted.transaction", `The posting transaction could not be confirmed: ${r.why}.`));
    return out();
  }
  checks.push(pass("posted.transaction", `transaction ${a.tx.slice(0, 12)}… is finalized, succeeded, and its signatures verify`));
  const ix = r.tx.instructions.find((i) => i.programId === a.programId && equalBytes(i.data, a.data));
  if (!ix) { checks.push(fail("posted.content", "The transaction carries no post instruction with exactly these values for the anchor program you trust.")); return out(); }
  const authority = ix.accounts[0] ?? null;
  if (!authority || !r.tx.signers.includes(authority)) { checks.push(fail("posted.content", "The instruction's authority did not sign the transaction.")); return out(); }
  checks.push(pass("posted.content", "the anchor program accepted exactly this root for this hour (it refuses a second one)"));
  let expected: string | null = null;
  for (const k of keys) if (k.from_hour <= a.hour) expected = k.key;
  checks.push(expected === authority ? pass("posted.anchorer", `posted by ${authority}, your anchorer key for that hour`) : fail("posted.anchorer", `Posted by ${authority}, not by the anchorer key you trust for that hour (${expected}): not by the anchorer key.`));
  return out({ anchorer: authority, earliest: expected === authority ? true : null });
}

const le64 = (v: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; };

/**
 * Confirm that the root of an anchor proof was published on chain, through the transaction the proof names. Use it
 * after `verifyReceipt` said `anchor: "proof_valid"`. The mode, the network, the anchorer keys and (program mode) the
 * program id are YOUR settings (`anchorTrustFromDocument(await fetchAnchorKeys(routerOrigin))`, or your own values, with
 * `pinnedAnchorer` to rely on more than the router's word). The proof's `mode`, `contract`, `network` and `anchorer`
 * are compared with them and never used in their place.
 */
export async function verifyPostedRoot(proof: PostedAnchorProof, opts: VerifyPostedRootOptions): Promise<PostedRootVerification> {
  const none = (id: string, detail: string): PostedRootVerification => ({ valid: false, status: "failed", mode: opts?.mode ?? null, anchorer: null, earliest: null, late: false, link: null, conflicts: [], checks: [fail(id, detail)], notChecked: [] });
  if (!proof || proof.status !== "confirmed" || typeof proof.tx !== "string" || !proof.tx) return none("posted.transaction", `The root is not posted (status ${String(proof?.status)}): until it is, it is only the router's statement.`);
  if (opts?.mode !== "memo" && opts?.mode !== "program") return none("posted.config", "Say which anchor mode you expect (`mode`: \"memo\" or \"program\"). The mode a proof names is the router's statement and is not used.");
  const ref = networkRef(opts.network);
  if (!ref) return none("posted.config", "Say which network you expect (`network`). The network a proof names is not used.");
  if (proof.mode && proof.mode !== opts.mode) return none("posted.config", `The proof says its root was posted in ${proof.mode} mode, but you expect ${opts.mode} mode.`);
  if (proof.network && networkRef(proof.network) !== ref) return none("posted.config", `The proof names network ${proof.network}, but you expect ${opts.network}.`);
  const root = hex64(proof.root);
  if (!root || !validHour(proof.hour) || !validCount(proof.count)) return none("posted.content", "The proof does not name a root, an hour and a count.");
  if (opts.mode === "memo") {
    // The line: as the proof gives it (a v2 line carries a link that cannot be rebuilt), but only if it says exactly
    // this network, hour, count and root; otherwise the v1 line built from them.
    let line = `trellis:root:v1:${ref}:${proof.hour}:${proof.count}:${root}`;
    if (typeof proof.memo === "string") {
      const given = parseRootLine(proof.memo);
      if (!given || given.kind !== "root" || given.network !== ref || given.hour !== proof.hour || given.count !== proof.count || given.root !== root) return none("posted.content", "The memo line the proof gives is not a root line for this network, hour, count and root.");
      line = proof.memo;
    }
    return verifyMemoLine({ tx: proof.tx, line }, opts);
  }
  if (typeof opts.programId !== "string" || !opts.programId) return none("posted.config", "Program mode needs the anchor program id you trust (`programId`). The program a proof names is not used.");
  if (typeof proof.contract === "string" && proof.contract !== opts.programId) return none("posted.config", `The proof names anchor program ${proof.contract}, but you trust ${opts.programId}.`);
  return verifyProgramPost({ tx: proof.tx, programId: opts.programId, data: concatBytes(POST_ROOT_DISCRIMINATOR, le64(proof.hour), hexToBytes(root), le64(proof.count)), hour: proof.hour }, opts);
}
