import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { mulBps, type Pico, tokenCost } from "../lib/money.ts";
import { completionsOf } from "./estimate.ts";
import { contextTokens, DEFAULT_HOLD_CONFIG, type HoldConfig } from "./hold-config.ts";

export type Usage = {
  prompt: number;
  completion: number;
  reasoning: number;
  cachedRead: number;
  cacheWrite: number;
  webSearch: number;
  images: number;
  estimated: boolean;
  /** Rerank only: search units billed (one query over up to 100 document chunks). Each is charged the offer's request price; unset = one request. */
  searchUnits?: number;
};

/** `tab` (docs §5.2) carries the per-call margin like `per_call`: x402 and tabs are the <= 1% lines of docs/Trellis_Overview.md §4. */
export type Mode = "prepaid" | "per_call" | "paywith" | "byok" | "cache" | "blind" | "tab";

export type Cost = {
  upstream: Pico; // what the provider charges (0 for BYOK: the caller pays the provider directly)
  notional: Pico; // provider list price for this usage (used for BYOK fees and rankings)
  royalty: Pico;
  margin: Pico;
  cacheDiscount: Pico;
  holderDiscount: Pico; // fee saved by an $TRLS holder tier (already taken off margin)
  total: Pico; // charged to the caller
};

/** A token count as reported: a finite, non-negative number, else `fallback`. A provider's garbage never reaches the ledger as NaN. */
const count = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), Number.MAX_SAFE_INTEGER) : fallback;
};

export function readUsage(u: any, fallback?: { prompt: number; completion: number }): Usage {
  const has = u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number" || typeof u.input_tokens === "number");
  const cachedRead = count(u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens);
  const cacheWrite = count(u?.prompt_tokens_details?.cache_write_tokens ?? u?.cache_creation_input_tokens);
  const reasoning = count(u?.completion_tokens_details?.reasoning_tokens ?? u?.reasoning_tokens);
  let prompt = count(u?.prompt_tokens ?? u?.input_tokens, count(fallback?.prompt));
  let completion = count(u?.completion_tokens ?? u?.output_tokens, count(fallback?.completion));
  // Security review R5-10: two shapes report part of the bill NEXT TO the count this function used to price alone.
  //   - The additive input shape (`input_tokens` with top-level `cache_read_input_tokens` / `cache_creation_input_tokens`):
  //     `input_tokens` excludes what was read from and written to the cache. upstreamCost subtracts the cached part from
  //     the prompt, so the prompt must contain it.
  //   - Reasoning outside `completion_tokens`. It is inside only when `total_tokens` proves it (the total is less than
  //     prompt + completion + reasoning); with no total, or a total that counts it separately, it is added. Adding it
  //     where it was already inside over-charges by the reasoning tokens, never above the hold; the other mistake was
  //     the operator's cost.
  if (has && u.prompt_tokens == null && (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null)) prompt += cachedRead + cacheWrite;
  if (has && reasoning > 0) {
    const total = typeof u.total_tokens === "number" && Number.isFinite(u.total_tokens) ? u.total_tokens : null;
    if (total == null || total >= prompt + completion + reasoning) completion += reasoning;
  }
  return { prompt, completion, reasoning, cachedRead, cacheWrite, webSearch: count(u?.server_tool_use?.web_search_requests), images: 0, estimated: !has };
}

/**
 * The prompt tokens billed when a provider reports no usage at all: a third of the prompt bound (for ASCII text, the
 * figure this router has always used for unreported usage). The bound itself is for holds; billing a caller the bound
 * would charge several times what a tokenizer counts.
 */
export const unreportedPromptTokens = (bound: number) => Math.ceil(bound / 3);

const figure = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
/**
 * Whether a provider's usage object is a METER READING the call can be charged by (security review R5-10): an input
 * figure above zero (every call has a prompt), and no count that is negative or not a number. Anything else (no
 * figures, a zero or negative prompt, a string) is not a reading, and the call is charged the conservative bound
 * instead of whatever the garbage happens to price to (it priced to zero).
 */
export const hasUsage = (u: any): boolean => {
  if (!u || typeof u !== "object") return false;
  const input = u.prompt_tokens ?? u.input_tokens;
  if (!figure(input) || input <= 0) return false;
  for (const v of [u.completion_tokens, u.output_tokens, u.total_tokens, u.reasoning_tokens, u.completion_tokens_details?.reasoning_tokens, u.prompt_tokens_details?.cached_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]) if (v != null && !figure(v)) return false;
  return true;
};

/** A string's UTF-8 length: an upper bound on its tokens (no tokenizer emits a token of less than one byte). */
export const utf8Bound = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * The usage charged when a call reached a provider and no usage figures came back (security review R4-02): the
 * conservative bound of what the provider may bill. The prompt at its BOUND (router/estimate.ts, the figure the hold
 * was computed from), the output at the UTF-8 bytes of every token received. Never less than the prompt bound, which
 * is the documented minimum for a call a provider accepted. `estimated` marks the settlement: it is counted and
 * alarmed (services/billing-watch.ts), and the ledger still caps the charge at the hold.
 *
 * The alternative, a third of the bound and a quarter of a token per character (what this router billed before), is
 * what a tokenizer gives for English prose; a provider's meter for symbols, token ids or CJK is several times that,
 * and at zero markup the difference was the operator's.
 */
export function unmeteredUsage(promptBound: number, outputBytes = 0, reasoningBytes = 0): Usage {
  return { prompt: count(promptBound), completion: count(outputBytes) + count(reasoningBytes), reasoning: count(reasoningBytes), cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true };
}

/**
 * The provider's reported usage when it is a meter reading, else the conservative bound above. A reading of zero
 * output for an answer that carries output is not one (R5-10).
 */
export function usageOrBound(u: any, promptBound: number, outputBytes = 0, reasoningBytes = 0, /** Whether the answer carries output (default: any output bytes were counted). */ producedOutput = outputBytes + reasoningBytes > 0): Usage {
  if (hasUsage(u)) {
    const read = readUsage(u);
    if (read.completion > 0 || !producedOutput) return read;
  }
  return unmeteredUsage(promptBound, outputBytes, reasoningBytes);
}

/** Provider list price for a usage record. */
export function upstreamCost(c: Candidate, u: Usage): { cost: Pico; cacheDiscount: Pico } {
  const cached = Math.min(u.cachedRead, u.prompt);
  const freshPrompt = u.prompt - cached - Math.min(u.cacheWrite, u.prompt - cached);
  const readPrice = c.priceCacheRead ?? c.pricePrompt;
  const writePrice = c.priceCacheWrite ?? c.pricePrompt;
  const writes = Math.min(u.cacheWrite, u.prompt - cached);
  const reasoning = c.priceReasoning > 0n ? Math.min(u.reasoning, u.completion) : 0;
  const cost =
    tokenCost(freshPrompt, c.pricePrompt) +
    tokenCost(cached, readPrice) +
    tokenCost(writes, writePrice) +
    tokenCost(u.completion - reasoning, c.priceCompletion) +
    tokenCost(reasoning, c.priceReasoning) +
    c.priceRequest * BigInt(u.searchUnits == null ? 1 : Math.max(0, Math.ceil(u.searchUnits))) +
    BigInt(u.webSearch) * c.priceWebSearch +
    BigInt(u.images) * c.priceImage;
  const cacheDiscount = readPrice < c.pricePrompt ? tokenCost(cached, c.pricePrompt - readPrice) : 0n;
  return { cost, cacheDiscount };
}

/** `discountBps` ($TRLS holder tier) lowers Trellis's own fee rates, never below 0: upstream cost and
 *  royalties are never discounted, so a caller never pays less than the provider's cost. */
export type Fees = { royaltyBps: number; perCallMarginBps: number; byokFeeBps: number; discountBps?: number };

export function priceUsage(c: Candidate, model: ModelRow, u: Usage, mode: Mode, fees: Fees, byok: boolean): Cost {
  const { cost: notional, cacheDiscount } = upstreamCost(c, u);
  const upstream = byok ? 0n : notional;
  const royalty = model.creator && model.royaltyBps > 0 ? mulBps(notional, model.royaltyBps) : 0n;
  const marginAt = (off: number) =>
    (mode === "per_call" || mode === "tab" ? mulBps(upstream + royalty, Math.max(0, fees.perCallMarginBps - off)) : 0n) + (byok ? mulBps(notional, Math.max(0, fees.byokFeeBps - off)) : 0n);
  const off = Math.max(0, fees.discountBps ?? 0);
  const margin = marginAt(off);
  // What the discount saved: the margin at full rates minus the margin charged (0 when no margin applies).
  const holderDiscount = off ? marginAt(0) - margin : 0n;
  return { upstream, notional, royalty, margin, cacheDiscount, holderDiscount, total: upstream + royalty + margin };
}

export { analyzePrompt, boundWith, completionsOf, estimatePromptTokens, itemKindsOf, itemLimitsOf, maxItemLimits, refuseUnboundable } from "./estimate.ts";

/** Prompts batched in one /completions request (each string or token-id array of a list is its own completion); else 1. */
export const promptBatchOf = (body: Record<string, unknown>): number =>
  Array.isArray(body.prompt) && body.prompt.length > 0 && (typeof body.prompt[0] === "string" || Array.isArray(body.prompt[0])) ? body.prompt.length : 1;

/** The caller's output limit: the smaller of `max_tokens` and `max_completion_tokens` when both are sent; 0 when neither. */
export function askedOutputTokens(body: Record<string, unknown>): number {
  const asked = [body.max_completion_tokens, body.max_tokens].filter((v): v is number => Number.isInteger(v) && (v as number) > 0);
  return asked.length ? Math.min(...asked) : 0;
}

/**
 * The output cap for a request on a candidate: what is HELD and what is SENT upstream as `max_tokens` (security review
 * R3-02). It is the smallest of the caller's own limit, the catalog's output limit for the offer (the model's when the
 * offer has none, HOLD_DEFAULT_MAX_OUTPUT_TOKENS when neither has one) and the room the context window leaves after
 * the prompt bound. A caller value above the catalog limit is clamped, not refused; an omitted value is filled in.
 * `promptTokens` is the prompt bound (router/estimate.ts).
 */
export function maxOutputTokens(body: Record<string, unknown>, c: Candidate, model: ModelRow, promptTokens: number, cfg: Pick<HoldConfig, "defaultMaxOutputTokens" | "contextBytesPerToken"> = DEFAULT_HOLD_CONFIG) {
  const asked = askedOutputTokens(body);
  const ctx = c.ctx ?? model.ctx;
  const limit = c.maxOut ?? model.maxOut ?? Math.max(1, Math.min(ctx, cfg.defaultMaxOutputTokens));
  const room = Math.max(1, ctx - contextTokens(promptTokens, cfg));
  return Math.max(1, Math.min(asked > 0 ? asked : limit, limit, room));
}

export type WorstCaseOptions = {
  cfg?: HoldConfig;
  /** Image parts in the request, priced at the offer's per-image price on top of their tokens. */
  images?: number;
  /** Price this output cap instead of the request's own (0 is allowed): used to find the cap a fixed hold covers. */
  cap?: number;
};

/**
 * Worst-case charge for a request on a candidate: the hold amount. A BOUND, given that `promptTokens` is the prompt
 * bound and the output cap is sent upstream:
 *   - output: the cap, times every completion asked for (`n` / `best_of`, times the prompts of a batched request:
 *     providers generate and bill each one). `logprobs` / `top_logprobs` add no tokens: they annotate the tokens
 *     already counted. Reasoning tokens are part of the completion in this router's pricing (upstreamCost never bills
 *     reasoning beyond the completion count), so the cap covers them, at the dearer of the completion and reasoning
 *     price; a provider that generates reasoning outside the cap it was sent is over-reporting and is not paid for it.
 *   - input: the prompt bound, never more than the context window per completion (a provider cannot process more),
 *     billed once per choice (a provider that fans `n` out bills the prompt each time), at the dearest input price the
 *     catalog has for the offer: the cache-write (or cache-read) price when that is above the prompt price.
 *   - the per-request price once per completion, and the per-image price per image part.
 */
export function worstCase(c: Candidate, model: ModelRow, body: Record<string, unknown>, promptTokens: number, mode: Mode, fees: Fees, byok: boolean, o: WorstCaseOptions = {}): Pico {
  return priceUsage(c, model, orderedUsage(c, model, body, promptTokens, o), mode, fees, byok).total;
}

/**
 * The usage a request ORDERS from a candidate at most: what worstCase prices, and so what a hold covers. It is also
 * what a call is charged when the router stopped listening to a provider that had the request (its timeout, a caller
 * who left, an answer above the size it reads) and no usage figure came back (security review R5-01): the provider may
 * bill everything that was ordered, and nothing the router saw says it billed less.
 */
export function orderedUsage(c: Candidate, model: ModelRow, body: Record<string, unknown>, promptTokens: number, o: WorstCaseOptions = {}): Usage {
  const cfg = o.cfg ?? DEFAULT_HOLD_CONFIG;
  const prompts = promptBatchOf(body);
  const completions = completionsOf(body, prompts);
  const out = (o.cap ?? maxOutputTokens(body, c, model, promptTokens, cfg)) * completions;
  const ctx = c.ctx ?? model.ctx;
  const billable = Math.min(promptTokens, ctx * prompts) * (completions / prompts);
  const write = c.priceCacheWrite ?? 0n;
  const read = c.priceCacheRead ?? 0n;
  const usage: Usage = {
    prompt: billable,
    completion: out,
    reasoning: c.priceReasoning > c.priceCompletion ? out : 0,
    cachedRead: read > c.pricePrompt && read > write ? billable : 0,
    cacheWrite: write > c.pricePrompt && write >= read ? billable : 0,
    webSearch: 0,
    images: Math.max(0, o.images ?? 0),
    estimated: true,
    ...(completions > 1 ? { searchUnits: completions } : {}),
  };
  return usage;
}

// ---- The size of an answer (security review R5-01) -------------------------------------------------------------------
//
// The router reads at most MAX_ANSWER_BYTES of a provider's answer. An answer it cannot read to its end is still
// billed by the provider, so (a) such a call is charged what was ordered (orderedUsage) and is never retried elsewhere,
// and (b) a request whose answer could not fit is refused before anything is held or sent, so a caller cannot ORDER an
// answer the router will not deliver. (b) needs the bytes an answer of `tokens` output tokens can take. No tokenizer
// bounds that exactly; the figures below are generous for every format this router relays (a token's text escaped as
// JSON: about 4 bytes, 64 allowed; a stream's chunk envelope around each token: 150 to 350 bytes, 512 allowed; one
// `logprobs` entry with its token, bytes and logprob: about 80 bytes, 256 allowed), and nothing about billing depends
// on them being exact: an answer above the cap is charged in full either way.

/** The most bytes of one provider answer that are read (a non-streamed body, or a stream in total). */
export const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
/**
 * An attested gateway's answer is read no further than the bytes kept for checking its receipt (providers/upstream.ts
 * recordBody): an answer that was read to its end can then always be checked (R5-09).
 */
export const MAX_ATTESTED_ANSWER_BYTES = 16 * 1024 * 1024;
/** The most bytes of an answer that are read from this candidate. */
export const answerLimitOf = (c: Candidate): number => (c.provider?.aci ? MAX_ATTESTED_ANSWER_BYTES : MAX_ANSWER_BYTES);
/** No answer is cut below this, whatever was ordered: a provider that over-generates a little is still delivered and capped at the hold (R3-02). */
export const MIN_ANSWER_BYTES = 1024 * 1024;
const ANSWER_ENVELOPE_BYTES = 64 * 1024;
const BYTES_PER_OUTPUT_TOKEN = 64;
const BYTES_PER_STREAMED_TOKEN = 512;
const BYTES_PER_LOGPROB_ENTRY = 256;
/** JSON text of one embedding component (a double printed in full, a comma), and the widest vector assumed when `dimensions` is not sent. */
const BYTES_PER_EMBEDDING_COMPONENT = 26;
export const ASSUMED_EMBEDDING_DIMENSIONS = 4096;
/** The most inputs one embeddings request may batch (R5-01): 256 vectors of 4,096 components are 26 MiB of JSON. */
export const MAX_EMBEDDING_INPUTS = 256;

/** Whether a request asks for per-token log-probabilities, and how many alternatives per token. */
function logprobAlternatives(body: Record<string, unknown>): number | null {
  const top = Number.isInteger(body.top_logprobs) ? (body.top_logprobs as number) : 0;
  if (typeof body.logprobs === "number") return Math.max(body.logprobs, top); // legacy completions: logprobs is the count
  return body.logprobs === true || top > 0 ? top : null;
}

/** The bytes an answer to `body` can take when at most `cap` output tokens are generated per completion. */
export function answerBytesBound(body: Record<string, unknown>, cap: number, prompts = promptBatchOf(body)): number {
  const alternatives = logprobAlternatives(body);
  const perToken = (body.stream === true ? BYTES_PER_STREAMED_TOKEN : BYTES_PER_OUTPUT_TOKEN) + (alternatives == null ? 0 : BYTES_PER_LOGPROB_ENTRY * (1 + alternatives));
  return ANSWER_ENVELOPE_BYTES + completionsOf(body, prompts) * Math.max(1, Math.ceil(cap)) * perToken;
}

/** The bytes an embeddings answer can take: one vector per input, at the `dimensions` asked for or the widest assumed. */
export function embeddingBytesBound(body: Record<string, unknown>, inputs: number): number {
  const dims = Number.isInteger(body.dimensions) && (body.dimensions as number) > 0 ? (body.dimensions as number) : ASSUMED_EMBEDDING_DIMENSIONS;
  return ANSWER_ENVELOPE_BYTES + inputs * (dims * BYTES_PER_EMBEDDING_COMPONENT + 256);
}

/** The read cap for a candidate's answer bounded at `bound` bytes: never below the floor, never above the candidate's limit. */
export const answerReadCap = (c: Candidate, bound: number): number => Math.min(answerLimitOf(c), Math.max(MIN_ANSWER_BYTES, Math.ceil(bound)));

/**
 * Worst-case charge for a call with no output (embeddings, rerank): the input bound at the dearest input price the
 * catalog has for the offer, plus `searchUnits` request prices (one when unset).
 */
export function inputWorstCase(c: Candidate, model: ModelRow, promptTokens: number, mode: Mode, fees: Fees, searchUnits?: number): Pico {
  const write = c.priceCacheWrite ?? 0n;
  const read = c.priceCacheRead ?? 0n;
  const usage: Usage = {
    prompt: promptTokens,
    completion: 0,
    reasoning: 0,
    cachedRead: read > c.pricePrompt && read > write ? promptTokens : 0,
    cacheWrite: write > c.pricePrompt && write >= read ? promptTokens : 0,
    webSearch: 0,
    images: 0,
    estimated: true,
    ...(searchUnits != null ? { searchUnits } : {}),
  };
  return priceUsage(c, model, usage, mode, fees, false).total;
}

/**
 * The largest output cap (at most the request's own) whose worst case a fixed budget covers; 0 when the budget does
 * not cover even one output token. For calls whose hold was taken before their prompt was known (a council judge).
 */
export function capWithinBudget(budget: Pico, c: Candidate, model: ModelRow, body: Record<string, unknown>, promptTokens: number, mode: Mode, fees: Fees, byok: boolean, o: WorstCaseOptions = {}): number {
  const top = maxOutputTokens(body, c, model, promptTokens, o.cfg ?? DEFAULT_HOLD_CONFIG);
  const fits = (cap: number) => worstCase(c, model, body, promptTokens, mode, fees, byok, { ...o, cap }) <= budget;
  if (fits(top)) return top;
  if (!fits(1)) return 0;
  let lo = 1;
  let hi = top;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * A batch line's price: the normal price less `discountBps` (BATCH_DISCOUNT_BPS; 0 by default, security review R4-03). The
 * discount is rounded up, so the caller is never charged more than exactly the discounted price. The cost components
 * (upstream, royalty, margin) stay as priced: the operator absorbs the discount, which is why the configuration refuses
 * one that PROVIDER_FEE_BPS does not fund.
 */
export function batchPrice(cost: Cost, discountBps: number): Cost & { batchDiscount: Pico } {
  const bps = Math.min(10_000, Math.max(0, discountBps));
  const batchDiscount = mulBps(cost.total, bps, "ceil");
  return { ...cost, total: cost.total - batchDiscount, batchDiscount };
}

/** The hold for a batch line: the worst case less the discount, rounded so it still covers the discounted price. */
export const batchHold = (hold: Pico, discountBps: number): Pico => hold - mulBps(hold, Math.min(10_000, Math.max(0, discountBps)), "floor");
