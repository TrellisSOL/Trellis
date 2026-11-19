// The core launch surface: the ONLY routes and background jobs that exist on a router running LAUNCH_SURFACE=core
// (see surface.ts). The launch is: tier `credits` (trellis_credits) plus trellis_tab, memo-anchored receipt roots,
// prepaid credits, tabs (X-Trellis-Tab with a session-key voucher, closed by the tab-close job) and x402 per call, one attested third-party gateway as the SEALED supply plus ordinary OPEN providers, zero markup,
// and a dashboard for keys, balance, chat and receipts.
//
// To add a route or a job to the launch: add it here, add it to security/launch-surface/core-routes.txt or
// core-jobs.txt (test/launch-surface.test.ts compares the router's real tables with both), and clear its entries in
// security/DEFERRED.md first. A route is named by the group that registers it in src/app.ts and its exact
// `METHOD path` as Hono records it (`ALL` is a middleware or an all-methods handler).

export const CORE_ROUTES: Record<string, readonly string[]> = {
  // ---- Edge middleware, in the order src/app.ts mounts it ----------------------------------------------------------
  "edge.origin-lock": ["ALL /*"],
  "edge.cors": ["ALL /api/*", "ALL /v1/*"],
  "edge.security-headers": ["ALL /*"],
  "edge.hardening": ["ALL /*"], // body-size caps and the anonymous rate limit
  "edge.budget": ["ALL /*"], // per-request time budget (R4-06)
  "edge.core-request": ["ALL /*"], // refuses request fields and headers that select a non-core feature
  "edge.status": ["ALL /*"], // outcome counters for the status page
  "edge.inference-scope": ["ALL /*"], // stored key scopes stay enforced

  // ---- Inference ---------------------------------------------------------------------------------------------------
  // x402 payment recovery wraps the paid inference routes (a lost paid answer is sent again, never paid twice).
  "x402-recovery": ["ALL /api/v1/chat/completions", "ALL /api/v1/completions", "ALL /api/v1/embeddings"],
  // The hosted x402 facilitator (exact and tab settlement for other sellers; joined the launch on 2026-11-04). The relay
  // pays the network fee and recovers nothing; FACILITATOR_ENABLED switches it on, and it answers 503 until then.
  "edge.cors-facilitator": ["ALL /facilitator/*"],
  facilitator: ["GET /facilitator/supported", "POST /facilitator/settle", "POST /facilitator/verify"],
  chat: ["POST /api/v1/chat/completions", "POST /api/v1/completions", "POST /v1/chat/completions", "POST /v1/completions"],
  embeddings: ["POST /api/v1/embeddings", "POST /v1/embeddings"],
  // Images and video (the media update, src/api/media.ts): registered, and answering 404 `not_enabled` until the `media`
  // release switch is on (src/features.json). Prepaid keys only.
  media: ["GET /api/v1/images/generations/:id", "GET /api/v1/media/files/:id/:n", "GET /api/v1/media/models", "GET /api/v1/videos/generations/:id", "POST /api/v1/images/generations", "POST /api/v1/videos/generations"],
  // The catalogue. `ALL` is the early-access field middleware of the two list routes (inert without a holder token).
  models: ["ALL /api/v1/models", "ALL /v1/models", "GET /api/v1/models", "GET /v1/models", "GET /api/v1/models/:author/:slug/endpoints", "GET /api/v1/providers"],

  // ---- Receipts ----------------------------------------------------------------------------------------------------
  generation: ["GET /api/v1/generation", "GET /api/v1/generations"],
  public: [
    "GET /.well-known/trellis-receipt-keys.json",
    "GET /api/v1/receipts/keys",
    "POST /api/v1/receipts/verify",
    "GET /api/v1/receipts/:id",
    "GET /api/v1/receipts/:id/proof",
    "GET /api/v1/receipts/:id/privacy",
    "GET /api/v1/status",
    "GET /health",
    "GET /ready",
    "GET /ready/metrics",
  ],
  // Make-good refunds, read-only. Make-good is not core in this launch (R5-12: MAKEGOOD_ENABLED is refused and
  // services/makegood.ts issues nothing in core), so this route answers 404 until a later review enables it.
  makegood: ["GET /api/v1/refunds"],

  // ---- Keys, wallet sign-in, prepaid credits ---------------------------------------------------------------------
  keys: [
    "POST /api/v1/keys",
    "GET /api/v1/keys",
    "GET /api/v1/key",
    "GET /api/v1/keys/:hash",
    "PATCH /api/v1/keys/:hash",
    "DELETE /api/v1/keys/:hash",
    "POST /api/v1/auth/wallet/challenge",
    "POST /api/v1/auth/wallet",
    "GET /api/v1/credits",
    "POST /api/v1/credits/deposit-tx",
    "POST /api/v1/credits/owner-tx",
    "POST /api/v1/credits/refund-destination-tx",
    "GET /api/v1/credits/close",
    "POST /api/v1/credits/close",
    "POST /api/v1/credits/close/cancel",
    "POST /api/v1/credits/close/release",
  ],
  deposits: ["GET /api/v1/credits/deposits", "POST /api/v1/credits/deposits"],
  // Paying in $TRLS: mounted in core only with that update released (src/app.ts).
  escrow: ["GET /api/v1/escrow", "GET /api/v1/escrow/trls/price", "GET /api/v1/escrow/deposits"],
  "account-runway": ["GET /api/v1/account/low-balance", "PATCH /api/v1/account/low-balance"],

  // ---- Attestation, status, holder tiers (read-only) -------------------------------------------------------------
  "attestation-history": ["GET /api/v1/attestation/summary", "GET /api/v1/attestation/:providerId/history"],
  attestation: ["GET /api/v1/attestation/:providerId"],
  holders: ["GET /api/v1/holders/tiers"],
  status: [
    "GET /api/v1/status/slo",
    "GET /api/v1/status/incidents",
    "GET /api/v1/status/incidents.atom",
    "GET /api/v1/status/incidents.rss",
    "GET /api/v1/status/incidents/:id",
    // Operator routes: see CORE_ADMIN_ROUTES.
    "POST /api/v1/status/incidents",
    "PATCH /api/v1/status/incidents/:id",
    "POST /api/v1/status/incidents/:id/updates",
  ],

  // ---- The static dashboard (web/out), including /keep/inventory.json and the docs hub ---------------------------
  "site.static": ["ALL /_next/static/*", "ALL /*", "GET /registry/:id/", "GET /registry/:id", "GET /favicon.ico"],
  "site.builtin": ["GET /"],
};

/**
 * The operator routes that remain in core: the status page's incident log, and nothing else (no tRPC, no catalogue,
 * supply, holder or lane administration). Each requires ADMIN_TOKEN and a source address that is loopback or listed in
 * ADMIN_ALLOWED_SOURCES (src/api/lane.ts requireOperator). `GET /api/v1/status/incidents?all=true` is the same check.
 */
export const CORE_ADMIN_ROUTES: readonly string[] = ["POST /api/v1/status/incidents", "PATCH /api/v1/status/incidents/:id", "POST /api/v1/status/incidents/:id/updates"];

/** Background jobs that run in core, by the name they are registered under. */
export const CORE_JOBS: readonly string[] = [
  "catalog-refresh",
  "provider-registry", // provider discovery and registry state
  "health-flush", // passive provider health
  "health-probes",
  "attestor",
  "holds-expire",
  "chain-indexer", // trellis_credits deposits and closures
  "settlement", // spent root, host and gateway payables, closure refunds (its make-good step is off in core, R5-12)
  "receipts-anchor", // memo-anchored receipt roots
  "receipt-key-rotation",
  "x402-recovery-expire", // deletes sealed x402 answers past their 24 hours
  "low-balance-alerts",
  "sanctions-refresh", // the list closure refunds are screened against (when SANCTIONS_SCREENING_ENABLED)
  "alert-notifier", // readiness-driven alerts (monitoring hook)
  "provider-reconcile", // R4-02: what each provider is owed against what the ledger collected, daily
  "tab-close", // posts the highest voucher of a tab near its cap or expiry with trellis_tab::close (joined 2026-11-04)
  "escrow-indexer", // paying in $TRLS: deposits into the escrow wallet; registered in core only with that update released and configured
  "trls-price", // paying in $TRLS: the router's own price readings
  "trls-burn", // paying in $TRLS: burns what credited deposits paid
  "media-jobs", // the media update: follows pending image and video generations to their end; registered only with the switch on
  "job-watchdog", // R4-01: liveness of every job above
];

/**
 * What is off in core, for GET /api/v1/status and the dashboard: a name per feature and one line on what it is.
 * The findings that must be fixed and re-reviewed before a feature is added to the lists above are in security/DEFERRED.md.
 */
export const NON_CORE_FEATURES: Record<string, string> = {
  batches: "Batch API",
  skills: "Skills hub and imports",
  trpc: "tRPC admin API",
  guardrails: "Request-level and key-level guardrails (PII, redaction)",
  council: "Council mode and dual verification",
  rerank: "Rerank",
  rag: "RAG, files and ask-with-documents",
  characters: "Characters",
  arena: "Arena",
  rush: "Rush (upstream credit monitor)",
  agents: "Agents: policy, guard, pay, profiles, directory, certificates, approvals, sessions, playbooks, identity, Telegram",
  tools: "Tools market and data tools",
  "pay-with": "Pay with stock tokens, Swig sessions",
  escrow: "Escrow deposits other than $TRLS, fast credit",
  "network-hosts": "Network hosts, host bonds, slasher, payouts",
  capacity: "Prepaid capacity (Bushels) and HVX",
  "makegood-onchain": "Make-good refunds (ledger credits and refunds paid on chain)",
  blind: "Blind tokens",
  ohttp: "Oblivious HTTP and the onion service",
  "anthropic-shim": "Anthropic Messages API shim",
  "ollama-shim": "Ollama API shim",
  responses: "OpenAI Responses API shim",
  mcp: "MCP server",
  e2ee: "Encrypted pass-through",
  teams: "Teams",
  webhooks: "Webhooks and spend alerts",
  statements: "Statements, proof packs served by the router, lane reports, insights",
  supply: "Supply adapters, auto-listing, day-zero lane, catalogue administration",
  "honest-ledger": "Honest ledger",
  "account-extras": "Saved routes, presets, memory, BYOK, response cache, transforms, inbox, activity feed, runway",
  royalties: "Creator claims and royalties",
  "program-anchor": "Receipt roots in the anchor program (core anchors by memo)",
  measurements: "Measurement bundles, transparency log, IPX",
  faucet: "Development faucet",
};
