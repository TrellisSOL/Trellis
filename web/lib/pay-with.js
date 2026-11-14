// Pay with a tokenized stock (docs/Trellis_Backend.md §6): a call that carries `X-Pay-With: <mint>` is paid by an
// exact-out swap of that token for the USDC owed, signed by a Swig session key with a per-day cap in that token. This
// page only keeps the preference, per key, in this browser: which mint the dashboard's own calls should name. No swap
// is made here, and no session key is created here; the SDKs open the Swig session.
import { isAddress } from "./base58.js";

export const HEADER = "X-Pay-With";
const STORE = "trellis-pay-with-v1";

export const isMint = (value) => isAddress(String(value ?? "").trim());

/** The stored preference for a key hash: a mint address, or "" for USDC credits. */
export function loadPayWith(keyHash, storage = globalThis.localStorage) {
  try {
    const all = JSON.parse(storage?.getItem(STORE) || "{}");
    const mint = all?.[keyHash];
    return isMint(mint) ? mint : "";
  } catch {
    return "";
  }
}

/** Keep a mint for a key hash, or clear it with "" or null. Returns what is stored. */
export function savePayWith(keyHash, mint, storage = globalThis.localStorage) {
  const value = String(mint ?? "").trim();
  if (value && !isMint(value)) throw new Error("Enter the token's mint address (base58, 32 bytes), or leave it empty to pay with USDC credits.");
  try {
    const all = JSON.parse(storage?.getItem(STORE) || "{}");
    if (value) all[keyHash] = value;
    else delete all[keyHash];
    storage?.setItem(STORE, JSON.stringify(all));
  } catch {
    /* storage unavailable: the choice holds for this page only */
  }
  return value;
}

/** Request headers for a call under this preference: the X-Pay-With header, or nothing for USDC. */
export const payWithHeaders = (mint) => (isMint(mint) ? { [HEADER]: String(mint).trim() } : {});

/** What the setting means, in words the page shows. */
export const PAY_WITH_COPY = {
  what: "Each call names a token mint in the X-Pay-With header. The router swaps exactly the USDC the call costs out of that token at a price within 1% of the oracle value, batched until at least $1 or 24 hours.",
  session: "The swap is signed by a Swig session key you create with the SDK: a key limited to a per-day cap in that token and to this router's swap program. Without a session key the header is ignored and the call falls back to prepaid credits, then to 402.",
  guard: "If the token's Scaled UI Amount multiplier changed in the last 24 hours, the payment falls back to credits for that call.",
};
