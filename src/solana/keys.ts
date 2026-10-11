import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "../lib/util.ts";
import { base58Decode, base58Encode } from "./constants.ts";

// API keys are self-custodial. From the secret the router (and the key holder) derive:
//   keyHash      = sha256(secret)                          — database lookup, never reversible
//   keyAddress   = ed25519 public key (base58) of seed sha256("trellis-key-v1:" + secret)
//   chainKeyHash = sha256(public key bytes), hex           — the per-key credit balance id (CreditAccount seed)
// So anyone can generate a key offline, fund its balance and start calling the API immediately. Credits are spend-only.

export const KEY_PREFIX = "sk-tr-v1-";
export const KEY_RE = /^sk-tr-v1-[0-9a-f]{64}$/;

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/** The 32-byte ed25519 seed derived from the secret, as hex. */
export function keyPrivateKey(secret: string): string {
  return createHash("sha256").update("trellis-key-v1:" + secret).digest("hex");
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function deriveKey(secret: string) {
  const seed = Buffer.from(keyPrivateKey(secret), "hex");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));
  const keyAddress = base58Encode(publicKey);
  return {
    keyHash: sha256(secret),
    keyAddress,
    chainKeyHash: chainKeyHashOf(keyAddress),
    label: `${secret.slice(0, 13)}...${secret.slice(-4)}`,
    account: {
      address: keyAddress,
      /** Detached ed25519 signature over `message`, base58. */
      sign: (message: Uint8Array) => base58Encode(new Uint8Array(sign(null, message, privateKey))),
      /** The same signature as raw bytes (for the Ed25519 precompile instruction). */
      signBytes: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)),
    },
  };
}

export const chainKeyHashOf = (address: string) => sha256(base58Decode(address));

/** The 32-byte CreditAccount seed of a key: its chainKeyHash as bytes. */
export const chainKeyHashBytes = (chainKeyHash: string) => new Uint8Array(Buffer.from(chainKeyHash.replace(/^0x/, ""), "hex"));

// ---- Role signers ---------------------------------------------------------------------------------------------------
// Router, settlement, anchorer, slasher and facilitator authorities are base58-encoded 64-byte ed25519 secret keys
// (seed || public key), the form `solana-keygen` and the config validator (src/config.ts `pk`) use. The secret never
// leaves the Keypair: nothing here logs, stringifies or returns it, and errors never echo the input.

export type RoleSignerKey = Keypair;

/** Decode a base58 64-byte secret key into a Keypair; refuses any other length or a seed/public-key mismatch. */
export function loadSigner(secretBase58: string): Keypair {
  let bytes: Uint8Array;
  try { bytes = base58Decode(secretBase58.trim()); } catch { throw new Error("signing key is not base58"); }
  if (bytes.length !== 64) throw new Error("signing key must be a 64-byte ed25519 secret key");
  const kp = Keypair.fromSecretKey(bytes, { skipValidation: false });
  return kp;
}

/** The public address of a base58 secret key, or null when it is not a valid signer. Safe to log. */
export function signerAddress(secretBase58: string | undefined): string | null {
  if (!secretBase58) return null;
  try { return loadSigner(secretBase58).publicKey.toBase58(); } catch { return null; }
}

/** A deterministic Keypair from a 32-byte seed (tests and session keys); production role keys come from config. */
export const keypairFromSeed = (seed: Uint8Array) => Keypair.fromSeed(seed);

export const toPublicKey = (address: string | PublicKey) => (address instanceof PublicKey ? address : new PublicKey(address));
