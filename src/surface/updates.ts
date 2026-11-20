import spec from "../features.json" with { type: "json" };

// Release switches (src/features.json, UPDATES.md): which of the prepared updates this router has released.
//
// `main` is the launch as it runs: pay per call, nothing deployed on chain (LAUNCH_TIER=minimal). Each update is built
// and tested already, and off in features.json; its branch (update/<n>-<name>) turns that one switch on. A switch does
// not configure anything by itself. It is the second lock next to the launch surface (surface.ts): the settings that
// would switch an update's feature on are refused on a production router while the update is off, so a deployment
// cannot run a feature that has not been released, and cannot believe one is on (or off) by mistake.
//
//   production      a setting of an update that is off stops the router from starting, naming the setting and the update
//   elsewhere       nothing is refused: development, the test suites and the local launch run whatever they configure
//
// One server can take an update early, or drop one, without a code change: FEATURE_<NAME>=true|false, and FEATURES=all
// or none for every switch at once. GET /api/v1/status reports the switches under `updates`.

type Raw = Record<string, unknown>;
type Entry = { update: number; on: boolean; title: string; summary: string; includes: string[] };

/** In release order: the number of an update is its place here and in src/features.json. */
export const UPDATE_NAMES = ["credits", "trls", "tabs", "facilitator", "sealed", "anchor", "media", "holders", "council", "agents", "blind", "estimate"] as const;
export type UpdateName = (typeof UPDATE_NAMES)[number];
export const UPDATES = spec as Record<UpdateName, Entry>;

const set = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";
const truthy = (v: unknown) => set(v) && !["false", "0", "off", "no"].includes(String(v).trim().toLowerCase());

/** The settings that switch each update's feature on. `when` narrows to the values that do (default: any set value). */
export const UPDATE_SETTINGS: Record<UpdateName, { setting: string; when?: (v: unknown) => boolean }[]> = {
  credits: [
    // Every tier above `minimal` deploys trellis_credits.
    { setting: "LAUNCH_TIER", when: (v) => set(v) && String(v) !== "minimal" },
    { setting: "TRELLIS_CREDITS_PROGRAM_ID" },
    { setting: "CREDITS_ADDRESS" },
    { setting: "SETTLEMENT_PRIVATE_KEY" },
  ],
  tabs: [{ setting: "TRELLIS_TAB_PROGRAM_ID" }, { setting: "CALLPAY_ADDRESS" }],
  facilitator: [{ setting: "FACILITATOR_ENABLED", when: truthy }, { setting: "FACILITATOR_RELAY_PRIVATE_KEY" }],
  sealed: [{ setting: "PRIVATE_AI_BASE_URL" }, { setting: "PRIVATE_AI_ATTESTATION_URL" }],
  anchor: [{ setting: "TRELLIS_ANCHOR_PROGRAM_ID" }, { setting: "RECEIPT_ANCHOR_ADDRESS" }, { setting: "ANCHOR_MODE", when: (v) => v === "program" }],
  // Images and video have no setting of their own: the switch is read by the routes themselves (src/api/media.ts), which
  // answer 404 `not_enabled` while it is off, in every environment.
  media: [],
  // Every update outside the core launch surface (src/surface/config.ts NON_CORE_SETTINGS) is refused by a core
  // production router whatever this file says, until it has its place on the surface: CORE_WHEN_RELEASED below.
  // Council, paying in the token, holder tiers, blind tokens (the first part of the blind lane) and the rulebook half
  // of agent keys have that place.
  holders: [{ setting: "TRLS_TOKEN_ADDRESS" }, { setting: "HOLDER_TIERS" }],
  council: [{ setting: "TRELLIS_FEATURE_COUNCIL", when: truthy }],
  agents: [
    { setting: "AGENT_POLICY_ENABLED", when: truthy }, { setting: "AGENT_GUARD_ENABLED", when: truthy }, { setting: "AGENT_PAY_ENABLED", when: truthy },
    { setting: "AGENT_PROFILES_ENABLED", when: truthy }, { setting: "AGENT_RULEBOOK_WORDS_ENABLED", when: truthy },
    { setting: "TELEGRAM_LINKING_ENABLED", when: truthy }, { setting: "TELEGRAM_BOT_TOKEN" }, { setting: "WEEKLY_SUMMARY_ENABLED", when: truthy },
  ],
  blind: [
    { setting: "TRELLIS_FEATURE_BLIND", when: truthy }, { setting: "BLIND_MULTI_TOKEN_ENABLED", when: truthy },
    { setting: "OHTTP_ENABLED", when: truthy }, { setting: "OHTTP_CHUNKED_ENABLED", when: truthy },
    { setting: "ONION_ADDRESS" }, { setting: "ONION_PROXY_SECRET" }, { setting: "UNLINKABLE_VIA_ONION", when: truthy },
  ],
  // Price check has no setting of its own: the `estimate` route group is mounted only while the switch is on, on either
  // surface (src/app.ts), and a router without it answers 404 for POST /api/v1/estimate.
  estimate: [],
  // Paying in the token: deposits to the escrow wallet, priced from the router's own readings of the token's market
  // (src/solana/trls-price.ts), and the burn of what credited deposits paid (src/solana/trls-burn.ts). The token's address is a setting of holder tiers too; either update lets it through.
  trls: [
    { setting: "TRLS_TOKEN_ADDRESS" }, { setting: "PAYMENTS_MODE", when: (v) => v === "escrow" }, { setting: "ESCROW_ADDRESS" }, { setting: "ESCROW_TOKENS" },
    { setting: "TRLS_POOL_LEGS" }, { setting: "TRLS_POOL_PROGRAM" }, { setting: "TRELLIS_FEE_ROUTER_PROGRAM_ID" },
    { setting: "TRLS_POOL_VAULTS" }, { setting: "TRLS_BURN_PRIVATE_KEY" },
  ],
};

/**
 * Settings of a feature outside the core launch surface that an update admits there once it is released
 * (src/surface/config.ts reads this). An update that is not named here cannot be opened in core by its switch.
 * Council: the `council` and `verify` request fields and the model `trellis/council` (src/surface/request.ts).
 */
export const CORE_WHEN_RELEASED: Partial<Record<UpdateName, readonly string[]>> = {
  council: ["TRELLIS_FEATURE_COUNCIL"],
  // Paying in $TRLS: the token, the wallet deposits go to, the pool it is priced from and the key that burns. Nothing
  // else of escrow is admitted: no escrow mode, no Stock Tokens, no USDC escrow, no fast credit. The retired pool legs
  // stay refused on a core router (dropped outside production) and stop the start on the full surface (config.ts).
  trls: ["TRLS_TOKEN_ADDRESS", "ESCROW_ADDRESS", "TRLS_POOL_VAULTS", "TRLS_BURN_PRIVATE_KEY"],
  // Holder tiers: the token and the tier table. On a core router that opens the public table, a signed-in wallet's own
  // tier (GET /api/v1/holders/me, src/api/holders.ts) and the tier's request and token limit multipliers on the core
  // inference routes. The other perks stay closed there: polls and votes, badges and the per-tier count limits have no
  // core route, the sealed-lane queue and credit expiry have settings of their own that stay refused, and no
  // early-access window is opened (src/config.ts holderSettings).
  holders: ["TRLS_TOKEN_ADDRESS", "HOLDER_TIERS"],
  // The blind lane, its first part only: single-use blind-signed tokens, bought from a balance and spent with no
  // account (the two blind routes, the rotation job and the `PrivateToken` credential: src/surface/request.ts). Token
  // sets (BLIND_MULTI_TOKEN_ENABLED), Oblivious HTTP (OHTTP_*) and the onion service (ONION_*, UNLINKABLE_VIA_ONION)
  // are not admitted: a core router refuses those settings with the switch on as with it off.
  blind: ["TRELLIS_FEATURE_BLIND"],
  // Agent keys: the rulebook engine alone (a rulebook per key, approvals, stop and resume, the event log and the
  // activity ledger: src/surface/core-allowlist.ts, src/surface/request.ts). Guard, agent pay, profiles, rulebook
  // wording for Telegram, Telegram itself and the weekly summary stay refused on a core router.
  agents: ["AGENT_POLICY_ENABLED"],
};

/** The non-core settings the released updates admit on the core surface, for this environment. */
export function releasedCoreSettings(raw: Raw): Set<string> {
  const state = updateState(raw);
  return new Set(UPDATE_NAMES.filter((name) => state[name]).flatMap((name) => CORE_WHEN_RELEASED[name] ?? []));
}

export const overrideName = (name: UpdateName) => `FEATURE_${name.toUpperCase()}`;
export const branchName = (name: UpdateName) => `update/${UPDATES[name].update}-${name}`;

export type UpdateState = Record<UpdateName, boolean>;

/** Which updates are on: features.json, then FEATURES=all|none, then FEATURE_<NAME> for one switch. */
export function updateState(raw: Raw): UpdateState {
  const all = set(raw.FEATURES) ? String(raw.FEATURES).trim().toLowerCase() : "";
  if (all && all !== "all" && all !== "none") throw new Error("FEATURES must be all or none (or unset: src/features.json decides).");
  const state = {} as UpdateState;
  for (const name of UPDATE_NAMES) {
    const own = raw[overrideName(name)];
    if (set(own) && !["true", "false"].includes(String(own).trim().toLowerCase())) throw new Error(`${overrideName(name)} must be true or false.`);
    state[name] = set(own) ? String(own).trim().toLowerCase() === "true" : all ? all === "all" : UPDATES[name].on === true;
  }
  return state;
}

/**
 * The release switches for this process. In production a setting that belongs to an update that is off stops the start.
 * Returns the state for the status route.
 */
export function resolveUpdates(raw: Raw): UpdateState {
  const state = updateState(raw);
  if (raw.TRELLIS_ENV !== "production") return state;
  // A setting that more than one update uses (the token's address) is let through by any of them.
  const released = new Set(UPDATE_NAMES.filter((name) => state[name]).flatMap((name) => UPDATE_SETTINGS[name].map((rule) => rule.setting)));
  for (const name of UPDATE_NAMES) {
    if (state[name]) continue;
    for (const rule of UPDATE_SETTINGS[name]) {
      if (released.has(rule.setting)) continue;
      if (!(rule.when ? rule.when(raw[rule.setting]) : set(raw[rule.setting]))) continue;
      const u = UPDATES[name];
      throw new Error(`${rule.setting} switches on "${u.title}" (update ${u.update}), which this router has not released: src/features.json has \`${name}\` off. Remove ${rule.setting}, or release the update (merge ${branchName(name)}; ${overrideName(name)}=true for this server alone). UPDATES.md says what the update needs first.`);
    }
  }
  return state;
}

/** What GET /api/v1/status says: every update, whether it is on here, and its public title and summary. */
export const updatesStatus = (state: UpdateState) =>
  UPDATE_NAMES.map((name) => ({ name, update: UPDATES[name].update, on: state[name], title: UPDATES[name].title, summary: UPDATES[name].summary, includes: UPDATES[name].includes }));
