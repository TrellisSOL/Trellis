import { validRouteExplanation } from "./route-explanation.js"; // V84
// Verify page: pure helpers (no React), shared by components/Verify.jsx and its tests.
// Two jobs. Describe what the router's attestation record for a provider does and does not establish, in plain words,
// keeping "unverified" unverified. And check a pasted receipt in the browser against the router's published keys.
// The receipt code follows packages/client/src/receipts.ts; a test in the router's suite runs both on the same input.

export const KEYS_PATH = "/.well-known/trellis-receipt-keys.json";
export const attestationPath = (providerId) => `/api/v1/attestation/${encodeURIComponent(providerId)}`;

// ---- provider id in the address --------------------------------------------------------------------------------

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The provider id from `?p=` (or `?provider=`), or "" when absent or not a plausible id. */
export function providerIdFromSearch(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const id = (params.get("p") || params.get("provider") || "").trim();
  return PROVIDER_ID.test(id) ? id : "";
}
export const verifyHref = (providerId) => `/verify/?p=${encodeURIComponent(providerId)}`;

// ---- what the router's record says -----------------------------------------------------------------------------

const REASONS = {
  no_attestation: "The router has never verified this provider.",
  last_attempt_failed: "The router's most recent attempt to verify this provider failed.",
  attestation_stale: "The router's last successful verification is too old to rely on.",
  simulated_evidence_refused: "The only evidence is simulated (development) evidence, which this router does not accept.",
};

const VERIFIERS = {
  dcap: "DCAP: Intel's signature and certificate chain over the quote",
  dstack: "dstack: the deployment's compose hash against its event log",
};

const TEE = [
  [/tdx/i, "Intel TDX (confidential virtual machine)"],
  [/snp|sev/i, "AMD SEV-SNP (confidential virtual machine)"],
  [/^dev$/i, "None: simulated for development"],
];
export function teeLabel(kind) {
  if (!kind) return "Not reported";
  for (const [re, label] of TEE) if (re.test(kind)) return label;
  return String(kind);
}

const REGISTRY = {
  registered: { state: "yes", text: "Registered on chain." },
  revoked: { state: "bad", text: "Revoked on chain: this measurement is no longer accepted." },
  submitted_unconfirmed: { state: "partial", text: "Submitted to the chain but not yet confirmed." },
  proposed_waiting_timelock: { state: "no", text: "Proposed to the on-chain registry. A proposal can be registered 24 hours after it was made; until then it is not registered." },
  calldata_ready_not_submitted: { state: "no", text: "Prepared for the chain but not submitted." },
  not_submitted: { state: "no", text: "Not registered on chain." },
  not_recorded: { state: "no", text: "Nothing to register: the router has no measurement for this provider." },
};

/** "4 min ago", "3 h ago", "2 d ago"; "just now" under a minute; "" when the time is unusable. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < -60) return "in the future";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const shortDigest = (d) => (typeof d === "string" && d.length > 22 ? `${d.slice(0, 12)}…${d.slice(-8)}` : d || "");

const yes = (v) => (v ? "yes" : "no");
/** A link target the page will render: https only, no whitespace or markup characters. */
const httpsUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "");

/**
 * A view model for the page from `GET /api/v1/attestation/:providerId` (the `data` object).
 * Every row has a `state`: yes / no (established or not) / partial / bad / unknown. Nothing is upgraded: a missing
 * field reads "unknown", a false check reads "no", and "attested" appears only when the router says status is attested.
 */
export function describeAttestation(data, now = Date.now()) {
  const d = data || {};
  const status = d.status === "attested" || d.status === "simulated" ? d.status : "unverified";
  const verdict =
    status === "attested"
      ? { tone: "ok", label: "Attested", text: "The router verified this provider's hardware attestation recently and reports it as attested. That is what the router checked, listed below. It does not show what the provider does with your data, and this page did not contact the provider or read its quote." }
      : status === "simulated"
        ? { tone: "warn", label: "Simulated", text: "This provider has only simulated (development) evidence. No hardware backs it, so nothing about it is private or verified." }
        : { tone: "bad", label: "Unverified", text: `${REASONS[d.reason] || "The router has no current verification for this provider."} Treat it as an ordinary provider: nothing here should be read as a privacy guarantee.` };

  const m = d.measurement || null;
  const log = m?.transparency_log || null;
  const reg = m?.registry || null;
  const registry = REGISTRY[reg?.state] || REGISTRY.not_recorded;
  const verifiers = Array.isArray(d.verifiers) ? d.verifiers : [];

  // A signed measurement bundle (the router's record of what the compose hash, image and model digests stand for) or, older,
  // an entry the router found for the image digest. The two are worded apart: only the first says who signed the entry.
  const bundle = log?.subject === "measurement_bundle";
  const what = bundle ? "A signed measurement bundle for this compose hash was found in the log" : "An entry for the image was found";
  const logState = !m
    ? { state: "no", text: "No measurement recorded, so no log lookup was made." }
    : log?.found && log.inclusion_verified && log.checkpoint_signature_verified
      ? { state: "yes", text: `${what}, its inclusion in the log was verified, and so was the log's signature over its checkpoint.${bundle ? " The router checked that it was signed with the measurement key it publishes." : ""}` }
      : log?.found && log.inclusion_verified
        ? { state: "partial", text: `${what} and its inclusion was verified, but the log's signature over the checkpoint was not.` }
        : log?.found
          ? { state: "partial", text: `${what}, but its inclusion in the log has not been verified.` }
          : { state: "no", text: "No transparency-log entry was found for the image." };

  const attestedAt = status === "unverified" ? null : d.attested_at || null;
  return {
    status,
    verdict,
    provider: d.provider || "",
    rows: {
      tee: { label: "Hardware", value: status === "unverified" ? "Not established" : teeLabel(d.tee), state: status === "attested" ? "known" : status === "simulated" ? "simulated" : "unknown" },
      verifiers: {
        label: "Quote checked by",
        value: verifiers.length && status === "attested" ? verifiers.map((v) => VERIFIERS[v] || v) : [],
        empty: "Nobody: no verifier has accepted a quote for this provider.",
        state: status === "attested" && verifiers.length ? "yes" : "no",
      },
      lastVerified: { label: "Last verified by the router", value: attestedAt || "", relative: relativeTime(attestedAt, now), empty: "Never, or not recently enough to count.", state: attestedAt ? "yes" : "no" },
    },
    measurement: m
      ? {
          recorded: true,
          currentlyAttested: status === "attested" && !!m.attested_now,
          status: m.status,
          firstSeen: m.first_attested_at || "",
          lastSeen: m.last_seen_at || "",
          digests: [
            { key: "image", label: "Image digest", value: m.image_digest || "" },
            { key: "compose", label: "Compose hash", value: m.compose_hash || "" },
            { key: "model", label: "Model digest", value: m.model_digest || "" },
          ],
        }
      : { recorded: false, currentlyAttested: false, digests: [] },
    transparencyLog: { ...logState, index: log?.log_index ?? null, uuid: log?.uuid || "", integratedAt: log?.integrated_at || "", checkedAt: log?.checked_at || "", subject: bundle ? "measurement_bundle" : null, entryUrl: httpsUrl(log?.entry_url), bundleDigest: bundle && typeof log.bundle?.digest === "string" ? log.bundle.digest : "" },
    registry: { ...registry, address: reg?.address || "", tx: reg?.tx_hash || "", registeredAt: reg?.registered_at || "" },
    checks: [
      // The first two only count while the router calls the provider attested, whatever the flags say.
      ["quote_verified", "The router verified a hardware quote", yes(status === "attested" && d.checks?.quote_verified)],
      ["digests_bound_to_quote", "The image, compose and model digests are committed inside that quote", yes(status === "attested" && d.checks?.digests_bound_to_quote)],
      ["transparency_log_entry", bundle ? "The measurement bundle has an entry in a transparency log" : "The image has an entry in a transparency log", yes(d.checks?.transparency_log_entry)],
      ["transparency_log_checkpoint_signature", "The log's signature over that entry was verified", yes(d.checks?.transparency_log_checkpoint_signature)],
      ["registered_on_chain", "The measurement is registered on chain", yes(d.checks?.registered_on_chain)],
    ].map(([id, label, state]) => ({ id, label, state })),
    notChecked: [
      ...(Array.isArray(d.not_checked) ? d.not_checked : []),
      "Anything about the provider itself. This page reads the router's record. To check the provider's own /attest document and its TLS certificate before you send, use an SDK (see the docs).",
    ],
  };
}

// ---- receipts, in the browser ----------------------------------------------------------------------------------

// Canonical JSON: the router's `canonical` + JSON.stringify (src/lib/util.ts). Object key order comes out of the
// JavaScript engine, exactly as it does when the router signs.
function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    // A member named "__proto__" is a member like any other: assigning it would set the copy's prototype and drop it
    // from the bytes, so it could be added to a signed payload without breaking the signature (R5-22).
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) { if (k === "__proto__") Object.defineProperty(out, k, { value: canonical(value[k]), enumerable: true, writable: true, configurable: true }); else out[k] = canonical(value[k]); }
    return out;
  }
  return value;
}
export const canonicalJson = (v) => JSON.stringify(canonical(v));

const utf8 = (s) => new TextEncoder().encode(s);
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/i, "");
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(clean.match(/../g) || [], (h) => parseInt(h, 16));
}
export function base64ToBytes(text) {
  const t = String(text).trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t)) throw new Error("invalid base64");
  const std = t.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// SHA-256, synchronous (WebCrypto's digest is not), for the receipt leaf and merkle nodes: the same hash the router's
// src/lib/hash.ts and the on-chain anchor program use.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
export function hash256(data) {
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

const cmp = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
export function verifyMerkleProof(leaf, proof, root) {
  try {
    // Every element is 32 bytes and the path at most 64 long, as in the router and the client (R5-22).
    if (!Array.isArray(proof) || proof.length > 64) return false;
    let h = hexToBytes(leaf);
    const r = hexToBytes(root);
    if (h.length !== 32 || r.length !== 32) return false;
    for (const p of proof) {
      const q = hexToBytes(p);
      if (q.length !== 32) return false;
      h = hash256(cmp(h, q) < 0 ? concat(h, q) : concat(q, h));
    }
    return bytesToHex(h) === bytesToHex(r);
  } catch {
    return false;
  }
}

/** Ed25519 through WebCrypto; throws {unsupported: true} where the browser cannot. */
export async function ed25519Verify(publicKey, message, signature) {
  let key;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    throw Object.assign(new Error("This browser cannot verify Ed25519 signatures."), { unsupported: true, cause: e });
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

const pass = (id, detail) => ({ id, status: "pass", detail });
const fail = (id, detail) => ({ id, status: "fail", detail });
const skip = (id, detail) => ({ id, status: "not_checked", detail });

const receiptTime = (payload) => {
  if (typeof payload.ts === "number" && Number.isFinite(payload.ts)) return payload.ts;
  const t = Date.parse(payload.issued || "");
  return Number.isFinite(t) ? t : null;
};

// A root is a SHA-256 value the router serves as 0x-prefixed hex; show the hex itself, and the transaction the proof names.
const rootLabel = (root) => `${String(root).replace(/^0x/i, "").slice(0, 10)}…`;
const postedIn = (tx) => (typeof tx === "string" && tx ? `; the proof names transaction ${tx.length > 16 ? `${tx.slice(0, 8)}…${tx.slice(-6)}` : tx} (the router's statement: not checked against the chain here)` : "");

export const RECEIPT_NOT_CHECKED = [
  "That the signing key is the one registered on chain: compare the key id with the signer set of the trellis_anchor program, or pin the key yourself.",
  "That an anchor root was posted on chain: an inclusion proof shows the receipt sits under a root, not that the root was published. The transaction, mode and anchorer a proof names are the router's own statement, and this page does not check them. To check, run scripts/verify-proof-pack.mjs with --rpc and the key document you fetched from the router, or verifyPostedRoot in the client package with the anchor mode, network and anchorer key you trust.",
];

/**
 * Check a receipt against the router's published key set (`keys`: the JWKS, or its `keys` array) or against a raw
 * Ed25519 public key in hex (`publicKeyHex`). Returns { valid, keyId, checks, anchor, notChecked }. `valid` is true only
 * when the signature verified and nothing failed; a browser that cannot run Ed25519 gets "not_checked" and valid false.
 */
export async function verifyReceipt(receipt, opts = {}) {
  // A receipt with a v2 encoding gets both checked; v1 alone is checked exactly as before.
  const cose = typeof receipt?.cose === "string" ? receipt.cose : typeof receipt?.v2?.cose === "string" ? receipt.v2.cose : null;
  const v2opts = { keys: opts.keys, publicKeyHex: opts.publicKeyHex, ed25519: opts.ed25519 || ed25519Verify, chunks: opts.chunks };
  if (cose && !receipt.payload) {
    const v2 = await verifyReceiptV2(cose, { ...v2opts, proof: receipt.anchor });
    return { valid: v2.valid, keyId: v2.keyId, checks: v2.checks, anchor: anchorState(v2.checks), notChecked: RECEIPT_NOT_CHECKED, claims: v2.claims };
  }
  const v1 = await verifyReceiptV1(receipt, opts);
  if (!cose) return v1;
  const v2 = await verifyReceiptV2(cose, { ...v2opts, proof: receipt.v2?.anchor });
  // B: both encodings are signed by the router from the same call, so they carry the same decision tag or none.
  const t1 = receipt.payload?.decision_tag ?? null, t2 = v2.claims?.decision_tag ?? null;
  const tags = t1 === t2 ? [] : [fail("decision_tag", "The v1 and v2 receipts carry different decision tags, so they are not from the same call.")];
  return { ...v1, valid: v1.valid && v2.valid && !tags.length, checks: [...v1.checks, ...v2.checks, ...tags], claims: v2.claims };
}
const anchorState = (checks) => {
  const c = checks.find((x) => x.id === "v2_anchor_proof");
  return c?.status === "pass" ? "proof_valid" : c?.status === "fail" ? "proof_invalid" : "no_proof";
};

async function verifyReceiptV1(receipt, { keys, publicKeyHex, ed25519 = ed25519Verify, skewMs = 300_000 } = {}) {
  const checks = [];
  const keyId = typeof receipt?.key_id === "string" ? receipt.key_id : "";
  const done = (anchor) => ({ valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signature" && c.status === "pass"), keyId, checks, anchor, notChecked: RECEIPT_NOT_CHECKED });
  if (!receipt || typeof receipt !== "object" || !receipt.payload || typeof receipt.payload !== "object" || typeof receipt.sig !== "string" || !keyId) {
    checks.push(fail("shape", "A receipt needs payload, sig and key_id."));
    return done("no_proof");
  }
  if (receipt.payload.route !== undefined) checks.push(validRouteExplanation(receipt.payload.route, receipt.payload.provider) ? pass("route", "Route explanation v1 is a router-signed summary, not independent proof of selection.") : fail("route", "Invalid route explanation.")); // V84
  checks.push(receipt.alg === undefined || receipt.alg === "Ed25519" ? pass("alg", "Ed25519") : fail("alg", `Unsupported algorithm ${String(receipt.alg)}.`));

  let raw = null;
  let window = null;
  const idOf = async (bytes) => bytesToHex(await sha256(bytes)).slice(0, 16);
  if (publicKeyHex) {
    try {
      raw = hexToBytes(publicKeyHex.trim());
      if (raw.length !== 32) throw new Error("length");
    } catch {
      raw = null;
      checks.push(fail("key", "The key you entered is not 32 bytes of hex."));
    }
    if (raw) {
      const derived = await idOf(raw);
      checks.push(derived === keyId ? pass("key", `Key id ${keyId} matches the key you entered.`) : fail("key", `The receipt names key ${keyId}, but the key you entered has id ${derived}.`));
    }
  } else {
    const list = Array.isArray(keys) ? keys : keys?.keys || [];
    const jwk = list.find((k) => k.kid === keyId);
    if (!jwk) checks.push(fail("key", `Key ${keyId} is not in the router's published key list.`));
    else if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") checks.push(fail("key", "The published key is not an Ed25519 key."));
    else {
      try {
        raw = base64ToBytes(jwk.x);
        if (raw.length !== 32) throw new Error("length");
        const derived = await idOf(raw);
        checks.push(derived === keyId ? pass("key", `Key ${keyId} is in the router's published list and its id matches its bytes.`) : fail("key", `The published entry's id does not match its key bytes (${derived}).`));
        window = { from: jwk.valid_from ? Date.parse(jwk.valid_from) : null, to: jwk.retired_at ? Date.parse(jwk.retired_at) : null };
      } catch {
        raw = null;
        checks.push(fail("key", "The published key is malformed."));
      }
    }
  }

  let sig = null;
  try {
    sig = base64ToBytes(receipt.sig);
  } catch {
    checks.push(fail("signature", "The signature is not valid base64."));
  }
  const bytes = utf8(canonicalJson(receipt.payload));
  if (raw && sig && !checks.some((c) => c.id === "key" && c.status === "fail")) {
    try {
      checks.push((await ed25519(raw, bytes, sig)) ? pass("signature", "The signature over the receipt's contents verifies with that key.") : fail("signature", "The signature does not verify: the receipt was changed or was not signed by that key."));
    } catch (e) {
      checks.push(e?.unsupported ? skip("signature", `${e.message} Use one of the SDKs to check it.`) : fail("signature", String(e?.message || e)));
    }
  } else if (!checks.some((c) => c.id === "signature")) {
    checks.push(fail("signature", "Not verified: there is no usable key or signature."));
  }

  const t = receiptTime(receipt.payload);
  if (window && t !== null && (window.from !== null || window.to !== null)) {
    const early = window.from !== null && t < window.from - skewMs;
    const late = window.to !== null && t > window.to + skewMs;
    checks.push(early || late ? fail("key_window", "The receipt is dated outside its signing key's validity window.") : pass("key_window", "The receipt's date is inside its key's validity window."));
  } else checks.push(skip("key_window", "No key window or receipt date to compare."));

  if (receipt.leaf && sig) {
    const leaf = "0x" + bytesToHex(hash256(hash256(concat(bytes, sig))));
    checks.push(leaf === String(receipt.leaf).toLowerCase() ? pass("leaf", "The receipt's anchor leaf matches its contents and signature.") : fail("leaf", "The anchor leaf does not match the receipt's contents and signature."));
  } else checks.push(skip("leaf", "The receipt carries no anchor leaf."));

  let anchor = "no_proof";
  const proof = receipt.anchor;
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string" && receipt.leaf) {
    const ok = verifyMerkleProof(receipt.leaf, proof.proof, proof.root);
    anchor = ok ? "proof_valid" : "proof_invalid";
    checks.push(ok ? pass("anchor_proof", `The receipt is included under root ${rootLabel(proof.root)}${proof.tx ? postedIn(proof.tx) : " (a root kept off chain, not posted)"}`) : fail("anchor_proof", "The inclusion proof does not lead from the receipt to the stated root."));
  } else checks.push(skip("anchor_proof", "No inclusion proof yet. The router adds receipts to a Merkle root on a schedule, so fetch it again later. A root is posted on chain only when its proof names a transaction."));
  return done(anchor);
}

// ---- receipt v2 (COSE_Sign1, EdDSA), the same checks as packages/client/src/receipts-v2.ts ----------------------

function decodeCbor(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("truncated CBOR");
  };
  const item = () => {
    need(1);
    const b = bytes[at++];
    const major = b >> 5;
    const info = b & 0x1f;
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
      const s = bytes.slice(at, at + n);
      at += n;
      return major === 2 ? s : new TextDecoder().decode(s);
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
const cborHead = (major, n) => (n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : n < 65536 ? Uint8Array.of((major << 5) | 25, n >> 8, n & 255) : Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255));
const cborBstr = (b) => concat(cborHead(2, b.length), b);
const sigStructure = (prot, payload) => concat(cborHead(4, 4), cborHead(3, 10), utf8("Signature1"), cborBstr(prot), cborBstr(new Uint8Array()), cborBstr(payload));

/** COSE_Sign1 bytes into { alg, keyId, claims, prot, payload, signature }. Throws on anything malformed. */
export function decodeReceiptV2(bytes) {
  let v = decodeCbor(bytes);
  if (v && v.tag !== undefined && !(v instanceof Map) && !Array.isArray(v)) {
    if (v.tag !== 18) throw new Error("not a COSE_Sign1");
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4 || !(v[0] instanceof Uint8Array) || !(v[2] instanceof Uint8Array) || !(v[3] instanceof Uint8Array)) throw new Error("not a COSE_Sign1");
  const hdr = decodeCbor(v[0]);
  const kid = hdr instanceof Map ? hdr.get(4) : null;
  return { alg: hdr instanceof Map ? hdr.get(1) : null, keyId: kid instanceof Uint8Array ? bytesToHex(kid) : "", claims: cborJson(decodeCbor(v[2])), prot: v[0], payload: v[2], signature: v[3] };
}

/** The chunk hash chain head over streamed event data: c_0 = SHA-256(rid), c_i = SHA-256(c_{i-1} || chunk_i). */
export async function chunkChainHead(rid, chunks) {
  let c = await sha256(utf8(rid));
  for (const d of chunks) c = await sha256(concat(c, utf8(d)));
  return "sha256:" + bytesToHex(c);
}

/** Checks a v2 receipt in order: signature, chain head (when events are given), anchor proof. Ids are prefixed v2_. */
export async function verifyReceiptV2(coseB64, { keys, publicKeyHex, ed25519 = ed25519Verify, chunks, proof } = {}) {
  const checks = [];
  let bytes, d;
  try {
    bytes = base64ToBytes(coseB64);
    d = decodeReceiptV2(bytes);
  } catch (e) {
    return { valid: false, keyId: "", claims: null, checks: [fail("v2_shape", `The v2 receipt is not a readable COSE_Sign1 (${e.message}).`)] };
  }
  if (d.claims.route !== undefined) checks.push(validRouteExplanation(d.claims.route, d.claims.node?.provider) ? pass("v2_route", "Route explanation v1 is covered by the COSE signature; routing itself is not independently checked.") : fail("v2_route", "Invalid route explanation.")); // V84
  checks.push(d.alg === -8 ? pass("v2_alg", "v2: COSE_Sign1 with EdDSA.") : fail("v2_alg", `v2: unsupported COSE algorithm ${String(d.alg)}.`));
  let raw = null;
  try {
    if (publicKeyHex) raw = hexToBytes(publicKeyHex.trim());
    else {
      const jwk = (Array.isArray(keys) ? keys : keys?.keys || []).find((k) => k.kid === d.keyId);
      if (jwk && jwk.kty === "OKP" && jwk.crv === "Ed25519") raw = base64ToBytes(jwk.x);
    }
  } catch {
    raw = null;
  }
  if (!raw || raw.length !== 32) checks.push(fail("v2_signature", `v2: key ${d.keyId || "(none)"} is not available to check against.`));
  else if (bytesToHex(await sha256(raw)).slice(0, 16) !== d.keyId) checks.push(fail("v2_signature", `v2: the receipt names key ${d.keyId}, which is not this key.`));
  else {
    try {
      checks.push((await ed25519(raw, sigStructure(d.prot, d.payload), d.signature)) ? pass("v2_signature", "v2: the COSE signature over the claims verifies.") : fail("v2_signature", "v2: the COSE signature does not verify: the claims were changed or not signed by that key."));
    } catch (e) {
      checks.push(e?.unsupported ? skip("v2_signature", `${e.message} Use one of the SDKs to check it.`) : fail("v2_signature", String(e?.message || e)));
    }
  }
  if (Array.isArray(chunks)) {
    const head = await chunkChainHead(d.claims.rid, chunks);
    checks.push(head === d.claims.resp?.chain ? pass("v2_chain", `v2: the chain head over ${chunks.length} streamed events matches.`) : fail("v2_chain", "v2: the chain head does not match the streamed events: the stream was cut or changed."));
  } else checks.push(skip("v2_chain", d.claims.resp?.chain ? `v2: signed chain head ${shortDigest(d.claims.resp.chain)}. Paste the streamed events to check it.` : "v2: not a streamed response, so there is no chain."));
  const leaf = "0x" + bytesToHex(hash256(hash256(bytes)));
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string") {
    const ok = verifyMerkleProof(leaf, proof.proof, proof.root);
    checks.push(ok ? pass("v2_anchor_proof", `v2: included under root ${rootLabel(proof.root)}${proof.anchored || proof.tx ? postedIn(proof.tx) : " (a root kept off chain, not posted)"}`) : fail("v2_anchor_proof", "v2: the Merkle path does not lead from this receipt to the root."));
  } else checks.push(skip("v2_anchor_proof", "v2: no Merkle path yet. Fetch the receipt again later; a root is posted on chain only when its proof names a transaction."));
  return { valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "v2_signature" && c.status === "pass"), keyId: d.keyId, claims: d.claims, leaf, checks };
}

// ---- decision tags (B) ---------------------------------------------------------------------------------------------
// A caller may send X-Trellis-Decision-Tag with a model call: the SHA-256 of the order its agent is about to place. The
// router signs it into that call's v1 receipt (payload.decision_tag) and v2 claims (claims.decision_tag). The page shows it
// and hashes an order pasted here the way the helpers and SDKs do; only the two hashes are compared, nothing is sent.

const TAG = /^sha256:[0-9a-f]{64}$/;

/**
 * The decision tag a receipt carries, from its v1 payload or its v2 claims (pass the decoded, signed claims when the
 * receipt was checked), or null. `agree` is false when the two encodings name different tags.
 */
export function receiptDecisionTag(receipt, claims) {
  const v1 = typeof receipt?.payload?.decision_tag === "string" ? receipt.payload.decision_tag : null;
  const c = claims ?? receipt?.v2?.claims ?? (typeof receipt?.claims === "object" ? receipt.claims : null);
  const v2 = typeof c?.decision_tag === "string" ? c.decision_tag : null;
  const tag = v1 ?? v2;
  return tag ? { tag, v1, v2, agree: !v1 || !v2 || v1 === v2, wellFormed: TAG.test(tag) } : null;
}

/**
 * `sha256:<hex>` of an order's canonical JSON (keys sorted, no spaces), the same bytes the decision-receipt helpers and
 * the SDKs hash, or a pasted `sha256:` digest as it is. Returns { tag } or { error }. Runs in this browser only.
 */
export async function orderDecisionTag(text) {
  const s = String(text || "").trim();
  if (!s) return { error: "Paste the order first." };
  if (/^(?:sha256:)?[0-9a-fA-F]{64}$/.test(s)) return { tag: "sha256:" + s.replace(/^sha256:/, "").toLowerCase(), digest: true };
  let value;
  try {
    value = JSON.parse(s);
  } catch {
    return { error: "That is not valid JSON. Paste the order exactly as your agent hashed it." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "An order is a JSON object, for example {\"symbol\":\"STOCK_A\",\"side\":\"buy\",\"quantity\":\"2\"}." };
  return { tag: "sha256:" + bytesToHex(await sha256(utf8(canonicalJson(value)))) };
}

/**
 * Turn whatever was pasted into a receipt envelope. Accepts the receipt itself, a chat response holding `receipt`, or a
 * receipt lookup response ({ data: ... }). A v2-only receipt ({ cose }) works too. Returns { receipt } or { error }.
 */
export function parseReceiptInput(text) {
  const s = String(text || "").trim();
  if (!s) return { error: "Paste a receipt first." };
  let json;
  try {
    json = JSON.parse(s);
  } catch {
    return { error: "That is not valid JSON. Paste the whole receipt object." };
  }
  const candidates = [json, json?.receipt, json?.data, json?.data?.receipt];
  const receipt =
    candidates.find((c) => c && typeof c === "object" && c.payload && typeof c.sig === "string" && typeof c.key_id === "string") ||
    candidates.find((c) => c && typeof c === "object" && typeof c.cose === "string");
  if (!receipt) return { error: "No receipt found. It needs payload, sig and key_id, or a v2 cose field (a chat response's receipt field, or GET /api/v1/receipts/:id, works)." };
  return { receipt };
}

/** A receipt the sidecar signed with its enclave key: the router's key list will not contain that key. */
export const isEnclaveReceipt = (receipt) => receipt?.payload?.type === "trellis.sidecar.receipt";
