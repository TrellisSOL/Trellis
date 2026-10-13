import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { IdlProgram, programDataAddress, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_measurements.json";

// trellis_measurements (docs/Trellis_Backend.md §3.2), built from src/solana/idl/trellis_measurements.json. The
// measurement registry: an allow-list of 32-byte digests, one Measurement account per (kind, digest), written by the
// Registry's authority (a Squads 2-of-3 in production). An entry is never closed: revoke stamps revoked_at, register on
// an existing entry fails at init (revoked or not), and only reinstate clears a revocation. The program holds no funds.
// Adding to the allow-list takes a day (security review round 3): propose_measurement / propose_reinstate announce an
// entry in a PendingMeasurement account, and register / reinstate apply it once the 24 h timelock has elapsed (and
// within 7 days of that). revoke is immediate. Until a proposal is applied the allow-list is unchanged.
// PDA seeds: ["registry"], ["measurement", [kind], digest], ["pending_measurement", [kind], digest].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const MEASUREMENTS_IDL = idl as unknown as TrellisIdl;
export const measurementsIdl = new IdlProgram(MEASUREMENTS_IDL);
export const measurementsAt = (programId: PublicKey | string) => measurementsIdl.at(programId);

/** Measurement kinds in the program's order: the index is the on-chain `kind: u8`. */
export const MEASUREMENT_KINDS = ["model_digest", "compose_hash", "os_image", "sidecar_source"] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export const MAX_LABEL_BYTES = 64;

/** The on-chain code of a kind (by name or code); throws on anything else. */
export function kindCode(kind: MeasurementKind | number): number {
  const code = typeof kind === "number" ? kind : MEASUREMENT_KINDS.indexOf(kind);
  if (!Number.isInteger(code) || code < 0 || code >= MEASUREMENT_KINDS.length) throw new RangeError("unknown measurement kind");
  return code;
}

/** Revocation reasons the program's `reason_code` carries (in the MeasurementRevoked event only). */
export const REVOKE_REASONS = ["unspecified", "superseded", "vulnerable", "compromised", "policy_change"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const MEASUREMENTS_SEEDS = {
  registry: [Buffer.from("registry")],
  measurement: (kind: MeasurementKind | number, digest: Uint8Array) => [Buffer.from("measurement"), Buffer.from([kindCode(kind)]), Buffer.from(digest)],
  pendingMeasurement: (kind: MeasurementKind | number, digest: Uint8Array) => [Buffer.from("pending_measurement"), Buffer.from([kindCode(kind)]), Buffer.from(digest)],
};
export const registryPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(MEASUREMENTS_SEEDS.registry, programId)[0];
export function measurementPda(programId: PublicKey, kind: MeasurementKind | number, digest: Uint8Array): PublicKey {
  if (digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return PublicKey.findProgramAddressSync(MEASUREMENTS_SEEDS.measurement(kind, digest), programId)[0];
}

/** The proposal account of one (kind, digest): a registration or a reinstatement waiting out the timelock. */
export function pendingMeasurementPda(programId: PublicKey, kind: MeasurementKind | number, digest: Uint8Array): PublicKey {
  if (digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return PublicKey.findProgramAddressSync(MEASUREMENTS_SEEDS.pendingMeasurement(kind, digest), programId)[0];
}
/** Seconds between a proposal and the moment it can be applied (CONFIG_TIMELOCK of the mainnet build): 24 h. */
export const MEASUREMENT_TIMELOCK_SECONDS = 24 * 3600;
/** Seconds a proposal stays applicable after that (PROPOSAL_TTL of the mainnet build): 7 days. */
export const MEASUREMENT_PROPOSAL_TTL_SECONDS = 7 * 24 * 3600;

export type PendingMeasurement = { kind: MeasurementKind; kindCode: number; digest: Uint8Array; label: string; policyVersion: number; reinstate: boolean; proposedAt: bigint; effectiveAt: bigint };
export function decodePendingMeasurement(data: Uint8Array): PendingMeasurement | null {
  const r = measurementsIdl.decodeAccount<Raw>("PendingMeasurement", data);
  if (!r) return null;
  const kind = MEASUREMENT_KINDS[r.kind as number];
  if (!kind) return null;
  return { kind, kindCode: r.kind, digest: r.digest, label: r.label, policyVersion: r.policy_version, reinstate: r.reinstate, proposedAt: r.proposed_at, effectiveAt: r.effective_at };
}

export type Registry = { authority: PublicKey; registered: bigint; revoked: bigint };
export function decodeRegistry(data: Uint8Array): Registry | null {
  const r = measurementsIdl.decodeAccount<Raw>("Registry", data);
  if (!r) return null;
  return { authority: r.authority, registered: r.registered, revoked: r.revoked };
}

export type Measurement = { kind: MeasurementKind; kindCode: number; digest: Uint8Array; label: string; policyVersion: number; registeredAt: bigint; revokedAt: bigint | null };
export function decodeMeasurement(data: Uint8Array): Measurement | null {
  const r = measurementsIdl.decodeAccount<Raw>("Measurement", data);
  if (!r) return null;
  const kind = MEASUREMENT_KINDS[r.kind as number];
  if (!kind) return null;
  return { kind, kindCode: r.kind, digest: r.digest, label: r.label, policyVersion: r.policy_version, registeredAt: r.registered_at, revokedAt: r.revoked_at ?? null };
}

export type MeasurementRegisteredEvent = { kind: number; digest: Uint8Array; label: string; policyVersion: number; registeredAt: bigint };
export const measurementRegisteredEvents = (programId: PublicKey | string, logs: readonly string[]): MeasurementRegisteredEvent[] =>
  measurementsIdl.at(programId).eventsNamed<Raw>("MeasurementRegistered", logs).map((e) => ({ kind: e.kind, digest: e.digest, label: e.label, policyVersion: e.policy_version, registeredAt: e.registered_at }));

export type MeasurementRevokedEvent = { kind: number; digest: Uint8Array; reasonCode: number; revokedAt: bigint };
export const measurementRevokedEvents = (programId: PublicKey | string, logs: readonly string[]): MeasurementRevokedEvent[] =>
  measurementsIdl.at(programId).eventsNamed<Raw>("MeasurementRevoked", logs).map((e) => ({ kind: e.kind, digest: e.digest, reasonCode: e.reason_code, revokedAt: e.revoked_at }));

export type MeasurementReinstatedEvent = { kind: number; digest: Uint8Array; reinstatedAt: bigint };
export const measurementReinstatedEvents = (programId: PublicKey | string, logs: readonly string[]): MeasurementReinstatedEvent[] =>
  measurementsIdl.at(programId).eventsNamed<Raw>("MeasurementReinstated", logs).map((e) => ({ kind: e.kind, digest: e.digest, reinstatedAt: e.reinstated_at }));

export type MeasurementProposedEvent = { kind: number; digest: Uint8Array; label: string; policyVersion: number; reinstate: boolean; effectiveAt: bigint; expiresAt: bigint };
export const measurementProposedEvents = (programId: PublicKey | string, logs: readonly string[]): MeasurementProposedEvent[] =>
  measurementsIdl.at(programId).eventsNamed<Raw>("MeasurementProposed", logs).map((e) => ({ kind: e.kind, digest: e.digest, label: e.label, policyVersion: e.policy_version, reinstate: e.reinstate, effectiveAt: e.effective_at, expiresAt: e.expires_at }));

export type MeasurementProposalCancelledEvent = { kind: number; digest: Uint8Array; reinstate: boolean; by: PublicKey };
export const measurementProposalCancelledEvents = (programId: PublicKey | string, logs: readonly string[]): MeasurementProposalCancelledEvent[] =>
  measurementsIdl.at(programId).eventsNamed<Raw>("MeasurementProposalCancelled", logs).map((e) => ({ kind: e.kind, digest: e.digest, reinstate: e.reinstate, by: e.by }));

/** init_registry(authority): `payer` must be the program's upgrade authority (TR-13); `authority` is the key that will register and revoke. */
export function initRegistryIx(programId: PublicKey, a: { payer: PublicKey; authority: PublicKey }): TransactionInstruction {
  return measurementsAt(programId).instruction("init_registry", { authority: a.authority }, { payer: a.payer, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}

/**
 * propose_measurement(kind, digest, label, policy_version) by the registry authority: step 1 of a registration. The
 * allow-list does not change; registerIx adds the entry once the 24 h timelock has elapsed. Refused when the entry exists
 * (live or revoked) or a proposal for it is already pending.
 */
export function proposeMeasurementIx(programId: PublicKey, a: { authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array; label: string; policyVersion: number }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  if (Buffer.byteLength(a.label, "utf8") > MAX_LABEL_BYTES) throw new RangeError(`measurement label must be at most ${MAX_LABEL_BYTES} bytes`);
  if (!Number.isInteger(a.policyVersion) || a.policyVersion < 0 || a.policyVersion > 0xffff_ffff) throw new RangeError("policy version must be a u32");
  return measurementsAt(programId).instruction("propose_measurement", { kind: kindCode(a.kind), digest: a.digest, label: a.label, policy_version: a.policyVersion }, { authority: a.authority, system_program: SystemProgram.programId });
}

/** register(kind, digest) by the registry authority, after the timelock: the proposed entry goes on the allow-list with the label and policy version that were announced. */
export function registerIx(programId: PublicKey, a: { authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return measurementsAt(programId).instruction("register", { kind: kindCode(a.kind), digest: a.digest }, { authority: a.authority, system_program: SystemProgram.programId });
}

/** revoke(kind, digest, reason_code) by the registry authority: the entry stays, stamped with the revocation time. */
export function revokeIx(programId: PublicKey, a: { authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array; reasonCode: number }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  if (!Number.isInteger(a.reasonCode) || a.reasonCode < 0 || a.reasonCode > 255) throw new RangeError("reason code must be a u8");
  return measurementsAt(programId).instruction("revoke", { kind: kindCode(a.kind), digest: a.digest, reason_code: a.reasonCode }, { authority: a.authority });
}

/** propose_reinstate(kind, digest) by the registry authority: step 1 of a reinstatement; the entry stays revoked until reinstateIx, 24 h later. */
export function proposeReinstateIx(programId: PublicKey, a: { authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return measurementsAt(programId).instruction("propose_reinstate", { kind: kindCode(a.kind), digest: a.digest }, { authority: a.authority, system_program: SystemProgram.programId });
}

/** reinstate(kind, digest) by the registry authority, after the timelock of its proposal: the only way a revoked entry is accepted again. */
export function reinstateIx(programId: PublicKey, a: { authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return measurementsAt(programId).instruction("reinstate", { kind: kindCode(a.kind), digest: a.digest }, { authority: a.authority });
}

/**
 * cancel_measurement_proposal(kind, digest): the registry authority drops a pending registration or reinstatement; anyone
 * may clear one that has expired. `authority` is the registry authority (it gets the proposal's rent back).
 */
export function cancelMeasurementProposalIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; kind: MeasurementKind | number; digest: Uint8Array }): TransactionInstruction {
  if (a.digest.length !== 32) throw new RangeError("measurement digest must be 32 bytes");
  return measurementsAt(programId).instruction("cancel_measurement_proposal", { kind: kindCode(a.kind), digest: a.digest }, { signer: a.signer, authority: a.authority });
}

/** transfer_authority(new_authority): step 1 of a hand-over. The new authority takes over by signing resolveAuthorityTransferIx(accept) after the 24 h timelock. */
export function transferAuthorityIx(programId: PublicKey, a: { authority: PublicKey; newAuthority: PublicKey }): TransactionInstruction {
  return measurementsAt(programId).instruction("transfer_authority", { new_authority: a.newAuthority }, { authority: a.authority, system_program: SystemProgram.programId });
}
/** resolve_authority_transfer(accept): accept = true, signed by the new authority after the timelock; false, by the current authority to withdraw it. */
export function resolveAuthorityTransferIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; accept: boolean }): TransactionInstruction {
  return measurementsAt(programId).instruction("resolve_authority_transfer", { accept: a.accept }, { signer: a.signer, authority: a.authority });
}
