// Launch tiers: which Trellis programs a deployment has. Pure functions, no chain access, so the tests can pin them.
//
// A program costs rent for as long as it lives (about 6.96 SOL per MB of program data), so a launch deploys only what it
// uses. With an attested gateway as launch supply there are no self-run hosts on day one: bonds, prepaid capacity
// (Bushels), rulebooks, the measurement registry and the fee router have nothing to do yet.
//
//   tier       programs deployed                                   what users get
//   minimal    none                                                pay-per-call x402; receipt roots as memo transactions
//   credits    trellis_credits            (the recommended start)  + prepaid credits (deposit, spend, closure refund)
//   payments   trellis_credits, trellis_tab, trellis_anchor        + tabs; receipt roots in the anchor program
//   full       all eight                                           + rulebooks, host bonds, Bushels, fee router, registry
//
// Tiers are additive: `deploy.sh --tier payments` on top of a `credits` deployment deploys only what is missing, and
// `init.ts` initialises only what has no config yet. `--programs a,b,c` names an arbitrary set instead.
//
// Program ids are reserved for ALL eight programs from the start (scripts/mainnet/keys.sh): they cost nothing until
// deployed, and three of them are referenced by other programs (trellis_tab's config names trellis_rules, trellis_bond's
// config names trellis_capacity's claimer PDA, trellis_capacity compiles in trellis_bond's id). A later tier therefore
// lands at the address the earlier ones already point to.

export const PROGRAM_ORDER = ["trellis_credits", "trellis_anchor", "trellis_rules", "trellis_tab", "trellis_bond", "trellis_fee_router", "trellis_capacity", "trellis_measurements"] as const;
export type TierProgram = (typeof PROGRAM_ORDER)[number];
export const TIER_NAMES = ["minimal", "credits", "payments", "full"] as const;
export type TierName = (typeof TIER_NAMES)[number];
export type Tier = TierName | "custom";
export const DEFAULT_TIER: TierName = "credits";

export const TIERS: Record<TierName, readonly TierProgram[]> = {
  minimal: [],
  credits: ["trellis_credits"],
  payments: ["trellis_credits", "trellis_anchor", "trellis_tab"],
  full: PROGRAM_ORDER,
};

/** What a program needs deployed beside it to be of any use. */
export const REQUIRES: Partial<Record<TierProgram, readonly TierProgram[]>> = {
  trellis_capacity: ["trellis_bond"], // commitments lock a host's bond through a CPI into trellis_bond
  trellis_rules: ["trellis_tab"], // a rulebook is enforced by trellis_tab's enforcer PDA
};

const ordered = (set: Iterable<TierProgram>): TierProgram[] => { const s = new Set(set); return PROGRAM_ORDER.filter((p) => s.has(p)); };
/** The tier whose program set is exactly `programs`, or "custom". */
export function tierOf(programs: readonly TierProgram[]): Tier {
  const key = ordered(programs).join(",");
  return TIER_NAMES.find((t) => ordered(TIERS[t]).join(",") === key) ?? "custom";
}
/** The LAUNCH_TIER a router can run with on these programs: the largest tier whose required programs are all there. */
export function routerTier(programs: readonly TierProgram[]): TierName {
  const has = (p: TierProgram) => programs.includes(p);
  if (has("trellis_credits") && has("trellis_tab") && has("trellis_anchor") && has("trellis_bond")) return "full";
  if (has("trellis_credits") && has("trellis_tab") && has("trellis_anchor")) return "payments";
  if (has("trellis_credits")) return "credits";
  return "minimal";
}

/**
 * `--tier <name>` or `--programs a,b,c` (names with or without the `trellis_` prefix). Neither: `fallback` (the tier of
 * the deployments record when there is one), else the recommended `credits`. Returns problems instead of exiting.
 */
export function selectPrograms(o: { tier?: string; programs?: string; fallback?: readonly TierProgram[] }): { tier: Tier; programs: TierProgram[]; problems: string[] } {
  const problems: string[] = [];
  if (o.tier !== undefined && o.programs !== undefined) problems.push("pass --tier or --programs, not both");
  let programs: TierProgram[];
  if (o.programs !== undefined) {
    const names = o.programs.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith("trellis_") ? s : `trellis_${s}`));
    const unknown = names.filter((n) => !(PROGRAM_ORDER as readonly string[]).includes(n));
    if (unknown.length) problems.push(`unknown program(s): ${unknown.join(", ")}; choose from ${PROGRAM_ORDER.join(", ")}`);
    programs = ordered(names.filter((n): n is TierProgram => (PROGRAM_ORDER as readonly string[]).includes(n)));
  } else if (o.tier !== undefined) {
    if (!(TIER_NAMES as readonly string[]).includes(o.tier)) { problems.push(`unknown tier ${o.tier}; choose from ${TIER_NAMES.join(", ")}`); programs = []; }
    else programs = ordered(TIERS[o.tier as TierName]);
  } else programs = ordered(o.fallback ?? TIERS[DEFAULT_TIER]);
  for (const p of programs) for (const need of REQUIRES[p] ?? []) if (!programs.includes(need)) problems.push(`${p} needs ${need} deployed with it`);
  return { tier: tierOf(programs), programs, problems };
}

/** Receipt roots go to the anchor program when it is part of the deployment, otherwise out as memo transactions. */
export const anchorModeOf = (programs: readonly TierProgram[]): "memo" | "program" => (programs.includes("trellis_anchor") ? "program" : "memo");

// ---- What a tier gives, in words (preflight and MAINNET.md print the same rows) -----------------------------------------
export const TIER_GIVES: Record<TierName, string> = {
  minimal: "pay-per-call x402 only; receipts with hourly roots posted as memo transactions",
  credits: "minimal + prepaid credits (deposit, spend, closure refund after 72 h, expiry sweep)",
  payments: "credits + tabs (open, voucher, close) and receipt roots in the anchor program",
  full: "payments + rulebooks, host bonds and slashing, prepaid capacity (Bushels), the fee router and the measurement registry",
};
export const DEFERRED: Record<TierProgram, string> = {
  trellis_credits: "prepaid credits: keys cannot be funded on chain; every call is paid per call",
  trellis_anchor: "the receipt-root program: roots are memo transactions signed by the anchorer key instead (weaker: see MAINNET.md)",
  trellis_rules: "rulebooks (spending limits enforced on tabs)",
  trellis_tab: "tabs (escrowed pay-as-you-go with vouchers)",
  trellis_bond: "host bonds and slashing: needed only once self-run (Graft) hosts join",
  trellis_fee_router: "the fee router ($TRLS burn and fee split; every fee setting is 0 at launch)",
  trellis_capacity: "prepaid capacity (Bushels)",
  trellis_measurements: "the on-chain measurement registry (measurements stay signed bundles off chain)",
};

// ---- SOL -------------------------------------------------------------------------------------------------------------------
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Rent-exempt minimum on every cluster today: (bytes + 128 bytes of account overhead) x 3,480 lamports per byte-year x 2 years. */
export const rentExempt = (bytes: number) => (bytes + 128) * 6_960;
/** ProgramData header (45 bytes) and the 36-byte program account, both rent-exempt for as long as the program lives. */
export const programRent = (soBytes: number, headroom = 0) => rentExempt(soBytes + headroom + 45) + rentExempt(36);
/** One signature, no priority fee: what a memo transaction costs. */
export const SIGNATURE_FEE = 5_000;
export const HOURS_PER_MONTH = 720;
/** Anchor account sizes: 8-byte discriminator + fields (programs/trellis_anchor/src/state.rs, programs/trellis_credits/src/state.rs). */
export const RECEIPT_ROOT_BYTES = 8 + 8 + 32 + 8 + 32 + 8 + 1;
export const SPENT_ROOT_BYTES = 8 + 8 + 32 + 8 + 8 + 8 + 1;
export const ROOT_RETENTION_DAYS = 400;

export type MonthlyCost = { item: string; lamports: number; kind: "fee" | "rent (returned after 400 days)" | "rent (not returned)"; note: string };
/**
 * What the chain costs each month once running, with a root every hour (the worst case: an hour without traffic posts
 * nothing) and `spentRootsPerDay` settlement commits (SETTLEMENT_INTERVAL_MS: 1 a day at 86400000, 24 at the default).
 */
export function monthlyCost(programs: readonly TierProgram[], o: { spentRootsPerDay?: number } = {}): MonthlyCost[] {
  const out: MonthlyCost[] = [];
  if (anchorModeOf(programs) === "memo") out.push({ item: "receipt roots (memo)", lamports: HOURS_PER_MONTH * SIGNATURE_FEE, kind: "fee", note: "one memo transaction an hour, no account" });
  else {
    out.push({ item: "receipt roots (program): rent", lamports: HOURS_PER_MONTH * rentExempt(RECEIPT_ROOT_BYTES), kind: "rent (returned after 400 days)", note: `one ${RECEIPT_ROOT_BYTES}-byte account an hour; close_root returns it once the hour is ${ROOT_RETENTION_DAYS} days old, so about ${((ROOT_RETENTION_DAYS * 24 * rentExempt(RECEIPT_ROOT_BYTES)) / LAMPORTS_PER_SOL).toFixed(1)} SOL stays locked at steady state` });
    out.push({ item: "receipt roots (program): fees", lamports: HOURS_PER_MONTH * SIGNATURE_FEE, kind: "fee", note: "one transaction an hour" });
  }
  if (programs.includes("trellis_credits")) {
    const perDay = o.spentRootsPerDay ?? 1;
    out.push({ item: `spent roots (${perDay} a day): rent`, lamports: perDay * 30 * rentExempt(SPENT_ROOT_BYTES), kind: "rent (not returned)", note: `one ${SPENT_ROOT_BYTES}-byte account per settlement commit that changed anything; trellis_credits has no close instruction for them yet (SETTLEMENT_INTERVAL_MS sets the cadence)` });
    out.push({ item: `spent roots (${perDay} a day): fees`, lamports: perDay * 30 * SIGNATURE_FEE, kind: "fee", note: "" });
  }
  return out;
}

export type Funding = { role: string; env: string; lamports: number; why: string };
/**
 * SOL for the keys that pay fees, per tier. A fee payer needs a float, not a balance: `floatLamports` each (0.1 SOL by
 * default, MAINNET_ROLE_FLOAT_SOL). A key that also pays account rent gets `months` of that rent on top.
 */
export function roleFunding(programs: readonly TierProgram[], o: { floatLamports?: number; months?: number; spentRootsPerDay?: number; facilitator?: boolean } = {}): Funding[] {
  const float = o.floatLamports ?? 100_000_000, months = o.months ?? 1;
  const cost = monthlyCost(programs, o);
  const rent = (prefix: string) => cost.filter((c) => c.item.startsWith(prefix) && c.kind !== "fee").reduce((s, c) => s + c.lamports, 0) * months;
  const out: Funding[] = [
    { role: "router signing key", env: "MONITOR_ROUTER_ADDRESS", lamports: float, why: "fee payer of x402 per-call payments: it fronts the network fee of each, which is passed through to the payer at cost as its own receipt line (no part of the price of a call)" },
    { role: "anchorer", env: "MAINNET_ANCHORER", lamports: float + rent("receipt roots"), why: anchorModeOf(programs) === "memo" ? `one memo transaction an hour: ${((HOURS_PER_MONTH * SIGNATURE_FEE) / LAMPORTS_PER_SOL).toFixed(4)} SOL a month` : `fees plus ${months} month(s) of root rent` },
  ];
  if (programs.includes("trellis_credits")) out.push({ role: "settlement", env: "MAINNET_SETTLEMENT_AUTHORITY", lamports: float + rent("spent roots"), why: `fees plus ${months} month(s) of spent-root rent at ${o.spentRootsPerDay ?? 1} commit(s) a day` });
  if (programs.includes("trellis_bond")) out.push({ role: "slasher", env: "MAINNET_SLASHER", lamports: float, why: "fees of slash proposals and executions" });
  if (o.facilitator) out.push({ role: "facilitator relay", env: "MONITOR_FACILITATOR_RELAY_ADDRESS", lamports: float, why: "fee payer of hosted facilitator settlements (only when FACILITATOR_ENABLED)" });
  if (programs.length) {
    out.push({ role: "guardian", env: "MAINNET_GUARDIAN", lamports: 10_000_000, why: "the fee of a pause transaction, ready before it is needed" });
    out.push({ role: "multisig vault", env: "MAINNET_MULTISIG_VAULT", lamports: 20_000_000, why: "after the hand-over the vault pays the rent of each config proposal (returned when it resolves)" });
  }
  return out;
}
