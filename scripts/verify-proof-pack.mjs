#!/usr/bin/env node
// Verify an Trellis proof pack offline, with nothing but Node (18 or later) and this file.
//
//   node scripts/verify-proof-pack.mjs trellis-proof-pack-<from>-to-<to>.json --keys <key document.json>
//   node scripts/verify-proof-pack.mjs trellis-proof-pack-<from>-to-<to>.json --keys <key document.json> --intent order.json [--intent other.json]
//
// WHO signed the pack is checked against keys YOU trust, never against the keys the pack carries (security review round
// 4, R4-11: a pack signed with anybody's key is consistent with the key list inside it). Give one of:
//   --keys <file>          the key document you fetched from the router's own origin, /.well-known/trellis-receipt-keys.json
//   --keys-url <address>   that address; this run fetches it (the only network request made without --rpc)
//   --receipt-key <key>    the router's receipt public key, 64 hex characters or base64url; repeat for several
// Every key in the pack must be one of them. A key document says how long it may be relied on (`expires_at`) and which
// version of the key list it is (`version`, the number of keys): an expired one is refused, and --min-key-version <n>
// refuses one older than a version you have already seen. Without a key source the checks below still run, against the
// keys in the pack, and the result says SIGNER UNCHECKED instead of "every check passed".
//
// Exit codes: 0 every check passed and the signer is one you trust; 1 a check failed or could not be made; 2 usage;
// 3 nothing failed, but the signer was not checked.
//
// Checks: every key in the pack has the id its bytes give (first 16 hex of sha256); every call receipt (v1: Ed25519 over
// canonical JSON; v2: COSE_Sign1 with EdDSA), refund receipt, monthly statement and the pack's manifest verifies against
// those keys; each receipt's anchor leaf is sha256(sha256(...)) of what was signed; every Merkle path
// present leads from that leaf to its root (sorted-pair sha256); each statement's amounts
// reconcile exactly; the lane report adds up and matches the calls listed, and each call's lane, provider and model match
// its signed receipt; the decision tag list names exactly the tags the signed receipts carry; and the signed manifest lists
// exactly the receipts, statements, keys, lane report and decision tags in the file. With --intent, each order JSON file is
// hashed as the decision-receipt helpers hash it (sha256 of canonical JSON) and the calls whose signed receipt carries that
// hash are named; no such call is a failure. Without --rpc and --keys-url it makes no
// network request, and it deliberately shares no code with the router.
//
//   node scripts/verify-proof-pack.mjs <pack.json> --rpc <solana rpc url> --keys <key document.json> [--anchorer <first anchorer key>]
//   node scripts/verify-proof-pack.mjs <pack.json> --receipt-key <key> --rpc <solana rpc url> --mode memo --network <caip-2 id> --anchorer <anchorer key>
//
// With --rpc it also checks every root the pack says was posted, against the chain, through the transaction the proof
// names. What it TRUSTS it takes from you, never from the pack (security review round 3, R3-04): the anchor mode, the
// network, the anchor program and the anchorer keys come from --keys or from --mode, --network,
// --program and --anchorer; --anchorer beside --keys pins the first key of the document. The key list inside a pack is
// not signed and is ignored; a pack that names another mode, program or network than yours fails. Without a
// configuration of your own no root is verified and the exit code is not 0. The number of anchorer keys is the version
// of that list: --min-anchorers <n> refuses a document that lists fewer than you have already seen.
//   memo mode     the RPC serves the cluster your network names (getGenesisHash); the transaction is FINALIZED and
//                 succeeded; the anchorer's Ed25519 signature over its message bytes verifies here; a Memo v2 instruction
//                 naming the anchorer carries exactly the root's line (trellis:root:v2:<network>:<hour>:<count>:<root>:<previous>,
//                 or the v1 line without the link for hours before memo_v2_from_hour); the anchorer was your key for
//                 that hour (each rotation signed by the key before it and by the new key, and the FIRST hand-over
//                 that key ever signed: its history is walked back to its beginning, which needs an RPC that keeps
//                 it) and had not been retired
//                 when the line landed; the line landed no earlier than its hour and no later than the lateness bound
//                 after it closed (max_late_seconds of the key document, at most 24 hours; default 6 hours; --max-late <seconds>,
//                 --allow-late); the transaction carries no second, different root for the hour (R4-10: two roots in
//                 one transaction are a conflict); a v2 line names the ACTUAL previous root (R4-28): the transaction
//                 it names is read, is a root line of the anchorer for an earlier hour that landed before this one,
//                 and the anchorer signed no root that counts for an hour between the two (`0`, "no previous root",
//                 passes only when the anchorer's history shows none); and no earlier finalized line of that key
//                 names another root for the hour. A later contradicting line is reported.
//   program mode  the transaction is finalized and succeeded and carries trellis_anchor::post_root(hour, root, count)
//                 for YOUR program id, signed by its authority, which must be your anchorer key. (The program refused a
//                 second root for the hour when it landed. This also covers roots whose account was closed after 400 days.)
// "Earliest line for the hour" fails closed (R3-05): the anchorer's history must be read from the line back to before
// the hour began. There is no default limit on that walk (R4-09: a limit lets a few thousand transactions that merely
// name the anchorer make an honest root unknowable); the signature list is read a page at a time and the candidates 16
// at a time. When the walk errors, is cut short by a limit you set (--max-pages, --max-reads), meets a transaction the
// node lists and does not serve (R4-28), or ends at a node that does not keep its ledger that far back, the root is
// reported UNKNOWN and the exit code is not 0; so is a line whose link cannot be followed. Memo mode is weaker
// than the program in ways this script cannot remove: nothing on chain stops a second line for an hour (it can only be
// found and reported), the RPC must still serve the old transactions (the first root of a deployment, which says `0`,
// needs an endpoint that keeps the ledger from the cluster's first block), the anchorer key you trust carries all the
// weight, and a key document that misses a rotation lets the retired key pass for hours the new key owns, for as long
// as that document has not expired.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const PACK_TYPE = "trellis.proof-pack.v1";
export const MANIFEST_TYPE = "trellis.proof-pack.manifest.v1";
export const STATEMENT_TYPE = "trellis.statement.v1";

// ---- encodings ---------------------------------------------------------------------------------------------------

/** The router's canonical JSON: object keys sorted recursively, undefined dropped. */
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    // A member named "__proto__" is a member like any other: assigning it would set the copy's prototype and drop it
    // from the bytes, so it could be added to a signed payload without breaking the signature (R5-22).
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) { if (k === "__proto__") Object.defineProperty(out, k, { value: canonical(v[k]), enumerable: true, writable: true, configurable: true }); else out[k] = canonical(v[k]); }
    return out;
  }
  return v;
}
export const canonicalJson = (v) => JSON.stringify(canonical(v));
const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (b) => createHash("sha256").update(b).digest();
const b64 = (s) => (typeof s === "string" && /^[A-Za-z0-9+/_-]*={0,2}$/.test(s) ? Buffer.from(s, s.includes("-") || s.includes("_") ? "base64url" : "base64") : null);
const fromHex = (s) => (typeof s === "string" && /^(0x)?([0-9a-fA-F]{2})*$/.test(s) ? Buffer.from(s.replace(/^0x/, ""), "hex") : null);

const leafOf = (bytes) => "0x" + hex(sha256(sha256(bytes)));

/** The deepest Merkle path the check follows (a tree of 2^64 leaves). */
export const MAX_PROOF_DEPTH = 64;
/** A sorted-pair Merkle path: sha256 sorted pairs from the leaf up; the result must be the root. Every element is 32 bytes and the path at most MAX_PROOF_DEPTH long. */
export function merkleVerify(leaf, proof, root) {
  let h = fromHex(leaf);
  const r = fromHex(root);
  if (!h || h.length !== 32 || !r || r.length !== 32 || !Array.isArray(proof) || proof.length > MAX_PROOF_DEPTH) return false;
  for (const p of proof) {
    const q = fromHex(p);
    if (!q || q.length !== 32) return false;
    h = sha256(Buffer.compare(h, q) < 0 ? Buffer.concat([h, q]) : Buffer.concat([q, h]));
  }
  return h.equals(r);
}

/** Enough CBOR (RFC 8949) for a COSE_Sign1 receipt: integers, byte and text strings, arrays, maps, tags, simple values. */
export function cborDecode(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("truncated CBOR");
  };
  const item = () => {
    need(1);
    const b = bytes[at++], major = b >> 5, info = b & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("unsupported CBOR value");
    }
    let n = info;
    if (info >= 24) {
      const len = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
      if (!len) throw new Error("indefinite CBOR lengths are not allowed");
      need(len);
      n = 0;
      for (let i = 0; i < len; i++) n = n * 256 + bytes[at++];
    }
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      need(n);
      const s = bytes.subarray(at, at + n);
      at += n;
      return major === 2 ? Buffer.from(s) : Buffer.from(s).toString("utf8");
    }
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) {
      const m = new Map();
      for (let i = 0; i < n; i++) m.set(item(), item());
      return m;
    }
    return { tag: n, value: item() };
  };
  const v = item();
  if (at !== bytes.length) throw new Error("trailing CBOR bytes");
  return v;
}
const cborJson = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), cborJson(x)])) : Array.isArray(v) ? v.map(cborJson) : v);
const head = (major, n) => {
  if (n < 24) return Buffer.of((major << 5) | n);
  if (n < 256) return Buffer.of((major << 5) | 24, n);
  if (n < 65536) return Buffer.of((major << 5) | 25, n >> 8, n & 255);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};
const bstr = (b) => Buffer.concat([head(2, b.length), b]);

/** COSE_Sign1 into its protected header (alg, kid), payload, signature and the Sig_structure that was signed. */
export function decodeCose(bytes) {
  let v = cborDecode(bytes);
  if (v && !Array.isArray(v) && !(v instanceof Map) && typeof v === "object" && "tag" in v) {
    if (v.tag !== 18) throw new Error("not a COSE_Sign1");
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4 || !Buffer.isBuffer(v[0]) || !Buffer.isBuffer(v[2]) || !Buffer.isBuffer(v[3])) throw new Error("not a COSE_Sign1");
  const prot = v[0].length ? cborDecode(v[0]) : new Map();
  if (!(prot instanceof Map)) throw new Error("protected header is not a map");
  const kid = prot.get(4);
  const toBeSigned = Buffer.concat([head(4, 4), head(3, 10), Buffer.from("Signature1"), bstr(v[0]), bstr(Buffer.alloc(0)), bstr(v[2])]);
  return { alg: prot.get(1) ?? null, keyId: Buffer.isBuffer(kid) ? hex(kid) : null, claims: cborJson(cborDecode(v[2])), signature: v[3], toBeSigned };
}

// ---- checks ------------------------------------------------------------------------------------------------------

const pico = (value) => {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,12})?$/.test(value)) throw new Error("bad amount");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return (BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"))) * (value.startsWith("-") ? -1n : 1n);
};
/** Opening + deposits + refunds - usage - fees + other = closing; every usage grouping and the movements add up. */
export function statementReconciles(p) {
  try {
    if (pico(p.opening_balance) + pico(p.deposits) + pico(p.refunds) - pico(p.usage) - pico(p.fees) + pico(p.other_changes) !== pico(p.closing_balance)) return false;
    for (const name of ["usage_by_model", "usage_by_key_agent", "usage_by_lane"]) if (!Array.isArray(p[name]) || p[name].reduce((s, r) => s + pico(r.amount), 0n) !== pico(p.usage)) return false;
    return Array.isArray(p.movements_by_kind) && pico(p.opening_balance) + p.movements_by_kind.reduce((s, r) => s + pico(r.amount), 0n) === pico(p.closing_balance);
  } catch {
    return false;
  }
}

// The lanes whose endpoints all hold a fresh hardware attestation the router verified: "proven hardware".
export const PROVEN_LANES = ["attested", "unlinkable"];
const LANE_ORDER = ["public", "attested", "unlinkable"];
/** part / whole to four decimal places, rounded half up; null when whole is 0. The router computes shares the same way. */
export const shareOf = (part, whole) => (whole === 0n ? null : Number((part * 20000n + whole) / (2n * whole)) / 10000);
const evidenceUrl = (provider) => `/verify/?p=${encodeURIComponent(provider)}`;
const attestationUrl = (provider) => `/api/v1/attestation/${encodeURIComponent(provider)}`;

/**
 * Recompute a lane report from the calls it covers and compare: totals, every lane (calls, spend, shares), the proven
 * share, and every provider and model row on the proven lanes with its evidence links. Returns a list of problems.
 */
export function laneReportProblems(report, calls) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!report || typeof report !== "object") return ["it is missing or not an object"];
  try {
    let total = 0n, spend = 0n;
    const lanes = new Map(LANE_ORDER.map((l) => [l, { calls: 0n, spend: 0n }]));
    const rows = new Map();
    for (const c of calls) {
      const lane = c?.lane ?? null, amount = pico(c?.cost);
      total += 1n;
      spend += amount;
      const t = lanes.get(lane) ?? { calls: 0n, spend: 0n };
      t.calls += 1n;
      t.spend += amount;
      lanes.set(lane, t);
      if (!PROVEN_LANES.includes(lane)) continue;
      const id = JSON.stringify([lane, c.provider, c.model]);
      const r = rows.get(id) ?? { calls: 0n, spend: 0n };
      r.calls += 1n;
      r.spend += amount;
      rows.set(id, r);
    }
    if (report.totals?.calls !== Number(total) || pico(report.totals?.spend) !== spend) bad(`the totals (${report.totals?.calls} calls, ${report.totals?.spend}) are not the ${total} calls and ${spend} pico-USDC listed`);

    const listedLanes = Array.isArray(report.lanes) ? report.lanes : [];
    if (!Array.isArray(report.lanes)) bad("it has no lane list");
    let laneCalls = 0n, laneSpend = 0n;
    const seen = new Set();
    for (const row of listedLanes) {
      const lane = row?.lane ?? null, name = lane ?? "not recorded";
      if (seen.has(lane)) bad(`lane ${name} is listed twice`);
      seen.add(lane);
      const want = lanes.get(lane) ?? { calls: 0n, spend: 0n };
      const got = { calls: BigInt(row.calls), spend: pico(row.spend) };
      laneCalls += got.calls;
      laneSpend += got.spend;
      if (got.calls !== want.calls || got.spend !== want.spend) bad(`lane ${name}: ${row.calls} calls and ${row.spend} listed, but the calls in this file give ${want.calls} and ${want.spend} pico-USDC`);
      if (row.share_of_calls !== shareOf(got.calls, total) || row.share_of_spend !== shareOf(got.spend, spend)) bad(`lane ${name}: its shares do not match its calls and spend`);
      if (row.proven !== PROVEN_LANES.includes(lane)) bad(`lane ${name}: marked ${row.proven ? "proven" : "not proven"}`);
    }
    for (const [lane, t] of lanes) if (t.calls > 0n && !seen.has(lane)) bad(`lane ${lane ?? "not recorded"} has calls in this file but is not listed`);
    if (laneCalls !== total || laneSpend !== spend) bad("the lanes do not add up to the totals");

    const p = report.proven ?? {};
    const provenCalls = PROVEN_LANES.reduce((n, l) => n + (lanes.get(l)?.calls ?? 0n), 0n), provenSpend = PROVEN_LANES.reduce((n, l) => n + (lanes.get(l)?.spend ?? 0n), 0n);
    if (canonicalJson(p.lanes) !== canonicalJson(PROVEN_LANES)) bad("the proven share does not name the attested and unlinkable lanes");
    if (BigInt(p.calls ?? -1) !== provenCalls || pico(p.spend) !== provenSpend) bad(`the proven share (${p.calls} calls, ${p.spend}) is not the ${provenCalls} calls and ${provenSpend} pico-USDC on the proven lanes`);
    if (p.share_of_calls !== shareOf(provenCalls, total) || p.share_of_spend !== shareOf(provenSpend, spend)) bad("the proven shares do not match");

    const providers = Array.isArray(report.providers) ? report.providers : [];
    if (!Array.isArray(report.providers)) bad("it has no provider list");
    let rowCalls = 0n, rowSpend = 0n;
    const listed = new Set();
    for (const row of providers) {
      const id = JSON.stringify([row?.lane, row?.provider, row?.model]), name = `${row?.provider} ${row?.model} on ${row?.lane}`;
      if (listed.has(id)) bad(`provider ${name} is listed twice`);
      listed.add(id);
      if (!PROVEN_LANES.includes(row?.lane)) bad(`provider ${name}: provider rows cover only the proven lanes`);
      const want = rows.get(id) ?? { calls: 0n, spend: 0n };
      const got = { calls: BigInt(row.calls), spend: pico(row.spend) };
      rowCalls += got.calls;
      rowSpend += got.spend;
      if (got.calls !== want.calls || got.spend !== want.spend) bad(`provider ${name}: ${row.calls} calls and ${row.spend} listed, but the calls in this file give ${want.calls} and ${want.spend} pico-USDC`);
      if (row.evidence_url !== evidenceUrl(row.provider) || row.attestation_url !== attestationUrl(row.provider)) bad(`provider ${name}: its evidence links do not point at its own attestation record`);
    }
    for (const id of rows.keys()) if (!listed.has(id)) bad(`provider ${JSON.parse(id).slice(1).join(" ")} on ${JSON.parse(id)[0]} has calls in this file but is not listed`);
    if (rowCalls !== provenCalls || rowSpend !== provenSpend) bad("the provider rows do not add up to the proven share");
  } catch {
    bad("it holds a value that is not a count or an amount");
  }
  return problems;
}

/** The lane, provider and model a call lists must be the ones its signed receipt states, where the receipt states them. */
function signedFacts(label, call, facts, fail) {
  for (const [name, value] of Object.entries(facts)) if (value !== undefined && value !== null && value !== call[name]) fail(`${label}: the listed ${name} ${call[name]} is not the signed ${value}`);
}

export const DECISION_TAG = /^sha256:[0-9a-f]{64}$/;
/** sha256:<hex> of an order's canonical JSON: the hash the decision-receipt helpers and the SDKs send as a decision tag. */
export const orderIntentHash = (order) => `sha256:${hex(sha256(Buffer.from(canonicalJson(order))))}`;

/**
 * The pack's decision tag list against the tags its signed receipts carry (`signed`: call id -> tag or null, for every call
 * whose receipt verified): one row per tagged call, each tag the signed one, and no tagged call left out. A list of problems.
 */
export function decisionTagProblems(list, signed) {
  if (!Array.isArray(list)) return ["it is not a list"];
  const problems = [];
  const seen = new Set();
  for (const row of list) {
    const id = row?.id, label = `call ${id}`;
    if (seen.has(id)) problems.push(`${label} is listed twice`);
    seen.add(id);
    if (typeof row?.decision_tag !== "string" || !DECISION_TAG.test(row.decision_tag)) problems.push(`${label}: ${row?.decision_tag} is not sha256: and 64 lowercase hex characters`);
    else if (!signed.has(id)) problems.push(`${label}: no call with a verified receipt has this id`);
    else if (signed.get(id) !== row.decision_tag) problems.push(`${label}: the listed tag is not the one its signed receipt carries (${signed.get(id) ?? "none"})`);
  }
  for (const [id, tag] of signed) if (tag && !seen.has(id)) problems.push(`call ${id}: its signed receipt carries ${tag}, but the list leaves it out`);
  return problems;
}

// ---- posted roots, against the chain (only with --rpc) -----------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(text) {
  if (typeof text !== "string" || !text.length) throw new Error("not base58");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]);
    if (carry < 0) throw new Error("not base58");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const POST_ROOT = Buffer.from([154, 210, 156, 158, 199, 27, 174, 35]); // sha256("global:post_root")[0..8]
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const HOUR = 3600;
/** How long after its hour closed a root may land and still count, unless the key document or --max-late says otherwise. */
export const DEFAULT_MAX_LATE_SECONDS = 6 * 3600;
/**
 * The most a KEY DOCUMENT can make the lateness bound: 24 hours. The document is the router's own unsigned statement,
 * and without a ceiling a document that said thirty days let a root posted three days late into a gap verify
 * (security review round 5, R5-22). A longer bound is yours to set (--max-late), not the document's.
 */
export const MAX_DOCUMENT_LATE_SECONDS = 24 * 3600;
const B58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const MEMO_LINE = /trellis:[a-z]+:v[12]:[A-Za-z0-9:-]+/g;

/** Genesis hashes of the public clusters, for network names that are not a CAIP-2 reference. */
export const KNOWN_GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
/** Whether a line's network name `ref` names the cluster with this genesis hash (`pinned`: a genesis hash you gave for your network). */
export function networkNamesGenesis(ref, genesis, pinned) {
  if (typeof genesis !== "string" || !genesis) return false;
  if (pinned && pinned.ref === ref) return pinned.genesis === genesis;
  if (KNOWN_GENESIS[ref]) return KNOWN_GENESIS[ref] === genesis;
  return /^[1-9A-HJ-NP-Za-km-z]{32}$/.test(ref) && genesis.startsWith(ref);
}

/**
 * A serialized Solana transaction (legacy or v0): its signatures, the message bytes they sign, the static account keys
 * and the instructions that touch only static keys.
 */
export function parseTransaction(raw) {
  let at = 0;
  const need = (n) => { if (at + n > raw.length) throw new Error("truncated transaction"); };
  const short = () => { let v = 0, shift = 0; for (;;) { need(1); const b = raw[at++]; v |= (b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7; if (shift > 14) throw new Error("bad length"); } };
  const take = (n) => { need(n); const out = raw.subarray(at, at + n); at += n; return out; };
  const signatures = [];
  for (let n = short(); n > 0; n--) signatures.push(take(64));
  const message = raw.subarray(at);
  need(1);
  if (raw[at] & 0x80) { if ((raw[at] & 0x7f) !== 0) throw new Error("unsupported transaction version"); at++; }
  const [required] = take(3);
  const keys = [];
  for (let n = short(); n > 0; n--) keys.push(take(32));
  take(32); // recent blockhash
  const instructions = [];
  for (let n = short(); n > 0; n--) {
    const program = take(1)[0];
    const accounts = [...take(short())];
    const data = take(short());
    if (program < keys.length && accounts.every((i) => i < keys.length)) instructions.push({ programId: base58Encode(keys[program]), accounts: accounts.map((i) => base58Encode(keys[i])), data });
  }
  if (signatures.length !== required || keys.length < required) throw new Error("the signature count does not match the message");
  return { signatures, message, keys: keys.map((k) => base58Encode(k)), rawKeys: keys, required, instructions };
}

/**
 * The transaction at finalized commitment with every required signature verified here; { ok: false, why } otherwise
 * (`unavailable` when the RPC could not be asked at all: nothing is known then).
 */
async function signedTransaction(rpc, signature) {
  let t;
  try {
    t = await rpc("getTransaction", [signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  } catch (e) {
    return { ok: false, unavailable: true, why: `the RPC could not be asked for it (${String(e?.message ?? e).slice(0, 100)})` };
  }
  if (!t) return { ok: false, notServed: true, why: "the RPC does not serve it at finalized commitment (not final yet, or that part of the history is no longer kept)" };
  if (t.meta?.err) return { ok: false, failedOnChain: true, why: "it failed on chain" };
  let tx;
  try {
    tx = parseTransaction(Buffer.from(Array.isArray(t.transaction) ? t.transaction[0] : "", "base64"));
  } catch (e) {
    return { ok: false, why: `it does not parse (${e.message})` };
  }
  if (base58Encode(tx.signatures[0]) !== signature) return { ok: false, why: "the RPC answered with a different transaction" };
  const signers = [];
  for (let i = 0; i < tx.required; i++) {
    let good = false;
    try { good = verify(null, tx.message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, tx.rawKeys[i]]), format: "der", type: "spki" }), tx.signatures[i]); } catch { good = false; }
    if (!good) return { ok: false, why: `signature ${i} does not verify over the transaction message` };
    signers.push(tx.keys[i]);
  }
  const memos = tx.instructions.filter((ix) => ix.programId === MEMO_PROGRAM).map((ix) => ({ text: ix.data.toString("utf8"), signers: ix.accounts.filter((a) => signers.includes(a)) }));
  return { ok: true, slot: t.slot, blockTime: typeof t.blockTime === "number" ? t.blockTime : null, signers, memos, instructions: tx.instructions };
}

const networkRef = (network) => { const ref = String(network ?? "").includes(":") ? String(network).slice(String(network).indexOf(":") + 1) : String(network ?? ""); return /^[A-Za-z0-9-]{1,44}$/.test(ref) ? ref : null; };
const validHour = (h) => Number.isSafeInteger(h) && h >= 0 && h % HOUR === 0;
const validCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** A router root line, v1 or v2: { version, network, hour, count, root, prev } or null. Strict, like the router's own parser. */
export function parseRootLine(text) {
  const p = String(text ?? "").split(":");
  const int = (v) => (v !== undefined && /^(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : null);
  if (p[0] !== "trellis" || p[1] !== "root" || !/^[A-Za-z0-9-]{1,44}$/.test(p[3] ?? "")) return null;
  const hour = int(p[4]), count = int(p[5]);
  if (hour === null || count === null || hour % HOUR !== 0 || !/^[0-9a-f]{64}$/.test(p[6] ?? "")) return null;
  if (p[2] === "v1" && p.length === 7) return { version: 1, network: p[3], hour, count, root: p[6], prev: null };
  if (p[2] === "v2" && p.length === 8 && (p[7] === "0" || B58_SIGNATURE.test(p[7]))) return { version: 2, network: p[3], hour, count, root: p[6], prev: p[7] === "0" ? null : p[7] };
  return null;
}
const sameClaim = (a, b) => a.root === b.root && a.count === b.count;
/** A hand-over line of an anchorer key (trellis:anchorer:v1:<network>:<from hour>:<new key>): { network, fromHour, newAnchorer } or null. Strict, like the router's own parser. */
export function parseHandOverLine(text) {
  const p = String(text ?? "").split(":");
  if (p.length !== 6 || p[0] !== "trellis" || p[1] !== "anchorer" || p[2] !== "v1" || !/^[A-Za-z0-9-]{1,44}$/.test(p[3]) || !/^(0|[1-9]\d{0,15})$/.test(p[4]) || !B58_KEY.test(p[5])) return null;
  const fromHour = Number(p[4]);
  return fromHour % HOUR === 0 ? { network: p[3], fromHour, newAnchorer: p[5] } : null;
}

/** The anchorer keys as [{ key, from_hour, rotation_tx }], oldest first; a problem string when unusable. */
export function anchorerList(doc) {
  const list = Array.isArray(doc?.anchorers) ? doc.anchorers : [];
  if (!list.length) return "no anchorer key is configured";
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (typeof k?.key !== "string" || !B58_KEY.test(k.key) || !Number.isSafeInteger(k.from_hour) || k.from_hour < 0 || k.from_hour % HOUR !== 0) return `anchorer key ${i} is malformed`;
    if (i === 0 ? k.from_hour !== 0 || k.rotation_tx : !k.rotation_tx || k.from_hour <= list[i - 1].from_hour || k.key === list[i - 1].key) return `anchorer key ${i} does not follow the key before it`;
  }
  return list;
}

/**
 * The verifier's own anchor configuration, from what the caller gave: `anchor` (an object), `keys` (the key document
 * the caller fetched from the router), `pinned` and the single settings. Nothing here reads the pack. Returns
 * { ok: true, ... } or { ok: false, why }.
 */
export function anchorConfiguration({ anchor, keys, pinned, mode, network, program, genesisHash, maxLateSeconds, allowLate, maxPages, maxReads, minKeyVersion, minAnchorers, now } = {}) {
  const doc = anchor ?? keys?.anchor ?? (keys && Array.isArray(keys.anchorers) ? keys : null);
  // A key document says how long it may be relied on (`expires_at`), and the version of its anchorer list is the
  // number of keys in it (R3-14, R4-12): an expired document, or a list shorter than one you have already seen
  // (`minAnchorers`), may miss a rotation and is refused.
  for (const d of [keys, doc]) { const why = d ? keyDocumentProblem(d, d === doc ? { now, list: "anchorers", minVersion: minAnchorers } : { now, list: "keys", minVersion: minKeyVersion }) : null; if (why) return { ok: false, why: `your key document is not usable: ${why}` }; }
  const own = { mode: mode ?? doc?.mode ?? null, network: network ?? doc?.network ?? null, program: program ?? doc?.program ?? null };
  if (!doc && !pinned) return { ok: false, why: "no anchor configuration of your own: pass --keys <the key document you fetched from the router> or --mode, --network and --anchorer. The key list inside a pack is the pack's own statement and is not used" };
  const published = anchorerList(doc ?? { anchorers: [{ key: pinned, from_hour: 0, rotation_tx: null }] });
  if (!Array.isArray(published)) return { ok: false, why: `your anchor configuration is not usable: ${published}` };
  if (pinned && published[0].key !== pinned) return { ok: false, why: `the first anchorer key of your key document is ${published[0].key}, not the pinned ${pinned}` };
  if (own.mode !== "memo" && own.mode !== "program") return { ok: false, why: "your anchor configuration does not say whether roots are posted in memo or program mode (--mode)" };
  const ref = networkRef(own.network);
  if (!ref) return { ok: false, why: "your anchor configuration does not name the network (--network, a CAIP-2 id such as solana:<32 characters of the genesis hash>)" };
  if (own.mode === "program" && (typeof own.program !== "string" || !B58_KEY.test(own.program))) return { ok: false, why: "program mode needs the anchor program id you trust (--program)" };
  const v2 = doc?.memo_v2_from_hour;
  const late = maxLateSeconds ?? (validCount(doc?.max_late_seconds) ? Math.min(doc.max_late_seconds, MAX_DOCUMENT_LATE_SECONDS) : undefined);
  return {
    ok: true, mode: own.mode, network: own.network, ref, program: own.mode === "program" ? own.program : null, anchorers: published, pinned: pinned ?? null,
    v2FromHour: validHour(v2) ? v2 : null, maxLateSeconds: validCount(late) ? late : DEFAULT_MAX_LATE_SECONDS, allowLate: !!allowLate,
    // No default limit on the walk back through the anchorer's history (R4-09): null means "to the start of the hour".
    genesis: genesisHash ? { ref, genesis: genesisHash } : null, maxPages: validCount(maxPages) && maxPages > 0 ? maxPages : null, maxReads: validCount(maxReads) && maxReads > 0 ? maxReads : null,
  };
}

/**
 * Why a key document cannot be relied on, or null: it expired (`expires_at`), its `version` does not count the keys it
 * lists, or it is older than `minVersion`. The version of a list is the number of keys in it (keys are added, never
 * removed), whether or not the document also states it. `list` names the array ("keys": the receipt keys of the whole
 * document; "anchorers": its anchor part). A document without an expiry (an older router) is not refused for that.
 */
export function keyDocumentProblem(doc, { now = Date.now(), list = "keys", minVersion } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.expires_at !== undefined && doc.expires_at !== null) {
    const until = typeof doc.expires_at === "string" ? Date.parse(doc.expires_at) : NaN;
    if (!Number.isFinite(until)) return "its expires_at is not a date";
    if (until < now) return `it expired at ${doc.expires_at}: fetch it again from the router`;
  }
  const listed = Array.isArray(doc[list]) ? doc[list].length : null;
  if (doc.version !== undefined && doc.version !== null) {
    if (!Number.isSafeInteger(doc.version) || doc.version < 0) return "its version is not a whole number";
    if (listed !== null && doc.version !== listed) return `its version (${doc.version}) does not count the ${listed} key(s) it lists`;
  }
  const version = doc.version ?? listed;
  if (minVersion !== undefined && version !== null && version < minVersion) return `it is an older version (${version} key(s)) than the one you have already seen (${minVersion})`;
  return null;
}

/** Whether the node keeps its ledger back to before `time` (or to the cluster's first block). */
async function ledgerReachesBefore(rpc, time) {
  try {
    const slot = await rpc("getFirstAvailableBlock", []);
    if (slot === 0) return true;
    if (!Number.isSafeInteger(slot)) return false;
    const t = await rpc("getBlockTime", [slot]);
    return typeof t === "number" && t < time;
  } catch {
    return false;
  }
}

/** Transactions a history walk reads at once: what bounds its memory, whatever the history holds. */
export const WALK_READ_BATCH = 16;
/** Lines one walk keeps (the earliest it saw). */
const WALK_KEEP_LINES = 64;
/** The walk FORWARD from a line only reports later lines and never decides a verdict: it keeps a budget of its own. */
const LATER_WALK = { maxPages: 20, maxReads: 2_000 };

/** Whether the node lists memo text for this address: asked about the entry of the transaction being verified, which has one. */
async function nodeIndexesMemos(rpc, anchorer, signature) {
  const newer = await rpc("getSignaturesForAddress", [anchorer, { limit: 1000, commitment: "finalized", until: signature }]);
  if (!Array.isArray(newer) || newer.length >= 1000) return false;
  const own = await rpc("getSignaturesForAddress", [anchorer, { limit: 1, commitment: "finalized", ...(newer.length ? { before: newer[newer.length - 1].signature } : {}) }]);
  return Array.isArray(own) && own[0]?.signature === signature && typeof own[0].memo === "string";
}

/**
 * The root lines `anchorer` signed that `wanted(parsed line)` picks, each read from its own finalized transaction (the
 * memo instruction signed by the anchorer, the network naming this cluster), oldest first. (`o.parse` reads another
 * kind of line instead: the hand-overs of a key, R5-19.)
 *
 * `until` walks from the newest signature back to that one and is complete when the list ends. Otherwise the walk goes
 * back (from `before`, or from the newest signature) to the first entry whose block time is before `floor`; it is
 * complete when it reaches one, or when the list ends at a node that keeps its ledger back that far.
 *
 * There is no default limit on pages or reads (security review round 4, R4-09): the list is read a page at a time and
 * the candidates of a page WALK_READ_BATCH at a time, so memory does not grow with the history. `maxPages` and
 * `maxReads` are the caller's own choice, and a walk they cut short is NOT complete. A candidate that cannot be read
 * (listed and not served, other bytes, bytes that do not verify) makes the walk incomplete too (R4-28): it is never
 * skipped as if it held nothing, and the walk goes on past it so that a conflicting line that CAN be read is found.
 */
async function walkLines(rpc, cfg, genesis, anchorer, wanted, o) {
  const found = [];
  let more = false, unread = null;
  const done = (complete, why = null) => ({ list: found.reverse(), complete: complete && !unread, why: why ?? unread, more });
  const maxPages = o.maxPages ?? Infinity, maxReads = o.maxReads ?? Infinity;
  const toFloor = !o.until;
  const parse = o.parse ?? parseRootLine;
  let before = o.before, reads = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc("getSignaturesForAddress", [anchorer, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}), ...(o.until ? { until: o.until } : {}) }]);
    if (!Array.isArray(batch)) throw new Error("the RPC did not return a signature list");
    const candidates = [];
    let reachedFloor = false;
    for (const s of batch) {
      if (toFloor && typeof s.blockTime === "number" && s.blockTime < o.floor) { reachedFloor = true; break; }
      if (s.err) continue;
      // The memo field picks candidates only where the node is known to index memos; otherwise every transaction is read.
      if (o.indexed && typeof s.memo !== "string") continue;
      if (typeof s.memo === "string" && !(s.memo.match(MEMO_LINE) ?? []).some((t) => wanted(parse(t)))) continue;
      candidates.push(s.signature);
    }
    for (let i = 0; i < candidates.length; i += WALK_READ_BATCH) {
      const chunk = candidates.slice(i, i + WALK_READ_BATCH);
      if (reads + chunk.length > maxReads) return done(false, `more than ${maxReads} transactions would have to be read`);
      reads += chunk.length;
      const read = await Promise.all(chunk.map((signature) => signedTransaction(rpc, signature)));
      for (let j = 0; j < chunk.length; j++) {
        const t = read[j];
        if (!t.ok) {
          if (t.unavailable) return done(false, t.why);
          // A transaction that landed and failed carries no line. Anything else was not read, and the walk says so.
          if (!t.failedOnChain) unread ??= `transaction ${chunk[j]} is in the anchorer's history and could not be read: ${t.why}`;
          continue;
        }
        for (const m of t.memos) {
          const claim = parse(m.text);
          if (!wanted(claim) || !m.signers.includes(anchorer) || !networkNamesGenesis(claim.network, genesis, cfg.genesis)) continue;
          found.push({ signature: chunk[j], slot: t.slot, blockTime: t.blockTime, text: m.text, claim });
          if (found.length > WALK_KEEP_LINES) { found.shift(); more = true; }
        }
      }
    }
    if (reachedFloor) return done(true);
    if (batch.length < 1000) {
      if (!toFloor) return done(true);
      return (await ledgerReachesBefore(rpc, o.floor)) ? done(true) : done(false, "the signature list ended before the range began, and the RPC does not keep its ledger back that far");
    }
    before = batch[batch.length - 1].signature;
  }
  return done(false, `the anchorer's history is longer than ${maxPages} pages for this range`);
}

/**
 * Check every posted root of a pack against the chain. `rpc(method, params)` returns the JSON-RPC result. What is
 * trusted comes from the caller: `anchor` ({ mode, network, program, anchorers, memo_v2_from_hour, max_late_seconds }),
 * or `keys` (the key document the caller fetched), with `pinned` as the first anchorer key the caller trusts; the single
 * settings `mode`, `network`, `program`, `genesisHash`, `maxLateSeconds`, `allowLate`, `maxPages` override it. The
 * pack's own `keys.anchor`, and the mode, program, network and anchorer its proofs name, are never used as settings.
 * Returns { ok, failures, lines, roots: [{ root, tx, mode, ok, status, ... }] }: `ok` only when every root verified.
 */
export async function verifyAnchorsOnChain(input, options = {}) {
  const { rpc } = options;
  const pack = input && typeof input === "object" && input.data && !input.type ? input.data : input;
  const failures = [], unknowns = [], lines = [], roots = [], notes = new Set();
  const seen = new Map();
  for (const call of Array.isArray(pack?.calls) ? pack.calls : []) for (const a of [call?.receipt?.anchor, call?.receipt?.v2?.anchor]) {
    if (!a || a.status !== "confirmed" || !a.tx) continue;
    const id = `${a.tx}:${String(a.root).toLowerCase()}`;
    if (!seen.has(id)) seen.set(id, a);
  }
  const cfg = anchorConfiguration(options);
  // Who signed the pack (R4-11): with the router's key document in hand, a pack whose signing keys are not in it is
  // refused here too, whatever its roots say.
  const trust = trustedKeys(options);
  if (trust) for (const m of signerProblems(pack?.keys, trust)) failures.push(m);
  const finish = () => {
    const good = roots.filter((r) => r.ok).length;
    lines.unshift(`Posted roots checked on chain: ${good} of ${roots.length} verified through their transaction (finalized, signed by the anchorer, exact content, in time, earliest for the hour).`);
    if (cfg.ok) lines.push(`Your configuration: ${cfg.mode} mode on ${cfg.network}${cfg.program ? `, program ${cfg.program}` : ""}; anchorer key(s) ${cfg.anchorers.map((k) => `${k.key} from hour ${k.from_hour}`).join("; ")}${cfg.pinned ? " (first key pinned by you)" : ""}.`);
    if (cfg.ok && cfg.mode === "memo") lines.push("Memo mode: no program enforces one root per hour. This check looked for other lines of the anchorer for each hour; it cannot see what the RPC does not serve.");
    for (const n of notes) lines.push(`NOT CHECKED ${n}`);
    for (const u of unknowns) lines.push(`UNKNOWN ${u}`);
    for (const f of failures) lines.push(`FAIL ${f}`);
    return { ok: failures.length === 0 && unknowns.length === 0 && roots.every((r) => r.ok), failures, unknowns, lines, roots };
  };
  const entryOf = (a) => ({ root: a.root, tx: a.tx, mode: cfg.ok ? cfg.mode : null, claimed_mode: a.mode ?? null, hour: a.hour ?? null, ok: false, status: "failed", anchorer: null, earliest: null, late: false, link: null, conflicts: [] });
  if (!cfg.ok) {
    for (const a of seen.values()) roots.push(entryOf(a));
    failures.push(cfg.why);
    return finish();
  }
  // The cluster behind the RPC must be the one the configured network names (R3-13).
  let genesis = null, genesisWhy = null;
  try {
    genesis = await rpc("getGenesisHash", []);
    if (!networkNamesGenesis(cfg.ref, genesis, cfg.genesis)) genesisWhy = `the RPC serves the cluster with genesis hash ${genesis}, which is not the cluster your network (${cfg.network}) names`;
  } catch (e) {
    genesisWhy = `the RPC could not be asked which cluster it serves (${String(e?.message ?? e).slice(0, 80)})`;
  }
  if (genesisWhy) {
    for (const a of seen.values()) roots.push({ ...entryOf(a), status: genesis ? "failed" : "unknown" });
    (genesis ? failures : unknowns).push(genesisWhy);
    return finish();
  }
  const published = cfg.anchorers;
  const indexAt = (hour) => { let at = -1; for (let i = 0; i < published.length; i++) if (published[i].from_hour <= hour) at = i; return at; };
  const rotations = new Map(); // index -> { why, unread } or null, each rotation checked once
  const rotationProblem = async (i) => {
    if (rotations.has(i)) return rotations.get(i);
    const k = published[i], prev = published[i - 1];
    const t = await signedTransaction(rpc, k.rotation_tx);
    const line = `trellis:anchorer:v1:${cfg.ref}:${k.from_hour}:${k.key}`;
    const memo = t.ok ? t.memos.find((m) => m.text === line) : null;
    let why = !t.ok ? `its rotation transaction could not be verified: ${t.why}` : !memo ? `its rotation transaction does not carry the line ${line}` : !memo.signers.includes(prev.key) ? "its rotation was not signed by the key before it" : !memo.signers.includes(k.key) ? "its rotation was not signed by the new key itself" : t.blockTime === null ? "its rotation has no block time" : t.blockTime > k.from_hour + HOUR ? "its rotation was announced after the hour it starts in" : null;
    let unread = false;
    if (!why) {
      // A key's EARLIEST finalized hand-over is its only one (security review round 5, R5-19): the rotation your list
      // names must be the first hand-over the key before it ever signed on this cluster. Its history is walked from
      // the rotation back to its beginning; what cannot be read is UNKNOWN, never a pass.
      const same = (c) => c.newAnchorer === k.key && c.fromHour === k.from_hour;
      const onCluster = (c) => networkNamesGenesis(c.network, genesis, cfg.genesis);
      if (t.memos.some((m) => { const c = parseHandOverLine(m.text); return !!c && m.signers.includes(prev.key) && onCluster(c) && !same(c); })) why = "its rotation transaction carries a second, different hand-over signed by the key before it: neither is a hand-over";
      else {
        let walk;
        try {
          const indexed = await nodeIndexesMemos(rpc, prev.key, k.rotation_tx).catch(() => false);
          walk = await walkLines(rpc, cfg, genesis, prev.key, (c) => !!c, { parse: parseHandOverLine, before: k.rotation_tx, floor: 0, indexed, maxPages: cfg.maxPages, maxReads: cfg.maxReads });
        } catch (e) {
          walk = { list: [], complete: false, why: `its history could not be read (${String(e?.message ?? e).slice(0, 80)})` };
        }
        const earlier = walk.list.find((m) => m.signature !== k.rotation_tx && !same(m.claim));
        if (earlier) why = `the key before it signed an earlier hand-over, to ${earlier.claim.newAnchorer} from hour ${earlier.claim.fromHour} (transaction ${earlier.signature}): a key's earliest hand-over is its only one, so the rotation in your list is none`;
        else if (!walk.complete) { unread = true; why = `whether the key before it handed over earlier is not known: its history was not read to its beginning (${walk.why ?? "the walk was cut short"})`; }
      }
    }
    const problem = why ? { why, unread } : null;
    rotations.set(i, problem);
    return problem;
  };
  for (const a of seen.values()) {
    const label = `root ${String(a.root).slice(0, 18)}… (hour ${a.hour}, transaction ${String(a.tx).slice(0, 12)}…)`;
    const entry = entryOf(a);
    roots.push(entry);
    const fail = (m) => { entry.status = "failed"; failures.push(`${label}: ${m}`); };
    const unknown = (m) => { entry.status = "unknown"; unknowns.push(`${label}: ${m}`); };
    const hour = a.hour, count = a.count;
    const rootHex = String(a.root ?? "").replace(/^0x/, "").toLowerCase();
    // What the pack says about mode, program and network is compared with the configuration, never used in its place.
    if (a.mode && a.mode !== cfg.mode) { fail(`the pack says this root was posted in ${a.mode} mode, but your configuration says ${cfg.mode}`); continue; }
    if (a.network && networkRef(a.network) !== cfg.ref) { fail(`the pack names network ${a.network}, but your configuration says ${cfg.network}`); continue; }
    if (!/^[0-9a-f]{64}$/.test(rootHex) || !validHour(hour) || !validCount(count)) { fail("the proof does not name a root, an hour and a count"); continue; }
    const at = indexAt(hour);
    if (at < 0) { fail("no anchorer key is configured for that hour"); continue; }
    const t = await signedTransaction(rpc, a.tx);
    if (!t.ok) { (t.unavailable ? unknown : fail)(t.why); continue; }
    if (cfg.mode === "memo") {
      // The line: as the pack gives it (a v2 line carries a link that cannot be rebuilt), but only if it says exactly
      // this network, hour, count and root; otherwise the v1 line built from them.
      let line = `trellis:root:v1:${cfg.ref}:${hour}:${count}:${rootHex}`;
      if (typeof a.memo === "string") {
        const given = parseRootLine(a.memo);
        if (!given || given.network !== cfg.ref || given.hour !== hour || given.count !== count || given.root !== rootHex) { fail("the memo line the pack gives is not a root line for this network, hour, count and root"); continue; }
        line = a.memo;
      }
      const claim = parseRootLine(line);
      let broken = null;
      for (let i = 1; i <= at && !broken; i++) { const p = await rotationProblem(i); if (p) broken = { unread: p.unread, why: `anchorer key ${i}: ${p.why}` }; }
      if (broken) { (broken.unread ? unknown : fail)(broken.why); continue; }
      const anchorer = published[at].key;
      entry.anchorer = anchorer;
      const memo = t.memos.find((m) => m.text === line);
      if (!memo) { fail(`the transaction carries no memo with exactly ${line}`); continue; }
      if (!memo.signers.includes(anchorer)) { fail(`the memo was not signed by the anchorer key configured for that hour (${anchorer}): not signed by the anchorer key`); continue; }
      // Every memo line of this very transaction (R4-10): a second line the anchorer signed in it for the hour with
      // another root or count is a conflict, and there is no "earlier" between two lines of one transaction.
      const onCluster = (c) => networkNamesGenesis(c.network, genesis, cfg.genesis);
      const differs = (m) => !sameClaim(m.claim ?? m, claim);
      if (t.memos.some((m) => { const c = parseRootLine(m.text); return m.signers.includes(anchorer) && c && c.hour === hour && onCluster(c) && differs(c); })) {
        entry.earliest = false;
        entry.conflicts = [a.tx];
        fail("the transaction itself carries two different roots for this hour, both signed by the anchorer: a conflict, and neither line is the root of the hour");
        continue;
      }
      if (t.blockTime === null) { unknown("the RPC gave no block time for the transaction, so neither its hour nor its lateness can be checked"); continue; }
      if (t.blockTime < hour) { fail("the memo was posted before the hour it claims to cover"); continue; }
      const next = published[at + 1];
      if (next && t.blockTime >= next.from_hour + HOUR) { fail(`the memo was signed by a retired key: ${anchorer} handed over at hour ${next.from_hour}, and this line landed after that hand-over took effect`); continue; }
      if (claim.version !== 2 && cfg.v2FromHour !== null && hour >= cfg.v2FromHour) { fail(`a v1 line for an hour at or after the switch to linked (v2) lines (hour ${cfg.v2FromHour})`); continue; }
      entry.late = t.blockTime > hour + HOUR + cfg.maxLateSeconds;
      if (entry.late && !cfg.allowLate) { fail(`the memo landed ${t.blockTime - hour - HOUR} seconds after its hour closed, later than the bound of ${cfg.maxLateSeconds} seconds: a late line is not an anchor (--allow-late accepts it)`); continue; }
      // The link of a v2 line (R4-28): the transaction it names must be read, must be a root line of the anchorer for
      // an EARLIER hour that landed BEFORE this one, and must be the actual previous root: the anchorer signed no root
      // that counts for an hour between the two. `0` says there is no previous root at all, and is checked the same way.
      let linkUnknown = null, between = null;
      if (claim.version === 2) {
        if (claim.prev) {
          const p = await signedTransaction(rpc, claim.prev);
          if (!p.ok && p.failedOnChain) { fail("the line's link does not hold: the transaction it names as the previous root failed on chain"); continue; }
          if (!p.ok) linkUnknown = `the transaction the line names as the previous root could not be read (${p.why})`;
          else {
            let previous = -1;
            for (const m of p.memos) {
              const c = parseRootLine(m.text);
              if (!c || c.hour >= hour || !onCluster(c)) continue;
              const i = indexAt(c.hour);
              if (i >= 0 && i <= at && m.signers.includes(published[i].key) && p.slot < t.slot) previous = Math.max(previous, c.hour);
            }
            if (previous < 0) { fail("the line's link does not hold: the transaction it names as the previous root is not an earlier root line of the anchorer"); continue; }
            between = previous + HOUR;
          }
        } else between = 0;
      }
      // The earliest finalized line for the hour is the root: look back from this one to before the hour began (and as
      // far as the link reaches), and forward from it for a later line that contradicts it.
      const from = linkUnknown || between === null ? hour : Math.min(hour, Math.max(between, published[at].from_hour));
      const passedOver = (c) => !!c && c.hour >= from && c.hour < hour;
      const none = { list: [], complete: false, why: null, more: false };
      let back, later = none;
      try {
        const indexed = await nodeIndexesMemos(rpc, anchorer, a.tx).catch(() => false);
        back = await walkLines(rpc, cfg, genesis, anchorer, (c) => !!c && (c.hour === hour || passedOver(c)), { before: a.tx, floor: from, indexed, maxPages: cfg.maxPages, maxReads: cfg.maxReads });
        if (back.complete) later = await walkLines(rpc, cfg, genesis, anchorer, (c) => !!c && c.hour === hour, { until: a.tx, floor: hour, indexed, maxPages: cfg.maxPages ?? LATER_WALK.maxPages, maxReads: cfg.maxReads ?? LATER_WALK.maxReads }).catch((e) => ({ ...none, why: String(e?.message ?? e).slice(0, 80) }));
      } catch (e) {
        unknown(`whether this is the earliest line for its hour is not known: the anchorer's history could not be read (${String(e?.message ?? e).slice(0, 80)})`);
        continue;
      }
      // A line that landed before the hour began is no line for it (the walk reaches back that far only for the link).
      const before = back.list.filter((m) => m.signature !== a.tx && m.claim.hour === hour && !(typeof m.blockTime === "number" && m.blockTime < hour));
      entry.conflicts = [...new Set([...before, ...later.list.filter((m) => m.signature !== a.tx)].filter(differs).map((m) => m.signature))];
      // The earliest TRANSACTION decides, with every line in it: one that carries another root refutes the proof.
      const first = before.filter((m) => m.signature === before[0].signature).find(differs);
      if (first) { entry.earliest = false; fail(`an earlier finalized line of the anchorer names another root for this hour (transaction ${first.signature}); the earliest line is the root`); continue; }
      // The link, second half: a root of the anchorer that counts, for an hour between the one the line names and its own.
      const counts = (m, i) => m.signature !== a.tx && m.signature !== claim.prev && m.slot < t.slot && indexAt(m.claim.hour) === i && typeof m.blockTime === "number" && m.blockTime >= m.claim.hour
        && !(published[i + 1] && m.blockTime >= published[i + 1].from_hour + HOUR) && m.blockTime <= m.claim.hour + HOUR + cfg.maxLateSeconds;
      const linkBroken = (m) => `the line's link does not hold: it ${claim.prev ? "names an older transaction as the previous root" : "says there is no previous root"}, but the anchorer signed a root for hour ${m.claim.hour} before this line (transaction ${m.signature})`;
      const skipped = back.list.find((m) => passedOver(m.claim) && counts(m, at));
      if (skipped) { fail(linkBroken(skipped)); continue; }
      if (!back.complete) { unknown(`whether this is the earliest line for its hour is not known: the anchorer's history could not be read back to before the hour began (${back.why ?? "the walk was cut short"})`); continue; }
      if (linkUnknown) { entry.link = "not_checked"; unknown(`whether the line's link holds is not known: ${linkUnknown}`); continue; }
      if (between !== null) {
        // Hours between the two that an EARLIER key owned are looked for in that key's own history.
        let bad = null, open = null;
        for (let i = at - 1; i >= 0 && !bad && !open && between < published[i + 1].from_hour; i--) {
          const lo = Math.max(between, published[i].from_hour), hi = Math.min(hour, published[i + 1].from_hour);
          if (lo >= hi) continue;
          const w = await walkLines(rpc, cfg, genesis, published[i].key, (c) => !!c && c.hour >= lo && c.hour < hi, { floor: lo, indexed: false, maxPages: cfg.maxPages, maxReads: cfg.maxReads }).catch((e) => ({ ...none, why: String(e?.message ?? e).slice(0, 80) }));
          bad = w.list.find((m) => counts(m, i)) ?? null;
          if (!bad && !w.complete) open = w.why ?? "the walk was cut short";
        }
        if (bad) { fail(linkBroken(bad)); continue; }
        if (open) { entry.link = "not_checked"; unknown(`whether the line's link names the actual previous root is not known: the history of an earlier anchorer key was not read (${open})`); continue; }
        entry.link = "verified";
      }
      if (back.more || later.more) notes.add(`${label}: the anchorer signed more than ${WALK_KEEP_LINES} lines for this range; only the earliest are listed.`);
      if (!later.complete) notes.add(`${label}: whether the anchorer signed a different line for this hour later (the history after this line was not read to its end).`);
      entry.earliest = before.length === 0;
      if (entry.conflicts.length) lines.push(`WARN ${label}: the anchorer also signed a different line for this hour later (${entry.conflicts.join(", ")}). The earliest line stands; the second one is evidence of a double post.`);
      if (entry.late) lines.push(`WARN ${label}: the line landed after the lateness bound and was accepted only because you allowed late lines.`);
      entry.ok = true;
      entry.status = "verified";
    } else {
      // Program mode: the transaction that posted the root to the anchor program YOU pinned, by YOUR anchorer key.
      if (typeof a.contract === "string" && a.contract !== cfg.program) { fail(`the pack names anchor program ${a.contract}, but your configuration says ${cfg.program}`); continue; }
      const data = Buffer.alloc(8 + 8 + 32 + 8);
      POST_ROOT.copy(data, 0); data.writeBigInt64LE(BigInt(hour), 8); Buffer.from(rootHex, "hex").copy(data, 16); data.writeBigUInt64LE(BigInt(count), 48);
      const ix = t.instructions.find((i) => i.programId === cfg.program && Buffer.from(i.data).equals(data));
      if (!ix) { fail(`the transaction carries no post_root(hour, root, count) with these values for program ${cfg.program}`); continue; }
      if (!t.signers.includes(ix.accounts[0])) { fail("the instruction's authority did not sign the transaction"); continue; }
      entry.anchorer = ix.accounts[0];
      if (published[at].key !== ix.accounts[0]) { fail(`posted by ${ix.accounts[0]}, not by the anchorer key your configuration names for that hour (${published[at].key})`); continue; }
      entry.earliest = true;
      entry.ok = true;
      entry.status = "verified";
    }
  }
  return finish();
}

function keyring(jwks, fail) {
  const keys = new Map();
  for (const k of Array.isArray(jwks?.keys) ? jwks.keys : []) {
    const raw = typeof k?.x === "string" ? Buffer.from(k.x, "base64url") : null;
    if (k?.kty !== "OKP" || k?.crv !== "Ed25519" || !raw || raw.length !== 32) {
      fail(`key ${k?.kid ?? "(no id)"}: not a 32-byte Ed25519 key`);
      continue;
    }
    if (hex(sha256(raw)).slice(0, 16) !== k.kid) {
      fail(`key ${k.kid}: its id does not match its bytes`);
      continue;
    }
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
    key.raw = hex(raw);
    keys.set(k.kid, key);
  }
  return keys;
}

/**
 * The receipt keys the CALLER trusts (security review round 4, R4-11), or null when none were given: `keys`, the key
 * document fetched by the caller from the router's /.well-known/trellis-receipt-keys.json (or a bare list of JWKs),
 * and `receiptKeys`, raw 32-byte Ed25519 public keys as hex or base64url. The key list inside a pack is the pack's own
 * statement and is never a source. Returns { keys: Map(key id -> raw key, hex), source, problems }.
 */
export function trustedKeys({ keys, receiptKeys, now, minKeyVersion } = {}) {
  const list = Array.isArray(keys) ? keys : Array.isArray(keys?.keys) ? keys.keys : null;
  const explicit = Array.isArray(receiptKeys) ? receiptKeys : receiptKeys === undefined || receiptKeys === null ? [] : [receiptKeys];
  if (!list && !explicit.length) return null;
  const problems = [], out = new Map();
  if (list) {
    const why = Array.isArray(keys) ? null : keyDocumentProblem(keys, { now, list: "keys", minVersion: minKeyVersion });
    if (why) problems.push(`the key document is not usable: ${why}`);
    for (const [id, key] of keyring({ keys: list }, (m) => problems.push(m))) out.set(id, key.raw);
  }
  for (const text of explicit) {
    const raw = typeof text === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text.replace(/^0x/, ""), "hex") : typeof text === "string" && /^[A-Za-z0-9_-]{43}=?$/.test(text) ? Buffer.from(text, "base64url") : null;
    if (!raw || raw.length !== 32) { problems.push("a receipt key you gave is not a 32-byte Ed25519 public key (64 hex characters, or base64url)"); continue; }
    out.set(hex(sha256(raw)).slice(0, 16), hex(raw));
  }
  return { keys: out, source: list && explicit.length ? "the key document and the keys you gave" : list ? "the key document you gave" : "the keys you gave", problems };
}
/** Why the keys a pack carries are not all keys the caller trusts: a list of failures (empty when they are). */
function signerProblems(jwks, trust) {
  const problems = trust.problems.map((m) => `trusted keys: ${m}`);
  for (const [id, key] of keyring(jwks, () => {})) if (trust.keys.get(id) !== key.raw) problems.push(`key ${id}: not in Trellis’s published receipt keys`);
  return problems;
}

/** One Ed25519 signature over canonical JSON: { payload, sig, key_id }. */
function signedJson(doc, keys) {
  const key = keys.get(doc?.key_id);
  const sig = b64(doc?.sig);
  if (!doc?.payload || typeof doc.payload !== "object" || !sig) return { ok: false, why: "needs payload, sig and key_id" };
  if (!key) return { ok: false, why: `signed by key ${doc.key_id}, which is not in this pack` };
  const bytes = Buffer.from(canonicalJson(doc.payload));
  let ok = false;
  try {
    ok = verify(null, bytes, key, sig);
  } catch {
    ok = false;
  }
  return ok ? { ok, bytes, sig } : { ok: false, why: "the signature does not verify: the contents were changed or not signed by that key" };
}

/**
 * Check a proof pack (the parsed file, or its { data } envelope). Returns { ok, failures, summary, lines, signer,
 * signedByTrellis }: `ok` is true only when nothing failed and the manifest verified.
 *
 * WHO signed it (R4-11) is a separate answer, as in web/lib/proof-pack-verify.js: the signatures are checked against
 * the keys the pack carries, and those keys against the ones the CALLER trusts (`keys`: the key document fetched from
 * the router's own origin; `receiptKeys`: raw public keys). `signedByTrellis` is true only when every key of the pack
 * is one of them and the manifest verified. Without a trusted key source `signer` is "unchecked", `signedByTrellis` is
 * false, the result lines say SIGNER UNCHECKED instead of "every check passed", and the command line does not exit 0:
 * a pack that is consistent with keys of its own proves nothing about who made it.
 */
export function verifyProofPack(input, { intents = [], keys: published, receiptKeys, now, minKeyVersion } = {}) {
  const pack = input && typeof input === "object" && input.data && !input.type ? input.data : input;
  const failures = [];
  const fail = (m) => failures.push(m);
  const s = { lane_report: "absent", proven_calls: 0, proven_share_of_calls: null, calls: 0, receipts: 0, without_receipt: 0, v1_valid: 0, v2: 0, v2_valid: 0, paths: 0, paths_valid: 0, onchain_roots: new Set(), offchain_roots: new Set(), unrooted: 0, refunds: 0, refunds_valid: 0, statements: 0, statements_valid: 0, keys: 0, manifest: false, decision_tags: "absent", tagged_calls: 0, intents: [] };
  const trust = trustedKeys({ keys: published, receiptKeys, now, minKeyVersion });
  if (!pack || pack.type !== PACK_TYPE) {
    fail(`not an Trellis proof pack (type ${pack?.type ?? "missing"}; expected ${PACK_TYPE})`);
    return finish(pack, s, failures, trust, false);
  }
  const keys = keyring(pack.keys, fail);
  let trusted = false;
  if (trust) {
    const problems = signerProblems(pack.keys, trust);
    for (const m of problems) fail(m);
    trusted = keys.size > 0 && problems.length === 0;
  }
  s.keys = keys.size;
  const path = (label, leaf, anchor) => {
    if (!anchor) return;
    s.paths++;
    if (merkleVerify(leaf, anchor.proof, anchor.root)) {
      s.paths_valid++;
      (anchor.status === "confirmed" && anchor.tx ? s.onchain_roots : s.offchain_roots).add(String(anchor.root).toLowerCase());
    } else fail(`${label}: the Merkle path does not lead from the receipt's leaf to root ${anchor.root}`);
  };

  const ids = new Set();
  // Decision tags read from signature-verified contents only: call id -> tag (null when the receipt carries none).
  const signedTags = new Map();
  for (const call of Array.isArray(pack.calls) ? pack.calls : []) {
    s.calls++;
    const label = `call ${call?.id}`;
    if (ids.has(call?.id)) fail(`${label}: listed twice`);
    ids.add(call?.id);
    const r = call?.receipt;
    if (!r) {
      s.without_receipt++;
      continue;
    }
    s.receipts++;
    if (r.id !== call.id) fail(`${label}: the receipt is for ${r.id}`);
    let rooted = false;
    if (r.payload) {
      const v = signedJson(r, keys);
      if (!v.ok) fail(`${label}: v1 ${v.why}`);
      else {
        s.v1_valid++;
        signedTags.set(call.id, r.payload.decision_tag ?? null);
        if (r.payload.id !== undefined && r.payload.id !== call.id) fail(`${label}: the signed receipt names call ${r.payload.id}`);
        signedFacts(label, call, { lane: r.payload.lane, provider: r.payload.provider, model: r.payload.model }, fail);
        const leaf = leafOf(Buffer.concat([v.bytes, v.sig]));
        if (r.leaf && leaf !== String(r.leaf).toLowerCase()) fail(`${label}: the v1 anchor leaf does not match the signed receipt`);
        else if (r.leaf) path(`${label} v1`, leaf, r.anchor);
        else if (r.anchor) fail(`${label}: a Merkle path without a leaf`);
        rooted ||= !!r.anchor;
      }
    }
    if (r.v2) {
      s.v2++;
      const bytes = b64(r.v2.cose);
      let d = null;
      try {
        d = bytes ? decodeCose(bytes) : null;
      } catch {
        d = null;
      }
      const key = d && keys.get(d.keyId);
      let ok = false;
      if (!d) fail(`${label}: v2 is not a readable COSE_Sign1`);
      else if (d.alg !== -8) fail(`${label}: v2 uses COSE algorithm ${d.alg}, not EdDSA`);
      else if (!key) fail(`${label}: v2 signed by key ${d.keyId}, which is not in this pack`);
      else {
        try {
          ok = verify(null, d.toBeSigned, key, d.signature);
        } catch {
          ok = false;
        }
        if (!ok) fail(`${label}: the v2 COSE signature does not verify`);
      }
      if (ok) {
        s.v2_valid++;
        const v2Tag = d.claims?.decision_tag ?? null;
        if (signedTags.has(call.id) && signedTags.get(call.id) !== v2Tag) fail(`${label}: the signed v1 and v2 receipts carry different decision tags`);
        else signedTags.set(call.id, v2Tag);
        if (d.claims?.rid !== call.id) fail(`${label}: the signed v2 claims name call ${d.claims?.rid}`);
        if (r.v2.claims && canonicalJson(r.v2.claims) !== canonicalJson(d.claims)) fail(`${label}: the readable v2 claims differ from the signed claims`);
        signedFacts(`${label} v2`, call, { lane: d.claims?.lane, provider: d.claims?.node?.provider, model: d.claims?.model?.id }, fail);
        const leaf = leafOf(bytes);
        if (r.v2.leaf && leaf !== String(r.v2.leaf).toLowerCase()) fail(`${label}: the v2 anchor leaf does not match the signed receipt`);
        else if (r.v2.leaf) path(`${label} v2`, leaf, r.v2.anchor);
        else if (r.v2.anchor) fail(`${label}: a v2 Merkle path without a leaf`);
        rooted ||= !!r.v2.anchor;
      }
    }
    if (!r.payload && !r.v2) fail(`${label}: the receipt has neither a v1 payload nor a v2 encoding`);
    if (!rooted) s.unrooted++;
  }

  // The lane report section (absent from packs made before it existed): recomputed from the calls in this file.
  if (pack.lane_report !== undefined) {
    const problems = laneReportProblems(pack.lane_report, Array.isArray(pack.calls) ? pack.calls : []);
    for (const p of problems) fail(`lane report: ${p}`);
    s.lane_report = problems.length ? "failed" : "matches";
    s.proven_calls = Number(pack.lane_report?.proven?.calls) || 0;
    s.proven_share_of_calls = pack.lane_report?.proven?.share_of_calls ?? null;
  }

  // The decision tag list (absent from packs made before it existed): exactly the tags the signed receipts carry.
  if (pack.decision_tags !== undefined) {
    const problems = decisionTagProblems(pack.decision_tags, signedTags);
    for (const p of problems) fail(`decision tags: ${p}`);
    s.decision_tags = problems.length ? "failed" : "matches";
    s.tagged_calls = [...signedTags.values()].filter(Boolean).length;
  }
  // Orders given with --intent: which calls' signed receipts carry each order's hash.
  for (const intent of intents) {
    const tag = orderIntentHash(intent.order);
    const calls = [...signedTags].filter(([, t]) => t === tag).map(([id]) => id);
    s.intents.push({ name: intent.name, tag, calls });
    if (!calls.length) fail(`order ${intent.name}: no signed receipt in this file carries its hash ${tag}`);
  }

  for (const r of Array.isArray(pack.refunds) ? pack.refunds : []) {
    s.refunds++;
    const label = `refund ${r?.id}`;
    const v = signedJson(r, keys);
    if (!v.ok) {
      fail(`${label}: ${v.why}`);
      continue;
    }
    if (r.payload.kind !== "refund" || r.payload.id !== r.id) fail(`${label}: the signed payload is not this refund receipt`);
    else if (r.leaf && leafOf(Buffer.concat([v.bytes, v.sig])) !== String(r.leaf).toLowerCase()) fail(`${label}: the anchor leaf does not match the signed receipt`);
    else {
      s.refunds_valid++;
      if (r.leaf) path(label, r.leaf, r.anchor);
    }
  }

  for (const st of Array.isArray(pack.statements) ? pack.statements : []) {
    s.statements++;
    const label = `statement ${st?.payload?.month}`;
    if (st?.payload?.type !== STATEMENT_TYPE) {
      fail(`${label}: not a monthly statement`);
      continue;
    }
    const v = signedJson(st, keys);
    if (!v.ok) fail(`${label}: ${v.why}`);
    else if (!statementReconciles(st.payload)) fail(`${label}: the amounts do not reconcile`);
    else s.statements_valid++;
  }

  const m = pack.manifest;
  const mv = signedJson(m, keys);
  if (!mv.ok) fail(`manifest: ${mv.why}`);
  else if (m.payload.type !== MANIFEST_TYPE) fail(`manifest: type ${m.payload.type}, expected ${MANIFEST_TYPE}`);
  else {
    const p = m.payload;
    const same = (a, b) => canonicalJson(a) === canonicalJson(b);
    const listed = {
      range: pack.range, scope: pack.scope, key_hash: pack.key_hash ?? null, part: pack.part, truncated: pack.truncated, next_cursor: pack.next_cursor ?? null, generated_at: pack.generated_at, router: pack.router,
      calls: (pack.calls ?? []).map((c) => ({ id: c.id, leaf: c.receipt?.leaf ?? null, leaf_v2: c.receipt?.v2?.leaf ?? null })),
      refunds: (pack.refunds ?? []).map((r) => ({ id: r.id, leaf: r.leaf ?? null })),
      statements: (pack.statements ?? []).map((x) => ({ month: x.payload?.month, key_id: x.key_id, sig: x.sig })),
      key_ids: (pack.keys?.keys ?? []).map((k) => k.kid),
      lane_report: pack.lane_report ?? null,
      decision_tags: pack.decision_tags ?? null,
    };
    const differs = Object.keys(listed).filter((k) => !same(p[k] ?? null, listed[k] ?? null));
    if (differs.length) fail(`manifest: the signed manifest does not match this file (${differs.join(", ")})`);
    else s.manifest = true;
  }
  return finish(pack, s, failures, trust, trusted);
}

const SIGNER_UNCHECKED = "SIGNER UNCHECKED: the signatures were checked against the keys inside this file, which whoever made the file put there. Run again with --keys <the key document you fetched from the router's /.well-known/trellis-receipt-keys.json>, --keys-url <that address> or --receipt-key <the router's public key>. Until then this file shows nothing about who signed it.";

function finish(pack, s, failures, trust, trusted) {
  const ok = failures.length === 0 && s.manifest;
  const signedByTrellis = !!trusted && s.manifest;
  const r = pack?.range;
  const lines = [
    `Trellis proof pack · ${r?.from ?? "?"} to ${r?.to ?? "?"} (UTC) · scope ${pack?.scope ?? "?"}${pack?.key_hash ? ` ${pack.key_hash}` : ""} · part ${pack?.part ?? 1}${pack?.truncated ? " of several" : ""}`,
    `Keys: ${s.keys} in this pack, each id matching its bytes.`,
    trust ? (trusted ? `Signer: every key in this pack is one of the receipt keys you trust (${trust.source}).` : `Signer: NOT the keys you trust (${trust.source}); see the failures below.`) : SIGNER_UNCHECKED,
    `Calls: ${s.calls} · ${s.receipts} with a signed receipt · ${s.without_receipt} without one.`,
    `Signatures: v1 ${s.v1_valid} valid · v2 ${s.v2_valid} of ${s.v2} valid · refunds ${s.refunds_valid} of ${s.refunds} valid · statements ${s.statements_valid} of ${s.statements} valid and reconciled.`,
    `Merkle paths: ${s.paths_valid} of ${s.paths} valid, under ${s.onchain_roots.size} root(s) the pack says were posted on chain (not checked without --rpc) and ${s.offchain_roots.size} kept off chain · ${s.unrooted} receipt(s) not yet rooted.`,
    `Manifest: ${s.manifest ? "signed, and lists exactly the receipts, statements and keys in this file." : "not verified."}`,
    s.lane_report === "absent"
      ? "Lane report: none in this file."
      : `Lane report: ${s.lane_report === "matches" ? "adds up and matches the calls in this file" : "does not match the calls in this file"} · ${s.proven_calls} call(s) on proven hardware (the attested and unlinkable lanes)${s.proven_share_of_calls === null ? "" : `, ${(s.proven_share_of_calls * 100).toFixed(2)}% of calls`}.`,
  ];
  if (s.decision_tags !== "absent") lines.push(`Decision tags: ${s.tagged_calls} call(s) whose signed receipt carries one · the list ${s.decision_tags === "matches" ? "names exactly those tags" : "does not match the signed receipts"}.`);
  for (const i of s.intents) lines.push(i.calls.length ? `Order ${i.name} (${i.tag}): carried by the signed receipt of ${i.calls.join(", ")}.` : `Order ${i.name} (${i.tag}): no signed receipt in this file carries it.`);
  for (const u of Array.isArray(pack?.statements_unavailable) ? pack.statements_unavailable : []) lines.push(`No statement for ${u.month}: ${u.reason}`);
  if (pack?.next_cursor) lines.push("More calls in this range are in the next part (next_cursor).");
  if (s.onchain_roots.size) lines.push("To finish, check each posted root against the chain: run again with --rpc <solana rpc url> and --keys <the key document you fetched from the router> (see the top of this file for what that checks). Until then \"posted on chain\" is the pack's own statement.");
  for (const f of failures.slice(0, 50)) lines.push(`FAIL ${f}`);
  if (failures.length > 50) lines.push(`... and ${failures.length - 50} more failures.`);
  lines.push(!ok ? `Result: ${failures.length || 1} check(s) failed.` : trust ? "Result: every check passed." : "Result: the file is consistent with the keys it carries, and the signer was NOT checked (SIGNER UNCHECKED).");
  const summary = { ...s, onchain_roots: s.onchain_roots.size, offchain_roots: s.offchain_roots.size };
  return { ok, failures, summary, lines, signer: trust ? "checked" : "unchecked", signedByTrellis };
}

const isMain = (() => {
  try {
    return import.meta.main ?? (process.argv[1] && new URL(import.meta.url).pathname === (process.argv[1].startsWith("/") ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`));
  } catch {
    return false;
  }
})();

/** Exit codes: 0 every check passed and the signer is one you trust; 1 a check failed or could not be made; 2 usage; 3 nothing failed, but the signer was not checked. */
export const EXIT_SIGNER_UNCHECKED = 3;

if (isMain) {
  const args = process.argv.slice(2);
  const VALUED = ["--intent", "--rpc", "--anchorer", "--keys", "--keys-url", "--receipt-key", "--mode", "--network", "--program", "--genesis", "--max-late", "--max-pages", "--max-reads", "--min-key-version", "--min-anchorers"];
  const FLAGS = ["--allow-late"];
  const every = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const intentFiles = every("--intent"), receiptKeys = every("--receipt-key");
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
  const rpcUrl = option("--rpc"), pinned = option("--anchorer"), keysFile = option("--keys"), keysUrl = option("--keys-url");
  const single = { mode: option("--mode"), network: option("--network"), program: option("--program"), genesisHash: option("--genesis") };
  const number = (name) => { const v = option(name); return v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : NaN; };
  const maxLateSeconds = number("--max-late"), maxPages = number("--max-pages"), maxReads = number("--max-reads"), minKeyVersion = number("--min-key-version"), minAnchorers = number("--min-anchorers");
  if (!file || [...intentFiles, ...receiptKeys].some((f) => !f || f.startsWith("--")) || [rpcUrl, pinned, keysFile, keysUrl, ...Object.values(single)].some((v) => typeof v === "string" && v.startsWith("--")) || args.some((a, i) => a.startsWith("--") && !VALUED.includes(a) && !FLAGS.includes(a)) || VALUED.some((n) => args.includes(n) && option(n) === undefined) || [maxLateSeconds, maxPages, maxReads, minKeyVersion, minAnchorers].some((n) => Number.isNaN(n)) || (single.mode !== undefined && !["memo", "program"].includes(single.mode)) || (keysFile !== undefined && keysUrl !== undefined)) {
    console.error("usage: node scripts/verify-proof-pack.mjs <trellis-proof-pack.json> (--keys <key document.json> | --keys-url <https://router/.well-known/trellis-receipt-keys.json> | --receipt-key <public key>...) [--min-key-version <n>] [--min-anchorers <n>] [--intent <order.json>]... [--rpc <solana rpc url> ([--anchorer <first anchorer key>] | --mode memo|program --network <caip-2 id> --anchorer <anchorer key> [--program <anchor program id>]) [--genesis <genesis hash>] [--max-late <seconds>] [--allow-late] [--max-pages <n>] [--max-reads <n>]]");
    process.exit(2);
  }
  const intents = [];
  for (const f of intentFiles) {
    try {
      intents.push({ name: f, order: JSON.parse(readFileSync(f, "utf8")) });
    } catch (e) {
      console.error(`Could not read ${f} as JSON: ${e.message}`);
      process.exit(2);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Could not read ${file} as JSON: ${e.message}`);
    process.exit(2);
  }
  // The key document: a file you fetched, or an address this run fetches it from. Never the copy inside the pack.
  let keys;
  if (keysFile) {
    try { keys = JSON.parse(readFileSync(keysFile, "utf8")); } catch (e) { console.error(`Could not read ${keysFile} as JSON: ${e.message}`); process.exit(2); }
  } else if (keysUrl) {
    try {
      const res = await fetch(keysUrl, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      keys = await res.json();
    } catch (e) { console.error(`Could not fetch the key document from ${keysUrl}: ${e.message}`); process.exit(2); }
  }
  const result = verifyProofPack(parsed, { intents, keys, receiptKeys, minKeyVersion });
  for (const line of result.lines) (line.startsWith("FAIL") || line.startsWith("SIGNER UNCHECKED") ? console.error : console.log)(line);
  let chainOk = true;
  if (rpcUrl) {
    let id = 0;
    const rpc = async (method, params) => {
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message ?? "RPC error");
      return j.result;
    };
    const onchain = await verifyAnchorsOnChain(parsed, { rpc, keys, receiptKeys, pinned, ...single, maxLateSeconds, maxPages, maxReads, minKeyVersion, minAnchorers, allowLate: args.includes("--allow-late") });
    for (const line of onchain.lines) (line.startsWith("FAIL") || line.startsWith("UNKNOWN") ? console.error : console.log)(line);
    chainOk = onchain.ok;
  }
  process.exit(!(result.ok && chainOk) ? 1 : result.signer === "checked" ? 0 : EXIT_SIGNER_UNCHECKED);
}
