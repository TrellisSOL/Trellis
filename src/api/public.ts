import { networkFeeAccount } from "../solana/sponsor.ts";
import { updatesStatus } from "../surface/updates.ts";
import { makegoodStatus, refundReceipt } from "../services/makegood.ts"; // V6 R
import { anchorKeyDocument } from "../services/anchor.ts";
import { launchStatus } from "../solana/launch-config.ts";
import type { Hono } from "hono";
import { dataToolsStatus } from "../data-tools/routes.ts"; // B
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { idHash } from "../lib/hash.ts";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { apps, generations, kv, models, offers, paywithSessions, providers } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { providerApplication, submitProviderApplication } from "../providers/application.ts";
import { cachedReadiness } from "../services/readiness.ts";
import { singleFlight } from "../hardening/single-flight.ts";
import { readinessMetrics } from "../services/readiness-metrics.ts";
import { addressBucket, readJson } from "./common.ts";
import { requireKey } from "./auth.ts";
import { verifyReceipt, verifyReceiptV2, anchorProof, anchorProofs } from "./generation.ts";
import { identityStatus } from "../identity/status.ts"; // v6 I
import { COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { MAX_PROOF_DEPTH } from "../receipts/merkle.ts";
import { decisionTagCheck, expectedDecisionTag } from "../receipts/decision-tag.ts"; // B
import { holdersStatus } from "../solana/tiers.ts";
import { laneSummary } from "./models.ts";
import { closeSession, openSession, paywithStatus, readSession, sessionJson, statement } from "../solana/paywith.ts";
import { tabStatus } from "../solana/tab-billing.ts";
import { faucetEnabled, faucetStatus } from "../solana/faucet.ts";
import { acceptedTokens, trlsSummary, escrowEnabled, usdcSummary } from "../solana/escrow.ts";
import { X402_VERSIONS, x402Enabled } from "../solana/x402.ts";
import { RECOVERY_MAX_BYTES, RECOVERY_TTL_MS, recoveryMessage } from "../solana/recovery.ts";
import { facilitatorStatus } from "../solana/facilitator.ts"; // v6 F
import { toolsStatus } from "../tools/routes.ts"; // v6 T
import { PRIVATE_LANES, PUBLIC_LANE_ROWS, privateLaneStats } from "../services/private-stats.ts";
import { labelForReceipt } from "../privacy/resolve.ts";

export { providerApplication } from "../providers/application.ts";

export function publicRoutes(app: Hono, ctx: Ctx) {
  const launchMetrics = async () => {
    const r = await ctx.db.execute(sql`
      SELECT
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '24 hours'), 0) AS tokens_24h,
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '7 days'), 0) / 7 AS tokens_per_day_7d,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '24 hours') AS active_keys_24h,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '30 days') AS active_keys_30d
      FROM generations WHERE provider_id <> 'cache' AND ${PUBLIC_LANE_ROWS}`);
    const row = (((r as { rows?: unknown[] }).rows ?? r) as Record<string, string | number>[])[0] ?? {};
    return {
      tokens_24h: Number(row.tokens_24h ?? 0),
      tokens_per_day_7d: Math.round(Number(row.tokens_per_day_7d ?? 0)),
      active_keys_24h: Number(row.active_keys_24h ?? 0),
      active_keys_30d: Number(row.active_keys_30d ?? 0),
    };
  };
  // ---- Private-lane stats: noisy hourly counters only (services/private-stats.ts) ----
  app.get("/api/v1/stats", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: { lanes: PRIVATE_LANES, ...privateLaneStats(ctx).document() } });
  });

  // ---- Receipts ----
  // `anchor` names where receipt roots are posted and the anchorer key(s) that sign them (memo mode: the key IS the anchor).
  app.get("/api/v1/receipts/keys", async (c) => c.json({ ...(await ctx.signer.jwks()), anchor: anchorKeyDocument(ctx) }));
  app.get("/.well-known/trellis-receipt-keys.json", async (c) => c.json({ ...(await ctx.signer.jwks()), anchor: anchorKeyDocument(ctx) }));
  // A root and every proof element is 32 bytes of 0x-prefixed hex, and a path is no deeper than any tree (R5-22):
  // anything else is a malformed request (400), not something for the hash function to throw on.
  const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32 bytes of 0x-prefixed hex");
  const anchorInput = z.object({ root: hash32, proof: z.array(hash32).max(MAX_PROOF_DEPTH), index: z.number().int().optional() }).optional();
  app.post("/api/v1/receipts/verify", async (c) => {
    const raw = await readJson(c);
    // Who a chain lookup is counted against (R3-29): this route takes no key, so it is the client address.
    const source = addressBucket(c, ctx.cfg).id;
    // v2: a COSE_Sign1 (base64), optionally with the hashes, the streamed event data and an anchor proof to check.
    if (raw && typeof raw === "object" && typeof (raw as { cose?: unknown }).cose === "string") {
      const b = z
        .object({ cose: z.string().max(16_384), request_sha256: z.string().optional(), response_sha256: z.string().optional(), chunks: z.array(z.string()).max(100_000).optional(), anchor: anchorInput, decision_tag: expectedDecisionTag.optional() })
        .parse(raw);
      const v = await verifyReceiptV2(ctx, b, source);
      const tag = decisionTagCheck(v.claims?.decision_tag, b.decision_tag); // B
      return c.json({ data: { ...v, ...tag, valid: v.valid && tag.decision_tag_valid !== false } });
    }
    const b = z.object({ payload: z.record(z.string(), z.unknown()), sig: z.string(), key_id: z.string(), anchor: anchorInput, decision_tag: expectedDecisionTag.optional() }).parse(raw);
    // The payload is verified as it was SENT, not as the schema copied it (R5-22): the copy drops a member named
    // "__proto__", so such a member could ride on a signed payload and the signature would still verify. The canonical
    // form carries it as an ordinary member, and then the signature does not fit.
    const payload = (raw as { payload: Record<string, unknown> }).payload;
    const v = await verifyReceipt(ctx, { ...b, payload }, source);
    // B: the signed decision tag, and whether it is the order hash the caller computed. A mismatch makes the result invalid.
    const tag = decisionTagCheck(Object.hasOwn(payload, "decision_tag") ? payload.decision_tag : undefined, b.decision_tag);
    return c.json({ data: { ...v, ...tag, valid: v.valid && tag.decision_tag_valid !== false } });
  });
  // The anchor path for a receipt once its hour has been rooted. `anchored` is true only when the root was posted to
  // ReceiptAnchor on chain; without a configured chain the root is kept off chain (status "local") and says so.
  app.get("/api/v1/receipts/:id/proof", async (c) => {
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    const version = g.receiptLeafV2 && c.req.query("v") !== "1" ? 2 : 1;
    const a = await anchorProof(ctx, g, version);
    const leaf = version === 2 ? g.receiptLeafV2 : g.receiptLeaf;
    if (!a) return c.json({ data: { rid: g.id, leaf, leaf_version: version, rooted: false, anchored: false, status: "pending", hint: "Receipts are rooted hourly. Ask again after the next root." } });
    const { index, leaf_index, from, to, ...rest } = a;
    return c.json({ data: { rid: g.id, leaf, leaf_version: version, rooted: true, anchored: a.status === "confirmed" && !!a.tx, anchor_index: index, leaf_index, window: { from, to }, ...rest } });
  });
  // "What we saw": the plain-English privacy label for one answer, computed from its signed receipt (privacy/label.ts).
  // Public by id, like the receipt itself.
  app.get("/api/v1/receipts/:id/privacy", async (c) => {
    const [g] = await ctx.db.select({ id: generations.id, receipt: generations.receipt }).from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    return c.json({ data: await labelForReceipt(ctx, { id: g.id, payload: g.receipt }) });
  });
  app.get("/api/v1/receipts/:id", async (c) => {
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) { const refund = c.req.query("format") ? null : await refundReceipt(ctx, c.req.param("id")); if (refund) return c.json({ data: refund }); } // V6 R
    if (!g) fail(404, "Receipt not found.", "not_found");
    const format = c.req.query("format");
    if (format === "cose") {
      if (!g.receiptCose) fail(404, "This receipt has no v2 (COSE) encoding.", "not_found");
      if (c.req.query("encoding") === "base64") return c.text(g.receiptCose, 200, { "content-type": "text/plain; charset=utf-8" });
      return c.body(Buffer.from(g.receiptCose, "base64"), 200, { "content-type": COSE_CONTENT_TYPE });
    }
    // Receipts carry only hashes and amounts, so they are public proofs by id. The v1 fields stay as they were; v2,
    // when the receipt has one, is added beside them.
    // Both paths come from one tree of the hour (R5-21: this route takes no key, and the tree was built twice per call).
    const proofs = await anchorProofs(ctx, g, g.receiptCose ? [1, 2] : [1]);
    const v2 = g.receiptCose ? { alg: "EdDSA", kid: g.receiptKeyId, content_type: COSE_CONTENT_TYPE, cose: g.receiptCose, claims: g.receiptV2, leaf: g.receiptLeafV2, anchor: proofs[2] ?? null } : null;
    // `privacy` is derived from the payload for readers; it is not part of what is signed.
    return c.json({ data: { id: g.id, version: v2 ? 2 : 1, payload: g.receipt, sig: g.receiptSig, key_id: g.receiptKeyId, leaf: g.receiptLeaf, anchor: proofs[1] ?? null, v2, privacy: await labelForReceipt(ctx, { id: g.id, payload: g.receipt }) } });
  });

  // ---- Rankings: tokens per model/app, and what creators were paid ----
  app.get("/api/v1/rankings", async (c) => {
    const period = c.req.query("period") ?? "day";
    const hours = period === "week" ? 168 : period === "month" ? 720 : 24;
    const since = new Date(Date.now() - hours * 3_600_000);
    const byModel = await ctx.db
      .select({
        model: generations.modelId,
        tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})`,
        requests: sql<string>`count(*)`,
        royalty: sql<string>`coalesce(sum(${generations.royalty}), 0)`,
      })
      .from(generations)
      .where(and(gte(generations.ts, since), sql`${generations.providerId} <> 'cache'`, PUBLIC_LANE_ROWS))
      .groupBy(generations.modelId)
      .orderBy(desc(sql`sum(${generations.tokensIn} + ${generations.tokensOut})`))
      .limit(100);
    const byApp = await ctx.db
      .select({ app: generations.appId, tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})` })
      .from(generations)
      .where(and(gte(generations.ts, since), sql`${generations.appId} IS NOT NULL`, PUBLIC_LANE_ROWS))
      .groupBy(generations.appId)
      .orderBy(desc(sql`sum(${generations.tokensIn} + ${generations.tokensOut})`))
      .limit(50);
    const appRows = byApp.length ? await ctx.db.select().from(apps) : [];
    const appMap = new Map(appRows.map((a) => [a.id, a]));
    const modelRows = await ctx.db.select({ id: models.id, creator: models.creator, royaltyBps: models.royaltyBps }).from(models);
    const mm = new Map(modelRows.map((m) => [m.id, m]));
    return c.json({
      data: {
        period,
        since: since.toISOString(),
        models: byModel.map((r) => ({
          model: r.model,
          tokens: Number(r.tokens),
          requests: Number(r.requests),
          paid_to_creator_usd: picoToUsd(BigInt(r.royalty)),
          creator: mm.get(r.model)?.creator ?? null,
          royalty_bps: mm.get(r.model)?.royaltyBps ?? 0,
        })),
        apps: byApp.map((r) => ({ app: appMap.get(r.app!)?.title ?? appMap.get(r.app!)?.url ?? r.app, url: appMap.get(r.app!)?.url ?? null, tokens: Number(r.tokens) })),
      },
    });
  });

  // ---- Pay with Stock Tokens ----
  app.get("/api/v1/paywith/tokens", (c) =>
    c.json({
      data: {
        contract: ctx.cfg.chain.payWithStock ?? null,
        threshold_usd: ctx.cfg.paywith.thresholdUsd,
        max_age_hours: ctx.cfg.paywith.maxAgeH,
        max_debt_usd: ctx.cfg.paywith.maxDebtUsd,
        tokens: ctx.cfg.paywith.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, feed: t.feed ?? null })),
      },
    }),
  );
  // Pay-with sessions (docs §6): a delegate key per API key with a per-day cap in the token; the owner funds it and can
  // close it (what is left goes back). The EVM-era allowance and charge-authorization routes answer 410.
  app.post("/api/v1/paywith/session", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const v = z.object({ token: z.string().min(1).max(64), wallet: z.string().min(32).max(44), cap_per_day: z.string().regex(/^\d+(\.\d{1,18})?$/) }).parse(await readJson(c));
    const s = await openSession(ctx, k, { token: v.token, wallet: v.wallet, capPerDay: v.cap_per_day });
    c.header("Cache-Control", "no-store");
    return c.json({ data: sessionJson(s) }, 201);
  });
  app.get("/api/v1/paywith/session", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const s = await readSession(ctx, k.chainKeyHash);
    c.header("Cache-Control", "no-store");
    return c.json({ data: s ? sessionJson(s) : null });
  });
  app.post("/api/v1/paywith/close", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const s = await closeSession(ctx, k.chainKeyHash);
    c.header("Cache-Control", "no-store");
    return c.json({ data: sessionJson(s) });
  });
  for (const path of ["/api/v1/paywith/open", "/api/v1/paywith/allowance/typed-data", "/api/v1/paywith/allowance", "/api/v1/paywith/charges", "/api/v1/paywith/charges/:id/signature", "/api/v1/paywith/revoke"])
    app.all(path, () => fail(410, "Signed allowances are an EVM-era surface: open a pay-with session (POST /api/v1/paywith/session) instead.", "gone"));
  app.get("/api/v1/paywith/statement", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, "month must be YYYY-MM.", "invalid_request");
    return c.json({ data: await statement(ctx, k.chainKeyHash, month) });
  });

  // ---- Provider onboarding: apply -> schema check -> bond -> 7-day shadow (canaries) -> live ----
  app.post("/api/v1/providers/apply", async (c) => {
    const data = await submitProviderApplication(ctx, providerApplication.parse(await readJson(c)), c.req.header("x-application-token"));
    return c.json({ data }, 201);
  });

  // Creator royalties: prove you control the model's Hugging Face repo by committing
  // `trellis.json` = {"creator": "0x…", "royalty_bps": 500} to its main branch, then claim.
  app.post("/api/v1/creators/claim", async (c) => {
    const v = z.object({ model: z.string(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await readJson(c));
    const lim = await ctx.limiter.take(`claim:${v.model}`, 1, 10, 3_600_000);
    if (!lim.ok) fail(429, "Too many claim attempts for this model.", "rate_limited");
    const [m] = await ctx.db.select().from(models).where(eq(models.id, v.model));
    if (!m) fail(404, "Unknown model.", "not_found");
    if (!m.hfRepo || !/^[\w.-]+\/[\w.-]+$/.test(m.hfRepo)) fail(400, "This model has no Hugging Face repository on record to prove ownership against.", "no_hf_repo");
    let proof: { creator?: string; royalty_bps?: number };
    try {
      const res = await fetch(`${ctx.cfg.hfBaseUrl}/${m.hfRepo}/raw/main/trellis.json`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      proof = (await res.json()) as typeof proof;
    } catch (e) {
      fail(400, `Could not read trellis.json from ${m.hfRepo} (${(e as Error).message}). Commit {"creator": "${v.address}"} to the repo's main branch.`, "claim_unverified");
    }
    if (String(proof.creator ?? "").toLowerCase() !== v.address.toLowerCase()) fail(403, "trellis.json names a different creator address.", "claim_mismatch");
    const bps = Math.min(2000, Math.max(0, Number.isInteger(proof.royalty_bps) ? proof.royalty_bps! : ctx.cfg.fees.defaultRoyaltyBps));
    await ctx.db.update(models).set({ creator: v.address.toLowerCase(), royaltyBps: bps }).where(eq(models.id, m.id));
    await ctx.catalog.refresh();
    let tx: string | null = null;
    if (ctx.chain.address("royalty") && ctx.chain.roleAddress("router"))
      tx = (await ctx.chain.registerRoyalty(idHash(m.id), v.address, bps).catch((e) => {
        throw new ApiError(502, `Verified, but on-chain registration failed: ${(e as Error).message.slice(0, 150)}`, "chain_failed");
      })).hash;
    return c.json({ data: { model: m.id, creator: v.address.toLowerCase(), royalty_bps: bps, onchain_tx: tx } }, 201);
  });

  // R5-05: the document is the same for every caller and holds a 30-day aggregate over `generations`: it is computed by
  // one caller at a time and kept for STATUS_CACHE_MS (hardening/single-flight.ts; a failed computation is not kept).
  const statusBody = singleFlight(ctx.cfg.hardening.statusCacheMs, async () => {
    await ctx.catalog.ensureFresh();
    return ({
      data: {
        // Raw launch metrics count the public lane only. Attested and unlinkable traffic is published only as noisy
        // hourly counters, at /api/v1/stats.
        launch: await launchMetrics(),
        private_lanes: { lanes: PRIVATE_LANES, stats: "/api/v1/stats", epsilon_spent_today: privateLaneStats(ctx).budget().epsilon_spent_today },
        router: "https://trellis.example", // HD1: canonical public router address.
        network: { hosts_open: ctx.cfg.networkHosts.enabled === true, payouts_open: ctx.cfg.networkPayouts.enabled === true, fee_bps: ctx.cfg.networkPayouts.feeBps },
        // v6 I: ERC-8004 identity, paid feedback and liveness probes; each says whether it is switched on here.
        identity: identityStatus(ctx),
        env: ctx.cfg.env,
        // The running build (RELEASE_COMMIT; null when unset) and whether its contracts were verified.
        release: {
          commit: ctx.cfg.release.commit,
          deployment: {
            status: ctx.cfg.release.deployment.status,
            manifest_sha256: ctx.cfg.release.deployment.manifestSha256,
            manifest_block: ctx.cfg.release.deployment.manifestBlock,
            verified_at_block: ctx.cfg.release.deployment.verifiedAtBlock,
            verifier_revision: ctx.cfg.release.deployment.verifierRevision,
          },
        },
        database: ctx.dbKind,
        redis: !!ctx.cfg.redisUrl,
        chain: ctx.chain.status(),
        // Launch tier: which Trellis programs this router has. A feature whose program is not deployed is off, and says so.
        launch_tier: launchStatus(ctx.cfg.launch),
        // Launch surface: `core` registers only the allow-listed routes and jobs; everything under `off` answers 404
        // `not_enabled`, whatever its own setting says (src/surface/surface.ts).
        launch_surface: { ...(ctx.surface?.status(ctx.jobs.status().map((j) => j.name)) ?? { surface: ctx.cfg.surface }), ignored_settings: ctx.cfg.surfaceIgnored.map((s) => s.setting) },
        // Release switches: the prepared updates and which of them this router has released (src/features.json).
        updates: updatesStatus(ctx.cfg.updates),
        dev_faucet: faucetEnabled(ctx),
        faucet: faucetStatus(ctx),
        // Prepaid credits on trellis_credits (docs/Trellis_Backend.md §5.1): spend-only, capped per key until audit.
        credits: { program: ctx.cfg.chain.credits ?? null, spend_only: true, cap_usdc: Number(ctx.cfg.solana.caps.creditsUnits) / 1e6, closure_refund_delay_h: Math.round(ctx.cfg.solana.closureDelayMs / 3_600_000), tab_cap_usdc: Number(ctx.cfg.solana.caps.tabUnits) / 1e6 },
        receipts: { key_id: ctx.signer.keyId, rotation_days: ctx.cfg.receipts.rotationDays, anchor_interval_ms: ctx.cfg.receipts.anchorIntervalMs },
        settlement: { spent_root_interval_ms: ctx.cfg.workers.settlementIntervalMs },
        fees: { prepaid_bps: 0, per_call_margin_bps: ctx.cfg.fees.perCallMarginBps, provider_fee_bps: ctx.cfg.fees.providerFeeBps, byok_fee_bps: ctx.cfg.fees.byokFeeBps },
        paywith: paywithStatus(ctx),
        // Tab billing (docs §5.2): X-Trellis-Tab + X-Trellis-Tab-Voucher on the chat routes, closed by the tab-close job.
        tabs: tabStatus(ctx),
        // Escrow payments: the tokens it credits, the Stock Token haircut, $TRLS's own terms (null when not accepted)
        // and whether USDC is credited 1:1 (usdc.enabled; its haircut and per-deposit limit are null while off).
        escrow: { enabled: escrowEnabled(ctx), tokens: escrowEnabled(ctx) ? acceptedTokens(ctx).map((t) => t.symbol) : [], haircut_bps: ctx.cfg.escrow.haircutBps, trls: trlsSummary(ctx), usdc: usdcSummary(ctx) },
        ...(ctx.cfg.agentGuardEnabled ? { agent_guard: { enabled: true } } : {}), // V98: preserve status bytes while off
        // Pay another agent: Agent Guard decides, the payer's wallet sends USDC straight to the recipient, the router verifies it.
        agent_pay: { enabled: ctx.cfg.agentPayEnabled },
        per_call: {
          configured: !!ctx.cfg.chain.callPay || x402Enabled(ctx),
          max_usd: ctx.cfg.fees.perCallMaxUsd,
          // x402 v1 and v2 when configured: the network names a payment may carry and the headers read and written.
          x402: {
            configured: x402Enabled(ctx),
            network: ctx.cfg.x402.network,
            versions: X402_VERSIONS,
            networks: [...new Set([ctx.cfg.x402.network, ctx.cfg.chain.network])],
            headers: { payment: ["X-PAYMENT", "PAYMENT-SIGNATURE"], required: "PAYMENT-REQUIRED", response: ["X-PAYMENT-RESPONSE", "PAYMENT-RESPONSE"] },
            // Payment recovery: a lost paid answer is sent again for the payer's signature of `message`, never paid twice.
            recovery: { available: x402Enabled(ctx), header: "PAYMENT-RECOVERY", message: recoveryMessage(ctx.cfg.chain.network, "<payer>", "<nonce>"), ttl_s: RECOVERY_TTL_MS / 1000, max_bytes: RECOVERY_MAX_BYTES, streamed: false /* R5-07: only a non-streamed answer of at most max_bytes is kept */ },
            // The Solana network fee of a sponsored payment is passed through to its payer at cost (zero markup): what
            // was paid in lamports and what was recovered in USDC over the last 30 days, side by side.
            network_fees: await networkFeeAccount(ctx).catch(() => null),
          },
        },
        // v6 F: the hosted x402 facilitator for other sellers; `relay.above_floor` is the last reading taken, null before any.
        facilitator: facilitatorStatus(ctx),
        // v6 T: paying x402 tools from a key's balance; ready only when the market is on and a buyer wallet is set.
        tools: toolsStatus(ctx),
        // v6 L: the honest commerce ledger: whether it is on, which receipt kinds feed it, and whether its filters can work here.
        // Agent agreements: the contracts this router indexes, and whether the isolated jury worker is posting rulings
        // (its fresh heartbeat after matching the oracle's jury on chain; the API itself never holds the signer keys).
        // $TRLS holder tiers: the token, the tier ladder, and whether tiers apply to requests.
        holders: holdersStatus(ctx),
        telemetry: ctx.telemetry.enabled,
        // B: per-call market-data tools and decision tags in receipts; both off unless switched on.
        data_tools: dataToolsStatus(ctx),
        decision_tags: { enabled: ctx.cfg.decisionTagsEnabled, header: "X-Trellis-Decision-Tag" },
        // The onion service that reaches this router over Tor (null when none is configured). Clients that reach it hide
        // their network address from the router; requests carry no address here, so limits for unkeyed calls are shared.
        onion: ctx.cfg.onion.address ? { address: ctx.cfg.onion.address, url: `http://${ctx.cfg.onion.address}` } : null,
        jobs: ctx.jobs.status().map((job) => ({ ...job, last_error: job.last_error ? "Job failed" : null })),
        catalog: { models: ctx.catalog.models.size, providers: ctx.catalog.providers.size },
        // Privacy lanes: how many models and live endpoints can serve each one right now, and the selection weight.
        lanes: laneSummary(ctx),
        makegood: await makegoodStatus(ctx), // V6 R: make-good refunds, from the refund records.
      },
    });
  });
  app.get("/api/v1/status", async (c) => c.json(await statusBody()));
  // R5-05: both readiness routes answer from one cached computation (services/readiness.ts `cachedReadiness`).
  app.get("/ready", async (c) => {
    const result = await cachedReadiness(ctx);
    return c.json(result, result.ok ? 200 : 503);
  });
  app.get("/ready/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(readinessMetrics(await cachedReadiness(ctx)));
  });
  app.get("/health", (c) => c.json({ ok: true }));
}

export { usdToPico };
