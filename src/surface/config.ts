import { CORE_JOBS } from "./core-allowlist.ts";
import { LAUNCH_SURFACES, SURFACE_ACK, type LaunchSurface } from "./surface.ts";
import { releasedCoreSettings } from "./updates.ts";

// Settings and the launch surface (see surface.ts). Routes and jobs are fenced where they are registered. Some non-core
// features are not routes at all but branches inside a core path (a pay-with header on a chat call, a blind token as
// credentials, a tab voucher, council mode, a program the settlement job would sign for). Those are switched by their own
// settings, so in LAUNCH_SURFACE=core every setting that turns one on is refused:
//   - in production the router does not start, and says which setting and which feature;
//   - elsewhere the setting is dropped before the configuration is read, and listed in the start-up log and under
//     `launch_surface.ignored_settings` of GET /api/v1/status, so a development environment written for the full
//     surface still starts, with the feature off.
// The safer of two designs was chosen: refusing in production instead of silently ignoring means a deployment cannot
// believe a feature is on (or off) by mistake. The alternative, ignoring everywhere, was rejected for that reason.

type Raw = Record<string, unknown>;
const on = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false && !(typeof v === "string" && ["false", "0", "off", "no"].includes(v.trim().toLowerCase()));

/** Setting name -> the non-core feature it would switch on. `when` narrows to the values that do (default: any set value). */
export const NON_CORE_SETTINGS: Record<string, { feature: string; when?: (v: unknown) => boolean }> = {
  // Other ways to pay
  PAYWITH_TOKENS: { feature: "pay-with" },
  PAYWITHSTOCK_ADDRESS: { feature: "pay-with" },
  PAYWITH_SESSION_MODE: { feature: "pay-with (Swig sessions)", when: (v) => v === "swig" },
  PAYMENTS_MODE: { feature: "escrow", when: (v) => v === "escrow" },
  ESCROW_ADDRESS: { feature: "escrow" },
  ESCROW_TOKENS: { feature: "escrow" },
  USDC_ESCROW_ENABLED: { feature: "escrow" },
  TRLS_POOL_LEGS: { feature: "pool-transaction pricing (retired)" },
  TRLS_POOL_PROGRAM: { feature: "pool-transaction pricing (retired)" },
  TRLS_POOL_VAULTS: { feature: "$TRLS deposit pricing" },
  TRLS_BURN_PRIVATE_KEY: { feature: "$TRLS burn" },
  TRLS_TOKEN_ADDRESS: { feature: "$TRLS (holder tiers, escrow)" },
  HOLDER_TIERS: { feature: "holder tiers" },
  FAST_CREDIT_ENABLED: { feature: "fast credit" },
  X402_FACILITATOR_URL: { feature: "external x402 facilitator" },
  TRELLIS_FEATURE_BLIND: { feature: "blind tokens" }, // admitted with the blind update released (updates.ts CORE_WHEN_RELEASED)
  BLIND_MULTI_TOKEN_ENABLED: { feature: "blind token sets" }, // not admitted: one token per call in core
  CREDITS_EXPIRY_ENABLED: { feature: "credit expiry" },
  // Programs other than trellis_credits and trellis_tab (tabs joined the launch on 2026-11-04)
  TRELLIS_BOND_PROGRAM_ID: { feature: "host bonds" },
  PROVIDER_BOND_ADDRESS: { feature: "host bonds" },
  HOST_BOND_ADDRESS: { feature: "host bonds" },
  SLASHER_PRIVATE_KEY: { feature: "slasher" },
  TRELLIS_ANCHOR_PROGRAM_ID: { feature: "program-mode receipt anchoring" },
  RECEIPT_ANCHOR_ADDRESS: { feature: "program-mode receipt anchoring" },
  ANCHOR_MODE: { feature: "program-mode receipt anchoring", when: (v) => v === "program" },
  TRELLIS_RULES_PROGRAM_ID: { feature: "rulebooks" },
  TRELLIS_FEE_ROUTER_PROGRAM_ID: { feature: "fee router" },
  TRELLIS_CAPACITY_PROGRAM_ID: { feature: "prepaid capacity" },
  TRELLIS_MEASUREMENTS_PROGRAM_ID: { feature: "measurement registry" },
  MEASUREMENT_REGISTRY_ADDRESS: { feature: "measurement registry" },
  ROYALTY_ADDRESS: { feature: "creator royalties" },
  PAYMASTER_ADDRESS: { feature: "paymaster" },
  PAYMASTER_SIGNER_KEY: { feature: "paymaster" },
  KEEPER_PRIVATE_KEY: { feature: "keeper role (capacity, HVX)" },
  BUSHELS_ENABLED: { feature: "prepaid capacity" },
  HVX_ENABLED: { feature: "HVX" },
  HVX_PUBLISH_ONCHAIN: { feature: "HVX" },
  MAKEGOOD_REFUND_PRIVATE_KEY: { feature: "make-good on-chain refunds" },
  // R5-12: make-good ledger credits are not core in this launch either (a withheld answer is not charged instead).
  MAKEGOOD_ENABLED: { feature: "make-good refunds" },
  // Agents
  AGENT_POLICY_ENABLED: { feature: "agents (policy)" },
  AGENT_GUARD_ENABLED: { feature: "agents (guard)" },
  AGENT_PAY_ENABLED: { feature: "agents (pay)" },
  AGENT_PROFILES_ENABLED: { feature: "agents (profiles)" },
  AGENT_RULEBOOK_WORDS_ENABLED: { feature: "agents (rulebooks)" },
  AGENT_IDENTITY_ENABLED: { feature: "agents (identity)" },
  AGENT_IDENTITY_REGISTRAR_KEY: { feature: "agents (identity)" },
  AGENT_REGISTRY_PROGRAM_ID: { feature: "agents (identity)" },
  AGENT_SEALED_ENABLED: { feature: "agents (sealed)" }, // R5-12: runs inside the core attestor job
  TELEGRAM_LINKING_ENABLED: { feature: "telegram" },
  TELEGRAM_BOT_TOKEN: { feature: "telegram" },
  WEEKLY_SUMMARY_ENABLED: { feature: "telegram" },
  DEPOSIT_PINGS_ENABLED: { feature: "deposit pings" },
  TOOLS_MARKET_ENABLED: { feature: "tools" },
  TOOLS_BUYER_PRIVATE_KEY: { feature: "tools" },
  DATA_TOOLS_ENABLED: { feature: "data tools" },
  // Network hosts and supply
  NETWORK_HOSTS_ENABLED: { feature: "network hosts" },
  NETWORK_POLICY_ENABLED: { feature: "network hosts" },
  NETWORK_STATS_ENABLED: { feature: "network hosts" },
  NETWORK_PAYOUTS_ENABLED: { feature: "network hosts" },
  NETWORK_SLASHING_ENABLED: { feature: "network hosts" },
  HOST_ANCHOR_ENABLED: { feature: "host anchoring" },
  HOST_DASHBOARD_ENABLED: { feature: "host dashboard" },
  SUPPLY_NOSANA_ENABLED: { feature: "supply adapters" },
  SUPPLY_IONET_ENABLED: { feature: "supply adapters" },
  AUTOLIST_ENABLED: { feature: "auto-listing" },
  HONEST_LEDGER_ENABLED: { feature: "honest ledger" },
  UPSTREAM_MONITOR_ENABLED: { feature: "rush (upstream monitor)" },
  UPSTREAM_BALANCE_URL: { feature: "rush (upstream monitor)" },
  CATALOG_CACHE_ENABLED: { feature: "rush (catalogue cache)" }, // R5-12: a second handler on the core model-list routes
  SHADOW_ENABLED: { feature: "shadow re-execution" },
  DAYZERO_ENABLED: { feature: "day-zero lane" },
  IPX_ENABLED: { feature: "IPX" },
  IPX_ORACLE_ENABLED: { feature: "IPX" },
  IPX_ORACLE_PRIVATE_KEY: { feature: "IPX" },
  IPX_KEEPER_PRIVATE_KEY: { feature: "IPX" },
  MEASUREMENTS_ENABLED: { feature: "measurements" },
  MEASUREMENT_PUBLIC_KEY: { feature: "measurements" },
  TLOG_ENABLED: { feature: "transparency log" },
  TLOG_REKOR_ENABLED: { feature: "transparency log" },
  // Private transports and multi-call modes
  OHTTP_ENABLED: { feature: "OHTTP" },
  OHTTP_CHUNKED_ENABLED: { feature: "OHTTP" },
  ONION_ADDRESS: { feature: "onion" },
  ONION_PROXY_SECRET: { feature: "onion" },
  UNLINKABLE_VIA_ONION: { feature: "onion" },
  E2EE_PASSTHROUGH_ENABLED: { feature: "encrypted pass-through" },
  TRELLIS_FEATURE_COUNCIL: { feature: "council / dual verification" },
  SEALED_MAX_CONCURRENCY_PER_HOST: { feature: "SEALED holder queue", when: (v) => on(v) && Number(v) > 0 },
  // Account extras
  WEBHOOK_SIGNING_ENABLED: { feature: "webhooks" },
  STATEMENTS_ENABLED: { feature: "statements" },
  SPEND_INSIGHTS_ENABLED: { feature: "insights" },
  SKILLS_SOURCES: { feature: "skills", when: (v) => on(v) && String(v).trim() !== "[]" },
  INFERENCE_KEYS_ENABLED: { feature: "restricted inference keys" },
  ROUTE_EXPLAIN_ENABLED: { feature: "route explanations" },
  DECISION_TAGS_ENABLED: { feature: "decision tags" },
  STRUCTURED_OUTPUT_CHECK_ENABLED: { feature: "structured-output check" }, // R5-12: a schema walk on a core chat call
  DEVELOPER_FIRST_CALL_ENABLED: { feature: "first-call pages" },
  ZKAPI_PAGE_ORIGINS: { feature: "zkapi pages" },
  DEV_FAUCET: { feature: "faucet" },
  FAUCET_ENABLED: { feature: "faucet" },
  CANARIES: { feature: "canaries" },
};

export type SurfaceSettings = { surface: LaunchSurface; env: Raw; ignored: { setting: string; feature: string }[] };

/**
 * Read LAUNCH_SURFACE from the raw environment and, in `core`, take every setting that would switch a non-core feature on
 * out of it (or refuse to start, in production). Returns the environment the configuration schema should parse.
 */
export function resolveSurface(raw: Raw): SurfaceSettings {
  const value = raw.LAUNCH_SURFACE === undefined || raw.LAUNCH_SURFACE === "" ? "core" : String(raw.LAUNCH_SURFACE);
  if (!(LAUNCH_SURFACES as readonly string[]).includes(value)) throw new Error("LAUNCH_SURFACE must be core or all.");
  const surface = value as LaunchSurface;
  const production = raw.TRELLIS_ENV === "production";
  if (surface === "all") {
    if (production && raw.LAUNCH_SURFACE_ACK !== SURFACE_ACK)
      throw new Error(`LAUNCH_SURFACE=all registers every feature, including ones no security review has cleared for launch. In production it needs LAUNCH_SURFACE_ACK=${SURFACE_ACK}; without it use LAUNCH_SURFACE=core.`);
    // R4-21: the tier is never a default in production (unset used to mean `full`).
    if (production && (raw.LAUNCH_TIER === undefined || raw.LAUNCH_TIER === "")) throw new Error("LAUNCH_TIER must be set explicitly in production (minimal, credits, payments or full).");
    return { surface, env: raw, ignored: [] };
  }
  const env: Raw = { ...raw };
  const ignored: SurfaceSettings["ignored"] = [];
  // A released update admits its own settings on the core surface (src/surface/updates.ts CORE_WHEN_RELEASED).
  const released = releasedCoreSettings(raw);
  for (const [setting, rule] of Object.entries(NON_CORE_SETTINGS)) {
    if (released.has(setting)) continue;
    const v = raw[setting];
    if (!(rule.when ? rule.when(v) : on(v))) continue;
    if (production)
      throw new Error(`${setting} switches on ${rule.feature}, which is not on the core launch surface. Remove ${setting}, or run LAUNCH_SURFACE=all with LAUNCH_SURFACE_ACK=${SURFACE_ACK} after that feature has been reviewed (security/DEFERRED.md).`);
    delete env[setting];
    ignored.push({ setting, feature: rule.feature });
  }
  // Canaries default to on: in core they are off unless a later review puts them on the list.
  env.CANARIES = "false";
  // Launch tier: core is the `credits` launch (or `minimal`, x402 only). The tier is a minimum set of programs; the
  // programs beyond trellis_credits are refused above.
  const tier = raw.LAUNCH_TIER === undefined || raw.LAUNCH_TIER === "" ? undefined : String(raw.LAUNCH_TIER);
  if (tier !== "minimal" && tier !== "credits") {
    if (production) throw new Error("LAUNCH_SURFACE=core needs an explicit LAUNCH_TIER of credits or minimal in production (tiers payments and full need programs that are not on the core surface).");
    if (tier) ignored.push({ setting: "LAUNCH_TIER", feature: `tier ${tier}` });
    env.LAUNCH_TIER = "credits";
  }
  // A worker's job list may only name core jobs.
  if (typeof raw.WORKER_JOBS === "string" && raw.WORKER_JOBS.trim()) {
    const names = raw.WORKER_JOBS.split(",").map((n) => n.trim()).filter(Boolean);
    const extra = names.filter((n) => !CORE_JOBS.includes(n));
    if (extra.length && production) throw new Error(`WORKER_JOBS names jobs that are not on the core launch surface: ${extra.join(", ")}.`);
    if (extra.length) {
      env.WORKER_JOBS = names.filter((n) => CORE_JOBS.includes(n)).join(",");
      for (const n of extra) ignored.push({ setting: "WORKER_JOBS", feature: `job ${n}` });
    }
  }
  return { surface, env, ignored };
}
