import { accountRunwayRoutes } from "./api/account-runway.ts"; // B119
import { hardeningMiddleware, originLockMiddleware } from "./hardening/middleware.ts"; // HD1
import { internalEnv } from "./hardening/client.ts"; // HD1
import { initializeUpstreamMonitor } from "./rush/monitor.ts"; // ON3
import { facilitatorRoutes } from "./solana/facilitator.ts"; // v6 F: hosted x402 facilitator
import { toolsRoutes } from "./tools/routes.ts"; // v6 T: paid tool market, off by default.
import { firstCallRoutes, firstCallCsp } from "./developers/first-call.ts"; // ON2
import { inferenceScopeMiddleware, keyDefaultsRoutes } from "./provisioning/scope.ts"; // ZK6
import { structuredOutputMiddleware } from "./structured-output/chat.ts"; // V83
import { paymentRecovery } from "./solana/recovery.ts";
import { statementRoutes } from "./api/statements.ts"; // V87
import { proofPackRoutes } from "./api/proof-pack.ts"; // U100
import { laneReportRoutes } from "./api/lane-report.ts"; // Lane report
import { insightsRoutes } from "./api/insights.ts"; // V88: spend insights.
import { webhookRoutes } from "./webhooks/routes.ts"; // V86: signed destinations.
import { makegoodRoutes } from "./services/makegood.ts"; // V6 R: make-good refunds.
import { inboxRoutes } from "./api/inbox.ts"; // U78: account inbox.
import { activityRoutes } from "./api/activity.ts";
import { networkStatsRoutes } from "./network/stats.ts";
import { agentProfilesRoutes } from "./api/agent-profiles.ts";
import { identityRoutes } from "./identity/routes.ts"; // v6 I: before the rulebook routes, which 404 without AGENT_POLICY_ENABLED.
import { agentSealedRoutes } from "./api/agent-sealed.ts";
import { telegramLinkingRoutes } from "./api/telegram-linking.ts";
import { weeklySummaryRoutes } from "./api/weekly-summary.ts"; // B120
import { agentLedgerMiddleware } from "./agents/ledger-context.ts";
import { agentLedgerRoutes } from "./api/agent-ledger.ts";
import { networkHostRoutes } from "./api/network-hosts.ts";
import { networkSanctionsRoutes } from "./api/network-sanctions.ts";
import { e2eeRoutes } from "./api/e2ee.ts";
import { hostBondRoutes } from "./network/bonds.ts";
import { guardHostSlasher } from "./network/bond-config.ts";
import { configureNetworkRouting } from "./network/routing.ts";
import { siteCsp } from "./lib/csp.ts";
import { zkapiHosting } from "./zkapi/hosting.ts"; // ZK10
import { EXPOSED_RESPONSE_HEADERS, viaOnion } from "./api/common.ts";
import { onionIngress } from "./onion/ingress.ts";
import { kv } from "./db/schema.ts";
import { Hono } from "hono";
import { Surface, API_NAMESPACE, NOT_ENABLED } from "./surface/surface.ts";
import { requestBudgetMiddleware } from "./hardening/budget.ts";
import { agentsInCore, coreRequestMiddleware } from "./surface/request.ts";
import { configureAgentPolicies } from "./agents/enforce.ts";
import { configureApprovals } from "./agents/approvals.ts";
import { serveStatic } from "hono/bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { loadConfig } from "./config.ts";
import { openDatabase, type DbHandle } from "./db/client.ts";
import { Catalog } from "./catalog/catalog.ts";
import { HealthTracker } from "./services/health.ts";
import { ReceiptSigner } from "./receipts/signer.ts";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./lib/ratelimit.ts";
import { ChainService } from "./solana/chain-service.ts";
import { ResponseCache } from "./gateway/cache.ts";
import { Telemetry } from "./gateway/otel.ts";
import { TracingExporter } from "./services/tracing.ts";
import { Jobs } from "./services/jobs.ts";
import type { Ctx } from "./context.ts";
import { ApiError } from "./lib/errors.ts";
import { log, setLogLevel } from "./lib/util.ts";
import { chatRoutes } from "./api/chat.ts";
import { modelsRoutes } from "./api/models.ts";
import { generationRoutes } from "./api/generation.ts";
import { hvxRoutes } from "./api/hvx.ts";
import { supplyRoutes } from "./api/supply.ts";
import { bushelRoutes } from "./api/bushels.ts";
import { ledgerRoutes } from "./api/ledger.ts";
import { keysRoutes } from "./api/keys.ts";
import { teamsRoutes } from "./api/teams.ts";
import { escrowRoutes } from "./api/escrow.ts";
import { depositRoutes } from "./api/deposits.ts"; // V97B
import { savedRoutesRoutes } from "./api/saved-routes.ts";
import { presetsRoutes } from "./api/presets.ts";
import { characterRoutes } from "./api/characters.ts";
import { memoryRoutes } from "./api/memory.ts";
import { agentCertificatesRoutes } from "./api/agent-certificates.ts";
import { guardRoutes } from "./api/guard.ts"; // V98
import { agentPayRoutes } from "./api/agent-pay.ts"; // Pay another agent
import { agentsRoutes } from "./api/agents.ts";
import { playbooksRoutes } from "./api/playbooks.ts"; // U115
import { agentApprovalMiddleware, agentApprovalsRoutes } from "./api/agent-approvals.ts";
import { agentSessionsRoutes } from "./api/agent-sessions.ts";
import { spendRoutes } from "./api/spend.ts";
import { holdersRoutes } from "./api/holders.ts";
import { estimateRoutes } from "./api/estimate.ts"; // Update 13: Price check
import { disclosureRoutes } from "./api/disclosure.ts";
import { ipxRoutes } from "./api/ipx.ts";
import { dataToolsRoutes } from "./data-tools/routes.ts"; // B: per-call market-data tools.
import { attestationRoutes } from "./api/attestation.ts";
import { attestationHistoryRoutes } from "./api/attestation-history.ts";
import { measurementRoutes } from "./api/measurements.ts";
import { laneRoutes } from "./api/lane.ts";
import { dayzeroRoutes } from "./api/dayzero.ts";
import { creatorClaimRoutes } from "./api/creator-claims.ts";
import { publicRoutes } from "./api/public.ts";
import { embeddingsRoutes } from "./api/embeddings.ts";
import { mediaRoutes } from "./api/media.ts";
import { batchesRoutes } from "./api/batches.ts";
import { rerankRoutes } from "./api/rerank.ts";
import { adminRoutes } from "./admin/trpc.ts";
import { registerJobs } from "./services/register.ts";
import { mcpRoutes } from "./api/mcp.ts";
import { anthropicRoutes } from "./api/anthropic.ts";
import { ollamaRoutes } from "./ollama/routes.ts";
import { responsesRoutes } from "./api/responses.ts";
import { ragRoutes } from "./api/rag.ts";
import { siteRoutes } from "./api/site.ts";
import { badgeRoutes } from "./api/badge.ts";
import { BlindIssuer } from "./blind/issuer.ts";
import { ensurePool } from "./blind/redeem.ts";
import { blindRoutes } from "./blind/routes.ts";
import { OhttpKeys } from "./ohttp/keys.ts";
import { ohttpRoutes } from "./ohttp/gateway.ts";
import { hostAnchorRoutes } from "./api/host-anchor.ts";
import { hostRoutes } from "./api/hosts.ts";
import { TransparencyLog } from "./tlog/log.ts";
import { networkPolicyRoutes } from "./network/routes.ts";
import { tlogRoutes } from "./tlog/routes.ts";
import { statusRoutes } from "./api/status.ts";
import { networkRoutes } from "./network/waitlist.ts";
import { skillsRoutes } from "./api/skills.ts";
import { startStatusLoop, statusMiddleware } from "./services/slo.ts";

export type AppOptions = {
  env?: Record<string, unknown>;
  rand?: () => number;
  chain?: ChainService;
  startJobs?: boolean;
  /** Already initialized, caller-owned database for embedding or sharing an in-memory test store. */
  database?: Pick<DbHandle, "db" | "kind">;
};

export async function createApp(opts: AppOptions = {}) {
  const cfg = loadConfig(opts.env ?? {});
  await guardHostSlasher(cfg);
  setLogLevel(cfg.logLevel);
  const ownedDatabase = opts.database ? undefined : await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
  const handle = opts.database ?? ownedDatabase!;
  const redis = cfg.redisUrl ? new (await import("ioredis")).Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  const limiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
  const signer = new ReceiptSigner(handle.db, cfg.appSecret, cfg.receipts.rotationDays, cfg.receipts.signingKey, cfg.receipts.keySyncMs);
  await signer.init();
  const catalog = new Catalog(handle.db);
  await catalog.refresh();
  const health = new HealthTracker(cfg.routing.outageWindowMs);
  configureNetworkRouting(health, cfg.networkWeights);
  await health.refreshAggregates(handle.db).catch(() => undefined);

  const surface = new Surface(cfg.surface);
  if (cfg.surfaceIgnored.length) log.warn("launch surface core: settings for features that are not on it were ignored", { settings: cfg.surfaceIgnored.map((s) => s.setting) });
  const ctx: Ctx = {
    cfg,
    surface,
    db: handle.db,
    dbKind: handle.kind,
    catalog,
    health,
    signer,
    limiter,
    chain: opts.chain ?? new ChainService(cfg),
    cache: new ResponseCache(cfg.appSecret, 5_000, redis),
    telemetry: new Telemetry(cfg.gateway.otlpEndpoint, cfg.gateway.otelServiceName),
    tracing: new TracingExporter(cfg.appSecret),
    jobs: new Jobs(cfg.redisUrl, async (state) => {
      const value = { ...state, last_error: state.last_error ? "Job failed; inspect private operator logs." : null };
      await handle.db.insert(kv).values({ key: `job-health:${state.name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    }, cfg.runtimeRole === "worker" ? cfg.workerJobs : undefined, (name) => surface.jobAllowed(name)),
    rand: opts.rand,
    blind: cfg.blind.enabled ? new BlindIssuer(handle.db, cfg) : undefined,
    ohttp: cfg.ohttp.enabled ? new OhttpKeys(handle.db, cfg) : undefined,
    tlog: cfg.tlog.enabled ? new TransparencyLog(handle.db, cfg.tlog).start() : undefined,
  };
  if (ctx.blind) await ensurePool(ctx);

  await initializeUpstreamMonitor(ctx); // ON3
  const webDir = resolve(cfg.webDir ?? resolve(import.meta.dir, "../web/out"));
  const webBuilt = existsSync(resolve(webDir, "index.html"));
  const csp = webBuilt ? siteCsp(webDir) : "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
  // Launch surface (src/surface/surface.ts): every route below is registered inside `mount(<group>, ...)`, and in
  // LAUNCH_SURFACE=core only the groups and the exact routes on the checked-in allow-list (src/surface/core-allowlist.ts)
  // reach the router. A group that is not listed is not called at all. This is the one place routes are registered.
  const app = new Hono({ router: surface.router() });
  const mount = (group: string, register: () => void) => surface.mount(group, register);
  mount("edge.origin-lock", () => app.use("*", originLockMiddleware(ctx))); // HD1: authenticate ingress before CORS, including preflights.
  // The OpenAI-style /v1/* aliases get the same CORS as /api/*, so a browser can read the receipt, lane and policy headers on either.
  const apiCors = cors({ origin: "*", allowHeaders: ["x-agent-approval", "authorization", "content-type", "x-e2ee-version", "x-client-pub-key", "x-model-pub-key", "x-e2ee-nonce", "x-e2ee-timestamp", "x-pay-with", "x-payment", "payment-signature", "payment-recovery", "x-wallet-auth", "x-trellis-cache", "x-trellis-disclosure-max", "x-trellis-lane", "x-trellis-lane-downgrade", "x-trellis-decision-tag", "http-referer", "x-title", "traceparent", "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"], exposeHeaders: [...EXPOSED_RESPONSE_HEADERS, ...(cfg.routeExplain ? ["x-trellis-route"] : []), /* V84 */ ...(cfg.structuredOutputCheckEnabled ? ["x-trellis-json-check"] : []), /* V83 */ "x-e2ee-applied", "x-e2ee-version", "x-e2ee-algo", "x-e2ee-receipt-id"] });
  mount("edge.cors", () => { app.use("/api/*", apiCors); app.use("/v1/*", apiCors); });
  mount("edge.cors-ollama", () => app.use("/ollama/*", apiCors));
  mount("edge.cors-facilitator", () => app.use("/facilitator/*", apiCors)); // v6 F
  if (webBuilt && cfg.zkapiPageOrigins.length) mount("edge.zkapi-hosting", () => app.use("*", zkapiHosting(csp, cfg.zkapiPageOrigins))); // ZK10: narrowly scoped static policies.
  mount("edge.security-headers", () => app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      c.header("content-security-policy", firstCallCsp(c.req.method, c.req.path, cfg.developerFirstCallEnabled) ?? csp); // ON2: retain the script-free endpoint page policy.
      // Tell Tor Browser this page has an onion twin (only on the clearnet site; it does nothing without ONION_ADDRESS).
      if (cfg.onion.address && c.req.method === "GET" && !viaOnion(c, cfg)) {
        const url = new URL(c.req.url);
        c.header("onion-location", `http://${cfg.onion.address}${url.pathname}${url.search}`);
      }
    }
    if (cfg.production) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }));

  mount("edge.hardening", () => app.use("*", hardeningMiddleware(ctx))); // HD1: after CORS/security headers, before every body reader.
  mount("edge.budget", () => app.use("*", requestBudgetMiddleware(ctx))); // R4-06: a wall-clock budget per request.
  if (surface.core) mount("edge.core-request", () => app.use("*", coreRequestMiddleware(ctx))); // headers and credentials that select a non-core feature: 404 not_enabled
  mount("edge.onion-ingress", () => app.use("*", onionIngress(cfg))); // onion requests: drop every client address header before any route reads one
  mount("edge.status", () => app.use("*", statusMiddleware(ctx))); // public-lane outcomes per API surface for /api/v1/status/slo; private lanes are not counted here
  mount("edge.inference-scope", () => app.use("*", inferenceScopeMiddleware(ctx))); // ZK6: deny by default before account middleware.
  // Agent keys. In core: only with that update released and rulebooks switched on (src/surface/updates.ts), and then
  // only the rulebook, approval and ledger routes on the allow-list. The engine itself is switched here, not by a
  // route group being mounted, so a router that applies rulebooks never depends on which routes it serves.
  configureAgentPolicies(ctx);
  configureApprovals(ctx.db, cfg.agentApprovalTtlS);
  const agentsOn = !surface.core || agentsInCore(ctx);
  if (agentsOn) mount("edge.agent-ledger", () => app.use("*", agentLedgerMiddleware(ctx)));
  if (agentsOn) mount("edge.agent-approval", () => app.use("*", agentApprovalMiddleware(ctx)));
  mount("x402-recovery", () => { paymentRecovery(app, ctx); }); // a lost x402 answer is sent again, never paid twice; outside every other route middleware
  mount("structured-output", () => { structuredOutputMiddleware(app, ctx); }); // V83: ordinary chat routes bill each call.
  mount("first-call", () => { firstCallRoutes(app, cfg.developerFirstCallEnabled, cfg.siteUrl); }); // ON2: the public site address, not the router host
  mount("chat", () => { chatRoutes(app, ctx); });
  mount("e2ee", () => { e2eeRoutes(app, ctx); });
  mount("embeddings", () => { embeddingsRoutes(app, ctx); });
  mount("media", () => { mediaRoutes(app, ctx); }); // the media update: images and video; 404 not_enabled until its switch is on
  mount("batches", () => { batchesRoutes(app, ctx); });
  mount("rerank", () => { rerankRoutes(app, ctx); });
  mount("models", () => { modelsRoutes(app, ctx); });
  mount("generation", () => { generationRoutes(app, ctx); });
  mount("hvx", () => { app.route("/api/v1/hvx", hvxRoutes(ctx)); }); // public read-only index (docs/Trellis_Backend.md §5.6)
  mount("honest-ledger", () => { ledgerRoutes(app, ctx); }); // Honest Ledger: public daily x402 volume after the wash filter (§9)
  mount("bushels", () => { bushelRoutes(app, ctx); }); // prepaid capacity (§5.6); answers 503 prepaid_capacity_disabled until BUSHELS_ENABLED
  mount("supply", () => { supplyRoutes(app, ctx); }); // operator: warm pool and catalogue auto-listing (§2)
  mount("activity", () => { activityRoutes(app, ctx); });
  mount("statements", () => { statementRoutes(app, ctx); }); // V87
  mount("proof-pack", () => { proofPackRoutes(app, ctx); }); // U100
  mount("lane-report", () => { laneReportRoutes(app, ctx); }); // Lane report: read-only, with statements
  mount("insights", () => { insightsRoutes(app, ctx); }); // V88: read-only, off by default.
  mount("account-runway", () => { accountRunwayRoutes(app, ctx); }); // B119
  mount("inbox", () => { inboxRoutes(app, ctx); }); // U78: account inbox.
  mount("key-defaults", () => { keyDefaultsRoutes(app, ctx); }); // ZK6: before /keys/:hash.
  mount("keys", () => { keysRoutes(app, ctx); });
  mount("teams", () => { teamsRoutes(app, ctx); });
  if (!surface.core || cfg.updates.trls) mount("escrow", () => { escrowRoutes(app, ctx); }); // in core: only with paying in $TRLS released
  mount("deposits", () => { depositRoutes(app, ctx); }); // V97B: account-owned deposit progress, both lanes.
  mount("saved-routes", () => { savedRoutesRoutes(app, ctx); });
  mount("presets", () => { presetsRoutes(app, ctx); });
  mount("characters", () => { characterRoutes(app, ctx); });
  mount("memory", () => { memoryRoutes(app, ctx); });
  mount("agent-profiles", () => { agentProfilesRoutes(app, ctx); });
  mount("identity", () => { identityRoutes(app, ctx); }); // v6 I
  mount("agent-sealed", () => { agentSealedRoutes(app, ctx); });
  if (agentsOn) mount("agents", () => { agentsRoutes(app, ctx); });
  mount("playbooks", () => { playbooksRoutes(app, ctx); }); // U115: after agentsRoutes, whose /api/v1/agents/* switch also covers the follow route.
  mount("agent-guard", () => { guardRoutes(app, ctx); }); // V98
  mount("agent-pay", () => { agentPayRoutes(app, ctx); }); // Pay another agent (AGENT_PAY_ENABLED)
  mount("agent-certificates", () => { agentCertificatesRoutes(app, ctx); });
  if (agentsOn) mount("agent-ledger", () => { agentLedgerRoutes(app, ctx); });
  if (agentsOn) mount("agent-approvals", () => { agentApprovalsRoutes(app, ctx); });
  mount("telegram", () => { telegramLinkingRoutes(app, ctx); });
  mount("weekly-summary", () => { weeklySummaryRoutes(app, ctx); }); // B120
  mount("agent-sessions", () => { agentSessionsRoutes(app, ctx); });
  mount("spend", () => { spendRoutes(app, ctx); });
  mount("webhooks", () => { webhookRoutes(app, ctx); }); // V86.
  mount("makegood", () => { makegoodRoutes(app, ctx); }); // V6 R.
  mount("holders", () => { holdersRoutes(app, ctx); });
  if (cfg.updates.estimate) mount("estimate", () => { estimateRoutes(app, ctx); }); // Update 13, Price check: only with its switch on, on either surface
  mount("disclosure", () => { disclosureRoutes(app, ctx); });
  mount("ipx", () => { ipxRoutes(app, ctx); });
  mount("data-tools", () => { dataToolsRoutes(app, ctx); }); // B
  mount("attestation-history", () => { attestationHistoryRoutes(app, ctx); }); // before attestationRoutes: /attestation/summary must not be read as a provider id
  mount("attestation", () => { attestationRoutes(app, ctx); });
  if (ctx.cfg.hostDashboard.enabled) mount("host-dashboard", () => { hostRoutes(app, ctx); });
  mount("host-bonds", () => { hostBondRoutes(app, ctx); });
  mount("measurements", () => { measurementRoutes(app, ctx); });
  mount("badge", () => { badgeRoutes(app, ctx); });
  mount("lane", () => { laneRoutes(app, ctx); });
  mount("dayzero", () => { dayzeroRoutes(app, ctx); });
  mount("creator-claims", () => { creatorClaimRoutes(app, ctx); });
  if (ctx.blind && (!surface.core || cfg.updates.blind)) mount("blind", () => { blindRoutes(app, ctx); }); // in core: only with the blind update released
  if (ctx.ohttp) mount("ohttp", () => { ohttpRoutes(app, ctx); });
  if (ctx.cfg.hostAnchor.enabled) mount("host-anchor", () => { hostAnchorRoutes(app, ctx); });
  if (ctx.tlog) mount("tlog", () => { tlogRoutes(app, ctx); });
  mount("network-policy", () => { networkPolicyRoutes(app, ctx); });
  mount("status", () => { statusRoutes(app, ctx); });
  mount("skills", () => { skillsRoutes(app, ctx); });
  mount("tools", () => { toolsRoutes(app, ctx); }); // v6 T: registers nothing unless TOOLS_MARKET_ENABLED.
  mount("network-waitlist", () => { networkRoutes(app, ctx); });
  mount("public", () => { publicRoutes(app, ctx); });
  mount("network-sanctions", () => { networkSanctionsRoutes(app, ctx); });
  mount("network-hosts", () => { networkHostRoutes(app, ctx); });
  mount("network-stats", () => { networkStatsRoutes(app, ctx); });
  mount("mcp", () => { mcpRoutes(app, ctx); });
  mount("anthropic", () => { anthropicRoutes(app, ctx); });
  mount("ollama", () => { ollamaRoutes(app, ctx); });
  mount("responses", () => { responsesRoutes(app, ctx); });
  mount("rag", () => { ragRoutes(app, ctx); });
  mount("facilitator", () => { facilitatorRoutes(app, ctx); }); // v6 F: answers 503 facilitator_disabled until FACILITATOR_ENABLED
  mount("admin-trpc", () => { adminRoutes(app, ctx); });
  // The website (web/out, a static Next.js export) is served at / when it has been built; otherwise
  // a small built-in page lists models and rankings.

  if (webBuilt) mount("site.static", () => {
    app.use("/_next/static/*", async (c, next) => {
      await next();
      c.header("cache-control", "public, max-age=31536000, immutable");
    });
    const serveWeb = serveStatic({ root: webDir });
    app.use("*", async (c, next) => {
      const url = new URL(c.req.url), canonical = new URL(ctx.cfg.publicUrl);
      if (c.req.method === "GET" && c.req.header("accept")?.includes("text/html") && url.hostname === "www." + canonical.hostname && canonical.protocol === "https:") {
        canonical.pathname = url.pathname;
        canonical.search = url.search;
        return c.redirect(canonical.href, 307);
      }
      return serveWeb(c, next);
    });
    // /registry/<provider id>/ is one static page (exported as /registry/_/) that reads the id from the address.
    const registryShell = resolve(webDir, "registry/_/index.html");
    if (existsSync(registryShell)) {
      const html = readFileSync(registryShell, "utf8");
      app.get("/registry/:id/", (c) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.req.param("id")) ? c.html(html) : c.notFound()));
      app.get("/registry/:id", (c) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.req.param("id")) ? c.redirect(`/registry/${c.req.param("id")}/`, 308) : c.notFound()));
    }
    if (existsSync(resolve(webDir, "brand/trellis-symbol.png"))) app.get("/favicon.ico", (c) => c.redirect("/brand/trellis-symbol.png", 301));
  });
  else mount("site.builtin", () => { siteRoutes(app, ctx); });
  surface.prune(app);
  const notFoundPage = webBuilt && existsSync(resolve(webDir, "404.html")) ? readFileSync(resolve(webDir, "404.html"), "utf8") : null;

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const api = API_NAMESPACE.test(path);
    if (notFoundPage && c.req.method === "GET" && !api) return c.html(notFoundPage, 404);
    // LAUNCH_SURFACE=core: nothing outside the allow-list is registered, so an API path that matches no route is, as far
    // as this router is concerned, a feature that is not enabled here. One answer for all of them: 404 `not_enabled`.
    if (surface.core && (api || c.req.method !== "GET"))
      return c.json(new ApiError(404, `${c.req.method} ${path} is not enabled on this router (launch surface: core). GET /api/v1/status lists what is.`, NOT_ENABLED, { launch_surface: "core" }).toJSON(), 404);
    return c.json(new ApiError(404, `No route for ${c.req.method} ${path}.`, "not_found").toJSON(), 404);
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(err.toJSON(), err.status as never);
    }
    if (err instanceof ZodError) {
      return c.json(new ApiError(400, "Invalid request: " + err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "invalid_request").toJSON(), 400);
    }
    if ((err as Error)?.name === "AbortError") return c.json(new ApiError(499, "Client closed the request.", "cancelled").toJSON(), 499 as never);
    log.error("unhandled error", { path: new URL(c.req.url).pathname, error: (err as Error)?.message, stack: (err as Error)?.stack?.split("\n").slice(0, 5).join(" | ") });
    return c.json(new ApiError(500, "Internal router error.", "internal").toJSON(), 500);
  });

  // Batch lines are dispatched in process with a marker in `env` that no network request can carry (router/batch-line.ts).
  registerJobs(ctx, (path, init) => app.request(path, init, internalEnv()), (path, init, env) => app.request(path, init, internalEnv(env) as never));
  if (opts.startJobs ?? cfg.workers.enabled) await ctx.jobs.start();

  // Passive health belongs to each API replica, not the shared registry worker's memory.
  const healthTimer = cfg.runtimeRole === "api" ? setInterval(() => void ctx.health.flush(ctx.db).catch(() => undefined), 5000) : null;
  healthTimer?.unref();
  const stopStatus = startStatusLoop(ctx);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (healthTimer) clearInterval(healthTimer);
    signer.close();
    await stopStatus();
    await ctx.telegram?.stop();
    await ctx.jobs.stop();
    await ctx.tlog?.stop();
    await ctx.health.flush(ctx.db).catch(() => undefined);
    await ctx.telemetry.close();
    await ctx.tracing.close();
    await limiter.close();
    redis?.disconnect();
    await ownedDatabase?.close();
  };
  return { app, ctx, close, fetch: app.fetch };
}
