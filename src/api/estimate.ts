import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { outputModalities } from "../catalog/catalog.ts";
import { maxPico, picoToUsdString, priceString, type Pico } from "../lib/money.ts";
import { estimatePromptTokens } from "../router/estimate.ts";
import { contextTokens } from "../router/hold-config.ts";
import { maxOutputTokens, priceUsage, worstCase, type Fees, type Mode, type Usage } from "../router/pricing.ts";
import { blendedPrice } from "../router/select.ts";
import { fundedOffers } from "../rush/availability.ts";
import { servable } from "./models.ts";
import { readJson } from "./common.ts";

// Update 13, Price check (src/features.json `estimate`): price a prompt on every model before calling. For each text
// model the router lists, what this request would cost at the listed price (an estimate: about one token per four
// characters of the prompt, plus the output you allow), and what the router would HOLD on a balance for it while it
// runs: the same bound the chat route reserves (the prompt's bytes and the output cap, src/router/pricing.ts
// worstCase) over the offers that may serve the model. Plus whether the request fits the model's context window and
// output limit. Sorted cheapest first.
//
// Public, like the catalogue it reads: no key, nothing written, nothing logged. The prompt is read from the body only,
// counted, and dropped with the request. The anonymous rate limit and the body-size caps apply (src/hardening).

export const ESTIMATE_LIMITS = Object.freeze({ promptChars: 400_000, systemChars: 100_000, maxTokens: 1_000_000, models: 50, rows: 200 });

const body = z
  .object({
    prompt: z.string().min(1, "prompt must not be empty.").max(ESTIMATE_LIMITS.promptChars, `prompt: at most ${ESTIMATE_LIMITS.promptChars.toLocaleString("en-US")} characters.`),
    system: z.string().max(ESTIMATE_LIMITS.systemChars, `system: at most ${ESTIMATE_LIMITS.systemChars.toLocaleString("en-US")} characters.`).optional(),
    max_tokens: z.number().int().min(1).max(ESTIMATE_LIMITS.maxTokens),
    models: z.array(z.string().min(1).max(200)).min(1).max(ESTIMATE_LIMITS.models).optional(),
    pay: z.enum(["balance", "per_call"]).default("balance"),
    limit: z.number().int().min(1).max(ESTIMATE_LIMITS.rows).default(50),
  })
  .strict();
export type EstimateBody = z.input<typeof body>;

/** The same rough count the site's chat and cost pages use: one token per four characters. */
export const roughTokens = (text: string) => Math.ceil(text.length / 4);

const live = (o: Candidate) => o.status === "live" && o.provider.status === "live";
/** The offer whose price the catalogue lists for a model (GET /api/v1/models `pricing`): the cheapest paid one. */
function listedOffer(offers: Candidate[]) {
  const paid = offers.filter((o) => o.pricePrompt > 0n || o.priceCompletion > 0n);
  return [...(paid.length ? paid : offers)].sort((a, b) => blendedPrice(a) - blendedPrice(b))[0];
}

type Row = {
  model: string;
  name: string;
  input_tokens: number;
  output_tokens: number;
  estimate_usd: string;
  hold_usd: string;
  pricing: { prompt: string; completion: string; request: string };
  context_length: number;
  max_completion_tokens: number | null;
  fits: boolean;
  problem: "context" | "output" | null;
  cost: Pico;
};

export function priceCheck(ctx: Ctx, input: z.output<typeof body>) {
  const messages = [...(input.system ? [{ role: "system", content: input.system }] : []), { role: "user", content: input.prompt }];
  const request: Record<string, unknown> = { messages, max_tokens: input.max_tokens };
  // The prompt bound the router holds against (lenient: plain text has no item to refuse).
  const bound = estimatePromptTokens(request, { settings: ctx.cfg.holds.bound, lenient: true });
  const rough = roughTokens(input.prompt) + (input.system ? roughTokens(input.system) : 0);
  const mode: Mode = input.pay === "per_call" ? "per_call" : "prepaid";
  const wanted = input.models ? new Set(input.models) : null;
  const rows: Row[] = [];
  const missing: string[] = [];
  for (const m of ctx.catalog.models.values() as Iterable<ModelRow>) {
    if (m.hidden || (wanted && !wanted.has(m.id))) continue;
    if (!outputModalities(m).includes("text")) continue;
    const offers = fundedOffers(ctx, servable(ctx, m).filter(live));
    if (!offers.length) continue;
    const ref = listedOffer(offers);
    const fees: Fees = { royaltyBps: m.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
    const window = ref.ctx ?? m.ctx;
    const outLimit = ref.maxOut ?? m.maxOut ?? null;
    const used = contextTokens(bound, ctx.cfg.holds);
    const problem = used >= window ? "context" : outLimit != null && input.max_tokens > outLimit ? "output" : null;
    const output = maxOutputTokens(request, ref, m, bound, ctx.cfg.holds);
    const usage: Usage = { prompt: rough, completion: output, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true };
    const cost = priceUsage(ref, m, usage, mode, fees, false).total;
    const hold = maxPico(...offers.map((o) => worstCase(o, m, request, bound, mode, { ...fees, royaltyBps: 0 }, false, { cfg: ctx.cfg.holds })));
    rows.push({
      model: m.id,
      name: m.name,
      input_tokens: rough,
      output_tokens: output,
      estimate_usd: picoToUsdString(cost),
      hold_usd: picoToUsdString(hold),
      pricing: { prompt: priceString(ref.pricePrompt), completion: priceString(ref.priceCompletion), request: priceString(ref.priceRequest) },
      context_length: window,
      max_completion_tokens: outLimit,
      fits: problem === null,
      problem,
      cost,
    });
  }
  if (wanted) for (const id of wanted) if (!rows.some((r) => r.model === id)) missing.push(id);
  // Cheapest first; a request that does not fit goes after every one that does.
  rows.sort((a, b) => Number(b.fits) - Number(a.fits) || (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.model.localeCompare(b.model)));
  return {
    data: rows.slice(0, input.limit).map(({ cost: _, ...row }) => row),
    count: rows.length,
    input_tokens: rough,
    input_bound_tokens: bound,
    max_tokens: input.max_tokens,
    pay: input.pay,
    ...(missing.length ? { not_listed: missing } : {}),
    as_of: new Date().toISOString(),
  };
}

export function estimateRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/estimate", async (c) => {
    c.header("cache-control", "no-store");
    const input = body.parse(await readJson(c));
    await ctx.catalog.ensureFresh();
    return c.json(priceCheck(ctx, input));
  });
}
