/** URL-only redaction: this does not filter request text or unrelated credentials. */
export { DEFAULT_PUBLIC_RPC } from "./constants.ts";
import { isPublicRpcUrl } from "./constants.ts";
export type RpcRedactor = (text: string) => string;

/** Pure, reusable matcher, including shortened URLs in library error messages. */
export function createRpcRedactor(urls: readonly string[]): RpcRedactor {
  // The clusters' public endpoints (mainnet-beta, devnet, testnet) carry no key and are never redacted.
  const privateUrls = urls.filter((url) => !isPublicRpcUrl(url));
  const hosts = new Set(privateUrls.map((url) => new URL(url).host.toLowerCase()));
  const exact = [...new Set(privateUrls.flatMap((url) => {
    const parsed = new URL(url);
    return [url, parsed.origin + parsed.pathname];
  }))].sort((a, b) => b.length - a.length);
  return (text) => {
    if (!hosts.size) return text;
    let safe = text.replace(/https?:\/\/[^\s"'<>`\\]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return hosts.has(parsed.host.toLowerCase()) ? `${parsed.protocol}//${parsed.host}/…` : url;
      } catch { return url; }
    });
    for (const url of exact) safe = safe.replaceAll(url, "[private RPC]");
    return safe;
  };
}

// Keep matchers for the process lifetime: an older client's in-flight failure must remain safe
// when configuration is loaded again. No URL is logged or persisted here.
const configured = new Set<string>();
let currentRedactor: RpcRedactor = (text) => text;
export function registerRpcRedaction(urls: readonly string[]) {
  let changed = false;
  for (const url of urls) if (!isPublicRpcUrl(url) && !configured.has(url)) {
    configured.add(url);
    changed = true;
  }
  if (changed) currentRedactor = createRpcRedactor([...configured]);
}
export const redactRpcText: RpcRedactor = (text) => currentRedactor(text);
export function redactRpcFields<T>(value: T): T {
  if (!configured.size || value instanceof Date) return value;
  if (typeof value === "string") return redactRpcText(value) as T;
  if (Array.isArray(value)) return value.map(redactRpcFields) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, field]) => [redactRpcText(key), redactRpcFields(field)])) as T;
  return value;
}

/** Preserve the RPC client's error types/codes and causes, while removing URL text. */
export function redactRpcError(error: unknown, redact: RpcRedactor = redactRpcText, seen = new WeakSet<object>()): unknown {
  if (typeof error === "string") return redact(error);
  if (!error || typeof error !== "object" || seen.has(error)) return error;
  seen.add(error);
  for (const key of Object.getOwnPropertyNames(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
    if (!("value" in descriptor)) continue;
    const value = redactRpcError(descriptor.value, redact, seen);
    if (descriptor.writable) (error as Record<string, unknown>)[key] = value;
  }
  return error;
}
