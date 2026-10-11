import { z } from "zod";
import { isPublicRpcUrl } from "./constants.ts";
import { createRpcRedactor, DEFAULT_PUBLIC_RPC, registerRpcRedaction } from "./rpc-redaction.ts";

export const rpcEnv = { SOL_RPC_FALLBACK_URLS: z.string().default(DEFAULT_PUBLIC_RPC) };
function validateRpcUrl(value: string, name: string, _production: boolean) {
  // Plain HTTP stays allowed: compose service names and private networks use it.
  // What protects a keyed URL is redaction, not the scheme.
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must contain valid HTTP(S) URLs.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must use http or https.`);
  if (url.hash) throw new Error(`${name} must not contain URL fragments.`);
}
export function rpcSettings(e: { SOL_RPC_URL: string; SOL_RPC_FALLBACK_URLS: string; PUBLIC_RPC_URL: string }, production: boolean) {
  validateRpcUrl(e.SOL_RPC_URL, "SOL_RPC_URL", production);
  const urls = e.SOL_RPC_FALLBACK_URLS === "" ? [] : e.SOL_RPC_FALLBACK_URLS.split(",").map((url) => url.trim());
  for (const url of urls) validateRpcUrl(url, "SOL_RPC_FALLBACK_URLS", production);
  const privateUrls = [e.SOL_RPC_URL, ...urls];
  // The clusters' own public endpoints (api.mainnet-beta / api.devnet / api.testnet .solana.com) are never private, so a
  // devnet router may hand wallets the same api.devnet.solana.com it reads from itself.
  if (createRpcRedactor(privateUrls)(e.PUBLIC_RPC_URL) !== e.PUBLIC_RPC_URL)
    throw new Error("PUBLIC_RPC_URL must not expose a private RPC endpoint; use a public wallet endpoint.");
  registerRpcRedaction(privateUrls);
  // A public-only primary keeps its existing single HTTP transport, including retry defaults.
  return { rpcFallbackUrls: isPublicRpcUrl(e.SOL_RPC_URL) ? [] : [...new Map(urls.map((url) => [new URL(url).href, url])).values()].filter((url) => new URL(url).href !== new URL(e.SOL_RPC_URL).href) };
}
