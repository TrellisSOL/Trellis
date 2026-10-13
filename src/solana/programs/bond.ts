import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { IdlProgram, le64, programDataAddress, type TrellisIdl } from "./idl.ts";
import { toHex0x } from "./encoding.ts";
import idl from "../idl/trellis_bond.json";

// trellis_bond (docs/Trellis_Backend.md §5.3), built from src/solana/idl/trellis_bond.json. HostBond{host (the host's
// wallet), amount >= min_bond (10,000 USDC), unbond_at, strikes, delisted, ejected}; 14-day unbond; slashes are
// proposals opened by the config's slasher with an evidence hash, a reason code and the schedule's bps
// (propose_slash(proposal_id, evidence_hash, bps, reason_code, refund_amount)); anyone may crank execute_slash after the
// 72h dispute window, unless the host disputed inside it (then until the authority resolves it or dispute_block passes).
// The slash is computed against the bond as it stands at execution; refund_amount goes to refund_pool first, the rest to
// treasury. A proposal is addressed by its PDA ["proposal", bond, proposal_id LE] (ids count per bond).
// Security review round 3: a rate-based slash that the cumulative cap would cut is executed by the slasher only, and one
// cut to zero neither delists nor ejects (R3-26); `delisted` / `ejected` are cleared only by the authority through
// propose_reinstate and its 24 h timelock; a capacity claim is taken out of the bond's lock when it is filed and can
// never exceed what is locked (R3-16).
// PDA seeds: ["config"], ["bond", host], ["vault", bond], ["proposal", bond, proposal_id LE], ["lock", bond],
// ["slash_ledger", bond], ["pending_reinstate", bond].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const BOND_IDL = idl as unknown as TrellisIdl;
export const bondIdl = new IdlProgram(BOND_IDL);
export const bondAt = (programId: PublicKey | string) => bondIdl.at(programId);

export const BOND_SEEDS = {
  config: [Buffer.from("config")],
  bond: (host: PublicKey) => [Buffer.from("bond"), host.toBuffer()],
  vault: (bond: PublicKey) => [Buffer.from("vault"), bond.toBuffer()],
  proposal: (bond: PublicKey, id: bigint | number) => [Buffer.from("proposal"), bond.toBuffer(), le64(id)],
  lock: (bond: PublicKey) => [Buffer.from("lock"), bond.toBuffer()],
  pendingConfig: [Buffer.from("pending_config")],
  pendingReinstate: (bond: PublicKey) => [Buffer.from("pending_reinstate"), bond.toBuffer()],
};

export const MIN_BOND_UNITS = 10_000_000_000n; // 10,000 USDC
export const UNBOND_DELAY_S = 14 * 86_400;
export const DISPUTE_WINDOW_S = 72 * 3_600;
export const DISPUTE_BLOCK_S = 7 * 86_400;
export const BPS_DENOMINATOR = 10_000n;
/** One rate-based proposal carries at most 50% of a bond (the program refuses more, whatever the reason). */
export const MAX_SLASH_BPS_PER_PROPOSAL = 5_000;

/** Slash reasons by on-chain code (Borsh variant order). */
export const SLASH_REASONS = ["EmptyTwoHundred", "QuantizationSwap", "UptimeBelow95", "ShadowMismatch", "SealedWithoutAttestation", "CapacityShortfall"] as const;
export type SlashReason = (typeof SLASH_REASONS)[number];
export const slashReasonCode = (r: SlashReason) => SLASH_REASONS.indexOf(r);
/** The schedule the program enforces: unit bps and whether bps may be a multiple (per day / per incident). */
export const SLASH_SCHEDULE: Record<SlashReason, { unitBps: number; perUnit: boolean; delists: boolean; ejects: boolean } | null> = {
  EmptyTwoHundred: { unitBps: 100, perUnit: false, delists: false, ejects: false },
  QuantizationSwap: { unitBps: 2_500, perUnit: false, delists: true, ejects: false },
  UptimeBelow95: { unitBps: 50, perUnit: true, delists: false, ejects: false },
  ShadowMismatch: { unitBps: 5_000, perUnit: false, delists: true, ejects: true },
  SealedWithoutAttestation: { unitBps: 500, perUnit: true, delists: false, ejects: false },
  CapacityShortfall: null,
};
/** The router's slash kinds mapped onto the program's reason codes (kinds with no on-chain reason are off-chain only). */
export const SLASH_KIND: Record<string, number> = { empty200: 0, quant_fraud: 1, uptime: 2, shadow_mismatch: 3, sealed_no_attestation: 4, capacity_underdelivered: 5 };
export const SLASH_DELISTS = (code: number) => !!SLASH_SCHEDULE[SLASH_REASONS[code]]?.delists;
export const slashAmount = (bondAmount: bigint, bps: number) => (bondAmount * BigInt(bps)) / BPS_DENOMINATOR;

export function bondPdas(programId: PublicKey, host?: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync(BOND_SEEDS.config, programId);
  const bond = host ? PublicKey.findProgramAddressSync(BOND_SEEDS.bond(host), programId)[0] : null;
  const vault = bond ? PublicKey.findProgramAddressSync(BOND_SEEDS.vault(bond), programId)[0] : null;
  return { config, bond, vault };
}
export const proposalPda = (programId: PublicKey, bond: PublicKey, id: bigint | number) => PublicKey.findProgramAddressSync(BOND_SEEDS.proposal(bond, id), programId)[0];
/** The bond's lock account: USDC locked behind open capacity commitments (withdraw_bond pays amount - locked). */
export const bondLockPda = (programId: PublicKey, bond: PublicKey) => PublicKey.findProgramAddressSync(BOND_SEEDS.lock(bond), programId)[0];
/** The bond's slash ledger: rate-based slashes of the last two 30-day windows and the capacity claims still open. */
export const slashLedgerPda = (programId: PublicKey, bond: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("slash_ledger"), bond.toBuffer()], programId)[0];
export type SlashLedger = { bond: PublicKey; windowIndex: bigint; slashedCurrent: bigint; slashedPrevious: bigint; pendingClaims: bigint };
export function decodeSlashLedger(data: Uint8Array): SlashLedger | null {
  const r = bondIdl.decodeAccount<Raw>("SlashLedger", data);
  return r ? { bond: r.bond, windowIndex: r.window_index, slashedCurrent: r.slashed_current, slashedPrevious: r.slashed_previous, pendingClaims: r.pending_claims } : null;
}
export function decodeBondLock(data: Uint8Array): { bond: PublicKey; locked: bigint } | null {
  const r = bondIdl.decodeAccount<Raw>("BondLock", data);
  return r ? { bond: r.bond, locked: r.locked } : null;
}
/** A bond's pending reinstatement (one per bond): the authority's proposal to clear `delisted` / `ejected`, waiting out the timelock. */
export const pendingReinstatePda = (programId: PublicKey, bond: PublicKey) => PublicKey.findProgramAddressSync(BOND_SEEDS.pendingReinstate(bond), programId)[0];
export type PendingReinstate = { bond: PublicKey; strikes: number; proposedAt: bigint; effectiveAt: bigint };
export function decodePendingReinstate(data: Uint8Array): PendingReinstate | null {
  const r = bondIdl.decodeAccount<Raw>("PendingReinstate", data);
  return r ? { bond: r.bond, strikes: r.strikes, proposedAt: r.proposed_at, effectiveAt: r.effective_at } : null;
}
export type ReinstateProposedEvent = { bond: PublicKey; host: PublicKey; effectiveAt: bigint; expiresAt: bigint };
export const reinstateProposedEvents = (programId: PublicKey | string, logs: readonly string[]): ReinstateProposedEvent[] => bondIdl.at(programId).eventsNamed<Raw>("ReinstateProposed", logs).map((e) => ({ bond: e.bond, host: e.host, effectiveAt: e.effective_at, expiresAt: e.expires_at }));
export type ReinstateResolvedEvent = { bond: PublicKey; host: PublicKey; applied: boolean; by: PublicKey };
export const reinstateResolvedEvents = (programId: PublicKey | string, logs: readonly string[]): ReinstateResolvedEvent[] => bondIdl.at(programId).eventsNamed<Raw>("ReinstateResolved", logs).map((e) => ({ bond: e.bond, host: e.host, applied: e.applied, by: e.by }));
/** BondConfigProposed, with the two flags added in round 3 (a change of the capacity claimer or of a payout account). */
export type BondConfigProposedEvent = { effectiveAt: bigint; expiresAt: bigint; changesAuthority: boolean; changesGuardian: boolean; changesCapacityClaimer: boolean; changesPayoutAccounts: boolean };
export const bondConfigProposedEvents = (programId: PublicKey | string, logs: readonly string[]): BondConfigProposedEvent[] => bondIdl.at(programId).eventsNamed<Raw>("BondConfigProposed", logs).map((e) => ({ effectiveAt: e.effective_at, expiresAt: e.expires_at, changesAuthority: e.changes_authority, changesGuardian: e.changes_guardian, changesCapacityClaimer: e.changes_capacity_claimer, changesPayoutAccounts: e.changes_payout_accounts }));

/**
 * What the bond's cumulative cap leaves for a rate-based slash right now (the program's `SlashLedger::room`, with the
 * ledger rolled to `now`): all such slashes of the current 30-day window and the one before take at most 50% of the
 * bond as it stood before them. `windowSeconds` is the program's SLASH_WINDOW (30 days on the mainnet build).
 */
export function slashCapRoom(bondAmount: bigint, ledger: Pick<SlashLedger, "windowIndex" | "slashedCurrent" | "slashedPrevious"> | null, now: number | bigint, windowSeconds = 30 * 86_400): bigint {
  const index = BigInt(now) / BigInt(windowSeconds);
  let current = 0n, previous = 0n;
  if (ledger) {
    if (index === ledger.windowIndex) { current = ledger.slashedCurrent; previous = ledger.slashedPrevious; }
    else if (index === ledger.windowIndex + 1n) previous = ledger.slashedCurrent;
  }
  const recent = current + previous;
  const cap = ((bondAmount + recent) * BigInt(MAX_SLASH_BPS_PER_PROPOSAL)) / BPS_DENOMINATOR;
  return cap > recent ? cap - recent : 0n;
}
/**
 * Whether execute_slash would cut a rate-based slash of `bps` today: such a proposal is executed by the slasher only
 * (anyone else gets `CapCutNeedsSlasher`), and one cut to zero takes nothing and does not delist.
 */
export function slashWouldBeCut(bondAmount: bigint, bps: number, ledger: Parameters<typeof slashCapRoom>[1], now: number | bigint, windowSeconds?: number): { cut: boolean; amount: bigint; uncapped: bigint } {
  const uncapped = slashAmount(bondAmount, bps);
  const room = slashCapRoom(bondAmount, ledger, now, windowSeconds);
  const amount = uncapped < room ? uncapped : room;
  return { cut: amount < uncapped, amount, uncapped };
}

/** The projection's host id: the host wallet's 32 bytes as 0x-hex (stable, case-insensitive, same shape as a hash). */
export const hostIdOf = (host: PublicKey | string) => toHex0x(new PublicKey(host).toBytes());

// ---- Accounts --------------------------------------------------------------------------------------------------------

export type BondConfig = { authority: PublicKey; slasher: PublicKey; guardian: PublicKey; usdcMint: PublicKey; refundPool: PublicKey; treasury: PublicKey; capacityClaimer: PublicKey; capacityRefund: PublicKey; minBond: bigint; unbondPeriod: bigint; disputeWindow: bigint; disputeBlock: bigint; paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint };
export function decodeBondConfig(data: Uint8Array): BondConfig | null {
  const r = bondIdl.decodeAccount<Raw>("BondConfig", data);
  if (!r) return null;
  return { authority: r.authority, slasher: r.slasher, guardian: r.guardian, usdcMint: r.usdc_mint, refundPool: r.refund_pool, treasury: r.treasury, capacityClaimer: r.capacity_claimer, capacityRefund: r.capacity_refund, minBond: r.min_bond, unbondPeriod: r.unbond_period, disputeWindow: r.dispute_window, disputeBlock: r.dispute_block, paused: r.paused, pausedUntil: r.paused_until, guardianPauseReadyAt: r.guardian_pause_ready_at };
}

export type HostBond = { host: PublicKey; amount: bigint; unbondAt: bigint; strikes: number; slashedTotal: bigint; openProposals: number; nextProposalId: bigint; delisted: boolean; ejected: boolean };
export function decodeHostBond(data: Uint8Array): HostBond | null {
  const r = bondIdl.decodeAccount<Raw>("HostBond", data);
  if (!r) return null;
  return { host: r.host, amount: r.amount, unbondAt: r.unbond_at, strikes: r.strikes, slashedTotal: r.slashed_total, openProposals: r.open_proposals, nextProposalId: r.next_proposal_id, delisted: r.delisted, ejected: r.ejected };
}

export type DisputeStatus = "None" | "Open" | "Upheld" | "Rejected";
export type SlashProposal = { bond: PublicKey; proposalId: bigint; evidenceHash: Uint8Array; reason: SlashReason; bps: number; fixedAmount: bigint; refundAmount: bigint; proposedAt: bigint; windowEnd: bigint; disputeStatus: DisputeStatus; disputedAt: bigint; executed: boolean; executedAmount: bigint; rentPayer: PublicKey; unblockAt: bigint };
export function decodeSlashProposal(data: Uint8Array): SlashProposal | null {
  const r = bondIdl.decodeAccount<Raw>("SlashProposal", data);
  if (!r) return null;
  return { bond: r.bond, proposalId: r.proposal_id, evidenceHash: r.evidence_hash, reason: r.reason, bps: r.bps, fixedAmount: r.fixed_amount, refundAmount: r.refund_amount, proposedAt: r.proposed_at, windowEnd: r.window_end, disputeStatus: r.dispute_status, disputedAt: r.disputed_at, executed: r.executed, executedAmount: r.executed_amount, rentPayer: r.rent_payer, unblockAt: r.unblock_at };
}

// ---- Events (names shared with src/network/bond-state.ts's projection) ------------------------------------------------

export type BondEventRecord = { event: string; args: Record<string, unknown> };

/**
 * Every event the trellis_bond program at `programId` emitted in a transaction's logs (lines another program logged are
 * not events of it), in order, as the host-bond projection consumes them. Hosts are
 * identified by `hostId` (hex of the host wallet) and proposals by `slashId` (the proposal PDA, base58); bond-level
 * events also carry `bond` so the projection can attribute proposals to hosts.
 */
export function bondEvents(programId: PublicKey | string, logs: readonly string[]): BondEventRecord[] {
  const out: BondEventRecord[] = [];
  for (const e of bondIdl.at(programId).events(logs)) {
    const d = e.data as Raw;
    const str = (v: unknown) => (v as bigint).toString();
    switch (e.name) {
      case "BondPosted": out.push({ event: "Bonded", args: { bond: d.bond.toBase58(), hostId: hostIdOf(d.host), operator: d.host.toBase58(), amount: str(d.amount), total: str(d.total) } }); break;
      case "UnbondRequested": out.push({ event: "UnbondRequested", args: { bond: d.bond.toBase58(), hostId: hostIdOf(d.host), availableAt: str(d.unbond_at) } }); break;
      case "UnbondCancelled": out.push({ event: "UnbondCancelled", args: { bond: d.bond.toBase58(), hostId: hostIdOf(d.host) } }); break;
      case "BondWithdrawn": out.push({ event: "Unbonded", args: { bond: d.bond.toBase58(), hostId: hostIdOf(d.host), to: d.host.toBase58(), amount: str(d.amount) } }); break;
      case "SlashProposed": out.push({ event: "SlashProposed", args: { bond: d.bond.toBase58(), slashId: d.proposal.toBase58(), proposalId: str(d.proposal_id), reason: slashReasonCode(d.reason), bps: d.bps, fixedAmount: str(d.fixed_amount), refundAmount: str(d.refund_amount), evidenceRoot: toHex0x(d.evidence_hash), executableAt: str(d.window_end) } }); break;
      case "SlashDisputed": out.push({ event: "SlashDisputed", args: { bond: d.bond.toBase58(), slashId: d.proposal.toBase58(), disputedAt: str(d.disputed_at) } }); break;
      case "DisputeResolved": out.push({ event: "DisputeResolved", args: { bond: d.bond.toBase58(), slashId: d.proposal.toBase58(), status: d.status } }); break;
      case "SlashExecuted": out.push({ event: "SlashExecuted", args: { bond: d.bond.toBase58(), slashId: d.proposal.toBase58(), reason: slashReasonCode(d.reason), amount: str(d.amount), toRefundPool: str(d.to_refund_pool), toTreasury: str(d.to_treasury), toCapacityRefund: str(d.to_capacity_refund), strikes: d.strikes, remainingBond: str(d.remaining_bond), delisted: SLASH_DELISTS(slashReasonCode(d.reason)) } }); break;
      case "ProposalClosed": out.push({ event: "ProposalClosed", args: { bond: d.bond.toBase58(), slashId: d.proposal.toBase58() } }); break;
      case "BondConfigUpdated": out.push({ event: "BondConfigUpdated", args: { authority: d.authority.toBase58(), slasher: d.slasher.toBase58(), guardian: d.guardian.toBase58(), minBond: str(d.min_bond) } }); break;
      case "BondPauseChanged": out.push({ event: "BondPauseChanged", args: { paused: d.paused, by: d.by.toBase58(), pausedUntil: str(d.paused_until) } }); break;
      default: break;
    }
  }
  return out;
}

// ---- Instructions ----------------------------------------------------------------------------------------------------

/** initialize_config(args) by the admin authority, which must be the program's upgrade authority (TR-13). Delays below the program's floors (72 h window, 7 d block, 14 d unbond) are refused. */
export function initializeConfigIx(programId: PublicKey, a: { authority: PublicKey; usdcMint: PublicKey; refundPool: PublicKey; treasury: PublicKey; capacityRefund: PublicKey; slasher: PublicKey; guardian: PublicKey; capacityClaimer: PublicKey; minBond?: bigint | null; unbondPeriod?: bigint | null; disputeWindow?: bigint | null; disputeBlock?: bigint | null }): TransactionInstruction {
  return bondAt(programId).instruction("initialize_config", { args: { slasher: a.slasher, guardian: a.guardian, capacity_claimer: a.capacityClaimer, min_bond: a.minBond ?? null, unbond_period: a.unbondPeriod ?? null, dispute_window: a.disputeWindow ?? null, dispute_block: a.disputeBlock ?? null } }, { authority: a.authority, usdc_mint: a.usdcMint, refund_pool: a.refundPool, treasury: a.treasury, capacity_refund: a.capacityRefund, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}

export type BondConfigChange = { newAuthority?: PublicKey | null; slasher?: PublicKey | null; guardian?: PublicKey | null; capacityClaimer?: PublicKey | null; minBond?: bigint | null; unbondPeriod?: bigint | null; disputeWindow?: bigint | null; disputeBlock?: bigint | null };
const configArgs = (a: BondConfigChange) => ({ new_authority: a.newAuthority ?? null, slasher: a.slasher ?? null, guardian: a.guardian ?? null, capacity_claimer: a.capacityClaimer ?? null, min_bond: a.minBond ?? null, unbond_period: a.unbondPeriod ?? null, dispute_window: a.disputeWindow ?? null, dispute_block: a.disputeBlock ?? null });
/**
 * update_config(args) by the authority: TIGHTENING ONLY, effective at once (a longer unbond period, dispute window or
 * dispute block). Roles, payout accounts, an authority hand-over, ANY change of the minimum bond and anything looser are
 * refused on chain with `RequiresTimelock`: use proposeConfigIx, wait 24 h, then resolveConfigIx(apply).
 */
export function updateConfigIx(programId: PublicKey, a: { authority: PublicKey } & BondConfigChange): TransactionInstruction {
  return bondAt(programId).instruction("update_config", { args: configArgs(a) }, { authority: a.authority });
}
/** propose_config(args): records any change, including replacement payout accounts, for the timelock. */
export function proposeConfigIx(programId: PublicKey, a: { authority: PublicKey; refundPool?: PublicKey | null; treasury?: PublicKey | null; capacityRefund?: PublicKey | null } & BondConfigChange): TransactionInstruction {
  return bondAt(programId).instruction("propose_config", { args: configArgs(a) }, { authority: a.authority, refund_pool: a.refundPool ?? null, treasury: a.treasury ?? null, capacity_refund: a.capacityRefund ?? null, system_program: SystemProgram.programId });
}
/** resolve_config(apply): the authority applies after the timelock and within 7 days of it (a new authority co-signs); only the authority cancels (anyone may clear an expired proposal). */
export function resolveConfigIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return bondAt(programId).instruction("resolve_config", { apply: a.apply }, { signer: a.signer, authority: a.authority, new_authority: a.newAuthority ?? null });
}

/** post_bond(amount): the host wallet signs; its USDC token account funds the bond's vault (created on first post). */
export function postBondIx(programId: PublicKey, a: { host: PublicKey; hostToken: PublicKey; mint: PublicKey; amount: bigint }): TransactionInstruction {
  return bondAt(programId).instruction("post_bond", { amount: a.amount }, { host: a.host, usdc_mint: a.mint, host_token: a.hostToken, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId });
}
export const requestUnbondIx = (programId: PublicKey, a: { host: PublicKey }) => bondAt(programId).instruction("request_unbond", {}, { host: a.host });
export const cancelUnbondIx = (programId: PublicKey, a: { host: PublicKey }) => bondAt(programId).instruction("cancel_unbond", {}, { host: a.host });
/** withdraw_bond(): after the unbond period, the host takes what is not locked behind open capacity commitments. */
export function withdrawBondIx(programId: PublicKey, a: { host: PublicKey; hostToken: PublicKey; mint: PublicKey }): TransactionInstruction {
  return bondAt(programId).instruction("withdraw_bond", {}, { host: a.host, usdc_mint: a.mint, host_token: a.hostToken, token_program: TOKEN_PROGRAM_ID });
}

/** propose_slash(proposal_id, evidence_hash, bps, reason_code, refund_amount) by the config's slasher. */
export function proposeSlashIx(programId: PublicKey, a: { slasher: PublicKey; host: PublicKey; proposalId: bigint; evidenceHash: Uint8Array; bps: number; reasonCode: number; refundAmount: bigint }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("propose_slash", { proposal_id: a.proposalId, evidence_hash: a.evidenceHash, bps: a.bps, reason_code: a.reasonCode, refund_amount: a.refundAmount }, { slasher: a.slasher, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId), system_program: SystemProgram.programId });
}

/**
 * execute_slash(): anyone cranks it after the window; funds go to the config's payout accounts. A rate-based slash is cut
 * to what the bond's cumulative cap leaves (50% per 30 days over all proposals); the cranker pays the slash ledger's rent
 * when the bond has none yet. A proposal the cap would cut today is refused (`CapCutNeedsSlasher`) unless `cranker` is the
 * config's slasher, so a host cannot crank its own proposal at the moment it takes nothing; a slash cut to zero neither
 * delists nor ejects (`slashWouldBeCut` tells in advance).
 */
export function executeSlashIx(programId: PublicKey, a: { cranker: PublicKey; host: PublicKey; proposalId: bigint; mint: PublicKey; refundPool: PublicKey; treasury: PublicKey; capacityRefund: PublicKey }): TransactionInstruction {
  const { bond, vault } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("execute_slash", {}, { cranker: a.cranker, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId), usdc_mint: a.mint, vault: vault!, refund_pool: a.refundPool, treasury: a.treasury, capacity_refund: a.capacityRefund, token_program: TOKEN_PROGRAM_ID });
}

export function disputeIx(programId: PublicKey, a: { host: PublicKey; proposalId: bigint }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("dispute", {}, { host: a.host, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId) });
}
export function resolveDisputeIx(programId: PublicKey, a: { authority: PublicKey; host: PublicKey; proposalId: bigint; upheld: boolean }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("resolve_dispute", { upheld: a.upheld }, { authority: a.authority, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId) });
}
/** void_proposal() by the authority: drops a proposal that has not executed (disputed or not); it can then never execute. */
export function voidProposalIx(programId: PublicKey, a: { authority: PublicKey; host: PublicKey; proposalId: bigint }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("void_proposal", {}, { authority: a.authority, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId) });
}
/** propose_reinstate() by the authority: step 1 of clearing `delisted` / `ejected` on a host's bond; applicable 24 h later, for 7 days. */
export function proposeReinstateIx(programId: PublicKey, a: { authority: PublicKey; host: PublicKey }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("propose_reinstate", {}, { authority: a.authority, bond: bond!, system_program: SystemProgram.programId });
}
/**
 * resolve_reinstate(apply): apply = true, by the authority after the timelock (refused with `ReinstateStale` when a slash
 * was executed against the bond since the proposal); false, the authority drops it, or anyone once it has expired.
 * `authority` is the config authority (it gets the proposal's rent back).
 */
export function resolveReinstateIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; host: PublicKey; apply: boolean }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("resolve_reinstate", { apply: a.apply }, { signer: a.signer, authority: a.authority, bond: bond! });
}
/** close_proposal(): only the account that paid the proposal's rent may close it (it signs), once executed or rejected. */
export function closeProposalIx(programId: PublicKey, a: { host: PublicKey; proposalId: bigint; rentPayer: PublicKey }): TransactionInstruction {
  const { bond } = bondPdas(programId, a.host);
  return bondAt(programId).instruction("close_proposal", {}, { rent_payer: a.rentPayer, bond: bond!, proposal: proposalPda(programId, bond!, a.proposalId) });
}
