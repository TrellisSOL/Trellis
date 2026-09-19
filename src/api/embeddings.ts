import { refuseCreditExhaustion, refuseCreditOutage } from "../rush/errors.ts"; // ON3
import { rememberRoutePlan, rememberRouteResult, routeReceiptFields, routeResponseHeaders } from "../router/explain.ts"; // V84
import { agentReservation } from "../agents/enforce.ts";
import { blindReceipt } from "../blind/set.ts";
import type { Hono } from "hono";
import { noteEstimatedSettlement, noteVerifiedReceipt, noteWithheldAnswer } from "../services/billing-watch.ts";
import { enforceCoreRequest } from "../surface/request.ts";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { maxPico, picoToUsd, picoToUsdString } from "../lib/money.ts";
import { genId, log, sha256 } from "../lib/util.ts";
import { keepHoldAlive, reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { disclosureRefusal, profileOf } from "../router/disclosure.ts";
import { analyzePrompt, batchHold, batchPrice, boundWith, inputWorstCase, itemKindsOf, maxItemLimits, priceUsage, refuseUnboundable, unmeteredUsage, usageOrBound } from "../router/pricing.ts";
import { answerLimitOf, answerReadCap, embeddingBytesBound, MAX_EMBEDDING_INPUTS } from "../router/pricing.ts";
import { contextTokens, holdTtlMs } from "../router/hold-config.ts";
import { noteHoldExceeded, payableWithin } from "../services/hold-watch.ts";
import { batchKey, batchLineOf } from "../router/batch-line.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { bearer, requireKey, requireRole } from "./auth.ts";
import { admitInference, noteCutOff, type Admitted } from "./admission.ts";
import { keepPaidAnswer, recoveryRequestHash } from "../solana/recovery.ts";
import { addressBucket, generationHeaders, readJson } from "./common.ts";
import { servedPolicyHash } from "./disclosure.ts";
import { requestHash, requiresAttestedUpstream, toolkit, unattestedUpstream } from "./chat.ts";
import { compactUpstream, recordGpuAttested } from "../providers/aci.ts";
import { payPerCall } from "../solana/percall.ts";
import { paymentHeaderOf, x402ResponseHeaders } from "../solana/x402.ts";
import type { Attempt } from "../router/execute.ts";
import { holderTier, scaleLimit, walletOfAccount } from "../solana/tiers.ts";
import { gateEarlyAccess } from "../holders/early-access.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { requestLane } from "../ohttp/lane.ts";
import { applyRouteDefault } from "../routing/route-default.ts"; // U101
import { noteLane } from "../services/private-stats.ts";
import { BLIND_POOL, claimToken, confirmToken, isBlindRequest, presentBlindToken, redemptionSummary, requireValue, unclaimToken } from "../blind/redeem.ts";

// POST /api/v1/embeddings — prepaid keys, or no key at all: an unpaid call gets the same 402 as chat
// (CallPay and/or x402, whichever this router has configured) and the paid retry is served.
//
// An attested aci/1 gateway is held to the same rule as for chat (providers/aci.ts): the router fetches the gateway's
// receipt for the call and checks it against the exact request and response bytes. On lane "attested" (any
// disclosure ceiling of "none", or `:private`) the vectors are returned only when the receipt shows an upstream the
// gateway verified inside a TEE; otherwise they are withheld, the call is billed, and the signed receipt says why.
// On other lanes the vectors are returned and the receipt records that they were not attested.
export function embeddingsRoutes(app: Hono, ctx: Ctx) {
  // R5-04: a slot per key (or source address), taken before the body is read and given back on every way out.
  const handler = async (c: import("hono").Context) => {
    const admission = await admitInference(ctx, c);
    try {
      return await serve(c, admission);
    } finally {
      admission.release();
    }
  };
  const serve = async (c: import("hono").Context, admission: Admitted) => {
    const t0 = Date.now();
    // A line of a batch (POST /api/v1/batches), dispatched in process by the batch runner as the key that submitted it.
    const batchLine = batchLineOf(c);
    const key = batchLine ? await batchKey(ctx, batchLine.keyHash) : bearer(c.req.header("authorization")) ? await requireKey(ctx, c.req.header("authorization")) : null;
    if (key) await requireRole(ctx, key, ["owner", "admin", "member"]);
    let tier = key ? await holderTier(ctx, walletOfAccount(key.accountId)) : null; // $TRLS holders get a higher rpm
    const from = addressBucket(c, ctx.cfg); // over Tor: the shared onion bucket, not a client address
    const lim = key
      ? await ctx.limiter.take(`k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), 60_000)
      : gatewayOrigin(c.req.raw)
        ? { ok: true, retryAfterMs: 0 } // dispatched by the Oblivious HTTP gateway, which limited it per relay: there is no client address here
        : isBlindRequest(ctx, c.req.header("authorization"))
          ? await ctx.limiter.take(`blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), 60_000) // a token carries its own quota
          : await ctx.limiter.take(`ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    // R5-05: and per ACCOUNT, over all of its keys (sub-keys each have their own rpm).
    if (key && !batchLine) {
      const acct = await ctx.limiter.take(`acct:${key.accountId}`, 1, scaleLimit(ctx.cfg.limits.accountRpm, tier), 60_000);
      if (!acct.ok) fail(429, "Rate limit exceeded for this account.", "rate_limited", undefined, { "retry-after": String(Math.ceil(acct.retryAfterMs / 1000)) });
    }
    // A Privacy Pass token (Authorization: PrivateToken) instead of a key, when TRELLIS_FEATURE_BLIND is on.
    const pass = key ? null : await presentBlindToken(ctx, c.req.header("authorization"));
    const body = await readJson(c);
    const recoverySha = !key && paymentHeaderOf(c) ? recoveryRequestHash(body) : null; // R5-07: what a recovery request is compared with
    enforceCoreRequest(ctx, body, key); // LAUNCH_SURFACE=core
    const input = body.input;
    // R5-01: the batch is bounded so the vectors that come back fit what the router reads (router/pricing.ts): an
    // answer it cannot read to its end is billed by the provider all the same, so it must not be orderable.
    if (!(typeof input === "string" || (Array.isArray(input) && input.length > 0 && input.length <= MAX_EMBEDDING_INPUTS))) fail(400, `\`input\` must be a string or an array (max ${MAX_EMBEDDING_INPUTS} items).`, "invalid_request");
    if (typeof body.model !== "string") fail(400, "`model` is required.", "invalid_request");
    if (body.dimensions != null && (!Number.isInteger(body.dimensions) || (body.dimensions as number) < 1 || (body.dimensions as number) > 65_536)) fail(400, "`dimensions` must be a positive integer.", "invalid_request");
    const answerBound = embeddingBytesBound(body, Array.isArray(input) ? input.length : 1);
    await ctx.catalog.ensureFresh();
    const r = ctx.catalog.resolve(body.model);
    if (!r) fail(404, `Model ${body.model} is not available.`, "model_not_found");
    if (key?.allowedModels?.length && !key.allowedModels.includes(r.model.id)) fail(403, "This key may not use that model.", "model_not_allowed");
    await gateEarlyAccess(ctx, [r], () => tier); // holder early access: 403 early_access until the caller's tier's time
    // What is billed when a provider reports no usage: the figure this endpoint has always used (never above the bound).
    const chars = (Array.isArray(input) ? input : [input]).reduce((n: number, s) => n + String(s).length, 0);
    const unreportedTokens = Math.ceil(chars / 3) + 8;
    // The input BOUND behind the hold (security review R3-02; router/estimate.ts): every forwarded field, each input at
    // its UTF-8 bytes or one token per id. An input that is neither text nor token ids cannot be bounded and is refused.
    const analysis = analyzePrompt(body, { settings: ctx.cfg.holds.bound, endpoint: "embeddings" });
    const itemLimits = maxItemLimits(ctx.catalog.offers(r.model.id));
    const promptTokens = boundWith(analysis, itemLimits) ?? refuseUnboundable(itemKindsOf(analysis).filter((k) => !itemLimits[k]), r.model.id);
    const fitTokens = contextTokens(promptTokens, ctx.cfg.holds);
    await applyRouteDefault(ctx, c, body, key, { tokens: fitTokens }); // U101: the key's default privacy route, only when the request names no lane
    // Same disclosure ceiling and lane as chat (`provider.disclosure`, `provider.lane`, X-Trellis-Disclosure-Max, X-Trellis-Lane).
    const { disclosure: _wantDisclosure, lane: _wantLane, lane_downgrade: _wantDowngrade, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
    // A per-call payment names its payer as a wallet does: it is identity-bearing for lane "unlinkable".
    const disc = requestLane(ctx, c, (body.provider ?? {}) as Record<string, unknown>, { hasKey: !!key, hasWallet: !key && !pass && (!!c.req.header("x-wallet-auth") || !!paymentHeaderOf(c)), hasToken: !!pass });
    noteLane(c.req.raw, disc.lane); // the status page counts public-lane requests only (services/slo.ts)
    const strict = disc.max !== "any";
    const plan = (p: ProviderPrefs) =>
      selectProviders({
        modelId: r.model.id,
        offers: ctx.catalog.offers(r.model.id),
        prefs: p,
        modifiers: r.modifiers,
        requestParams: [],
        estimatedTokens: fitTokens,
        health: ctx.health,
        production: ctx.cfg.production,
        attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
        disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
        modelLane: ctx.catalog.laneOf(r.model),
        attestedBonus: ctx.cfg.routing.attestedBonus,
        rand: ctx.rand,
      });
    const sel = plan({ ...basePrefs, ...(strict ? { disclosure: disc.max } : {}), ...(disc.lane !== "public" ? { lane: disc.lane } : {}) });
    rememberRoutePlan(ctx.cfg.routeExplain, sel, sel.ordered, sel.excluded, { ...basePrefs, lane: disc.lane }, r.modifiers, [], new Map()); // V84
    if (!sel.ordered.length) {
      const refusal = strict ? disclosureRefusal(disc, [r.model.id], sel.excluded, () => plan(basePrefs).ordered.length > 0) : null;
      if (refusal) throw refusal;
      refuseCreditOutage(ctx.cfg.rush.enabled, sel.excluded); // ON3
      fail(404, "No providers match this request.", "no_providers", { excluded: sel.excluded });
    }
    const mode = key ? "prepaid" : pass ? "blind" : "per_call";
    const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: key || pass ? 0 : ctx.cfg.fees.perCallMarginBps, byokFeeBps: 0 };
    // R5-01: only providers whose answer to this batch fits what the router reads from them.
    const sized = sel.ordered.filter((cand) => answerBound <= answerLimitOf(cand));
    if (!sized.length) fail(400, "The vectors this request orders could be larger than the router reads from a provider. Send fewer inputs, or fewer `dimensions`.", "response_too_large", { answer_bytes_bound: answerBound, max_bytes: Math.max(...sel.ordered.map(answerLimitOf)) });
    const tried = sized.slice(0, ctx.cfg.routing.maxAttempts); // exactly the providers the loop below may call
    const worst = (cand: (typeof sel.ordered)[number]) => inputWorstCase(cand, r.model, promptTokens, mode, fees);
    const worstHold = maxPico(...tried.map(worst));
    // The hold is the bound (plus one pico, so it is never zero): it no longer needs doubling, because the input can
    // not cost more than its bound and a provider that reports more is not charged to the caller.
    const hold = (batchLine ? batchHold(worstHold, batchLine.discountBps) : worstHold) + 1n; // a batch line is held at its discounted worst case
    // No key: the caller pays this call up front (402 quote, or the X-Payment retry); the payment funds the hold.
    const paid = key || pass ? null : await payPerCall(ctx, c, { pricePico: hold, bodySha: requestHash(body), modelId: r.model.id });
    const accountId = key?.accountId ?? (pass ? BLIND_POOL : paid!.accountId);
    const caller = sha256(accountId).slice(0, 16); // R5-04: health events name who saw them
    if (paid) tier = await holderTier(ctx, paid.payer); // a wallet paying per call: its $TRLS tier is reported with the answer
    const id = batchLine?.generationId ?? genId();
    if (pass) {
      requireValue(ctx, pass, hold); // the token pays for at most its face value
      await claimToken(ctx, pass); // spends once; given back below if nothing is served
    }
    // R3-25: the hold outlives every attempt on the slowest provider, and is renewed while the request is alive.
    const holdTtl = holdTtlMs({ providerTimeoutMs: ctx.cfg.routing.providerTimeoutMs, maxAttempts: tried.length, candidates: tried });
    try {
      await reserve(ctx.db, { ...agentReservation(ctx, () => ({ models: [r.model.id], lane: disc.lane, max_output_tokens: 0, body })), id, accountId, keyHash: key?.keyHash ?? null, amount: hold, ttlMs: holdTtl });
    } catch (e) {
      if (pass) await unclaimToken(ctx, pass);
      throw e;
    }
    keepHoldAlive(ctx.db, id, holdTtl, ctx.cfg.holds.maxLifetimeMs, holdTtl + 30_000); // R4-01: renewed no longer than the request's own deadline
    const attempts: Attempt[] = [];
    try {
      for (const cand of tried) {
        const res = await callUpstream({ health: ctx.health, // ON3
    appSecret: ctx.cfg.appSecret,
          candidate: cand,
          path: "/embeddings",
          body: upstreamBody(cand, body, false).body,
          stream: false,
          apiKey: providerKey(cand, ctx.cfg.appSecret),
          // R4-02: a call a provider is working on runs to its end whoever is still listening; it is billed either way.
          signal: new AbortController().signal,
          timeoutMs: ctx.cfg.routing.providerTimeoutMs,
          firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs,
          production: ctx.cfg.production,
          maxResponseBytes: answerReadCap(cand, answerBound),
        });
        const empty = res.ok && res.kind === "json" && !(Array.isArray(res.json?.data) && res.json.data.length);
        // R4-02: the router's own timeout cut off a provider that had the request. The provider may bill the input, so
        // the call is charged the documented minimum (the input bound at its price) and no other provider is tried.
        // R5-01: likewise an answer above the size the router reads: the provider embedded and metered the whole input.
        const timedOut = !res.ok && (res.errorKind === "timeout" || res.errorKind === "oversize");
        if (timedOut) {
          const cut = res.errorKind as "timeout" | "oversize";
          attempts.push({ provider: cand.providerId, model: r.model.id, ok: false, error_kind: cut, latency_ms: Math.round(res.latencyMs) });
          ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: false, errorKind: cut, source: "traffic", caller });
          const usage = unmeteredUsage(promptTokens, 0);
          const priced = { ...priceUsage(cand, r.model, { ...usage, completion: 0 }, mode, fees, false), batchDiscount: 0n };
          const settled = await settle(ctx.db, id, priced.total, { description: `${r.model.id} embeddings via ${cand.providerId} (${cut === "timeout" ? "timed out" : "answer too large to read"}; input charged)`, generationId: id });
          const charged = settled.charged;
          const cost = settled.uncovered > 0n ? { ...priced, ...payableWithin(priced, charged) } : priced;
          const payload = { v: 1, id, issued: new Date().toISOString(), router: ctx.cfg.publicUrl, model: r.model.id, provider: cand.providerId, tokens: { prompt: usage.prompt, completion: 0, reasoning: 0, cached: 0, estimated: true }, cost: picoToUsdString(charged), cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin) }, paid_with: null, latency_ms: Math.round(res.latencyMs), quant: cand.quant, mode, lane: disc.lane, payer: key?.chainKeyHash ?? paid?.payer ?? null, payment_tx: paid?.txHash ?? null, request_sha256: sha256(JSON.stringify(body)), response_sha256: sha256("") };
          const signed = ctx.signer.sign(payload);
          await ctx.db.insert(generations).values({ id, keyHash: key?.keyHash ?? null, accountId, modelId: r.model.id, providerId: cand.providerId, tokensIn: usage.prompt, cost: charged, upstreamCost: cost.upstream, royalty: cost.royalty, margin: cost.margin, mode, latencyMs: Math.round(res.latencyMs), generationTimeMs: Date.now() - t0, finishReason: cut, quant: cand.quant, receiptId: id, receiptSig: signed.sig, receiptKeyId: signed.keyId, receipt: payload, receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes), paymentTx: paid?.txHash ?? null, attempts, requestSha256: payload.request_sha256, responseSha256: payload.response_sha256 });
          await noteEstimatedSettlement(ctx, { providerId: cand.providerId, generationId: id, reason: cut, charged }).catch(() => undefined);
          await noteCutOff(ctx, admission);
          if (cut === "oversize") return c.json({ error: { code: 502, type: "provider_response_too_large", message: "The provider's answer was larger than the router reads, so it was not delivered. The provider had embedded the input and may bill it, so the call is charged its input at that provider's price; nothing else is charged." }, id, usage: { prompt_tokens: usage.prompt, total_tokens: usage.prompt, cost: picoToUsd(charged) }, receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload } }, 502, { ...generationHeaders(id, disc.lane), ...(paid?.paymentResponse ? x402ResponseHeaders(paid.paymentResponse) : {}) });
          return c.json({ error: { code: 504, type: "provider_timeout", message: "The provider did not answer within the router's time limit. It had accepted the request and may bill it, so the call is charged its input at that provider's price; nothing else is charged." }, id, usage: { prompt_tokens: usage.prompt, total_tokens: usage.prompt, cost: picoToUsd(charged) }, receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload } }, 504, { ...generationHeaders(id, disc.lane), ...(paid?.paymentResponse ? x402ResponseHeaders(paid.paymentResponse) : {}) });
        }
        if (!res.ok || empty) {
          const kind = res.ok ? "empty200" : res.errorKind;
          attempts.push({ provider: cand.providerId, model: r.model.id, ok: false, error_kind: kind, status: res.ok ? 200 : res.status, latency_ms: Math.round(res.latencyMs) });
          ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: false, errorKind: kind, empty200: kind === "empty200", source: "traffic", caller });
          continue;
        }
        if (res.kind !== "json") continue;
        attempts.push({ provider: cand.providerId, model: r.model.id, ok: true, status: 200, latency_ms: Math.round(res.latencyMs) });
        // An attested gateway's receipt for this exchange: checked before anything is charged or returned.
        const ua = await toolkit.upstreamAttestationOf(ctx, { candidate: cand, exchange: res.exchange }, new Map());
        const refused = !!ua && requiresAttestedUpstream(body, disc) && !ua.attested;
        if (ua?.attested) noteVerifiedReceipt(ctx, cand.providerId);
        // R5-09: withheld vectors are charged nothing and nothing is owed to the provider for them; the call is still
        // recorded and receipted (at zero), and the event is counted and alarmed (services/billing-watch.ts).
        if (refused) await noteWithheldAnswer(ctx, { providerId: cand.providerId, modelId: cand.modelId, generationId: id, reason: ua!.reason ?? "not attested" });
        else ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: true, latencyMs: res.latencyMs, source: "traffic" });
        // R4-02: with no usage figures the call is charged the input bound, never a fraction of it.
        const usage = usageOrBound(res.json.usage, promptTokens, 0);
        if (usage.estimated) void noteEstimatedSettlement(ctx, { providerId: cand.providerId, generationId: id, reason: "no_usage", charged: 0n }).catch(() => undefined);
        const usagePrice = priceUsage(cand, r.model, { ...usage, completion: 0 }, mode, fees, false);
        const listCost = refused ? { ...usagePrice, upstream: 0n, notional: 0n, royalty: 0n, margin: 0n, total: 0n } : usagePrice;
        const priced = batchLine ? batchPrice(listCost, batchLine.discountBps) : { ...listCost, batchDiscount: 0n };
        // R3-02: the charge is capped at the hold by the ledger. Usage priced above it is the provider over-reporting:
        // it is owed no more than the caller paid, and the event is logged, counted against it and alarmed.
        const settled = await settle(ctx.db, id, priced.total, { description: `${r.model.id} embeddings via ${cand.providerId}`, generationId: id });
        const charged = settled.charged;
        const overHold = settled.uncovered > 0n && !settled.late;
        const cost = overHold ? { ...priced, ...payableWithin(priced, charged) } : priced;
        if (overHold && !settled.alreadySettled) await noteHoldExceeded(ctx, { generationId: id, providerId: cand.providerId, modelId: cand.modelId, listCost: priced.total, charged, usage, caller: sha256(accountId).slice(0, 16) });
        const served = toolkit.servedWith(ctx, cand, ua);
        if (ua) await recordGpuAttested(ctx.db, r.model.id, cand.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
        const routeResult = rememberRouteResult({ candidate: cand, model: r.model, attempts }, [{ model: r.model, ordered: sel.ordered }]); // V84
        const payload = {
          ...routeReceiptFields(ctx.cfg.routeExplain, routeResult), // V84
          v: 1,
          id,
          issued: new Date().toISOString(),
          router: ctx.cfg.publicUrl,
          model: r.model.id,
          provider: cand.providerId,
          tokens: { prompt: usage.prompt, completion: 0, reasoning: 0, cached: 0, estimated: usage.estimated },
          cost: picoToUsdString(charged),
          cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin), ...(batchLine ? { batch_discount: picoToUsdString(cost.batchDiscount) } : {}), ...(overHold ? { over_hold: picoToUsdString(priced.total) } : {}) },
          paid_with: null,
          latency_ms: Math.round(res.latencyMs),
          quant: cand.quant,
          mode,
          disclosure: served.class,
          lane: disc.lane,
          ...(served.simulated ? { attestation_simulated: true } : {}),
          payer: key?.chainKeyHash ?? paid?.payer ?? null,
          payment_tx: paid?.txHash ?? null,
          ...(pass ? blindReceipt(pass) : {}), // no account: the receipt names the spent token by its hash
          request_sha256: sha256(JSON.stringify(body)),
          response_sha256: sha256(JSON.stringify(res.json.data)),
          ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
          ...(batchLine ? { batch: { id: batchLine.batchId, line: batchLine.idx } } : {}),
        };
        const signed = ctx.signer.sign(payload);
        await ctx.db.insert(generations).values({
          id,
          keyHash: key?.keyHash ?? null,
          accountId,
          modelId: r.model.id,
          providerId: cand.providerId,
          tokensIn: usage.prompt,
          cost: charged,
          upstreamCost: cost.upstream,
          royalty: cost.royalty,
          margin: cost.margin,
          mode,
          latencyMs: Math.round(res.latencyMs),
          generationTimeMs: Date.now() - t0,
          quant: cand.quant,
          receiptId: id,
          receiptSig: signed.sig,
          receiptKeyId: signed.keyId,
          receipt: payload,
          receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes),
          paymentTx: paid?.txHash ?? null,
          attempts,
          requestSha256: payload.request_sha256,
          responseSha256: payload.response_sha256,
        });
        if (pass) await (refused ? unclaimToken(ctx, pass) : confirmToken(ctx, pass, id)); // withheld vectors do not spend the token
        const usageJson = { prompt_tokens: usage.prompt, total_tokens: usage.prompt, cost: picoToUsd(charged), cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), ...(key ? {} : { margin: picoToUsd(cost.margin) }), ...(batchLine ? { batch_discount: picoToUsd(cost.batchDiscount) } : {}) } };
        const receiptJson = { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload };
        const headers = { ...routeResponseHeaders(ctx.cfg.routeExplain, routeResult), ...generationHeaders(id, disc.lane, servedPolicyHash(ctx, cand)), "x-trellis-disclosure": served.class, ...(paid?.paymentResponse ? x402ResponseHeaders(paid.paymentResponse) : {}) };
        const out = {
          ...res.json,
          id,
          model: r.model.id,
          provider: cand.provider.name,
          usage: usageJson,
          ...(tier ? { holder: { tier: tier.name, rpm_multiplier: tier.rpmMultiplier, tpm_multiplier: tier.tpmMultiplier } } : {}),
          ...(pass ? { blind: redemptionSummary(pass, charged) } : {}),
          receipt: receiptJson,
        };
        // The vectors are withheld; the receipt (at zero) records why.
        if (refused) return c.json({ ...unattestedUpstream(ua!, false).toJSON(), id, usage: usageJson, receipt: receiptJson }, 502, headers);
        // R5-07: the answer to a call paid with x402 is kept so its payer can have it sent again (PAYMENT-RECOVERY).
        if (paid?.txHash && recoverySha) await keepPaidAnswer(ctx, { payer: paid.payer, nonce: paid.txHash, requestSha256: recoverySha, body: JSON.stringify(out) });
        return c.json(out, 200, headers);
      }
    } catch (e) {
      await release(ctx.db, id);
      if (pass) await unclaimToken(ctx, pass);
      throw e;
    }
    await release(ctx.db, id);
    if (pass) await unclaimToken(ctx, pass); // nothing was served: the token is not spent
    refuseCreditExhaustion(attempts); // ON3
    fail(502, "All providers for this request failed. Nothing was charged.", "providers_unavailable", { attempts });
  };
  app.post("/api/v1/embeddings", handler);
  app.post("/v1/embeddings", handler);
}
