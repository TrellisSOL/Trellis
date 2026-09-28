import { createPublicKey, verify } from "node:crypto";
import { base58Decode } from "../solana/constants.ts";

// Solana wallet message signatures (web/PORT-NOTES.md, "API contract the router must implement").
//   address   = base58 of the wallet's 32-byte ed25519 public key
//   signature = base58 of the 64-byte detached ed25519 signature over the exact UTF-8 bytes of the message
// Addresses are case-sensitive and are stored exactly as the wallet presents them (never lowercased).

/** Base58 alphabet, 32 to 44 characters: the shape of a 32-byte public key. Decoding still has to yield 32 bytes. */
export const WALLET_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Base58, 64 to 88 characters: the shape of a 64-byte signature. */
export const WALLET_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// ---- Wallet sign-in (security review TR-17) -------------------------------------------------------------------------------
// The text a wallet signs to sign in names the site it signs in to. It is a Sign-In-With-Solana message (the EIP-4361
// layout): the router's domain on the first line, then the address, a statement, and the URI, version, network, nonce
// and validity. A wallet shows the domain, and wallets that know the format check it against the page that asked, so a
// phishing page cannot pass this router's challenge off as its own login. The earlier form,
// "trellis:wallet:v1\n<nonce>\n<time>", named no site and is no longer accepted: the router verifies a signature over
// exactly the message it issued with the challenge, and nothing else.

/** Version of the sign-in scheme the challenge route reports. v1 (no domain in the signed text) is retired. */
export const WALLET_SIGN_IN_VERSION = "trellis:wallet:v2";
/** The statement line of the sign-in message. */
export const WALLET_SIGN_IN_STATEMENT = "Sign in to Trellis with this wallet. Signing proves you hold the address: it sends no transaction and costs nothing.";

export type WalletSignIn = {
  /** Host (and port) of the site being signed in to: the first thing the wallet shows. */
  domain: string;
  /** The wallet's base58 address. */
  address: string;
  statement: string;
  /** Origin of the router the signature is for. */
  uri: string;
  /** Version of the message format: "1". */
  version: string;
  /** The network (CAIP-2), so a signature for one cluster's router is not one for another's. */
  chainId: string;
  nonce: string;
  /** ISO 8601 times: when the challenge was issued and when it stops being accepted. */
  issuedAt: string;
  expirationTime: string;
};

/** The exact text a wallet signs to sign in (no trailing newline). The challenge route returns it ready to sign. */
export function walletSignInMessage(f: WalletSignIn): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    `Version: ${f.version}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ].join("\n");
}

/** Read a sign-in message back into its fields (a client checks `domain` before it signs); null when it is not one. */
export function parseWalletSignInMessage(message: string): WalletSignIn | null {
  const m = /^([^\s]+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n([^\n]*)\n\nURI: ([^\n]+)\nVersion: ([^\n]+)\nChain ID: ([^\n]+)\nNonce: ([^\n]+)\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(message);
  if (!m) return null;
  const f: WalletSignIn = { domain: m[1], address: m[2], statement: m[3], uri: m[4], version: m[5], chainId: m[6], nonce: m[7], issuedAt: m[8], expirationTime: m[9] };
  return walletSignInMessage(f) === message ? f : null;
}

// ---- X-Wallet-Auth (security review TR-20) ---------------------------------------------------------------------------------
// A wallet signs one request: the method, the router it is for, the path (query string included), a unix time and the
// SHA-256 of what the route binds (its request body, or a resource hash on a route without one). The earlier message,
// "trellis:<time>:<sha256>", named no method, path or host, so a signature over an empty body was good for every
// body-less route of every router for five minutes. It is no longer accepted.
//
//   trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unixSeconds>\n<sha256 hex>
//
// METHOD is upper case; host is the router's public host as configured (the host[:port] of PUBLIC_BASE_URL, lower case:
// the same value the sign-in challenge calls `domain`); path is the request target exactly as sent, from the first "/"
// to the end of the query string. No trailing newline.

/** Version line of the X-Wallet-Auth message. v1 ("trellis:<time>:<sha256>") is retired. */
export const WALLET_AUTH_VERSION = "trellis:wallet-auth:v2";

export type WalletAuthRequest = {
  /** HTTP method; compared in upper case. */
  method: string;
  /** The router's public host (host[:port]); compared in lower case. */
  host: string;
  /** Path and query string of the request, as sent ("/api/v1/generation?id=gen_1"). */
  path: string;
  /** Unix seconds. */
  timestamp: number | string;
  /** SHA-256 (lower-case hex) of what the route binds: the request body's hash, or a resource hash. */
  bodySha: string;
};

/** The exact text behind an X-Wallet-Auth signature (UTF-8, no trailing newline). */
export function walletAuthMessage(r: WalletAuthRequest): string {
  const fields = [WALLET_AUTH_VERSION, r.method.toUpperCase(), r.host.toLowerCase(), r.path, String(r.timestamp), r.bodySha];
  // One field per line: a field that carried a line break could pass for two.
  if (fields.some((f) => /[\r\n]/.test(f))) throw new RangeError("wallet-auth fields must not contain line breaks");
  return fields.join("\n");
}

/** Decode a base58 string that must be exactly `length` bytes, or null. */
export function decodeBase58Bytes(text: string, length: number): Uint8Array | null {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) return null;
  try {
    const bytes = base58Decode(text);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

/** The 32 public-key bytes of a base58 Solana address, or null when it is not one. */
export const decodeWalletAddress = (address: string) => (WALLET_ADDRESS_RE.test(address) ? decodeBase58Bytes(address, 32) : null);
/** The 64 bytes of a base58 ed25519 signature, or null. */
export const decodeWalletSignature = (signature: string) => (WALLET_SIGNATURE_RE.test(signature) ? decodeBase58Bytes(signature, 64) : null);
export const isWalletAddress = (v: unknown): v is string => typeof v === "string" && decodeWalletAddress(v) !== null;
export const isWalletSignature = (v: unknown): v is string => typeof v === "string" && decodeWalletSignature(v) !== null;

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Whether `signature` (base58) is the wallet at `address` (base58) signing exactly `message` (a string is its UTF-8
 * bytes). Never throws: a malformed address, signature or key is simply not a valid signature.
 */
export function verifyWalletSignature(address: string, message: string | Uint8Array, signature: string): boolean {
  const pub = decodeWalletAddress(address);
  const sig = decodeWalletSignature(signature);
  if (!pub || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
    const bytes = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
    return verify(null, bytes, key, Buffer.from(sig));
  } catch {
    return false;
  }
}
