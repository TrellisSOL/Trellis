// Deterministic JSON: object keys sorted recursively, undefined dropped, bigint as string.
// This is the same function the router uses to sign receipts (src/lib/util.ts `canonical`) and the sidecar uses for
// its bindings digest, kept byte-for-byte equivalent. A test in the router's suite compares the two on many inputs.

export function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      // A member named "__proto__" is a member like any other: assigning it would set the copy's prototype and drop it
      // from the bytes, so it could be added to a signed payload without breaking the signature (R5-22).
      if (v !== undefined) { if (k === "__proto__") Object.defineProperty(out, k, { value: canonical(v), enumerable: true, writable: true, configurable: true }); else out[k] = canonical(v); }
    }
    return out;
  }
  return value;
}

export const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v));
