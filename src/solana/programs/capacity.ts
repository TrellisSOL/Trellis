import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { IdlProgram, programDataAddress, le64, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_capacity.json";

// trellis_capacity (docs/Trellis_Backend.md §5.6), built from src/solana/idl/trellis_capacity.json. Capacity
// commitments backed by a host's trellis_bond HostBond, sold as Bushel lots and settled by shortfall claims filed into
// trellis_bond through the ["bond_claimer"] PDA; the HVX index feed is written by hvx_authority. A commitment keeps the
// grade price it was made at: its lots together are worth at most its value, its claims at most that value too, and
// trellis_bond pays each claim out of what the commitment locked (security review round 3, R3-16).
// PDA seeds: ["config"], ["host", host], ["commitment", host, commitment_id LE], ["lot", commitment, lot_id LE(u32)],
// ["bond_claimer"].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const CAPACITY_IDL = idl as unknown as TrellisIdl;
export const capacityIdl = new IdlProgram(CAPACITY_IDL);
export const capacityAt = (programId: PublicKey | string) => capacityIdl.at(programId);

export const CAPACITY_SEEDS = {
  config: [Buffer.from("config")],
  host: (host: PublicKey) => [Buffer.from("host"), host.toBuffer()],
  commitment: (host: PublicKey, id: bigint | number) => [Buffer.from("commitment"), host.toBuffer(), le64(id)],
  bondClaimer: [Buffer.from("bond_claimer")],
};
export const capacityConfigPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(CAPACITY_SEEDS.config, programId)[0];
export const hostCapacityPda = (programId: PublicKey, host: PublicKey) => PublicKey.findProgramAddressSync(CAPACITY_SEEDS.host(host), programId)[0];
export const commitmentPda = (programId: PublicKey, host: PublicKey, id: bigint | number) => PublicKey.findProgramAddressSync(CAPACITY_SEEDS.commitment(host, id), programId)[0];
/** The PDA trellis_bond's config must name as `capacity_claimer`. */
export const bondClaimerPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(CAPACITY_SEEDS.bondClaimer, programId)[0];

export type CapacityConfig = { authority: PublicKey; saleAuthority: PublicKey; hvxAuthority: PublicKey; guardian: PublicKey; gradePrices: bigint[]; maxOutstandingValue: bigint; outstandingValue: bigint; paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint };
export function decodeCapacityConfig(data: Uint8Array): CapacityConfig | null {
  const r = capacityIdl.decodeAccount<Raw>("CapacityConfig", data);
  if (!r) return null;
  return { authority: r.authority, saleAuthority: r.sale_authority, hvxAuthority: r.hvx_authority, guardian: r.guardian, gradePrices: r.grade_prices, maxOutstandingValue: r.max_outstanding_value, outstandingValue: r.outstanding_value, paused: r.paused, pausedUntil: r.paused_until, guardianPauseReadyAt: r.guardian_pause_ready_at };
}

/** The issuance cap can never be set above this while the programs are unaudited (compiled into the program): 250,000 USDC. */
export const MAX_OUTSTANDING_VALUE_CAP = 250_000_000_000n;
/** No grade price can be set above this (compiled into the program): 10,000 USDC per Bushel. */
export const MAX_GRADE_PRICE = 10_000_000_000n;

/**
 * `pricePerBushel` is the grade price fixed when the host committed (0 on a commitment from before the field existed:
 * nothing more is sold against it), `paidTotal` the sum of its lots' price_paid and `claimedValue` the sum of the claims
 * filed for it; both stay at or below `value`.
 */
export type CapacityCommitment = { host: PublicKey; hostBond: PublicKey; commitmentId: bigint; grade: number; tokens: bigint; soldTokens: bigint; windowStart: bigint; windowEnd: bigint; value: bigint; status: "Open" | "ShortfallReported" | "Settled"; unservedTokens: bigint; lotsSold: number; pricePerBushel: bigint; paidTotal: bigint; claimedValue: bigint };
export function decodeCapacityCommitment(data: Uint8Array): CapacityCommitment | null {
  const r = capacityIdl.decodeAccount<Raw>("CapacityCommitment", data);
  if (!r) return null;
  return { host: r.host, hostBond: r.host_bond, commitmentId: r.commitment_id, grade: r.grade, tokens: r.tokens, soldTokens: r.sold_tokens, windowStart: r.window_start, windowEnd: r.window_end, value: r.value, status: r.status, unservedTokens: r.unserved_tokens, lotsSold: r.lots_sold, pricePerBushel: r.price_per_bushel ?? 0n, paidTotal: r.paid_total ?? 0n, claimedValue: r.claimed_value ?? 0n };
}

/** initialize_config(args) by the admin authority, which must be the program's upgrade authority (TR-13). */
export function initializeConfigIx(programId: PublicKey, a: { authority: PublicKey; saleAuthority: PublicKey; hvxAuthority: PublicKey; guardian: PublicKey; gradePrices: [bigint, bigint, bigint]; maxOutstandingValue?: bigint | null }): TransactionInstruction {
  return capacityAt(programId).instruction("initialize_config", { args: { sale_authority: a.saleAuthority, hvx_authority: a.hvxAuthority, guardian: a.guardian, grade_prices: a.gradePrices, max_outstanding_value: a.maxOutstandingValue ?? null } }, { authority: a.authority, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}

export type CapacityConfigChange = { newAuthority?: PublicKey | null; saleAuthority?: PublicKey | null; hvxAuthority?: PublicKey | null; guardian?: PublicKey | null; gradePrices?: [bigint, bigint, bigint] | null; maxOutstandingValue?: bigint | null };
const configArgs = (a: CapacityConfigChange) => ({ new_authority: a.newAuthority ?? null, sale_authority: a.saleAuthority ?? null, hvx_authority: a.hvxAuthority ?? null, guardian: a.guardian ?? null, grade_prices: a.gradePrices ?? null, max_outstanding_value: a.maxOutstandingValue ?? null });
/** update_config(args): tightening only (a lower issuance cap), effective at once; anything else needs proposeConfigIx + the 24 h timelock. */
export function updateConfigIx(programId: PublicKey, a: { authority: PublicKey } & CapacityConfigChange): TransactionInstruction {
  return capacityAt(programId).instruction("update_config", { args: configArgs(a) }, { authority: a.authority });
}
export function proposeConfigIx(programId: PublicKey, a: { authority: PublicKey } & CapacityConfigChange): TransactionInstruction {
  return capacityAt(programId).instruction("propose_config", { args: configArgs(a) }, { authority: a.authority, system_program: SystemProgram.programId });
}
export function resolveConfigIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return capacityAt(programId).instruction("resolve_config", { apply: a.apply }, { signer: a.signer, authority: a.authority, new_authority: a.newAuthority ?? null });
}
/** The bond's ["slash_ledger", bond] account: trellis_bond reads the claims still open against the bond from it. */
export const slashLedgerOf = (bondProgramId: PublicKey, hostBond: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("slash_ledger"), hostBond.toBuffer()], bondProgramId)[0];
/** The trellis_bond accounts a commitment's lock lives in: the bond config, the host's bond and its ["lock", bond] account. */
export function bondLockAccounts(bondProgramId: PublicKey, hostBond: PublicKey) {
  return { bond_config: PublicKey.findProgramAddressSync([Buffer.from("config")], bondProgramId)[0], host_bond: hostBond, bond_lock: PublicKey.findProgramAddressSync([Buffer.from("lock"), hostBond.toBuffer()], bondProgramId)[0], bond_program: bondProgramId };
}
/** release_commitment(): anyone, once window_end + the 14-day claim period has passed: settles the commitment and frees its bond lock. */
export function releaseCommitmentIx(programId: PublicKey, bondProgramId: PublicKey, a: { commitment: PublicKey; host: PublicKey; hostBond: PublicKey }): TransactionInstruction {
  return capacityAt(programId).instruction("release_commitment", {}, { commitment: a.commitment, host_capacity: hostCapacityPda(programId, a.host), ...bondLockAccounts(bondProgramId, a.hostBond) });
}

/** Bytes of a CapacityCommitment in the current layout; a shorter account was written by an earlier build (migrateCommitmentIx). */
export const commitmentAccountSize = () => capacityIdl.accountSize("CapacityCommitment");
/** migrate_commitment(): grows a commitment created before the price, paid and claimed fields existed. Anyone may pay; works once per commitment. */
export function migrateCommitmentIx(programId: PublicKey, a: { payer: PublicKey; commitment: PublicKey }): TransactionInstruction {
  return capacityAt(programId).instruction("migrate_commitment", {}, { payer: a.payer, commitment: a.commitment, system_program: SystemProgram.programId });
}

/**
 * commit_capacity(args) by the host: the commitment's value is checked against the host's bond and LOCKED in it
 * (trellis_bond::lock_bond) until the commitment is settled. lock_bond refuses a lock the bond does not cover on top of
 * what is already locked and of every claim still open against it (RR-07). The window is at most 90 days long, ending within 180 days.
 */
export function commitCapacityIx(programId: PublicKey, bondProgramId: PublicKey, a: { host: PublicKey; commitmentId: bigint; grade: number; tokens: bigint; windowStart: bigint; windowEnd: bigint }): TransactionInstruction {
  const hostBond = PublicKey.findProgramAddressSync([Buffer.from("bond"), a.host.toBuffer()], bondProgramId)[0];
  return capacityAt(programId).instruction("commit_capacity", { args: { commitment_id: a.commitmentId, grade: a.grade, tokens: a.tokens, window_start: a.windowStart, window_end: a.windowEnd } }, { host: a.host, ...bondLockAccounts(bondProgramId, hostBond), slash_ledger: slashLedgerOf(bondProgramId, hostBond), system_program: SystemProgram.programId });
}

/** publish_hvx(grade, hour, usd_per_mtoken, thin) by the HVX authority; `feed` is the caller's feed account. `hour` is the unix hour (seconds / 3600); the program refuses one ahead of the chain clock's hour or below the feed's. */
export function publishHvxIx(programId: PublicKey, a: { hvxAuthority: PublicKey; feed: PublicKey; grade: number; hour: bigint; usdPerMtoken: bigint; thin: boolean }): TransactionInstruction {
  return capacityAt(programId).instruction("publish_hvx", { grade: a.grade, hour: a.hour, usd_per_mtoken: a.usdPerMtoken, thin: a.thin }, { hvx_authority: a.hvxAuthority, feed: a.feed, system_program: SystemProgram.programId });
}
