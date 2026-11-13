// The router's prompt bound, mirrored for pages that show a worst case before a request is sent
// (the router's own copy: src/router/estimate.ts; security review R3-02).
//
// A hold is a bound, not an estimate. Text counts its UTF-8 bytes (non-ASCII text the larger of its bytes and its
// NFKD-normalised bytes), token ids count one each, templates get fixed allowances, and every other forwarded field
// that is a string, array or object counts the bytes of its indented JSON. Nothing here divides characters by a ratio,
// so at the router's default settings a figure from this file is never below the one the router holds. It is several
// times a tokenizer's count for English text; the router releases a hold down to actual usage when the call settles.

const encoder = new TextEncoder();
const utf8 = (s) => encoder.encode(s).length;
const ASCII = /^[\x00-\x7f]*$/;

/** The router's defaults (HOLD_TEMPLATE_TOKENS_PER_REQUEST, _PER_MESSAGE, _TOOLS and HOLD_DEFAULT_MAX_OUTPUT_TOKENS). */
export const HOLD_BOUND = Object.freeze({ perRequestTokens: 64, perMessageTokens: 16, toolsTokens: 256, defaultMaxOutputTokens: 16384 });

/** Fields that only mean something to the router: never forwarded to a provider, so never counted. */
const ROUTER_FIELDS = new Set(["provider", "models", "route", "transforms", "usage", "plugins", "cache", "guardrails", "user_id", "debug", "council", "verify"]);
export const ITEM_KINDS = Object.freeze(["image", "audio", "video", "file"]);
const MEDIA_PARTS = {
  image_url: "image", image: "image", input_image: "image",
  input_audio: "audio", audio: "audio", audio_url: "audio",
  video_url: "video", video: "video", input_video: "video",
  file: "file", input_file: "file", document: "file",
};
const MEDIA_KEYS = {
  images: "image", image: "image", image_url: "image",
  audio: "audio", audios: "audio", input_audio: "audio", audio_url: "audio",
  video: "video", videos: "video", video_url: "video",
  file: "file", files: "file", file_ids: "file", attachments: "file",
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Bound on the tokens of a piece of text: its UTF-8 bytes, or its NFKD-normalised bytes when those are more. */
export function textBound(text) {
  const s = String(text ?? "");
  const bytes = utf8(s);
  if (ASCII.test(s)) return bytes;
  let expanded = bytes;
  try {
    expanded = utf8(s.normalize("NFKD"));
  } catch {
    /* its own bytes stand */
  }
  return Math.max(bytes, expanded);
}

/** Bound for a JSON value a template may render into the prompt: the bytes of its 4-space-indented JSON, every string at its text bound. */
function jsonBound(v) {
  if (v === undefined) return 0;
  let extra = 0;
  const text = JSON.stringify(v, (_k, x) => {
    if (typeof x === "string" && !ASCII.test(x)) extra += Math.max(0, textBound(x) - utf8(x));
    return x;
  }, 4);
  return text === undefined ? 0 : utf8(text) + extra;
}

const isId = (x) => Number.isInteger(x) && x >= 0;
const isIdList = (x) => Array.isArray(x) && x.length > 0 && x.every(isId);

/** `prompt` (completions) or `input` (embeddings): each string or token-id array of a list is its own completion or embedding. */
function listBound(v, per) {
  if (typeof v === "string") return { tokens: textBound(v) + per, count: 1 };
  if (!Array.isArray(v) || !v.length) return { tokens: jsonBound(v), count: 1 };
  if (isIdList(v)) return { tokens: v.length + per, count: 1 };
  if (v.every((x) => typeof x === "string")) return { tokens: v.reduce((n, x) => n + textBound(x) + per, 0), count: v.length };
  if (v.every(isIdList)) return { tokens: v.reduce((n, x) => n + x.length + per, 0), count: v.length };
  return { tokens: jsonBound(v), count: 1 }; // the router refuses this shape
}

/**
 * What a request body costs in prompt tokens at most: { text, completions, items }. `text` covers everything that is
 * text, token ids or rendered JSON, template allowances included; `completions` is the prompts of a batched
 * /completions call (else 1); `items` counts the non-text input parts by kind, which only the model's own per-item
 * limits (input_token_limits in GET /api/v1/models) can bound.
 */
export function analyzePrompt(body, { endpoint = "chat" } = {}) {
  const s = HOLD_BOUND;
  const items = { image: 0, audio: 0, video: 0, file: 0 };
  let text = s.perRequestTokens;
  let completions = 1;
  const media = (kind, v) => {
    items[kind] += Array.isArray(v) ? Math.max(1, v.length) : 1;
  };
  const part = (p) => {
    if (typeof p === "string") return textBound(p);
    if (!p || typeof p !== "object" || Array.isArray(p)) return jsonBound(p);
    const type = p.type;
    if (typeof type === "string" && own(MEDIA_PARTS, type)) {
      media(MEDIA_PARTS[type], null);
      return 0;
    }
    const untyped = type == null ? Object.keys(p).find((key) => own(MEDIA_PARTS, key)) : undefined;
    if (untyped) {
      media(MEDIA_PARTS[untyped], null);
      return 0;
    }
    return jsonBound(p); // a part type the router cannot bound is refused there; here it counts as its JSON
  };
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined || v === null || ROUTER_FIELDS.has(k)) continue;
    // Not content: the model id, and top-level numbers and booleans (sampling and control parameters).
    if (k === "model" || k === "stream" || k === "stream_options" || typeof v === "number" || typeof v === "boolean") continue;
    if (k === "messages" && Array.isArray(v)) {
      for (const m of v) {
        text += s.perMessageTokens;
        if (!m || typeof m !== "object" || Array.isArray(m)) {
          text += jsonBound(m);
          continue;
        }
        for (const [mk, mv] of Object.entries(m)) {
          if (mv === undefined || mv === null) continue;
          if (mk === "content") text += typeof mv === "string" ? textBound(mv) : Array.isArray(mv) ? mv.reduce((n, p) => n + part(p), 0) : jsonBound(mv);
          else if (own(MEDIA_KEYS, mk)) media(MEDIA_KEYS[mk], mv);
          else text += utf8(mk) + 4 + jsonBound(mv);
        }
      }
    } else if (k === "prompt" && endpoint !== "embeddings") {
      const b = listBound(v, s.perMessageTokens);
      text += b.tokens;
      completions = b.count;
    } else if (k === "input" && endpoint === "embeddings") {
      text += listBound(v, s.perMessageTokens).tokens;
    } else if (k === "tools" || k === "functions") {
      if (!Array.isArray(v) || v.length) text += s.toolsTokens + jsonBound(v);
    } else if (own(MEDIA_KEYS, k)) media(MEDIA_KEYS[k], v);
    else text += utf8(k) + 4 + jsonBound(v);
  }
  return { text, completions, items };
}

/**
 * The prompt bound of a request body, in tokens. `items` are the model's per-item limits ({ image, audio, video, file });
 * a non-text part with no limit counts nothing here, because the router refuses such a request (400 unboundable_input)
 * instead of holding anything for it.
 */
export function promptBound(body, { items = null, endpoint = "chat" } = {}) {
  const a = analyzePrompt(body, { endpoint });
  return a.text + ITEM_KINDS.reduce((n, k) => n + a.items[k] * (Number.isInteger(items?.[k]) && items[k] > 0 ? items[k] : 0), 0);
}

/** How many completions a body asks for: batched prompts times `n` / `best_of`. A provider generates and bills each one. */
export function completionsOf(body, prompts = 1) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 1);
  return prompts * Math.max(1, n(body?.n), n(body?.best_of));
}
