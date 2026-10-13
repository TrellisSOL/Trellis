import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { IdlProgram, programDataAddress, le64, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_anchor.json";

// trellis_anchor (docs/Trellis_Backend.md §5.4), built from src/solana/idl/trellis_anchor.json. One ReceiptRoot per
// hour (unix seconds, multiple of 3600; a second post_root for the same hour fails at init), posted by the SignerSet's
// authority; SignerSet holds the current and previous receipt signing keys. A new key is never installed at once:
// propose_signer announces it, resolve_signer(true) installs it 24 h later (the outgoing one is kept as previous), and
// revoke_signer removes a key in one transaction (security review round 3).
// The router's running anchor index is not on chain: a root is found by the hour that closed its batch
// (`receiptRootHour`), which the anchors table maps an index to. Per-host receipt roots (§3) are HostRoot accounts,
// one per (provider id hash, hour), posted by the same authority with post_host_root(provider_id_hash, hour, root, count).
// PDA seeds: ["signer_set"], ["pending_signer"], ["receipt_root", hour LE], ["host_root", provider_id_hash, hour LE].
// Rent: each root is its own account; close_root / close_host_root return the rent once the hour is 400 days old, and
// an hour that old can no longer be posted. With ANCHOR_MODE=memo no account exists at all (src/solana/anchor-memo.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const ANCHOR_IDL = idl as unknown as TrellisIdl;
export const anchorIdl = new IdlProgram(ANCHOR_IDL);
export const anchorAt = (programId: PublicKey | string) => anchorIdl.at(programId);

export const ANCHOR_SEEDS = {
  signerSet: [Buffer.from("signer_set")],
  pendingSigner: [Buffer.from("pending_signer")],
  root: (hour: bigint | number) => [Buffer.from("receipt_root"), le64(hour)],
  hostRoot: (providerIdHash: Uint8Array, hour: bigint | number) => [Buffer.from("host_root"), Buffer.from(providerIdHash), le64(hour)],
};
export const SECONDS_PER_HOUR = 3600;

/** The on-chain hour of a batch that closes at `toTs` (exclusive): the hour containing its last second. */
export const receiptRootHour = (toTs: number | bigint) => { const t = Number(toTs); return Math.floor(Math.max(0, t - 1) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR; };

export function anchorPdas(programId: PublicKey) {
  const [signerSet] = PublicKey.findProgramAddressSync(ANCHOR_SEEDS.signerSet, programId);
  const [pendingSigner] = PublicKey.findProgramAddressSync(ANCHOR_SEEDS.pendingSigner, programId);
  return { signerSet, pendingSigner };
}
export const receiptRootPda = (programId: PublicKey, hour: bigint | number) => PublicKey.findProgramAddressSync(ANCHOR_SEEDS.root(hour), programId)[0];
export const hostRootPda = (programId: PublicKey, providerIdHash: Uint8Array, hour: bigint | number) => PublicKey.findProgramAddressSync(ANCHOR_SEEDS.hostRoot(providerIdHash, hour), programId)[0];

export type ReceiptRoot = { hour: bigint; root: Uint8Array; count: bigint; signer: PublicKey; postedAt: bigint };
export function decodeReceiptRoot(data: Uint8Array): ReceiptRoot | null {
  const r = anchorIdl.decodeAccount<Raw>("ReceiptRoot", data);
  if (!r) return null;
  return { hour: r.hour, root: r.root, count: r.count, signer: r.signer, postedAt: r.posted_at };
}

export type HostRoot = { providerIdHash: Uint8Array; hour: bigint; root: Uint8Array; count: bigint; signer: PublicKey; postedAt: bigint };
export function decodeHostRoot(data: Uint8Array): HostRoot | null {
  const r = anchorIdl.decodeAccount<Raw>("HostRoot", data);
  if (!r) return null;
  return { providerIdHash: r.provider_id_hash, hour: r.hour, root: r.root, count: r.count, signer: r.signer, postedAt: r.posted_at };
}

export type SignerSet = { authority: PublicKey; currentSigner: PublicKey; previousSigner: PublicKey; rotatedAt: bigint; rotationCount: bigint };
export function decodeSignerSet(data: Uint8Array): SignerSet | null {
  const r = anchorIdl.decodeAccount<Raw>("SignerSet", data);
  if (!r) return null;
  return { authority: r.authority, currentSigner: r.current_signer, previousSigner: r.previous_signer, rotatedAt: r.rotated_at, rotationCount: r.rotation_count };
}

/** A receipt signer waiting out the 24 h timelock (the ["pending_signer"] account); one at a time. */
export type PendingSigner = { newSigner: PublicKey; proposedAt: bigint; effectiveAt: bigint };
export function decodePendingSigner(data: Uint8Array): PendingSigner | null {
  const r = anchorIdl.decodeAccount<Raw>("PendingSigner", data);
  if (!r) return null;
  return { newSigner: r.new_signer, proposedAt: r.proposed_at, effectiveAt: r.effective_at };
}
/** Seconds a proposal stays applicable after it became effective (PROPOSAL_TTL of the mainnet build): 7 days. */
export const PROPOSAL_TTL_SECONDS = 7 * 24 * 3600;
/** Seconds between proposing a signer and the moment it can be installed (CONFIG_TIMELOCK of the mainnet build): 24 h. */
export const SIGNER_TIMELOCK_SECONDS = 24 * 3600;

export type SignerProposedEvent = { newSigner: PublicKey; effectiveAt: bigint; expiresAt: bigint };
export const signerProposedEvents = (programId: PublicKey | string, logs: readonly string[]): SignerProposedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("SignerProposed", logs).map((e) => ({ newSigner: e.new_signer, effectiveAt: e.effective_at, expiresAt: e.expires_at }));
export type SignerRotatedEvent = { previousSigner: PublicKey; currentSigner: PublicKey; rotatedAt: bigint; rotationCount: bigint };
export const signerRotatedEvents = (programId: PublicKey | string, logs: readonly string[]): SignerRotatedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("SignerRotated", logs).map((e) => ({ previousSigner: e.previous_signer, currentSigner: e.current_signer, rotatedAt: e.rotated_at, rotationCount: e.rotation_count }));
export type SignerRevokedEvent = { signer: PublicKey; wasCurrent: boolean; revokedAt: bigint };
export const signerRevokedEvents = (programId: PublicKey | string, logs: readonly string[]): SignerRevokedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("SignerRevoked", logs).map((e) => ({ signer: e.signer, wasCurrent: e.was_current, revokedAt: e.revoked_at }));
export type SignerProposalCancelledEvent = { newSigner: PublicKey; by: PublicKey };
export const signerProposalCancelledEvents = (programId: PublicKey | string, logs: readonly string[]): SignerProposalCancelledEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("SignerProposalCancelled", logs).map((e) => ({ newSigner: e.new_signer, by: e.by }));

export type RootPostedEvent = { hour: bigint; root: Uint8Array; count: bigint; signer: PublicKey; postedAt: bigint };
export const rootPostedEvents = (programId: PublicKey | string, logs: readonly string[]): RootPostedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("RootPosted", logs).map((e) => ({ hour: e.hour, root: e.root, count: e.count, signer: e.signer, postedAt: e.posted_at }));

export type RootClosedEvent = { hour: bigint; root: Uint8Array; count: bigint; postedAt: bigint };
export const rootClosedEvents = (programId: PublicKey | string, logs: readonly string[]): RootClosedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("RootClosed", logs).map((e) => ({ hour: e.hour, root: e.root, count: e.count, postedAt: e.posted_at }));

export type HostRootPostedEvent = { providerIdHash: Uint8Array; hour: bigint; root: Uint8Array; count: bigint; signer: PublicKey; postedAt: bigint };
export const hostRootPostedEvents = (programId: PublicKey | string, logs: readonly string[]): HostRootPostedEvent[] => anchorIdl.at(programId).eventsNamed<Raw>("HostRootPosted", logs).map((e) => ({ providerIdHash: e.provider_id_hash, hour: e.hour, root: e.root, count: e.count, signer: e.signer, postedAt: e.posted_at }));

/**
 * init_signer_set(authority, initial_signer): `payer` (default: `authority`) must be the program's upgrade authority
 * (TR-13); `authority` is the key that will post roots and rotate the signer and need not be the payer.
 */
export function initSignerSetIx(programId: PublicKey, a: { authority: PublicKey; initialSigner: PublicKey; payer?: PublicKey }): TransactionInstruction {
  return anchorAt(programId).instruction("init_signer_set", { authority: a.authority, initial_signer: a.initialSigner }, { payer: a.payer ?? a.authority, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}

/** post_root(hour, root, count) by the SignerSet authority. */
export function postRootIx(programId: PublicKey, a: { authority: PublicKey; hour: bigint | number; root: Uint8Array; count: bigint | number }): TransactionInstruction {
  const hour = BigInt(a.hour);
  if (hour < 0n || hour % BigInt(SECONDS_PER_HOUR) !== 0n) throw new RangeError("hour must be unix seconds on an hour boundary");
  return anchorAt(programId).instruction("post_root", { hour, root: a.root, count: BigInt(a.count) }, { authority: a.authority, system_program: SystemProgram.programId });
}

/** post_host_root(provider_id_hash, hour, root, count) by the SignerSet authority: one HostRoot per (host, hour). */
export function postHostRootIx(programId: PublicKey, a: { authority: PublicKey; providerIdHash: Uint8Array; hour: bigint | number; root: Uint8Array; count: bigint | number }): TransactionInstruction {
  const hour = BigInt(a.hour);
  if (hour < 0n || hour % BigInt(SECONDS_PER_HOUR) !== 0n) throw new RangeError("hour must be unix seconds on an hour boundary");
  if (a.providerIdHash.length !== 32) throw new RangeError("provider id hash must be 32 bytes");
  return anchorAt(programId).instruction("post_host_root", { provider_id_hash: a.providerIdHash, hour, root: a.root, count: BigInt(a.count) }, { authority: a.authority, system_program: SystemProgram.programId });
}

/** The root of `hour` may be closed (and can no longer be posted) from this unix time on: the hour's end plus the retention. */
export const ROOT_RETENTION_SECONDS = 400 * 24 * 3600;
export const rootClosableAt = (hour: bigint | number, retentionSeconds = ROOT_RETENTION_SECONDS) => Number(hour) + SECONDS_PER_HOUR + retentionSeconds;

/**
 * close_root(hour) by the SignerSet authority: returns the rent of a ReceiptRoot whose hour ended at least 400 days ago
 * (ROOT_RETENTION, compiled into the program). The hour can never be posted again; the closed root is verified from the
 * transaction that posted it (src/solana/anchor-memo.ts `verifyProgramPost`).
 */
export function closeRootIx(programId: PublicKey, a: { authority: PublicKey; hour: bigint | number }): TransactionInstruction {
  return anchorAt(programId).instruction("close_root", { hour: BigInt(a.hour) }, { authority: a.authority });
}
/** close_host_root(provider_id_hash, hour) by the SignerSet authority: the same for one host's root. */
export function closeHostRootIx(programId: PublicKey, a: { authority: PublicKey; providerIdHash: Uint8Array; hour: bigint | number }): TransactionInstruction {
  if (a.providerIdHash.length !== 32) throw new RangeError("provider id hash must be 32 bytes");
  return anchorAt(programId).instruction("close_host_root", { provider_id_hash: a.providerIdHash, hour: BigInt(a.hour) }, { authority: a.authority });
}

/**
 * build_profile(): takes no account and returns the floors compiled into the deployed binary (profile 0 = the mainnet
 * build, 1 = the `devnet` cargo feature). Simulate it and read the return data with `decodeBuildProfile`.
 */
export function buildProfileIx(programId: PublicKey): TransactionInstruction {
  return anchorAt(programId).instruction("build_profile", {}, {});
}
export type BuildProfile = { profile: number; devnet: boolean; configTimelock: bigint; rootRetention: bigint; proposalTtl: bigint };
/** The return data of build_profile: u8 profile | i64 config_timelock | i64 root_retention | i64 proposal_ttl. */
export function decodeBuildProfile(data: Uint8Array): BuildProfile | null {
  const p = anchorIdl.decodeBuildProfile(data);
  if (!p || p.floors.rootRetention === undefined || p.floors.proposalTtl === undefined) return null;
  return { profile: p.profile, devnet: p.devnet, configTimelock: p.configTimelock, rootRetention: p.floors.rootRetention, proposalTtl: p.floors.proposalTtl };
}
/** The mainnet values a default build returns. */
export const MAINNET_BUILD_PROFILE = { profile: 0, configTimelock: 86_400n, rootRetention: BigInt(ROOT_RETENTION_SECONDS), proposalTtl: 604_800n } as const;

/**
 * propose_signer(new_signer) by the SignerSet authority: step 1 of a rotation. Nothing changes in the set; the key can be
 * installed with resolveSignerIx(apply) once the 24 h timelock has elapsed, and for 7 days after that. One at a time.
 */
export function proposeSignerIx(programId: PublicKey, a: { authority: PublicKey; newSigner: PublicKey }): TransactionInstruction {
  return anchorAt(programId).instruction("propose_signer", { new_signer: a.newSigner }, { authority: a.authority, system_program: SystemProgram.programId });
}
/**
 * resolve_signer(apply): apply = true, by the authority after the timelock: the proposed key becomes current_signer and
 * the outgoing one previous_signer (old receipts stay verifiable). apply = false: the authority drops the proposal;
 * anyone may clear an expired one. `authority` is the SignerSet authority (it gets the proposal's rent back).
 */
export function resolveSignerIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean }): TransactionInstruction {
  return anchorAt(programId).instruction("resolve_signer", { apply: a.apply }, { signer: a.signer, authority: a.authority });
}
/** revoke_signer(signer) by the authority: removes the current or the previous signer from the set, at once. */
export function revokeSignerIx(programId: PublicKey, a: { authority: PublicKey; signer: PublicKey }): TransactionInstruction {
  return anchorAt(programId).instruction("revoke_signer", { signer: a.signer }, { authority: a.authority });
}

/** transfer_authority(new_authority): step 1 of a hand-over. The new authority takes over by signing resolveAuthorityTransferIx(accept) after the 24 h timelock. */
export function transferAuthorityIx(programId: PublicKey, a: { authority: PublicKey; newAuthority: PublicKey }): TransactionInstruction {
  return anchorAt(programId).instruction("transfer_authority", { new_authority: a.newAuthority }, { authority: a.authority, system_program: SystemProgram.programId });
}
/** resolve_authority_transfer(accept): accept = true, signed by the new authority after the timelock; false, by the current authority to withdraw it (by anyone once it has expired). */
export function resolveAuthorityTransferIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; accept: boolean }): TransactionInstruction {
  return anchorAt(programId).instruction("resolve_authority_transfer", { accept: a.accept }, { signer: a.signer, authority: a.authority });
}
