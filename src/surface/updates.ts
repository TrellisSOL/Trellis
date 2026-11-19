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
export const UPDATE_NAMES = ["credits", "trls", "tabs", "facilitator", "sealed", "anchor", "media", "holders", "council", "agents", "blind"] as const;
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
  // Holder tiers, council, agent keys and the blind lane are outside the core launch surface as well, like program-mode
  // anchoring and paying in the token (src/surface/config.ts NON_CORE_SETTINGS): a core production router refuses these
  // settings whatever this file says, so each needs its review and its place on the surface before its switch can open
  // it (UPDATES.md).
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
  // Paying in the token: deposits through the escrow path, priced from a pool, and the fee router that burns what was
  // paid for inference. The token's address is a setting of holder tiers too; either update lets it through.
  trls: [
    { setting: "TRLS_TOKEN_ADDRESS" }, { setting: "PAYMENTS_MODE", when: (v) => v === "escrow" }, { setting: "ESCROW_ADDRESS" }, { setting: "ESCROW_TOKENS" },
    { setting: "TRLS_POOL_LEGS" }, { setting: "TRLS_POOL_PROGRAM" }, { setting: "TRELLIS_FEE_ROUTER_PROGRAM_ID" },
  ],
};

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
