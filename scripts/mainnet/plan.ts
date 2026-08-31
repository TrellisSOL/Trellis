// The instruction sets of the mainnet procedure, in one place: what init.ts sends, what the hand-over proposes and what
// resolves it. init.ts, handover.ts, verify.ts and the in-process simulation (simulate.ts, tests/mainnet-handover.ts) all
// build their transactions here, so the thing that is rehearsed and warped through 24 hours in a test is the thing that
// is sent.
//
// Who ends up holding what:
//   upgrade authority    deployer, then the multisig vault (SetAuthorityChecked: the vault signs to take it)
//   config authority     deployer, then the multisig vault (propose, 24 h, resolve with the vault co-signing)
//   guardian             MAINNET_GUARDIAN from init on. A key of its own; the hand-over does not touch it. It can
//                        pause and nothing else: it cannot cancel a proposal (security/REREVIEW-2026-10.md RR-02).
//   trellis_anchor       MAINNET_ANCHORER from init on (it posts a root every hour); no hand-over
//   role keys            settlement, slasher, sale, HVX as named in the environment, from init on
//
// The hand-over is two-step because the programs are (security/REVIEW-2026-10.md TR-23): the current authority proposes,
// CONFIG_TIMELOCK (24 h in the default build) passes, and then the change is applied in an instruction that the NEW
// authority signs as well. For the five programs with a config and for the fee router that instruction needs the old
// authority's signature too, so the resolving transaction carries both: the operator key and the vault. A proposal can
// be applied from `effective_at` until PROPOSAL_TTL (7 days) later; after that it can only be cleared and proposed
// again (RR-09). Only the authority cancels a live proposal; anyone may clear an expired one of the five config programs.
//
// This file also holds what the kit knows about the programs' rules, so that every script and the monitor read them
// from one place: the floors a mainnet build must report through `build_profile` (RR-04), the pause slots and when a
// pause is in force (72 h, then it lapses), and the life cycle of a proposal.
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { anchorIdl, anchorPdas, initSignerSetIx } from "../../src/solana/programs/anchor.ts";
import { bondAt, bondIdl, bondPdas, initializeConfigIx as bondInitializeConfigIx, proposeConfigIx as bondProposeConfigIx, resolveConfigIx as bondResolveConfigIx } from "../../src/solana/programs/bond.ts";
import { bondClaimerPda, capacityAt, capacityConfigPda, capacityIdl, initializeConfigIx as capacityInitializeConfigIx, proposeConfigIx as capacityProposeConfigIx, resolveConfigIx as capacityResolveConfigIx } from "../../src/solana/programs/capacity.ts";
import { creditsAt, creditsIdl, creditsPdas, initConfigIx as creditsInitConfigIx, initLimiterIx, proposeConfigIx as creditsProposeConfigIx, resolveConfigIx as creditsResolveConfigIx, setSettlementsPausedIx, type SettleLimiter } from "../../src/solana/programs/credits.ts";
import { pauseActive, type IdlProgram } from "../../src/solana/programs/idl.ts";
import { feeRouterIdl, feeRouterPdas, initFeeConfigIx, proposeChangeIx, resolveChangeIx } from "../../src/solana/programs/fee-router.ts";
import { initRegistryIx, measurementsIdl, registryPda, resolveAuthorityTransferIx as measurementsResolveIx, transferAuthorityIx as measurementsTransferAuthorityIx } from "../../src/solana/programs/measurements.ts";
import { initConfigIx as rulesInitConfigIx, proposeConfigIx as rulesProposeConfigIx, resolveConfigIx as rulesResolveConfigIx, rulesAt, rulesConfigPda, rulesIdl } from "../../src/solana/programs/rules.ts";
import { enforcerPda, initializeConfigIx as tabInitializeConfigIx, proposeConfigIx as tabProposeConfigIx, resolveConfigIx as tabResolveConfigIx, tabAt, tabConfigPda, tabIdl } from "../../src/solana/programs/tab.ts";
import { BPF_UPGRADEABLE_LOADER, programDataAddress } from "../devnet/lib.ts";
import type { ProgramName, Roles } from "./lib.ts";
import { PARAMS, USDC } from "./params.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

/** The seeds of the three extra USDC accounts (beside the vault's associated account), derived from the deployer key. */
export const SEEDED = { refundPool: "trellis-refund-pool", capacityRefund: "trellis-capacity-refund", workersVault: "trellis-workers-vault" } as const;
export type TokenAccounts = { treasury: PublicKey; refundPool: PublicKey; capacityRefund: PublicKey; workersVault: PublicKey };
export async function tokenAccounts(deployer: PublicKey, usdcMint: PublicKey, vault: PublicKey): Promise<TokenAccounts> {
  const seeded = Object.fromEntries(await Promise.all(Object.entries(SEEDED).map(async ([name, seed]) => [name, await PublicKey.createWithSeed(deployer, seed, TOKEN_PROGRAM_ID)] as const))) as Record<keyof typeof SEEDED, PublicKey>;
  return { treasury: getAssociatedTokenAddressSync(usdcMint, vault, true), ...seeded };
}
/** Which of those accounts a set of programs needs: none for a tier without a program that pays into one. */
export function tokenAccountsNeeded(programs: readonly ProgramName[]): (keyof TokenAccounts)[] {
  const has = (p: ProgramName) => programs.includes(p);
  const out: (keyof TokenAccounts)[] = [];
  if (has("trellis_credits") || has("trellis_bond") || has("trellis_fee_router")) out.push("treasury");
  if (has("trellis_bond")) out.push("refundPool", "capacityRefund");
  if (has("trellis_fee_router")) out.push("workersVault");
  return out;
}

export type PlanContext = {
  /** The id of every program, deployed or reserved. */
  ids: Record<ProgramName, PublicKey>;
  /** The programs this run initialises or hands over, in any order. */
  programs: readonly ProgramName[];
  /** The deployer: upgrade authority and, until the hand-over, config authority. It signs every init. */
  operator: PublicKey;
  roles: Partial<Roles>;
  usdcMint: PublicKey;
  accounts: TokenAccounts;
  pauseCapacity?: boolean;
};
export type Step = { program: ProgramName; pda: PublicKey; what: string; build: () => TransactionInstruction[] };

const need = <T>(v: T | undefined, what: string): T => { if (v === undefined || v === null) throw new Error(`${what} is not set`); return v; };

/**
 * The init instruction of each selected program, in the order of what they guard: what holds or reaches customer funds
 * first (credits, tabs, then bonds and the capacity program that can file claims against them), then the fee router,
 * rulebooks, receipts and the registry. Every init is signed by the operator, which must be the program's upgrade
 * authority (TR-13), and passes the ProgramData account. The guardian and the anchorer are the final keys already.
 */
export function initSteps(c: PlanContext): Step[] {
  const { ids, operator: authority, roles, usdcMint, accounts: a } = c;
  const all: Step[] = [
    { program: "trellis_credits", pda: creditsPdas(ids.trellis_credits).config, what: "init_config (explicit cap and timings; guardian = the guardian key)", build: () => [
      creditsInitConfigIx(ids.trellis_credits, { authority, usdcMint, treasuryTokenAccount: a.treasury, settlementAuthority: need(roles.settlement, "MAINNET_SETTLEMENT_AUTHORITY"), guardian: need(roles.guardian, "MAINNET_GUARDIAN"), maxBalancePerKey: PARAMS.credits.maxBalancePerKey, creditTtl: PARAMS.credits.creditTtl, refundDelay: PARAMS.credits.refundDelay, expiryGrace: PARAMS.credits.expiryGrace }),
    ] },
    { program: "trellis_tab", pda: tabConfigPda(ids.trellis_tab), what: "initialize_config (rules program = the reserved trellis_rules id)", build: () => [
      tabInitializeConfigIx(ids.trellis_tab, { authority, usdcMint, guardian: need(roles.guardian, "MAINNET_GUARDIAN"), rulesProgram: ids.trellis_rules, maxCap: PARAMS.tab.maxCap, reclaimGrace: PARAMS.tab.reclaimGrace }),
    ] },
    { program: "trellis_bond", pda: bondPdas(ids.trellis_bond).config, what: "initialize_config", build: () => [
      bondInitializeConfigIx(ids.trellis_bond, { authority, usdcMint, refundPool: a.refundPool, treasury: a.treasury, capacityRefund: a.capacityRefund, slasher: need(roles.slasher, "MAINNET_SLASHER"), guardian: need(roles.guardian, "MAINNET_GUARDIAN"), capacityClaimer: bondClaimerPda(ids.trellis_capacity), minBond: PARAMS.bond.minBond, unbondPeriod: PARAMS.bond.unbondPeriod, disputeWindow: PARAMS.bond.disputeWindow, disputeBlock: PARAMS.bond.disputeBlock }),
    ] },
    { program: "trellis_capacity", pda: capacityConfigPda(ids.trellis_capacity), what: `initialize_config${c.pauseCapacity ? " + pause" : ""}`, build: () => [
      capacityInitializeConfigIx(ids.trellis_capacity, { authority, saleAuthority: need(roles.sale, "the sale authority"), hvxAuthority: need(roles.hvx, "the HVX authority"), guardian: need(roles.guardian, "MAINNET_GUARDIAN"), gradePrices: need(roles.gradePricesUsdc, "MAINNET_GRADE_PRICES_USDC").map((n) => USDC(n)) as [bigint, bigint, bigint], maxOutstandingValue: PARAMS.capacity.maxOutstandingValue }),
      ...(c.pauseCapacity ? [capacityAt(ids.trellis_capacity).instruction("pause", {}, { signer: authority })] : []),
    ] },
    { program: "trellis_fee_router", pda: feeRouterPdas(ids.trellis_fee_router).feeConfig, what: "init_fee_config (authority = the operator until the hand-over)", build: () => [
      initFeeConfigIx(ids.trellis_fee_router, { authority, payer: authority, feeMint: usdcMint, trlsMint: need(roles.trlsMint, "MAINNET_TRLS_MINT"), workersVault: a.workersVault, treasuryVault: a.treasury, workersBps: PARAMS.feeRouter.workersBps, treasuryBps: PARAMS.feeRouter.treasuryBps }),
    ] },
    { program: "trellis_rules", pda: rulesConfigPda(ids.trellis_rules), what: "init_config", build: () => [
      rulesInitConfigIx(ids.trellis_rules, { authority, guardian: need(roles.guardian, "MAINNET_GUARDIAN"), enforcer: enforcerPda(ids.trellis_tab) }),
    ] },
    // trellis_anchor has one authority and it is the key that posts a root every hour: the anchorer, named at init
    // (the operator only pays and proves it is the upgrade authority). It is never the operator key, not for a second.
    { program: "trellis_anchor", pda: anchorPdas(ids.trellis_anchor).signerSet, what: "init_signer_set (authority = the anchorer key)", build: () => [
      initSignerSetIx(ids.trellis_anchor, { payer: authority, authority: need(roles.anchorer, "MAINNET_ANCHORER"), initialSigner: need(roles.receiptSigner, "MAINNET_RECEIPT_SIGNER") }),
    ] },
    { program: "trellis_measurements", pda: registryPda(ids.trellis_measurements), what: "init_registry (authority = the operator until the hand-over)", build: () => [
      initRegistryIx(ids.trellis_measurements, { payer: authority, authority }),
    ] },
  ];
  return all.filter((s) => c.programs.includes(s.program));
}

// ---- The hand-over ---------------------------------------------------------------------------------------------------------

/**
 * How each program hands its authority over:
 *   config    propose_config(new_authority) then resolve_config(apply) signed by the old authority AND the new one
 *   change    propose_change(new_authority) then resolve_change(apply) signed by the old authority AND the new one
 *   transfer  transfer_authority(new) then resolve_authority_transfer(accept) signed by the new authority alone
 *   none      trellis_anchor: its authority is the anchorer key from init on (it still HAS a pending account: the
 *             anchorer hands itself on with transfer_authority, and the monitor watches that account like the others)
 */
export const HANDOVER_KIND: Record<ProgramName, "config" | "change" | "transfer" | "none"> = {
  trellis_credits: "config", trellis_tab: "config", trellis_bond: "config", trellis_capacity: "config", trellis_rules: "config",
  trellis_fee_router: "change", trellis_measurements: "transfer", trellis_anchor: "none",
};
/** Every program's generated IDL client, by name. */
export const PROGRAM_IDL: Record<ProgramName, IdlProgram> = { trellis_credits: creditsIdl, trellis_tab: tabIdl, trellis_bond: bondIdl, trellis_capacity: capacityIdl, trellis_rules: rulesIdl, trellis_fee_router: feeRouterIdl, trellis_measurements: measurementsIdl, trellis_anchor: anchorIdl };
const seed = (text: string, id: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(text)], id)[0];
/** The account a pending hand-over (or any pending config change) of a program lives in; one per program, all eight. */
export function pendingAddress(p: ProgramName, id: PublicKey): PublicKey {
  return seed(HANDOVER_KIND[p] === "config" ? "pending_config" : HANDOVER_KIND[p] === "change" ? "pending_change" : "pending_authority", id);
}

export type Pending = {
  proposedAt: number; effectiveAt: number; timelock: number; newAuthority: string | null; guardian: string | null;
  /** Every other field the proposal sets (snake_case, as the program names them): roles, payout accounts, parameters. */
  other: string[];
};
const b58 = (k: PublicKey | null | undefined) => (k ? k.toBase58() : null);
/**
 * A pending account decoded through the program's own IDL; null when the bytes are something else. `other` lists what
 * else it would change. A field counts as set when it is not null and not `false`: trellis_credits carries one plain
 * bool (`write_down_spent`), which is false in every proposal that does not ask for it.
 */
export function decodePending(p: ProgramName, data: Uint8Array): Pending | null {
  const idl = PROGRAM_IDL[p];
  const name = HANDOVER_KIND[p] === "config" ? "PendingConfig" : HANDOVER_KIND[p] === "change" ? "PendingChange" : "PendingAuthority";
  let r: Raw | null;
  try { r = idl.decodeAccount<Raw>(name, data); } catch { r = null; }
  if (!r) return null;
  const params: Raw = r.params ?? r.args ?? r;
  const skip = new Set(["new_authority", "guardian", "proposed_at", "effective_at", "bump", "params", "args"]);
  const other = [...Object.entries(params), ...Object.entries(r)].filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== false).map(([k]) => k);
  const proposedAt = Number(r.proposed_at), effectiveAt = Number(r.effective_at);
  return { proposedAt, effectiveAt, timelock: effectiveAt - proposedAt, newAuthority: b58(params.new_authority), guardian: b58(params.guardian), other: [...new Set(other)] };
}
export async function readPending(conn: Pick<Connection, "getAccountInfo">, p: ProgramName, id: PublicKey): Promise<Pending | null> {
  const info = await conn.getAccountInfo(pendingAddress(p, id), "confirmed");
  return info ? decodePending(p, info.data) : null;
}

/**
 * Where a proposal stands at `now` (unix seconds), as the programs judge it:
 *   pending     the timelock is still running: nothing can be applied, the authority can cancel
 *   applicable  from `effective_at` to `effective_at + PROPOSAL_TTL` inclusive: the authority (with the new authority
 *               co-signing a hand-over) can apply it in one transaction
 *   expired     later than that: it can no longer be applied (`ProposalExpired`) and only occupies the program's one
 *               proposal slot until it is cleared (anyone for the five config programs; the authority for the fee
 *               router, the registry and trellis_anchor)
 * `proposalTtl` is the program's own PROPOSAL_TTL, read from build_profile; the mainnet value is the default.
 */
export type ProposalState = "pending" | "applicable" | "expired";
export type Lifecycle = { state: ProposalState; expiresAt: number; toEffective: number; toExpiry: number };
export function proposalLifecycle(x: Pick<Pending, "effectiveAt">, now: number, proposalTtl: number = MAINNET_PROPOSAL_TTL_SECONDS): Lifecycle {
  const expiresAt = x.effectiveAt + proposalTtl;
  const state: ProposalState = now < x.effectiveAt ? "pending" : now > expiresAt ? "expired" : "applicable";
  return { state, expiresAt, toEffective: x.effectiveAt - now, toExpiry: expiresAt - now };
}

/**
 * Step 1, signed by the operator (the current authority): name the vault as the next authority. `guardian` is passed
 * only when the config's guardian is not the final guardian key yet; then it rides in the same proposal.
 */
export function proposeIx(p: ProgramName, id: PublicKey, a: { operator: PublicKey; vault: PublicKey; guardian?: PublicKey | null }): TransactionInstruction | null {
  const change = { authority: a.operator, newAuthority: a.vault, ...(a.guardian ? { guardian: a.guardian } : {}) };
  switch (p) {
    case "trellis_credits": return creditsProposeConfigIx(id, change);
    case "trellis_tab": return tabProposeConfigIx(id, change);
    case "trellis_bond": return bondProposeConfigIx(id, change);
    case "trellis_capacity": return capacityProposeConfigIx(id, change);
    case "trellis_rules": return rulesProposeConfigIx(id, change);
    case "trellis_fee_router": return proposeChangeIx(id, { authority: a.operator, newAuthority: a.vault });
    case "trellis_measurements": return measurementsTransferAuthorityIx(id, { authority: a.operator, newAuthority: a.vault });
    case "trellis_anchor": return null;
  }
}

/**
 * Drop a pending proposal (apply = false / accept = false). `signer` is the current authority, the only key that can
 * cancel a live proposal: the guardian cannot (RR-02). Once a proposal of one of the five config programs has expired
 * anyone may sign this to clear it (`signer` then differs from `authority`, which still receives the rent); the fee
 * router and the registry leave even that to the authority, so there this returns null for any other signer.
 */
export function cancelIx(p: ProgramName, id: PublicKey, a: { operator: PublicKey; signer?: PublicKey }): TransactionInstruction | null {
  const signer = a.signer ?? a.operator;
  const cancel = { signer, authority: a.operator, apply: false };
  switch (p) {
    case "trellis_credits": return creditsResolveConfigIx(id, cancel);
    case "trellis_tab": return tabResolveConfigIx(id, cancel);
    case "trellis_bond": return bondResolveConfigIx(id, cancel);
    case "trellis_capacity": return capacityResolveConfigIx(id, cancel);
    case "trellis_rules": return rulesResolveConfigIx(id, cancel);
    case "trellis_fee_router": return signer.equals(a.operator) ? resolveChangeIx(id, { authority: a.operator, apply: false }) : null;
    case "trellis_measurements": return signer.equals(a.operator) ? measurementsResolveIx(id, { signer: a.operator, authority: a.operator, accept: false }) : null;
    case "trellis_anchor": return null;
  }
}

/**
 * Step 2, after the timelock and before the proposal expires: apply the hand-over. The instruction carries the vault
 * as a signer (it accepts the authority), and for every kind but `transfer` the operator as well (the old authority
 * applies its own proposal).
 */
export function resolveIx(p: ProgramName, id: PublicKey, a: { operator: PublicKey; vault: PublicKey }): TransactionInstruction | null {
  const apply = { signer: a.operator, authority: a.operator, apply: true, newAuthority: a.vault };
  switch (p) {
    case "trellis_credits": return creditsResolveConfigIx(id, apply);
    case "trellis_tab": return tabResolveConfigIx(id, apply);
    case "trellis_bond": return bondResolveConfigIx(id, apply);
    case "trellis_capacity": return capacityResolveConfigIx(id, apply);
    case "trellis_rules": return rulesResolveConfigIx(id, apply);
    case "trellis_fee_router": return resolveChangeIx(id, { authority: a.operator, apply: true, newAuthority: a.vault });
    case "trellis_measurements": return measurementsResolveIx(id, { signer: a.vault, authority: a.operator, accept: true });
    case "trellis_anchor": return null;
  }
}

/**
 * BPF upgradeable loader SetAuthorityChecked (instruction 7): ProgramData (writable), the current authority (signer),
 * the new authority (signer). Unlike SetAuthority it cannot hand a program to an address nobody can sign for.
 */
export function setUpgradeAuthorityCheckedIx(programId: PublicKey, current: PublicKey, next: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: BPF_UPGRADEABLE_LOADER,
    keys: [{ pubkey: programDataAddress(programId), isSigner: false, isWritable: true }, { pubkey: current, isSigner: true, isWritable: false }, { pubkey: next, isSigner: true, isWritable: false }],
    data: Buffer.from([7, 0, 0, 0]),
  });
}
/** SetAuthority (instruction 4) with no new authority: the program becomes immutable. Only for --freeze-upgrades. */
export function removeUpgradeAuthorityIx(programId: PublicKey, current: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: BPF_UPGRADEABLE_LOADER, keys: [{ pubkey: programDataAddress(programId), isSigner: false, isWritable: true }, { pubkey: current, isSigner: true, isWritable: false }], data: Buffer.from([4, 0, 0, 0]) });
}

/**
 * One program's resolving transaction: the config hand-over (when one is pending) and the upgrade authority, together.
 * The config instruction comes first, so a failure there leaves the upgrade authority where it was.
 */
export function resolveInstructions(p: ProgramName, id: PublicKey, a: { operator: PublicKey; vault: PublicKey; config: boolean; upgrade: boolean; freeze?: boolean }): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (a.config) { const ix = resolveIx(p, id, a); if (ix) out.push(ix); }
  if (a.upgrade) out.push(a.freeze ? removeUpgradeAuthorityIx(id, a.operator) : setUpgradeAuthorityCheckedIx(id, a.operator, a.vault));
  return out;
}

// ---- Asking a deployed program which build it is (security/REREVIEW-2026-10.md RR-04) --------------------------------------
//
// The `devnet` cargo feature compiles 1-second floors, a 30-second timelock, a 60-second pause and a 10-minute proposal
// expiry into a binary whose IDL and account layouts are those of the mainnet build. Every one of the eight programs
// therefore answers `build_profile`: the profile byte (0 = the default build, 1 = `devnet`) and the floors themselves,
// as return data. It takes no signer and writes nothing, so it is SIMULATED: on the exact .so files before a deploy
// (simulate.ts), and against the deployed program afterwards (verify.ts, handover.ts, the monitor).

export const MAINNET_TIMELOCK_SECONDS = 86_400;
export const DEVNET_TIMELOCK_SECONDS = 30;
export const MAINNET_PROPOSAL_TTL_SECONDS = 7 * 86_400;
export const MAINNET_PAUSE_TTL_SECONDS = 72 * 3_600;
export const MAINNET_GUARDIAN_COOLDOWN_SECONDS = 7 * 86_400;
const HOUR = 3_600n, DAY = 86_400n;
const TIMELOCKED = { configTimelock: 24n * HOUR, proposalTtl: 7n * DAY };
const PAUSED = { pauseTtl: 72n * HOUR, guardianPauseCooldown: 7n * DAY };
/**
 * What `build_profile` of a mainnet build returns beside `profile = 0`, in seconds, by program: every floor the program
 * enforces whatever its config says. Written out here, not read from the programs: a build is the mainnet build only
 * when it reports exactly these. They are the constants of each program's `#[cfg(not(feature = "devnet"))]` block;
 * tests/mainnet-handover.ts holds target/deploy to this table and target/deploy-devnet away from it.
 */
export const MAINNET_FLOORS: Record<ProgramName, Record<string, bigint>> = {
  trellis_credits: { ...TIMELOCKED, ...PAUSED, minRefundDelay: 72n * HOUR, minExpiryGrace: 30n * DAY, minCreditTtl: 180n * DAY, settleWindow: 24n * HOUR },
  trellis_tab: { ...TIMELOCKED, ...PAUSED, minReclaimGrace: 24n * HOUR },
  trellis_bond: { ...TIMELOCKED, ...PAUSED, minDisputeWindow: 72n * HOUR, minDisputeBlock: 7n * DAY, minUnbondPeriod: 14n * DAY, slashWindow: 30n * DAY },
  trellis_capacity: { ...TIMELOCKED, ...PAUSED, claimPeriod: 14n * DAY },
  trellis_rules: { ...TIMELOCKED, ...PAUSED },
  trellis_fee_router: { ...TIMELOCKED },
  trellis_measurements: { ...TIMELOCKED },
  trellis_anchor: { ...TIMELOCKED, rootRetention: 400n * DAY },
};

/** build_profile of `p` at `id`: no signer, no writable account (trellis_bond and trellis_rules name the clock sysvar). */
export function buildProfileIx(p: ProgramName, id: PublicKey): TransactionInstruction {
  return PROGRAM_IDL[p].at(id).buildProfileInstruction();
}
/** The return data a program set in a transaction, from its logs (`Program return: <id> <base64>`); null when none. */
export function returnDataFromLogs(logs: readonly string[], id: PublicKey): Buffer | null {
  const prefix = `Program return: ${id.toBase58()} `;
  const line = [...logs].reverse().find((l) => typeof l === "string" && l.startsWith(prefix));
  return line ? Buffer.from(line.slice(prefix.length).trim(), "base64") : null;
}

export type ProfileKind = "mainnet" | "devnet" | "unknown";
export type ProfileReading = {
  /** mainnet: profile 0 AND every floor equal to MAINNET_FLOORS. devnet: profile 1. unknown: anything else, or no answer. */
  kind: ProfileKind;
  profile: number | null;
  /** config_timelock in seconds, as reported. */
  timelock: number | null;
  floors: Record<string, bigint>;
  /** Why this is not the mainnet build; empty exactly when `kind` is "mainnet". */
  problems: string[];
};
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/**
 * Judge what build_profile returned. A build that says profile 0 but reports another floor (or lacks one, or adds one
 * this kit does not know) is "unknown", never "mainnet", and no flag accepts it: --allow-devnet-build accepts only a
 * build that says it is the devnet one.
 */
export function appraiseBuildProfile(p: ProgramName, data: Uint8Array | null | undefined): ProfileReading {
  const decoded = data && data.length ? PROGRAM_IDL[p].decodeBuildProfile(data) : null;
  if (!decoded) return { kind: "unknown", profile: null, timelock: null, floors: {}, problems: [data && data.length ? `build_profile returned ${data.length} bytes that are not ${p}'s BuildProfile` : "build_profile returned nothing"] };
  const want = MAINNET_FLOORS[p];
  const off: string[] = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(decoded.floors)])) {
    if (decoded.floors[k] === want[k]) continue;
    off.push(want[k] === undefined ? `${snake(k)} (${decoded.floors[k]} s) is not a floor this kit knows` : `${snake(k)} is ${decoded.floors[k] === undefined ? "missing" : `${decoded.floors[k]} s`}, the mainnet build has ${want[k]} s`);
  }
  const problems = [...(decoded.profile === 0 ? [] : [`profile is ${decoded.profile}${decoded.profile === 1 ? " (the `devnet` cargo feature)" : ""}, the mainnet build reports 0`]), ...off];
  const kind: ProfileKind = decoded.profile === 1 ? "devnet" : decoded.profile === 0 && off.length === 0 ? "mainnet" : "unknown";
  return { kind, profile: decoded.profile, timelock: Number(decoded.configTimelock), floors: decoded.floors, problems };
}
/** One line for people: `profile 0, config_timelock 86400 s, proposal_ttl 604800 s, ...`. */
export function describeProfile(r: ProfileReading): string {
  if (r.profile === null) return "no build profile";
  return [`profile ${r.profile}`, ...Object.entries(r.floors).map(([k, v]) => `${snake(k)} ${v} s`)].join(", ");
}
/** The build a bare timelock points at; only a cross-check of a pending account against what build_profile said. */
export const profileOf = (timelock: number | null): ProfileKind => (timelock === MAINNET_TIMELOCK_SECONDS ? "mainnet" : timelock === DEVNET_TIMELOCK_SECONDS ? "devnet" : "unknown");

// ---- Pauses ----------------------------------------------------------------------------------------------------------------
//
// Five programs have a pause and trellis_credits has two (deposits; the settlement key's outflows), so there are six
// pause slots. The rules are the same for each (RR-02):
//   - the guardian or the authority sets it; it is in force for PAUSE_TTL (72 h) and then LAPSES BY ITSELF, flag or no flag;
//   - the authority may set it again at any time (that renews it for another 72 h) and only the authority lifts it early;
//   - after a guardian pause the guardian cannot pause that slot again until GUARDIAN_PAUSE_COOLDOWN (7 days) after
//     the moment its pause was due to lapse. A stolen guardian key buys one pause of at most 72 hours.

export const PAUSE_SLOTS = ["trellis_credits.deposits", "trellis_credits.settlements", "trellis_tab", "trellis_bond", "trellis_capacity", "trellis_rules"] as const;
export type PauseSlot = (typeof PAUSE_SLOTS)[number];
export const PAUSABLE = ["trellis_credits", "trellis_tab", "trellis_bond", "trellis_capacity", "trellis_rules"] as const;
export const slotProgram = (slot: PauseSlot): ProgramName => slot.split(".")[0] as ProgramName;
export const slotsOf = (p: ProgramName): PauseSlot[] => PAUSE_SLOTS.filter((s) => slotProgram(s) === p);
export const SLOT_STOPS: Record<PauseSlot, string> = {
  "trellis_credits.deposits": "new deposits. Closures, closure refunds, settlement and sweeps continue.",
  "trellis_credits.settlements": "spent-root commits, host payouts and sweeps. Deposits, closures and closure refunds continue.",
  trellis_tab: "new tabs. Open tabs can be vouched, topped up, closed and reclaimed.",
  trellis_bond: "new bonds. Unbonding, slashing and disputes continue.",
  trellis_capacity: "new commitments and sales. Redemptions, shortfall reports and claims continue.",
  trellis_rules: "new rulebooks. Existing ones keep working.",
};

/** Set (`paused` true: pause, or renew a pause) or lift one pause slot. `signer` is the guardian or the authority. */
export function pauseIx(slot: PauseSlot, id: PublicKey, a: { signer: PublicKey; paused: boolean }): TransactionInstruction {
  switch (slot) {
    case "trellis_credits.deposits": return creditsAt(id).instruction("set_deposits_paused", { paused: a.paused }, { signer: a.signer });
    case "trellis_credits.settlements": return setSettlementsPausedIx(id, { signer: a.signer, paused: a.paused });
    case "trellis_rules": return rulesAt(id).instruction("set_new_rulebooks_paused", { paused: a.paused }, { signer: a.signer });
    case "trellis_tab": return tabAt(id).instruction(a.paused ? "pause" : "unpause", {}, { signer: a.signer });
    case "trellis_bond": return bondAt(id).instruction(a.paused ? "pause" : "unpause", {}, { signer: a.signer });
    case "trellis_capacity": return capacityAt(id).instruction(a.paused ? "pause" : "unpause", {}, { signer: a.signer });
  }
}

export type PauseFields = { slot: PauseSlot; flag: boolean; until: number; guardianReadyAt: number };
type PauseConfigs = {
  trellis_credits?: { depositsPaused: boolean; depositsPausedUntil: bigint; depositsGuardianReadyAt: bigint } | null;
  trellis_tab?: { paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint } | null;
  trellis_bond?: { paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint } | null;
  trellis_capacity?: { paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint } | null;
  trellis_rules?: { newRulebooksPaused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint } | null;
};
/** The pause fields of every slot that exists on chain, read from the decoded configs and the credits limiter. */
export function pauseFields(c: PauseConfigs, limiter: Pick<SettleLimiter, "paused" | "pausedUntil" | "guardianPauseReadyAt"> | null | undefined): PauseFields[] {
  const out: PauseFields[] = [];
  const n = (v: bigint | number | undefined | null) => Number(v ?? 0);
  if (c.trellis_credits) out.push({ slot: "trellis_credits.deposits", flag: !!c.trellis_credits.depositsPaused, until: n(c.trellis_credits.depositsPausedUntil), guardianReadyAt: n(c.trellis_credits.depositsGuardianReadyAt) });
  if (c.trellis_credits && limiter) out.push({ slot: "trellis_credits.settlements", flag: !!limiter.paused, until: n(limiter.pausedUntil), guardianReadyAt: n(limiter.guardianPauseReadyAt) });
  for (const p of ["trellis_tab", "trellis_bond", "trellis_capacity"] as const) { const x = c[p]; if (x) out.push({ slot: p, flag: !!x.paused, until: n(x.pausedUntil), guardianReadyAt: n(x.guardianPauseReadyAt) }); }
  if (c.trellis_rules) out.push({ slot: "trellis_rules", flag: !!c.trellis_rules.newRulebooksPaused, until: n(c.trellis_rules.pausedUntil), guardianReadyAt: n(c.trellis_rules.guardianPauseReadyAt) });
  return out;
}

export type PauseView = PauseFields & {
  /** In force right now: the flag is set and `until` lies ahead. */
  active: boolean;
  /** The flag is still set but `until` has passed: the program runs again although its config says "paused". */
  lapsed: boolean;
  /** Seconds until an active pause lapses; 0 otherwise. */
  left: number;
  /** The guardian may not set this slot before `guardianReadyAt`. */
  guardianInCooldown: boolean;
  /**
   * Who last set a pause whose flag is still up, as far as the account shows: a guardian pause leaves
   * `guardian_ready_at = paused_until + cooldown`; any other relation means the authority set (or renewed) it.
   * "unknown" when no flag is set or the cooldown length is not known.
   */
  by: "guardian" | "authority" | "unknown";
};
export function pauseView(f: PauseFields, now: number, guardianCooldown: number | null = MAINNET_GUARDIAN_COOLDOWN_SECONDS): PauseView {
  const active = pauseActive(f.flag, f.until, now);
  return {
    ...f, active, lapsed: f.flag && !active, left: active ? f.until - now : 0, guardianInCooldown: now < f.guardianReadyAt,
    by: !f.flag || guardianCooldown === null ? "unknown" : f.guardianReadyAt === f.until + guardianCooldown ? "guardian" : "authority",
  };
}
/** Whether `signer` may set (or renew) a pause on this slot right now, and if not, why. Mirrors the programs' `next_pause`. */
export function mayPause(v: PauseView, role: "authority" | "guardian" | null): { ok: boolean; why?: string } {
  if (role === "authority") return { ok: true };
  if (role !== "guardian") return { ok: false, why: "the signer is neither the guardian nor the authority" };
  if (v.guardianInCooldown) return { ok: false, why: `the guardian cannot pause this again before ${new Date(v.guardianReadyAt * 1000).toISOString()} (7 days after its last pause was due to lapse): until then only the authority can` };
  return { ok: true };
}

// ---- Accounts made before the current layout ---------------------------------------------------------------------------------

/**
 * migrate_config of the five programs whose config grew by `paused_until` and `guardian_pause_ready_at`: it extends a
 * config created by an earlier build to the current length (the new fields read as "no pause, guardian free to
 * pause"). Anyone may pay, nothing is chosen by the caller, and it works once. Null for the three programs without one.
 */
export function migrateConfigIx(p: ProgramName, id: PublicKey, payer: PublicKey): TransactionInstruction | null {
  if (!(PAUSABLE as readonly string[]).includes(p)) return null;
  return PROGRAM_IDL[p].at(id).instruction("migrate_config", {}, { payer, system_program: SystemProgram.programId });
}
/** init_limiter: creates trellis_credits' `["limiter_v2"]` account for a config that predates it. Anyone may pay. */
export const createLimiterIx = (id: PublicKey, payer: PublicKey): TransactionInstruction => initLimiterIx(id, { payer });
