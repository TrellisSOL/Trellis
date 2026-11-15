// Tab session keys (docs/Trellis_Backend.md §5.2). A tab is opened from an SDK: open_tab(payer, payee, USDC, cap, expiry)
// moves the cap into escrow, and every request then carries a voucher signed by the payer's *session key*. This page
// makes that session key in the browser with WebCrypto, keeps the private half non-extractable in IndexedDB, and shows
// the public key (base58) to put in the SDK. Nothing here opens a tab or moves funds.
//
// What a voucher signs (the tab program's own bytes, src/solana/programs/tab.ts), 110 bytes:
//   "trellis:tab:voucher:v1" || tab program id (32) || tab (32) || Tab.created_at i64 LE || cumulative_used u64 LE || seq u64 LE
// The prefix keeps a voucher from being anything else the key signs; the program id binds it to one deployment (one
// cluster); created_at binds it to one opening of the tab address, so a voucher of a closed tab is worth nothing against
// a tab opened again at the same address. The 48-byte message without them is no longer accepted.
import { base58Decode, base58Encode, base64ToBytes, bytesToBase64 } from "./base58.js";

export const DB_NAME = "trellis-session-key";
const STORE = "keys";
const ITEM = "tab-session";

/** Whether this browser can make Ed25519 keys with WebCrypto (recent Chrome, Safari 17, Firefox 130). */
export async function ed25519Supported(subtle = globalThis.crypto?.subtle) {
  if (!subtle) return false;
  try {
    await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

/** A fresh non-extractable Ed25519 key pair and its public key as base58. */
export async function generateSessionKey(subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("This browser has no WebCrypto; use the SDK to make a session key.");
  let pair;
  try {
    pair = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch {
    throw new Error("This browser cannot make Ed25519 keys. Use a current Chrome, Safari or Firefox, or make the session key with the SDK.");
  }
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: base58Encode(raw), createdAt: new Date().toISOString() };
}

/** Sign bytes with the kept session key; the signature is 64 bytes, returned as base58. */
export async function signWithSessionKey(record, bytes, subtle = globalThis.crypto?.subtle) {
  const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, record.pair.privateKey, bytes));
  return base58Encode(sig);
}

// ---- vouchers ----

/** The domain separator every voucher message starts with, and the length of the whole message. */
export const VOUCHER_DOMAIN = "trellis:tab:voucher:v1";
export const VOUCHER_LENGTH = 110;
const U64_MAX = (1n << 64n) - 1n;
const le64 = (value, signed = false) => {
  const v = BigInt(value);
  if (signed ? v < -(1n << 63n) || v >= 1n << 63n : v < 0n || v > U64_MAX) throw new Error("A voucher number is out of range.");
  const out = new Uint8Array(8);
  new DataView(out.buffer)[signed ? "setBigInt64" : "setBigUint64"](0, v, true);
  return out;
};
const key32 = (text, what) => {
  let bytes;
  try { bytes = base58Decode(String(text)); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32) throw new Error(`${what} must be a Solana address (base58, 32 bytes).`);
  return bytes;
};

/**
 * The 110 bytes a session key signs for a voucher. `programId` is the router's tab program (GET /facilitator/supported),
 * `tab` the tab's address, `createdAt` the open tab's created_at (unix seconds, read from the chain once open_tab has
 * landed), `cumulativeUsed` the running total in USDC base units and `seq` the voucher's number.
 */
export function voucherMessage({ programId, tab, createdAt, cumulativeUsed, seq }) {
  if (createdAt === undefined || createdAt === null || createdAt === "") throw new Error("A voucher needs the tab’s created_at: read the open tab from the chain first.");
  const out = new Uint8Array(VOUCHER_LENGTH);
  out.set(new TextEncoder().encode(VOUCHER_DOMAIN), 0);
  out.set(key32(programId, "The tab program id"), 22);
  out.set(key32(tab, "The tab"), 54);
  out.set(le64(createdAt, true), 86);
  out.set(le64(cumulativeUsed), 94);
  out.set(le64(seq), 102);
  return out;
}

/** `Tab.created_at` (unix seconds) from a Tab account's data as getAccountInfo returns it (base64). */
export function tabCreatedAt(accountDataBase64) {
  const data = base64ToBytes(accountDataBase64);
  if (data.length < 187) throw new Error("That is not a Tab account.");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(176, true);
}

/**
 * Sign one voucher with the kept session key. Returns the message, the signature (base58) and the two request headers:
 * `X-Trellis-Tab` and `X-Trellis-Tab-Voucher: <base64 message>.<base64 signature>`.
 */
export async function signVoucher(record, voucher, subtle = globalThis.crypto?.subtle) {
  const message = voucherMessage(voucher);
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, record.pair.privateKey, message));
  return { message, signature: base58Encode(signature), headers: { "X-Trellis-Tab": String(voucher.tab), "X-Trellis-Tab-Voucher": `${bytesToBase64(message)}.${bytesToBase64(signature)}` } };
}

const openDb = (indexedDB = globalThis.indexedDB) =>
  new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error("This browser has no IndexedDB, so the session key cannot be kept."));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("The session key store could not be opened."));
    req.onblocked = () => reject(new Error("The session key store is open in another tab."));
  });
const run = (db, mode, fn) =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error || new Error("The session key store failed."));
    tx.onabort = () => reject(tx.error || new Error("The session key store aborted."));
  });

/** The kept session key record `{ pair, publicKey, createdAt }`, or null. */
export async function loadSessionKey(indexedDB) {
  const db = await openDb(indexedDB);
  try {
    return (await run(db, "readonly", (s) => s.get(ITEM))) ?? null;
  } finally {
    db.close();
  }
}
export async function saveSessionKey(record, indexedDB) {
  const db = await openDb(indexedDB);
  try {
    await run(db, "readwrite", (s) => s.put(record, ITEM));
  } finally {
    db.close();
  }
}
export async function deleteSessionKey(indexedDB) {
  const db = await openDb(indexedDB);
  try {
    await run(db, "readwrite", (s) => s.delete(ITEM));
  } finally {
    db.close();
  }
}

// ---- tabs on this router (GET /api/v1/status) ----

export const TAB_STATUS_PATH = "/api/v1/status";

/**
 * The `tabs` block of GET /api/v1/status as the page states it: whether this router bills tabs, its tab program, the
 * payee a tab must name, and the largest cap. This is the core way to read it (tabs joined the launch on 2026-11-04;
 * the hosted facilitator, below, is still off in core).
 */
export function tabView(status) {
  if (status === undefined) return { state: "loading", tab: null, headline: "Reading this router's status…" };
  if (status === null) return { state: "unreachable", tab: null, headline: "This router's status could not be read." };
  const t = status?.data?.tabs ?? status?.tabs ?? null;
  if (!t || t.enabled !== true || typeof t.program !== "string" || !t.program) return { state: "off", tab: null, headline: "Tabs are not switched on on this router." };
  const cap = Number(t.cap_usdc);
  return {
    state: "tab",
    tab: { program: t.program, payee: typeof t.payee === "string" ? t.payee : null, capUsdc: Number.isFinite(cap) && cap > 0 ? cap : null, maxUnvouched: typeof t.max_unvouched === "string" ? t.max_unvouched : null },
    headline: "Tabs are open on this router.",
  };
}

// ---- the facilitator ----

export const SUPPORTED_PATH = "/facilitator/supported";

/**
 * GET /facilitator/supported as the page states it. `kinds` lists {x402Version, scheme, network, extra}; `fee_bps`,
 * `fee_waiver_until` and `networks` say what settlement costs and where it runs.
 */
export function facilitatorView(data) {
  if (data === undefined) return { state: "loading", schemes: [], networks: [], tab: null, fee: "", headline: "Reading the facilitator…" };
  if (data === null) return { state: "unreachable", schemes: [], networks: [], tab: null, fee: "", headline: "The facilitator could not be read." };
  const kinds = Array.isArray(data?.kinds) ? data.kinds : [];
  const schemes = [...new Set(kinds.map((k) => k.scheme).filter(Boolean))];
  const networks = Array.isArray(data?.networks) ? data.networks : [...new Set(kinds.map((k) => k.network).filter(Boolean))];
  const tabKind = kinds.find((k) => k.scheme === "tab");
  const tab = tabKind ? { program: tabKind.extra?.program ?? null, feePayer: tabKind.extra?.feePayer ?? null, maxCapUnits: tabKind.extra?.maxCapUnits ?? null, versions: [...new Set(kinds.filter((k) => k.scheme === "tab").map((k) => k.x402Version))] } : null;
  if (!kinds.length) return { state: "off", schemes, networks, tab, fee: "", headline: "This router's facilitator is not switched on." };
  const bps = Number(data.fee_bps);
  const waiver = data.fee_waiver_until ? new Date(data.fee_waiver_until) : null;
  const fee = Number.isFinite(bps) && bps > 0 ? `Settlement fee ${bps / 100}%.` : waiver && !Number.isNaN(waiver.getTime()) ? `No settlement fee until ${waiver.toLocaleDateString("en-GB")}.` : "No settlement fee.";
  return { state: tab ? "tab" : "exact", schemes, networks, tab, fee, headline: tab ? "Tabs are open on this router." : "Only scheme exact is open; tabs are not switched on here yet." };
}

/** The whole-USDC cap of a tab from base units, for display. */
export const capUsdc = (units) => (units == null ? null : (Number(BigInt(units) / 10000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
