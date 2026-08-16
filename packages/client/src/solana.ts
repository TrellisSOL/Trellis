// Solana payments for Trellis: x402 `exact` per-call payments (HTTP 402 -> X-PAYMENT), tabs (the trellis_tab program
// and its off-chain vouchers), transaction signing for credit deposits, closures and refund destinations, and X-Wallet-Auth.
//
// Everything on the wire is encoded here: base58, program-derived addresses, legacy transaction messages, SPL Token
// and trellis_tab instruction bytes, ed25519 signing through WebCrypto or node:crypto. The module therefore has no
// dependency on @solana/web3.js. Where that library's objects fit (a Keypair as a signer, a Connection for the recent
// blockhash, a PublicKey wherever an address is taken) they are accepted by shape.
//
// Wire formats follow src/solana/x402.ts (inspectExactTransaction), src/solana/programs/tab.ts (the program interface)
// and src/lib/wallet-sig.ts on the router side. The suite checks them against sdks/fixtures/contracts.json, which the
// router's own code produces.

import { base64ToBytes, bytesToBase64, concatBytes, fromUtf8, hexToBytes, randomBytes, utf8 } from "./bytes.js";
import { defaultEd25519Verify, UnsupportedCrypto } from "./ed25519.js";
import { TrellisError } from "./errors.js";
import { canonicalJson } from "./canonical.js";
import { sha256Sync, sha256SyncHex } from "./hash.js";
import type { Fetch } from "./types.js";
/** Local alias so the module typechecks without DOM lib types (Bun, Node and browsers all accept it). */
type HeadersInit = ConstructorParameters<typeof Headers>[0];

// ---- Constants -------------------------------------------------------------------------------------------------------

/** USDC mint on Solana mainnet-beta (6 decimals). Amounts on the wire are base-unit integers as strings. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
/** CAIP-2 network identifiers, as x402 names Solana networks. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Anchor discriminators of the trellis_tab instructions and the Tab account. */
export const OPEN_TAB_DISCRIMINATOR = new Uint8Array([76, 59, 11, 59, 218, 58, 30, 59]);
export const TOP_UP_DISCRIMINATOR = new Uint8Array([236, 225, 96, 9, 60, 106, 77, 208]);
export const RECLAIM_DISCRIMINATOR = new Uint8Array([44, 177, 236, 249, 145, 109, 163, 186]);
export const TAB_ACCOUNT_DISCRIMINATOR = new Uint8Array([194, 242, 40, 53, 214, 169, 9, 172]);
/** A voucher message: tab (32) || cumulative_used u64 LE || seq u64 LE. */
/** The domain separator every voucher message starts with (22 ASCII bytes). */
export const VOUCHER_DOMAIN = "trellis:tab:voucher:v1";
/** 22 (domain) + 32 (program id) + 32 (tab) + 8 (created_at) + 8 (cumulative_used) + 8 (seq). */
export const VOUCHER_MESSAGE_LENGTH = 110;
/** A tab's expiry is at most this far from the moment it is opened: the program refuses more. */
export const MAX_TAB_LIFETIME_SECONDS = 30 * 86_400;

// ---- base58 ----------------------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
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
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]);
    if (carry < 0) throw new TrellisError("not a base58 string", "bad_options");
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
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);
  return out;
}

// ---- Keys and addresses ----------------------------------------------------------------------------------------------

/** An address: base58, 32 raw bytes, or anything with `toBytes()` (a @solana/web3.js PublicKey). */
export type PublicKeyLike = string | Uint8Array | { toBytes(): Uint8Array };

export function publicKeyBytes(k: PublicKeyLike): Uint8Array {
  const b = typeof k === "string" ? base58Decode(k) : k instanceof Uint8Array ? k : k.toBytes();
  if (b.length !== 32) throw new TrellisError("a Solana public key is 32 bytes", "bad_options");
  return new Uint8Array(b);
}

/** The base58 form of an address. */
export const address = (k: PublicKeyLike): string => base58Encode(publicKeyBytes(k));

const le64 = (v: bigint | number): Uint8Array => {
  const n = BigInt(v);
  if (n < 0n || n > 0xffffffffffffffffn) throw new TrellisError("value does not fit in a u64", "bad_options");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
const le64i = (v: bigint | number): Uint8Array => {
  const n = BigInt(v);
  if (n < -(1n << 63n) || n >= 1n << 63n) throw new TrellisError("value does not fit in an i64", "bad_options");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, n, true);
  return out;
};
const readU64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
const readI64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(at, true);

// ed25519 curve membership (for program-derived addresses), the check @solana/web3.js makes through noble-curves:
// decompress y, solve x^2 = (y^2 - 1) / (d y^2 + 1); the point is on the curve when a root exists.
const P = (1n << 255n) - 19n;
const modP = (a: bigint) => {
  const r = a % P;
  return r < 0n ? r + P : r;
};
function powP(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = modP(r * b);
    b = modP(b * b);
    e >>= 1n;
  }
  return r;
}
const ED_D = modP(-121665n * powP(121666n, P - 2n));

/** Whether 32 bytes decode to a point on ed25519 (then they cannot be a program-derived address). */
export function isOnCurve(key: Uint8Array): boolean {
  if (key.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(key[i]);
  y &= (1n << 255n) - 1n;
  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(ED_D * y2 + 1n);
  const v3 = modP(v * v * v);
  const v7 = modP(v3 * v3 * v);
  const x = modP(u * v3 * powP(modP(u * v7), (P - 5n) / 8n));
  const vx2 = modP(v * x * x);
  return vx2 === u || vx2 === modP(-u);
}

const PDA_MARKER = utf8("ProgramDerivedAddress");

/** sha256(seeds || programId || "ProgramDerivedAddress"), or null when the hash lands on the curve. */
export function createProgramAddress(seeds: Uint8Array[], programId: PublicKeyLike): Uint8Array | null {
  for (const s of seeds) if (s.length > 32) throw new TrellisError("a PDA seed is at most 32 bytes", "bad_options");
  const h = sha256Sync(concatBytes(...seeds, publicKeyBytes(programId), PDA_MARKER));
  return isOnCurve(h) ? null : h;
}

/** The program-derived address for `seeds` and the bump that produced it (bump 255 downwards). */
export function findProgramAddress(seeds: Uint8Array[], programId: PublicKeyLike): { address: string; bytes: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const bytes = createProgramAddress([...seeds, new Uint8Array([bump])], programId);
    if (bytes) return { address: base58Encode(bytes), bytes, bump };
  }
  throw new TrellisError("no viable program address for these seeds", "bad_options");
}

/** The associated token account of `owner` for `mint` (base58). */
export const associatedTokenAddress = (owner: PublicKeyLike, mint: PublicKeyLike = USDC_MINT, tokenProgram: PublicKeyLike = TOKEN_PROGRAM): string =>
  findProgramAddress([publicKeyBytes(owner), publicKeyBytes(tokenProgram), publicKeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM).address;

// ---- ed25519 signing (WebCrypto first, then node:crypto) ----------------------------------------------------------------

/** Signs 32-byte messages and whole transaction messages with one ed25519 key. A wallet adapter fits this shape. */
export type Signer = { publicKey: PublicKeyLike; sign(message: Uint8Array): Promise<Uint8Array> };

const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");
const asBuffer = (b: Uint8Array) => b as unknown as BufferSource;
const nodeCrypto = () => import(/* webpackIgnore: true */ /* @vite-ignore */ ["node", "crypto"].join(":")) as Promise<typeof import("node:crypto")>;

async function edSign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = concatBytes(PKCS8_PREFIX, seed);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const key = await subtle.importKey("pkcs8", asBuffer(pkcs8), { name: "Ed25519" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, asBuffer(message)));
    } catch {
      /* this runtime's WebCrypto has no Ed25519: try node:crypto */
    }
  }
  try {
    const mod = await nodeCrypto();
    return new Uint8Array(mod.sign(null, message, mod.createPrivateKey({ key: pkcs8 as unknown as Buffer, format: "der", type: "pkcs8" })));
  } catch (e) {
    throw new UnsupportedCrypto(`no ed25519 signer in this runtime (${(e as Error).message})`);
  }
}

async function edPublicKey(seed: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = concatBytes(PKCS8_PREFIX, seed);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const key = await subtle.importKey("pkcs8", asBuffer(pkcs8), { name: "Ed25519" }, true, ["sign"]);
      const jwk = await subtle.exportKey("jwk", key);
      if (jwk.x) return base64ToBytes(jwk.x);
    } catch {
      /* fall through */
    }
  }
  try {
    const mod = await nodeCrypto();
    const jwk = mod.createPublicKey(mod.createPrivateKey({ key: pkcs8 as unknown as Buffer, format: "der", type: "pkcs8" })).export({ format: "jwk" });
    return base64ToBytes(String(jwk.x));
  } catch (e) {
    throw new UnsupportedCrypto(`no ed25519 in this runtime (${(e as Error).message})`);
  }
}

/** A signer with its secret key beside it, so it can be stored and restored with {@link keypairSigner}. */
export type KeypairSigner = Signer & { publicKey: Uint8Array; secretKey: Uint8Array };

/** A signer from a 64-byte secret key (seed || public key, the Solana Keypair layout) or a Keypair object. */
export function keypairSigner(secret: Uint8Array | { secretKey: Uint8Array }): KeypairSigner {
  const secretKey = secret instanceof Uint8Array ? secret : secret.secretKey;
  if (secretKey.length !== 64) throw new TrellisError("a Solana secret key is 64 bytes (seed || public key); use signerFromSeed for a 32-byte seed", "bad_options");
  const seed = new Uint8Array(secretKey.subarray(0, 32));
  return { publicKey: new Uint8Array(secretKey.subarray(32)), secretKey: new Uint8Array(secretKey), sign: (m) => edSign(seed, m) };
}

/** A signer from a 32-byte seed (the public key is derived). */
export async function signerFromSeed(seed: Uint8Array): Promise<KeypairSigner> {
  if (seed.length !== 32) throw new TrellisError("an ed25519 seed is 32 bytes", "bad_options");
  return keypairSigner(concatBytes(seed, await edPublicKey(seed)));
}

/** A fresh ed25519 keypair for signing tab vouchers. Keep `secretKey` to restore it with {@link keypairSigner}. */
export const generateSessionKey = (): Promise<KeypairSigner> => signerFromSeed(randomBytes(32));

// ---- Legacy transaction messages --------------------------------------------------------------------------------------

export type AccountMeta = { pubkey: string; isSigner: boolean; isWritable: boolean };
export type Instruction = { programId: string; keys: AccountMeta[]; data: Uint8Array };
export type CompiledMessage = { bytes: Uint8Array; accountKeys: string[]; numRequiredSignatures: number };

function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    const b = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return new Uint8Array(out);
}
function readCompactU16(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++];
    if (b === undefined) throw new TrellisError("truncated transaction", "bad_options");
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
}

/**
 * A legacy message with the fee payer first and the other accounts grouped as @solana/web3.js compiles them (writable
 * signers, read-only signers, writable non-signers, read-only non-signers, each in order of first appearance).
 */
export function compileLegacyMessage(o: { feePayer: PublicKeyLike; recentBlockhash: string; instructions: Instruction[] }): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    m.signer ||= signer;
    m.writable ||= writable;
    metas.set(k, m);
  };
  touch(address(o.feePayer), true, true);
  for (const ix of o.instructions) {
    touch(address(ix.programId), false, false);
    for (const k of ix.keys) touch(address(k.pubkey), k.isSigner, k.isWritable);
  }
  const entries = [...metas.entries()];
  const group = (signer: boolean, writable: boolean) => entries.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const ws = group(true, true);
  const rs = group(true, false);
  const wn = group(false, true);
  const rn = group(false, false);
  const keys = [...ws, ...rs, ...wn, ...rn];
  const index = new Map(keys.map((k, i) => [k, i]));
  const blockhash = base58Decode(o.recentBlockhash);
  if (blockhash.length !== 32) throw new TrellisError("recentBlockhash must be a base58 32-byte hash", "bad_options");
  const ixs = o.instructions.map((ix) =>
    concatBytes(new Uint8Array([index.get(address(ix.programId))!]), compactU16(ix.keys.length), new Uint8Array(ix.keys.map((k) => index.get(address(k.pubkey))!)), compactU16(ix.data.length), ix.data),
  );
  const bytes = concatBytes(new Uint8Array([ws.length + rs.length, rs.length, rn.length]), compactU16(keys.length), ...keys.map((k) => base58Decode(k)), blockhash, compactU16(ixs.length), ...ixs);
  return { bytes, accountKeys: keys, numRequiredSignatures: ws.length + rs.length };
}

/** compact-u16 signature count, the 64-byte signatures (zeros where missing), then the message. */
export function serializeTransaction(message: Uint8Array, signatures: (Uint8Array | null)[]): Uint8Array {
  for (const s of signatures) if (s && s.length !== 64) throw new TrellisError("a signature is 64 bytes", "bad_options");
  return concatBytes(compactU16(signatures.length), ...signatures.map((s) => s ?? new Uint8Array(64)), message);
}

export type ParsedTransaction = {
  signatures: Uint8Array[];
  message: Uint8Array;
  version: "legacy" | number;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  accountKeys: string[];
  recentBlockhash: string;
};

/** The signatures and the message of a serialized transaction (legacy or versioned), with the static account keys. */
export function parseTransaction(transaction: Uint8Array | string): ParsedTransaction {
  const raw = typeof transaction === "string" ? base64ToBytes(transaction) : transaction;
  const sigs = readCompactU16(raw, 0);
  const signatures: Uint8Array[] = [];
  let at = sigs.next;
  for (let i = 0; i < sigs.value; i++, at += 64) signatures.push(new Uint8Array(raw.subarray(at, at + 64)));
  const message = new Uint8Array(raw.subarray(at));
  let m = 0;
  const version: "legacy" | number = message[0] & 0x80 ? message[m++] & 0x7f : "legacy";
  const header = { numRequiredSignatures: message[m], numReadonlySigned: message[m + 1], numReadonlyUnsigned: message[m + 2] };
  const n = readCompactU16(message, m + 3);
  const accountKeys: string[] = [];
  let k = n.next;
  for (let i = 0; i < n.value; i++, k += 32) accountKeys.push(base58Encode(message.subarray(k, k + 32)));
  if (message.length < k + 32) throw new TrellisError("truncated transaction", "bad_options");
  return { signatures, message, version, header, accountKeys, recentBlockhash: base58Encode(message.subarray(k, k + 32)) };
}

/**
 * Sign a serialized transaction (base64, as the router returns it for deposits and closures, or as {@link
 * openTabTransaction} builds it) with one or more signers, keeping every other signature. Returns base64.
 */
export async function signTransaction(transaction: string | Uint8Array, signers: Signer | Signer[]): Promise<string> {
  const t = parseTransaction(transaction);
  const sigs: (Uint8Array | null)[] = t.signatures.map((s) => (s.every((b) => b === 0) ? null : s));
  while (sigs.length < t.header.numRequiredSignatures) sigs.push(null);
  for (const s of [signers].flat()) {
    const who = address(s.publicKey);
    const i = t.accountKeys.indexOf(who);
    if (i < 0 || i >= t.header.numRequiredSignatures) throw new TrellisError(`${who} is not a required signer of this transaction`, "bad_options");
    sigs[i] = await s.sign(t.message);
  }
  return bytesToBase64(serializeTransaction(t.message, sigs));
}

// ---- RPC ------------------------------------------------------------------------------------------------------------

/** What is needed from a @solana/web3.js Connection (or anything else that answers getLatestBlockhash). */
export type ConnectionLike = { getLatestBlockhash(commitment?: string): Promise<{ blockhash: string }> };
export type Commitment = "processed" | "confirmed" | "finalized";
export type RpcOptions = { rpcUrl?: string; connection?: ConnectionLike; fetch?: Fetch; commitment?: Commitment };

/** A fresh blockhash from a Connection or over plain JSON-RPC at `rpcUrl`. */
export async function latestBlockhash(o: RpcOptions): Promise<string> {
  if (o.connection) return (await o.connection.getLatestBlockhash(o.commitment ?? "confirmed")).blockhash;
  if (!o.rpcUrl) throw new TrellisError("pass rpcUrl, connection or recentBlockhash", "bad_options");
  const f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  const res = await f(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: o.commitment ?? "confirmed" }] }) });
  const j = (await res.json().catch(() => null)) as { result?: { value?: { blockhash?: string } }; error?: { message?: string } } | null;
  const blockhash = j?.result?.value?.blockhash;
  if (typeof blockhash !== "string") throw new TrellisError(`getLatestBlockhash failed: ${j?.error?.message ?? `HTTP ${res.status}`}`, "rpc_failed", res.status);
  return blockhash;
}

async function jsonRpc<T>(o: RpcOptions, method: string, params: unknown[]): Promise<T> {
  if (!o.rpcUrl) throw new TrellisError("pass rpcUrl or connection", "bad_options");
  const f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  const res = await f(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!j || j.error || !("result" in j)) throw new TrellisError(`${method} failed: ${j?.error?.message ?? `HTTP ${res.status}`}`, "rpc_failed", res.status);
  return j.result as T;
}

/** An account's data (raw bytes) from a Connection's getAccountInfo or over plain JSON-RPC; null when it does not exist. */
export async function accountData(account: PublicKeyLike, o: RpcOptions): Promise<Uint8Array | null> {
  const connection = o.connection as (ConnectionLike & { getAccountInfo?: (key: unknown, commitment?: string) => Promise<{ data: Uint8Array | [string, string] } | null> }) | undefined;
  if (connection?.getAccountInfo) {
    // A web3.js Connection wants a PublicKey: pass the caller's object through when it is one, else the address.
    const key = typeof account === "object" && !(account instanceof Uint8Array) ? account : address(account);
    const info = await connection.getAccountInfo(key, o.commitment ?? "confirmed");
    if (!info) return null;
    return Array.isArray(info.data) ? base64ToBytes(info.data[0]) : new Uint8Array(info.data);
  }
  const r = await jsonRpc<{ value: { data: [string, string] } | null }>(o, "getAccountInfo", [address(account), { encoding: "base64", commitment: o.commitment ?? "confirmed" }]);
  return r?.value ? base64ToBytes(r.value.data[0]) : null;
}
const accountExists = async (account: PublicKeyLike, o: RpcOptions) => (await accountData(account, o)) !== null;

/** Send a signed transaction (base64) over JSON-RPC at `rpcUrl`; returns its signature (base58). */
export const sendTransaction = (transaction: string, o: RpcOptions): Promise<string> =>
  jsonRpc<string>(o, "sendTransaction", [transaction, { encoding: "base64", preflightCommitment: o.commitment ?? "confirmed" }]);

// ---- x402 `exact` per-call payments ------------------------------------------------------------------------------------

/** One way to pay, as a 402 lists it in `accepts` (x402 v1 shape; a v2 `PAYMENT-REQUIRED` header is mapped onto it). */
export type X402Requirement = {
  scheme: string;
  network: string;
  /** USDC base units, as a decimal string. */
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  /** `feePayer` co-signs and pays the SOL fee; null means the router cannot sponsor the transaction. */
  extra?: { feePayer?: string | null; decimals?: number; [k: string]: unknown };
};

export type PaymentRequired = {
  x402Version: number;
  error: string;
  accepts: X402Requirement[];
  /** The price in USDC (decimal string) and the model, as the router's 402 body adds them. */
  priceUsdc?: string;
  model?: string;
  /** Why an earlier payment was rejected (the router's reason), when this 402 follows one. */
  paymentError?: string;
};

type HeadersLike = { get(name: string): string | null };
type ResponseLike = { status?: number; headers: HeadersLike; bodyUsed?: boolean; clone?: () => { json(): Promise<unknown> }; json?: () => Promise<unknown> };

const decodeBase64Json = (v: string | null | undefined): unknown => {
  if (!v) return null;
  try {
    return JSON.parse(fromUtf8(base64ToBytes(v)));
  } catch {
    return null;
  }
};

/**
 * Read a 402: the x402 v1 JSON body (`accepts`, `price_usdc`, `model`, `payment_error`) and, failing that, the v2
 * `PAYMENT-REQUIRED` header. Pass `body` when the response body was already read. Null when it is not an x402 402.
 */
export async function parsePaymentRequired(res: ResponseLike, body?: unknown): Promise<PaymentRequired | null> {
  let b = body as { x402Version?: unknown; error?: unknown; accepts?: unknown; price_usdc?: unknown; model?: unknown; payment_error?: unknown } | null | undefined;
  if (b === undefined && !res.bodyUsed) {
    try {
      b = (await (res.clone ? res.clone() : (res as { json(): Promise<unknown> })).json()) as typeof b;
    } catch {
      b = null;
    }
  }
  const v2 = decodeBase64Json(res.headers?.get("payment-required")) as { x402Version?: unknown; error?: unknown; resource?: { url?: string; description?: string; mimeType?: string }; accepts?: Array<Record<string, unknown>> } | null;
  const fromV1 = Array.isArray(b?.accepts) && b.accepts.length ? (b.accepts as X402Requirement[]) : null;
  const fromV2 = Array.isArray(v2?.accepts)
    ? v2.accepts.map(
        (a): X402Requirement => ({
          scheme: String(a.scheme),
          network: String(a.network),
          maxAmountRequired: String(a.amount ?? a.maxAmountRequired),
          resource: v2.resource?.url,
          description: v2.resource?.description,
          mimeType: v2.resource?.mimeType,
          payTo: String(a.payTo),
          maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : undefined,
          asset: String(a.asset),
          extra: (a.extra ?? undefined) as X402Requirement["extra"],
        }),
      )
    : null;
  const accepts = fromV1 ?? fromV2;
  if (!accepts?.length) return null;
  return {
    x402Version: Number(b?.x402Version ?? v2?.x402Version ?? 1),
    error: String(b?.error ?? v2?.error ?? ""),
    accepts,
    priceUsdc: typeof b?.price_usdc === "string" ? b.price_usdc : undefined,
    model: typeof b?.model === "string" ? b.model : undefined,
    paymentError: typeof b?.payment_error === "string" ? b.payment_error : undefined,
  };
}

/** The settlement a paid answer carries in `X-PAYMENT-RESPONSE` (v1) / `PAYMENT-RESPONSE` (v2). */
export type PaymentResponse = { success: boolean; transaction: string; network: string; payer: string; errorReason?: string };

export function parsePaymentResponse(headers: HeadersLike): PaymentResponse | null {
  const j = decodeBase64Json(headers.get("x-payment-response") ?? headers.get("payment-response")) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return null;
  return { success: j.success === true, transaction: String(j.transaction ?? ""), network: String(j.network ?? ""), payer: String(j.payer ?? ""), ...(typeof j.errorReason === "string" ? { errorReason: j.errorReason } : {}) };
}

/** The `X-PAYMENT` header value: base64 JSON `{x402Version: 1, scheme: "exact", network, payload: {transaction}}`. */
export const x402PaymentHeader = (p: { network: string; transaction: string }): string =>
  bytesToBase64(utf8(JSON.stringify({ x402Version: 1, scheme: "exact", network: p.network, payload: { transaction: p.transaction } })));

/**
 * What the router's fee payer agrees to sign (src/solana/x402.ts, DEFAULT_EXACT_LIMITS): a compute unit limit and price
 * within these caps, their product within the priority-fee cap, and payTo's token account created (if at all) with the
 * PAYER's lamports. A payment outside them is refused before the router co-signs, so none is built here.
 */
export type ExactLimits = { maxComputeUnitLimit: number; maxComputeUnitPriceMicroLamports: bigint; maxPriorityFeeLamports: bigint };
export const EXACT_LIMITS: ExactLimits = { maxComputeUnitLimit: 200_000, maxComputeUnitPriceMicroLamports: 5_000_000n, maxPriorityFeeLamports: 10_000n };
/** The runtime's budget when no limit is set: 200,000 units per instruction, at most 1.4M. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
const MAX_TRANSACTION_UNITS = 1_400_000;

/** The priority fee the fee payer is charged: ceil(compute unit limit x micro-lamports per unit / 1e6) lamports. */
export const priorityFeeLamports = (unitLimit: number, microLamportsPerUnit: bigint | number): bigint => (BigInt(unitLimit) * BigInt(microLamportsPerUnit) + 999_999n) / 1_000_000n;

/** The SetComputeUnitLimit / SetComputeUnitPrice instructions of a payment, refused when they are outside `limits`. */
export function computeBudgetInstructions(o: { computeUnitLimit?: number; computeUnitPrice?: bigint | number; instructionCount?: number }, limits: ExactLimits = EXACT_LIMITS): Instruction[] {
  const out: Instruction[] = [];
  const limit = o.computeUnitLimit;
  const price = o.computeUnitPrice === undefined ? undefined : BigInt(o.computeUnitPrice);
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > limits.maxComputeUnitLimit) throw new TrellisError(`computeUnitLimit must be between 1 and ${limits.maxComputeUnitLimit}: the router's fee payer signs no more`, "payment_out_of_bounds");
    const data = new Uint8Array(5);
    data[0] = 2;
    new DataView(data.buffer).setUint32(1, limit, true);
    out.push({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data });
  }
  if (price !== undefined) {
    if (price < 0n || price > limits.maxComputeUnitPriceMicroLamports) throw new TrellisError(`computeUnitPrice must be at most ${limits.maxComputeUnitPriceMicroLamports} micro-lamports per unit`, "payment_out_of_bounds");
    // Without an explicit limit the runtime budgets per instruction, and the fee is charged on that.
    const effective = limit ?? Math.min(MAX_TRANSACTION_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * (o.instructionCount ?? 1));
    const fee = priorityFeeLamports(effective, price);
    if (fee > limits.maxPriorityFeeLamports) throw new TrellisError(`a priority fee of ${fee} lamports (${effective} units at ${price} micro-lamports) is above the ${limits.maxPriorityFeeLamports} lamports the router's fee payer signs; lower computeUnitPrice or set a smaller computeUnitLimit`, "payment_out_of_bounds");
    out.push({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concatBytes(new Uint8Array([3]), le64(price)) });
  }
  return out;
}

/**
 * The SPL TransferChecked (and, optionally, the idempotent creation of the destination ATA) of an `exact` payment. The
 * token account, when created here, is funded by the payer: the router refuses one funded by its fee payer.
 */
export function exactPaymentInstructions(o: { payer: PublicKeyLike; payTo: PublicKeyLike; mint?: PublicKeyLike; amount: bigint | number; decimals?: number; createDestinationAta?: boolean; tokenProgram?: PublicKeyLike; computeUnitLimit?: number; computeUnitPrice?: bigint | number }): { instructions: Instruction[]; source: string; destination: string } {
  const payer = address(o.payer);
  const payTo = address(o.payTo);
  const mint = address(o.mint ?? USDC_MINT);
  const tokenProgram = address(o.tokenProgram ?? TOKEN_PROGRAM);
  const source = associatedTokenAddress(payer, mint, tokenProgram);
  const destination = associatedTokenAddress(payTo, mint, tokenProgram);
  const instructions: Instruction[] = computeBudgetInstructions({ computeUnitLimit: o.computeUnitLimit, computeUnitPrice: o.computeUnitPrice, instructionCount: o.createDestinationAta ? 2 : 1 });
  if (o.createDestinationAta)
    instructions.push({
      programId: ASSOCIATED_TOKEN_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: payTo, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]),
    });
  instructions.push({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: concatBytes(new Uint8Array([12]), le64(o.amount), new Uint8Array([o.decimals ?? USDC_DECIMALS])),
  });
  return { instructions, source, destination };
}

export type ExactPayment = {
  /** The partially signed transaction, base64: what goes into `payload.transaction`. */
  transaction: string;
  message: Uint8Array;
  signature: Uint8Array;
  amount: bigint;
  payer: string;
  feePayer: string;
  source: string;
  destination: string;
  network: string;
  recentBlockhash: string;
};

export type BuildExactOptions = RpcOptions & {
  requirement: X402Requirement;
  signer: Signer;
  /** Skip the RPC: use this blockhash. */
  recentBlockhash?: string;
  /**
   * Add create_associated_token_account_idempotent for payTo's USDC account, funded by the payer (never by the fee
   * payer: the router refuses that). `"auto"` asks the RPC whether the account exists and adds it only when it does not.
   */
  createDestinationAta?: boolean | "auto";
  /** Pay more than `maxAmountRequired` (the rest stays as change on the payer's wallet account). */
  amount?: bigint;
  tokenProgram?: PublicKeyLike;
  /** SetComputeUnitLimit, at most {@link EXACT_LIMITS}.maxComputeUnitLimit. Left out by default. */
  computeUnitLimit?: number;
  /** SetComputeUnitPrice in micro-lamports per unit. The fee payer pays it, so it is capped (see {@link EXACT_LIMITS}). Left out by default. */
  computeUnitPrice?: bigint | number;
};

/**
 * Build and sign the `exact` payment for a requirement: one USDC TransferChecked from the payer's associated token
 * account to payTo's, with the router's fee payer (`extra.feePayer`) as account 0 and its signature slot left empty.
 */
export async function buildExactPayment(o: BuildExactOptions): Promise<ExactPayment> {
  const req = o.requirement;
  if (req.scheme !== "exact") throw new TrellisError(`unsupported x402 scheme ${req.scheme}`, "payment_unsupported");
  if (!req.network.startsWith("solana:")) throw new TrellisError(`unsupported x402 network ${req.network}`, "payment_unsupported");
  const feePayer = req.extra?.feePayer;
  if (!feePayer) throw new TrellisError("the 402 names no fee payer (extra.feePayer): this router cannot sponsor per-call payments", "payment_unavailable");
  const required = BigInt(req.maxAmountRequired);
  const amount = o.amount ?? required;
  if (amount < required) throw new TrellisError(`amount ${amount} is below the ${required} units required`, "bad_options");
  const payer = address(o.signer.publicKey);
  if (payer === address(feePayer)) throw new TrellisError("the payer cannot be the fee payer", "bad_options");
  // payTo's token account must exist when the transfer runs. "auto" creates it (with the payer's lamports) only if the
  // cluster does not have it yet.
  const createDestinationAta = o.createDestinationAta === "auto" ? !(await accountExists(associatedTokenAddress(req.payTo, req.asset, o.tokenProgram ?? TOKEN_PROGRAM), o)) : !!o.createDestinationAta;
  const { instructions, source, destination } = exactPaymentInstructions({ payer, payTo: req.payTo, mint: req.asset, amount, decimals: req.extra?.decimals ?? USDC_DECIMALS, createDestinationAta, tokenProgram: o.tokenProgram, computeUnitLimit: o.computeUnitLimit, computeUnitPrice: o.computeUnitPrice });
  const recentBlockhash = o.recentBlockhash ?? (await latestBlockhash(o));
  const msg = compileLegacyMessage({ feePayer, recentBlockhash, instructions });
  // Exactly the fee payer and the payer sign, and the fee payer is in no instruction: anything else the router refuses.
  if (msg.numRequiredSignatures !== 2 || msg.accountKeys[0] !== address(feePayer)) throw new TrellisError("an exact payment has exactly two signers: the router's fee payer and the payer", "payment_out_of_bounds");
  const signatures: (Uint8Array | null)[] = new Array<Uint8Array | null>(msg.numRequiredSignatures).fill(null);
  const at = msg.accountKeys.indexOf(payer);
  const signature = await o.signer.sign(msg.bytes);
  if (signature.length !== 64) throw new TrellisError("the signer returned something other than a 64-byte signature", "bad_options");
  signatures[at] = signature;
  return { transaction: bytesToBase64(serializeTransaction(msg.bytes, signatures)), message: msg.bytes, signature, amount, payer, feePayer: address(feePayer), source, destination, network: req.network, recentBlockhash };
}

export type PerCallOptions = RpcOptions & {
  createDestinationAta?: boolean | "auto";
  computeUnitLimit?: number;
  computeUnitPrice?: bigint | number;
  /** Refuse (throw `payment_too_large`) when a 402 asks for more than this many USDC base units. */
  maxAmount?: bigint;
  /** Called with every payment built, before the retry. */
  onPayment?: (payment: ExactPayment, requirement: X402Requirement) => void;
};
/** A per-call payer: the wallet and how to reach an RPC for the recent blockhash. */
export type PerCallPayer = PerCallOptions & { signer: Signer };

const headersRecord = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
};

/**
 * A fetch that pays per call: a 402 with an x402 `exact` requirement on a Solana network is answered once with the
 * same request plus `X-PAYMENT`. Anything else (another 402, an error) is returned as is. Bodies must be re-sendable
 * (strings or bytes, not streams).
 */
export function payPerCall(f: Fetch, signer: Signer, o: PerCallOptions = {}): Fetch {
  return async (input, init) => {
    const res = await f(input, init);
    if (res.status !== 402) return res;
    const sent = headersRecord(init?.headers);
    if (sent["x-payment"] || sent["payment-signature"]) return res;
    const required = await parsePaymentRequired(res).catch(() => null);
    const requirement = required?.accepts.find((a) => a.scheme === "exact" && a.network.startsWith("solana:"));
    if (!requirement) return res;
    if (o.maxAmount !== undefined && BigInt(requirement.maxAmountRequired) > o.maxAmount)
      throw new TrellisError(`this call costs ${requirement.maxAmountRequired} USDC units, above the ${o.maxAmount} ceiling`, "payment_too_large", 402, required);
    const payment = await buildExactPayment({ ...o, requirement, signer });
    o.onPayment?.(payment, requirement);
    await res.body?.cancel().catch(() => {});
    // An X-Wallet-Auth the first attempt carried is spent (it is single use, and the router has seen it): resending it
    // would be refused as a replay. The signed payment needs no wallet signature beside it.
    const { "x-wallet-auth": _spent, ...headers } = sent;
    return f(input, { ...init, headers: { ...headers, "x-payment": x402PaymentHeader(payment) } });
  };
}

// ---- Tabs (trellis_tab) ----------------------------------------------------------------------------------------------

export type TabPdas = { config: string; tab: string; escrow: string; bumps: { config: number; tab: number; escrow: number } };

/** The tab program's `enforcer` PDA: the signer of its calls into trellis_rules when a rulebook-bound tab commits USDC. */
export const tabEnforcerAddress = (programId: PublicKeyLike): string => findProgramAddress([utf8("enforcer")], programId).address;
/** The trellis_rules config PDA. */
export const rulesConfigAddress = (rulesProgramId: PublicKeyLike): string => findProgramAddress([utf8("config")], rulesProgramId).address;

/**
 * The rulebook a tab is bound to: the payer's own Rulebook account and the trellis_rules program that owns it (the one
 * the tab program's config names). `open_tab` and `top_up` count the escrowed USDC against its daily limit; `close` and
 * `reclaim` never involve it.
 */
export type TabRulebook = { rulebook: PublicKeyLike; rulesProgram: PublicKeyLike };

/** The trailing accounts of open_tab / top_up: rules config, rules program and the enforcer (the program id where absent). */
function rulebookTail(programId: string, rules: TabRulebook | null | undefined): AccountMeta[] {
  const ro = (pubkey: string): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  return [ro(rules ? rulesConfigAddress(rules.rulesProgram) : programId), ro(rules ? address(rules.rulesProgram) : programId), ro(tabEnforcerAddress(programId))];
}

/** The config, tab and escrow addresses under `programId` for a payer/payee/tab_id triple. */
export function tabPdas(programId: PublicKeyLike, payer: PublicKeyLike, payee: PublicKeyLike, tabId: bigint | number): TabPdas {
  const config = findProgramAddress([utf8("config")], programId);
  const tab = findProgramAddress([utf8("tab"), publicKeyBytes(payer), publicKeyBytes(payee), le64(tabId)], programId);
  const escrow = findProgramAddress([utf8("escrow"), tab.bytes], programId);
  return { config: config.address, tab: tab.address, escrow: escrow.address, bumps: { config: config.bump, tab: tab.bump, escrow: escrow.bump } };
}

/** The tab address (PDA) for a payer/payee/tab_id triple. */
export const tabAddress = (programId: PublicKeyLike, payer: PublicKeyLike, payee: PublicKeyLike, tabId: bigint | number): string => tabPdas(programId, payer, payee, tabId).tab;

/** A random u64 tab id. */
export const randomTabId = (): bigint => readU64(randomBytes(8), 0);

export type OpenTabOptions = {
  programId: PublicKeyLike;
  payer: PublicKeyLike;
  payee: PublicKeyLike;
  /** USDC base units moved into escrow; the most the tab can ever pay. */
  cap: bigint | number;
  /** Unix seconds; at most 30 days from now ({@link MAX_TAB_LIFETIME_SECONDS}): the program refuses a later one. */
  expiry: bigint | number;
  /** The session key's public key: it signs the vouchers. */
  sessionKey: PublicKeyLike;
  tabId?: bigint | number;
  /** Bind the tab to the payer's own rulebook. Needs the rules program id beside the rulebook's address. */
  rulebook?: TabRulebook | null;
  mint?: PublicKeyLike;
  /** The current unix time, for the expiry check (default: this machine's clock). */
  now?: number;
};

/**
 * open_tab: discriminator ++ Borsh OpenTabArgs; accounts in the program's order. The rulebook group (rulebook, rules
 * config, rules program) carries the tab program id as a placeholder when the tab has no rulebook.
 */
export function openTabInstruction(o: OpenTabOptions): { instruction: Instruction; tab: string; tabId: bigint; pdas: TabPdas } {
  const cap = BigInt(o.cap);
  if (cap <= 0n) throw new TrellisError("tab cap must be above 0", "bad_options");
  const now = BigInt(Math.floor(o.now ?? Date.now() / 1000));
  if (BigInt(o.expiry) <= now) throw new TrellisError("tab expiry is in the past", "bad_options");
  if (BigInt(o.expiry) > now + BigInt(MAX_TAB_LIFETIME_SECONDS)) throw new TrellisError("tab expiry is more than 30 days out: the program refuses it (ExpiryTooFar)", "bad_options");
  if (o.rulebook && !o.rulebook.rulesProgram) throw new TrellisError("a rulebook-bound tab needs the rules program id", "bad_options");
  const programId = address(o.programId);
  const payer = address(o.payer);
  const payee = address(o.payee);
  const mint = address(o.mint ?? USDC_MINT);
  const tabId = o.tabId === undefined ? randomTabId() : BigInt(o.tabId);
  const pdas = tabPdas(programId, payer, payee, tabId);
  const instruction: Instruction = {
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payee, isSigner: false, isWritable: false },
      { pubkey: pdas.config, isSigner: false, isWritable: false },
      { pubkey: pdas.tab, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: pdas.escrow, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(payer, mint), isSigner: false, isWritable: true },
      { pubkey: o.rulebook ? address(o.rulebook.rulebook) : programId, isSigner: false, isWritable: !!o.rulebook },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ...rulebookTail(programId, o.rulebook),
    ],
    data: concatBytes(OPEN_TAB_DISCRIMINATOR, le64(tabId), le64(cap), le64i(o.expiry), publicKeyBytes(o.sessionKey)),
  };
  return { instruction, tab: pdas.tab, tabId, pdas };
}

export type OpenTabTransaction = { transaction: string; message: Uint8Array; tab: string; tabId: bigint; pdas: TabPdas; instruction: Instruction };

/**
 * The open_tab transaction for the payer's wallet to sign and send (the payer is the fee payer): base64 with an empty
 * signature slot. Sign it with {@link signTransaction} or a wallet adapter.
 */
export function openTabTransaction(o: OpenTabOptions & { recentBlockhash: string }): OpenTabTransaction {
  const built = openTabInstruction(o);
  const msg = compileLegacyMessage({ feePayer: o.payer, recentBlockhash: o.recentBlockhash, instructions: [built.instruction] });
  return { transaction: bytesToBase64(serializeTransaction(msg.bytes, new Array<null>(msg.numRequiredSignatures).fill(null))), message: msg.bytes, ...built };
}

/**
 * top_up(amount) by the payer: adds to the escrow and the cap. A rulebook-bound tab passes its `rulebook`: the top-up is
 * a new commitment under it (the program refuses the top-up otherwise).
 */
export function topUpInstruction(o: { programId: PublicKeyLike; payer: PublicKeyLike; tab: PublicKeyLike; amount: bigint | number; mint?: PublicKeyLike; rulebook?: TabRulebook | null }): Instruction {
  const amount = BigInt(o.amount);
  if (amount <= 0n) throw new TrellisError("top-up must be above 0", "bad_options");
  const programId = address(o.programId);
  const payer = address(o.payer);
  const tab = address(o.tab);
  const mint = address(o.mint ?? USDC_MINT);
  return {
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: findProgramAddress([utf8("config")], programId).address, isSigner: false, isWritable: false },
      { pubkey: tab, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: findProgramAddress([utf8("escrow"), publicKeyBytes(tab)], programId).address, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(payer, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: o.rulebook ? address(o.rulebook.rulebook) : programId, isSigner: false, isWritable: !!o.rulebook },
      ...rulebookTail(programId, o.rulebook),
    ],
    data: concatBytes(TOP_UP_DISCRIMINATOR, le64(amount)),
  };
}

/**
 * reclaim(): delivers a tab's escrow after expiry plus the reclaim grace (or at any time once the payee has closed): the
 * payee's posted voucher to the payee, the rest to the payer. Nobody's signature is needed besides the fee payer's of the
 * transaction it is sent in, and no rulebook account is involved. `payer` and `payee` are the tab's own.
 */
export function reclaimInstruction(o: { programId: PublicKeyLike; payer: PublicKeyLike; payee: PublicKeyLike; tab: PublicKeyLike; mint?: PublicKeyLike }): Instruction {
  const programId = address(o.programId);
  const payer = address(o.payer);
  const tab = address(o.tab);
  const mint = address(o.mint ?? USDC_MINT);
  return {
    programId,
    keys: [
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: tab, isSigner: false, isWritable: true },
      { pubkey: findProgramAddress([utf8("config")], programId).address, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: findProgramAddress([utf8("escrow"), publicKeyBytes(tab)], programId).address, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(payer, mint), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(o.payee, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: RECLAIM_DISCRIMINATOR,
  };
}

/** The Tab account as the program stores it. */
export type TabAccount = { payer: string; payee: string; sessionKey: string; mint: string; tabId: bigint; cap: bigint; postedUsed: bigint; postedSeq: bigint; expiry: bigint; createdAt: bigint; rulebook: string | null; bump: number; escrowBump: number };

/** Decode a Tab account's data (raw bytes or base64 from getAccountInfo). Null when it is not a Tab. */
export function decodeTabAccount(data: Uint8Array | string): TabAccount | null {
  const b = typeof data === "string" ? base64ToBytes(data) : data;
  if (b.length < 8 + 32 * 4 + 8 * 6 + 1 + 2 || !TAB_ACCOUNT_DISCRIMINATOR.every((x, i) => b[i] === x)) return null;
  const key = (at: number) => base58Encode(b.subarray(at, at + 32));
  const hasRulebook = b[184] === 1;
  const tail = hasRulebook ? 185 + 32 : 185;
  if (b.length < tail + 2) return null;
  return {
    payer: key(8),
    payee: key(40),
    sessionKey: key(72),
    mint: key(104),
    tabId: readU64(b, 136),
    cap: readU64(b, 144),
    postedUsed: readU64(b, 152),
    postedSeq: readU64(b, 160),
    expiry: readI64(b, 168),
    createdAt: readI64(b, 176),
    rulebook: hasRulebook ? key(185) : null,
    bump: b[tail],
    escrowBump: b[tail + 1],
  };
}

// ---- Vouchers --------------------------------------------------------------------------------------------------------

export type Voucher = { tab: string; cumulativeUsed: bigint; seq: bigint };
/**
 * What a voucher is bound to besides its tab (the router's security review, TR-19): the tab program it is for, and the
 * opening of the tab. `programId` differs per cluster, so a devnet voucher is nothing on mainnet. `createdAt` is the
 * open tab's `Tab.created_at` (unix seconds, set by the program when `open_tab` lands): a tab address can be opened
 * again after it is closed, and a voucher for the earlier opening is worth nothing against the new escrow. Read it
 * from the chain with {@link fetchTabAccount}.
 */
export type VoucherScope = { programId: PublicKeyLike; createdAt: bigint | number };
/** The facilitator's JSON form of a voucher. */
export type WireVoucher = { tab: string; cumulative_used: string; seq: string; signature: string; session_key?: string };
export type VoucherHeaders = { "X-Trellis-Tab": string; "X-Trellis-Tab-Voucher": string };
export type SignedVoucher = Voucher & { programId: string; createdAt: bigint; message: Uint8Array; signature: Uint8Array; sessionKey: string; headers: VoucherHeaders; wire: WireVoucher };

/**
 * The 110 bytes a session key signs:
 * "trellis:tab:voucher:v1" || program id (32) || tab (32) || created_at i64 LE || cumulative_used u64 LE || seq u64 LE.
 */
export const voucherMessage = (v: Voucher, scope: VoucherScope): Uint8Array =>
  concatBytes(utf8(VOUCHER_DOMAIN), publicKeyBytes(scope.programId), publicKeyBytes(v.tab), le64i(scope.createdAt), le64(v.cumulativeUsed), le64(v.seq));

export const voucherHeaders = (tab: PublicKeyLike, message: Uint8Array, signature: Uint8Array): VoucherHeaders => ({ "X-Trellis-Tab": address(tab), "X-Trellis-Tab-Voucher": `${bytesToBase64(message)}.${bytesToBase64(signature)}` });

/** Read voucher bytes back into their fields. Throws unless they are a v1 voucher message (110 bytes, the domain first). */
export function parseVoucherMessage(message: Uint8Array): Voucher & { programId: string; createdAt: bigint } {
  const d = VOUCHER_DOMAIN.length;
  if (message.length !== VOUCHER_MESSAGE_LENGTH || fromUtf8(message.subarray(0, d)) !== VOUCHER_DOMAIN)
    throw new TrellisError(`a voucher message is ${VOUCHER_MESSAGE_LENGTH} bytes starting with "${VOUCHER_DOMAIN}" (the 48-byte tab||cumulative_used||seq form is retired)`, "bad_options");
  return { programId: base58Encode(message.subarray(d, d + 32)), tab: base58Encode(message.subarray(d + 32, d + 64)), createdAt: readI64(message, d + 64), cumulativeUsed: readU64(message, d + 72), seq: readU64(message, d + 80) };
}

/** Decode an `X-Trellis-Tab-Voucher` value: `<base64 message>.<base64 signature>`. */
export function parseVoucherHeader(value: string): Voucher & { programId: string; createdAt: bigint; message: Uint8Array; signature: Uint8Array } {
  const [m, s, ...rest] = value.split(".");
  if (rest.length || !m || !s) throw new TrellisError("X-Trellis-Tab-Voucher must be <base64 message>.<base64 signature>", "bad_options");
  const message = base64ToBytes(m);
  const signature = base64ToBytes(s);
  if (signature.length !== 64) throw new TrellisError("X-Trellis-Tab-Voucher carries a 110-byte message and a 64-byte signature", "bad_options");
  return { ...parseVoucherMessage(message), message, signature };
}

/** Sign a voucher with the session key, for the tab program and the opening of the tab in `scope`. */
export async function signVoucher(sessionKey: Signer, v: Voucher, scope: VoucherScope): Promise<SignedVoucher> {
  const message = voucherMessage(v, scope);
  const signature = await sessionKey.sign(message);
  if (signature.length !== 64) throw new TrellisError("the session key returned something other than a 64-byte signature", "bad_options");
  const key = address(sessionKey.publicKey);
  return { ...v, programId: address(scope.programId), createdAt: BigInt(scope.createdAt), message, signature, sessionKey: key, headers: voucherHeaders(v.tab, message, signature), wire: { tab: address(v.tab), cumulative_used: v.cumulativeUsed.toString(), seq: v.seq.toString(), signature: base58Encode(signature), session_key: key } };
}

/**
 * Whether a voucher (signed form, wire form, or header value) was signed by `sessionKey` (defaults to the voucher's
 * own `session_key` / `sessionKey` field) for the program and tab opening in `scope`. `scope` is what the VERIFIER
 * knows from the chain (the tab program it serves and the Tab account's created_at), never what the voucher claims: a
 * voucher whose message names another program or another opening does not verify. Never throws.
 */
export async function verifyVoucher(v: SignedVoucher | WireVoucher | string | (Voucher & { signature: Uint8Array | string }), scope: VoucherScope, sessionKey?: PublicKeyLike): Promise<boolean> {
  try {
    let voucher: Voucher;
    let signature: Uint8Array;
    let key: PublicKeyLike | undefined = sessionKey;
    if (typeof v === "string") {
      const parsed = parseVoucherHeader(v);
      voucher = parsed;
      signature = parsed.signature;
    } else if ("cumulative_used" in v) {
      voucher = { tab: v.tab, cumulativeUsed: BigInt(v.cumulative_used), seq: BigInt(v.seq) };
      signature = base58Decode(v.signature);
      key ??= v.session_key;
    } else {
      voucher = { tab: v.tab, cumulativeUsed: v.cumulativeUsed, seq: v.seq };
      signature = typeof v.signature === "string" ? base58Decode(v.signature) : v.signature;
      key ??= "sessionKey" in v ? v.sessionKey : undefined;
    }
    if (!key) return false;
    // Always the bytes for the verifier's own scope: a message carried by the voucher is not trusted.
    return await defaultEd25519Verify(publicKeyBytes(key), voucherMessage(voucher, scope), signature);
  } catch {
    return false;
  }
}

/**
 * The open Tab account at `tab`, read from the cluster (a Connection or JSON-RPC at `rpcUrl`) and decoded; null when
 * there is no tab there (never opened, or already closed). Its `createdAt` is what the vouchers sign.
 */
export async function fetchTabAccount(tab: PublicKeyLike, o: RpcOptions): Promise<TabAccount | null> {
  const data = await accountData(tab, o);
  return data ? decodeTabAccount(data) : null;
}

/**
 * The payer's side of an open tab: holds the session key and the voucher counters and produces the next voucher.
 * Every request should carry a voucher for the new cumulative total; `seq` increases by one each time. It needs the
 * tab program id and the tab's `createdAt` (from {@link fetchTabAccount} once `open_tab` has landed, or
 * {@link TabSession.open}).
 */
export class TabSession {
  readonly tab: string;
  readonly programId: string;
  readonly createdAt: bigint;
  readonly sessionKey: Signer;
  readonly cap: bigint | null;
  seq: bigint;
  cumulativeUsed: bigint;
  /** The last voucher produced, to resend with a retried request. */
  latest: SignedVoucher | null = null;

  constructor(o: { tab: PublicKeyLike; programId: PublicKeyLike; createdAt: bigint | number; sessionKey: Signer; seq?: bigint | number; cumulativeUsed?: bigint | number; cap?: bigint | number | null }) {
    if (o.programId === undefined || o.createdAt === undefined || o.createdAt === null) throw new TrellisError("a tab session needs the tab program id and the tab's created_at (fetchTabAccount): vouchers are signed for both", "bad_options");
    this.tab = address(o.tab);
    this.programId = address(o.programId);
    this.createdAt = BigInt(o.createdAt);
    this.sessionKey = o.sessionKey;
    this.seq = BigInt(o.seq ?? 0);
    this.cumulativeUsed = BigInt(o.cumulativeUsed ?? 0);
    this.cap = o.cap == null ? null : BigInt(o.cap);
  }

  /**
   * A session for the tab as it is open on the cluster now: reads the Tab account (created_at, cap, and the counters
   * the payee already posted) and checks that `sessionKey` is the tab's session key.
   */
  static async open(o: { tab: PublicKeyLike; programId: PublicKeyLike; sessionKey: Signer } & RpcOptions): Promise<TabSession> {
    const account = await fetchTabAccount(o.tab, o);
    if (!account) throw new TrellisError(`no open tab at ${address(o.tab)}`, "tab_not_found");
    if (account.sessionKey !== address(o.sessionKey.publicKey)) throw new TrellisError("this session key is not the tab's session key", "bad_options");
    return new TabSession({ tab: o.tab, programId: o.programId, createdAt: account.createdAt, sessionKey: o.sessionKey, cap: account.cap, seq: account.postedSeq, cumulativeUsed: account.postedUsed });
  }

  /** A voucher covering everything used so far (non-decreasing, within the cap), with the next seq. */
  async voucher(cumulativeUsed: bigint | number): Promise<SignedVoucher> {
    const total = BigInt(cumulativeUsed);
    if (total < this.cumulativeUsed) throw new TrellisError(`cumulative_used ${total} is below the ${this.cumulativeUsed} already vouched`, "bad_options");
    if (this.cap !== null && total > this.cap) throw new TrellisError(`cumulative_used ${total} exceeds the tab cap ${this.cap}`, "tab_cap_exceeded");
    const signed = await signVoucher(this.sessionKey, { tab: this.tab, cumulativeUsed: total, seq: this.seq + 1n }, { programId: this.programId, createdAt: this.createdAt });
    this.seq = signed.seq;
    this.cumulativeUsed = total;
    this.latest = signed;
    return signed;
  }

  /** `voucher(cumulativeUsed + more)`. */
  add(more: bigint | number): Promise<SignedVoucher> {
    return this.voucher(this.cumulativeUsed + BigInt(more));
  }

  /** The counters to persist (restore with `new TabSession({ ...state, sessionKey })`). */
  get state(): { tab: string; programId: string; createdAt: bigint; seq: bigint; cumulativeUsed: bigint; cap: bigint | null } {
    return { tab: this.tab, programId: this.programId, createdAt: this.createdAt, seq: this.seq, cumulativeUsed: this.cumulativeUsed, cap: this.cap };
  }
}

// ---- X-Wallet-Auth ---------------------------------------------------------------------------------------------------

/** Version line of the X-Wallet-Auth message. The v1 message ("trellis:<time>:<sha256>") is no longer accepted. */
export const WALLET_AUTH_VERSION = "trellis:wallet-auth:v2";

/** The request one X-Wallet-Auth signature is for. */
export type WalletAuthRequest = {
  /** HTTP method (signed in upper case). */
  method: string;
  /** The router's public host, with its port when it has one ("router.example", "127.0.0.1:8787"); signed in lower case. */
  host: string;
  /** The request target as sent: the path and, when there is one, the query string. */
  path: string;
  /** Unix seconds. */
  timestamp: number | string;
  /** SHA-256 (lower-case hex) of what the route binds: see {@link walletAuthHeader}. */
  sha256: string;
};

/**
 * The exact text a wallet signs for X-Wallet-Auth (UTF-8, no trailing newline):
 * "trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unixSeconds>\n<sha256 hex>".
 */
export function walletAuthMessage(r: WalletAuthRequest): string {
  const fields = [WALLET_AUTH_VERSION, r.method.toUpperCase(), r.host.toLowerCase(), r.path, String(r.timestamp), r.sha256];
  if (fields.some((f) => /[\r\n]/.test(f))) throw new TrellisError("wallet-auth fields must not contain line breaks", "bad_options");
  return fields.join("\n");
}

/** SHA-256 (hex) of the canonical JSON of a JSON body: what the router binds on its wallet-signed JSON routes. */
export const canonicalBodyHash = (body: unknown): string => sha256SyncHex(utf8(canonicalJson(body)));

/**
 * What the router binds on the chat routes (`/api/v1/chat/completions`, `/api/v1/completions`): SHA-256 of the canonical
 * JSON of the body without `stream` and `stream_options`, so the same signature covers a call streamed or not.
 */
export function chatRequestHash(body: Record<string, unknown>): string {
  const { stream: _stream, stream_options: _options, ...rest } = body;
  return canonicalBodyHash(rest);
}

/** What the router binds on `GET /api/v1/hosts/{id}` (an operator reading its own host): the hash names the resource. */
export const hostResourceHash = (id: string): string => sha256SyncHex(utf8(`GET /api/v1/hosts/${encodeURIComponent(id)}`));

/** The SHA-256 (hex) of the empty string: the hash of a request without a body. */
export const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type WalletAuthOptions = {
  method: string;
  /** The full request URL: its host and its path with the query string are what is signed. */
  url?: string;
  /** Instead of `url`: the path (with the query string) and the router's public host. */
  path?: string;
  host?: string;
  /**
   * What the route binds, as one of:
   *  - `sha256`: the hex digest itself;
   *  - `chat`: the chat request body (object): hashed as {@link chatRequestHash};
   *  - `json`: any other JSON body (object): the hash of its canonical JSON;
   *  - `body`: exact bytes or a string to hash as they are;
   *  - none of them: the empty body (GET).
   */
  sha256?: string;
  chat?: Record<string, unknown>;
  json?: unknown;
  body?: Uint8Array | string;
  /** Unix seconds (default: now). */
  now?: number;
};

/**
 * `X-Wallet-Auth: <base58 address>:<unixSeconds>:<base58 signature>` for one request: its method, the router's host,
 * its path with the query string, the time and the hash the route binds (see {@link WalletAuthOptions}). Valid for five
 * minutes and once: the router refuses the same request signed for the same second a second time. A signature for one
 * route, method or router is nothing on another.
 */
export async function walletAuthHeader(signer: Signer, o: WalletAuthOptions): Promise<string> {
  const u = o.url ? new URL(o.url) : null;
  const host = o.host ?? u?.host;
  const path = o.path ?? (u ? u.pathname + u.search : undefined);
  if (!host || !path) throw new TrellisError("walletAuthHeader needs the request url, or its path and the router's host", "bad_options");
  const digest = o.sha256 ?? (o.chat !== undefined ? chatRequestHash(o.chat) : o.json !== undefined ? canonicalBodyHash(o.json) : o.body !== undefined ? sha256SyncHex(typeof o.body === "string" ? utf8(o.body) : o.body) : EMPTY_BODY_HASH);
  const ts = String(Math.floor(o.now ?? Date.now() / 1000));
  const sig = await signer.sign(utf8(walletAuthMessage({ method: o.method, host, path, timestamp: ts, sha256: digest })));
  return `${address(signer.publicKey)}:${ts}:${base58Encode(sig)}`;
}

/**
 * The headers that present an already landed payment: `X-PAYMENT: <transaction signature>` with `X-Wallet-Auth` from
 * the wallet that paid, over this same request. The router accepts a bare transaction signature only with it (a landed
 * payment is public, so the signature alone does not show who is asking; without the wallet header the answer is 401
 * `payment_not_bound_to_caller`).
 */
export async function landedPaymentHeaders(signer: Signer, transactionSignature: string, request: WalletAuthOptions): Promise<{ "x-payment": string; "x-wallet-auth": string }> {
  return { "x-payment": transactionSignature, "x-wallet-auth": await walletAuthHeader(signer, request) };
}

// ---- Wallet sign-in ------------------------------------------------------------------------------------------------

/** Version of the sign-in scheme the challenge route reports. v1 (a client-built text naming no site) is retired. */
export const WALLET_SIGN_IN_VERSION = "trellis:wallet:v2";

/** `data` of POST /api/v1/auth/wallet/challenge: the nonce and the exact `message` the wallet signs. */
export type WalletChallenge = { nonce: string; message: string; domain: string; uri: string; chain_id: string; issued_at: string; expires_at: string; version: string };
/** The fields of a sign-in message (a Sign-In-With-Solana text). */
export type WalletSignInFields = { domain: string; address: string; statement: string; uri: string; version: string; chainId: string; nonce: string; issuedAt: string; expirationTime: string };

/** Read a sign-in message back into its fields; null when it is not one. */
export function parseWalletSignInMessage(message: string): WalletSignInFields | null {
  const m = /^([^\s]+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n([^\n]*)\n\nURI: ([^\n]+)\nVersion: ([^\n]+)\nChain ID: ([^\n]+)\nNonce: ([^\n]+)\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(message);
  if (!m) return null;
  return { domain: m[1], address: m[2], statement: m[3], uri: m[4], version: m[5], chainId: m[6], nonce: m[7], issuedAt: m[8], expirationTime: m[9] };
}

/**
 * Check a sign-in challenge before the wallet signs it: the message is a sign-in text for `host` (the router this
 * client is talking to) and for `address` (the wallet about to sign), with the challenge's own nonce, and has not
 * expired. Throws `sign_in_refused` otherwise: a challenge relayed from another site names that site, and signing it
 * would sign the wallet in there.
 */
export function checkWalletChallenge(challenge: WalletChallenge, expect: { host: string; address: PublicKeyLike; now?: number }): WalletSignInFields {
  const refuse = (why: string): never => {
    throw new TrellisError(`refusing to sign this sign-in challenge: ${why}`, "sign_in_refused");
  };
  const f = parseWalletSignInMessage(challenge?.message ?? "") ?? refuse("it is not a sign-in message");
  const host = expect.host.toLowerCase();
  if (f.domain.toLowerCase() !== host || (challenge.domain ?? "").toLowerCase() !== host) refuse(`it is for ${f.domain}, not for ${expect.host}`);
  let uriHost = "";
  try {
    uriHost = new URL(f.uri).host.toLowerCase();
  } catch {
    /* not a URL: refused below */
  }
  if (uriHost !== host) refuse(`its URI is ${f.uri}, not ${expect.host}`);
  if (f.address !== address(expect.address)) refuse("it names another wallet");
  if (f.nonce !== challenge.nonce) refuse("its nonce is not the challenge's");
  const expires = Date.parse(f.expirationTime);
  if (!Number.isFinite(expires) || expires <= (expect.now ?? Date.now())) refuse("it has expired");
  return f;
}

/**
 * The body of POST /api/v1/auth/wallet for a challenge: the wallet signs `challenge.message` exactly as the router
 * returned it (after {@link checkWalletChallenge}). `host` is the router's host the caller is talking to.
 */
export async function walletSignInBody(signer: Signer, challenge: WalletChallenge, o: { host: string; name?: string; now?: number }): Promise<{ address: string; nonce: string; signature: string; message: string; name?: string }> {
  checkWalletChallenge(challenge, { host: o.host, address: signer.publicKey, now: o.now });
  const signature = base58Encode(await signer.sign(utf8(challenge.message)));
  return { address: address(signer.publicKey), nonce: challenge.nonce, signature, message: challenge.message, ...(o.name ? { name: o.name } : {}) };
}

/**
 * Sign a wallet in: fetch the router's one-time challenge, check it is this router's, sign its `message` and exchange
 * it for an API key of the wallet's account. Returns the key (shown once) and its record.
 */
export async function walletSignIn(o: { baseUrl: string; signer: Signer; name?: string; fetch?: Fetch; now?: number }): Promise<{ key: string; data: Record<string, unknown> }> {
  const base = o.baseUrl.replace(/\/$/, "");
  const f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  const post = async (path: string, body: unknown) => {
    const res = await f(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { data?: unknown; key?: string; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw new TrellisError(json?.error?.message ?? `POST ${path} failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json;
  };
  const challenge = (await post("/api/v1/auth/wallet/challenge", { address: address(o.signer.publicKey) })).data as WalletChallenge;
  const answer = await post("/api/v1/auth/wallet", await walletSignInBody(o.signer, challenge, { host: new URL(base).host, name: o.name, now: o.now }));
  if (typeof answer.key !== "string") throw new TrellisError("the router returned no key", "request_failed");
  return { key: answer.key, data: (answer.data ?? {}) as Record<string, unknown> };
}

// ---- Credits closure -------------------------------------------------------------------------------------------------
// A closure names no destination. What is left of a key's credits returns to the wallets that deposited to it, each at
// most what it put in, to the token account that wallet named on chain (by default the one it paid from). The API key
// can ask for a closure and take it back; it cannot choose or change where the refund goes. Only a depositor's own
// wallet moves that depositor's destination.

/** The payer's part of a transaction the router already signed as the key: add one signature in slot 0, change nothing else. */
async function signAsPayerKeepingKey(transaction: string, payer: Signer, what: string, route: string): Promise<string> {
  const t = parseTransaction(transaction);
  const who = address(payer.publicKey);
  if (t.accountKeys[0] !== who) throw new TrellisError(`the ${what}'s fee payer is ${t.accountKeys[0]}, not ${who}: request it with payer set to the wallet that signs`, "bad_options");
  const others = t.signatures.slice(1, t.header.numRequiredSignatures);
  if (t.header.numRequiredSignatures < 2 || others.length !== t.header.numRequiredSignatures - 1 || others.some((sig) => sig.every((b) => b === 0)))
    throw new TrellisError(`the ${what} does not carry the key's signature: request a fresh one (POST ${route} with the key itself)`, "bad_options");
  const signed = await signTransaction(transaction, payer);
  const after = parseTransaction(signed);
  // The key signed this exact message: its signature has to arrive as it was issued.
  if (others.some((sig, i) => !sig.every((b, j) => b === after.signatures[i + 1][j]))) throw new TrellisError(`signing changed another signature of the ${what}`, "bad_options");
  return signed;
}

/**
 * Finish a credits closure: `transaction` (from POST /api/v1/credits/close) already carries the signature of the API
 * key's own keypair; the payer wallet adds its signature as fee payer, and nothing else changes. Returns the
 * transaction (base64) ready to send. Throws when the payer is not the fee payer or the key's signature is missing.
 * The payer only pays the fee: signing does not make it the destination of the refund.
 */
export const signCreditClosure = (transaction: string, payer: Signer): Promise<string> => signAsPayerKeepingKey(transaction, payer, "closure", "/api/v1/credits/close");

/**
 * Finish taking a closure back: `transaction` (from POST /api/v1/credits/close/cancel) already carries the key's
 * signature; the payer adds its own as fee payer exactly as for the closure. Returns base64, ready to send.
 */
export const signCreditClosureCancel = (transaction: string, payer: Signer): Promise<string> => signAsPayerKeepingKey(transaction, payer, "closure cancellation", "/api/v1/credits/close/cancel");

/**
 * Sign a change of refund destination (from POST /api/v1/credits/refund-destination-tx) with the DEPOSITOR's own wallet:
 * it is the fee payer and the only signer, and the API key has no part in it. Returns base64, ready to send. Throws
 * when the signer is not the depositor the transaction was built for, or when the transaction wants any other signature.
 */
export async function signRefundDestination(transaction: string, depositor: Signer): Promise<string> {
  const t = parseTransaction(transaction);
  const who = address(depositor.publicKey);
  if (t.accountKeys[0] !== who) throw new TrellisError(`this refund destination change is for ${t.accountKeys[0]}, not ${who}: only the wallet that deposited can sign it`, "bad_options");
  if (t.header.numRequiredSignatures !== 1) throw new TrellisError("a refund destination change is signed by the depositor alone; this transaction asks for other signatures", "bad_options");
  return signTransaction(transaction, depositor);
}
