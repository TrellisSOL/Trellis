import { depositPingsEnv } from "./solana/deposit-pings-config.ts"; // B123
import { hardeningEnv, hardeningSettings } from "./hardening/config.ts"; // HD1
import { rpcEnv, rpcSettings } from "./solana/rpc-config.ts"; // RPC1: private transport settings.
import { fastCreditEnv, fastCreditSettings } from "./solana/fast-credit-config.ts"; // V97
import { identityEnv, identitySettings } from "./identity/config.ts"; // v6 I: receipt-backed identity and reputation.
import { accountRuntimeSchema } from "./solana/account-policy.ts";
import { ADDRESS_RE, DEFAULT_PUBLIC_RPC, SOLANA_MAINNET_CAIP2, USDC_MINT } from "./solana/constants.ts";
import { rushEnv, rushSettings } from "./rush/config.ts"; // ON3
import { toolsEnv, toolsSettings } from "./tools/config.ts"; // v6 T: paid tool market.
import { loadHoldConfig } from "./router/hold-config.ts"; // R3-02 / R3-25: the hold bound (settings live in that file).
import { zkapiPageEnv } from "./zkapi/page-config.ts"; // ZK10: opt-in static-page origins.
import { structuredOutputEnv } from "./structured-output/options.ts"; // V83: opt-in JSON checking.
import { insightsEnv } from "./insights/config.ts"; // V88: off by default.
import { dataToolsEnv, dataToolsSettings } from "./data-tools/config.ts"; // B: off by default.
import { decisionTagEnv } from "./receipts/decision-tag.ts"; // B: off by default.
import { networkStatsEnv } from "./network/stats-config.ts";
import { sealedEnv, guardSealed } from "./agents/sealed/config.ts";
import { networkPayoutEnv, networkPayoutSettings } from "./network/payout-config.ts";
import { hostBondEnv, hostBondSettings } from "./network/bond-config.ts";
import { networkHostsEnv, networkHostsSettings } from "./network/host-config.ts";
import { sanctionsEnv, sanctionsSettings } from "./network/config.ts";
import { facilitatorEnv, facilitatorSettings } from "./solana/facilitator-config.ts"; // v6 F: hosted x402 facilitator
import { resolveSurface } from "./surface/config.ts"; // LAUNCH_SURFACE: the default-deny launch surface
import { resolveUpdates } from "./surface/updates.ts"; // release switches: src/features.json, UPDATES.md
import { assertLaunchTier, launchEnv, launchSettings } from "./solana/launch-config.ts"; // launch tiers and the receipt-anchor mode
import { e2eeSettings } from "./e2ee/config.ts";
import { networkWeightEnv, networkWeightSettings } from "./network/weight-config.ts";
import { supplyEnv, supplySettings } from "./supply/config.ts"; // §2: Nosana / io.net warm pool, off by default.
import { bushelEnv, bushelSettings } from "./capacity/config.ts"; // §5.6: prepaid capacity, off by default.
import { autoListEnv, autoListSettings } from "./catalog/auto-list-config.ts"; // §2: catalogue auto-listing.
import { honestLedgerEnv, honestLedgerSettings } from "./stats/config.ts"; // §9: Honest Ledger.
import { createHash, createHmac, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { usdToPico } from "./lib/money.ts";
import { parseOnionAddress, parseOnionSecrets } from "./lib/onion.ts";
import { parseModelMap } from "./anthropic/models.ts";
import { parseSignerKey, parseVerifierKey, SIG_COSIGNATURE_V1, validKeyName, type NoteVerifier } from "./tlog/note.ts";

// Every setting comes from the environment. Missing optional services produce
// an explicit "unavailable" state at runtime; they never fake success.

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (d: number) => z.coerce.number().int().default(d);
const num = (d: number) => z.coerce.number().default(d);
const addr = z
  .string()
  .regex(ADDRESS_RE, "must be a base58 Solana address")
  .optional()
  .or(z.literal("").transform(() => undefined));
const pk = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "must be a base58 64-byte ed25519 secret key")
  .optional()
  .or(z.literal("").transform(() => undefined));
const opt = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));
// The IPX oracle key signs index-price messages only (ed25519 or secp256k1-eip191 over a SHA-256 digest, see
// src/services/ipx-oracle-sign.ts) and is never a chain role, so it keeps the 32-byte hex form that signer takes.
const oraclePk = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
  .optional()
  .or(z.literal("").transform(() => undefined));

/** The measurement public key, normalised to a PEM string; throws on anything that is not an ECDSA P-256 public key. */
function measurementPublicKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\\n/g, "\n").trim();
  if (/PRIVATE KEY/.test(text)) throw new Error("MEASUREMENT_PUBLIC_KEY must be the public key; a private key was given.");
  try {
    const key = text.includes("BEGIN") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not P-256");
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new Error("MEASUREMENT_PUBLIC_KEY must be an ECDSA P-256 public key (PEM or base64 SPKI).");
  }
}

const schema = z.object({
  ...hardeningEnv, // HD1
  ...fastCreditEnv, // V97
  ...depositPingsEnv, // B123
  ...identityEnv, // v6 I
  ...zkapiPageEnv, // ZK10
  ...toolsEnv, // v6 T
  ...rushEnv, // ON3
  DEVELOPER_FIRST_CALL_ENABLED: bool.default(false), // ON2: guidance for GETs to model endpoints.
  ...structuredOutputEnv, // V83
  ...insightsEnv, // V88: spend insights.
  ...dataToolsEnv, // B: per-call market-data tools.
  ...decisionTagEnv, // B: X-Trellis-Decision-Tag in receipts.
  ...sealedEnv,
  ...hostBondEnv,
  ...networkWeightEnv,
  ...sanctionsEnv,
  ...facilitatorEnv, // v6 F
  ...launchEnv, // LAUNCH_TIER, ANCHOR_MODE, ANCHORER_ADDRESS, ANCHORER_KEYS
  ...networkHostsEnv,
  ...networkStatsEnv,
  INFERENCE_KEYS_ENABLED: bool.default(false), // ZK6: minting restricted keys; stored scopes are always enforced.
  WEBHOOK_SIGNING_ENABLED: bool.default(false), // V86: signed account webhooks.
  MAKEGOOD_ENABLED: bool.default(false), // V6 R: deterministic make-good refunds.
  MAKEGOOD_REFUND_PRIVATE_KEY: pk, // V6 R: treasury key for on-chain refunds to per-call payers; worker only, never logged.
  ...networkPayoutEnv,
  ...supplyEnv, // §2
  ...bushelEnv, // §5.6
  ...autoListEnv, // §2
  ...honestLedgerEnv, // §9
  // The launch surface (src/surface/surface.ts). `core`: only the allow-listed routes and jobs exist. `all` needs the
  // acknowledgement below in production. Both are read by resolveSurface before this schema; they are declared here so
  // the names are known settings.
  LAUNCH_SURFACE: z.enum(["core", "all"]).default("core"),
  LAUNCH_SURFACE_ACK: opt,
  // Operator routes (ADMIN_TOKEN) are answered only to a loopback caller or to a source address listed here: a comma
  // list of addresses and IPv4 CIDR blocks. Enforced always in LAUNCH_SURFACE=core, and elsewhere once a list is set.
  ADMIN_ALLOWED_SOURCES: z.string().default(""),
  RUNTIME_ROLE: z.enum(["all", "api", "worker"]).default("all"),
  WORKER_JOBS: z.string().default(""),
  AUTO_MIGRATE: bool.default(true),
  // Images and video (the media update): the id of the provider whose API carries image and video generation, and how many
  // generations one account may order a minute.
  MEDIA_PROVIDER_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default("relay"),
  MEDIA_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(12),
  TRELLIS_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),
  PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8787"),
  // B116: address shown in links people open; default: PUBLIC_BASE_URL. Signed receipt issuers stay unchanged.
  SITE_URL: z.string().url().optional(),
  // Passkeys for organisation members (WebAuthn). Default: the host and origin of PUBLIC_BASE_URL, where the dashboard is served.
  WEBAUTHN_RP_ID: opt,
  WEBAUTHN_ORIGINS: opt, // comma-separated origins allowed in clientDataJSON
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  REDIS_URL: opt,
  APP_SECRET: opt,
  ADMIN_TOKEN: opt,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: bool.default(false), // true behind exactly one trusted reverse proxy that appends X-Forwarded-For

  ROUTE_EXPLAIN_ENABLED: bool.default(false), // V84: route explanations.
  STATEMENTS_ENABLED: bool.default(false), // V87: read-only signed monthly statements.
  // Receipts
  RECEIPT_SIGNING_KEY: opt,
  RECEIPT_KEY_ROTATION_DAYS: num(7),
  ANCHOR_INTERVAL_MS: int(3_600_000),
  // Security review round 3 (R3-15, R3-29), one block.
  // RECEIPT_KEY_SYNC_MS: how often each router process re-reads the current receipt key. A retired key's private half is
  // erased from the database when it is rotated out; a process that did not run the rotation holds its copy for at
  // most this long (receipts/signer.ts). At most five minutes: that is the tolerance the published verifier allows
  // between a receipt's time and its key's window (packages/client/src/receipts.ts), so a receipt signed in the overlap
  // still verifies.
  // ATTESTATION_REQUIRE_ALLOWLIST: an attested gateway (aci/1) is attested only against a measurement pin that names
  // every identifier its evidence carries (MRTD, RTMR0 to RTMR3, the keyset digest, and the compose hash, OS image hash,
  // app id and key provider when present; services/attestor.ts, R5-03). Unset: required in production, not required
  // elsewhere (the gateway then attests with a warning). Production refuses "false".
  RECEIPT_KEY_SYNC_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  ATTESTATION_REQUIRE_ALLOWLIST: z.preprocess((v) => (v === "" ? undefined : v), bool.optional()),
  // Per-host anchoring of enclave receipts. Off by default: no job, no route. The `host-anchor` worker job collects each
  // attested sidecar's receipt leaves (GET /anchor/leaves with that host's anchor token), keeps those signed by the
  // receipt key its router-verified attestation binds, and roots them per host and interval; with a configured chain and
  // anchorer key it posts each root with ReceiptAnchor.anchorAttested, otherwise keeps it off chain (status "local").
  HOST_ANCHOR_ENABLED: bool.default(false),
  HOST_DASHBOARD_ENABLED: bool.default(false),
  HOST_ANCHOR_INTERVAL_MS: int(3_600_000),
  HOST_ANCHOR_TOKENS: opt, // JSON {"<provider id>": "<that sidecar's SIDECAR_ANCHOR_TOKEN>"}

  ...rpcEnv, // RPC1
  // Chain (Solana mainnet-beta by default). CHAIN_ID is the wallet-adapter numeric id (101 mainnet-beta, 102 testnet,
  // 103 devnet) kept for scoping stored rows; SOLANA_NETWORK is the CAIP-2 name x402 and receipts publish.
  CHAIN_ID: int(101),
  SOLANA_NETWORK: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/, "must be a CAIP-2 Solana network id").default(SOLANA_MAINNET_CAIP2),
  SOL_RPC_URL: z.string().default(DEFAULT_PUBLIC_RPC),
  SOLANA_RPC_URL: opt, // the same setting under the name docs/Trellis_Backend.md uses; wins over SOL_RPC_URL when set
  SOLANA_COMMITMENT: z.enum(["confirmed", "finalized"]).default("confirmed"), // read/send commitment; deposits always credit at finalized
  // Trellis Anchor programs (docs/Trellis_Backend.md §5). Empty: that program is not deployed for this router.
  TRELLIS_CREDITS_PROGRAM_ID: addr,
  TRELLIS_TAB_PROGRAM_ID: addr,
  TRELLIS_BOND_PROGRAM_ID: addr,
  TRELLIS_ANCHOR_PROGRAM_ID: addr,
  TRELLIS_RULES_PROGRAM_ID: addr,
  TRELLIS_FEE_ROUTER_PROGRAM_ID: addr,
  TRELLIS_CAPACITY_PROGRAM_ID: addr,
  TREASURY_ADDRESS: addr, // protocol treasury wallet (20% of fees, expired balances)
  REFUND_POOL_ADDRESS: addr, // where executed slashes land before affected callers are refunded
  // Caps until audit (§10): tab cap <= 500 USDC, credits <= 5,000 USDC per key. Lower is allowed, higher is refused.
  TAB_CAP_USDC: num(500),
  CREDITS_CAP_USDC: num(5_000),
  CREDITS_REFUND_DELAY_H: num(72), // closure refunds wait this long (open-dispute window) before the settlement job pays them
  // Security review R4-04: the closure refund job cannot be blocked by requests nobody signed or that cannot progress.
  // A closure asked for at the API and not seen on chain within CLOSURE_UNSIGNED_TTL_S is cancelled (the transaction it
  // was handed is valid for about a minute); one wallet may have CLOSURE_MAX_UNSIGNED_PER_PAYER such requests at a time;
  // a run examines at most CLOSURE_RUN_BUDGET payable closures, oldest first, and continues from where it stopped.
  DEPOSIT_STATUS_CACHE_MS: z.coerce.number().int().min(0).max(600_000).default(10_000), // R4-19: how long an account's batched deposit-status lookup is reused
  CLOSURE_UNSIGNED_TTL_S: z.coerce.number().int().min(120).max(86_400).default(900),
  CLOSURE_MAX_UNSIGNED_PER_PAYER: z.coerce.number().int().min(1).max(1000).default(3),
  CLOSURE_RUN_BUDGET: z.coerce.number().int().min(1).max(10_000).default(500),
  X402_FACILITATOR_URL: opt, // an external x402 facilitator (e.g. Coinbase's) used for `exact` settlement instead of the router's own fee payer
  FACILITATOR_FEE_WAIVER_UNTIL: opt, // inert: the hosted facilitator charges no fee at any time (FACILITATOR_FEE_BPS can only be 0). Still parsed as a date so an old environment starts.
  PUBLIC_RPC_URL: z.string().default(DEFAULT_PUBLIC_RPC), // shown to wallets (never the private node URL)
  EXPLORER_URL: z.string().default("https://explorer.solana.com"),
  WEB_DIR: opt, // built website (web/out) served at /; default ./web/out when present
  CHAIN_CONFIRMATIONS: int(2),
  CHAIN_START_BLOCK: z.coerce.bigint().optional(),
  USDC_ADDRESS: addr.default(USDC_MINT), // the USDC mint
  CREDITS_ADDRESS: addr,
  CALLPAY_ADDRESS: addr,
  PAYWITHSTOCK_ADDRESS: addr,
  PROVIDER_BOND_ADDRESS: addr,
  RECEIPT_ANCHOR_ADDRESS: addr,
  ROYALTY_ADDRESS: addr,
  PAYMASTER_ADDRESS: addr, // fee-payer sponsorship: Solana transactions name their fee payer, so no program backs this; kept so env files and manifests parse, no route serves it
  CALLPAY_TREASURY: addr,
  ROUTER_PRIVATE_KEY: pk,
  SETTLEMENT_PRIVATE_KEY: pk,
  ANCHORER_PRIVATE_KEY: pk,
  PAYMASTER_SIGNER_KEY: pk,
  PAYMASTER_ACCOUNT_RUNTIMES: z.string().default("[]").transform(raw => accountRuntimeSchema.parse(JSON.parse(raw))),
  SLASHER_PRIVATE_KEY: pk,
  KEEPER_PRIVATE_KEY: pk,
  // Local development only: POST /api/v1/dev/faucet mints mock USDC and deposits it to the caller's key,
  // so the site can be tried without a wallet. Refused in production and against a non-loopback RPC.
  DEV_FAUCET: bool.default(false),
  DEV_FAUCET_PRIVATE_KEY: pk,
  TRLS_POOL_PROGRAM: addr, // unused: kept so an old environment still parses
  TRLS_POOL_LEGS: opt, // retired (security review R4-33): a set value stops the start, see trlsEscrowConfig
  // The $TRLS deposit price (src/solana/trls-price.ts): the router's own samples of the token's market, the lowest of the window.
  TRLS_POOL_VAULTS: opt, // JSON {base,quote}: the pool's $TRLS and wrapped-SOL token accounts, once the token has left its launch curve
  TRLS_PRICE_WINDOW_MINUTES: num(30),
  TRLS_PRICE_SAMPLE_SECONDS: num(60),
  TRLS_PRICE_MIN_COVERAGE: num(0.75), // the share of the window's samples that must exist before there is a price
  TRLS_PRICE_MIN_SOL: num(10), // no sample from a market holding less SOL than this
  TRLS_SOL_USD_FEED: z.string().default("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
  TRLS_SOL_USD_ACCOUNT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).default("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"), // the on-chain price account of that feed
  HF_BASE_URL: z.string().default("https://huggingface.co"),

  // Economics (basis points)
  PER_CALL_MARGIN_BPS: int(0), // zero markup: callers pay the host price (docs Overview §4)
  PROVIDER_FEE_BPS: int(0), // zero markup: hosts are paid their full price
  BYOK_FEE_BPS: int(0),
  DEFAULT_ROYALTY_BPS: int(500),
  PER_CALL_QUOTE_TTL_S: int(300),
  PER_CALL_MAX_USD: num(25),
  // x402 (exact scheme): agents sign a USDC transfer to X402_PAY_TO and send it as X-PAYMENT; the router co-signs
  // as fee payer (ROUTER_PRIVATE_KEY) and submits it. Enabled when X402_PAY_TO is set.
  X402_PAY_TO: addr,
  X402_NETWORK: z.string().min(1).default(SOLANA_MAINNET_CAIP2), // CAIP-2 network advertised in `accepts`
  PAYMENT_WAIT_MS: int(8_000),

  // Pay with Stock Tokens
  PAYWITH_THRESHOLD_USD: num(1),
  PAYWITH_MAX_AGE_H: num(24),
  PAYWITH_MAX_DEBT_USD: num(5),
  PAYWITH_MAX_SLIP_BPS: int(100),
  PAYWITH_CAP_HAIRCUT_BPS: int(1000),
  PAYWITH_TOKENS: opt, // JSON: [{symbol,address,decimals,feed?}]

  // Stock escrow payments: a customer transfers an allowlisted Stock Token from their own wallet to
  // ESCROW_ADDRESS; once its block is final the sending wallet's account is credited at the feed
  // price minus ESCROW_HAIRCUT_BPS. PAYMENTS_MODE=escrow runs without the Trellis contracts.
  PAYMENTS_MODE: z.enum(["contracts", "escrow"]).default("contracts"),
  ESCROW_ADDRESS: addr,
  ESCROW_TOKENS: opt, // JSON: [{symbol,address,decimals,feed}]; default: PAYWITH_TOKENS entries that have a feed
  ESCROW_HAIRCUT_BPS: int(300),
  ESCROW_MAX_PRICE_AGE_S: int(302_400), // equity feeds pause outside market hours; 3.5 days covers long weekends
  ESCROW_START_BLOCK: z.coerce.bigint().optional(),
  // Credit only transfers in blocks the chain reports as final (CHAIN_CONFIRMATIONS stays an extra floor),
  // and keep re-verifying credits for ESCROW_REORG_HORIZON_BLOCKS below that point (~1 day on Solana).
  ESCROW_FINALITY: z.enum(["finalized", "confirmed"]).default("finalized"),
  ESCROW_REORG_HORIZON_BLOCKS: int(864_000),

  // Pay with $TRLS in escrow (off unless TRLS_TOKEN_ADDRESS is set). TRLS sent to ESCROW_ADDRESS is credited
  // like a Stock Token, with the same finality rules, but priced from the router's own samples of its market
  // (src/solana/trls-price.ts: the lowest of the window) instead of a price feed, minus TRLS_ESCROW_HAIRCUT_BPS, and
  // credited at most TRLS_ESCROW_MAX_USD_PER_DEPOSIT per deposit and TRLS_ESCROW_MAX_USD_PER_DAY across all deposits
  // of a day. What a credited deposit paid is burned by the worker that holds TRLS_BURN_PRIVATE_KEY (trls-burn.ts).
  TRLS_TOKEN_ADDRESS: addr,
  TRLS_TOKEN_SYMBOL: z.string().default("TRLS"),
  TRLS_TOKEN_DECIMALS: int(9), // checked against the mint before anything is credited
  TRLS_ESCROW_HAIRCUT_BPS: int(0),
  TRLS_ESCROW_MAX_USD_PER_DEPOSIT: num(250),
  TRLS_ESCROW_MAX_USD_PER_DAY: num(100), // every $TRLS deposit of the last 24 hours together; a deposit past it waits
  TRLS_BURN_PRIVATE_KEY: pk, // the escrow wallet's key (ESCROW_ADDRESS): signs the burn and nothing else; a worker's, never the API's
  TRLS_BURN_FEE_PAYER: z.enum(["escrow", "anchorer"]).default("escrow"), // who pays the burn's network fee

  // Add funds with USDC in escrow (off unless USDC_ESCROW_ENABLED). USDC (USDC_ADDRESS, 6 decimals, checked against the
  // token contract before anything is credited) sent to ESCROW_ADDRESS is credited 1:1 at par, with no price feed, under
  // the same finality, reorganization and idempotency rules, minus USDC_ESCROW_HAIRCUT_BPS, and credited at most
  // USDC_ESCROW_MAX_USD_PER_DEPOSIT per deposit (the rest is flagged for operator review, as for TRLS).
  USDC_ESCROW_ENABLED: bool.default(false),
  USDC_ESCROW_HAIRCUT_BPS: int(0),
  USDC_ESCROW_MAX_USD_PER_DEPOSIT: num(1000),

  // Routing / health
  OUTAGE_WINDOW_MS: int(30_000),
  HEALTH_PROBE_INTERVAL_MS: int(15_000),
  HEALTH_PROBES: bool.default(true),
  PROVIDER_TIMEOUT_MS: int(120_000),
  FIRST_TOKEN_TIMEOUT_MS: int(45_000),
  // R4-02. When a caller cancels a stream, the router keeps reading the upstream for at most this long to receive the
  // provider's usage event, and charges that. 0: stop the upstream at once and charge the conservative bound (the
  // prompt bound plus the bytes of every token received). The provider generates, and bills, for as long as it is read.
  STREAM_CANCEL_DRAIN_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
  // R4-02. The daily reconciliation alarms when a provider is owed this much more than its calls collected (USD), or
  // when its recorded invoice differs from what the router recorded as owed by more than this.
  RECONCILE_GAP_ALARM_USD: z.coerce.number().min(0).default(0.01),
  MAX_PROVIDER_ATTEMPTS: int(4),
  EMPTY200_SLASH_THRESHOLD: num(0.02),
  UPTIME_SLASH_THRESHOLD: num(0.95),
  // Selection weight multiplier for an endpoint served under the attested class (declared attested retention and a
  // fresh, verified attestation), per lane. On lanes attested and unlinkable every eligible endpoint is attested, so
  // their bonus only matters if set differently from 1. Must be at least 1: attestation never lowers a weight.
  ATTESTED_BONUS_PUBLIC: z.coerce.number().min(1).max(10).default(1.25),
  ATTESTED_BONUS_ATTESTED: z.coerce.number().min(1).max(10).default(1),
  ATTESTED_BONUS_UNLINKABLE: z.coerce.number().min(1).max(10).default(1),

  // Canaries
  CANARY_INTERVAL_MS: int(3_600_000),
  CANARIES: bool.default(true),
  SHADOW_DAYS: num(7),

  // Attestation
  ATTESTATION_INTERVAL_MS: int(600_000),
  // Days of attestor, canary and probe events kept for the public proof-time record (GET /api/v1/attestation/summary).
  // 0 records nothing and switches the two history endpoints off; rows already stored are left alone.
  ATTESTATION_HISTORY_DAYS: z.coerce.number().int().min(0).max(366).default(30),
  ALLOW_DEV_ATTESTATION: bool.default(false),
  // Public status page (GET /api/v1/status/slo): availability targets per lane, as fractions, and how many requests a window
  // needs before a dip below target is recorded as an incident suggestion for an operator to confirm.
  STATUS_SLO_PUBLIC: z.coerce.number().min(0.5).max(1).default(0.995),
  STATUS_SLO_ATTESTED: z.coerce.number().min(0.5).max(1).default(0.99),
  STATUS_SLO_UNLINKABLE: z.coerce.number().min(0.5).max(1).default(0.99),
  STATUS_SUGGEST_MIN_REQUESTS: z.coerce.number().int().min(1).default(20),
  NVIDIA_NRAS_URL: z.string().default("https://nras.attestation.nvidia.com/v3/attest/gpu"),
  // GPU evidence in a sidecar attestation document (services/attestor-verifiers.ts): the NVIDIA Remote Attestation
  // Service whose signed tokens the router accepts, and where its signing keys are published. These are the router's own
  // trust anchors; the `nras_url` a provider's document names is never used. NRAS_JWKS_URL defaults to
  // <NRAS_ISSUER>/.well-known/jwks.json.
  NRAS_ISSUER: z.string().url().default("https://nras.attestation.nvidia.com"),
  NRAS_JWKS_URL: z.string().url().optional(),
  TDX_VERIFIER_URL: opt,
  TDX_VERIFIER_KEY: opt,
  // Which services confirm a TEE quote: a comma list of dcap (TDX_VERIFIER_URL, the default), intel-ta, dstack,
  // tee-cloud (the TEE cloud's public quote verifier, TEE_CLOUD_VERIFIER_URL).
  // Every listed verifier must accept the quote.
  ATTESTATION_VERIFIERS: z.string().default("dcap"),
  INTEL_TA_URL: z.string().default("https://api.trustauthority.intel.com/appraisal/v2/attest"),
  INTEL_TA_JWKS_URL: z.string().default("https://portal.trustauthority.intel.com/certs"),
  INTEL_TA_API_KEY: opt,
  DSTACK_VERIFIER_URL: opt,
  DSTACK_VERIFIER_KEY: opt,
  TEE_CLOUD_VERIFIER_URL: z.string().default(""),

  // Measurements: record the image/compose/model digests bound into verified quotes, look them up in the
  // Rekor transparency log and prepare MeasurementRegistry.register() calldata. Off by default; nothing is submitted.
  MEASUREMENTS_ENABLED: bool.default(false),
  MEASUREMENTS_INTERVAL_MS: int(300_000),
  REKOR_URL: z.string().default("https://rekor.sigstore.dev"),
  REKOR_PUBLIC_KEY: opt, // PEM (ECDSA P-256) that signs Rekor checkpoints; without it checkpoints are not verified
  MEASUREMENT_REGISTRY_ADDRESS: addr,
  // PEM (or base64 SPKI) of the ECDSA P-256 key that signs measurement bundles. Setting it turns on bundle checking: the router
  // then accepts signed bundles (POST /trpc/measurements.submitBundle), verifies their transparency-log entries, and publishes
  // the key at GET /api/v1/measurements/key. Only the public key belongs here; the private key stays with whoever publishes.
  MEASUREMENT_PUBLIC_KEY: opt,
  // The measurement registry program (programs/trellis_measurements, docs/Trellis_Backend.md §3.2). The same setting as
  // MEASUREMENT_REGISTRY_ADDRESS under the name the other programs use; this one wins when both are set.
  TRELLIS_MEASUREMENTS_PROGRAM_ID: addr,
  // The keeper prepares register instructions for the registry authority (a Squads 2-of-3 in production) and sends
  // nothing. On: it sends them itself with MEASUREMENT_AUTHORITY_ROLE's key, when that key is the registry's authority.
  MEASUREMENTS_ONCHAIN_SUBMIT: bool.default(false),
  MEASUREMENT_AUTHORITY_ROLE: z.enum(["keeper", "anchorer", "settlement", "slasher"]).default("keeper"),
  MEASUREMENT_POLICY_VERSION: z.coerce.number().int().min(0).max(4_294_967_295).default(1), // policy_version written into new entries
  MEASUREMENT_REGISTRY_CACHE_MS: int(30_000), // how long a registry entry read from chain is reused by isAttested

  // The Lane. Day-zero pipeline (off by default): watch Hugging Face for new fine-tunes of the listed permissive
  // base models, check their license, and create candidates for evaluation. Nothing is served without an
  // operator approval and an attested provider.
  DAYZERO_ENABLED: bool.default(false),
  DAYZERO_INTERVAL_MS: int(900_000),
  DAYZERO_BASE_MODELS: z.string().default(""), // comma list of Hugging Face repo ids (owner/name) whose derivatives are watched
  DAYZERO_LICENSES: z.string().default("mit,apache-2.0"), // license ids (model card metadata) a base model and a derivative may carry
  DAYZERO_KEYWORDS: z.string().default("abliterated,uncensored,decensored,unfiltered"), // a repository is a candidate only if its id or tags contain one
  DAYZERO_MAX_PER_RUN: int(25), // most repositories examined in one run
  DAYZERO_MAX_REFUSAL_RATE: num(0.25), // largest share of the benign probe set a candidate may refuse
  DAYZERO_MIN_CAPABILITY: num(0.8), // smallest share of the exact-check set a candidate must answer correctly
  DAYZERO_MIN_CANARY: num(0.75), // smallest share of the canary exact-match set
  // Creator claims: how long an issued challenge stays valid, and the file the uploader publishes it in.
  LANE_CLAIM_TTL_S: int(86_400),
  LANE_CLAIM_FILE: z.string().default("trellis-claim.txt"),

  // Workers
  WORKERS: bool.default(true),
  SETTLEMENT_INTERVAL_MS: int(3_600_000),
  PROVIDER_REGISTRY_INTERVAL_MS: int(600_000),
  PROVIDERS_FILE: opt,
  E2EE_PASSTHROUGH_ENABLED: bool.default(false),
  E2EE_GATEWAY_BASE_URL: opt, // production pin for the confidential gateway when PROVIDERS_FILE is not used
  E2EE_GATEWAY_ATTESTATION_URL: opt,

  // Gateway features
  OTEL_EXPORTER_OTLP_ENDPOINT: opt,
  OTEL_SERVICE_NAME: z.string().default("trellis"),
  CACHE_TTL_S: z.coerce.number().int().min(1).default(3600),
  SEMANTIC_CACHE_THRESHOLD: num(0.97),
  SEMANTIC_CACHE_EMBEDDING_MODEL: opt,

  // Anthropic Messages endpoint (POST /v1/messages): JSON object mapping the model names an Anthropic client sends to catalog model ids.
  ANTHROPIC_MODEL_MAP: opt,

  // Council mode (model "trellis/council") and dual verification (verify: "dual"). Off unless enabled.
  TRELLIS_FEATURE_COUNCIL: bool.default(false),
  TRELLIS_COUNCIL_MODELS: opt, // comma list of 2-5 model ids used when a council request names none
  TRELLIS_COUNCIL_JUDGE: opt, // model id of the judge used when a council request names none
  TRELLIS_COUNCIL_MODE: z.enum(["judge", "fuse"]).default("judge"),

  // Private RAG (POST /api/v1/rag): what one request may carry. Document text is never stored; these bound the memory and the calls it costs.
  RAG_MAX_DOCUMENTS: int(200),
  RAG_MAX_BYTES: int(2_097_152), // total UTF-8 bytes of document text
  RAG_MAX_CHUNKS: int(2000),
  RAG_MAX_EMBEDDING_CALLS: int(64), // embeddings calls one request may make (a small-context embedding model needs more, smaller ones)

  // Batch API (POST /api/v1/batches): lines run on the worker, in spare capacity, at a discount. Requests and answers are kept
  // sealed in Redis (or memory), never in Postgres, until BATCH_RESULTS_TTL seconds after the batch finishes.
  // R4-03: 0 by default. A batch line goes to the provider as an ordinary call at the ordinary price, so a discount is
  // paid by the operator; a non-zero value is refused unless PROVIDER_FEE_BPS (the operator's margin) is at least as large.
  BATCH_DISCOUNT_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  BATCH_MAX_LINES: int(1000), // lines in one batch
  BATCH_MAX_BYTES: int(8 * 1024 * 1024), // bytes of input in one batch
  BATCH_MAX_ACTIVE: int(2), // unfinished batches one key may have at a time
  BATCH_RESULTS_TTL: z.coerce.number().int().min(60).default(86_400), // seconds results are kept after a batch finishes
  BATCH_INTERVAL_MS: int(2_000), // how often the worker drains queued lines
  BATCH_LINES_PER_TICK: int(20), // most lines started per drain
  BATCH_CONCURRENCY: int(4), // lines run at once
  BATCH_LINE_MAX_ATTEMPTS: int(3), // tries for a line whose providers were all unavailable

  // Secured Skills Hub (/api/v1/skills): agent skills imported from a repository or an archive, scanned, hashed and served.
  SKILLS_MAX_BYTES: int(5 * 1024 * 1024), // unpacked bytes of one skill (and the most an uploaded archive may be)
  SKILLS_MAX_FILES: int(500), // files in one skill
  SKILLS_ALLOWED_HOSTS: opt, // comma-separated hosts added to the scanner's network allowlist (a host also covers its subdomains)
  SKILLS_DOWNLOAD_LEVELS: z.string().default("trusted,caution"), // scan levels that may be downloaded and installed
  SKILLS_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(0), // network fee on a paid install; the author gets the rest
  SKILLS_GIT_TIMEOUT_MS: int(30_000),
  SKILLS_ALLOW_LOCAL_GIT: bool.default(false), // file:// and local paths as import sources (never in production)
  SKILLS_SOURCES: opt, // mirror job sources, JSON: [{ "kind": "git", "url", "ref"?, "paths"? } | { "kind": "index", "url" }]
  SKILLS_MIRROR_INTERVAL_MS: int(6 * 3_600_000),

  // Default per-key limits (0 = unlimited)
  DEFAULT_RPM: int(600),
  DEFAULT_TPM: int(0),
  UNAUTH_RPM: int(60),
  NEW_KEYS_PER_HOUR: int(10),
  // Security review R5-04 / R5-05. ACCOUNT_RPM: inference requests a minute for one ACCOUNT, over all of its keys
  // (sub-keys each have their own rpm, so without it the per-key limit bounds no account). INFLIGHT_PER_KEY /
  // INFLIGHT_PER_SOURCE: inference calls one key (or, without a key, one source address) may have open at a time, per
  // router replica. SLOW_CALLS_PER_10MIN: calls of one key or source that the router had to cut off (its timeout, an
  // answer above the size it reads) inside ten minutes before further calls are refused for the rest of them. 0 = no limit.
  ACCOUNT_RPM: z.coerce.number().int().min(0).max(1_000_000).default(1_200),
  INFLIGHT_PER_KEY: z.coerce.number().int().min(0).max(10_000).default(16),
  INFLIGHT_PER_SOURCE: z.coerce.number().int().min(0).max(10_000).default(8),
  SLOW_CALLS_PER_10MIN: z.coerce.number().int().min(0).max(10_000).refine((n) => n !== 1, "SLOW_CALLS_PER_10MIN must be 0 (off) or at least 2").default(20),

  // Release identity and contract-path launch guards (see contractPathGuards below)
  RELEASE_COMMIT: opt, // git commit of the running build, shown at GET /api/v1/status
  DEPLOYMENT_MANIFEST: opt, // the trellis.deployments/v1 manifest of the configured contracts: a file path or inline JSON
  DEPLOYMENT_VERIFICATION: opt, // the passing deployment verifier report for that manifest: a file path or inline JSON
  PAYWITH_DELEGATION_ACCEPTED: bool.default(false),
  PAYWITH_MAX_DAILY_CAP_USD: opt, // largest daily cap (USD at the fair price) the API will build a PayWithStock session for

  // Operations: optional alert webhook (a secret URL) and off-host backup freshness.
  ALERT_WEBHOOK_URL: opt,
  ALERT_WEBHOOK_FORMAT: z.enum(["ntfy", "slack", "discord", "json"]).optional().or(z.literal("").transform(() => undefined)),
  BACKUP_REQUIRED: bool.default(false),
  BACKUP_MAX_AGE_HOURS: num(26),

  // Optional Telegram bot (BotFather token, a secret). Without it the bot never starts.
  TELEGRAM_BOT_TOKEN: opt,
  LOW_BALANCE_ALERTS_ENABLED: bool.default(false), // B119
  TELEGRAM_LINKING_ENABLED: bool.default(false),
  WEEKLY_SUMMARY_ENABLED: bool.default(false), // B120

  // ---- $TRLS holder perks: membership tiers that give access and priority, never money (no fee discount, no free
  // credits, no cashback or rebates). The token is TRLS_TOKEN_ADDRESS / TRLS_TOKEN_SYMBOL above.
  HOLDER_TIERS: opt, // JSON [{name,min,rpm_multiplier,tpm_multiplier,...}] (see holderSettings); off unless TRLS_TOKEN_ADDRESS is set too
  // SEALED (attested) lane admission: at most this many sealed-lane calls in flight per host; 0 = no limit (no queue).
  SEALED_MAX_CONCURRENCY_PER_HOST: z.coerce.number().int().min(0).max(100_000).default(0),
  SEALED_QUEUE_MAX_WAIT_MS: z.coerce.number().int().min(0).max(120_000).default(5000), // longest a sealed-lane call waits for a slot
  SEALED_NONHOLDER_MIN_SHARE: z.coerce.number().min(0).max(1).default(0.2), // share of queued admissions kept for callers with no tier
  EARLY_ACCESS_WINDOW_HOURS: z.coerce.number().int().min(0).max(720).default(48), // longest a newly listed model stays holders-first
  AGENT_KEYS_MAX_ACTIVE: z.coerce.number().int().min(0).max(100_000).default(0), // active Agent Session keys per account; 0 = no cap
  CREDITS_EXPIRY_ENABLED: bool.default(false), // settlement sends trellis_credits notice_expiry / sweep_expired (holders with credits_never_expire are skipped)

  // ---- IPX, the inference price index: volume-weighted USDC price per 1M tokens per model class,
  // computed from real generations (GET /api/v1/ipx/:class). Off unless IPX_ENABLED.
  IPX_ENABLED: bool.default(false),
  IPX_CLASSES: opt, // JSON {"IPX-OPEN-70B":["author/model-id", ...]}; default: IPX-OPEN-70B = meta-llama/llama-3.3-70b-instruct
  IPX_THIN_USDC: z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a USDC amount like \"50000\"").default("50000"), // trailing-24h volume below which a class is THIN
  IPX_MAX_ACCOUNT_SHARE_BPS: int(10_000), // cap on one account's share of a window's volume; 10000 = no cap
  IPX_ATTESTED_ONLY: bool.default(true), // count only fills served by providers with a stored attestation
  // ---- IPX oracle publisher (src/services/ipx-oracle.ts): signed index price updates from the latest IPX samples,
  // served at GET /api/v1/ipx/:class/oracle and optionally handed to publishers. Off unless IPX_ORACLE_ENABLED (and IPX_ENABLED).
  IPX_ORACLE_ENABLED: bool.default(false),
  IPX_ORACLE_PRIVATE_KEY: oraclePk, // dedicated oracle signing key (32 bytes, hex); signs messages only and holds no funds. Never shared with a chain role.
  IPX_ORACLE_PUBLIC_KEY: opt, // public half for replicas that do not hold the private key (ed25519: 0x + 32 bytes; secp256k1: address)
  IPX_ORACLE_ALGORITHM: z.enum(["ed25519", "secp256k1-eip191"]).default("ed25519"),
  IPX_ORACLE_CLASSES: opt, // comma list of IPX class ids to publish; default: every IPX class
  IPX_ORACLE_INTERVAL_S: int(300), // publishing cadence
  IPX_ORACLE_STALE_AFTER_S: int(1800), // an update is valid for this long; a consumer must halt past it
  IPX_ORACLE_MAX_MOVE_BPS: int(1000), // largest move of the published price from the previous update, in basis points
  IPX_ORACLE_HALTED: bool.default(false), // kill switch in config: freeze publishing (PUT /api/v1/ipx/oracle/halt sets it at runtime)
  IPX_ORACLE_PUBLISHERS: opt, // comma list of sinks: "onchain" (IPXFeed calldata) and/or "https" (generic push); default none
  IPX_ORACLE_FEEDS: opt, // JSON {"IPX-OPEN-70B":"<IPX feed account address>"} for the onchain sink
  IPX_ORACLE_ONCHAIN_SUBMIT: bool.default(false), // onchain sink: submit the transaction with IPX_KEEPER_PRIVATE_KEY (default: build calldata only)
  IPX_ORACLE_PUSH_CONFIG: opt, // https sink: path to a JSON file (or inline JSON) describing the request; see deploy/ipx-perp/
  IPX_KEEPER_PRIVATE_KEY: pk, // the IPXFeed keeper; only used by the onchain sink with IPX_ORACLE_ONCHAIN_SUBMIT. Run it on a worker with no other signing key.

  // ---- Blind tokens: unlinkable paid access with Privacy Pass tokens (RFC 9578 type 0x0002). Off by default;
  // when off no route is registered and a PrivateToken Authorization header is not looked at.
  TRELLIS_FEATURE_BLIND: bool.default(false),
  BLIND_UNIT_PRICE_USD: z.string().default("0.000002"), // value of one token-unit; a token is 1000, 10000 or 100000 units
  BLIND_EPOCH_SECONDS: int(604_800), // issuer keys rotate every epoch (one week)
  BLIND_REDEEM_GRACE_SECONDS: int(604_800), // tokens stay redeemable this long after their epoch stops issuing
  BLIND_MULTI_TOKEN_ENABLED: bool.default(false), // allow token sets; existing single-token calls are unchanged
  BLIND_MAX_TOKENS_PER_REQUEST: z.coerce.number().int().min(1).max(64).default(16), // bound signature work and header size
  BLIND_MAX_BATCH: int(32), // most tokens one purchase request may ask for
  BLIND_PURCHASE_RPM: int(10), // purchase requests per key per minute
  BLIND_REDEEM_RPM: int(600), // calls per minute per client address that present a token (tokens bring their own quota)
  BLIND_MAX_USD_PER_DAY: num(100), // most one account may convert into tokens per rolling day

  // ---- Oblivious HTTP (RFC 9458) gateway and the "unlinkable" lane. Off by default: no route is registered and
  // lane "unlinkable" keeps answering 501. Needs TRELLIS_FEATURE_BLIND (the lane is paid with blind tokens).
  OHTTP_ENABLED: bool.default(false),
  OHTTP_KEY_EPOCH_SECONDS: int(86_400), // gateway HPKE keys rotate every epoch (one day)
  OHTTP_KEY_GRACE_SECONDS: int(86_400), // an epoch's key still opens requests this long after the epoch ends
  OHTTP_MAX_REQUEST_BYTES: int(8_388_608), // largest encapsulated request the gateway accepts
  OHTTP_MAX_RESPONSE_BYTES: int(8_388_608), // largest response the gateway will encapsulate (larger becomes a 502)
  OHTTP_RELAY_RPM: int(6000), // gateway requests per minute per authenticated relay
  OHTTP_DIRECT_RPM: int(60), // gateway requests per minute per client address that did not come through a relay
  OHTTP_PAD_BYTES: int(256), // responses are zero-padded to a multiple of this many bytes (0 = no padding)
  OHTTP_GATEWAY_OPERATOR: z.string().default("Trellis"), // the name this router's own operator goes by in RELAY_OPERATORS
  OHTTP_MIN_RELAY_OPERATORS: int(2), // production refuses to start with fewer relay operators than this that are not the gateway operator
  OHTTP_CHUNKED_ENABLED: bool.default(false), // also accept chunked Oblivious HTTP (message/ohttp-chunked-req), so streamed responses arrive as they are produced; only with OHTTP_ENABLED
  RELAY_OPERATORS: opt, // JSON [{operator,url,key_id,secret_sha256}]: the relays clients may use; published at GET /api/v1/relays

  // ---- Tor. Optional. ONION_ADDRESS is the v3 onion hostname of deploy/onion, published at GET /api/v1/status. Requests
  // that the onion proxy forwards carry ONION_PROXY_SECRET in X-Trellis-Onion; they have no client address, so their
  // per-address rate limits are shared pools ONION_POOL_MULTIPLIER times a single address's limit.
  ONION_ADDRESS: opt,
  ONION_PROXY_SECRET: opt,
  ONION_POOL_MULTIPLIER: int(10),
  // Serve lane "unlinkable" over Tor as well: to requests the onion proxy forwarded that are paid with a blind token and
  // nothing that names the payer, from attested providers only. Off by default; needs ONION_ADDRESS, ONION_PROXY_SECRET
  // and TRELLIS_FEATURE_BLIND. It is an alternative to OHTTP_ENABLED, not a change to it (src/onion/lane.ts).
  UNLINKABLE_VIA_ONION: bool.default(false),

  // ---- Transparency log of keys and configurations (C2SP tlog-tiles with signed-note checkpoints and tlog-cosignature
  // witnesses; src/tlog). Off by default: no route is registered and nothing is appended.
  AGENT_PROFILES_ENABLED: bool.default(false),
  AGENT_POLICY_ENABLED: bool.default(false),
  AGENT_RULEBOOK_WORDS_ENABLED: bool.default(false), // B124: Telegram wording only
  AGENT_GUARD_ENABLED: bool.default(false), // V98
  // Pay another agent: Agent Guard decides, the paying wallet sends USDC straight to the recipient, the router checks the
  // transfer on chain and signs a receipt. Trellis never holds the money. Off by default; needs AGENT_GUARD_ENABLED.
  AGENT_PAY_ENABLED: bool.default(false),
  AGENT_APPROVAL_TTL_S: z.coerce.number().int().min(1).max(86400).default(900),
  NETWORK_POLICY_ENABLED: bool.default(false),
  TLOG_ENABLED: bool.default(false),
  TLOG_ORIGIN: opt, // checkpoint origin and the log's key name; default "<host of PUBLIC_BASE_URL>/tlog"
  TLOG_SIGNING_KEY: opt, // the log's Ed25519 key: base64 PKCS#8, or PRIVATE+KEY+<origin>+<id>+<key>; required in production
  TLOG_WITNESSES: opt, // witness verifier keys "<name>+<id>+<base64 0x04 key>", comma or newline separated
  TLOG_WITNESS_QUORUM: int(2), // cosignatures a checkpoint needs to count as witnessed
  TLOG_INTERVAL_MS: int(60_000), // how often the log job picks up new keys and signs a checkpoint
  TLOG_COSIGN_RPM: int(60), // cosignature submissions per minute per client address
  // Append the SHA-256 of the data inventory this build publishes at /keep/inventory.json (src/privacy) to the log, as a
  // data_inventory entry, when a new inventory is first deployed. Off by default; needs TLOG_ENABLED.
  TLOG_DATA_INVENTORY: bool.default(false),
  // Public-log anchoring (src/tlog/rekor.ts), off by default: each new checkpoint, at most once per
  // TLOG_REKOR_MIN_INTERVAL_MS, is recorded in the Rekor log at REKOR_URL as a hashedrekord entry over the signed checkpoint
  // note, signed with TLOG_REKOR_SIGNING_KEY. REKOR_PUBLIC_KEY, when set, is used to check Rekor's checkpoint and signed
  // entry timestamp. In production this is accepted in place of TLOG_WITNESS_QUORUM witnesses.
  TLOG_REKOR_ENABLED: bool.default(false),
  TLOG_REKOR_SIGNING_KEY: opt, // a dedicated ECDSA P-256 private key (PKCS#8 or SEC1 PEM, or base64 PKCS#8); never the measurement key
  TLOG_REKOR_MIN_INTERVAL_MS: int(600_000), // at most one Rekor submission per this many milliseconds (at least 60000)

  // ---- Solana payment paths (docs/Trellis_Backend.md §5.2, §6, dev faucet) --------------------------------------------
  // Tab billing: the payee a tab must name (docs §5.2); defaults to X402_PAY_TO, else the router signing key. The close
  // job (src/solana/tab-close.ts) can only post vouchers when the router signing key is that payee.
  TAB_PAYEE: addr,
  // Pay with a tokenized stock (docs §6): Jupiter's public swap API (quote + swap) and Pyth Hermes for the price sanity check.
  JUPITER_API_URL: z.string().url().default("https://lite-api.jup.ag"),
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  // Test USDC faucet for localnet and devnet (never mainnet): POST /api/v1/dev/faucet mints to the faucet wallet and deposits
  // through trellis_credits. DEV_FAUCET_PRIVATE_KEY must be the test mint's mint authority. DEV_FAUCET (loopback only) still works.
  FAUCET_ENABLED: bool.default(false),
  // Pay-with session signer (docs §6): `delegate` = a router-held delegate keypair per API key (the owner funds it);
  // `swig` = a Swig smart-wallet role the owner authorises for the router's session key, with the per-day token cap enforced
  // on chain (src/solana/swig.ts); the router never holds the tokens.
  PAYWITH_SESSION_MODE: z.enum(["delegate", "swig"]).default("delegate"),
  // Flat weekly service fees (relay operators, canary runners) paid in USDC from the treasury settlement wallet by the
  // weekly settlement run after a sanctions screen: JSON [{"role":"relay","address":"<base58>","usdc_per_week":"25"}].
  SERVICE_FEE_RECIPIENTS: opt,
});

export type Config = ReturnType<typeof loadConfig>;

function adminSources(raw: string): string[] {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of list) {
    const [ip, bits, ...rest] = s.split("/");
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? "") && ip!.split(".").every((p) => Number(p) <= 255);
    const v6 = !v4 && /^[0-9a-fA-F:]{2,39}$/.test(ip ?? "") && ip!.includes(":");
    if (rest.length || !(v4 || v6) || (bits !== undefined && (!v4 || !/^\d{1,2}$/.test(bits) || Number(bits) > 32))) throw new Error("ADMIN_ALLOWED_SOURCES must be a comma list of IP addresses and IPv4 CIDR blocks.");
  }
  return list;
}

/** Every setting name the configuration schema knows (the launch-surface refusal list is checked against it). */
export const CONFIG_SETTING_NAMES: readonly string[] = Object.keys(schema.shape);

export function loadConfig(overrides: Record<string, unknown> = {}) {
  // Launch surface first (src/surface/config.ts): in `core` the settings that switch a non-core feature on are refused
  // (production) or dropped (elsewhere) before anything below reads them.
  const surface = resolveSurface({ ...process.env, ...overrides });
  // Release switches next (src/surface/updates.ts): in production a setting of an update that has not been released
  // here stops the start. They are read from the environment as it was given, before the surface dropped anything.
  const updates = resolveUpdates({ ...process.env, ...overrides });
  const parsed = schema.safeParse(surface.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  guardSealed(e);
  if (e.NETWORK_POLICY_ENABLED && !e.TLOG_ENABLED) throw new Error("NETWORK_POLICY_ENABLED needs TLOG_ENABLED.");
  const production = e.TRELLIS_ENV === "production";
  // Security review R4-21. "Production" is TRELLIS_ENV, which defaults to development, while the network defaults to
  // mainnet-beta: a router started with keys in its environment and no TRELLIS_ENV would sign and take payments on
  // mainnet under the development defaults (the public default APP_SECRET, no attestation allow-list, http providers).
  // Anything that signs, receives payments or follows a program on mainnet-beta therefore needs production mode. A
  // named non-mainnet cluster is unaffected, and so is the test environment (its cluster is in memory).
  if (!production && e.TRELLIS_ENV !== "test" && e.SOLANA_NETWORK === SOLANA_MAINNET_CAIP2) {
    const live = (["ROUTER_PRIVATE_KEY", "SETTLEMENT_PRIVATE_KEY", "ANCHORER_PRIVATE_KEY", "SLASHER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "MAKEGOOD_REFUND_PRIVATE_KEY", "X402_PAY_TO", "TRELLIS_CREDITS_PROGRAM_ID", "CREDITS_ADDRESS", "TRELLIS_TAB_PROGRAM_ID", "CALLPAY_ADDRESS", "ESCROW_ADDRESS"] as const).filter((name) => e[name]);
    if (live.length) throw new Error(`${live.join(", ")} would act on Solana mainnet-beta (SOLANA_NETWORK defaults to it) outside production mode. Set TRELLIS_ENV=production with its LAUNCH_TIER, or set SOLANA_NETWORK to the cluster you mean.`);
  }
  const rpcUrl = e.SOLANA_RPC_URL ?? e.SOL_RPC_URL;
  const rpc = rpcSettings({ ...e, SOL_RPC_URL: rpcUrl }, production || process.env.NODE_ENV === "production"); // RPC1
  const solana = solanaSettings(e, production);
  const escrowMode = e.PAYMENTS_MODE === "escrow";
  const contractAddresses = {
    CREDITS_ADDRESS: e.CREDITS_ADDRESS,
    CALLPAY_ADDRESS: e.CALLPAY_ADDRESS,
    PAYWITHSTOCK_ADDRESS: e.PAYWITHSTOCK_ADDRESS,
    PROVIDER_BOND_ADDRESS: e.PROVIDER_BOND_ADDRESS,
    RECEIPT_ANCHOR_ADDRESS: e.RECEIPT_ANCHOR_ADDRESS,
    ROYALTY_ADDRESS: e.ROYALTY_ADDRESS,
    PAYMASTER_ADDRESS: e.PAYMASTER_ADDRESS,
  };
  if (escrowMode) {
    if (!e.ESCROW_ADDRESS) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_ADDRESS.");
    // Escrow mode skips the contract custody checks, so it must not run beside live contracts.
    const set = Object.entries(contractAddresses).filter(([, v]) => v).map(([k]) => k);
    if (set.length) throw new Error(`PAYMENTS_MODE=escrow must not configure contracts (${set.join(", ")}).`);
  }
  if (e.ESCROW_HAIRCUT_BPS < 0 || e.ESCROW_HAIRCUT_BPS >= 10_000) throw new Error("ESCROW_HAIRCUT_BPS must be between 0 and 9999.");
  if (e.ESCROW_MAX_PRICE_AGE_S <= 0) throw new Error("ESCROW_MAX_PRICE_AGE_S must be positive.");
  if (e.ESCROW_REORG_HORIZON_BLOCKS <= 0) throw new Error("ESCROW_REORG_HORIZON_BLOCKS must be positive.");
  if (production) {
    if (escrowMode && e.ESCROW_START_BLOCK == null && e.CHAIN_START_BLOCK == null) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_START_BLOCK in production, so no transfer before the watcher starts is missed.");
    if (!e.APP_SECRET || e.APP_SECRET.length < 32) throw new Error("APP_SECRET (>= 32 chars) is required in production.");
    if (!e.ADMIN_TOKEN || e.ADMIN_TOKEN.length < 24) throw new Error("ADMIN_TOKEN (>= 24 chars) is required in production.");
    if (e.ALLOW_DEV_ATTESTATION) throw new Error("ALLOW_DEV_ATTESTATION must be false in production.");
    if (!e.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be https in production.");
    if (!/^postgres(?:ql)?:/.test(e.DATABASE_URL)) throw new Error("PostgreSQL is required in production.");
    const database = new URL(e.DATABASE_URL);
    if (!database.password || ["trellis", "postgres", "password"].includes(decodeURIComponent(database.password))) throw new Error("Nondefault database credential is required in production.");
    if (!e.REDIS_URL || !/^rediss?:/.test(e.REDIS_URL) || !new URL(e.REDIS_URL).password) throw new Error("Production requires authenticated Redis.");
    if (e.RUNTIME_ROLE === "all") throw new Error("Production requires separate api and worker roles.");
    if (e.AUTO_MIGRATE) throw new Error("Production requires AUTO_MIGRATE=false and a completed migration job.");
    if (e.HOST === "127.0.0.1" || e.HOST === "localhost" || e.HOST === "::1") throw new Error("Production HOST must be externally reachable.");
    // Which programs production requires follows LAUNCH_TIER (src/solana/launch-config.ts): `full`, the default, is all
    // four as before; `minimal`, `credits` and `payments` require fewer.
    if (!escrowMode) assertLaunchTier(e);
    if (e.RUNTIME_ROLE === "api" && !escrowMode && !e.ROUTER_PRIVATE_KEY) throw new Error("Public API requires the restricted router signing role for enabled per-call payments.");
    if (e.PAYMASTER_ADDRESS && e.RUNTIME_ROLE === "api" && !e.PAYMASTER_SIGNER_KEY) throw new Error("Configured paymaster requires its signing role.");
    const roleKeys = { settlement: e.SETTLEMENT_PRIVATE_KEY, anchoring: e.ANCHORER_PRIVATE_KEY, slashing: e.SLASHER_PRIVATE_KEY, keeper: e.KEEPER_PRIVATE_KEY };
    if (e.RUNTIME_ROLE === "api" && Object.values(roleKeys).some(Boolean)) throw new Error("Public API must not receive settlement, anchoring, slashing or keeper signing keys.");
    if (e.RUNTIME_ROLE === "api" && e.TRLS_BURN_PRIVATE_KEY) throw new Error("Public API must not receive TRLS_BURN_PRIVATE_KEY: the worker that runs trls-burn holds it.");
    // Escrow mode has no contracts, so no job signs anything: receipts stay signed locally ("local"
    // anchors) and settlement and slashing are inert. No signing key belongs anywhere.
    if (escrowMode && Object.values(roleKeys).some(Boolean)) throw new Error("PAYMENTS_MODE=escrow must not receive settlement, anchoring, slashing or keeper signing keys.");
    // IPX: the oracle key signs messages and the IPX keeper key posts to the feed; neither belongs on the public API,
    // and the keeper key (a funded chain signer) stays apart from every other signing role.
    if (e.RUNTIME_ROLE === "api" && (e.IPX_ORACLE_PRIVATE_KEY || e.IPX_KEEPER_PRIVATE_KEY)) throw new Error("Public API must not receive the IPX oracle or IPX keeper key; set IPX_ORACLE_PUBLIC_KEY instead.");
    if (e.IPX_KEEPER_PRIVATE_KEY && (escrowMode || Object.values(roleKeys).some(Boolean))) throw new Error("IPX_KEEPER_PRIVATE_KEY must be isolated from every other signing role.");
    // V6 R: the refund treasury key moves funds, so it lives only on the worker that runs makegood-payouts, alone.
    if (e.MAKEGOOD_REFUND_PRIVATE_KEY && (e.RUNTIME_ROLE === "api" || Object.values(roleKeys).some(Boolean) || e.IPX_KEEPER_PRIVATE_KEY)) throw new Error("MAKEGOOD_REFUND_PRIVATE_KEY must be isolated on the worker that runs makegood-payouts.");
    if (e.RUNTIME_ROLE === "worker") {
      const names = e.WORKER_JOBS.split(",").map((v) => v.trim()).filter(Boolean);
      const allowed = ["health-flush", "holds-expire", "catalog-refresh", "provider-registry", "health-probes", "canaries", "attestor", "receipts-anchor", "receipt-key-rotation", "settlement", "slasher", "chain-indexer", "paywith-aggregator", "escrow-indexer", "spend-watch", "alert-notifier", "telegram-bot", "measurements", "blind-key-rotation", "ipx-oracle", "dayzero", "ohttp-key-rotation", "host-anchor", "tlog", "batches", "skills-mirror", "sanctions-refresh", "tab-close"];
      allowed.push("weekly-summary"); // B120
      allowed.push("media-jobs"); // the media update: follows pending image and video generations to their end
      allowed.push("trls-price", "trls-burn"); // paying in $TRLS: the price sampler, and the burn of what deposits paid
      allowed.push("deposit-pings"); // B123
      allowed.push("low-balance-alerts"); // B119
      allowed.push("webhooks"); // V86: bounded event delivery.
      allowed.push("makegood-payouts"); // V6 R: on-chain make-good refunds.
      allowed.push("upstream-monitor"); // ON3
      allowed.push("tools-reconcile", "tools-canary"); // v6 T: the paid tool market's holds and canary probes.
      allowed.push("agent-alerts", "agent-policy-retention", "agent-ledger-retention", "host-bond-indexer", "host-slasher");
      allowed.push("bushel-shortfalls"); // §5.6: the after-window shortfall check (signs with BUSHEL_AUTHORITY_ROLE)
      allowed.push("supply-warm-pool", "catalog-auto-list", "honest-ledger"); // §2 supply warm pool and auto-listing; §9 daily public volume stats
      allowed.push("shadow", "hvx", "canary-evidence", "tab-close"); // §3 shadow re-execution, §5.6 index, §5.3 canary evidence, §5.2 tab close
      allowed.push("x402-recovery-expire"); // x402 payment recovery retention
      allowed.push("agent-liveness", "agent-identity"); // v6 I: daily signed endpoint probes; isolated ERC-8004 registrar.
      allowed.push("agent-pay-verify"); // Pay another agent: re-reads confirmed payments on chain; holds no signing key.
      allowed.push("provider-reconcile", "job-watchdog"); // round 4: the daily provider reconciliation; job liveness (every worker runs it)
      if (!names.length || names.some((n) => !allowed.includes(n))) throw new Error("Worker requires an explicit valid WORKER_JOBS list.");
      // The keeper key signs only the Bushel authority calls, and only when BUSHEL_AUTHORITY_ROLE names it.
      const keyJobs = { settlement: "settlement", anchoring: "receipts-anchor", slashing: "slasher", keeper: "bushel-shortfalls" };
      if (Object.values(roleKeys).filter(Boolean).length > 1) throw new Error("Privileged worker signing roles must be isolated.");
      if (names.includes("ipx-oracle") && !(e.IPX_ORACLE_ENABLED && e.IPX_ORACLE_PRIVATE_KEY)) throw new Error("The ipx-oracle job needs IPX_ORACLE_ENABLED and IPX_ORACLE_PRIVATE_KEY.");
      if (names.includes("host-anchor") && !e.HOST_ANCHOR_ENABLED) throw new Error("The host-anchor job needs HOST_ANCHOR_ENABLED.");
      if (names.includes("makegood-payouts") && !(e.MAKEGOOD_ENABLED && e.MAKEGOOD_REFUND_PRIVATE_KEY)) throw new Error("The makegood-payouts job needs MAKEGOOD_ENABLED and MAKEGOOD_REFUND_PRIVATE_KEY.");
      if (e.MAKEGOOD_REFUND_PRIVATE_KEY && !names.includes("makegood-payouts")) throw new Error("MAKEGOOD_REFUND_PRIVATE_KEY belongs only on the worker that runs makegood-payouts.");
      if (!escrowMode)
        for (const [role, key] of Object.entries(roleKeys)) {
          const enabled = role === "keeper"
            ? names.includes(keyJobs.keeper) && e.BUSHELS_ENABLED && e.BUSHEL_AUTHORITY_ROLE === "keeper"
            : names.includes(keyJobs[role as keyof typeof keyJobs]) || (role === "slashing" && names.includes("host-slasher") && e.NETWORK_SLASHING_ENABLED);
          // Without trellis_credits (LAUNCH_TIER=minimal) the settlement job has nothing on chain to sign, so it may run keyless.
          if (role === "settlement" && enabled && !key && !solana.programs.credits) continue;
          if (enabled !== !!key) throw new Error(`Worker ${role} job and signing-key configuration must match.`);
        }
    }
  }
  const verifierNames = e.ATTESTATION_VERIFIERS.split(",").map((v) => v.trim()).filter(Boolean);
  if (!verifierNames.length || verifierNames.some((v) => !["dcap", "intel-ta", "dstack", "tee-cloud"].includes(v))) throw new Error("ATTESTATION_VERIFIERS must list dcap, intel-ta, dstack and/or teeCloud.");
  if (new Set(verifierNames).size !== verifierNames.length) throw new Error("ATTESTATION_VERIFIERS lists a verifier twice.");
  if (verifierNames.includes("intel-ta") && !e.INTEL_TA_API_KEY) throw new Error("ATTESTATION_VERIFIERS includes intel-ta, which needs INTEL_TA_API_KEY.");
  if (verifierNames.includes("dstack") && !e.DSTACK_VERIFIER_URL) throw new Error("ATTESTATION_VERIFIERS includes dstack, which needs DSTACK_VERIFIER_URL.");
  if (production) {
    // R4-14: a verifier's answer is only as good as the channel it came over.
    if (verifierNames.includes("dcap") && e.TDX_VERIFIER_URL && !e.TDX_VERIFIER_URL.startsWith("https://")) throw new Error("TDX_VERIFIER_URL must be https in production.");
    if (verifierNames.includes("dstack") && e.DSTACK_VERIFIER_URL && !e.DSTACK_VERIFIER_URL.startsWith("https://")) throw new Error("DSTACK_VERIFIER_URL must be https in production.");
    if (verifierNames.includes("intel-ta") && !(e.INTEL_TA_URL.startsWith("https://") && e.INTEL_TA_JWKS_URL.startsWith("https://"))) throw new Error("INTEL_TA_URL and INTEL_TA_JWKS_URL must be https in production.");
    if (e.MEASUREMENTS_ENABLED && !e.REKOR_URL.startsWith("https://")) throw new Error("REKOR_URL must be https in production.");
    if (verifierNames.includes("tee-cloud") && !e.TEE_CLOUD_VERIFIER_URL.startsWith("https://")) throw new Error("TEE_CLOUD_VERIFIER_URL must be https in production.");
    // R5-11: tee-cloud and dstack report no TCB status, so alone they attest a quote from a revoked or out-of-date
    // platform. The launch surface refuses to start without a verifier that checks one. (On the full surface the
    // attestor refuses such a list each time it verifies a quote: services/attestor.ts `verifyQuote`.)
    if (surface.surface === "core" && !verifierNames.some((v) => v === "dcap" || v === "intel-ta")) throw new Error("ATTESTATION_VERIFIERS must include dcap (with TDX_VERIFIER_URL) or intel-ta (with INTEL_TA_API_KEY) in production: tee-cloud and dstack report no TCB status, so a revoked or out-of-date platform would be attested.");
    if (!e.NRAS_ISSUER.startsWith("https://") || (e.NRAS_JWKS_URL && !e.NRAS_JWKS_URL.startsWith("https://"))) throw new Error("NRAS_ISSUER and NRAS_JWKS_URL must be https in production.");
  }
  const launch = launchSettings(e, production, solana.programs, e.CALLPAY_ADDRESS);
  // Contract-path guards: verified deployment (H-02), network burn oracle (M-05), PayWithStock delegation (M-06).
  const contractPath = contractPathGuards(e, production, escrowMode);
  const faucet = faucetSettings(e, production);
  if (e.DEV_FAUCET) {
    if (production) throw new Error("DEV_FAUCET must be false in production.");
    let host = "";
    try {
      host = new URL(e.SOL_RPC_URL).hostname;
    } catch {
      /* reported below */
    }
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("DEV_FAUCET only works against a local chain (SOL_RPC_URL on 127.0.0.1/localhost).");
    if (!e.DEV_FAUCET_PRIVATE_KEY) throw new Error("DEV_FAUCET needs DEV_FAUCET_PRIVATE_KEY (a funded local development account).");
  }
  // The bot token is optional and secret (it is part of every Telegram API URL): never echo it.
  // The API only issues and checks link codes; every Telegram message is sent by the process that runs the bot and
  // alert jobs, so only roles that run jobs need the bot token.
  if (e.AGENT_GUARD_ENABLED && !e.AGENT_POLICY_ENABLED) throw new Error("AGENT_GUARD_ENABLED requires AGENT_POLICY_ENABLED."); // V98
  if (e.AGENT_PAY_ENABLED && !e.AGENT_GUARD_ENABLED) throw new Error("AGENT_PAY_ENABLED requires AGENT_GUARD_ENABLED.");
  if (e.AGENT_PAY_ENABLED && !e.USDC_ADDRESS) throw new Error("AGENT_PAY_ENABLED requires USDC_ADDRESS.");
  if (e.TELEGRAM_LINKING_ENABLED && !e.AGENT_POLICY_ENABLED) throw new Error("TELEGRAM_LINKING_ENABLED requires AGENT_POLICY_ENABLED.");
  if (e.WEEKLY_SUMMARY_ENABLED && !e.TELEGRAM_LINKING_ENABLED) throw new Error("WEEKLY_SUMMARY_ENABLED requires TELEGRAM_LINKING_ENABLED."); // B120
  if (e.TELEGRAM_LINKING_ENABLED && e.RUNTIME_ROLE !== "api" && !e.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_LINKING_ENABLED requires TELEGRAM_BOT_TOKEN on the worker (or a combined role).");
  if (e.TELEGRAM_BOT_TOKEN && !/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(e.TELEGRAM_BOT_TOKEN)) throw new Error("TELEGRAM_BOT_TOKEN must be the token BotFather issued (<id>:<secret>).");
  // The webhook is optional: without it the alert-notifier job only records state. Never echo the URL.
  if (e.ALERT_WEBHOOK_URL) {
    let protocol = "";
    try { protocol = new URL(e.ALERT_WEBHOOK_URL).protocol; } catch { /* reported below */ }
    if (protocol !== "https:" && (production || protocol !== "http:")) throw new Error("ALERT_WEBHOOK_URL must be an https URL.");
  }
  if (!(e.BACKUP_MAX_AGE_HOURS > 0)) throw new Error("BACKUP_MAX_AGE_HOURS must be positive.");
  if (e.PER_CALL_MARGIN_BPS > 100) throw new Error("PER_CALL_MARGIN_BPS must be <= 100 (1%).");
  // R4-03: nothing funds a batch discount at zero markup; the provider is owed the full price of every line.
  if (e.BATCH_DISCOUNT_BPS > e.PROVIDER_FEE_BPS) throw new Error("BATCH_DISCOUNT_BPS is a discount the operator pays: each batch line is owed to its provider at the full price. Set it to 0, or fund it with a margin: PROVIDER_FEE_BPS at least as large.");
  if (production && e.X402_PAY_TO && e.RUNTIME_ROLE === "api" && !e.ROUTER_PRIVATE_KEY) throw new Error("X402_PAY_TO requires the router signing role (ROUTER_PRIVATE_KEY) to relay x402 settlements.");
  const tokenList = z.array(
    z.object({
      symbol: z.string().min(1).max(16),
      address: z.string().regex(ADDRESS_RE),
      decimals: z.number().int().min(0).max(36),
      // A price feed: a Pyth price feed id (0x + 64 hex, as Hermes names it) or a base58 32-byte feed account address.
      feed: z.string().regex(/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, "must be a Pyth feed id (0x + 64 hex) or a base58 address").optional(),
      name: z.string().optional(),
    }),
  );
  let paywithTokens: PaywithToken[] = [];
  if (e.PAYWITH_TOKENS) {
    try {
      paywithTokens = tokenList.parse(JSON.parse(e.PAYWITH_TOKENS));
    } catch (err) {
      throw new Error(`PAYWITH_TOKENS must be a JSON array of {symbol,address,decimals,feed?}: ${(err as Error).message}`);
    }
  }
  let escrowTokens: EscrowToken[] = [];
  try {
    const listed = e.ESCROW_TOKENS ? tokenList.parse(JSON.parse(e.ESCROW_TOKENS)) : paywithTokens;
    if (e.ESCROW_TOKENS && listed.some((t) => !t.feed)) throw new Error("every token needs a feed");
    escrowTokens = listed.filter((t): t is EscrowToken => !!t.feed);
  } catch (err) {
    throw new Error(`ESCROW_TOKENS must be a JSON array of {symbol,address,decimals,feed}: ${(err as Error).message}`);
  }
  const lower = escrowTokens.map((t) => t.address); // base58 is case-sensitive: compared as written
  if (new Set(lower).size !== lower.length) throw new Error("ESCROW_TOKENS lists a token address twice.");
  if (escrowMode && !escrowTokens.length) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_TOKENS (or PAYWITH_TOKENS) with price feeds.");
  const councilModels = (e.TRELLIS_COUNCIL_MODELS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (councilModels.length && (councilModels.length < 2 || councilModels.length > 5 || new Set(councilModels).size !== councilModels.length))
    throw new Error("TRELLIS_COUNCIL_MODELS must list 2 to 5 distinct model ids.");
  const trlsEscrow = trlsEscrowConfig(e, lower);
  const usdcEscrow = usdcEscrowConfig(e, lower, trlsEscrow);
  const holders = holderSettings(e, trlsEscrow, surface.surface === "core");
  return {
    /** LAUNCH_SURFACE: `core` (default) registers only the allow-listed routes and jobs (src/surface/). */
    surface: surface.surface,
    /** Settings dropped because they would switch on a feature that is not on the core surface (never in production: it refuses). */
    surfaceIgnored: surface.ignored,
    /** Release switches: which prepared updates are on for this process (src/features.json, FEATURE_<NAME>, FEATURES). */
    updates,
    /** Images and video (the media update, src/api/media.ts): the provider row that carries the media catalogue, and orders per account per minute. */
    media: { providerId: e.MEDIA_PROVIDER_ID, perMinute: e.MEDIA_PER_MINUTE },
    adminAllowedSources: adminSources(e.ADMIN_ALLOWED_SOURCES),
    fastCredit: fastCreditSettings(e), // V97
    depositPingsEnabled: e.DEPOSIT_PINGS_ENABLED, // B123
    env: e.TRELLIS_ENV,
    production,
    developerFirstCallEnabled: e.DEVELOPER_FIRST_CALL_ENABLED, // ON2
    identity: identitySettings(e), // v6 I
    routeExplain: e.ROUTE_EXPLAIN_ENABLED, // V84
    hostDashboard: { enabled: e.HOST_DASHBOARD_ENABLED },
    sanctions: sanctionsSettings(e, production),
    facilitator: facilitatorSettings(e, production), // v6 F
    e2ee: e2eeSettings(e.E2EE_PASSTHROUGH_ENABLED, e.PROVIDERS_FILE, production, { baseUrl: e.E2EE_GATEWAY_BASE_URL, attestationUrl: e.E2EE_GATEWAY_ATTESTATION_URL }),
    networkHosts: networkHostsSettings(e, production),
    inferenceKeysEnabled: e.INFERENCE_KEYS_ENABLED, // ZK6
    statementsEnabled: e.STATEMENTS_ENABLED, // V87
    networkStatsEnabled: e.NETWORK_STATS_ENABLED,
    rush: rushSettings(e), // ON3
    tools: toolsSettings(e, production), // v6 T: off unless TOOLS_MARKET_ENABLED.
    holds: loadHoldConfig(overrides), // R3-02 / R3-25: HOLD_* settings, see src/router/hold-config.ts.
    spendInsightsEnabled: e.SPEND_INSIGHTS_ENABLED, // V88: read-only spend insights.
    dataTools: dataToolsSettings(e), // B
    decisionTagsEnabled: e.DECISION_TAGS_ENABLED, // B
    webhookSigningEnabled: e.WEBHOOK_SIGNING_ENABLED, // V86: off preserves existing delivery.
    makegood: { enabled: e.MAKEGOOD_ENABLED, refundKey: e.MAKEGOOD_REFUND_PRIVATE_KEY }, // V6 R
    networkPayouts: networkPayoutSettings(e, production),
    networkWeights: { ...networkWeightSettings(e), ...(e.NETWORK_BONDS_ENABLED ? { bonds: { ...hostBondSettings(e), scope: `${e.CHAIN_ID}:${e.HOST_BOND_ADDRESS}` } } : {}) },
    hostBonds: hostBondSettings(e),
    runtimeRole: e.RUNTIME_ROLE,
    autoMigrate: e.AUTO_MIGRATE,
    workerJobs: e.WORKER_JOBS.split(",").map((n) => n.trim()).filter(Boolean),
    test: e.TRELLIS_ENV === "test",
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    lowBalanceAlertsEnabled: e.LOW_BALANCE_ALERTS_ENABLED, // B119
    siteUrl: (e.SITE_URL ?? e.PUBLIC_BASE_URL).replace(/\/$/, ""),
    webauthn: {
      rpId: e.WEBAUTHN_RP_ID ?? new URL(e.PUBLIC_BASE_URL).hostname,
      origins: e.WEBAUTHN_ORIGINS ? e.WEBAUTHN_ORIGINS.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean) : [new URL(e.PUBLIC_BASE_URL).origin],
    },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appSecret: e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure",
    adminToken: e.ADMIN_TOKEN,
    agentProfilesEnabled: e.AGENT_PROFILES_ENABLED,
    agentPolicyEnabled: e.AGENT_POLICY_ENABLED,
    agentRulebookWordsEnabled: e.AGENT_RULEBOOK_WORDS_ENABLED, // B124
    agentGuardEnabled: e.AGENT_GUARD_ENABLED, // V98
    agentPayEnabled: e.AGENT_PAY_ENABLED,
    agentSealedEnabled: e.AGENT_SEALED_ENABLED,
    agentApprovalTtlS: e.AGENT_APPROVAL_TTL_S,
    networkPolicyEnabled: e.NETWORK_POLICY_ENABLED,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    hardening: hardeningSettings(e), // HD1
    release: { commit: contractPath.releaseCommit, deployment: contractPath.deployment },
    receipts: {
      signingKey: e.RECEIPT_SIGNING_KEY,
      rotationDays: e.RECEIPT_KEY_ROTATION_DAYS,
      anchorIntervalMs: e.ANCHOR_INTERVAL_MS,
      keySyncMs: e.RECEIPT_KEY_SYNC_MS,
    },
    solana,
    launch,
    chain: {
      id: e.CHAIN_ID,
      network: e.SOLANA_NETWORK,
      rpcUrl,
      ...rpc, // RPC1
      commitment: e.SOLANA_COMMITMENT,
      publicRpcUrl: e.PUBLIC_RPC_URL,
      explorerUrl: e.EXPLORER_URL,
      confirmations: e.CHAIN_CONFIRMATIONS,
      startBlock: e.CHAIN_START_BLOCK,
      usdc: e.USDC_ADDRESS,
      // The Trellis programs under the names the services grew up with; TRELLIS_*_PROGRAM_ID wins over the older key.
      credits: solana.programs.credits ?? e.CREDITS_ADDRESS,
      callPay: e.CALLPAY_ADDRESS,
      payWithStock: e.PAYWITHSTOCK_ADDRESS,
      providerBond: solana.programs.bond ?? e.PROVIDER_BOND_ADDRESS,
      receiptAnchor: solana.programs.anchor ?? e.RECEIPT_ANCHOR_ADDRESS,
      royalty: e.ROYALTY_ADDRESS,
      paymaster: e.PAYMASTER_ADDRESS,
      callPayTreasury: e.CALLPAY_TREASURY,
      routerKey: e.ROUTER_PRIVATE_KEY,
      settlementKey: e.SETTLEMENT_PRIVATE_KEY,
      anchorerKey: e.ANCHORER_PRIVATE_KEY,
      paymasterSignerKey: e.PAYMASTER_SIGNER_KEY,
      paymasterAccountRuntimes: e.PAYMASTER_ACCOUNT_RUNTIMES,
      slasherKey: e.SLASHER_PRIVATE_KEY,
      keeperKey: e.KEEPER_PRIVATE_KEY,
      ipxKeeperKey: e.IPX_KEEPER_PRIVATE_KEY,
      faucetKey: (e.DEV_FAUCET || faucet.enabled ? e.DEV_FAUCET_PRIVATE_KEY : undefined),
      poolManager: e.TRLS_POOL_PROGRAM,
    },
    fees: {
      perCallMarginBps: e.PER_CALL_MARGIN_BPS,
      providerFeeBps: e.PROVIDER_FEE_BPS,
      byokFeeBps: e.BYOK_FEE_BPS,
      defaultRoyaltyBps: e.DEFAULT_ROYALTY_BPS,
      quoteTtlS: e.PER_CALL_QUOTE_TTL_S,
      perCallMaxUsd: e.PER_CALL_MAX_USD,
      paymentWaitMs: e.PAYMENT_WAIT_MS,
    },
    x402: { payTo: e.X402_PAY_TO, network: e.X402_NETWORK },
    paywith: {
      thresholdUsd: e.PAYWITH_THRESHOLD_USD,
      maxAgeH: e.PAYWITH_MAX_AGE_H,
      maxDebtUsd: e.PAYWITH_MAX_DEBT_USD,
      maxSlipBps: e.PAYWITH_MAX_SLIP_BPS,
      capHaircutBps: e.PAYWITH_CAP_HAIRCUT_BPS,
      maxDailyCapUsd: contractPath.maxDailyCapUsd,
      tokens: paywithTokens,
      jupiterUrl: e.JUPITER_API_URL.replace(/\/$/, ""),
      pythUrl: e.PYTH_HERMES_URL.replace(/\/$/, ""),
      sessionMode: e.PAYWITH_SESSION_MODE,
    },
    /** Tab billing (docs §5.2): the payee tabs must name; null falls back to X402_PAY_TO, then the router key (src/solana/tab-billing.ts). */
    tab: { payee: e.TAB_PAYEE ?? null },
    faucet,
    escrow: {
      mode: e.PAYMENTS_MODE,
      address: e.ESCROW_ADDRESS,
      tokens: escrowTokens,
      haircutBps: e.ESCROW_HAIRCUT_BPS,
      maxPriceAgeS: e.ESCROW_MAX_PRICE_AGE_S,
      startBlock: e.ESCROW_START_BLOCK ?? e.CHAIN_START_BLOCK,
      finality: e.ESCROW_FINALITY,
      reorgHorizonBlocks: e.ESCROW_REORG_HORIZON_BLOCKS,
    },
    trlsEscrow, // null unless TRLS_TOKEN_ADDRESS is set
    usdcEscrow, // null unless USDC_ESCROW_ENABLED
    routing: {
      outageWindowMs: e.OUTAGE_WINDOW_MS,
      probeIntervalMs: e.HEALTH_PROBE_INTERVAL_MS,
      probes: e.HEALTH_PROBES,
      providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
      firstTokenTimeoutMs: e.FIRST_TOKEN_TIMEOUT_MS,
      cancelDrainMs: e.STREAM_CANCEL_DRAIN_MS,
      reconcileGapAlarmUsd: e.RECONCILE_GAP_ALARM_USD,
      maxAttempts: e.MAX_PROVIDER_ATTEMPTS,
      empty200SlashThreshold: e.EMPTY200_SLASH_THRESHOLD,
      uptimeSlashThreshold: e.UPTIME_SLASH_THRESHOLD,
      attestedBonus: { public: e.ATTESTED_BONUS_PUBLIC, attested: e.ATTESTED_BONUS_ATTESTED, unlinkable: e.ATTESTED_BONUS_UNLINKABLE },
    },
    canaries: { intervalMs: e.CANARY_INTERVAL_MS, enabled: e.CANARIES, shadowDays: e.SHADOW_DAYS },
    /** The escrow wallet's key and who pays the fee, for the burn of what $TRLS deposits paid (src/solana/trls-burn.ts). */
    trlsBurn: { key: e.TRLS_BURN_PRIVATE_KEY, feePayer: e.TRLS_BURN_FEE_PAYER },
    hfBaseUrl: e.HF_BASE_URL.replace(/\/$/, ""),
    webDir: e.WEB_DIR,
    zkapiPageOrigins: e.ZKAPI_PAGE_ORIGINS, // ZK10
    status: {
      targets: { public: e.STATUS_SLO_PUBLIC, attested: e.STATUS_SLO_ATTESTED, unlinkable: e.STATUS_SLO_UNLINKABLE },
      suggestMinRequests: e.STATUS_SUGGEST_MIN_REQUESTS,
    },
    attestation: {
      intervalMs: e.ATTESTATION_INTERVAL_MS,
      historyDays: e.ATTESTATION_HISTORY_DAYS,
      allowDev: e.ALLOW_DEV_ATTESTATION && !production,
      requireAllowlist: requireAttestationAllowlist(e.ATTESTATION_REQUIRE_ALLOWLIST, production),
      // R4-14: in production a quote verifier's answer must carry a TCB status, and an accepted one.
      requireTcbStatus: production,
      // R5-02: on the launch surface the attested lane's only supply is aci/1 gateways (keyset, TLS key pin, receipts),
      // so a production router there attests a provider by an aci/1 report and by nothing else (services/attestor.ts).
      gatewayOnly: production && surface.surface === "core",
      nrasUrl: e.NVIDIA_NRAS_URL,
      nrasIssuer: e.NRAS_ISSUER.replace(/\/+$/, ""),
      nrasJwksUrl: e.NRAS_JWKS_URL ?? `${e.NRAS_ISSUER.replace(/\/+$/, "")}/.well-known/jwks.json`,
      tdxVerifierUrl: e.TDX_VERIFIER_URL,
      tdxVerifierKey: e.TDX_VERIFIER_KEY,
      verifiers: verifierNames as ("dcap" | "intel-ta" | "dstack" | "tee-cloud")[],
      intelTa: { url: e.INTEL_TA_URL, jwksUrl: e.INTEL_TA_JWKS_URL, apiKey: e.INTEL_TA_API_KEY },
      dstackVerifierUrl: e.DSTACK_VERIFIER_URL,
      dstackVerifierKey: e.DSTACK_VERIFIER_KEY,
      teeCloudVerifierUrl: e.TEE_CLOUD_VERIFIER_URL,
    },
    measurements: {
      enabled: e.MEASUREMENTS_ENABLED,
      intervalMs: e.MEASUREMENTS_INTERVAL_MS,
      rekorUrl: e.REKOR_URL.replace(/\/$/, ""),
      rekorPublicKey: e.REKOR_PUBLIC_KEY?.replace(/\\n/g, "\n").trim(),
      publicKey: measurementPublicKey(e.MEASUREMENT_PUBLIC_KEY),
      registry: e.TRELLIS_MEASUREMENTS_PROGRAM_ID ?? e.MEASUREMENT_REGISTRY_ADDRESS ?? null,
      onchainSubmit: e.MEASUREMENTS_ONCHAIN_SUBMIT,
      authorityRole: e.MEASUREMENT_AUTHORITY_ROLE,
      policyVersion: e.MEASUREMENT_POLICY_VERSION,
      registryCacheMs: Math.max(0, e.MEASUREMENT_REGISTRY_CACHE_MS),
    },
    lane: laneSettings(e),
    workers: {
      enabled: e.WORKERS && e.RUNTIME_ROLE !== "api",
      settlementIntervalMs: e.SETTLEMENT_INTERVAL_MS,
      registryIntervalMs: e.PROVIDER_REGISTRY_INTERVAL_MS,
      providersFile: e.PROVIDERS_FILE,
    },
    gateway: {
      otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelServiceName: e.OTEL_SERVICE_NAME,
      cacheTtlS: e.CACHE_TTL_S,
      semanticThreshold: e.SEMANTIC_CACHE_THRESHOLD,
      semanticEmbeddingModel: e.SEMANTIC_CACHE_EMBEDDING_MODEL,
    },
    anthropic: { modelMap: parseModelMap(e.ANTHROPIC_MODEL_MAP) },
    // Off unless enabled. Council members and the judge are billed and receipted like any other call.
    structuredOutputCheckEnabled: e.STRUCTURED_OUTPUT_CHECK_ENABLED, // V83
    features: { council: e.TRELLIS_FEATURE_COUNCIL },
    council: { models: councilModels, judge: e.TRELLIS_COUNCIL_JUDGE ?? null, mode: e.TRELLIS_COUNCIL_MODE },
    rag: { maxDocuments: e.RAG_MAX_DOCUMENTS, maxBytes: e.RAG_MAX_BYTES, maxChunks: e.RAG_MAX_CHUNKS, maxEmbeddingCalls: e.RAG_MAX_EMBEDDING_CALLS },
    batch: {
      discountBps: e.BATCH_DISCOUNT_BPS,
      maxLines: e.BATCH_MAX_LINES,
      maxBytes: e.BATCH_MAX_BYTES,
      maxActive: e.BATCH_MAX_ACTIVE,
      resultsTtlS: e.BATCH_RESULTS_TTL,
      intervalMs: e.BATCH_INTERVAL_MS,
      linesPerTick: e.BATCH_LINES_PER_TICK,
      concurrency: Math.max(1, e.BATCH_CONCURRENCY),
      maxAttempts: Math.max(1, e.BATCH_LINE_MAX_ATTEMPTS),
    },
    skills: skillsSettings(e, production),
    limits: { defaultRpm: e.DEFAULT_RPM, defaultTpm: e.DEFAULT_TPM, unauthRpm: e.UNAUTH_RPM, newKeysPerHour: e.NEW_KEYS_PER_HOUR, accountRpm: e.ACCOUNT_RPM, inflightPerKey: e.INFLIGHT_PER_KEY, inflightPerSource: e.INFLIGHT_PER_SOURCE, slowCallsPer10Min: e.SLOW_CALLS_PER_10MIN },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL, webhookFormat: e.ALERT_WEBHOOK_FORMAT },
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, linkingEnabled: e.TELEGRAM_LINKING_ENABLED },
    weeklySummaryEnabled: e.WEEKLY_SUMMARY_ENABLED, // B120
    backup: { required: e.BACKUP_REQUIRED, maxAgeHours: e.BACKUP_MAX_AGE_HOURS },
    holders,
    ipx: ipxSettings(e),
    blind: blindSettings(e),
    ohttp: ohttpSettings(e, production),
    onion: onionSettings(e),
    unlinkable: unlinkableSettings(e),
    hostAnchor: hostAnchorSettings(e),
    tlog: tlogSettings(e, production),
    serviceFees: serviceFeeSettings(e),
    supply: supplySettings(e), // §2: warm pool on rented GPU networks
    bushels: bushelSettings(e), // §5.6: prepaid capacity
    autoList: autoListSettings(e), // §2: catalogue auto-listing
    honestLedger: honestLedgerSettings(e), // §9
  };
}

// ---- Flat service fees (src/services/settlement.ts payServiceFees) ----------------------------------------------------
export type ServiceFeeRecipient = { role: string; address: string; usdcPerWeek: bigint };
const USDC_DECIMAL = /^\d+(\.\d{1,6})?$/;
/** SERVICE_FEE_RECIPIENTS: who the weekly settlement pays a flat USDC amount, from the treasury settlement wallet. */
function serviceFeeSettings(e: Env): { recipients: ServiceFeeRecipient[] } {
  if (!e.SERVICE_FEE_RECIPIENTS) return { recipients: [] };
  const list = z.array(z.object({
    role: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,31}$/, "role must be a short lowercase name such as relay or canary"),
    address: z.string().regex(ADDRESS_RE, "address must be a base58 Solana address"),
    usdc_per_week: z.union([z.string(), z.number().finite()]).transform(String).pipe(z.string().regex(USDC_DECIMAL, "usdc_per_week must be a USDC amount like \"25\" or \"12.50\" (at most 6 decimals)")),
  })).max(64);
  let parsed: z.infer<typeof list>;
  try {
    parsed = list.parse(JSON.parse(e.SERVICE_FEE_RECIPIENTS));
  } catch (err) {
    throw new Error(`SERVICE_FEE_RECIPIENTS must be a JSON array of {role,address,usdc_per_week}: ${(err as Error).message}`);
  }
  const units = (v: string) => { const [whole, frac = ""] = v.split("."); return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0")); };
  const recipients = parsed.map((r) => ({ role: r.role, address: r.address, usdcPerWeek: units(r.usdc_per_week) }));
  if (recipients.some((r) => r.usdcPerWeek <= 0n)) throw new Error("SERVICE_FEE_RECIPIENTS: every usdc_per_week must be above 0.");
  const seen = new Set(recipients.map((r) => `${r.role}:${r.address}`));
  if (seen.size !== recipients.length) throw new Error("SERVICE_FEE_RECIPIENTS lists the same role and address twice.");
  return { recipients };
}

/** ATTESTATION_REQUIRE_ALLOWLIST: on in production whatever is set (and "false" there is refused, not ignored); elsewhere as set, off by default. */
function requireAttestationAllowlist(setting: boolean | undefined, production: boolean): boolean {
  if (production && setting === false) throw new Error("ATTESTATION_REQUIRE_ALLOWLIST must not be false in production: an attested gateway is attested only against a configured measurement allow-list (MRTD, RTMR0 to RTMR3 and the keyset digest at least).");
  return production || setting === true;
}

/**
 * FAUCET_ENABLED: test USDC on localnet or devnet only. Refused in production and on mainnet-beta (SOLANA_NETWORK); needs
 * DEV_FAUCET_PRIVATE_KEY, the mint authority of the test USDC mint (USDC_ADDRESS on that cluster).
 */
function faucetSettings(e: Env, production: boolean) {
  if (!e.FAUCET_ENABLED) return { enabled: false as const };
  if (production) throw new Error("FAUCET_ENABLED must be false in production.");
  if (e.SOLANA_NETWORK === SOLANA_MAINNET_CAIP2) throw new Error("FAUCET_ENABLED is refused on mainnet-beta (SOLANA_NETWORK): the faucet is for localnet and devnet only.");
  if (!e.DEV_FAUCET_PRIVATE_KEY) throw new Error("FAUCET_ENABLED needs DEV_FAUCET_PRIVATE_KEY (the test USDC mint authority).");
  return { enabled: true as const };
}

function onionSettings(e: Env) {
  const secrets = parseOnionSecrets(e.ONION_PROXY_SECRET);
  const address = e.ONION_ADDRESS ? parseOnionAddress(e.ONION_ADDRESS) : null;
  if (address && !secrets.length) throw new Error("ONION_ADDRESS requires ONION_PROXY_SECRET, the secret the onion proxy sends, so requests that arrive over Tor are not limited as one client.");
  if (!Number.isInteger(e.ONION_POOL_MULTIPLIER) || e.ONION_POOL_MULTIPLIER < 1 || e.ONION_POOL_MULTIPLIER > 1000) throw new Error("ONION_POOL_MULTIPLIER must be an integer from 1 to 1000.");
  return { address, secrets, poolMultiplier: e.ONION_POOL_MULTIPLIER };
}

/**
 * UNLINKABLE_VIA_ONION: the second way this router serves lane "unlinkable". The network-privacy part comes from Tor
 * instead of an independent Oblivious HTTP relay, so the switch needs the onion service this router trusts to mark its
 * requests (ONION_ADDRESS, and the ONION_PROXY_SECRET that address already requires) and blind tokens, the lane's only
 * payment. It changes nothing about OHTTP_ENABLED or its relay-operator guard; either one makes the lane available.
 */
function unlinkableSettings(e: Env) {
  if (!e.UNLINKABLE_VIA_ONION) return { viaOnion: false as boolean };
  if (!e.ONION_ADDRESS || !parseOnionSecrets(e.ONION_PROXY_SECRET).length)
    throw new Error("UNLINKABLE_VIA_ONION requires ONION_ADDRESS and ONION_PROXY_SECRET: lane unlinkable is served over Tor only to requests this router's own onion service (deploy/onion) forwarded and marked with the secret.");
  if (!e.TRELLIS_FEATURE_BLIND) throw new Error("UNLINKABLE_VIA_ONION requires TRELLIS_FEATURE_BLIND=true: the unlinkable lane is paid with blind tokens.");
  return { viaOnion: true as boolean };
}

// ---- Per-host anchoring of enclave receipts (services/host-anchor.ts) ---------------------------------------
function hostAnchorSettings(e: Env) {
  if (!Number.isInteger(e.HOST_ANCHOR_INTERVAL_MS) || e.HOST_ANCHOR_INTERVAL_MS < 60_000) throw new Error("HOST_ANCHOR_INTERVAL_MS must be at least 60000.");
  let tokens: Record<string, string> = {};
  if (e.HOST_ANCHOR_TOKENS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.HOST_ANCHOR_TOKENS);
    } catch {
      throw new Error("HOST_ANCHOR_TOKENS must be a JSON object of provider id to anchor token.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("HOST_ANCHOR_TOKENS must be a JSON object of provider id to anchor token.");
    for (const [id, token] of Object.entries(parsed)) if (!id || typeof token !== "string" || !token.trim() || /\s/.test(token)) throw new Error(`HOST_ANCHOR_TOKENS has no usable token for "${id}".`);
    tokens = parsed as Record<string, string>;
  }
  return { enabled: e.HOST_ANCHOR_ENABLED, intervalMs: e.HOST_ANCHOR_INTERVAL_MS, tokens };
}

// ---- Transparency log --------------------------------------------------------------------------------------------
export type SkillSource = { kind: "git"; url: string; ref?: string; paths?: string[] } | { kind: "index"; url: string };
const skillSourceSchema = z.array(
  z.union([
    z.object({ kind: z.literal("git"), url: z.string().min(1).max(512), ref: z.string().max(128).optional(), paths: z.array(z.string().max(255)).max(200).optional() }).strict(),
    z.object({ kind: z.literal("index"), url: z.string().url().max(512) }).strict(),
  ]),
).max(50);

function skillsSettings(e: Env, production: boolean) {
  let sources: SkillSource[] = [];
  if (e.SKILLS_SOURCES?.trim()) {
    try {
      sources = skillSourceSchema.parse(JSON.parse(e.SKILLS_SOURCES)) as SkillSource[];
    } catch {
      throw new Error("SKILLS_SOURCES must be a JSON array of { kind: git, url, ref?, paths? } or { kind: index, url } sources.");
    }
  }
  const levels = e.SKILLS_DOWNLOAD_LEVELS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!levels.length || levels.some((l) => !["trusted", "caution", "dangerous"].includes(l))) throw new Error("SKILLS_DOWNLOAD_LEVELS lists trusted, caution and/or dangerous.");
  return {
    maxBytes: e.SKILLS_MAX_BYTES,
    maxFiles: e.SKILLS_MAX_FILES,
    extraHosts: (e.SKILLS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    downloadLevels: levels as ("trusted" | "caution" | "dangerous")[],
    feeBps: e.SKILLS_FEE_BPS,
    gitTimeoutMs: e.SKILLS_GIT_TIMEOUT_MS,
    allowLocalGit: e.SKILLS_ALLOW_LOCAL_GIT && !production,
    sources,
    mirrorIntervalMs: Math.max(60_000, e.SKILLS_MIRROR_INTERVAL_MS),
  };
}

function tlogSettings(e: Env, production: boolean) {
  if (e.TLOG_REKOR_ENABLED && !e.TLOG_ENABLED) throw new Error("TLOG_REKOR_ENABLED needs TLOG_ENABLED: it records the transparency log's checkpoints in Rekor.");
  if (e.TLOG_DATA_INVENTORY && !e.TLOG_ENABLED) throw new Error("TLOG_DATA_INVENTORY needs TLOG_ENABLED: it appends the data inventory's hash to the transparency log.");
  if (!e.TLOG_ENABLED) return { enabled: false as boolean, dataInventory: false as boolean, origin: "", signingKey: Buffer.alloc(0), witnesses: [] as NoteVerifier[], quorum: e.TLOG_WITNESS_QUORUM, intervalMs: e.TLOG_INTERVAL_MS, cosignRpm: e.TLOG_COSIGN_RPM, rekor: tlogRekorSettings(e, production) };
  let origin = e.TLOG_ORIGIN?.trim() ?? "";
  let seed: Buffer | null = null;
  let pkcs8: Buffer | null = null;
  if (e.TLOG_SIGNING_KEY) {
    const raw = e.TLOG_SIGNING_KEY.trim();
    if (raw.startsWith("PRIVATE+KEY+")) {
      let parsed: { name: string; seed: Buffer };
      try {
        parsed = parseSignerKey(raw);
      } catch (err) {
        throw new Error(`TLOG_SIGNING_KEY: ${(err as Error).message}.`);
      }
      if (origin && parsed.name !== origin) throw new Error("TLOG_SIGNING_KEY names a different log than TLOG_ORIGIN.");
      origin = parsed.name;
      seed = parsed.seed;
    } else {
      pkcs8 = Buffer.from(raw, "base64");
      try {
        if (createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
      } catch {
        throw new Error("TLOG_SIGNING_KEY must be an Ed25519 key: base64 PKCS#8 or PRIVATE+KEY+<origin>+<id>+<key>.");
      }
    }
  }
  if (!origin) {
    let host = "localhost";
    try {
      host = new URL(e.PUBLIC_BASE_URL).host || host;
    } catch {
      /* the default stands outside production */
    }
    origin = `${host}/tlog`;
  }
  if (!validKeyName(origin)) throw new Error("TLOG_ORIGIN must be non-empty and contain no spaces or '+'.");
  const witnesses: NoteVerifier[] = [];
  for (const v of (e.TLOG_WITNESSES ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    let w: NoteVerifier;
    try {
      w = parseVerifierKey(v);
    } catch (err) {
      throw new Error(`TLOG_WITNESSES: ${(err as Error).message}.`);
    }
    if (w.type !== SIG_COSIGNATURE_V1) throw new Error(`TLOG_WITNESSES: the key of ${w.name} must be a cosignature/v1 (0x04) key.`);
    if (witnesses.some((x) => x.name === w.name || x.publicKey.equals(w.publicKey))) throw new Error("TLOG_WITNESSES lists a witness twice.");
    if (w.name === origin) throw new Error("TLOG_WITNESSES must not list the log itself.");
    witnesses.push(w);
  }
  if (witnesses.length > 32) throw new Error("TLOG_WITNESSES lists more than 32 witnesses.");
  if (e.TLOG_WITNESS_QUORUM < 1 || e.TLOG_WITNESS_QUORUM > 32) throw new Error("TLOG_WITNESS_QUORUM must be between 1 and 32.");
  if (e.TLOG_INTERVAL_MS < 1_000) throw new Error("TLOG_INTERVAL_MS must be at least 1000.");
  if (e.TLOG_COSIGN_RPM < 1) throw new Error("TLOG_COSIGN_RPM must be at least 1.");
  const rekor = tlogRekorSettings(e, production);
  if (production) {
    if (!e.TLOG_SIGNING_KEY) throw new Error("TLOG_ENABLED requires TLOG_SIGNING_KEY in production: the log's key is its identity and must not change.");
    // Someone other than the log must be able to see every checkpoint it signs: cosigning witnesses, or Rekor anchoring.
    if (witnesses.length < e.TLOG_WITNESS_QUORUM && !rekor.enabled)
      throw new Error("TLOG_ENABLED in production needs an independent check of its checkpoints: at least TLOG_WITNESS_QUORUM witnesses in TLOG_WITNESSES, or public-log anchoring with TLOG_REKOR_ENABLED and TLOG_REKOR_SIGNING_KEY.");
  }
  // Outside production a log with no configured key signs with one derived from APP_SECRET, so it keeps its identity
  // across restarts. Production refuses to start without TLOG_SIGNING_KEY (above).
  if (!seed && !pkcs8) seed = createHmac("sha256", e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure").update("trellis-tlog-signing-key/v1").digest();
  return {
    enabled: true as boolean,
    dataInventory: e.TLOG_DATA_INVENTORY as boolean,
    origin,
    /** A 32-byte Ed25519 seed or a PKCS#8 key. */
    signingKey: (seed ?? pkcs8)!,
    witnesses,
    quorum: e.TLOG_WITNESS_QUORUM,
    intervalMs: e.TLOG_INTERVAL_MS,
    cosignRpm: e.TLOG_COSIGN_RPM,
    rekor,
  };
}

/** Rekor anchoring of the log's checkpoints (src/tlog/rekor.ts). Checked only when TLOG_REKOR_ENABLED is on. */
function tlogRekorSettings(e: Env, production: boolean) {
  const url = e.REKOR_URL.replace(/\/+$/, "");
  const rekorPublicKey = e.REKOR_PUBLIC_KEY?.replace(/\\n/g, "\n").trim() || null;
  const off = { enabled: false as boolean, url, rekorPublicKey, minIntervalMs: e.TLOG_REKOR_MIN_INTERVAL_MS, signingKey: null as KeyObject | null };
  if (!e.TLOG_REKOR_ENABLED) return off;
  if (!e.TLOG_REKOR_SIGNING_KEY) throw new Error("TLOG_REKOR_ENABLED requires TLOG_REKOR_SIGNING_KEY: a dedicated ECDSA P-256 private key that signs the Rekor entries.");
  const p256 = (k: KeyObject) => k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1";
  let signingKey: KeyObject;
  try {
    const src = e.TLOG_REKOR_SIGNING_KEY.replace(/\\n/g, "\n").trim();
    signingKey = src.includes("BEGIN") ? createPrivateKey(src) : createPrivateKey({ key: Buffer.from(src, "base64"), format: "der", type: "pkcs8" });
    if (!p256(signingKey)) throw new Error("not P-256");
  } catch {
    throw new Error("TLOG_REKOR_SIGNING_KEY must be an ECDSA P-256 private key: a PKCS#8 or SEC1 PEM, or base64 PKCS#8.");
  }
  const publicPem = createPublicKey(signingKey).export({ type: "spki", format: "pem" }).toString();
  if (e.MEASUREMENT_PUBLIC_KEY && measurementPublicKey(e.MEASUREMENT_PUBLIC_KEY) === publicPem) throw new Error("TLOG_REKOR_SIGNING_KEY must be its own key, not the measurement key.");
  if (!Number.isInteger(e.TLOG_REKOR_MIN_INTERVAL_MS) || e.TLOG_REKOR_MIN_INTERVAL_MS < 60_000) throw new Error("TLOG_REKOR_MIN_INTERVAL_MS must be at least 60000.");
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error("REKOR_URL must be an http(s) URL.");
  if (production && !url.startsWith("https://")) throw new Error("REKOR_URL must be https in production.");
  if (rekorPublicKey) {
    let ok = false;
    try {
      ok = p256(createPublicKey(rekorPublicKey));
    } catch {
      /* refused below */
    }
    if (!ok) throw new Error("REKOR_PUBLIC_KEY must be the Rekor log's ECDSA P-256 public key (PEM).");
  }
  return { ...off, enabled: true as boolean, signingKey };
}

// ---- The Lane -------------------------------------------------------------------------------------------
const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

function laneSettings(e: Env) {
  const baseModels = [...new Set(csv(e.DAYZERO_BASE_MODELS))];
  const bad = baseModels.find((b) => !REPO_ID.test(b));
  if (bad) throw new Error("DAYZERO_BASE_MODELS must be a comma list of Hugging Face repository ids (owner/name).");
  if (e.DAYZERO_ENABLED && !baseModels.length) throw new Error("DAYZERO_ENABLED needs DAYZERO_BASE_MODELS: the base models whose derivatives are watched.");
  const licenses = [...new Set(csv(e.DAYZERO_LICENSES).map((l) => l.toLowerCase()))];
  if (!licenses.length) throw new Error("DAYZERO_LICENSES must list at least one license.");
  const keywords = [...new Set(csv(e.DAYZERO_KEYWORDS).map((k) => k.toLowerCase()))];
  if (!keywords.length) throw new Error("DAYZERO_KEYWORDS must list at least one keyword.");
  for (const [name, v] of Object.entries({ DAYZERO_MAX_REFUSAL_RATE: e.DAYZERO_MAX_REFUSAL_RATE, DAYZERO_MIN_CAPABILITY: e.DAYZERO_MIN_CAPABILITY, DAYZERO_MIN_CANARY: e.DAYZERO_MIN_CANARY }))
    if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1.`);
  if (e.DAYZERO_INTERVAL_MS < 60_000) throw new Error("DAYZERO_INTERVAL_MS must be at least 60000.");
  if (e.DAYZERO_MAX_PER_RUN < 1 || e.DAYZERO_MAX_PER_RUN > 200) throw new Error("DAYZERO_MAX_PER_RUN must be between 1 and 200.");
  if (e.LANE_CLAIM_TTL_S < 60) throw new Error("LANE_CLAIM_TTL_S must be at least 60.");
  if (!/^[\w.-][\w.-]{0,127}$/.test(e.LANE_CLAIM_FILE)) throw new Error("LANE_CLAIM_FILE must be a plain file name.");
  return {
    dayzero: {
      enabled: e.DAYZERO_ENABLED,
      intervalMs: e.DAYZERO_INTERVAL_MS,
      baseModels,
      licenses,
      keywords,
      maxPerRun: e.DAYZERO_MAX_PER_RUN,
      maxRefusalRate: e.DAYZERO_MAX_REFUSAL_RATE,
      minCapability: e.DAYZERO_MIN_CAPABILITY,
      minCanary: e.DAYZERO_MIN_CANARY,
    },
    claim: { ttlS: e.LANE_CLAIM_TTL_S, file: e.LANE_CLAIM_FILE },
  };
}

// ---- IPX ---------------------------------------------------------------------------------------
export type IpxClass = { id: string; models: string[] };
const IPX_CLASS_ID = /^IPX-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const IPX_DEFAULT_CLASSES: Record<string, string[]> = { "IPX-OPEN-70B": ["meta-llama/llama-3.3-70b-instruct"] };

function ipxSettings(e: Env) {
  let raw: unknown = IPX_DEFAULT_CLASSES;
  if (e.IPX_CLASSES) {
    try {
      raw = JSON.parse(e.IPX_CLASSES);
    } catch {
      throw new Error("IPX_CLASSES must be a JSON object of class id to model ids.");
    }
  }
  const parsed = z.record(z.string(), z.array(z.string().trim().min(1).max(200)).min(1).max(500)).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 20, "1 to 20 classes").safeParse(raw);
  if (!parsed.success) throw new Error(`IPX_CLASSES must be a JSON object of class id to model ids: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const classes: IpxClass[] = Object.entries(parsed.data).map(([id, models]) => ({ id: id.toUpperCase(), models: [...new Set(models.map((m) => m.toLowerCase()))] }));
  const bad = classes.find((c) => !IPX_CLASS_ID.test(c.id) || c.id.length > 32);
  if (bad) throw new Error(`IPX_CLASSES: "${bad.id}" is not a valid class id (IPX-<UPPERCASE-OR-DIGITS>, at most 32 characters).`);
  if (new Set(classes.map((c) => c.id)).size !== classes.length) throw new Error("IPX_CLASSES: class ids must be unique.");
  const seen = new Map<string, string>();
  for (const c of classes)
    for (const m of c.models) {
      if (seen.has(m)) throw new Error(`IPX_CLASSES: model ${m} is in both ${seen.get(m)} and ${c.id}.`);
      seen.set(m, c.id);
    }
  if (e.IPX_MAX_ACCOUNT_SHARE_BPS < 1 || e.IPX_MAX_ACCOUNT_SHARE_BPS > 10_000) throw new Error("IPX_MAX_ACCOUNT_SHARE_BPS must be between 1 and 10000.");
  const [whole, frac = ""] = e.IPX_THIN_USDC.split(".");
  return {
    enabled: e.IPX_ENABLED,
    classes,
    /** Trailing-24h volume (USDC base units, 6 decimals) below which a class is THIN. */
    thinUsdc: BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0")),
    maxAccountShareBps: e.IPX_MAX_ACCOUNT_SHARE_BPS,
    attestedOnly: e.IPX_ATTESTED_ONLY,
    oracle: ipxOracleSettings(e, classes),
  };
}

export type IpxOraclePublisherName = "onchain" | "https";
const IPX_ORACLE_PUBLISHERS: IpxOraclePublisherName[] = ["onchain", "https"];

function ipxOracleSettings(e: Env, classes: IpxClass[]) {
  const ids = new Set(classes.map((c) => c.id));
  const publishers = (e.IPX_ORACLE_PUBLISHERS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const bad = publishers.find((p) => !IPX_ORACLE_PUBLISHERS.includes(p as IpxOraclePublisherName));
  if (bad) throw new Error(`IPX_ORACLE_PUBLISHERS: "${bad.slice(0, 20)}" is not a publisher (use ${IPX_ORACLE_PUBLISHERS.join(", ")}).`);
  if (new Set(publishers).size !== publishers.length) throw new Error("IPX_ORACLE_PUBLISHERS lists a publisher twice.");
  const listed = (e.IPX_ORACLE_CLASSES ?? "").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
  const unknown = listed.find((c) => !ids.has(c));
  if (unknown) throw new Error(`IPX_ORACLE_CLASSES: ${unknown.slice(0, 40)} is not one of IPX_CLASSES.`);
  const oracleClasses = listed.length ? [...new Set(listed)] : classes.map((c) => c.id);
  let feeds: Record<string, string> = {};
  if (e.IPX_ORACLE_FEEDS) {
    let raw: unknown;
    try {
      raw = JSON.parse(e.IPX_ORACLE_FEEDS);
    } catch {
      throw new Error("IPX_ORACLE_FEEDS must be a JSON object of class id to feed address.");
    }
    const parsed = z.record(z.string(), z.string().regex(ADDRESS_RE)).safeParse(raw);
    if (!parsed.success) throw new Error("IPX_ORACLE_FEEDS must be a JSON object of class id to feed address.");
    feeds = Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k.toUpperCase(), v]));
    const stray = Object.keys(feeds).find((k) => !oracleClasses.includes(k));
    if (stray) throw new Error(`IPX_ORACLE_FEEDS: ${stray.slice(0, 40)} is not an oracle class.`);
  }
  if (e.IPX_ORACLE_INTERVAL_S < 10 || e.IPX_ORACLE_INTERVAL_S > 3_600) throw new Error("IPX_ORACLE_INTERVAL_S must be between 10 and 3600.");
  if (e.IPX_ORACLE_STALE_AFTER_S < 2 * e.IPX_ORACLE_INTERVAL_S || e.IPX_ORACLE_STALE_AFTER_S > 86_400) throw new Error("IPX_ORACLE_STALE_AFTER_S must be at least twice IPX_ORACLE_INTERVAL_S and at most 86400.");
  if (e.IPX_ORACLE_MAX_MOVE_BPS < 1 || e.IPX_ORACLE_MAX_MOVE_BPS > 10_000) throw new Error("IPX_ORACLE_MAX_MOVE_BPS must be between 1 and 10000.");
  const keyShape = e.IPX_ORACLE_ALGORITHM === "ed25519" ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (e.IPX_ORACLE_PUBLIC_KEY && !keyShape.test(e.IPX_ORACLE_PUBLIC_KEY)) throw new Error(`IPX_ORACLE_PUBLIC_KEY must be ${e.IPX_ORACLE_ALGORITHM === "ed25519" ? "0x followed by the 32-byte ed25519 public key" : "the secp256k1 signer address"}.`);
  if (e.IPX_ORACLE_ENABLED) {
    if (!e.IPX_ENABLED) throw new Error("IPX_ORACLE_ENABLED requires IPX_ENABLED.");
    if (e.RUNTIME_ROLE !== "api" && !e.IPX_ORACLE_PRIVATE_KEY) throw new Error("IPX_ORACLE_ENABLED requires IPX_ORACLE_PRIVATE_KEY (the public API may hold IPX_ORACLE_PUBLIC_KEY alone).");
    if (publishers.includes("onchain") && !Object.keys(feeds).length) throw new Error("The onchain publisher needs IPX_ORACLE_FEEDS.");
    if (publishers.includes("https") && !e.IPX_ORACLE_PUSH_CONFIG) throw new Error("The https publisher needs IPX_ORACLE_PUSH_CONFIG.");
    if (e.IPX_ORACLE_ONCHAIN_SUBMIT && !(publishers.includes("onchain") && e.IPX_KEEPER_PRIVATE_KEY)) throw new Error("IPX_ORACLE_ONCHAIN_SUBMIT needs the onchain publisher and IPX_KEEPER_PRIVATE_KEY.");
  }
  return {
    enabled: e.IPX_ORACLE_ENABLED,
    algorithm: e.IPX_ORACLE_ALGORITHM,
    privateKey: e.IPX_ORACLE_PRIVATE_KEY,
    publicKey: e.IPX_ORACLE_PUBLIC_KEY?.toLowerCase(),
    classes: oracleClasses,
    intervalS: e.IPX_ORACLE_INTERVAL_S,
    staleAfterS: e.IPX_ORACLE_STALE_AFTER_S,
    maxMoveBps: e.IPX_ORACLE_MAX_MOVE_BPS,
    halted: e.IPX_ORACLE_HALTED,
    publishers: publishers as IpxOraclePublisherName[],
    feeds,
    onchainSubmit: e.IPX_ORACLE_ONCHAIN_SUBMIT,
    pushConfig: e.IPX_ORACLE_PUSH_CONFIG,
  };
}

// ---- Blind tokens --------------------------------------------------------------------------------
export const BLIND_DENOMINATIONS = [1_000, 10_000, 100_000] as const;

function blindSettings(e: Env) {
  let unitPricePico: bigint;
  try {
    unitPricePico = usdToPico(e.BLIND_UNIT_PRICE_USD);
  } catch {
    throw new Error("BLIND_UNIT_PRICE_USD must be a decimal USD amount.");
  }
  if (unitPricePico <= 0n) throw new Error("BLIND_UNIT_PRICE_USD must be positive.");
  if (e.BLIND_EPOCH_SECONDS < 60) throw new Error("BLIND_EPOCH_SECONDS must be at least 60.");
  if (e.BLIND_REDEEM_GRACE_SECONDS < 0) throw new Error("BLIND_REDEEM_GRACE_SECONDS must not be negative.");
  if (e.BLIND_MAX_BATCH < 1 || e.BLIND_MAX_BATCH > 256) throw new Error("BLIND_MAX_BATCH must be between 1 and 256.");
  if (e.BLIND_PURCHASE_RPM < 1) throw new Error("BLIND_PURCHASE_RPM must be at least 1.");
  if (e.BLIND_REDEEM_RPM < 1) throw new Error("BLIND_REDEEM_RPM must be at least 1.");
  if (!(e.BLIND_MAX_USD_PER_DAY > 0)) throw new Error("BLIND_MAX_USD_PER_DAY must be positive.");
  let issuerName = "localhost";
  try {
    issuerName = new URL(e.PUBLIC_BASE_URL).hostname || issuerName;
  } catch {
    /* PUBLIC_BASE_URL is only advisory outside production; the default host name stands */
  }
  return {
    enabled: e.TRELLIS_FEATURE_BLIND,
    unitPricePico,
    denominations: BLIND_DENOMINATIONS,
    epochSeconds: e.BLIND_EPOCH_SECONDS,
    redeemGraceSeconds: e.BLIND_REDEEM_GRACE_SECONDS,
    multiTokenEnabled: e.BLIND_MULTI_TOKEN_ENABLED, maxTokensPerRequest: e.BLIND_MAX_TOKENS_PER_REQUEST,
    maxBatch: e.BLIND_MAX_BATCH,
    purchaseRpm: e.BLIND_PURCHASE_RPM,
    redeemRpm: e.BLIND_REDEEM_RPM,
    maxUsdPerDay: e.BLIND_MAX_USD_PER_DAY,
    issuerName,
  };
}

// ---- Oblivious HTTP ------------------------------------------------------------------------------
export type RelayOperator = { operator: string; url: string; keyId: string; secretSha256: string };

const noControls = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const relayEntry = z
  .object({
    operator: z.string().trim().min(1).max(80).refine(noControls, "must not contain control characters"),
    url: z.string().trim().min(8).max(300),
    key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "must be 1 to 64 letters, digits, dots, dashes or underscores"),
    secret_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be the hex SHA-256 of the secret the relay presents"),
  })
  .strict();

function ohttpSettings(e: Env, production: boolean) {
  const off = {
    enabled: false as boolean,
    keyEpochSeconds: e.OHTTP_KEY_EPOCH_SECONDS,
    keyGraceSeconds: e.OHTTP_KEY_GRACE_SECONDS,
    maxRequestBytes: e.OHTTP_MAX_REQUEST_BYTES,
    maxResponseBytes: e.OHTTP_MAX_RESPONSE_BYTES,
    relayRpm: e.OHTTP_RELAY_RPM,
    directRpm: e.OHTTP_DIRECT_RPM,
    padBytes: e.OHTTP_PAD_BYTES,
    gatewayOperator: e.OHTTP_GATEWAY_OPERATOR.trim() || "Trellis",
    minRelayOperators: e.OHTTP_MIN_RELAY_OPERATORS,
    chunked: false as boolean,
    relays: [] as RelayOperator[],
  };
  if (!e.OHTTP_ENABLED) return off;
  if (!e.TRELLIS_FEATURE_BLIND) throw new Error("OHTTP_ENABLED requires TRELLIS_FEATURE_BLIND=true: the unlinkable lane is paid with blind tokens.");
  if (e.OHTTP_KEY_EPOCH_SECONDS < 60) throw new Error("OHTTP_KEY_EPOCH_SECONDS must be at least 60.");
  if (e.OHTTP_KEY_GRACE_SECONDS < 0 || e.OHTTP_KEY_GRACE_SECONDS > 100 * e.OHTTP_KEY_EPOCH_SECONDS) throw new Error("OHTTP_KEY_GRACE_SECONDS must be between 0 and 100 epochs (key identifiers are 8 bits and repeat every 256 epochs).");
  if (e.OHTTP_MAX_REQUEST_BYTES < 1024 || e.OHTTP_MAX_REQUEST_BYTES > 64 * 1024 * 1024) throw new Error("OHTTP_MAX_REQUEST_BYTES must be between 1 KiB and 64 MiB.");
  if (e.OHTTP_MAX_RESPONSE_BYTES < 1024 || e.OHTTP_MAX_RESPONSE_BYTES > 64 * 1024 * 1024) throw new Error("OHTTP_MAX_RESPONSE_BYTES must be between 1 KiB and 64 MiB.");
  if (e.OHTTP_RELAY_RPM < 1 || e.OHTTP_DIRECT_RPM < 1) throw new Error("OHTTP_RELAY_RPM and OHTTP_DIRECT_RPM must be at least 1.");
  if (e.OHTTP_PAD_BYTES < 0 || e.OHTTP_PAD_BYTES > 65_536) throw new Error("OHTTP_PAD_BYTES must be between 0 and 65536.");
  if (e.OHTTP_MIN_RELAY_OPERATORS < 0) throw new Error("OHTTP_MIN_RELAY_OPERATORS must not be negative.");
  let raw: unknown = [];
  if (e.RELAY_OPERATORS) {
    try {
      raw = JSON.parse(e.RELAY_OPERATORS);
    } catch {
      throw new Error("RELAY_OPERATORS must be a JSON array of {operator,url,key_id,secret_sha256}.");
    }
  }
  const parsed = z.array(relayEntry).max(20).safeParse(raw);
  if (!parsed.success) throw new Error(`RELAY_OPERATORS must be a JSON array of {operator,url,key_id,secret_sha256}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "list"}: ${i.message}`).join("; ")}`);
  const relays: RelayOperator[] = parsed.data.map((r) => {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      throw new Error(`RELAY_OPERATORS: "${r.key_id}" has an invalid url.`);
    }
    if (u.protocol !== "https:" && (production || u.protocol !== "http:")) throw new Error(`RELAY_OPERATORS: the url of "${r.key_id}" must be https.`);
    if (u.username || u.password || u.hash) throw new Error(`RELAY_OPERATORS: the url of "${r.key_id}" must not carry credentials or a fragment.`);
    return { operator: r.operator, url: u.toString(), keyId: r.key_id, secretSha256: r.secret_sha256.toLowerCase() };
  });
  if (new Set(relays.map((r) => r.keyId)).size !== relays.length) throw new Error("RELAY_OPERATORS: key_id values must be unique.");
  if (new Set(relays.map((r) => r.secretSha256)).size !== relays.length) throw new Error("RELAY_OPERATORS: every relay needs its own secret.");
  const gatewayOperator = off.gatewayOperator;
  const others = new Set(relays.filter((r) => r.operator.toLowerCase() !== gatewayOperator.toLowerCase()).map((r) => r.operator.toLowerCase()));
  if (production && others.size < e.OHTTP_MIN_RELAY_OPERATORS)
    throw new Error(`OHTTP_ENABLED in production needs relays from at least ${e.OHTTP_MIN_RELAY_OPERATORS} operators other than "${gatewayOperator}" in RELAY_OPERATORS (found ${others.size}).`);
  return { ...off, enabled: true, chunked: e.OHTTP_CHUNKED_ENABLED, relays };
}

// ---- $TRLS holder perks ------------------------------------------------------------------------
// Tiers are membership levels read live from the wallet's token balance: fixed thresholds (`min`, in whole tokens, a
// decimal string), each with a fixed set of perks. Nothing scales with the size of a holding beyond the tier it reaches,
// and no perk is money: no fee discount, no free credits, no cashback, no rebates, no rewards.
//   rpm_multiplier / tpm_multiplier   the key's per-minute request / token limits, multiplied (tpm defaults to rpm)
//   max_agent_keys                    active Agent Session keys per account (raises AGENT_KEYS_MAX_ACTIVE; never lowers)
//   max_saved_routes                  saved routes and presets per account (raises the built-in 100; never lowers)
//   max_batch_rows                    lines in one batch (raises BATCH_MAX_LINES; never lowers)
//   sealed_priority                   place in the SEALED-lane admission queue when a host is full (0 = none) and in
//                                     Bushel purchase ordering
//   early_access_hours                how long before a newly listed model opens to everyone this tier may use it
//   vote_weight                       fixed weight of this tier's vote in advisory holder polls (never by balance)
//   credits_never_expire              the router sends no notice_expiry / sweep_expired for this tier's keys
//   badge                             whether an opted-in public agent profile may show the tier name
// The on-chain credits cap (CREDITS_CAP_USDC) and tab cap (TAB_CAP_USDC) are NOT tier perks: they are safety caps while
// the programs are unaudited, and no tier raises them.
export type HolderTier = {
  name: string;
  min: string;
  rpmMultiplier: number;
  tpmMultiplier: number;
  maxAgentKeys: number | null;
  maxSavedRoutes: number | null;
  maxBatchRows: number | null;
  sealedPriority: number;
  earlyAccessHours: number;
  voteWeight: number;
  creditsNeverExpire: boolean;
  badge: boolean;
};
const DECIMAL_TOKENS = /^\d+(\.\d{1,18})?$/;
/** A whole-token decimal string as an integer with 18 fractional digits, for ordering tiers. */
const tokens18 = (v: string) => {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
};
const tierLimit = z.number().int().positive().max(1_000_000).optional();
export const holderTierSchema = z.object({
  name: z.string().trim().min(1).max(32),
  min: z.union([z.string().regex(DECIMAL_TOKENS, "min must be a token amount like \"100000\""), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String),
  rpm_multiplier: z.number().min(1).max(100).default(1),
  tpm_multiplier: z.number().min(1).max(100).optional(),
  max_agent_keys: tierLimit,
  max_saved_routes: tierLimit,
  max_batch_rows: tierLimit,
  sealed_priority: z.number().int().min(0).max(100).default(0),
  early_access_hours: z.number().int().min(0).max(720).default(0),
  vote_weight: z.number().int().min(0).max(100).default(1),
  credits_never_expire: z.boolean().default(false),
  badge: z.boolean().default(true),
  // Accepted so an older HOLDER_TIERS value still loads, and ignored: Trellis charges zero markup, so there is no fee
  // to discount, and holder perks are never money.
  discount_bps: z.number().int().min(0).max(10_000).optional(),
});

function holderSettings(e: Env, trls: TrlsEscrow | null, core: boolean) {
  // The token is the one TRLS_TOKEN_ADDRESS configures for $TRLS escrow payments (null when unset).
  const token = trls ? { address: trls.address, symbol: trls.symbol } : null;
  let tiers: HolderTier[] = [];
  if (e.HOLDER_TIERS) {
    try {
      tiers = z
        .array(holderTierSchema)
        .min(1)
        .max(10)
        .parse(JSON.parse(e.HOLDER_TIERS))
        .map((t) => ({
          name: t.name,
          min: t.min,
          rpmMultiplier: t.rpm_multiplier,
          tpmMultiplier: t.tpm_multiplier ?? t.rpm_multiplier,
          maxAgentKeys: t.max_agent_keys ?? null,
          maxSavedRoutes: t.max_saved_routes ?? null,
          maxBatchRows: t.max_batch_rows ?? null,
          sealedPriority: t.sealed_priority,
          earlyAccessHours: t.early_access_hours,
          voteWeight: t.vote_weight,
          creditsNeverExpire: t.credits_never_expire,
          badge: t.badge,
        }))
        .sort((a, b) => (tokens18(a.min) < tokens18(b.min) ? -1 : 1));
    } catch (err) {
      throw new Error(`HOLDER_TIERS must be a JSON array of {name,min,rpm_multiplier,tpm_multiplier,max_agent_keys,max_saved_routes,max_batch_rows,sealed_priority,early_access_hours,vote_weight,credits_never_expire,badge}: ${(err as Error).message}`);
    }
    if (tiers.some((t) => tokens18(t.min) === 0n)) throw new Error("HOLDER_TIERS: every tier needs a min above 0.");
    if (new Set(tiers.map((t) => tokens18(t.min))).size !== tiers.length) throw new Error("HOLDER_TIERS: two tiers share the same min.");
    if (new Set(tiers.map((t) => t.name.toLowerCase())).size !== tiers.length) throw new Error("HOLDER_TIERS: tier names must be unique.");
  }
  const enabled = !!token && tiers.length > 0;
  // A newly listed model stays holders-first for the longest early_access_hours of any tier, at most
  // EARLY_ACCESS_WINDOW_HOURS: the top tier may use it from listing, callers with no tier when the window ends.
  // Not on the core launch surface: there a tier is its limits (src/surface/updates.ts CORE_WHEN_RELEASED), and no
  // window is ever opened, so a newly listed model is never closed to a caller with no tier.
  const earlyAccessWindowHours = enabled && !core ? Math.min(e.EARLY_ACCESS_WINDOW_HOURS, Math.max(0, ...tiers.map((t) => t.earlyAccessHours))) : 0;
  return {
    token,
    tiers,
    /** Live tiers run only with both the token and HOLDER_TIERS set. */
    enabled,
    earlyAccessWindowHours,
    /** SEALED-lane admission (src/holders/sealed-queue.ts); maxConcurrencyPerHost 0 = no limit and no queue. */
    sealed: { maxConcurrencyPerHost: e.SEALED_MAX_CONCURRENCY_PER_HOST, queueMaxWaitMs: e.SEALED_QUEUE_MAX_WAIT_MS, nonHolderMinShare: e.SEALED_NONHOLDER_MIN_SHARE },
    /** Active Agent Session keys per account before any tier; 0 = no cap (and then no tier changes that). */
    agentKeysMaxActive: e.AGENT_KEYS_MAX_ACTIVE,
    /** Whether settlement sends notice_expiry / sweep_expired at all (off: no balance is ever noticed or swept by the router). */
    creditsExpiryEnabled: e.CREDITS_EXPIRY_ENABLED,
  };
}

export type PaywithToken = { symbol: string; address: string; decimals: number; feed?: string; name?: string };
export type EscrowToken = PaywithToken & { feed: string };

// ---- Pay with $TRLS in escrow ------------------------------------------------------------------
// TRLS has no price feed. A deposit is priced from the router's own samples of the token's market
// (src/solana/trls-price.ts): its launch curve by default, or the two vaults TRLS_POOL_VAULTS names.
export type TrlsEscrow = {
  address: string;
  symbol: string;
  decimals: number;
  haircutBps: number;
  maxUsdPerDeposit: number;
  maxUsdPerDay: number;
  price: { vaults: { base: string; quote: string } | null; windowSeconds: number; sampleSeconds: number; coverage: number; minLamports: bigint; solFeed: string; solAccount: string };
};

function trlsEscrowConfig(e: Env, stockAddresses: string[]): TrlsEscrow | null {
  if (e.TRLS_POOL_LEGS) throw new Error("TRLS_POOL_LEGS is retired: a price read from a pool's last transactions can be set by a few swaps (security review R4-33). Remove it; $TRLS deposits are priced from the router's own samples (TRLS_POOL_VAULTS once the token trades in a pool).");
  if (!e.TRLS_TOKEN_ADDRESS) return null;
  const address = e.TRLS_TOKEN_ADDRESS;
  if (!/^[A-Za-z0-9.$_-]{1,16}$/.test(e.TRLS_TOKEN_SYMBOL)) throw new Error("TRLS_TOKEN_SYMBOL must be 1-16 letters or digits.");
  if (e.TRLS_TOKEN_DECIMALS < 0 || e.TRLS_TOKEN_DECIMALS > 36) throw new Error("TRLS_TOKEN_DECIMALS must be between 0 and 36.");
  if (e.TRLS_ESCROW_HAIRCUT_BPS < 0 || e.TRLS_ESCROW_HAIRCUT_BPS >= 10_000) throw new Error("TRLS_ESCROW_HAIRCUT_BPS must be between 0 and 9999.");
  for (const name of ["TRLS_ESCROW_MAX_USD_PER_DEPOSIT", "TRLS_ESCROW_MAX_USD_PER_DAY"] as const) if (!(e[name] > 0) || !Number.isFinite(e[name])) throw new Error(`${name} must be a positive USD amount.`);
  if (stockAddresses.includes(address)) throw new Error("TRLS_TOKEN_ADDRESS is also listed in ESCROW_TOKENS.");
  if (!(e.TRLS_PRICE_SAMPLE_SECONDS >= 15 && e.TRLS_PRICE_SAMPLE_SECONDS <= 600)) throw new Error("TRLS_PRICE_SAMPLE_SECONDS must be between 15 and 600.");
  if (!(e.TRLS_PRICE_WINDOW_MINUTES >= 10 && e.TRLS_PRICE_WINDOW_MINUTES <= 720)) throw new Error("TRLS_PRICE_WINDOW_MINUTES must be between 10 and 720: a shorter window is a price a few trades can hold.");
  if (!(e.TRLS_PRICE_MIN_COVERAGE >= 0.5 && e.TRLS_PRICE_MIN_COVERAGE <= 1)) throw new Error("TRLS_PRICE_MIN_COVERAGE must be between 0.5 and 1.");
  if (!(e.TRLS_PRICE_MIN_SOL > 0)) throw new Error("TRLS_PRICE_MIN_SOL must be positive.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.TRLS_SOL_USD_FEED)) throw new Error("TRLS_SOL_USD_FEED must be a 32-byte feed id (0x and 64 hex digits).");
  let vaults: TrlsEscrow["price"]["vaults"] = null;
  if (e.TRLS_POOL_VAULTS) {
    try {
      vaults = z.object({ base: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), quote: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) }).parse(JSON.parse(e.TRLS_POOL_VAULTS));
    } catch (err) {
      throw new Error(`TRLS_POOL_VAULTS must be JSON {base,quote} naming two token accounts: ${(err as Error).message.slice(0, 200)}`);
    }
    if (vaults.base === vaults.quote) throw new Error("TRLS_POOL_VAULTS names the same account twice.");
  }
  return {
    address, symbol: e.TRLS_TOKEN_SYMBOL, decimals: e.TRLS_TOKEN_DECIMALS, haircutBps: e.TRLS_ESCROW_HAIRCUT_BPS,
    maxUsdPerDeposit: Math.min(e.TRLS_ESCROW_MAX_USD_PER_DEPOSIT, e.TRLS_ESCROW_MAX_USD_PER_DAY), maxUsdPerDay: e.TRLS_ESCROW_MAX_USD_PER_DAY,
    price: { vaults, windowSeconds: Math.round(e.TRLS_PRICE_WINDOW_MINUTES * 60), sampleSeconds: Math.round(e.TRLS_PRICE_SAMPLE_SECONDS), coverage: e.TRLS_PRICE_MIN_COVERAGE, minLamports: BigInt(Math.round(e.TRLS_PRICE_MIN_SOL * 1e9)), solFeed: e.TRLS_SOL_USD_FEED, solAccount: e.TRLS_SOL_USD_ACCOUNT },
  };
}

// ---- Add funds with USDC in escrow -------------------------------------------------------------
// Balances are USDC-denominated, so USDC is credited 1:1 at par: no feed or pool is read. Its decimals are fixed
// at 6 and checked against the token contract before anything is credited, like every escrow token.
export const USDC_ESCROW_DECIMALS = 6;
export type UsdcEscrow = { address: string; symbol: "USDC"; decimals: number; haircutBps: number; maxUsdPerDeposit: number };

function usdcEscrowConfig(e: Env, stockAddresses: string[], trls: TrlsEscrow | null): UsdcEscrow | null {
  if (e.USDC_ESCROW_HAIRCUT_BPS < 0 || e.USDC_ESCROW_HAIRCUT_BPS >= 10_000) throw new Error("USDC_ESCROW_HAIRCUT_BPS must be between 0 and 9999.");
  if (!(e.USDC_ESCROW_MAX_USD_PER_DEPOSIT > 0) || !Number.isFinite(e.USDC_ESCROW_MAX_USD_PER_DEPOSIT)) throw new Error("USDC_ESCROW_MAX_USD_PER_DEPOSIT must be a positive USD amount.");
  if (!e.USDC_ESCROW_ENABLED) return null;
  if (!e.USDC_ADDRESS) throw new Error("USDC_ESCROW_ENABLED requires USDC_ADDRESS.");
  const address = e.USDC_ADDRESS;
  // A feed-priced copy would credit USDC at whatever the feed says instead of at par.
  if (stockAddresses.includes(address)) throw new Error("USDC_ADDRESS is also listed in ESCROW_TOKENS; with USDC_ESCROW_ENABLED it is credited at par, never through a price feed.");
  if (trls?.address === address) throw new Error("USDC_ADDRESS and TRLS_TOKEN_ADDRESS must be different tokens.");
  // Every USDC transfer into ESCROW_ADDRESS is credited to its sender, so x402 settlements must land elsewhere.
  if (e.ESCROW_ADDRESS && e.X402_PAY_TO && e.ESCROW_ADDRESS === e.X402_PAY_TO)
    throw new Error("USDC_ESCROW_ENABLED needs X402_PAY_TO to differ from ESCROW_ADDRESS: x402 payments sent there would also be credited as deposits.");
  return { address, symbol: "USDC", decimals: USDC_ESCROW_DECIMALS, haircutBps: e.USDC_ESCROW_HAIRCUT_BPS, maxUsdPerDeposit: e.USDC_ESCROW_MAX_USD_PER_DEPOSIT };
}

// ---- Program-path launch guards ----------------------------------------------------------------
// The deployment report: scripts/devnet/verify.ts checks the Anchor programs but does not write a DEPLOYMENT_VERIFICATION
//   report yet, so production program mode needs one produced in the shape below (the EVM verifier left with the contracts).
// H-02: production program mode moves customer funds through the Trellis programs, so it starts
//   only against a deployment that was independently verified: DEPLOYMENT_MANIFEST (written by the deploy
//   script) must list exactly the configured program addresses, and DEPLOYMENT_VERIFICATION must be the
//   passing report of the deployment verifier for that manifest (same slot, same network, an executable
//   account found at every manifest address). The report is a point-in-time snapshot: re-run the verifier for every release
//   and whenever ownership or roles change. A disposable fixture whose public origin is on a reserved
//   TLD (.example, .invalid, .test, .localhost; RFC 2606/6761) cannot serve real users or wallet
//   sign-in; it may run without a manifest and reports deployment status "fixture".
// M-06: every pay-with charge needs the session wallet's signature, either for that charge
//   or as a bounded allowance (<= 7 days, <= $5 per charge, tied to a usage commitment). Within an
//   allowance the router still chooses when to charge, so production requires an explicit
//   PAYWITH_DELEGATION_ACCEPTED and keeps the exposure small: PAYWITH_MAX_DEBT_USD <= $5 and
//   PAYWITH_MAX_DAILY_CAP_USD <= $25.

type Env = z.infer<typeof schema>;
export type DeploymentStatus = {
  status: "none" | "unverified" | "fixture" | "verified";
  manifestSha256: string | null;
  manifestBlock: number | null;
  verifiedAtBlock: string | null;
  verifierRevision: string | null;
};
export const DEPLOYMENT_SCHEMA = "trellis.deployments/v1";
export const PAYWITH_MAX_DEBT_CEILING_USD = 5;
export const PAYWITH_DAILY_CAP_CEILING_USD = 25;
const RESERVED_TLDS = new Set(["example", "invalid", "test", "localhost"]);
const MANIFEST_CONTRACTS = {
  CREDITS_ADDRESS: "credits",
  CALLPAY_ADDRESS: "callPay",
  PAYWITHSTOCK_ADDRESS: "payWithStock",
  PROVIDER_BOND_ADDRESS: "providerBond",
  RECEIPT_ANCHOR_ADDRESS: "receiptAnchor",
  ROYALTY_ADDRESS: "royalty",
  PAYMASTER_ADDRESS: "paymaster",
} as const;
const sameAddress = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && ADDRESS_RE.test(a) && a === b;

/** A file path or inline JSON; errors never echo the value. */
function readJsonSetting(name: string, value: string): { json: Record<string, any>; sha256: string } {
  let text: string;
  try {
    text = value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8");
  } catch {
    throw new Error(`${name} could not be read.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${name} must be a JSON object.`);
  return { json: json as Record<string, any>, sha256: createHash("sha256").update(text).digest("hex") };
}

function contractPathGuards(e: Env, production: boolean, escrowMode: boolean) {
  if (e.RELEASE_COMMIT && !/^[0-9a-f]{7,40}$/i.test(e.RELEASE_COMMIT)) throw new Error("RELEASE_COMMIT must be a git commit id.");
  const releaseCommit = e.RELEASE_COMMIT?.toLowerCase() ?? null;
  const maxDailyCapUsd = e.PAYWITH_MAX_DAILY_CAP_USD === undefined ? null : Number(e.PAYWITH_MAX_DAILY_CAP_USD);
  if (maxDailyCapUsd !== null && !(maxDailyCapUsd > 0)) throw new Error("PAYWITH_MAX_DAILY_CAP_USD must be a positive USD amount.");
  const configured = (Object.keys(MANIFEST_CONTRACTS) as (keyof typeof MANIFEST_CONTRACTS)[]).filter((name) => e[name]);
  const deployment: DeploymentStatus = { status: escrowMode || !configured.length ? "none" : "unverified", manifestSha256: null, manifestBlock: null, verifiedAtBlock: null, verifierRevision: null };
  const result = { releaseCommit, maxDailyCapUsd, deployment };
  if (!production) return result;

  // M-06: PayWithStock delegates router spending up to each session's daily cap.
  if (e.PAYWITHSTOCK_ADDRESS) {
    if (!e.PAYWITH_DELEGATION_ACCEPTED)
      throw new Error("PayWithStock allowances let the router key charge a wallet within its signed allowance (<= 7 days, <= $5 per charge) and daily cap without signing each charge. Set PAYWITH_DELEGATION_ACCEPTED=true only after accepting that bounded exposure.");
    if (!(e.PAYWITH_MAX_DEBT_USD > 0 && e.PAYWITH_MAX_DEBT_USD <= PAYWITH_MAX_DEBT_CEILING_USD)) throw new Error(`PAYWITH_MAX_DEBT_USD must be above 0 and at most ${PAYWITH_MAX_DEBT_CEILING_USD} in production.`);
    if (maxDailyCapUsd === null || maxDailyCapUsd > PAYWITH_DAILY_CAP_CEILING_USD || maxDailyCapUsd < e.PAYWITH_MAX_DEBT_USD)
      throw new Error(`PayWithStock requires PAYWITH_MAX_DAILY_CAP_USD between PAYWITH_MAX_DEBT_USD and ${PAYWITH_DAILY_CAP_CEILING_USD} in production.`);
  }

  // H-02: contract mode runs only against a verified deployment.
  if (escrowMode || !configured.length) return result;
  let host = "";
  try {
    host = new URL(e.PUBLIC_BASE_URL).hostname;
  } catch {
    /* PUBLIC_BASE_URL is validated above */
  }
  if (!e.DEPLOYMENT_MANIFEST) {
    if (RESERVED_TLDS.has(host.split(".").at(-1) ?? "")) {
      deployment.status = "fixture";
      return result;
    }
    throw new Error("Production contract mode requires DEPLOYMENT_MANIFEST (the trellis.deployments/v1 manifest) and DEPLOYMENT_VERIFICATION (its passing deployment verifier report).");
  }
  if (!releaseCommit || releaseCommit.length !== 40) throw new Error("Production contract mode requires RELEASE_COMMIT, the full git commit of this build.");

  const { json: manifest, sha256 } = readJsonSetting("DEPLOYMENT_MANIFEST", e.DEPLOYMENT_MANIFEST);
  const refuseManifest = (why: string): never => {
    throw new Error(`DEPLOYMENT_MANIFEST ${why}`);
  };
  const contracts: Record<string, unknown> = manifest.contracts && typeof manifest.contracts === "object" ? manifest.contracts : {};
  if (manifest.schema !== DEPLOYMENT_SCHEMA) refuseManifest(`must use schema ${DEPLOYMENT_SCHEMA}.`);
  if (manifest.mode !== "production") refuseManifest("must describe a production deployment.");
  if (manifest.network !== e.SOLANA_NETWORK) refuseManifest(`is not for network ${e.SOLANA_NETWORK}.`);
  if (!/^\d+$/.test(String(manifest.blockNumber))) refuseManifest("has no deployment block.");
  for (const [name, key] of [...Object.entries(MANIFEST_CONTRACTS), ["USDC_ADDRESS", "usdc"]] as [keyof Env, string][]) {
    if (e[name] && !sameAddress(e[name], contracts[key])) refuseManifest(`does not list ${name} as its ${key} contract.`);
  }
  if (e.CALLPAY_TREASURY && !sameAddress(e.CALLPAY_TREASURY, manifest.roles?.callPayTreasury)) refuseManifest("does not list CALLPAY_TREASURY as the CallPay treasury.");

  if (!e.DEPLOYMENT_VERIFICATION) throw new Error("Production contract mode requires DEPLOYMENT_VERIFICATION, the passing deployment verifier report for DEPLOYMENT_MANIFEST.");
  const { json: report } = readJsonSetting("DEPLOYMENT_VERIFICATION", e.DEPLOYMENT_VERIFICATION);
  const refuseReport = (why: string): never => {
    throw new Error(`DEPLOYMENT_VERIFICATION ${why}`);
  };
  const checks: { id?: unknown; status?: unknown; evidence?: any }[] = Array.isArray(report.checks) ? report.checks : [];
  if (report.ok !== true || !checks.length || checks.some((c) => !c || c.status === "fail")) refuseReport("is not a passing verifier report.");
  if (!/^[0-9a-f]{40}$/.test(String(report.verifierRevision))) refuseReport("does not name the verifier's git revision.");
  // Security review R4-17: where the hand-over stands is read from the report itself, not inferred from `ok`. Once the
  // record says the hand-over happened, every deployed program must be on the multisig vault; and the three checks that
  // carry that judgement must be in the report and have passed. A report without the `handover` field or without one
  // of the three checks comes from a verifier older than these rules (round 5 residual of R4-17) and is refused.
  const ho = report.handover;
  if (!ho || typeof ho !== "object" || Array.isArray(ho)) refuseReport("does not say where the hand-over stands (no `handover` field: run the current scripts/mainnet/verify.ts --write-report).");
  if (ho.recordedAt != null && !(ho.complete === true && Array.isArray(ho.onOperatorKey) && ho.onOperatorKey.length === 0 && Array.isArray(ho.notOnVault) && ho.notOnVault.length === 0))
    refuseReport("records a hand-over that is not complete: a deployed program is still on the operator key or not on the multisig vault.");
  for (const [id, accepted] of [["handover.complete", ["pass", "not_applicable"]], ["roles.operator_key", ["pass"]], ["deployment.coverage", ["pass"]]] as const) {
    const check = checks.find((c) => c.id === id);
    if (!check) refuseReport(`does not carry the ${id} check (run the current scripts/mainnet/verify.ts --write-report).`);
    if (!(accepted as readonly string[]).includes(String(check!.status))) refuseReport(`did not pass ${id}.`);
  }
  const certified = report.manifest ?? {};
  if (certified.schema !== DEPLOYMENT_SCHEMA || certified.mode !== "production" || certified.network !== e.SOLANA_NETWORK || Number(certified.blockNumber) !== Number(manifest.blockNumber))
    refuseReport("was produced for a different manifest.");
  const observedBlock = String(report.observed?.blockNumber);
  if (report.observed?.network !== e.SOLANA_NETWORK || !/^\d+$/.test(observedBlock) || BigInt(observedBlock) < BigInt(String(manifest.blockNumber)))
    refuseReport("was not read from this chain after the deployment block.");
  const proof = checks.find((c) => c.id === "contracts.source_equivalence");
  if (proof?.status !== "pass" || proof.evidence?.sourceRevision !== report.verifierRevision || !Array.isArray(proof.evidence?.mismatches) || proof.evidence.mismatches.length)
    refuseReport("does not prove the audited runtime build and immutable values.");
  // Bind the report to this manifest: the verifier found runtime bytecode at every manifest address.
  const bytecode = checks.find((c) => c.id === "contracts.bytecode_present");
  const found: Record<string, { address?: unknown; present?: unknown }> = bytecode?.status === "pass" && bytecode.evidence && typeof bytecode.evidence === "object" ? bytecode.evidence : {};
  for (const [key, address] of Object.entries(contracts)) {
    if (!address) continue;
    if (!sameAddress(found[key]?.address, address) || found[key]?.present !== true) refuseReport(`did not verify the manifest's ${key} contract.`);
  }
  Object.assign(deployment, { status: "verified", manifestSha256: sha256, manifestBlock: Number(manifest.blockNumber), verifiedAtBlock: observedBlock, verifierRevision: String(report.verifierRevision) });
  return result;
}

// ---- Solana programs, caps and facilitator settings (docs/Trellis_Backend.md §5, §10) ------------------------------
export const TAB_CAP_CEILING_USDC = 500;
export const CREDITS_CAP_CEILING_USDC = 5_000;
export type SolanaSettings = ReturnType<typeof solanaSettings>;
function solanaSettings(e: Env, production: boolean) {
  const programs = {
    credits: e.TRELLIS_CREDITS_PROGRAM_ID ?? e.CREDITS_ADDRESS,
    tab: e.TRELLIS_TAB_PROGRAM_ID,
    bond: e.TRELLIS_BOND_PROGRAM_ID ?? e.PROVIDER_BOND_ADDRESS,
    anchor: e.TRELLIS_ANCHOR_PROGRAM_ID ?? e.RECEIPT_ANCHOR_ADDRESS,
    rules: e.TRELLIS_RULES_PROGRAM_ID,
    feeRouter: e.TRELLIS_FEE_ROUTER_PROGRAM_ID,
    capacity: e.TRELLIS_CAPACITY_PROGRAM_ID,
    measurements: e.TRELLIS_MEASUREMENTS_PROGRAM_ID ?? e.MEASUREMENT_REGISTRY_ADDRESS,
  };
  // Distinctness is checked on the explicit TRELLIS_*_PROGRAM_ID keys only: fixtures and older configs reuse one
  // placeholder address across the legacy *_ADDRESS keys.
  const explicit = [e.TRELLIS_CREDITS_PROGRAM_ID, e.TRELLIS_TAB_PROGRAM_ID, e.TRELLIS_BOND_PROGRAM_ID, e.TRELLIS_ANCHOR_PROGRAM_ID, e.TRELLIS_RULES_PROGRAM_ID, e.TRELLIS_FEE_ROUTER_PROGRAM_ID, e.TRELLIS_CAPACITY_PROGRAM_ID].filter(Boolean) as string[];
  if (new Set(explicit).size !== explicit.length) throw new Error("Every TRELLIS_*_PROGRAM_ID must name a different program.");
  if (explicit.includes(e.USDC_ADDRESS)) throw new Error("A TRELLIS_*_PROGRAM_ID equals USDC_ADDRESS.");
  if (!(e.TAB_CAP_USDC > 0) || e.TAB_CAP_USDC > TAB_CAP_CEILING_USDC) throw new Error(`TAB_CAP_USDC must be above 0 and at most ${TAB_CAP_CEILING_USDC} (the pre-audit cap).`);
  if (!(e.CREDITS_CAP_USDC > 0) || e.CREDITS_CAP_USDC > CREDITS_CAP_CEILING_USDC) throw new Error(`CREDITS_CAP_USDC must be above 0 and at most ${CREDITS_CAP_CEILING_USDC} per key (the pre-audit cap).`);
  if (!(e.CREDITS_REFUND_DELAY_H >= 0) || e.CREDITS_REFUND_DELAY_H > 24 * 30) throw new Error("CREDITS_REFUND_DELAY_H must be between 0 and 720 hours.");
  if (production && e.CREDITS_REFUND_DELAY_H < 72) throw new Error("CREDITS_REFUND_DELAY_H must be at least 72 in production (the open-dispute window).");
  let facilitatorUrl: string | undefined;
  if (e.X402_FACILITATOR_URL) {
    let url: URL;
    try { url = new URL(e.X402_FACILITATOR_URL); } catch { throw new Error("X402_FACILITATOR_URL must be a URL."); }
    if ((url.protocol !== "https:" && (production || url.protocol !== "http:")) || url.username || url.password || url.hash) throw new Error("X402_FACILITATOR_URL must be an https URL without credentials or a fragment.");
    facilitatorUrl = url.href.replace(/\/$/, "");
  }
  let feeWaiverUntil: Date | null = null;
  if (e.FACILITATOR_FEE_WAIVER_UNTIL) {
    feeWaiverUntil = new Date(e.FACILITATOR_FEE_WAIVER_UNTIL);
    if (Number.isNaN(feeWaiverUntil.getTime())) throw new Error("FACILITATOR_FEE_WAIVER_UNTIL must be an ISO date.");
  }
  return {
    commitment: e.SOLANA_COMMITMENT,
    programs,
    treasury: e.TREASURY_ADDRESS,
    refundPool: e.REFUND_POOL_ADDRESS,
    caps: {
      /** Tab cap in USDC base units. */
      tabUnits: BigInt(Math.round(e.TAB_CAP_USDC * 1e6)),
      /** Credits balance cap per key in USDC base units. */
      creditsUnits: BigInt(Math.round(e.CREDITS_CAP_USDC * 1e6)),
    },
    closureDelayMs: Math.round(e.CREDITS_REFUND_DELAY_H * 3_600_000),
    depositStatusCacheMs: e.DEPOSIT_STATUS_CACHE_MS,
    closures: { unsignedTtlMs: e.CLOSURE_UNSIGNED_TTL_S * 1000, maxUnsignedPerPayer: e.CLOSURE_MAX_UNSIGNED_PER_PAYER, runBudget: e.CLOSURE_RUN_BUDGET },
    facilitatorUrl,
    feeWaiverUntil,
  };
}
