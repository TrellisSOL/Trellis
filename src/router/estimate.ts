import { fail } from "../lib/errors.ts";

// The prompt-token BOUND behind every hold, context check and token rate limit (security review R3-02).
//
// A hold is a bound, not an estimate: whatever tokenizer the provider runs, the tokens it can honestly bill for a
// request are at most what this file returns. The rules, each sound on its own:
//
//   text            tokens <= UTF-8 bytes. A byte-level BPE token covers at least one byte, so no tokenizer of that
//                   family can produce more tokens than bytes. Tokenizers that normalise first (NFKC/NFKD: BERT-style
//                   embedding and rerank models, SentencePiece) can expand a character into several, so non-ASCII text
//                   counts the larger of its own bytes and its NFKD bytes.
//   token ids       one per id.
//   templates       a fixed allowance per request, per message (or per prompt of a batch) and for tool boilerplate:
//                   the role headers, BOS/EOS and default system text a chat template adds around the caller's text.
//   everything else every field that is forwarded to the provider and can carry content (any string, array or object,
//                   known to this file or not) is counted at the bytes of its indented JSON (how templates render
//                   tools, schemas and tool calls), so a field this file does not know cannot be free.
//   non-text parts  images, audio, video and files have no byte rule: they are counted per item at the figure the
//                   catalog declares for the offer (`input_token_limits`), and REFUSED when there is none.
//
// Nothing here divides characters by a ratio. The price of soundness is that the bound is several times a typical
// tokenizer's count for English text; a hold is released down to actual usage when the call settles.

/** Fields that only mean something to the router and are never forwarded to a provider (providers/upstream.ts). */
export const ROUTER_FIELDS: ReadonlySet<string> = new Set(["provider", "models", "route", "transforms", "usage", "plugins", "cache", "guardrails", "user_id", "debug", "council", "verify"]);

export type ItemKind = "image" | "audio" | "video" | "file";
export const ITEM_KINDS: readonly ItemKind[] = ["image", "audio", "video", "file"];
/** Token ceilings per non-text input item, as an offer's catalog entry declares them. */
export type ItemLimits = Partial<Record<ItemKind, number>>;

export type BoundSettings = {
  /** Tokens allowed for what a template adds once per request (BOS, a default system prompt, the generation header). */
  perRequestTokens: number;
  /** Tokens allowed for what a template adds around each message, each prompt of a batch and each embedding input. */
  perMessageTokens: number;
  /** Tokens allowed for the boilerplate a template adds when tools or functions are present. */
  toolsTokens: number;
  /** The most prompts one /completions request may batch (each is its own completion). */
  maxPromptBatch: number;
};
export const DEFAULT_BOUND: BoundSettings = { perRequestTokens: 64, perMessageTokens: 16, toolsTokens: 256, maxPromptBatch: 16 };

export type PromptAnalysis = {
  /** Bound on the tokens of everything that is text, token ids or rendered JSON, template allowances included. */
  text: number;
  /** How many completions the request asks for before `n`: the prompts of a batched /completions call, else 1. */
  completions: number;
  /** Non-text input items by kind; each needs the offer's per-item figure. */
  items: Record<ItemKind, number>;
};

const UNBOUNDABLE = "unboundable_input";
const ASCII = /^[\x00-\x7f]*$/;
/**
 * The UTF-8 length of `s` as an encoder writes it: a lone surrogate is written as U+FFFD (3 bytes), a pair as 4.
 * Counted here rather than with Buffer.byteLength, whose fast path counted lone surrogates differently on x86-64 than
 * on arm64 under Bun 1.3.14 (CI, R5-06): the bound must not depend on the machine the router runs on.
 */
export function utf8Length(s: string): number {
  if (ASCII.test(s)) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3; // the rest of the BMP, and a lone surrogate (written as U+FFFD)
  }
  return n;
}
const utf8 = utf8Length;

/** Bound on the tokens of a piece of text under any byte-level or normalising tokenizer. */
export function textBound(s: string): number {
  const own = utf8(s);
  if (ASCII.test(s)) return own;
  return Math.max(own, nfkdBytes(s));
}

/** UTF-16 units normalised at a time by nfkdBytes. */
const NFKD_SLICE = 8_192;
/** At most this many units are given up at a slice's end to cut where no surrogate touches the cut. */
const NFKD_BACKOFF = 32;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isSurrogate = (c: number) => c >= 0xd800 && c <= 0xdfff;
/**
 * The UTF-8 length of the NFKD form of `s`, without building that form (security review R5-06: one character can
 * expand eighteenfold, so normalising a megabyte of them in one piece allocated tens of megabytes per request).
 * Normalised a slice at a time and summed. The sum is exactly the length of the whole string's NFKD form: compatibility
 * decomposition maps each code point by itself, and the canonical reordering that follows only permutes combining
 * marks, so cutting between code points changes the order of some marks at a cut and never their number or their
 * bytes. A slice never ends inside a surrogate pair. (test/security-r5-06-nfkd.test.ts holds the equality.)
 */
export function nfkdBytes(s: string): number {
  let total = 0;
  for (let i = 0; i < s.length; ) {
    let end = Math.min(s.length, i + NFKD_SLICE);
    // Cut away from surrogates when possible: step back at most NFKD_BACKOFF units to a boundary with no surrogate on
    // either side, so no engine's handling of a lone surrogate at a slice edge can change the sum. In a run that dense
    // in surrogates, keep a pair whole instead: extend only when the cut falls between a high surrogate and the low
    // surrogate after it (a high followed by anything else is lone either way; pulling in a second high would split
    // the pair that starts there and count 2 bytes too many).
    if (end < s.length) {
      let back = end;
      while (back > end - NFKD_BACKOFF && back > i + 1 && (isSurrogate(s.charCodeAt(back - 1)) || isSurrogate(s.charCodeAt(back)))) back--;
      if (!isSurrogate(s.charCodeAt(back - 1)) && !isSurrogate(s.charCodeAt(back))) end = back;
      else if (isHigh(s.charCodeAt(end - 1)) && isLow(s.charCodeAt(end))) end++;
    }
    const slice = s.slice(i, end);
    try {
      total += utf8(slice.normalize("NFKD"));
    } catch {
      total += utf8(slice); // (normalize does not throw on any string; were it to, the slice's own bytes stand)
    }
    i = end;
  }
  return total;
}

/**
 * Bound for a JSON value a template may render into the prompt (tool definitions, schemas, tool calls, unknown
 * fields): the bytes of its 4-space-indented JSON, the most verbose common rendering, with every string at its
 * text bound.
 */
function jsonBound(v: unknown): number {
  if (v === undefined) return 0;
  let extra = 0;
  const text = JSON.stringify(v, (_k, x) => {
    if (typeof x === "string" && !ASCII.test(x)) extra += Math.max(0, textBound(x) - utf8(x));
    return x;
  }, 4);
  return text === undefined ? 0 : utf8(text) + extra;
}

const isId = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const isIdList = (x: unknown): x is number[] => Array.isArray(x) && x.length > 0 && x.every(isId);

/**
 * `prompt` (completions) or `input` (embeddings): a string, an array of strings, an array of token ids, or an array of
 * token-id arrays. Each string or id array of a list is its own completion (or its own embedding). Anything else
 * cannot be bounded and is refused.
 */
function promptBound(v: unknown, field: "prompt" | "input", s: BoundSettings, maxItems: number): { tokens: number; count: number } {
  const refuse = (): never => fail(400, `\`${field}\` must be a string, a non-empty array of strings, an array of token ids, or an array of token-id arrays; this shape cannot be bounded.`, field === "prompt" ? "invalid_request" : UNBOUNDABLE);
  if (typeof v === "string") return { tokens: textBound(v) + s.perMessageTokens, count: 1 };
  if (!Array.isArray(v) || v.length === 0) return refuse();
  if (isIdList(v)) return { tokens: v.length + s.perMessageTokens, count: 1 };
  let tokens = 0;
  if (v.every((x) => typeof x === "string")) for (const x of v as string[]) tokens += textBound(x) + s.perMessageTokens;
  else if (v.every(isIdList)) for (const x of v as number[][]) tokens += x.length + s.perMessageTokens;
  else return refuse();
  if (v.length > maxItems)
    fail(400, `\`${field}\` batches ${v.length} ${field === "prompt" ? "prompts" : "inputs"}; at most ${maxItems} are accepted in one request.`, field === "prompt" ? "prompt_batch_too_large" : "invalid_request", { max: maxItems });
  return { tokens, count: v.length };
}

// Content-part types. Text-like parts are counted as rendered JSON; media parts per item; anything else is refused.
const TEXT_PARTS = new Set(["text", "input_text", "output_text", "refusal", "thinking", "reasoning", "summary_text", "tool_use", "tool_result"]);
const MEDIA_PARTS: Record<string, ItemKind> = {
  image_url: "image", image: "image", input_image: "image",
  input_audio: "audio", audio: "audio", audio_url: "audio",
  video_url: "video", video: "video", input_video: "video",
  file: "file", input_file: "file", document: "file",
};
// Keys that carry media next to a message's content, or at the top level of a body, in provider-native dialects.
const MEDIA_KEYS: Record<string, ItemKind> = {
  images: "image", image: "image", image_url: "image",
  audio: "audio", audios: "audio", input_audio: "audio", audio_url: "audio",
  video: "video", videos: "video", video_url: "video",
  file: "file", files: "file", file_ids: "file", attachments: "file",
};
// Tools the provider runs on its own servers (search, code execution): what they add to a prompt and bill has no bound.
const isFunctionTool = (t: unknown) => !!t && typeof t === "object" && !Array.isArray(t) && ((t as { type?: unknown }).type == null || (t as { type?: unknown }).type === "function");

/** What a request body costs in prompt tokens at most, before per-item figures. Throws a 400 for a shape with no bound. */
export function analyzePrompt(body: Record<string, unknown>, o: { settings?: Partial<BoundSettings>; endpoint?: "chat" | "embeddings" } = {}): PromptAnalysis {
  const s = { ...DEFAULT_BOUND, ...o.settings };
  const items: Record<ItemKind, number> = { image: 0, audio: 0, video: 0, file: 0 };
  let text = s.perRequestTokens;
  let completions = 1;
  const media = (kind: ItemKind, v: unknown) => {
    items[kind] += Array.isArray(v) ? Math.max(1, v.length) : 1;
  };
  const part = (p: unknown): number => {
    if (typeof p === "string") return textBound(p);
    if (!p || typeof p !== "object" || Array.isArray(p)) return jsonBound(p);
    const type = (p as { type?: unknown }).type;
    if (typeof type === "string" && type in MEDIA_PARTS) {
      media(MEDIA_PARTS[type], null);
      return 0;
    }
    // A part with no type that still names a media field is media, whatever the provider makes of it.
    const untyped = type == null ? Object.keys(p).find((key) => key in MEDIA_PARTS) : undefined;
    if (untyped) {
      media(MEDIA_PARTS[untyped], null);
      return 0;
    }
    if (type == null || (typeof type === "string" && TEXT_PARTS.has(type))) return jsonBound(p);
    return fail(400, `Content part type ${JSON.stringify(type)} cannot be bounded, so the request is refused. Send text parts, or image/audio/video/file parts to a model whose catalog entry declares a per-item token limit.`, UNBOUNDABLE, { part_type: String(type).slice(0, 64) });
  };
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null || ROUTER_FIELDS.has(k)) continue;
    // Not content: `model` is replaced by the provider's own model id, and a top-level number or boolean is a sampling
    // or control parameter (temperature, max_tokens, stream, seed ...) that no template renders into the prompt.
    const promptField = (k === "prompt" && o.endpoint !== "embeddings") || (k === "input" && o.endpoint === "embeddings");
    if (!promptField && (k === "model" || k === "stream" || k === "stream_options" || typeof v === "number" || typeof v === "boolean")) continue;
    if (k === "messages" && Array.isArray(v)) {
      for (const m of v) {
        text += s.perMessageTokens;
        if (!m || typeof m !== "object" || Array.isArray(m)) {
          text += jsonBound(m);
          continue;
        }
        for (const [mk, mv] of Object.entries(m as Record<string, unknown>)) {
          if (mv === undefined || mv === null) continue;
          if (mk === "content") text += typeof mv === "string" ? textBound(mv) : Array.isArray(mv) ? mv.reduce((n: number, p) => n + part(p), 0) : jsonBound(mv);
          else if (mk in MEDIA_KEYS) media(MEDIA_KEYS[mk], mv);
          else text += utf8(mk) + 4 + jsonBound(mv);
        }
      }
    } else if (k === "prompt" && o.endpoint !== "embeddings") {
      const b = promptBound(v, "prompt", s, s.maxPromptBatch);
      text += b.tokens;
      completions = b.count;
    } else if (k === "input" && o.endpoint === "embeddings") {
      text += promptBound(v, "input", s, Number.MAX_SAFE_INTEGER).tokens;
    } else if (k === "tools" || k === "functions") {
      if (k === "tools" && Array.isArray(v) && !v.every(isFunctionTool))
        fail(400, "Only function tools can be bounded: a tool the provider runs on its own servers (web search, code execution, file search) is refused.", UNBOUNDABLE);
      if (!Array.isArray(v) || v.length) text += s.toolsTokens + jsonBound(v);
    } else if (k === "web_search_options") {
      fail(400, "`web_search_options` cannot be bounded: what a provider-side search adds to the prompt and bills has no limit in the catalog, so the request is refused.", UNBOUNDABLE);
    } else if (k in MEDIA_KEYS) media(MEDIA_KEYS[k], v);
    else text += utf8(k) + 4 + jsonBound(v);
  }
  return { text, completions, items };
}

/** The non-text item kinds a request carries. */
export const itemKindsOf = (a: PromptAnalysis): ItemKind[] => ITEM_KINDS.filter((k) => a.items[k] > 0);

/** The bound for an analysed request under an offer's per-item figures; null when a kind it carries has no figure. */
export function boundWith(a: PromptAnalysis, limits: ItemLimits | null | undefined): number | null {
  let tokens = a.text;
  for (const k of ITEM_KINDS) {
    if (!a.items[k]) continue;
    const per = limits?.[k];
    if (!Number.isInteger(per) || (per as number) <= 0) return null;
    tokens += a.items[k] * (per as number);
  }
  return tokens;
}

/** A request that carries non-text input no figure covers. */
export function refuseUnboundable(kinds: ItemKind[], model?: string): never {
  return fail(
    400,
    `This request carries ${kinds.join(", ")} input, which cannot be bounded${model ? ` for ${model}` : ""}: no provider's catalog entry declares a per-item token limit for it (input_token_limits), so the request is refused rather than guessed. Send text, or choose a model that declares the limit.`,
    UNBOUNDABLE,
    { kinds },
  );
}

/**
 * Upper bound on the prompt tokens of a request body: used for holds, context checks and token rate limits. `items`
 * are the per-item token figures of the offer(s) that may serve it; a request with non-text input and no figure for it
 * is refused with a 400 (`unboundable_input`). The name is historical: this was an estimate before review R3-02.
 */
export function estimatePromptTokens(body: Record<string, unknown>, o: { items?: ItemLimits | null; settings?: Partial<BoundSettings>; endpoint?: "chat" | "embeddings"; /** For displays and suggestions only, never for a hold: non-text items with no figure count as zero instead of refusing. */ lenient?: boolean } = {}): number {
  const a = analyzePrompt(body, o);
  const bound = boundWith(a, o.items);
  if (bound != null) return bound;
  if (o.lenient) return a.text + ITEM_KINDS.reduce((n, k) => n + a.items[k] * (o.items?.[k] ?? 0), 0);
  return refuseUnboundable(itemKindsOf(a).filter((k) => !o.items?.[k]));
}

/** How many completions a body asks for: batched prompts times `n` / `best_of` (providers generate and bill every one). */
export function completionsOf(body: Record<string, unknown>, prompts = 1): number {
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 1);
  return prompts * Math.max(1, n(body.n), n(body.best_of));
}

/** The per-item figures an offer declares (`features.input_token_limits`, from the provider's /models entry). */
export function itemLimitsOf(offer: { features?: unknown } | null | undefined): ItemLimits {
  const raw = (offer?.features as { input_token_limits?: unknown } | null | undefined)?.input_token_limits;
  const out: ItemLimits = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const k of ITEM_KINDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (Number.isInteger(v) && (v as number) > 0) out[k] = v as number;
  }
  return out;
}

/** The largest figure per kind across several offers: a bound for whichever of them serves the call. */
export function maxItemLimits(offers: Iterable<{ features?: unknown }>): ItemLimits {
  const out: ItemLimits = {};
  for (const o of offers) for (const [k, v] of Object.entries(itemLimitsOf(o)) as [ItemKind, number][]) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
