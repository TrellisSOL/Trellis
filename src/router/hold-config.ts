import { z } from "zod";
import { DEFAULT_BOUND, type BoundSettings } from "./estimate.ts";

// Settings of the hold bound (security review R3-02 / R3-25). Kept apart from src/config.ts, which reads this fragment
// through loadHoldConfig. Every default is the safe one; none of these settings can make a hold smaller than the bound.

export const holdEnv = {
  /** Template allowance, in tokens: once per request, per message (or prompt, or embedding input), and when tools are present. */
  HOLD_TEMPLATE_TOKENS_PER_REQUEST: z.coerce.number().int().min(0).max(100_000).default(DEFAULT_BOUND.perRequestTokens),
  HOLD_TEMPLATE_TOKENS_PER_MESSAGE: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_BOUND.perMessageTokens),
  HOLD_TEMPLATE_TOKENS_TOOLS: z.coerce.number().int().min(0).max(100_000).default(DEFAULT_BOUND.toolsTokens),
  /** The most prompts one /completions request may batch; each is its own completion and is held and priced as one. */
  HOLD_MAX_PROMPT_BATCH: z.coerce.number().int().min(1).max(256).default(DEFAULT_BOUND.maxPromptBatch),
  /** The output cap sent upstream for a model whose catalog entry declares no output limit. */
  HOLD_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(1_000_000).default(16_384),
  /**
   * Admission checks only (does the prompt fit a model's context window; the per-key tokens-per-minute limit): how
   * many bytes of the prompt bound count as one token there. Default 3, the ratio the router has always used for these
   * two checks; every input shape now goes through the bound first, so neither can be bypassed with an array prompt.
   * It never lowers a hold: a hold is always priced at the bound itself (capped at the context window, which a
   * provider cannot exceed). 1 checks the bound itself, at the price of refusing most prompts that would fit: ordinary
   * text is three to four bytes a token, so a 131k-token model would take 131 kB.
   */
  HOLD_CONTEXT_BYTES_PER_TOKEN: z.coerce.number().min(1).max(8).default(3),
  /** How long the hold_exceeded readiness warning stays up after the last time a provider reported more than was held. */
  HOLD_EXCEEDED_ALERT_WINDOW_S: z.coerce.number().int().min(60).max(30 * 86_400).default(86_400),
  /** The longest a hold is kept alive by its request's heartbeat, whatever the request does. */
  HOLD_MAX_LIFETIME_MS: z.coerce.number().int().min(60_000).max(24 * 3_600_000).default(2 * 3_600_000),
};

export type HoldConfig = {
  bound: BoundSettings;
  defaultMaxOutputTokens: number;
  contextBytesPerToken: number;
  exceededAlertWindowMs: number;
  maxLifetimeMs: number;
};

export const DEFAULT_HOLD_CONFIG: HoldConfig = { bound: DEFAULT_BOUND, defaultMaxOutputTokens: 16_384, contextBytesPerToken: 3, exceededAlertWindowMs: 86_400_000, maxLifetimeMs: 2 * 3_600_000 };

const schema = z.object(holdEnv);

/** Settings from process.env with `overrides` on top, as src/config.ts does for everything else. */
export function loadHoldConfig(overrides: Record<string, unknown> = {}): HoldConfig {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) throw new Error(`Invalid hold configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  return {
    bound: { perRequestTokens: e.HOLD_TEMPLATE_TOKENS_PER_REQUEST, perMessageTokens: e.HOLD_TEMPLATE_TOKENS_PER_MESSAGE, toolsTokens: e.HOLD_TEMPLATE_TOKENS_TOOLS, maxPromptBatch: e.HOLD_MAX_PROMPT_BATCH },
    defaultMaxOutputTokens: e.HOLD_DEFAULT_MAX_OUTPUT_TOKENS,
    contextBytesPerToken: e.HOLD_CONTEXT_BYTES_PER_TOKEN,
    exceededAlertWindowMs: e.HOLD_EXCEEDED_ALERT_WINDOW_S * 1000,
    maxLifetimeMs: e.HOLD_MAX_LIFETIME_MS,
  };
}

/** Prompt tokens for the admission checks (context fit, tokens per minute): the bound scaled by HOLD_CONTEXT_BYTES_PER_TOKEN. */
export const contextTokens = (bound: number, cfg: Pick<HoldConfig, "contextBytesPerToken"> = DEFAULT_HOLD_CONFIG) => Math.ceil(bound / Math.max(1, cfg.contextBytesPerToken));

/** Time allowed for what follows the provider's answer before the hold is settled: an attested gateway's receipt fetch and its retries. */
const AFTER_ANSWER_MS = 60_000;

/**
 * How long a hold must live for one routed call (security review R3-25): every attempt may run for the provider's OWN
 * timeout (providers.timeout_ms) where it has one, after waiting for a sealed-lane slot; there is one retry pass; and
 * the receipt fetch follows. The request's heartbeat (ledger keepHoldAlive) extends it further while the call is alive.
 */
export function holdTtlMs(o: { providerTimeoutMs: number; maxAttempts: number; queueWaitMs?: number; candidates: Iterable<{ provider?: { timeoutMs?: number | null } | null }>; calls?: number }): number {
  let perAttempt = o.providerTimeoutMs;
  for (const c of o.candidates) perAttempt = Math.max(perAttempt, c.provider?.timeoutMs ?? 0);
  return (perAttempt + (o.queueWaitMs ?? 0)) * (o.maxAttempts + 1) * Math.max(1, o.calls ?? 1) + AFTER_ANSWER_MS;
}
