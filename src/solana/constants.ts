// Chain-wide constants shared by the Solana modules. Addresses are base58 strings, amounts are bigint base units.

/** USDC mint on Solana mainnet-beta (6 decimals). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
/** CAIP-2 identifier of Solana mainnet-beta, as x402 v2 names networks. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** CAIP-2 identifier of Solana devnet. */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEFAULT_PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
/** The clusters' own public RPC endpoints: never private, so never redacted, and fine as a wallet-facing PUBLIC_RPC_URL. */
export const PUBLIC_RPC_URLS: readonly string[] = [DEFAULT_PUBLIC_RPC, "https://api.devnet.solana.com", "https://api.testnet.solana.com"];
export const isPublicRpcUrl = (url: string) => { try { return PUBLIC_RPC_URLS.some((u) => new URL(u).href === new URL(url).href); } catch { return false; } };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A base58 Solana address (32-byte ed25519 public key): 32 to 44 characters of the Bitcoin alphabet. */
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A base58 Solana transaction signature (64 bytes). */
export const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS_RE.test(v);
/**
 * An address as an identity to compare by. Base58 is case-sensitive, so a Solana address is used exactly as written;
 * only a 0x hex address (whose case carries no meaning) is lowercased. Base58 has no "0", so nothing base58 starts with 0x.
 */
export const addressKey = (address: string) => (/^0x/i.test(address) ? address.toLowerCase() : address);
/** A payout address a host or provider may register: a base58 Solana address (the wallet that owns the USDC account). */
export const isPayoutAddress = (v: unknown): v is string => isAddress(v);
export const PAYOUT_ADDRESS_MESSAGE = "expected a base58 Solana address (32 to 44 characters)";

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
    if (carry < 0) throw new Error("not a base58 string");
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

/** Thrown by every placeholder operation that would move money or sign for a chain role. */
export const notPorted = (name: string) => new Error(`not ported to Solana yet: ${name}`);
