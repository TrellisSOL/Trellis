import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { ADDRESS_RE, USDC_MINT, base58Encode } from "../../src/solana/constants.ts";

// Deterministic Solana-shaped placeholder values for tests. Every address is the base58 ed25519 public key of a keypair
// derived from a fixed label, every secret key is the base58 64-byte (seed || public key) form the config loader and the
// Solana CLI use. Nothing here is a real account; the seeds are public text.

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keypair(label: string) {
  const seed = createHash("sha256").update(`trellis-test-fixture:${label}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  return { address: base58Encode(new Uint8Array(pub)), secretKey: base58Encode(new Uint8Array(Buffer.concat([seed, pub]))) };
}

const addresses = new Map<string, string>();
const secretKeys = new Map<string, string>();

/** A valid base58 Solana address (32-byte ed25519 public key), the same for the same label. */
export function fixtureAddress(label: string | number): string {
  const key = String(label);
  let v = addresses.get(key);
  if (!v) addresses.set(key, (v = keypair(`address:${key}`).address));
  return v;
}

/** A valid base58 64-byte ed25519 secret key, the same for the same label. Its address is `fixtureSignerAddress(label)`. */
export function fixtureSecretKey(label: string | number): string {
  const key = String(label);
  let v = secretKeys.get(key);
  if (!v) secretKeys.set(key, (v = keypair(`key:${key}`).secretKey));
  return v;
}

/** The public address that belongs to `fixtureSecretKey(label)`. */
export const fixtureSignerAddress = (label: string | number) => keypair(`key:${String(label)}`).address;

/** The USDC mint on mainnet-beta: use it wherever a stablecoin mint is meant. */
export const USDC_MINT_ADDRESS = USDC_MINT;

/** One address for the places that only need "some valid address". */
export const ADDRESS = fixtureAddress(1);

/** Named placeholders for the chain-related keys src/config.ts validates. */
export const SOLANA = {
  CREDITS_ADDRESS: fixtureAddress("credits"),
  CALLPAY_ADDRESS: fixtureAddress("callpay"),
  PROVIDER_BOND_ADDRESS: fixtureAddress("provider-bond"),
  RECEIPT_ANCHOR_ADDRESS: fixtureAddress("receipt-anchor"),
  PAYWITHSTOCK_ADDRESS: fixtureAddress("paywithstock"),
  ROYALTY_ADDRESS: fixtureAddress("royalty"),
  PAYMASTER_ADDRESS: fixtureAddress("paymaster"),
  CALLPAY_TREASURY: fixtureAddress("callpay-treasury"),
  MEASUREMENT_REGISTRY_ADDRESS: fixtureAddress("measurement-registry"),
  ESCROW_ADDRESS: fixtureAddress("escrow"),
  TRLS_TOKEN_ADDRESS: fixtureAddress("trls-mint"),
  TRLS_POOL_PROGRAM: fixtureAddress("trls-pool-program"),
  X402_PAY_TO: fixtureAddress("x402-pay-to"),
  USDC_ADDRESS: USDC_MINT,
  ROUTER_PRIVATE_KEY: fixtureSecretKey("router"),
  SETTLEMENT_PRIVATE_KEY: fixtureSecretKey("settlement"),
  ANCHORER_PRIVATE_KEY: fixtureSecretKey("anchorer"),
  SLASHER_PRIVATE_KEY: fixtureSecretKey("slasher"),
  KEEPER_PRIVATE_KEY: fixtureSecretKey("keeper"),
  PAYMASTER_SIGNER_KEY: fixtureSecretKey("paymaster-signer"),
  DEV_FAUCET_PRIVATE_KEY: fixtureSecretKey("dev-faucet"),
  IPX_KEEPER_PRIVATE_KEY: fixtureSecretKey("ipx-keeper"),
  MAKEGOOD_REFUND_PRIVATE_KEY: fixtureSecretKey("makegood-refund"),
} as const;

/**
 * The full environment the production loader demands for an API role (TRELLIS_ENV=production, Postgres and Redis with
 * nondefault credentials, the four required program addresses, the router signing key). Pass overrides for the role,
 * the jobs or the feature under test; a key set to undefined is dropped.
 */
export function solanaProductionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    NODE_ENV: "production",
    TRELLIS_ENV: "production",
    RUNTIME_ROLE: "api",
    AUTO_MIGRATE: "false",
    HOST: "0.0.0.0",
    APP_SECRET: "fixture-".repeat(6),
    ADMIN_TOKEN: "fixture-admin-".repeat(3),
    PUBLIC_BASE_URL: "https://router.example",
    DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test",
    REDIS_URL: "redis://:fixture-only-credential@localhost:6379",
    CREDITS_ADDRESS: SOLANA.CREDITS_ADDRESS,
    CALLPAY_ADDRESS: SOLANA.CALLPAY_ADDRESS,
    PROVIDER_BOND_ADDRESS: SOLANA.PROVIDER_BOND_ADDRESS,
    RECEIPT_ANCHOR_ADDRESS: SOLANA.RECEIPT_ANCHOR_ADDRESS,
    USDC_ADDRESS: SOLANA.USDC_ADDRESS,
    ROUTER_PRIVATE_KEY: SOLANA.ROUTER_PRIVATE_KEY,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined));
}

// Sanity: every generated value has the shape the loader checks, so a broken derivation fails loudly at import time.
for (const v of Object.values(SOLANA)) {
  if (!ADDRESS_RE.test(v) && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v)) throw new Error("solana-fixtures: generated a malformed value");
}
