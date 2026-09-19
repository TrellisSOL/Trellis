import { addSuggestions, availabilityFailure, selectWithSuggestions } from "../model-alternatives/suggest.ts"; // B121
import { refuseCreditExhaustion, refuseCreditOutage } from "../rush/errors.ts"; // ON3
import { noteFailedPaidCall, noteServedCall } from "../services/makegood.ts"; // V6 R
import { guardInferenceModels } from "../provisioning/inference.ts"; // ZK6
import { explainedStream, rememberRoutePlan, routeReceiptFields, routeResponseHeaders } from "../router/explain.ts"; // V84
import { captureStructuredOutput } from "../structured-output/chat.ts"; // V83
import { linkNetworkReceipt } from "../network/receipt-link.ts";
import { agentReservation, enforceAgentCached } from "../agents/enforce.ts";
import { blindReceipt } from "../blind/set.ts";
import type { Context, Hono } from "hono";
import { enforceCoreBody, enforceCoreKey } from "../surface/request.ts";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { apps, byokKeys, generations, savedRoutes } from "../db/schema.ts";
import { applyBushelAllowance, bushelAllowanceFor } from "../capacity/bushels.ts"; // §5.6: prepaid capacity at billing time
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { ApiError, fail, isApiError } from "../lib/errors.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { canonical, canonicalJson, decrypt, genId, log, sha256 } from "../lib/util.ts";
import { keepHoldAlive, reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { isRestricted } from "../router/lane.ts";
import { disclosureClass, disclosureRefusal, profileOf, type DisclosureClass, type DisclosureRequest } from "../router/disclosure.ts";
import { servedDisclosure, servedPolicyHash } from "./disclosure.ts";
import { answerBytesBound, answerLimitOf, answerReadCap, hasUsage, orderedUsage } from "../router/pricing.ts";
import { analyzePrompt, batchHold, batchPrice, boundWith, capWithinBudget, itemKindsOf, itemLimitsOf, maxItemLimits, maxOutputTokens, priceUsage, refuseUnboundable, unmeteredUsage, usageOrBound, utf8Bound, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import type { ItemKind } from "../router/estimate.ts";
import { contextTokens, holdTtlMs } from "../router/hold-config.ts";
import { noteHoldExceeded, payableWithin } from "../services/hold-watch.ts";
import { batchKey, batchLineOf } from "../router/batch-line.ts";
import { route, type Attempt, type Billable, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import { noteEstimatedSettlement, noteUnrecordedCall, noteVerifiedReceipt, noteWithheldAnswer } from "../services/billing-watch.ts";
import { admitInference, noteCutOff, type Admitted } from "./admission.ts";
import { keepPaidAnswer, recoveryRequestHash } from "../solana/recovery.ts";
import { providerKey } from "../providers/upstream.ts";
import { compactUpstream, recordGpuAttested, unverifiedUpstream, verifyAciExchange, type UpstreamAttestation } from "../providers/aci.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { decisionTagFields, decisionTagOf } from "../receipts/decision-tag.ts"; // B: X-Trellis-Decision-Tag
import { buildClaimsV2, chainComment, ChunkChain, COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { middleOut } from "../gateway/transforms.ts";
import type { CacheMode } from "../gateway/cache.ts";
import { bearer, requireRole, resolveKey, walletAuth, type KeyRow } from "./auth.ts";
import { addressBucket, generationHeaders, readJson, sharedPolicyHash } from "./common.ts";
import { grantFor, recordDebt, type PaywithGrant } from "../solana/paywith.ts";
import { resolveSavedRoute } from "../routing/saved-routes.ts";
import { resolvePreset } from "../routing/presets.ts";
import { applyRouteDefault } from "../routing/route-default.ts"; // U101
import { recordCharacterUse, resolveCharacter, type CharacterMeta } from "../characters/registry.ts";
import { networkFeeLine, payPerCall, type NetworkFee } from "../solana/percall.ts";
import { paymentHeaderOf, x402ResponseHeaders } from "../solana/x402.ts";
import { holderTier, scaleLimit, walletOfAccount } from "../solana/tiers.ts";
import { gateEarlyAccess } from "../holders/early-access.ts";
import { sealedAdmission } from "../holders/sealed-queue.ts";
import { hasTabHeaders, recordTabUsage, resolveTab, tabAccountId, tabCreditLine, type TabBilling } from "../solana/tab-billing.ts";
import { usdcToPico } from "../lib/money.ts";
import type { HolderTier } from "../config.ts";
import { COUNCIL_MODEL, applyDualDecoding, runCouncil, runDual, validateMulti } from "./council.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { requestLane } from "../ohttp/lane.ts";
import { blockReasonForStatus, isPrivateLaneRequest, noteLane, recordPrivateLane } from "../services/private-stats.ts";
import { parseTraceparent, shouldExportTrace } from "../services/tracing.ts";
import { BLIND_POOL, claimToken, confirmToken, isBlindRequest, presentBlindToken, redemptionSummary, requireValue, unclaimToken, type BlindPass } from "../blind/redeem.ts";
import { noteSealedGeneration } from "../services/shadow.ts";

export type Kind = "chat" | "completion";
export type Billing =
  | { mode: "prepaid"; accountId: string; key: KeyRow }
  | { mode: "paywith"; accountId: string; key: KeyRow; grant: PaywithGrant }
  | { mode: "per_call"; accountId: string; payer: string; paymentTx?: string; paymentResponse?: string; /** The network fee kept back from the payment (percall.ts): its own line on the receipt. */ networkFee?: NetworkFee; key?: undefined }
  // A trellis_tab (docs §5.2): the tab's escrow is the balance, mirrored as the internal account tab_<pda>; a key, when sent, keeps its limits and budget.
  | { mode: "tab"; accountId: string; tab: TabBilling; key?: KeyRow }
  // A Privacy Pass token, charged to the pooled internal account: no key, no wallet, no buyer. `hold` is set once known.
  | { mode: "blind"; accountId: string; pass: BlindPass; hold: Pico; key?: undefined };

const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
// Parameters that change what a provider must be able to do; never silently dropped.
const SEMANTIC_PARAMS = ["tools", "tool_choice", "response_format", "structured_outputs", "reasoning", "include_reasoning", "logprobs", "top_logprobs", "seed", "max_tokens", "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "top_k", "repetition_penalty", "min_p", "logit_bias", "parallel_tool_calls"];
const MUST_SUPPORT = ["tools", "response_format"];

function validate(kind: Kind, body: Record<string, unknown>) {
  if (kind === "chat") {
    if (!Array.isArray(body.messages) || body.messages.length === 0) fail(400, "`messages` must be a non-empty array.", "invalid_request");
    for (const m of body.messages as any[]) {
      if (!m || typeof m !== "object" || !ROLES.has(m.role)) fail(400, `Invalid message role: ${JSON.stringify(m?.role)}.`, "invalid_request");
      if (m.content != null && typeof m.content !== "string" && !Array.isArray(m.content)) fail(400, "Message content must be a string or an array of parts.", "invalid_request");
    }
  } else if (typeof body.prompt !== "string" && !Array.isArray(body.prompt)) fail(400, "`prompt` must be a string.", "invalid_request");
  if (body.model != null && typeof body.model !== "string") fail(400, "`model` must be a string.", "invalid_request");
  if (body.models != null && (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string"))) fail(400, "`models` must be an array of model ids.", "invalid_request");
  if (body.provider != null && (typeof body.provider !== "object" || Array.isArray(body.provider))) fail(400, "`provider` must be an object.", "invalid_request");
  for (const k of ["max_tokens", "max_completion_tokens"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1)) fail(400, `\`${k}\` must be a positive integer.`, "invalid_request");
  for (const k of ["n", "best_of"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1 || (body[k] as number) > 16)) fail(400, `\`${k}\` must be an integer from 1 to 16.`, "invalid_request");
  // logprobs / top_logprobs annotate the tokens that are generated anyway: they change no token count, so they add
  // nothing to a hold. They are still bounded here (a provider's answer grows with them): 0 to 20, as OpenAI has it.
  if (body.top_logprobs != null && (!Number.isInteger(body.top_logprobs) || (body.top_logprobs as number) < 0 || (body.top_logprobs as number) > 20)) fail(400, "`top_logprobs` must be an integer from 0 to 20.", "invalid_request");
  if (typeof body.logprobs === "number" && (!Number.isInteger(body.logprobs) || body.logprobs < 0 || body.logprobs > 20)) fail(400, "`logprobs` must be a boolean, or an integer from 0 to 20.", "invalid_request");
}

/**
 * Drop the providers that cannot bound a request's non-text input (no per-item token figure in their catalog entry for
 * a kind the request carries); a request no remaining provider can bound is refused (400 unboundable_input).
 */
function boundableTargets(targets: RouteTarget[], kinds: ItemKind[], excluded: { model: string; provider: string; reason: string }[]): RouteTarget[] {
  if (!kinds.length) return targets;
  const out: RouteTarget[] = [];
  for (const t of targets) {
    const ordered = t.ordered.filter((cand) => {
      const limits = itemLimitsOf(cand);
      const ok = kinds.every((k) => limits[k]);
      if (!ok) excluded.push({ model: t.model.id, provider: cand.providerId, reason: `declares no per-item token limit for ${kinds.filter((k) => !limits[k]).join(", ")} input` });
      return ok;
    });
    if (ordered.length) out.push({ model: t.model, ordered });
  }
  if (!out.length) refuseUnboundable(kinds, targets[0]?.model.id);
  return out;
}

/**
 * Security review R5-01: drop the providers whose answer to this request could be larger than the router reads from
 * them (router/pricing.ts answerBytesBound: completions x output cap, with `logprobs` alternatives); a request no
 * remaining provider can answer within that is refused (400 response_too_large) before anything is held or sent. An
 * answer the router cannot read to its end is billed by the provider all the same, so it must not be orderable.
 */
function answerSizedTargets(ctx: Ctx, targets: RouteTarget[], body: Record<string, unknown>, promptTokens: number, excluded: { model: string; provider: string; reason: string }[]): RouteTarget[] {
  const out: RouteTarget[] = [];
  let smallest = Infinity;
  for (const t of targets) {
    const ordered = t.ordered.filter((cand) => {
      const bound = answerBytesBound(body, maxOutputTokens(body, cand, t.model, promptTokens, ctx.cfg.holds));
      const ok = bound <= answerLimitOf(cand);
      if (!ok) {
        smallest = Math.min(smallest, bound);
        excluded.push({ model: t.model.id, provider: cand.providerId, reason: "the answer this request orders could be larger than the router reads from this provider" });
      }
      return ok;
    });
    if (ordered.length) out.push({ model: t.model, ordered });
  }
  // Nothing dropped: the same list, so the route plan remembered for it (router/explain.ts keys on identity) still applies.
  if (smallest === Infinity) return targets;
  if (!out.length)
    fail(400, "The answer this request orders could be larger than the router reads from a provider (completions x output tokens, times the log-probability alternatives asked for). Lower `max_tokens`, `n` or `top_logprobs`.", "response_too_large", { answer_bytes_bound: smallest, max_bytes: Math.max(...targets.flatMap((t) => t.ordered.map(answerLimitOf))) });
  return out;
}

/** How long a routed call's hold must live: see holdTtlMs (router/hold-config.ts). The request's heartbeat extends it. */
const holdLifetime = (ctx: Ctx, targets: RouteTarget[], lane: string, calls = 1) =>
  holdTtlMs({ providerTimeoutMs: ctx.cfg.routing.providerTimeoutMs, maxAttempts: ctx.cfg.routing.maxAttempts, queueWaitMs: lane === "attested" ? ctx.cfg.holders.sealed.queueMaxWaitMs : 0, candidates: targets.flatMap((t) => t.ordered), calls });

function validateCacheTtl(body: Record<string, unknown>, maxTtlS: number) {
  if (body.cache == null) return;
  if (typeof body.cache !== "object" || Array.isArray(body.cache)) fail(400, "`cache` must be an object.", "invalid_request");
  const cache = body.cache as Record<string, unknown>;
  if (!Object.hasOwn(cache, "ttl")) return;
  const ttl = cache.ttl;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 1)
    fail(400, "`cache.ttl` must be a positive integer number of seconds.", "invalid_request");
  if (ttl > maxTtlS) fail(400, `\`cache.ttl\` cannot exceed the configured maximum of ${maxTtlS} seconds.`, "invalid_request");
}

function requestParams(body: Record<string, unknown>) {
  return SEMANTIC_PARAMS.filter((p) => body[p] !== undefined && body[p] !== null && !(Array.isArray(body[p]) && (body[p] as unknown[]).length === 0));
}

/** Body hash that binds a 402 quote to one request (stream flags excluded). */
export function requestHash(body: Record<string, unknown>) {
  const { stream: _s, stream_options: _so, ...rest } = body;
  return sha256(canonicalJson(rest));
}

async function limitOrThrow(ctx: Ctx, key: string, amount: number, limit: number, what: string) {
  const r = await ctx.limiter.take(key, amount, limit, 60_000);
  if (!r.ok)
    fail(429, `Rate limit exceeded (${limit} ${what}/min). Retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
}

async function byokFor(ctx: Ctx, accountId: string | undefined) {
  const map = new Map<string, string>();
  if (!accountId) return map;
  const rows = await ctx.db.select().from(byokKeys).where(eq(byokKeys.accountId, accountId));
  for (const r of rows) {
    try {
      map.set(r.providerId, decrypt(ctx.cfg.appSecret, r.keyEnc));
    } catch {
      log.warn("undecryptable BYOK key", { provider: r.providerId });
    }
  }
  return map;
}

/** The ledger credit line a billing mode may draw on: a pay-with grant, or a tab's unvouched allowance (seller exposure). */
export const creditLineOf = (b: Billing): Pico => (b.mode === "paywith" ? b.grant.creditLine : b.mode === "tab" ? usdcToPico(b.tab.maxUnvouched) : 0n);

/**
 * Who pays: a tab (X-Trellis-Tab + voucher, docs §5.2; with or without a key), the key's prepaid balance, a Stock Token
 * pay-with grant, or (no key) a wallet / per-call payment.
 */
async function resolveBilling(ctx: Ctx, c: Context, key: KeyRow | null, wallet: { accountId: string; wallet: string } | null, pass: BlindPass | null): Promise<{ billing: Billing | null; paywithNote?: string }> {
  const paySymbol = c.req.header("x-pay-with") ?? (key?.payWithDefault || undefined);
  let billing: Billing | null = null;
  let paywithNote: string | undefined;
  if (hasTabHeaders(c) && !pass) {
    const tab = await resolveTab(ctx, c);
    billing = { mode: "tab", accountId: tabAccountId(tab.pda), tab, ...(key ? { key } : {}) };
  } else if (key) {
    billing = { mode: "prepaid", accountId: key.accountId, key };
    if (paySymbol) {
      const { grant, reason } = await grantFor(ctx, key, paySymbol);
      if (grant) billing = { mode: "paywith", accountId: key.accountId, key, grant };
      else paywithNote = reason; // falls back to prepaid USDC (then 402 if empty)
    }
  } else if (pass) {
    billing = { mode: "blind", accountId: BLIND_POOL, pass, hold: 0n };
  } else if (wallet) {
    billing = { mode: "per_call", accountId: wallet.accountId, payer: wallet.wallet };
  }
  return { billing, paywithNote };
}

/**
 * Providers able to serve each resolved model under the caller's routing preferences, in routing order.
 * Shared by single calls, council members and the judge, and dual-verification legs, so all of them honour a
 * disclosure ceiling or lane the same way: a request whose ceiling leaves no provider is refused (409, or 503
 * while compliant providers are down) and is never routed to one that does not meet it.
 */
function selectTargets(
  ctx: Ctx,
  o: {
    resolved: { model: ModelRow; modifiers: Set<Modifier> }[]; prefs: ProviderPrefs; params: string[]; promptTokens: number; byok: Map<string, string>; disc: DisclosureRequest;
    /** Per model id: the providers that honour the key's prepaid capacity (§5.6). They go first unless the caller pinned an order. */
    prefer?: Map<string, string[]>;
  },
) {
  const { resolved, prefs, params, promptTokens, byok, disc } = o;
  const strict = disc.max !== "any";
  const targets: RouteTarget[] = [];
  const excluded: { model: string; provider: string; reason: string }[] = [];
  const plan = (r: (typeof resolved)[number], callerPrefs: ProviderPrefs) => {
    // Prepaid capacity is honoured by the committed host(s): they are tried first, like a pinned order, and every other
    // eligible provider stays a fallback. A caller's own `provider.order` always wins.
    const honouring = !callerPrefs.order?.length ? o.prefer?.get(r.model.id) : undefined;
    const p: ProviderPrefs = honouring?.length ? { ...callerPrefs, order: honouring } : callerPrefs;
    const sel = selectProviders({
      modelId: r.model.id,
      offers: ctx.catalog.offers(r.model.id),
      prefs: p,
      modifiers: r.modifiers,
      requestParams: params,
      estimatedTokens: promptTokens,
      byokProviders: new Set(byok.keys()),
      health: ctx.health,
      production: ctx.cfg.production,
      attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
      disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
      modelLane: ctx.catalog.laneOf(r.model),
      attestedBonus: ctx.cfg.routing.attestedBonus,
      rand: ctx.rand,
    });
    // Tools / structured output must be supported by whoever serves the request.
    const must = MUST_SUPPORT.filter((q) => params.includes(q));
    const notes: { model: string; provider: string; reason: string }[] = [];
    let ordered = sel.ordered.filter((cand) => {
      const sp = cand.supportedParameters ?? [];
      const ok = !must.length || !sp.length || must.every((q) => sp.includes(q));
      if (!ok) notes.push({ model: r.model.id, provider: cand.providerId, reason: `does not support ${must.join("/")}` });
      return ok;
    });
    // BYOK providers go first unless the caller pinned an order (hosts honouring prepaid capacity stay ahead of them:
    // the allowance is already paid for and lapses with its window).
    if (honouring?.length && byok.size) ordered = [...ordered.filter((x) => honouring.includes(x.providerId)), ...ordered.filter((x) => !honouring.includes(x.providerId) && byok.has(x.providerId)), ...ordered.filter((x) => !honouring.includes(x.providerId) && !byok.has(x.providerId))];
    else if (!p.order?.length && byok.size) ordered = [...ordered.filter((x) => byok.has(x.providerId)), ...ordered.filter((x) => !byok.has(x.providerId))];
    for (const e of sel.excluded) notes.push({ model: r.model.id, ...e });
    rememberRoutePlan(ctx.cfg.routeExplain, sel, ordered, notes, p, r.modifiers, params, byok); // V84
    return { ordered, notes };
  };
  for (const r of resolved) {
    const { ordered, notes } = plan(r, prefs);
    excluded.push(...notes);
    if (ordered.length) targets.push({ model: r.model, ordered });
  }
  if (!targets.length && strict) {
    // Would anything have matched without the disclosure ceiling? Then the ceiling is what blocked this request:
    // say so (409, or 503 when compliant providers exist but are down), and never fall back to one that does not meet it.
    const { disclosure: _d, lane: _l, ...relaxed } = prefs;
    const refusal = disclosureRefusal(disc, resolved.map((r) => r.model.id), excluded, () => resolved.some((r) => plan(r, relaxed).ordered.length > 0));
    if (refusal) throw refusal;
  }
  if (!targets.length) refuseCreditOutage(ctx.cfg.rush.enabled, excluded); // ON3
  return { targets, excluded };
}

/**
 * Prepaid capacity (§5.6): for a prepaid key with a redeemed allowance on a requested model's grade, the providers that
 * honour it, per model id. Empty when prepaid capacity is off, the call is not billed to a key's prepaid balance, or the
 * caller pinned `provider.order`. A failed lookup never fails the request: routing then proceeds without the preference.
 */
async function bushelPreference(ctx: Ctx, billing: Billing | null | undefined, prefs: ProviderPrefs, resolved: { model: ModelRow }[]): Promise<Map<string, string[]> | undefined> {
  if (!ctx.cfg.bushels.enabled || billing?.mode !== "prepaid" || prefs.order?.length) return undefined;
  const prefer = new Map<string, string[]>();
  try {
    for (const r of resolved) {
      if (prefer.has(r.model.id)) continue;
      const allowance = await bushelAllowanceFor(ctx, billing.key.keyHash, r.model.id);
      if (allowance?.providers.length) prefer.set(r.model.id, allowance.providers);
    }
  } catch (e) {
    log.warn("prepaid capacity lookup failed; routing without it", { error: (e as Error).message.slice(0, 160) });
    return undefined;
  }
  return prefer.size ? prefer : undefined;
}

/** Undo a hold whose request was not served. A blind token is given back with it, so a failed request does not cost the token. */
async function giveBack(ctx: Ctx, billing: Billing, holdId: string) {
  await release(ctx.db, holdId);
  if (billing.mode === "blind") await unclaimToken(ctx, billing.pass);
}

/** `trace_id` for a receipt when the request carried a well-formed W3C traceparent. */
const traceIdField = (traceparent: string | undefined): { trace_id?: string } => {
  const id = parseTraceparent(traceparent)?.traceId;
  return id && /^[0-9a-f]{32}$/.test(id) && !/^0{32}$/.test(id) ? { trace_id: id } : {};
};

/** x402: the settlement receipt rides on the served response. */
const paymentHeaders = (b: Billing): Record<string, string> => (b.mode === "per_call" && b.paymentResponse ? x402ResponseHeaders(b.paymentResponse) : {});

function chunkBase(id: string, created: number, model: ModelRow, provider: string, kind: Kind) {
  return { id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion", created, model: model.id, provider };
}

/**
 * One chat or completion call. A refused private-lane request is counted (noisily, see services/private-stats.ts) under the
 * reason it was refused. `characterId` forces a character (POST /api/v1/characters/:id/chat, src/api/characters.ts).
 */
export async function runChat(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  // R5-04: a slot per key (or source address), taken before the body is read. A streamed answer keeps it until the
  // stream ends (streamResponse marks it deferred and gives it back); everything else gives it back here.
  const admission = await admitInference(ctx, c);
  admissions.set(c.req.raw, admission);
  try {
    return await handle(ctx, c, kind, characterId);
  } catch (e) {
    if (isPrivateLaneRequest(c.req.raw)) recordPrivateLane(ctx, c.req.raw, { blocked: isApiError(e) ? blockReasonForStatus(e.status, e.type) : "upstream_error", latencyMs: Date.now() - t0 });
    throw e;
  } finally {
    if (!admission.deferred) admission.release();
  }
}
/** The admission (in-flight slot, caller id) of a request in this handler, by its Request object. */
const admissions = new WeakMap<Request, Admitted>();

export function chatRoutes(app: Hono, ctx: Ctx) {
  const run = (c: Context, kind: Kind) => runChat(ctx, c, kind);
  app.post("/api/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/api/v1/completions", (c) => run(c, "completion"));
  // OpenAI-SDK style base URLs (…/api/v1) already covered; also accept /v1/* for convenience.
  app.post("/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/v1/completions", (c) => run(c, "completion"));
}

async function handle(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  const body = await readJson(c);
  enforceCoreBody(ctx, body); // LAUNCH_SURFACE=core: fields and model prefixes that select a non-core feature are refused first
  validate(kind, body);
  validateCacheTtl(body, ctx.cfg.gateway.cacheTtlS);
  validateMulti(ctx, kind, body);
  const stream = body.stream === true;
  const bodySha = requestHash(body);
  // R5-07: the hash a recovery request is compared with (src/solana/recovery.ts), taken before anything below can touch
  // the body. Only for a non-streamed request that carries a payment: nothing else can be recovered.
  const recoverySha = !stream && paymentHeaderOf(c) ? recoveryRequestHash(body) : null;

  // ---- 1. Who is calling -------------------------------------------------------------------
  const secret = bearer(c.req.header("authorization"));
  // A line of a batch (POST /api/v1/batches), dispatched in process by the batch runner as the key that submitted it.
  const batchLine = batchLineOf(c);
  let key: KeyRow | null = null;
  let wallet: { accountId: string; wallet: string; exists: boolean } | null = null;
  // A verified Privacy Pass token (Authorization: PrivateToken), when TRELLIS_FEATURE_BLIND is on.
  let pass: BlindPass | null = null;
  // $TRLS holder tier of the wallet behind this request (null unless HOLDER_TIERS is live).
  let tier: HolderTier | null = null;
  if (batchLine || secret) {
    key = batchLine ? await batchKey(ctx, batchLine.keyHash) : await resolveKey(ctx, secret!);
    if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDC to its key hash first.", "invalid_key");
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    tier = await holderTier(ctx, walletOfAccount(key.accountId));
    await limitOrThrow(ctx, `k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), "requests");
    // R5-05: and per ACCOUNT, over all of its keys: sub-keys each have their own rpm, so the per-key limit alone bounds no account.
    if (!batchLine) await limitOrThrow(ctx, `acct:${key.accountId}`, 1, scaleLimit(ctx.cfg.limits.accountRpm, tier), "requests");
  } else {
    // A token carries its own quota (one request), so token callers get their own, larger per-address limit:
    // behind a relay many strangers share an address. A request the Oblivious HTTP gateway dispatched has no client
    // address (the gateway already limited it per relay), so it has no per-address bucket here.
    // A request that came over Tor has no client address: it counts against the shared onion bucket (see addressBucket).
    if (!gatewayOrigin(c.req.raw)) {
      const from = addressBucket(c, ctx.cfg);
      if (isBlindRequest(ctx, c.req.header("authorization"))) await limitOrThrow(ctx, `blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), "requests");
      else await limitOrThrow(ctx, `ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), "requests");
    }
    pass = await presentBlindToken(ctx, c.req.header("authorization"));
    const wa = c.req.header("x-wallet-auth");
    if (wa && !pass) wallet = await walletAuth(ctx, wa, bodySha, c);
  }

  enforceCoreKey(ctx, key); // LAUNCH_SURFACE=core: a key that carries a non-core setting is refused

  // ---- 2. Key presets, model resolution, guardrails, transforms --------------------------------
  const routing = (key?.routing ?? null) as { aliases?: Record<string, { model: string; provider?: ProviderPrefs; models?: string[] }>; provider?: ProviderPrefs } | null;
  const alias = typeof body.model === "string" ? routing?.aliases?.[body.model] : undefined;
  if (alias) {
    body.model = alias.model;
    if (alias.models && !body.models) body.models = alias.models;
    body.provider = { ...(alias.provider ?? {}), ...((body.provider as object) ?? {}) };
  }
  // Saved route (`model: "@route/<slug>"`, the caller's account only): fills in the fallback models,
  // provider prefs and default params the request leaves unset. Precedence: request > alias > route > key.
  guardInferenceModels(key, body); // ZK6: scope check before reading account settings.
  const savedRoute = await resolveSavedRoute(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body);
  // Preset (`model: "@preset/<name>[@<version>]"`): a versioned saved route that can also carry a system prompt, tools and a
  // response_format (routing/presets.ts). Same precedence and the same stricter-wins privacy settings as a saved route.
  const preset = savedRoute ? null : await resolvePreset(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body, kind);
  const presetMeta = preset ? { name: preset.name, version: preset.version, hash: preset.hash } : null;
  // Character (`model: "@character/<id>"`, or POST /api/v1/characters/:id/chat): the card becomes the system prompt, assembled
  // in memory for this call only; the lane defaults to attested when the model has an attested provider (characters/registry.ts).
  const character = savedRoute || preset ? null : await resolveCharacter(ctx, c, body, key?.accountId ?? wallet?.accountId ?? null, kind, characterId);
  if (routing?.provider) body.provider = { ...routing.provider, ...((body.provider as object) ?? {}) };
  captureStructuredOutput(ctx, c, kind, body); // V83: resolved defaults, opt-in only.
  // Disclosure ceiling and lane: `provider.disclosure` / `provider.lane` and the X-Trellis-* headers, the
  // stricter of the two winning, after the key's default and the saved route filled in what the request left unset.
  // A request naming no lane is public, except one relayed through the Oblivious HTTP gateway and paid with a blind
  // token, which defaults to unlinkable. Defaults (any, public) add nothing to `prefs`, so such requests route as before.
  // Lane "unlinkable" (OHTTP_ENABLED or UNLINKABLE_VIA_ONION): only through an independent relay or the onion service, only with a blind token and no key or wallet.
  // Checked before anything is priced or spent (ohttp/lane.ts).
  await applyRouteDefault(ctx, c, body, key, { params: requestParams(body) }); // U101: the key's default privacy route, only when the request names no lane
  const { disclosure: _wantDisclosure, lane: _wantLane, lane_downgrade: _wantDowngrade, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
  const disc = requestLane(ctx, c, (body.provider ?? {}) as Record<string, unknown>, { hasKey: !!key, hasWallet: !!wallet || (!key && !pass && !!paymentHeaderOf(c)), hasToken: !!pass });
  // Private-lane traffic (and `:private`, stored as private) is published only through noisy hourly counters.
  noteLane(c.req.raw, disc.lane !== "public" ? disc.lane : (body.provider as ProviderPrefs | undefined)?.private === true || String(body.model ?? "").includes(":private") ? "attested" : "public");
  decisionTagOf(ctx.cfg.decisionTagsEnabled, c, disc.lane); // B: a malformed tag is refused before anything is priced or spent.
  const strict = disc.max !== "any";
  const prefs: ProviderPrefs = { ...basePrefs, ...(strict ? { disclosure: disc.max } : {}), ...(disc.lane !== "public" ? { lane: disc.lane } : {}) };

  // A blind token pays for one provider call. Council mode and dual verification make several, each with its own hold.
  if (pass && ((ctx.cfg.features.council && body.model === COUNCIL_MODEL) || body.verify != null))
    fail(400, "Council mode and dual verification make several provider calls, so they cannot be paid with a blind token. Use an API key.", "blind_unsupported");

  if (batchLine && (stream || body.verify != null || (ctx.cfg.features.council && body.model === COUNCIL_MODEL)))
    fail(400, "Batch lines cannot stream, use council mode or use dual verification.", "invalid_request");
  // Council mode (`model: "trellis/council"`): several member calls plus a judge call, each billed and receipted.
  if (ctx.cfg.features.council && body.model === COUNCIL_MODEL) return runCouncil(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, tier, prefs, disc });

  const modelIds = [...new Set([...(typeof body.model === "string" ? [body.model] : []), ...((body.models as string[] | undefined) ?? [])])];
  if (!modelIds.length) fail(400, "`model` is required (e.g. \"meta-llama/llama-3.3-70b-instruct\").", "invalid_request");
  await ctx.catalog.ensureFresh();
  // A key allowed `@route/<slug>` (e.g. an agent session) may use exactly that route's own models.
  const allowed = new Set(key?.allowedModels ?? []);
  if (savedRoute && allowed.has(`@route/${savedRoute}`) && key) {
    const [row] = await ctx.db.select({ config: savedRoutes.config }).from(savedRoutes).where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, savedRoute)));
    for (const m of ((row?.config as { models?: string[] } | undefined)?.models ?? [])) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  }
  // Likewise a key allowed `@preset/<name>` may use the models of the preset version it resolved.
  if (preset && allowed.has(`@preset/${preset.name}`) && key)
    for (const m of preset.models) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  let resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[] = [];
  for (const id of modelIds) {
    const r = ctx.catalog.resolve(id);
    if (!r) continue;
    if (allowed.size && !allowed.has(r.model.id)) continue;
    resolved.push({ ...r, requested: id });
  }
  // Holder early access: a model still inside its window is open only from the caller's tier's time (403 early_access
  // otherwise, before anything is priced or spent). The tier is the key's wallet account's, else the signing wallet's.
  resolved = await gateEarlyAccess(ctx, resolved, async () => tier ?? (wallet ? await holderTier(ctx, wallet.wallet) : null));
  if (!resolved.length)
    fail(
      key?.allowedModels?.length ? 403 : 404,
      key?.allowedModels?.length ? `This key may only use: ${key.allowedModels.join(", ")}.` : `Model ${modelIds[0]} is not available. See GET /api/v1/models.`,
      key?.allowedModels?.length ? "model_not_allowed" : "model_not_found",
    );

  // Request-level guardrails only for authenticated keys; a key's own guardrails always apply.
  const guardCfg = mergeGuardrails(key?.guardrails as GuardrailConfig | null, key ? body.guardrails as GuardrailConfig | undefined : undefined);
  const guard = applyGuardrails(body, guardCfg);
  if (stream && guardCfg?.redact_output) fail(400, "Output redaction requires a non-streaming response.", "invalid_guardrails");

  const transforms = Array.isArray(body.transforms) ? (body.transforms as string[]) : [];
  const primary = resolved[0].model;
  // The per-item token figures the catalog declares for non-text input, the largest across every offer of the models
  // asked for: a bound whichever of them serves the call. Offers with no figure for a kind the request carries are
  // dropped after selection (boundableTargets).
  const itemLimits = maxItemLimits(resolved.flatMap((r) => ctx.catalog.offers(r.model.id)));
  let middle: { removed: number; truncated: number } | null = null;
  if (transforms.includes("middle-out") && kind === "chat") {
    const reserveOut = Number(body.max_tokens ?? body.max_completion_tokens ?? Math.min(4096, Math.floor(primary.ctx / 4)));
    middle = middleOut(body, primary.ctx, reserveOut, { items: itemLimits, settings: ctx.cfg.holds.bound, bytesPerToken: ctx.cfg.holds.contextBytesPerToken });
  }
  // The prompt BOUND (router/estimate.ts): every forwarded field, text at its UTF-8 bytes, token ids one each, non-text
  // parts at the catalog's per-item figure. A shape with no bound is refused here, before anything is priced or held.
  const analysis = analyzePrompt(body, { settings: ctx.cfg.holds.bound });
  const itemKinds = itemKindsOf(analysis);
  const promptTokens = boundWith(analysis, itemLimits) ?? refuseUnboundable(itemKinds.filter((k) => !itemLimits[k]), primary.id);
  // What the context-fit check sees: the bound itself unless HOLD_CONTEXT_BYTES_PER_TOKEN relaxes it (never the hold).
  const fitTokens = contextTokens(promptTokens, ctx.cfg.holds);

  // ---- 3. Accounts: key, pay-with, wallet change, per-call payment -------------------------------
  const { billing: resolvedBilling, paywithNote } = await resolveBilling(ctx, c, key, wallet, pass);
  let billing: Billing | null = resolvedBilling;

  // ---- 4. Cache (opt-in, never across accounts, keys, policies or end users) ----------------------
  const cacheSpec = (body.cache as { mode?: CacheMode; ttl?: number } | undefined) ?? (c.req.header("x-trellis-cache") ? { mode: c.req.header("x-trellis-cache") as CacheMode } : undefined);
  // The response cache keeps prompts and answers in the router, and a hit is served without any provider, so a
  // request with a disclosure ceiling never reads or writes it. Nor does a restricted variant (abliterated,
  // native_low_refusal): those are served only under attested retention, and the router must not keep their prompts.
  // Blind-token callers all share one internal account, so a cached answer would cross between strangers: never cache.
  const cacheMode: CacheMode | null = !strict && billing?.mode !== "blind" && !resolved.some((r) => isRestricted(ctx.catalog.laneOf(r.model).variant)) && (cacheSpec?.mode === "exact" || cacheSpec?.mode === "semantic") ? cacheSpec.mode : null;
  // `user` is forwarded to the provider as the end-user identity; a response made for one end user
  // must never be replayed to another behind the same key (exact or semantic).
  const cacheScope = billing ? `${billing.accountId}:policy-v3:${sha256(canonicalJson({ key: key?.keyHash ?? null, user: body.user ?? null, guardrails: guardCfg, provider: prefs, kind, models: resolved.map((r) => ({ id: r.model.id, modifiers: [...r.modifiers].sort() })), ...(savedRoute ? { route: savedRoute } : {}), ...(presetMeta ? { preset: presetMeta } : {}) }))}` : "";
  if (cacheMode && billing && !stream && body.verify == null) {
    const hit = await ctx.cache.get(cacheMode, cacheScope, body, ctx.cfg.gateway.semanticThreshold);
    if (hit) return cachedResponse(ctx, c, { body, hit, billing, model: primary, t0, bodySha, disc });
  }

  // ---- 5. Provider selection ------------------------------------------------------------------
  const byok = await byokFor(ctx, billing?.accountId);
  if (body.verify != null) applyDualDecoding(body); // temperature 0 and a fixed seed, before parameter support is checked
  const params = requestParams(body);
  const alternatives = { resolved, prefs, params, promptTokens: fitTokens, byok, body, allowed }; // B121
  const prefer = await bushelPreference(ctx, billing, prefs, resolved);
  const selected = selectWithSuggestions(() => selectTargets(ctx, { resolved, prefs, params, promptTokens: fitTokens, byok, disc, prefer }), ctx, alternatives); // B121
  const excluded = selected.excluded;
  if (!selected.targets.length)
    throw addSuggestions(new ApiError(404, "No providers match this request's model and routing preferences.", "no_providers", { excluded: excluded.slice(0, 50) }), ctx, alternatives); // B121
  const targets = answerSizedTargets(ctx, boundableTargets(selected.targets, itemKinds, excluded), body, promptTokens, excluded);

  // Dual verification (`verify: "dual"`): the same request to two providers, outputs compared.
  if (body.verify != null) return runDual(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, tier, billing, paywithNote, prefs, disc, resolved, targets, excluded, promptTokens, images: analysis.items.image, byok, guard, guardCfg, middle, savedRoute, preset: presetMeta });

  // ---- 6. Hold the worst case --------------------------------------------------------------------
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const reachable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model })));
  const attemptable = reachable.slice(0, ctx.cfg.routing.maxAttempts);
  // The hold is the dearest worst case over EVERY provider routing may reach (it skips some without counting an
  // attempt, so the first MAX_PROVIDER_ATTEMPTS are not the only ones), each at the output cap it will be sent.
  const worstOpts = { cfg: ctx.cfg.holds, images: analysis.items.image };
  const worst = maxPico(...reachable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, modeForPrice, fees, byok.has(cand.providerId), worstOpts)));
  const hold = batchLine ? batchHold(worst, batchLine.discountBps) : worst; // a batch line is held at its discounted worst case
  // The output cap sent to a provider: its own limit for this request, and never more than the hold covers.
  const outputCap = (cand: Candidate, model: ModelRow) => capWithinBudget(worst, cand, model, body, promptTokens, modeForPrice, fees, byok.has(cand.providerId), worstOpts);
  // R5-01: what this request orders from a provider at most (its prompt bound and the output cap it is sent): the
  // charge when the router stops listening to that provider and no usage figure came back. Never above the hold.
  const ordered = (cand: Candidate, model: ModelRow) => orderedUsage(cand, model, body, promptTokens, { ...worstOpts, cap: outputCap(cand, model) });
  // R5-01: and the most bytes of its answer that are read: what that order can take, within the provider's limit.
  const responseCap = (cand: Candidate, cap: number) => answerReadCap(cand, answerBytesBound(body, cap));

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: hold, bodySha, modelId: primary.id });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse, networkFee: r.networkFee };
  } else if (billing.mode === "per_call" && wallet && !billing.paymentTx && paymentHeaderOf(c)) {
    // A wallet-signed request that also carries a payment: the payment is redeemed for this request. A bare transaction
    // signature is accepted here and only here, because X-Wallet-Auth has shown the caller is the wallet that paid
    // (security review TR-07); the wallet header was verified above and is passed on, not verified twice.
    const r = await payPerCall(ctx, c, { pricePico: hold, bodySha, modelId: primary.id, wallet });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse, networkFee: r.networkFee };
  }
  if (billing.mode === "per_call") tier = await holderTier(ctx, billing.payer);
  // Tab: seller exposure (max(0.25 x last request cost, $0.05) beyond the latest voucher) is checked before any hold; a
  // request that needs a newer voucher is answered 402 voucher_required with the cumulative_used to sign.
  const creditLine: Pico = billing.mode === "tab" ? tabCreditLine(billing.tab, hold) : creditLineOf(billing);
  if (billing.mode === "tab") tier = await holderTier(ctx, billing.tab.payer);
  if (billing.mode === "blind") {
    requireValue(ctx, billing.pass, hold); // the token pays for at most its face value
    billing.hold = hold;
    await claimToken(ctx, billing.pass); // spends once: a second claim of the same token fails; undone if nothing is served
  }
  if (billing.key?.tpm) await limitOrThrow(ctx, `kt:${billing.key.keyHash}`, fitTokens, scaleLimit(billing.key.tpm, tier, "tpm"), "tokens");

  const holdId = batchLine?.generationId ?? genId(); // a batch line's id is chosen by the runner, so an interrupted line can be traced to its charge
  const holdTtl = holdLifetime(ctx, targets, disc.lane);
  try {
    await reserve(ctx.db, {
      ...agentReservation(ctx, () => ({ models: attemptable.map(t => t.model.id), lane: disc.lane, max_output_tokens: Math.max(...reachable.map(t => maxOutputTokens(body, t.cand, t.model, promptTokens, ctx.cfg.holds))), body })),
      id: holdId,
      accountId: billing.accountId,
      keyHash: billing.key?.keyHash ?? null,
      amount: hold,
      kind: "usage",
      // R3-25: the hold lives as long as the slowest provider that may be tried, and the heartbeat below renews it.
      ttlMs: holdTtl,
      creditLine,
    });
  } catch (e) {
    if (billing.mode === "blind") await unclaimToken(ctx, billing.pass);
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }
  // The hold is renewed while the request is in flight and stops being renewed the moment it is settled or released.
  // R4-01: and no longer than the request's own deadline (the routing budget the hold's lifetime was computed from,
  // plus the cancel drain and the receipt check), not for two hours.
  const drainMs = ctx.cfg.routing.cancelDrainMs;
  keepHoldAlive(ctx.db, holdId, holdTtl, ctx.cfg.holds.maxLifetimeMs, holdTtl + drainMs + 30_000);

  // ---- 7. Route ---------------------------------------------------------------------------------
  const abort = new AbortController();
  // R4-02: a call a provider is working on is billed by that provider whether or not anyone still listens.
  //   A non-streamed call therefore runs to its end when its caller goes away, and is charged its reported usage (an
  //   x402-paid one could always be collected again: src/solana/recovery.ts).
  //   A stream whose caller goes away is read on for STREAM_CANCEL_DRAIN_MS, to receive the provider's usage; only
  //   then is the upstream stopped, and the call charged the conservative bound.
  const client = { gone: false };
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const clientGone = () => {
    if (client.gone) return;
    client.gone = true;
    const stop = () => abort.abort(new DOMException("client disconnected", "AbortError"));
    if (drainMs <= 0) return stop();
    drainTimer = setTimeout(stop, drainMs);
    (drainTimer as { unref?: () => void }).unref?.();
  };
  if (stream) c.req.raw.signal?.addEventListener("abort", clientGone, { once: true });
  const keyFor = (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, byok.get(cand.providerId));
  const path = kind === "chat" ? ("/chat/completions" as const) : ("/completions" as const);
  const meta = { guard, middle, paywithNote, cacheMode, excluded, route: savedRoute, preset: presetMeta, character };
  // Streams send their headers before a provider is chosen, so the header is only set up front when every
  // provider this request can reach is served under the same class; the signed receipt always carries the truth.
  const classes = new Set(attemptable.map(({ cand }) => servedDisclosure(ctx, cand).class));
  const planned = classes.size === 1 ? [...classes][0] : null;
  // Likewise the policy hash: up front on a stream only when every reachable endpoint attested the same one.
  const plannedPolicy = sharedPolicyHash(attemptable.map(({ cand }) => servedPolicyHash(ctx, cand)));
  const common = { ctx, c, body, billing, holdId, t0, bodySha, stream, kind, byok, meta, guardCfg, promptTokens, ordered, tier, disc, planned, plannedPolicy, unavailable: (attempts: Attempt[], last?: Parameters<typeof allFailed>[1]) => availabilityFailure(() => allFailed(attempts, last), ctx, alternatives, attempts) }; // B121

  if (stream) return explainedStream(ctx.cfg.routeExplain, () => route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: true, outputCap, responseCap, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16), admit: sealedAdmission(ctx, disc.lane, tier) }), (run, routeHeaders) => streamResponse({ ...common, run, routeHeaders, abort, client, clientGone, stopDrain: () => clearTimeout(drainTimer) })); // V84

  let result: Awaited<ReturnType<typeof route>>;
  try {
    result = await route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: false, outputCap, responseCap, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16), admit: sealedAdmission(ctx, disc.lane, tier) });
  } catch (e) {
    await giveBack(ctx, billing, holdId);
    throw e;
  }
  if (!result.ok) {
    // R4-02 / R5-01: the router stopped listening to a provider that had the request (its own timeout, or an answer
    // above the size it reads). Charged what was ordered from that provider, and no other provider is tried.
    if (result.billable) {
      const fin = await chargeUnserved(common, result.billable, result.attempts);
      if (result.billable.kind !== "cancelled") await noteCutOff(ctx, admissions.get(c.req.raw));
      const err = unservedError(result.billable);
      return c.json({ ...err.toJSON(), id: fin.id, usage: fin.usageJson, receipt: fin.receiptJson }, err.status as 504, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), "x-trellis-disclosure": fin.disclosure, ...paymentHeaders(billing) });
    }
    await giveBack(ctx, billing, holdId);
    await noteFailedPaidCall(ctx, billing, holdId, result.attempts); // V6 R
    throw common.unavailable(result.attempts, result.last); // B121
  }
  const r = result as Extract<RouteSuccess, { kind: "json" }>;
  const json = r.json;
  // R4-02: with no usage figures the call is charged the conservative bound, never a fraction of it.
  const usage = answeredUsage(common, r, json.usage, utf8Bound(JSON.stringify(json.choices ?? [])));
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const responseText = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : ch?.text ?? "")).join("");
  // An attested gateway's receipt for this exchange: checked before anything is returned.
  const upstreamAttestation = await upstreamAttestationOf(ctx, r, byok);
  // R5-09: a request that required attested hardware, whose gateway receipt is missing or does not show it. The answer
  // is withheld, so the caller is charged nothing for it and the provider is owed nothing for it. The call is still
  // recorded and receipted (at zero), so its caller holds a signed record of where the prompt went; the event is counted
  // and alarmed, and the provider leaves routing after a few in a row (services/billing-watch.ts noteWithheldAnswer).
  const withheld = !!upstreamAttestation && requiresAttestedUpstream(body, disc) && !upstreamAttestation.attested;
  let fin: Awaited<ReturnType<typeof finalize>>;
  try {
    fin = await finalize({ ...common, r, usage, responseText, finishReason: json.choices?.[0]?.finish_reason ?? null, nativeFinish: json.choices?.[0]?.native_finish_reason ?? json.choices?.[0]?.finish_reason ?? null, generationMs: Date.now() - t0, cancelled: false, upstreamAttestation, withheld });
  } catch (e) {
    // R4-01: whatever ends a request, its hold is closed before the handler returns. R5-15: closed by CHARGING it: the
    // provider answered and bills the call whatever went wrong here afterwards (a withheld answer is released: it is
    // not charged). A hold finalize already settled is left as settled.
    if (withheld) await release(ctx.db, holdId).catch(() => undefined);
    else await settleAfterFailure(common, r, usage, e);
    throw e;
  }
  if (withheld) {
    await noteWithheldAnswer(ctx, { providerId: r.candidate.providerId, modelId: r.candidate.modelId, generationId: fin.id, reason: upstreamAttestation!.reason ?? "not attested" });
    return c.json({ ...unattestedUpstream(upstreamAttestation!, false).toJSON(), id: fin.id, usage: fin.usageJson, receipt: fin.receiptJson }, 502, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), ...routeResponseHeaders(ctx.cfg.routeExplain, r), "x-trellis-disclosure": fin.disclosure, ...paymentHeaders(billing) });
  }
  const out = {
    ...json,
    id: fin.id,
    model: r.model.id,
    provider: r.candidate.provider.name,
    object: kind === "chat" ? "chat.completion" : "text_completion",
    usage: fin.usageJson,
    receipt: fin.receiptJson,
    ...(fin.extras(redactions) ?? {}),
  };
  if (cacheMode && !stream) await ctx.cache.put(cacheMode, cacheScope, body, out, fin.upstream, (body.cache as { ttl?: number } | undefined)?.ttl ?? ctx.cfg.gateway.cacheTtlS);
  // R5-07: the answer to a call paid with x402 is kept so its payer can have it sent again (PAYMENT-RECOVERY).
  if (billing.mode === "per_call" && billing.paymentTx && recoverySha) await keepPaidAnswer(ctx, { payer: billing.payer, nonce: billing.paymentTx, requestSha256: recoverySha, body: JSON.stringify(out) });
  return c.json(out, 200, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), ...routeResponseHeaders(ctx.cfg.routeExplain, r), "x-trellis-disclosure": fin.disclosure, ...paymentHeaders(billing) });
}

/** What a caller is told when the router stopped listening to a provider that had the request (R4-02, R5-01). */
function unservedError(b: Billable): ApiError {
  const charged = "The provider had accepted the request and may bill all of it, so the call is charged what it ordered from that provider: its input and the output limit that was sent (the signed receipt says so).";
  return b.kind === "timeout"
    ? new ApiError(504, `The provider did not answer within the router's time limit. ${charged} Lower \`max_tokens\`, or stream, to bound what a slow call can cost.`, "provider_timeout")
    : b.kind === "oversize"
      ? new ApiError(502, `The provider's answer was larger than the router reads, so it was not delivered. ${charged}`, "provider_response_too_large")
      : new ApiError(499, `The request was cancelled while a provider was working on it. ${charged}`, "cancelled");
}

/**
 * The usage a call that a provider ANSWERED is charged: its meter reading when it sent one (router/pricing.ts
 * hasUsage), else the conservative bound: the prompt as it was ordered (the bound, once per completion, at the dearest
 * input price) and the output at the UTF-8 bytes received.
 */
function answeredUsage(p: Pick<Common, "ordered" | "promptTokens">, r: Pick<RouteSuccess, "candidate" | "model" | "empty">, reported: unknown, outputBytes: number, reasoningBytes = 0): Usage {
  const o = p.ordered?.(r.candidate, r.model);
  // A non-streamed answer's bytes are those of its `choices` JSON, envelope included: whether it carries OUTPUT is what
  // routing found (an empty answer the provider metered at zero output tokens is a reading, R4-02).
  const usage = usageOrBound(reported, o?.prompt ?? p.promptTokens, outputBytes, reasoningBytes, r.empty ? false : outputBytes + reasoningBytes > 0);
  if (!o) return usage;
  if (!usage.estimated) return o.searchUnits != null ? { ...usage, searchUnits: o.searchUnits } : usage;
  return { ...o, completion: usage.completion, reasoning: o.reasoning > 0 ? usage.completion : usage.reasoning };
}

export const FINALIZE_FAILED_LOG = "a call a provider answered could not be recorded; its hold was closed by charging it";
/**
 * Security review R5-15: finalize failed for a call a provider answered (a stream's answer is already with its
 * caller). The provider bills the call, so the hold is closed by charging the usage, not by releasing it; only when
 * that fails too is it released. settle() is idempotent, so a hold finalize had settled before it failed is untouched.
 */
async function settleAfterFailure(p: Common, r: RouteSuccess, usage: Usage | null, error: unknown) {
  const { ctx, billing } = p;
  try {
    if (!usage) throw new Error("no usage to charge");
    const isByok = p.byok.has(r.candidate.providerId);
    const cost = priceUsage(r.candidate, r.model, usage, billing.mode === "per_call" ? "per_call" : isByok ? "byok" : billing.mode, { royaltyBps: r.model.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps }, isByok);
    const settled = await settle(ctx.db, p.holdId, cost.total, { description: `${r.model.id} via ${r.candidate.providerId} (not recorded)`, generationId: p.holdId, creditLine: creditLineOf(billing) });
    log.error(FINALIZE_FAILED_LOG, { hold: p.holdId, provider: r.candidate.providerId, charged: settled.charged, error: (error as Error)?.message?.slice(0, 200) });
    await noteUnrecordedCall(ctx, { providerId: r.candidate.providerId, generationId: p.holdId, charged: settled.charged }).catch(() => undefined);
  } catch (e) {
    log.error("closing a hold after a failed finalize failed too; releasing it", { hold: p.holdId, error: (e as Error).message.slice(0, 200) });
    await release(ctx.db, p.holdId).catch(() => undefined);
  }
}



/**
 * Settle a call the router cut off while a provider was working on it (security review R4-02, R5-01): what was ordered
 * from that provider (its prompt bound and the output cap it was sent), which is the most it can bill and never more
 * than the hold. A generation row and a signed receipt record it like any call (finish reason `timeout` or `cancelled`, tokens
 * marked estimated, the provider owed what the caller paid), so the charge is visible, provable and reconciled.
 */
async function chargeUnserved(p: Common, b: Billable, attempts: Attempt[], received: { text?: string; reasoning?: string } = {}) {
  const r: RouteSuccess = { ok: true, kind: "json", candidate: b.candidate, model: b.model, json: {}, latencyMs: b.latencyMs, attempts, dropped: [] };
  // R5-01: the router did not see the provider's answer to its end, and the provider may bill all that was ordered.
  const usage = p.ordered?.(b.candidate, b.model) ?? unmeteredUsage(p.promptTokens, utf8Bound(received.text ?? ""), utf8Bound(received.reasoning ?? ""));
  return finalize({ ...p, r, usage, responseText: received.text ?? "", finishReason: b.kind, nativeFinish: null, generationMs: Date.now() - p.t0, cancelled: b.kind === "cancelled", upstreamAttestation: null, unserved: b.kind });
}

function allFailed(attempts: Attempt[], last?: { status?: number; errorKind: string; message: string }): ApiError {
  refuseCreditExhaustion(attempts); // ON3
  const allRejected = attempts.length > 0 && attempts.every((a) => a.error_kind === "rejected");
  const status = allRejected ? (last?.status && last.status >= 400 && last.status < 500 ? last.status : 400) : 502;
  return new ApiError(
    status,
    allRejected ? `Provider rejected the request: ${last?.message ?? "invalid request"}` : "All providers for this request failed. Nothing was charged.",
    allRejected ? "provider_rejected" : "providers_unavailable",
    { attempts: attempts.map(({ message, ...a }) => ({ ...a, message: message?.slice(0, 200) })) },
  );
}

/** A request that may only be answered by attested hardware: lane "attested" (or any disclosure "none"), or `:private`. */
export function requiresAttestedUpstream(body: Record<string, unknown>, disc: DisclosureRequest) {
  return disc.max === "none" || (body.provider as ProviderPrefs | undefined)?.private === true || String(body.model ?? "").includes(":private");
}

/**
 * The receipt check for a call an attested aci/1 gateway served (providers/aci.ts); null for every other provider.
 * A gateway call the router kept no record of cannot be checked, so it counts as not attested.
 */
async function upstreamAttestationOf(ctx: Ctx, r: Pick<RouteSuccess, "candidate" | "exchange">, byok: Map<string, string>): Promise<UpstreamAttestation | null> {
  const g = r.candidate.provider.aci;
  if (!g) return null;
  if (!r.exchange) return unverifiedUpstream(g, null, "the router kept no record of the exchange to check");
  return verifyAciExchange({
    baseUrl: r.candidate.provider.baseUrl,
    gateway: g,
    exchange: r.exchange,
    apiKey: providerKey(r.candidate, ctx.cfg.appSecret, byok.get(r.candidate.providerId)),
    tlsPin: r.candidate.provider.tlsPin,
    production: ctx.cfg.production,
  });
}

/**
 * The class a call was served under, given its gateway receipt check: an answer whose receipt does not show an
 * attested upstream is served under the class the provider has without a fresh attestation.
 */
function servedWith(ctx: Ctx, cand: Candidate, ua: UpstreamAttestation | null | undefined, base = servedDisclosure(ctx, cand)): { class: DisclosureClass; simulated: boolean } {
  if (!ua || ua.attested || base.class !== "attested") return base;
  return { class: disclosureClass(profileOf(ctx.catalog.disclosure.get(cand.providerId)), false), simulated: false };
}

/**
 * The answer for a request that required attested hardware when the gateway's receipt does not show it: the
 * upstream already did (and billed) the work, so the call is settled like any finished call, but its output is
 * withheld and the signed receipt records why.
 */
export function unattestedUpstream(ua: UpstreamAttestation, charged = true): ApiError {
  return new ApiError(
    502,
    charged
      ? `The provider's receipt does not show an attested upstream (${ua.reason ?? "not attested"}). The response was withheld. The upstream had already generated it, so the call is billed as usual; the signed receipt records the verification result.`
      : `The provider's receipt does not show an attested upstream (${ua.reason ?? "not attested"}). The response was withheld. Nothing was charged; the signed receipt records the verification result.`,
    "upstream_not_attested",
    { upstream_attestation: compactUpstream(ua) },
  );
}

export type Common = {
  ctx: Ctx;
  c: Context;
  body: Record<string, unknown>;
  billing: Billing;
  holdId: string;
  t0: number;
  bodySha: string;
  stream: boolean;
  kind: Kind;
  byok: Map<string, string>;
  meta: { guard: ReturnType<typeof applyGuardrails>; middle: { removed: number; truncated: number } | null; paywithNote?: string; cacheMode: CacheMode | null; excluded: unknown[]; route: string | null; preset?: { name: string; version: number; hash: string } | null; character?: CharacterMeta | null };
  guardCfg: GuardrailConfig | null;
  promptTokens: number;
  /**
   * R5-01: what the request orders from a candidate at most (router/pricing.ts orderedUsage, at the output cap it is
   * sent). Absent for the multi-call modes (council, dual verification), which are not on the core surface and keep
   * the round-4 rule.
   */
  ordered?: (cand: Candidate, model: ModelRow) => Usage;
  tier: HolderTier | null;
  disc: DisclosureRequest;
  /** The disclosure class every reachable provider shares, or null when it depends on who serves the call. */
  planned: DisclosureClass | null;
  /** The attested policy hash every reachable endpoint shares, or null (see generationHeaders); used by streams. */
  plannedPolicy?: string | null;
};

/** Extra inputs for calls made on behalf of a larger request (council members, dual verification). */
export type FinalizeExtra = {
  /**
   * Extra signed receipt fields; never replaces a base field. `attestation_ref` is set only for calls made under an
   * attested council or attested dual verification (see router/council.ts `attestationRefOf`); other receipts omit it.
   */
  payload?: { council?: unknown; verification?: unknown; attestation_ref?: unknown };
  /** The most this call may charge: usage above it is not billed to the caller (reported as `over_budget`). */
  budget?: Pico;
  /**
   * For a receipt that stands for several calls (the top-level council receipt): the weakest disclosure class
   * among all of them, and whether any rests on a simulated attestation. Never stronger than this call's own.
   */
  served?: { class: DisclosureClass; simulated: boolean };
};

export type FinalizeInput = Common & {
  r: RouteSuccess;
  usage: Usage;
  responseText: string;
  finishReason: string | null;
  nativeFinish: string | null;
  generationMs: number;
  cancelled: boolean;
  extra?: FinalizeExtra;
  /**
   * The checked receipt of an attested aci/1 gateway for this call. When omitted and the call went to such a
   * gateway, finalize checks it itself (council and dual verification calls).
   */
  upstreamAttestation?: UpstreamAttestation | null;
  /** For a stream: the head of the chunk hash chain over every event sent before the receipt (receipt v2 resp.chain). */
  chainHead?: string | null;
  /** For a stream: output tokens delivered to the caller, estimated from the delivered text (V6 R make-good). */
  delivered?: { completion: number; reasoning: number } | null;
  /** R4-02 / R5-01: the router did not get the provider's answer (it cut the call off, or could not read it). Charged, receipted and owed; not a served call. */
  unserved?: "timeout" | "cancelled" | "oversize";
  /**
   * R5-09: the answer is withheld (it required attested hardware and the gateway's receipt does not show it). Recorded
   * and receipted like any call, at ZERO: the caller is charged nothing and the generation row owes the provider nothing.
   */
  withheld?: boolean;
};

async function finalize(p: FinalizeInput) {
  const { ctx, billing, r } = p;
  const isByok = p.byok.has(r.candidate.providerId);
  const mode: Mode = isByok ? "byok" : billing.mode;
  const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps }; // a holder tier never changes a price
  const listCost = priceUsage(r.candidate, r.model, p.usage, billing.mode === "per_call" ? "per_call" : mode, fees, isByok);
  // A batch line is charged the discounted price (BATCH_DISCOUNT_BPS); everything else the list price.
  const batchLine = batchLineOf(p.c);
  const cost = batchLine ? batchPrice(listCost, batchLine.discountBps) : { ...listCost, batchDiscount: 0n };
  const id = p.holdId;
  const budget = p.extra?.budget;
  const overBudget = budget != null && cost.total > budget;
  // A blind token pays for at most its face value: anything above the hold would come out of the pool's other tokens.
  // Likewise a council call's budget is its hold. Both are the ledger's own rule now (security review R3-02): settle()
  // charges at most the hold, so the full cost is passed and the hold caps it.
  const due = p.withheld ? 0n : cost.total;
  // Prepaid capacity (§5.6): a prepaid, non-BYOK call on a host that honours the key's redeemed allowance for this
  // model's grade spends the allowance first; only the uncovered share is charged. The host's price is unchanged.
  let bushel: Awaited<ReturnType<typeof applyBushelAllowance>> | null = null;
  if (ctx.cfg.bushels.enabled && billing.mode === "prepaid" && !isByok && due > 0n) {
    try {
      const applied = await applyBushelAllowance(ctx, { keyHash: billing.key.keyHash, modelId: r.model.id, providerId: r.candidate.providerId, usage: { tokensIn: p.usage.prompt, tokensOut: p.usage.completion, reasoningTokens: p.usage.reasoning, cachedTokens: p.usage.cachedRead }, cost: due });
      if (applied.coveredTokens > 0n) bushel = applied;
    } catch (e) {
      // The allowance is untouched when this fails; the call is charged in full rather than lost.
      log.error("prepaid capacity could not be applied", { hold: p.holdId, error: (e as Error).message.slice(0, 160) });
    }
  }
  const coveredPico = bushel ? due - bushel.charge : 0n;
  const settled = await settle(ctx.db, p.holdId, bushel?.charge ?? due, {
    description: `${r.model.id} via ${r.candidate.providerId}`,
    generationId: id,
    creditLine: creditLineOf(billing),
  });
  const charged = settled.charged;
  // R3-02: usage priced above the hold means the provider ignored the output cap it was sent, over-generated or
  // over-reported. The caller paid the hold; the provider is owed no more than that for this generation (the row below
  // records it, and the settlement job pays from the row); the event is logged, counted against the provider and alarmed.
  // A hold that had expired and could not be charged in full is not the provider's doing: it is paid its price.
  const overHold = settled.uncovered > 0n && !settled.late;
  // R5-01, invariant (2): what a generation row says is owed is never more than its caller was charged, also when the
  // hold had expired and the account could not cover the call any more (`late`; that case is logged by the ledger).
  const payable = p.withheld ? { upstream: 0n, royalty: 0n, margin: 0n } : settled.uncovered > 0n ? payableWithin(cost, charged, coveredPico) : cost;
  if (overHold && !settled.alreadySettled) await noteHoldExceeded(ctx, { generationId: id, providerId: r.candidate.providerId, modelId: r.candidate.modelId, listCost: cost.total, charged, usage: p.usage, caller: sha256(billing.accountId).slice(0, 16) });

  // Pay-with: record the debt and an estimate of the share fraction it will cost. Tab: the usage record moves on.
  let paidWith: Record<string, unknown> | string | null = null;
  if (billing.mode === "paywith") {
    const raw = await recordDebt(ctx, { key: billing.key, generationId: id, amount: charged, grant: billing.grant });
    paidWith = { token: billing.grant.symbol, token_address: billing.grant.token, raw_units: raw?.toString() ?? "0", fair_price: billing.grant.fairPrice18.toString(), swap_tx: null, status: "accrued" };
  } else if (billing.mode === "tab") {
    paidWith = "tab";
    await recordTabUsage(ctx, billing.tab, charged);
  } else if (billing.mode === "per_call" && billing.paymentTx) {
    // Paid by a per-call payment presented with this request (an x402 payload, or a wallet-bound transaction signature).
    paidWith = "x402";
  }

  const attestation = r.candidate.provider.attested && r.candidate.provider.attestationHash ? r.candidate.provider.attestationHash : null;
  const ua = p.upstreamAttestation !== undefined ? p.upstreamAttestation : await upstreamAttestationOf(ctx, r, p.byok);
  // A gateway answer whose receipt does not show an attested upstream is served under the class the provider has
  // without a fresh attestation, whatever the gateway's own attestation says.
  const served = servedWith(ctx, r.candidate, ua, p.extra?.served ?? servedDisclosure(ctx, r.candidate));
  if (ua) await recordGpuAttested(ctx.db, r.model.id, r.candidate.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
  if (ua?.attested) noteVerifiedReceipt(ctx, r.candidate.providerId); // R5-09: ends the provider's run of withheld answers
  const privateRoute = (p.body.provider as ProviderPrefs | undefined)?.private === true || String(p.body.model ?? "").includes(":private");
  const payer = billing.mode === "tab" ? billing.tab.payer : billing.key ? billing.key.chainKeyHash : billing.mode === "per_call" ? billing.payer : null;
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: r.model.id,
    provider: r.candidate.providerId,
    tokens: { prompt: p.usage.prompt, completion: p.usage.completion, reasoning: p.usage.reasoning, cached: p.usage.cachedRead, estimated: p.usage.estimated },
    cost: picoToUsdString(charged),
    // `over_hold` (and, under council.max_cost_usd, `over_budget`): the list price of the usage the provider reported, when it was above the hold and so not charged.
    cost_details: { upstream: picoToUsdString(payable.upstream), royalty: picoToUsdString(payable.royalty), margin: picoToUsdString(payable.margin), ...(overBudget ? { over_budget: picoToUsdString(cost.total) } : {}), ...(overHold ? { over_hold: picoToUsdString(cost.total) } : {}), ...(batchLine ? { batch_discount: picoToUsdString(cost.batchDiscount) } : {}), ...(bushel ? { prepaid_capacity: picoToUsdString(coveredPico) } : {}) },
    // Prepaid capacity spent on this call: cost_details.prepaid_capacity is the USD it covered (not charged); here the
    // output-equivalent tokens taken and the lots they came from.
    ...(bushel ? { prepaid_capacity: { tokens: bushel.coveredTokens.toString(), lots: bushel.lots } } : {}),
    paid_with: paidWith,
    latency_ms: Math.round(r.latencyMs),
    generation_ms: p.generationMs,
    quant: r.candidate.quant,
    mode,
    private: privateRoute,
    attestation,
    disclosure: served.class,
    lane: p.disc.lane,
    ...(served.simulated ? { attestation_simulated: true } : {}),
    payer,
    payment_tx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    // The Solana network fee of that payment, passed through at cost (zero markup): apart from `cost`, which is the call.
    ...(billing.mode === "per_call" && billing.networkFee ? { network_fee: networkFeeLine(billing.networkFee) } : {}),
    // A tab call names the tab and the voucher it was served under; the close posts the highest voucher on chain.
    ...(billing.mode === "tab" ? { tab: { address: billing.tab.pda, seq: billing.tab.voucher.seq.toString(), cumulative_used: billing.tab.voucher.cumulativeUsed.toString() } } : {}),
    // A blind redemption names no account: the receipt carries the hash of the spent token (its nullifier) and the key that signed it.
    ...(billing.mode === "blind" ? blindReceipt(billing.pass) : {}),
    request_sha256: p.bodySha,
    response_sha256: sha256(p.responseText),
    ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
    ...(batchLine ? { batch: { id: batchLine.batchId, line: batchLine.idx } } : {}),
    ...routeReceiptFields(ctx.cfg.routeExplain, r), // V84: signed optional extension.
    ...decisionTagFields(decisionTagOf(ctx.cfg.decisionTagsEnabled, p.c, p.disc.lane)), // B: signed optional extension.
    // The caller's W3C trace id (traceparent): a tool call and the model call it hands its answer to share one (docs §7).
    ...traceIdField(p.c.req.header("traceparent")),
    ...(p.extra?.payload ?? {}),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  // Receipt v2 alongside v1: the same facts minus payer and exact counts, as a COSE_Sign1 under the same key.
  const policyHash = servedPolicyHash(ctx, r.candidate);
  const claimsV2 = buildClaimsV2({
    ...routeReceiptFields(ctx.cfg.routeExplain, r), // V84
    rid: id,
    issuedAt: new Date(payload.issued),
    router: ctx.cfg.publicUrl,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    attestation,
    policyHash,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    chainHead: p.stream ? (p.chainHead ?? null) : null,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    finish: p.finishReason,
    stream: p.stream,
    complete: !p.cancelled && p.finishReason !== "error" && !p.unserved,
    lane: p.disc.lane,
    disclosure: served.class,
    mode,
    chargedPico: charged,
    keyset: billing.mode === "blind" && !billing.pass.tokens ? billing.pass.keyId : null,
    decisionTag: payload.decision_tag ?? null, // B
  });
  const signedV2 = ctx.signer.signCose(claimsV2);

  const referer = p.c.req.header("http-referer") ?? p.c.req.header("referer");
  const title = p.c.req.header("x-title");
  let appId: string | null = null;
  // App attribution names where a call came from, so it is never recorded for the unlinkable lane.
  if ((referer || title) && p.disc.lane !== "unlinkable") {
    appId = sha256((referer ?? "") + "|" + (title ?? "")).slice(0, 24);
    await ctx.db.insert(apps).values({ id: appId, url: referer?.slice(0, 500) ?? null, title: title?.slice(0, 200) ?? null }).onConflictDoNothing();
  }

  const tps = p.usage.completion > 0 && p.generationMs > r.latencyMs ? p.usage.completion / ((p.generationMs - r.latencyMs) / 1000) : null;
  // A call the router cut off was already recorded against the provider as a timeout (router/execute.ts), or not at all.
  // A metered empty answer (R4-02) is a served call that stays on record as empty-200 evidence: it counts in the
  // provider's empty rate, and, being `ok`, never towards an outage (its caller paid for it and may have asked for it).
  // R5-09: nor is a withheld answer a success.
  if (!p.unserved && !p.withheld) ctx.health.record({ modelId: r.candidate.modelId, providerId: r.candidate.providerId, ok: true, latencyMs: r.latencyMs, tps, source: "traffic", ...(r.empty ? { empty200: true } : {}) });
  // R4-02: every settlement at an estimate is counted per provider and raised as a readiness warning.
  if (p.usage.estimated && !settled.alreadySettled && !p.withheld) await noteEstimatedSettlement(ctx, { providerId: r.candidate.providerId, generationId: id, reason: p.unserved ?? (p.cancelled ? "cancelled" : "no_usage"), charged }).catch(() => undefined);

  await ctx.db.insert(generations).values({
    id,
    keyHash: billing.key?.keyHash ?? null,
    accountId: billing.accountId,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    reasoningTokens: p.usage.reasoning,
    cachedTokens: p.usage.cachedRead,
    cacheWriteTokens: p.usage.cacheWrite,
    cost: charged,
    // What this generation pays out: the list split, or (over the hold) no more in total than the caller was charged.
    upstreamCost: payable.upstream,
    royalty: payable.royalty,
    margin: payable.margin,
    cacheDiscount: cost.cacheDiscount,
    mode,
    latencyMs: Math.round(r.latencyMs),
    generationTimeMs: p.generationMs,
    finishReason: p.finishReason,
    nativeFinishReason: p.nativeFinish,
    streamed: p.stream,
    cancelled: p.cancelled,
    quant: r.candidate.quant,
    dataRegion: r.candidate.provider.datacenter?.[0] ?? null,
    isByok,
    private: privateRoute,
    attestationHash: attestation,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    receiptV2: claimsV2,
    receiptCose: signedV2.cose.toString("base64"),
    receiptLeafV2: signedV2.leaf,
    paidWith,
    paymentTx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    appId,
    attempts: r.attempts,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
  });
  await linkNetworkReceipt(ctx, id, r.candidate.providerId, r);
  // Verifiable inference (docs/Trellis_Backend.md §3): sample SEALED calls for shadow re-execution; fire-and-forget, in memory only.
  if (p.disc.lane === "attested" && !p.unserved) void noteSealedGeneration(ctx, { generationId: id, lane: p.disc.lane, modelId: r.model.id, providerId: r.candidate.providerId, body: p.body, path: p.kind === "chat" ? "/chat/completions" : "/completions", requestSha256: p.bodySha, responseSha256: payload.response_sha256 }).catch(() => {});
  if (!p.unserved && !p.withheld) await noteServedCall(ctx, { id, accountId: billing.accountId, keyHash: billing.key?.keyHash ?? null, billingMode: billing.mode, paymentTx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null, payer: billing.mode === "per_call" ? billing.payer : null, candidate: r.candidate, model: r.model, attempts: r.attempts, usage: p.usage, delivered: p.delivered, cost, charged, priceMode: billing.mode === "per_call" ? "per_call" : mode, fees, isByok, byokProviders: [...p.byok.keys()], batchDiscountBps: batchLine?.discountBps ?? null, servedClass: served.class, upstreamAttested: ua ? ua.attested : null, attestedLane: requiresAttestedUpstream(p.body, p.disc), lane: p.disc.lane, finishReason: p.finishReason, cancelled: p.cancelled, stream: p.stream }); // V6 R
  if (billing.mode === "blind") await (p.withheld ? unclaimToken(ctx, billing.pass) : confirmToken(ctx, billing.pass, id)); // a withheld answer does not spend the token
  // Creator attribution for a public character: a count and a cost per day, never on the unlinkable lane.
  if (p.meta.character?.attribute && p.disc.lane !== "unlinkable") await recordCharacterUse(ctx, p.meta.character.id, charged);

  // A private-lane request is counted once in the noisy counters and sends no per-request trace span.
  const privateLane = isPrivateLaneRequest(p.c.req.raw);
  recordPrivateLane(ctx, p.c.req.raw, { latencyMs: p.generationMs, tokens: p.usage.prompt + p.usage.completion });
  if (!privateLane) ctx.telemetry.span("chat " + r.model.id, p.t0, Date.now(), {
    "gen_ai.system": r.candidate.providerId,
    "gen_ai.operation.name": p.kind === "chat" ? "chat" : "text_completion",
    "gen_ai.request.model": String(p.body.model ?? r.model.id),
    "gen_ai.response.model": r.model.id,
    "gen_ai.usage.input_tokens": p.usage.prompt,
    "gen_ai.usage.output_tokens": p.usage.completion,
    "trellis.generation_id": id,
    "trellis.provider": r.candidate.providerId,
    "trellis.mode": mode,
    "trellis.cost_usd": picoToUsd(charged),
    "trellis.attempts": r.attempts.length,
    "trellis.streamed": p.stream,
  }, undefined, p.c.req.header("traceparent")?.split("-")[1]);
  // The key owner's own trace export (services/tracing.ts): public-lane calls only. An attested or unlinkable call
  // never reaches the queue, whatever the key is configured to do. Queued without waiting; it cannot fail the call.
  if (billing.key?.tracing && shouldExportTrace({ lane: p.disc.lane, privateLaneRequest: privateLane, privateRoute })) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    ctx.tracing.enqueue(billing.key.keyHash, billing.key.tracing, {
      generationId: id,
      startMs: p.t0,
      endMs: Date.now(),
      ...parseTraceparent(p.c.req.header("traceparent")),
      operation: p.kind === "chat" ? "chat" : "text_completion",
      provider: r.candidate.providerId,
      requestModel: String(p.body.model ?? r.model.id),
      responseModel: r.model.id,
      inputTokens: p.usage.prompt,
      outputTokens: p.usage.completion,
      temperature: num(p.body.temperature),
      topP: num(p.body.top_p),
      maxTokens: num(p.body.max_tokens ?? p.body.max_completion_tokens),
      finishReasons: p.finishReason ? [p.finishReason] : [],
      costUsd: picoToUsd(charged),
      timeToFirstTokenMs: r.latencyMs,
      mode,
      streamed: p.stream,
      attempts: r.attempts.length,
      input: p.kind === "chat" ? p.body.messages : p.body.prompt,
      output: p.responseText,
    });
  }

  const usageJson = {
    prompt_tokens: p.usage.prompt,
    completion_tokens: p.usage.completion,
    total_tokens: p.usage.prompt + p.usage.completion,
    cost: picoToUsd(charged),
    is_byok: isByok,
    cost_details: { upstream_inference_cost: picoToUsd(payable.upstream), royalty: picoToUsd(payable.royalty), margin: picoToUsd(payable.margin), ...(batchLine ? { batch_discount: picoToUsd(cost.batchDiscount) } : {}), ...(bushel ? { prepaid_capacity: picoToUsd(coveredPico) } : {}), ...(overHold ? { over_hold: picoToUsd(cost.total) } : {}) },
    prompt_tokens_details: { cached_tokens: p.usage.cachedRead, cache_write_tokens: p.usage.cacheWrite },
    completion_tokens_details: { reasoning_tokens: p.usage.reasoning },
  };
  const receiptJson = {
    id,
    sig: signed.sig,
    key_id: signed.keyId,
    alg: "Ed25519",
    payload,
    leaf,
    anchor_hint: `Rooted within the hour; GET /api/v1/receipts/${id}/proof returns the merkle path.`,
    ...(paidWith ? { paid_with: paidWith } : {}),
    v2: { alg: "EdDSA", kid: signedV2.keyId, content_type: COSE_CONTENT_TYPE, cose: signedV2.cose.toString("base64"), claims: claimsV2, leaf: signedV2.leaf },
  };
  return {
    id,
    disclosure: served.class,
    simulated: served.simulated,
    /** The classifier policy hash the serving endpoint's fresh attestation bound, or null (X-Trellis-Policy-Hash). */
    policyHash,
    upstream: payable.upstream,
    charged,
    cost: { ...cost, ...payable },
    overBudget,
    overHold,
    mode,
    isByok,
    payload,
    usageJson,
    receiptJson,
    extras: (redactions: number) => {
      const x: Record<string, unknown> = {};
      if (p.meta.route) x.route = p.meta.route; // the saved route (`@route/<slug>`) that resolved this call
      if (p.meta.preset) x.preset = p.meta.preset; // the preset version (`@preset/<name>@<version>`) that resolved this call
      if (p.meta.character) x.character = { id: p.meta.character.id, card_hash: p.meta.character.card_hash, lane: p.meta.character.lane, lorebook_entries: p.meta.character.lore.length, greeting: p.meta.character.greeting, ...(p.meta.character.note ? { note: p.meta.character.note } : {}) };
      if (p.meta.guard || redactions) x.guardrails = { ...(p.meta.guard ?? {}), output_redactions: redactions };
      if (p.meta.middle && (p.meta.middle.removed || p.meta.middle.truncated)) x.transforms = { "middle-out": p.meta.middle };
      if (p.meta.paywithNote) x.pay_with_fallback = p.meta.paywithNote;
      if (p.billing.mode === "blind") x.blind = redemptionSummary(p.billing.pass, charged);
      if (p.tier) x.holder = { tier: p.tier.name, rpm_multiplier: p.tier.rpmMultiplier, tpm_multiplier: p.tier.tpmMultiplier };
      if (r.dropped.length) x.dropped_parameters = r.dropped;
      return Object.keys(x).length ? x : null;
    },
  };
}

function streamResponse(p: Common & { unavailable: typeof allFailed; run: () => ReturnType<typeof route>; routeHeaders?: Record<string, string>; abort: AbortController; /** R4-02: set when the caller left; `clientGone` starts the drain window, `stopDrain` ends it. */ client: { gone: boolean }; clientGone: () => void; stopDrain: () => void }): Response {
  const { ctx, kind } = p;
  const enc = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  // R5-04: the request's in-flight slot is held until the stream has ended, and given back on every way out of it.
  const admission = admissions.get(p.c.req.raw);
  if (admission) admission.deferred = true;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
     try {
      await (async () => {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const event = (obj: unknown) => send(`data: ${JSON.stringify(obj)}\n\n`);
      send(": TRELLIS PROCESSING\n\n");
      const keepalive = setInterval(() => send(": TRELLIS PROCESSING\n\n"), 5_000);
      let result: Awaited<ReturnType<typeof route>> | null = null;
      try {
        result = await p.run();
      } catch (e) {
        clearInterval(keepalive);
        p.stopDrain();
        await giveBack(ctx, p.billing, p.holdId);
        if (!p.abort.signal.aborted) event({ error: { code: 502, message: (e as Error).message, type: "router_error" } });
        send("data: [DONE]\n\n");
        closed = true;
        try { controller.close(); } catch { /* client gone */ }
        return;
      }
      clearInterval(keepalive);
      if (!result.ok) {
        p.stopDrain();
        if (result.billable) {
          // R4-02: the router cut off a provider that had the request (its timeout, or the caller left and the drain ran
          // out before the first token). Charged the documented minimum, with a receipt.
          try {
            const fin = await chargeUnserved(p, result.billable, result.attempts);
            if (result.billable.kind !== "cancelled") await noteCutOff(ctx, admission);
            event({ ...unservedError(result.billable).toJSON(), id: fin.id });
            event({ id: fin.id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion", created, choices: [], usage: fin.usageJson, receipt: fin.receiptJson });
          } catch (e) {
            log.error("stream finalize failed", { error: (e as Error).message, hold: p.holdId });
            await release(ctx.db, p.holdId).catch(() => undefined);
          }
        } else {
          await giveBack(ctx, p.billing, p.holdId);
          await noteFailedPaidCall(ctx, p.billing, p.holdId, result.attempts); // V6 R
          const err = p.unavailable(result.attempts, result.last); // B121
          event(err.toJSON());
        }
        send("data: [DONE]\n\n");
        closed = true;
        try { controller.close(); } catch { /* client gone */ }
        return;
      }
      const r = result as Extract<RouteSuccess, { kind: "stream" }>;
      const base = chunkBase(p.holdId, created, r.model, r.candidate.provider.name, kind);
      // Chunk hash chain (receipt v2 resp.chain): every event before the receipt is chained, and c_i follows the
      // i-th event as an SSE comment, which OpenAI-compatible parsers discard. Only what was enqueued is chained.
      const chain = new ChunkChain(p.holdId);
      const chained = (obj: unknown) => {
        if (closed) return;
        const data = JSON.stringify(obj);
        const hex = chain.push(data);
        send(`data: ${data}\n\n` + chainComment(chain.count, hex));
      };
      // What an attested gateway streams for a request that requires attested hardware is held back until its
      // receipt shows an attested upstream (providers/aci.ts); every other stream is relayed as it arrives.
      const hold = !!r.candidate.provider.aci && requiresAttestedUpstream(p.body, p.disc);
      const held: unknown[] = [];
      const relay = (obj: unknown) => (hold ? held.push(obj) : chained(obj));
      const holdKeepalive = hold ? setInterval(() => send(": TRELLIS PROCESSING\n\n"), 5_000) : undefined;
      let text = "";
      let reasoningText = ""; // billed when usage never arrives (e.g. the client cancels mid-stream)
      let toolText = "";
      let finish: string | null = null;
      let nativeFinish: string | null = null;
      let providerUsage: any = null;
      let cancelled = false;
      let midError: string | null = null;
      // R5-01: the ROUTER stopped listening before the provider's answer ended (its caller left and the drain ran out,
      // its own time limit, the size it reads). Without a usage figure such a call is charged what was ordered.
      let routerCut = false;
      const emit = (ev: any) => {
        if (ev?.usage) providerUsage = ev.usage;
        const choices = Array.isArray(ev?.choices) ? ev.choices : [];
        for (const ch of choices) {
          const d = ch?.delta ?? {};
          if (typeof d.content === "string") text += d.content;
          if (typeof ch?.text === "string") text += ch.text;
          if (typeof d.reasoning === "string") reasoningText += d.reasoning;
          if (typeof d.reasoning_content === "string") reasoningText += d.reasoning_content;
          if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) toolText += String(tc?.function?.arguments ?? "") + String(tc?.function?.name ?? "");
          if (ch?.finish_reason) {
            finish = ch.finish_reason;
            nativeFinish = ch.native_finish_reason ?? ch.finish_reason;
          }
        }
        if (!choices.length && ev?.usage) return; // usage-only chunk: we send our own at the end
        const { usage: _u, id: _i, model: _m, created: _c, object: _o, ...rest } = ev ?? {};
        relay({ ...base, ...rest, choices });
      };
      try {
        for (const ev of r.buffered) emit(ev);
        for await (const ev of r.rest) {
          if (ev?.error) {
            midError = String(ev.error?.message ?? "provider error");
            relay({ ...base, error: { code: 502, message: midError, type: "provider_error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
            break;
          }
          emit(ev);
        }
      } catch (e) {
        const cut = (e as { errorKind?: string }).errorKind;
        if (p.abort.signal.aborted) cancelled = routerCut = true;
        else {
          if (cut === "timeout" || cut === "oversize" || (e as Error)?.name === "TimeoutError") {
            routerCut = true;
            await noteCutOff(ctx, admission);
          }
          midError = (e as Error).message;
          relay({ ...base, error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
        }
      }
      p.stopDrain();
      if (p.client.gone) cancelled = true; // the caller left; the upstream was read on for its usage (R4-02)
      let usage: Usage | null = null;
      let withheld = false;
      try {
        // Make-good counts what was delivered at the old per-character estimate; the charge below does not use it.
        const reasoningEst = Math.ceil(reasoningText.length / 4);
        // R4-02: the provider's usage when it sent one. Otherwise, when the PROVIDER ended the stream (it finished, or
        // broke off), the conservative bound: the prompt bound plus the UTF-8 bytes of every token it sent (content,
        // tool arguments, reasoning), whether or not the caller got them. R5-01: when the ROUTER stopped listening,
        // what the provider sent afterwards is not known, so the call is charged what was ordered.
        usage = (routerCut && !hasUsage(providerUsage) ? p.ordered?.(r.candidate, r.model) : undefined) ?? answeredUsage(p, r, providerUsage, utf8Bound(text) + utf8Bound(toolText), utf8Bound(reasoningText));
        const upstreamAttestation = await upstreamAttestationOf(ctx, r, p.byok);
        clearInterval(holdKeepalive);
        const refused = hold && !!upstreamAttestation && !upstreamAttestation.attested;
        // R5-09: withheld, so charged nothing (recorded and receipted at zero). A caller who LEFT is not given that: it
        // cannot make the receipt check fail for free by leaving (a cut-off exchange can not be checked), so its call
        // is settled like any call its caller left, and does not count towards the provider's breaker.
        withheld = refused && !cancelled;
        if (hold && !refused) for (const e of held) chained(e);
        // The refusal goes out before the receipt is signed, so the chain covers it too.
        if (refused) chained({ ...unattestedUpstream(upstreamAttestation!, !withheld).toJSON(), id: p.holdId });
        const fin = await finalize({ ...p, r, usage, responseText: text, finishReason: finish ?? (cancelled ? "cancelled" : midError ? "error" : null), nativeFinish, generationMs: Date.now() - p.t0, cancelled, upstreamAttestation, withheld, chainHead: chain.head, delivered: providerUsage ? { completion: Math.ceil((text.length + toolText.length) / 4) + reasoningEst, reasoning: reasoningEst } : { completion: usage.completion, reasoning: usage.reasoning } /* V6 R: a stream with no provider usage is billed for exactly what was received, so nothing is undelivered */ });
        if (withheld) await noteWithheldAnswer(ctx, { providerId: r.candidate.providerId, modelId: r.candidate.modelId, generationId: fin.id, reason: upstreamAttestation!.reason ?? "not attested" });
        event({ ...base, choices: [], usage: fin.usageJson, receipt: fin.receiptJson, ...(fin.extras(0) ?? {}) });
      } catch (e) {
        clearInterval(holdKeepalive);
        log.error("stream finalize failed", { error: (e as Error).message, hold: p.holdId });
        // R5-15: the answer is with the caller and the provider bills it. (A withheld answer is not charged: released.)
        if (withheld) await release(ctx.db, p.holdId).catch(() => undefined);
        else await settleAfterFailure(p, r, usage, e);
      }
      send("data: [DONE]\n\n");
      closed = true;
      try {
        controller.close();
      } catch {
        /* client gone */
      }
      })();
     } finally {
      admission?.release();
     }
    },
    cancel() {
      closed = true;
      p.clientGone(); // R4-02: read the upstream on for its usage (STREAM_CANCEL_DRAIN_MS), then stop it
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...p.routeHeaders, /* V84 */ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...generationHeaders(p.holdId, p.disc.lane, p.plannedPolicy), ...(p.planned ? { "x-trellis-disclosure": p.planned } : {}), ...paymentHeaders(p.billing) },
  });
}

async function cachedResponse(ctx: Ctx, c: Context, p: { body: Record<string, unknown>; hit: { response: any; upstream: bigint; similarity: number }; billing: Billing; model: ModelRow; t0: number; bodySha: string; disc: DisclosureRequest }) {
  const id = genId();
  await enforceAgentCached(ctx, p.billing.key, p.model.id, p.disc.lane, p.body, id);
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: p.model.id,
    provider: "cache",
    tokens: { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false },
    cost: "0",
    cost_details: { upstream: "0", royalty: "0", margin: "0" },
    paid_with: null,
    latency_ms: Date.now() - p.t0,
    mode: "cache",
    // The answer was first produced by a provider under no disclosure ceiling (a request with one never uses the cache).
    disclosure: "vendor-forwarded" satisfies DisclosureClass,
    lane: p.disc.lane,
    cache: { similarity: Number(p.hit.similarity.toFixed(4)), original: p.hit.response?.id ?? null },
    payer: p.billing.mode === "tab" ? p.billing.tab.payer : (p.billing.key?.chainKeyHash ?? (p.billing.mode === "per_call" ? p.billing.payer : null)),
    request_sha256: p.bodySha,
    response_sha256: sha256((p.hit.response?.choices ?? []).map((ch: any) => ch?.message?.content ?? "").join("")),
    ...decisionTagFields(decisionTagOf(ctx.cfg.decisionTagsEnabled, c, p.disc.lane)), // B
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  await ctx.db.insert(generations).values({
    id,
    keyHash: p.billing.key?.keyHash ?? null,
    accountId: p.billing.accountId,
    modelId: p.model.id,
    providerId: "cache",
    mode: "cache",
    cost: 0n,
    cacheDiscount: p.hit.upstream,
    latencyMs: Date.now() - p.t0,
    generationTimeMs: Date.now() - p.t0,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    finishReason: p.hit.response?.choices?.[0]?.finish_reason ?? null,
  });
  return c.json(
    {
      ...p.hit.response,
      id,
      cached: true,
      usage: { ...(p.hit.response?.usage ?? {}), cost: 0, cost_details: { upstream_inference_cost: 0, royalty: 0, margin: 0, cache_savings: picoToUsd(p.hit.upstream) } },
      receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload, leaf },
    },
    200,
    // Served from the cache, not by an attested endpoint: no policy hash.
    { ...generationHeaders(id, p.disc.lane), "x-trellis-cache": "hit", "x-trellis-disclosure": "vendor-forwarded", ...paymentHeaders(p.billing) },
  );
}

/** What the multi-call modes (council, dual verification) reuse from the single-call path. */
export const toolkit = { finalize, selectTargets, boundableTargets, holdLifetime, resolveBilling, allFailed, byokFor, limitOrThrow, requestHash, requestParams, paymentHeaders, upstreamAttestationOf, servedWith };

export { canonical };
