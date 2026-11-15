// Solana facts the site shows and the helpers that turn the router's status into words: the USDC mint, the CAIP-2 network
// ids x402 uses, the Wallet Standard chain names, explorer links and Solana Pay transfer links. Pure; no network access.
import { base58Encode, hexToBytes, isAddress } from "./base58.js";

/** USDC on Solana mainnet-beta (6 decimals). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
/** CAIP-2 ids, as x402 v2 and the facilitator name networks. */
export const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
export const EXPLORER = "https://explorer.solana.com";

const CLUSTERS = {
  [MAINNET]: { chain: "solana:mainnet", name: "Solana mainnet-beta", cluster: "" },
  [DEVNET]: { chain: "solana:devnet", name: "Solana devnet", cluster: "devnet" },
  [TESTNET]: { chain: "solana:testnet", name: "Solana testnet", cluster: "testnet" },
};

/** The cluster a router's `network` (CAIP-2 or a Wallet Standard chain name) refers to. Unknown ids read as a local validator. */
export function clusterOf(network) {
  const id = String(network ?? "");
  if (CLUSTERS[id]) return { id, ...CLUSTERS[id] };
  const named = Object.entries(CLUSTERS).find(([, c]) => c.chain === id);
  if (named) return { id: named[0], ...named[1] };
  return { id: id || "solana:localnet", chain: "solana:localnet", name: id ? "Solana (local validator)" : "Solana", cluster: "custom" };
}

/** The chain block of GET /api/v1/status as the pages use it: cluster name, Wallet Standard chain, RPC, explorer, mint. */
export function chainOf(status) {
  const c = status?.chain || {};
  const cluster = clusterOf(c.network);
  return { id: c.chain_id ?? null, network: cluster.id, chain: cluster.chain, name: cluster.name, cluster: cluster.cluster, rpc: c.public_rpc || null, explorer: c.explorer || EXPLORER, usdc: c.usdc || USDC_MINT, programs: c.programs || {} };
}

const explorerLink = (kind, value, chain) => {
  const base = (chain?.explorer || EXPLORER).replace(/\/$/, "");
  const q = chain?.cluster && chain.cluster !== "custom" ? `?cluster=${chain.cluster}` : "";
  return `${base}/${kind}/${encodeURIComponent(value)}${q}`;
};
/** An explorer page for a transaction signature, on the router's cluster. */
export const explorerTx = (signature, chain) => explorerLink("tx", signature, chain);
/** An explorer page for an address (a mint, a program, an account). */
export const explorerAddress = (address, chain) => explorerLink("address", address, chain);

/** The key hash (hex, 32 bytes) as a base58 public key, usable as a Solana Pay `reference` account. */
export function keyHashReference(keyHash) {
  const bytes = hexToBytes(keyHash);
  if (bytes.length !== 32) throw new Error("A key hash is 32 bytes.");
  return base58Encode(bytes);
}

/** A USDC amount with up to 6 decimals, as the API and Solana Pay take it. */
export const USDC_AMOUNT = /^\d+(\.\d{1,6})?$/;

/**
 * A Solana Pay transfer request (https://docs.solanapay.com/spec#transfer-request): the wallet app sends `amount` of the
 * SPL token `mint` to `recipient`'s token account and includes `reference` as a read-only account so the router's
 * indexer can find the transfer. Throws when a field is not well formed.
 */
export function solanaPayUrl({ recipient, mint = USDC_MINT, amount, reference, label = "Trellis", message }) {
  if (!isAddress(recipient)) throw new Error("The recipient is not a Solana address.");
  if (!isAddress(mint)) throw new Error("The token mint is not a Solana address.");
  if (reference != null && !isAddress(reference)) throw new Error("The reference is not a Solana address.");
  const q = [];
  if (amount != null) {
    const a = String(amount).trim();
    if (!USDC_AMOUNT.test(a) || Number(a) <= 0) throw new Error("Enter a USDC amount above zero with up to 6 decimals.");
    q.push(`amount=${a}`);
  }
  q.push(`spl-token=${mint}`);
  if (reference) q.push(`reference=${reference}`);
  if (label) q.push(`label=${encodeURIComponent(label)}`);
  if (message) q.push(`message=${encodeURIComponent(message)}`);
  return `solana:${recipient}?${q.join("&")}`;
}
