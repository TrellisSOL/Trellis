// Mainnet parameters for the Trellis programs: the single place the deploy, init, verify and handover scripts read them
// from. The values are the spec defaults of docs/Trellis_Backend.md §5 and §10 and the owner decisions of 2026-10-12
// (PORT-NOTES.md): the pre-audit caps stay, pricing is zero markup, every fee setting is 0.
//
// The six timings and the minimum bond that differ between clusters come from the `mainnet` set of
// scripts/devnet/profile.ts (the spec values), so the devnet `--profile mainnet` run and mainnet itself read one source;
// the short `devnet` set of that file is never imported here. `assertSpec` below fails the import if that set ever
// stops matching the spec numbers written out in this file.
import { SOLANA_MAINNET_CAIP2, USDC_MINT } from "../../src/solana/constants.ts";
import { TREASURY_BPS, WORKERS_BPS } from "../../src/solana/programs/fee-router.ts";
import { PROFILES } from "../devnet/profile.ts";

/** Genesis hash of Solana mainnet-beta. A script in mainnet mode refuses any RPC that reports another one. */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Genesis hashes of the public test clusters: a rehearsal refuses them too (it runs against a local validator only). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export const MAINNET_CAIP2 = SOLANA_MAINNET_CAIP2;
/** Circle's USDC mint on mainnet-beta (classic SPL Token program, 6 decimals). */
export const MAINNET_USDC = USDC_MINT;
export const USDC_DECIMALS = 6;
/** Squads Protocol v4 multisig program (the same address on mainnet-beta and devnet). */
export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

export const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const HOUR = 3_600n;
const DAY = 86_400n;
const SPEC = PROFILES.mainnet;

/**
 * What init.ts writes and verify.ts asserts. Durations are in seconds, amounts in USDC base units (6 decimals).
 * Every value is passed to the programs explicitly, so mainnet does not depend on a program-side default.
 */
export const PARAMS = {
  credits: {
    maxBalancePerKey: USDC(5_000), // pre-audit cap: credits <= 5,000 USDC per key
    creditTtl: 365n * DAY, // credits expire 365 days after the latest deposit
    refundDelay: SPEC.refundDelayS, // closure refunds wait 72 h (the open-dispute window)
    expiryGrace: SPEC.expiryGraceS, // expired balances move to treasury 30 days after the notice
    // Not an init argument: the program creates the outflow limiter with this rate (DEFAULT_SETTLE_RATE_BPS). Host
    // settlements may take at most this share of the vault over any 24 h, and closure refunds the same from an
    // allowance of their own. verify.ts and the monitor hold the limiter to it; raising it takes the 24 h timelock.
    settleRateBps: 2_000,
  },
  tab: {
    maxCap: USDC(500), // pre-audit cap: tab <= 500 USDC
    reclaimGrace: 24n * HOUR, // payer reclaim opens 24 h after expiry
  },
  bond: {
    minBond: SPEC.minBondUnits, // host bond >= 10,000 USDC
    unbondPeriod: SPEC.unbondPeriodS, // 14 days
    disputeWindow: SPEC.disputeWindowS, // 72 h
    disputeBlock: SPEC.disputeBlockS, // a dispute blocks execution until resolved or 7 days pass
  },
  capacity: {
    maxOutstandingValue: USDC(250_000), // pre-audit cap: prepaid capacity outstanding <= $250k
  },
  feeRouter: {
    workersBps: WORKERS_BPS, // 0: no fee split
    treasuryBps: TREASURY_BPS, // 10,000: anything the fee router ever receives goes to the treasury vault
  },
  /** Not an on-chain value: the Toolshed tool-provider bond the router enforces (docs §7). Printed so the owner sees it. */
  toolBondUsdc: 2_000,
  trlsDecimals: 9,
} as const;

/**
 * The spec numbers, written out. A change to the shared profile that moved mainnet away from them (a shortened window,
 * a smaller bond) stops every mainnet script at import instead of being deployed.
 */
function assertSpec(): void {
  const want: [string, bigint, bigint][] = [
    ["credits refund delay (72 h)", PARAMS.credits.refundDelay, 72n * HOUR],
    ["credits expiry grace (30 d)", PARAMS.credits.expiryGrace, 30n * DAY],
    ["minimum host bond (10,000 USDC)", PARAMS.bond.minBond, USDC(10_000)],
    ["unbond period (14 d)", PARAMS.bond.unbondPeriod, 14n * DAY],
    ["dispute window (72 h)", PARAMS.bond.disputeWindow, 72n * HOUR],
    ["dispute block (7 d)", PARAMS.bond.disputeBlock, 7n * DAY],
  ];
  const off = want.filter(([, have, spec]) => have !== spec).map(([name]) => name);
  if (off.length) throw new Error(`scripts/devnet/profile.ts PROFILES.mainnet no longer carries the spec value for: ${off.join(", ")}. Mainnet scripts refuse to run with it.`);
}
assertSpec();

/** The same parameters as printable rows (preflight prints them before the typed confirmation). */
export function describeParams(gradePricesUsdc: number[] | null): [string, string][] {
  const usdc = (v: bigint) => `${(Number(v) / 1e6).toLocaleString("en-US")} USDC`;
  const hours = (v: bigint) => `${Number(v / HOUR)} h`;
  const days = (v: bigint) => `${Number(v / DAY)} d`;
  return [
    ["credits: cap per key", usdc(PARAMS.credits.maxBalancePerKey)],
    ["credits: TTL", days(PARAMS.credits.creditTtl)],
    ["credits: closure refund delay", hours(PARAMS.credits.refundDelay)],
    ["credits: expiry grace", days(PARAMS.credits.expiryGrace)],
    ["credits: outflow limit", `${PARAMS.credits.settleRateBps / 100}% of the vault per 24 h (program default; at least 1,000 USDC; a quarter of it at once)`],
    ["tab: cap", usdc(PARAMS.tab.maxCap)],
    ["tab: reclaim grace", hours(PARAMS.tab.reclaimGrace)],
    ["bond: minimum host bond", usdc(PARAMS.bond.minBond)],
    ["bond: unbond period", days(PARAMS.bond.unbondPeriod)],
    ["bond: dispute window", hours(PARAMS.bond.disputeWindow)],
    ["bond: dispute block", days(PARAMS.bond.disputeBlock)],
    ["capacity: max prepaid capacity outstanding", usdc(PARAMS.capacity.maxOutstandingValue)],
    ["capacity: grade prices (G-S, G-M, G-L)", gradePricesUsdc ? `${gradePricesUsdc.join(", ")} USDC per Bushel` : "NOT SET (MAINNET_GRADE_PRICES_USDC)"],
    ["fee router: workers / treasury", `${PARAMS.feeRouter.workersBps} / ${PARAMS.feeRouter.treasuryBps} bps (no fee split)`],
    ["router setting: tool-provider bond", `${PARAMS.toolBondUsdc.toLocaleString("en-US")} USDC (off chain, docs §7)`],
    ["router settings: markup", "PER_CALL_MARGIN_BPS=0 PROVIDER_FEE_BPS=0 BYOK_FEE_BPS=0 FACILITATOR_FEE_BPS=0 (zero markup)"],
  ];
}
