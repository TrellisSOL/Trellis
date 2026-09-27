// Chain-agnostic hashing for Merkle trees, receipt leaves and on-chain ids: sha256 everywhere. The anchor, credits and
// bond programs must hash the same way (Solana programs have a native sha256 syscall; keccak was the EVM router's choice).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export type Hex = `0x${string}`;

/** Bytes of a value: a 0x-hex string is decoded, any other string is UTF-8, bytes pass through. */
export const toBytes = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? (/^0x([0-9a-fA-F]{2})*$/.test(v) ? hexToBytes(v.slice(2)) : utf8ToBytes(v)) : v);
export const toHex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
export const concat = (parts: readonly (Uint8Array | Hex)[]): Uint8Array => concatBytes(...parts.map(toBytes));

/** sha256 of the concatenated parts, as 0x-hex. */
export const hash256 = (...parts: (Uint8Array | string)[]): Hex => toHex(sha256(concat(parts.map(toBytes))));
/** A 32-byte id for a string (provider, model, host ids): sha256 of its UTF-8 bytes. */
export const idHash = (id: string): Hex => toHex(sha256(utf8ToBytes(id)));
/** An unsigned integer as 32 big-endian bytes (the uint256 encoding the EVM used; kept so stored leaves stay comparable). */
export function uint256(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) throw new Error("negative integer");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v > 0n) throw new Error("integer does not fit 32 bytes");
  return out;
}
export const uint32be = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
export const uint64be = (n: bigint | number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
