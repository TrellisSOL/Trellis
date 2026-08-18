import { toChatRequest } from "../../../src/anthropic/convert.ts";
import { estimatePromptTokens, type ItemLimits } from "../../../src/router/estimate.ts";
import { mulBps, usdToPico } from "../../../src/lib/money.ts";
import type { TorFetch } from "./tor.ts";

/**
 * Use the same conversion and prompt BOUND as the router (the figure its holds are priced at: UTF-8 bytes of text and
 * JSON plus template allowances), including tools and tool results. No I/O. An image is bounded by the per-item limit
 * the model declares (`input_token_limits` in GET /v1/models), passed as `items`; without one this throws, exactly as
 * the router refuses the request (400 unboundable_input), instead of guessing.
 */
export function countMessageTokens(body: Record<string, unknown>, items?: ItemLimits | null) {
  return estimatePromptTokens(toChatRequest(body, { countOnly: true }).body, { items });
}

/** Prices stay only in memory for one minute, and every refresh goes through the supplied Tor transport. */
export function messageBudget(fetchOverTor: TorFetch, onion: string) {
  let cached: { until: number; rows: Record<string, any>[] } | null = null;
  let pending: Promise<Record<string, any>[]> | null = null;
  const rows = async (signal: AbortSignal) => {
    if (cached && cached.until > Date.now()) return cached.rows;
    if (!pending) {
      pending = (async () => {
        const res = await fetchOverTor(`http://${onion}/api/v1/models?lane=unlinkable`, { headers: { accept: "application/json" }, signal });
        if (!res.ok) throw new Error(`Model prices could not be read (${res.status}). No tokens were leased.`);
        const json = await res.json() as { data?: Record<string, any>[] };
        if (!Array.isArray(json.data)) throw new Error("The model directory is invalid.");
        cached = { until: Date.now() + 60_000, rows: json.data };
        return json.data;
      })().finally(() => { pending = null; });
    }
    return pending;
  };
  return async (body: Record<string, unknown>, signal: AbortSignal): Promise<bigint> => {
    // Validate before any network or token lease. Keep the un-clamped max_tokens for a conservative estimate.
    const conv = toChatRequest(body);
    const model = (await rows(signal)).find((row) => row.id === body.model);
    if (!model) throw new Error("Choose an attested model from GET /v1/models. No tokens were leased.");
    // The router's prompt bound; non-text input needs the model's declared per-item limits (it throws without them).
    const input = estimatePromptTokens(conv.body, { items: (model.input_token_limits ?? null) as ItemLimits | null });
    const price = (field: string) => {
      const raw = model.pricing?.[field];
      if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`Model ${field} price is unavailable. No tokens were leased.`);
      const value = usdToPico(raw);
      if (value < 0n) throw new Error("Model prices must be nonnegative.");
      return value;
    };
    const outputPrice = price("completion");
    const reasoningPrice = model.pricing?.internal_reasoning == null ? outputPrice : price("internal_reasoning");
    // The router holds the input at the dearest input price the model lists (a cache write or read above the prompt price).
    const optional = (field: string) => (model.pricing?.[field] == null ? 0n : price(field));
    const inputPrice = [price("prompt"), optional("input_cache_write"), optional("input_cache_read")].reduce((a, b) => (b > a ? b : a));
    const base = BigInt(input) * inputPrice + BigInt(conv.body.max_tokens as number) * (reasoningPrice > outputPrice ? reasoningPrice : outputPrice) + price("request");
    const royalty = Number(model.royalty_bps ?? 0);
    if (!Number.isInteger(royalty) || royalty < 0 || royalty > 10_000) throw new Error("Invalid model royalty.");
    return base + mulBps(base, royalty);
  };
}
