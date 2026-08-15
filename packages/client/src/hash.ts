import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8 } from "./bytes.js";

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return s;
};

const asBuffer = (b: Uint8Array) => b as unknown as BufferSource;

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", asBuffer(typeof data === "string" ? utf8(data) : data)));
}
export const sha256Hex = async (data: Uint8Array | string) => bytesToHex(await sha256(data));

// ---- SHA-256, synchronously ------------------------------------------------------------------------------------------
// Receipt leaves and Merkle nodes are sha256 (Trellis anchors them from a Solana program, which hashes with sha256). The
// server-side Merkle code (src/receipts/merkle.ts and the anchor program) must use exactly this rule:
//   leaf = sha256(sha256(bytes)), node = sha256(min(a,b) || max(a,b)).
// @noble/hashes gives a synchronous sha256 so the leaf and proof checks stay synchronous.

export function sha256Sync(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? utf8(data) : data);
}
export const sha256SyncHex = (data: Uint8Array | string) => bytesToHex(sha256Sync(data));

/** sha256(sha256(data)): the double hash used for anchor leaves, 0x-prefixed hex. */
export const sha256dHex = (data: Uint8Array) => "0x" + bytesToHex(sha256Sync(sha256Sync(data)));
