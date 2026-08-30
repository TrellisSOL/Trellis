// What "handed over" has to cover (security/REVIEW-ROUND3-2026-10.md R3-08): every program that is deployed, whichever
// tier a command names, and every role a config holds, not only the two authorities.
//
// The round-3 sequence this file exists for: `credits` is launched and handed over; later `payments` is deployed and
// initialised with --tier; the environment still says MAINNET_TIER=credits. A script that looks only at the selected
// tier sees one program, held by the vault, and reports the hand-over complete while trellis_tab is still upgradeable
// by the operator key. So the selection never decides what is looked at here:
//
//   deployed        every program found on chain at one of the eight ids of this deployment, plus every program the
//                   record lists. The ids come from the source (`declare_id!`; on mainnet also Anchor.toml
//                   [programs.mainnet]), never from the record alone: lib.ts `programIds` (REVIEW-ROUND4 R4-18)
//   roles           per program, every key its config names (below), and the owner of every account it pays into
//
// Roles, and what each must be once the operator key is retired:
//   upgrade authority, config authority (credits, tab, bond, capacity, rules, fee router), registry authority
//                                 the multisig vault (or no upgrade authority at all: frozen)
//   guardian (five programs)      a key of its own: not the operator, not the vault
//   trellis_anchor authority      the anchorer, a hot key by design (it posts every hour): never the operator key
//   settlement, slasher, sale     hot worker keys by design: never the operator key
//   HVX authority                 the vault by default, or a worker key: never the operator key
//   receipt signer (current and previous)   the router's receipt keys: never the operator key
//   treasury / refund pool / capacity refund / workers vault OWNERS, their delegates and close authorities
//                                 token accounts the programs pay into: the owner is the vault, and there is no delegate
//                                 and no close authority at all (`payoutFindings`: handover.ts and verify.ts both require it)
// A program-derived address in a config (the credits vault, the tab enforcer, the bond claimer) is not a key anyone
// holds and is checked for its derivation by verify.ts, not here.
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { PROGRAMS, type ProgramName, type Record_ } from "./lib.ts";
import type { ChainState } from "./state.ts";

export type RoleKind = "upgrade" | "authority" | "guardian" | "worker" | "signer" | "payout";
export type RoleRow = { program: ProgramName; role: string; kind: RoleKind; address: string | null; /** For a payout role: the token account whose owner this is. */ account?: string };

/** Every key the configs of the deployed programs name, and each program's upgrade authority. Token-account owners come from `payoutRoles`. */
export function configRoles(state: ChainState): RoleRow[] {
  const out: RoleRow[] = [];
  const b58 = (k: PublicKey | null | undefined) => (k ? k.toBase58() : null);
  const add = (program: ProgramName, role: string, kind: RoleKind, k: PublicKey | null | undefined) => out.push({ program, role, kind, address: b58(k) });
  for (const p of PROGRAMS) if (state.programs[p]?.deployed) out.push({ program: p, role: "upgrade", kind: "upgrade", address: state.programs[p].upgradeAuthority });
  const c = state.configs;
  if (c.trellis_credits) { add("trellis_credits", "authority", "authority", c.trellis_credits.authority); add("trellis_credits", "guardian", "guardian", c.trellis_credits.guardian); add("trellis_credits", "settlement", "worker", c.trellis_credits.settlementAuthority); }
  if (c.trellis_anchor) {
    add("trellis_anchor", "authority", "worker", c.trellis_anchor.authority);
    add("trellis_anchor", "receipt signer", "signer", c.trellis_anchor.currentSigner);
    if (c.trellis_anchor.previousSigner && !c.trellis_anchor.previousSigner.equals(PublicKey.default)) add("trellis_anchor", "previous receipt signer", "signer", c.trellis_anchor.previousSigner);
  }
  if (c.trellis_rules) { add("trellis_rules", "authority", "authority", c.trellis_rules.authority); add("trellis_rules", "guardian", "guardian", c.trellis_rules.guardian); }
  if (c.trellis_tab) { add("trellis_tab", "authority", "authority", c.trellis_tab.authority); add("trellis_tab", "guardian", "guardian", c.trellis_tab.guardian); }
  if (c.trellis_bond) { add("trellis_bond", "authority", "authority", c.trellis_bond.authority); add("trellis_bond", "guardian", "guardian", c.trellis_bond.guardian); add("trellis_bond", "slasher", "worker", c.trellis_bond.slasher); }
  if (c.trellis_fee_router) add("trellis_fee_router", "authority", "authority", c.trellis_fee_router.authority);
  if (c.trellis_capacity) { add("trellis_capacity", "authority", "authority", c.trellis_capacity.authority); add("trellis_capacity", "guardian", "guardian", c.trellis_capacity.guardian); add("trellis_capacity", "sale", "worker", c.trellis_capacity.saleAuthority); add("trellis_capacity", "hvx", "worker", c.trellis_capacity.hvxAuthority); }
  if (c.trellis_measurements) add("trellis_measurements", "authority", "authority", c.trellis_measurements.authority);
  return out;
}

/** The token accounts each config pays into, by the name the role is reported under. */
export function payoutAccounts(state: ChainState): { program: ProgramName; name: string; account: PublicKey }[] {
  const c = state.configs, out: { program: ProgramName; name: string; account: PublicKey }[] = [];
  if (c.trellis_credits) out.push({ program: "trellis_credits", name: "treasury", account: c.trellis_credits.treasuryTokenAccount });
  if (c.trellis_bond) out.push({ program: "trellis_bond", name: "refund pool", account: c.trellis_bond.refundPool }, { program: "trellis_bond", name: "treasury", account: c.trellis_bond.treasury }, { program: "trellis_bond", name: "capacity refund", account: c.trellis_bond.capacityRefund });
  if (c.trellis_fee_router) out.push({ program: "trellis_fee_router", name: "workers vault", account: c.trellis_fee_router.workersVault }, { program: "trellis_fee_router", name: "treasury vault", account: c.trellis_fee_router.treasuryVault });
  return out;
}
/**
 * Who can move what the programs pay out: the owner, the delegate and the close authority of every payout account, read
 * from the chain. An account that is missing or is not an SPL Token account is reported with a null address: nothing
 * is assumed about it.
 */
export async function payoutRoles(conn: Pick<Connection, "getAccountInfo">, state: ChainState): Promise<RoleRow[]> {
  const out: RoleRow[] = [];
  for (const x of payoutAccounts(state)) {
    const account = x.account.toBase58();
    const info = await conn.getAccountInfo(x.account, "confirmed");
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) { out.push({ program: x.program, role: `${x.name} owner`, kind: "payout", address: null, account }); continue; }
    let t: ReturnType<typeof unpackAccount>;
    try { t = unpackAccount(x.account, info, TOKEN_PROGRAM_ID); } catch { out.push({ program: x.program, role: `${x.name} owner`, kind: "payout", address: null, account }); continue; }
    out.push({ program: x.program, role: `${x.name} owner`, kind: "payout", address: t.owner.toBase58(), account });
    if (t.delegate) out.push({ program: x.program, role: `${x.name} delegate`, kind: "payout", address: t.delegate.toBase58(), account });
    if (t.closeAuthority) out.push({ program: x.program, role: `${x.name} close authority`, kind: "payout", address: t.closeAuthority.toBase58(), account });
  }
  return out;
}
export const allRoles = async (conn: Pick<Connection, "getAccountInfo">, state: ChainState): Promise<RoleRow[]> => [...configRoles(state), ...(await payoutRoles(conn, state))];
/** `trellis_credits settlement, trellis_tab upgrade`: how a set of roles is named in a refusal. */
export const nameRoles = (rows: readonly RoleRow[]) => rows.map((r) => `${r.program} ${r.role}`).join(", ");

export type Coverage = {
  /** Deployed on chain at an id of this deployment, in deploy order. */
  found: ProgramName[];
  /** Listed in the record's `programs`, whether or not the chain still has them. */
  recorded: ProgramName[];
  /** found or recorded: what a hand-over, a verification or a report has to be about. */
  deployed: ProgramName[];
  /** Deployed but not in the selection: the reason a narrower --tier / MAINNET_TIER is refused. */
  outside: ProgramName[];
  /** Deployed on chain but absent from the record's `programs` (a deploy the record does not know of). */
  unrecorded: ProgramName[];
};
/** What is deployed against what was selected. `state` must have been read for all eight ids (lib.ts `programIds`). */
export function coverageOf(selected: readonly ProgramName[], state: ChainState, rec: Pick<Record_, "programs">): Coverage {
  const found = PROGRAMS.filter((p) => state.programs[p]?.deployed);
  const recorded = PROGRAMS.filter((p) => !!rec.programs[p]?.programId);
  const deployed = PROGRAMS.filter((p) => found.includes(p) || recorded.includes(p));
  return { found, recorded, deployed, outside: deployed.filter((p) => !selected.includes(p)), unrecorded: found.filter((p) => !recorded.includes(p)) };
}
/**
 * Every one of the eight programs, accounted for (R4-18): deployed at its id (and then inspected in detail when it is in
 * the selection, which a selection that leaves a deployed program out fails anyway), or shown not to be deployed: the
 * RPC answered that there is no account at its id. A program without an id is not accounted for.
 */
export type Accounted = Record<string, { programId: string | null; state: "deployed" | "absent" | "no id"; inspected: boolean }>;
export function accountFor(selected: readonly ProgramName[], state: ChainState): Accounted {
  return Object.fromEntries(PROGRAMS.map((p) => {
    const s = state.programs[p];
    const id = s?.programId || null;
    return [p, { programId: id, state: !id ? "no id" : s.deployed ? "deployed" : "absent", inspected: !!id && s.deployed && selected.includes(p) }];
  }));
}
/** One sentence per way the selection falls short of what is deployed; empty when it covers everything. */
export function coverageProblems(c: Coverage, tier: string, selected: readonly ProgramName[]): string[] {
  const out: string[] = [];
  if (c.outside.length) out.push(`${c.outside.join(", ")} ${c.outside.length === 1 ? "is" : "are"} deployed but not covered by the selection (tier ${tier}: ${selected.join(", ") || "no program"}). Run with a --tier / MAINNET_TIER that covers every deployed program`);
  return out;
}

/**
 * The hand-over, judged over EVERYTHING deployed: what is still on the operator key (any role), and which authorities
 * are not the vault's yet. Empty lists mean nothing is left; pending proposals are judged by the caller.
 */
export function handoverFindings(roles: readonly RoleRow[], a: { operator: string; vault: string; frozen?: (p: ProgramName) => boolean }): { onOperator: RoleRow[]; notVault: RoleRow[]; unreadable: RoleRow[]; guardianIsVault: RoleRow[] } {
  const onOperator = roles.filter((r) => r.address === a.operator);
  const notVault = roles.filter((r) => (r.kind === "upgrade" ? !(a.frozen?.(r.program) && r.address === null) && r.address !== a.vault : r.kind === "authority" && r.address !== a.vault));
  return { onOperator, notVault, unreadable: roles.filter((r) => r.kind === "payout" && r.address === null), guardianIsVault: roles.filter((r) => r.kind === "guardian" && r.address === a.vault) };
}

/**
 * What is wrong with the accounts the programs pay into (R4-29): an owner that is not the multisig vault, and any
 * delegate or close authority at all. Whoever owns such an account, or holds a delegation on it, moves what the
 * programs pay out, so a hand-over is not complete while one of them is another key, whichever key that is.
 */
export function payoutFindings(roles: readonly RoleRow[], vault: string): RoleRow[] {
  return roles.filter((r) => r.kind === "payout" && r.address !== null && (/ owner$/.test(r.role) ? r.address !== vault : true));
}
/** One line per payout finding, naming the account, the key and what it should be. */
export const describePayout = (r: RoleRow) => `${r.program} ${r.role} of ${r.account} is ${r.address}${/ owner$/.test(r.role) ? ": not the multisig vault" : ": a payout account must have no delegate and no close authority"}`;

/**
 * Guardians that are also members of the multisig (R4-29). The guardian is the brake on the authority: after the
 * hand-over the authority is the multisig, so a member's key in the guardian's seat is one key on both sides (and a
 * stolen member key pauses the programs). `handover.ts propose --set-guardian` refuses such a key; this is the same
 * rule for a guardian that is already in a config.
 */
export function guardianMemberFindings(roles: readonly RoleRow[], members: readonly string[]): RoleRow[] {
  return roles.filter((r) => r.kind === "guardian" && r.address !== null && members.includes(r.address));
}
export const describeGuardianMember = (rows: readonly RoleRow[]) => `the guardian ${[...new Set(rows.map((r) => r.address))].join(", ")} (${[...new Set(rows.map((r) => r.program))].join(", ")}) is a member of the multisig: the guardian must be a key of its own, not one of the keys that vote for the authority it brakes`;

/**
 * Where the hand-over stands, for verify.ts and its report (R4-17). Once the record says the hand-over is complete
 * (`handover.at`), every deployed program's upgrade authority and config authority must be the vault's, and nothing may
 * be on the operator key: a tier deployed afterwards sits on the operator key until its own hand-over resolves, and
 * until then the deployment is not what a green result would vouch for. `ok` is false exactly in that state; the report
 * carries the rest, so that a reader (the router's start-up guard) does not have to take `ok` on trust.
 */
export type HandoverStanding = { recordedAt: string | null; complete: boolean; ok: boolean; stage: string; vault: string | null; operator: string; onOperatorKey: string[]; notOnVault: string[] };
export function handoverStanding(roles: readonly RoleRow[], a: { operator: string; vault: string | null | undefined; recordedAt: string | null | undefined; stage: string; frozen?: (p: ProgramName) => boolean }): HandoverStanding {
  const f = handoverFindings(roles, { operator: a.operator, vault: a.vault ?? "", frozen: a.frozen });
  const onOperatorKey = f.onOperator.map((r) => `${r.program} ${r.role}`), notOnVault = f.notVault.map((r) => `${r.program} ${r.role}`);
  const complete = !!a.vault && roles.length > 0 && !onOperatorKey.length && !notOnVault.length;
  return { recordedAt: a.recordedAt ?? null, complete, ok: a.recordedAt ? complete : true, stage: a.stage, vault: a.vault ?? null, operator: a.operator, onOperatorKey, notOnVault };
}
