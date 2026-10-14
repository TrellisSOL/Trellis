import type { Context, MiddlewareHandler } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { NOT_ENABLED } from "./surface.ts";

// Non-core features that are not routes: a header, a body field, a model prefix or a key setting on a CORE route selects
// them. In LAUNCH_SURFACE=core each is refused before anything is priced, held or sent upstream, with the same answer a
// non-core route gives (404 `not_enabled`), so a caller is never served by a code path the launch did not review.
// (The settings that back these features are also refused or dropped at start-up: src/surface/config.ts.)

const notEnabled = (what: string): never => {
  throw new ApiError(404, `${what} is not enabled on this router (launch surface: core).`, NOT_ENABLED, { launch_surface: "core" });
};

/** Request headers that select a non-core feature. */
const NON_CORE_HEADERS: Record<string, string> = {
  "x-pay-with": "Pay-with (X-Pay-With)",
  "x-trellis-cache": "The response cache (X-Trellis-Cache)",
  "x-e2ee-version": "Encrypted pass-through (X-E2EE-*)",
  "x-client-pub-key": "Encrypted pass-through (X-E2EE-*)",
  "x-agent-approval": "Agent approvals (X-Agent-Approval)",
  "x-trellis-decision-tag": "Decision tags (X-Trellis-Decision-Tag)",
};

/** Mounted only in core (src/app.ts): refuses the headers above and any credential scheme other than a key. */
export const coreRequestMiddleware = (_ctx: Ctx): MiddlewareHandler => async (c, next) => {
  for (const [header, what] of Object.entries(NON_CORE_HEADERS)) if (c.req.header(header) !== undefined) notEnabled(what);
  const auth = c.req.header("authorization");
  // Bearer keys only. `PrivateToken` (blind tokens) and anything else is not a core credential.
  if (auth !== undefined && auth.length > 0 && !(auth.length <= 512 && auth.slice(0, 7).toLowerCase() === "bearer ")) notEnabled("This authorization scheme");
  await next();
};

/** Body fields of an inference request that select a non-core feature (the router's own extensions, never forwarded). */
const NON_CORE_BODY_FIELDS: Record<string, string> = {
  guardrails: "Request-level guardrails (`guardrails`)",
  transforms: "Prompt transforms (`transforms`)",
  cache: "The response cache (`cache`)",
  verify: "Dual verification (`verify`)",
  council: "Council mode (`council`)",
  plugins: "Plugins (`plugins`)",
  route: "Saved routes (`route`)",
  debug: "Debug output (`debug`)",
};
const NON_CORE_MODEL_PREFIXES: [string, string][] = [["@route/", "Saved routes"], ["@preset/", "Presets"], ["@character/", "Characters"], ["trellis/council", "Council mode"]];
/** `provider` preference keys core accepts: routing order and filters, the lane and the disclosure ceiling. */
const CORE_PROVIDER_PREFS = new Set(["order", "only", "ignore", "allow_fallbacks", "sort", "quantizations", "data_collection", "require_parameters", "max_price", "zdr", "private", "lane", "disclosure", "lane_downgrade", "preferred_min_throughput", "preferred_max_latency"]);

type KeyLike = { guardrails?: unknown; payWithDefault?: unknown; routing?: unknown; tracing?: unknown; topup?: unknown; scope?: unknown; teamId?: unknown } | null | undefined;

/**
 * Called by the core inference handlers (chat, completions, embeddings) right after the body is parsed and the key is
 * resolved. Does nothing outside core.
 */
export function enforceCoreRequest(ctx: Ctx, body: Record<string, unknown>, key: KeyLike): void {
  enforceCoreBody(ctx, body);
  enforceCoreKey(ctx, key);
}

/**
 * Security review R5-10: the top-level body fields a core inference request may carry. Every other field used to be
 * forwarded to the provider as it came, and a provider that prices by one (a service tier, predicted output, a
 * provider-side tool) billed the operator for something no hold covered. An unknown field is refused, not dropped: a
 * caller who sent it meant something by it.
 */
const CORE_BODY_FIELDS: ReadonlySet<string> = new Set([
  "model", "models", "provider", "messages", "prompt", "input", "stream", "stream_options", "usage", "user",
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "n", "best_of", "stop", "seed",
  "presence_penalty", "frequency_penalty", "repetition_penalty", "logit_bias", "logprobs", "top_logprobs",
  "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call", "response_format", "structured_outputs",
  "reasoning", "reasoning_effort", "include_reasoning", "verbosity", "suffix", "echo", "dimensions", "encoding_format",
  // Other names for an output limit: each is overwritten with (or lowered to) the cap that was held (providers/upstream.ts).
  "max_new_tokens", "max_output_tokens", "max_gen_tokens", "num_predict", "max_length", "min_tokens", "min_new_tokens", "min_completion_tokens", "min_length",
]);

/** The body half: called before the request is validated or anything about it is looked up. */
export function enforceCoreBody(ctx: Ctx, body: Record<string, unknown>): void {
  if (!ctx.surface?.core) return;
  for (const [field, what] of Object.entries(NON_CORE_BODY_FIELDS)) if (body[field] !== undefined && body[field] !== null) notEnabled(what);
  for (const k of Object.keys(body)) if (!CORE_BODY_FIELDS.has(k) && body[k] !== undefined && body[k] !== null) throw new ApiError(400, `The parameter \`${k.slice(0, 40)}\` is not accepted by this router: only parameters it knows how to bound and price are forwarded to a provider.`, "unsupported_parameter", { parameter: k.slice(0, 40) });
  const models = [body.model, ...(Array.isArray(body.models) ? body.models : [])];
  for (const m of models) {
    if (typeof m !== "string") continue;
    if (m.length > 256) throw new ApiError(400, "A model id is at most 256 characters.", "invalid_request");
    for (const [prefix, what] of NON_CORE_MODEL_PREFIXES) if (m.startsWith(prefix)) notEnabled(what);
  }
  const provider = body.provider;
  if (provider && typeof provider === "object" && !Array.isArray(provider))
    for (const k of Object.keys(provider)) if (!CORE_PROVIDER_PREFS.has(k)) notEnabled(`The provider preference \`${k.slice(0, 40)}\``);
}

/**
 * The key half. A key that carries a non-core setting (written while the router ran the full surface) is not served as
 * if it did not: its owner asked for behaviour this router no longer provides. Refusing is the safer of the two.
 */
export function enforceCoreKey(ctx: Ctx, key: KeyLike): void {
  if (!ctx.surface?.core) return;
  if (key) {
    if (key.guardrails) notEnabled("This key's guardrails");
    if (key.payWithDefault) notEnabled("This key's pay-with default");
    if (key.routing) notEnabled("This key's routing presets");
    if (key.tracing) notEnabled("This key's trace export");
  }
}

/** Fields of a key spec (POST /api/v1/keys, PATCH /api/v1/keys/:hash) that core accepts: the name, limits and revocation. */
const CORE_KEY_FIELDS = new Set(["name", "limit", "budget_usd", "limit_reset", "rpm", "tpm", "allowed_models", "disabled", "expires_at", "management"]);

/** Refuse a key spec that sets anything beyond a name and limits. Does nothing outside core. */
export function enforceCoreKeySpec(ctx: Ctx, raw: Record<string, unknown>): void {
  if (!ctx.surface?.core) return;
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && !CORE_KEY_FIELDS.has(k)) notEnabled(`The key setting \`${k.slice(0, 40)}\``);
}

export const isNotEnabled = (c: Context, e: unknown) => e instanceof ApiError && e.type === NOT_ENABLED && !!c;
