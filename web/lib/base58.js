// Base58 (Bitcoin alphabet) for Solana addresses and signatures, without a dependency. Addresses are 32-byte ed25519
// public keys, signatures 64 bytes; both are shown and sent as base58 text.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** The characters base58 uses; a 32-byte value is 32 to 44 of them, a 64-byte one 64 to 88. */
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

/** Decodes base58 text; throws on a character outside the alphabet. */
export function base58Decode(text) {
  const s = String(text ?? "");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = INDEX.get(s[i]);
    if (carry === undefined) throw new Error("not a base58 string");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** Decoded length of base58 text, or -1 when it is not base58. */
const decodedLength = (text) => {
  if (typeof text !== "string" || !BASE58_RE.test(text)) return -1;
  try {
    return base58Decode(text).length;
  } catch {
    return -1;
  }
};

/** A Solana address: base58 text that decodes to exactly 32 bytes. */
export const isAddress = (text) => decodedLength(text) === 32;
/** A Solana transaction signature or ed25519 signature: base58 text that decodes to exactly 64 bytes. */
export const isSignature = (text) => decodedLength(text) === 64;

/** "Ab3d…9xYz": the first and last four characters of an address or signature. */
export const shortAddress = (a) => (a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "");

export const hexToBytes = (hex) => {
  const h = String(hex ?? "").replace(/^0x/, "");
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error("not a hex string");
  return new Uint8Array(h.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
};
export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const bytesToBase64 = (bytes) => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const base64ToBytes = (text) => {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  const s = atob(text);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
