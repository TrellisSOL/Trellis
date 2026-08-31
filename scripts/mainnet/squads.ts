// The little of Squads Protocol v4 the handover needs, read-only: the vault address of a multisig and the multisig
// account's threshold, time lock, config authority and members, and the judgement of that account against what the
// owner configured (members, threshold, time lock). Nothing here builds a Squads transaction; proposals are made and approved
// in the Squads app or CLI by the members.
//
// Layout of the `Multisig` account (squads-protocol/v4, programs/squads_multisig_program/src/state/multisig.rs), after the
// 8-byte Anchor discriminator: create_key Pubkey | config_authority Pubkey | threshold u16 | time_lock u32 |
// transaction_index u64 | stale_transaction_index u64 | rent_collector Option<Pubkey> | bump u8 | members Vec<Member>,
// with Member = key Pubkey | permissions u8 (bit 0 initiate, bit 1 vote, bit 2 execute).
// Vault PDA: ["multisig", multisig, "vault", [index]] under the Squads program; index 0 is the default vault.
//
// And, to tell a multisig that has EXECUTED a vault transaction from one that has only created some (R4-29), two more
// accounts per transaction index (squads-protocol/v4, state/proposal.rs and state/vault_transaction.rs):
//   transaction PDA ["multisig", multisig, "transaction", index u64 LE]; a `VaultTransaction` is, after the
//     discriminator: multisig Pubkey | creator Pubkey | index u64 | bump u8 | vault_index u8 | ...
//   proposal PDA    [..., "proposal"]; a `Proposal` is: multisig Pubkey | transaction_index u64 | status | bump u8 |
//     approved Vec<Pubkey> | rejected | cancelled, with status an enum of one byte and, except for the deprecated
//     variant 4, an i64 timestamp: 0 Draft, 1 Active, 2 Rejected, 3 Approved, 4 Executing, 5 Executed, 6 Cancelled.
// Like the Multisig layout, these are read from Squads' public source and checked against this kit's own encoders (the
// rehearsal's fixtures), never against the real program: compare what the kit prints with the Squads app.
import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction, type AccountMeta, type Connection } from "@solana/web3.js";
import type { Mode } from "./lib.ts";
import { SQUADS_V4_PROGRAM } from "./params.ts";

export const SQUADS_PROGRAM_ID = new PublicKey(SQUADS_V4_PROGRAM);
/** How long a pause holds on the mainnet build (PAUSE_TTL; scripts/mainnet/plan.ts MAINNET_PAUSE_TTL_SECONDS is the same number). */
const PAUSE_TTL_SECONDS = 72 * 3_600;
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const MULTISIG_DISCRIMINATOR = discriminator("Multisig");
const PROPOSAL_DISCRIMINATOR = discriminator("Proposal");
const VAULT_TRANSACTION_DISCRIMINATOR = discriminator("VaultTransaction");
const PROPOSAL_EXECUTED = 5;
/** How many of a multisig's latest transactions are looked at for an executed vault transaction. */
export const EXECUTED_SCAN = 50;

export const vaultPda = (multisig: PublicKey, index = 0) =>
  PublicKey.findProgramAddressSync([Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("vault"), Buffer.from([index])], SQUADS_PROGRAM_ID)[0];

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
/** The transaction account of one index of a multisig, and its proposal. */
export function transactionPdas(multisig: PublicKey, index: bigint): { transaction: PublicKey; proposal: PublicKey } {
  const seeds = [Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("transaction"), u64le(index)];
  return { transaction: PublicKey.findProgramAddressSync(seeds, SQUADS_PROGRAM_ID)[0], proposal: PublicKey.findProgramAddressSync([...seeds, Buffer.from("proposal")], SQUADS_PROGRAM_ID)[0] };
}

export type Member = { key: string; initiate: boolean; vote: boolean; execute: boolean };
/** A vault transaction that was approved and executed: what shows that the members can make the vault sign. */
export type ExecutedVaultTransaction = { index: number; proposal: string; transaction: string; vaultIndex: number; executedAt: number; approvals: number };
export type Multisig = { address: string; configAuthority: string | null; threshold: number; timeLockSeconds: number; transactionIndex: bigint; members: Member[]; voters: number };

export function decodeMultisig(address: PublicKey, data: Uint8Array): Multisig | null {
  const b = Buffer.from(data);
  if (b.length < 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4 || !b.subarray(0, 8).equals(MULTISIG_DISCRIMINATOR)) return null;
  let o = 8 + 32; // create_key
  const configAuthority = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const threshold = b.readUInt16LE(o); o += 2;
  const timeLockSeconds = b.readUInt32LE(o); o += 4;
  const transactionIndex = b.readBigUInt64LE(o); o += 8;
  o += 8; // stale_transaction_index
  const hasRentCollector = b[o] === 1; o += 1 + (hasRentCollector ? 32 : 0);
  o += 1; // bump
  if (o + 4 > b.length) return null;
  const count = b.readUInt32LE(o); o += 4;
  if (count > 64 || o + count * 33 > b.length) return null;
  const members: Member[] = [];
  for (let i = 0; i < count; i++) {
    const key = new PublicKey(b.subarray(o, o + 32)).toBase58(); const mask = b[o + 32]!; o += 33;
    members.push({ key, initiate: (mask & 1) !== 0, vote: (mask & 2) !== 0, execute: (mask & 4) !== 0 });
  }
  // A config authority of all zeros means the multisig is "autonomous": only its own members can change its settings.
  return { address: address.toBase58(), configAuthority: configAuthority.equals(PublicKey.default) ? null : configAuthority.toBase58(), threshold, timeLockSeconds, transactionIndex, members, voters: members.filter((m) => m.vote).length };
}

/** The multisig account as the chain holds it, or a reason it cannot be trusted as a Squads v4 multisig. */
export async function readMultisig(conn: Pick<Connection, "getAccountInfo">, address: PublicKey): Promise<{ multisig: Multisig } | { error: string }> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) return { error: `no account at ${address.toBase58()}` };
  if (!info.owner.equals(SQUADS_PROGRAM_ID)) return { error: `${address.toBase58()} is owned by ${info.owner.toBase58()}, not the Squads v4 program ${SQUADS_V4_PROGRAM}` };
  const multisig = decodeMultisig(address, info.data);
  return multisig ? { multisig } : { error: `${address.toBase58()} does not decode as a Squads v4 Multisig account` };
}

/**
 * The latest vault transaction of `vaultIndex` that the multisig EXECUTED, among its last EXECUTED_SCAN transactions;
 * null when there is none. A transaction counts only when both of its accounts are there, owned by the Squads program
 * and of this multisig: the proposal in state Executed, and the transaction a VaultTransaction of that vault (a
 * settings change that was executed shows that members can vote, not that the vault can sign). Accounts that were
 * closed to reclaim their rent show nothing: keep the test transaction's accounts until the hand-over is recorded.
 */
export async function readExecutedVaultTransaction(conn: Pick<Connection, "getAccountInfo">, m: Pick<Multisig, "address" | "transactionIndex">, vaultIndex: number): Promise<ExecutedVaultTransaction | null> {
  const multisig = new PublicKey(m.address);
  const mine = (data: Buffer, disc: Buffer, index: bigint, indexAt: number) => data.length >= indexAt + 8 && data.subarray(0, 8).equals(disc) && data.subarray(8, 40).equals(multisig.toBuffer()) && data.readBigUInt64LE(indexAt) === index;
  const lowest = m.transactionIndex > BigInt(EXECUTED_SCAN) ? m.transactionIndex - BigInt(EXECUTED_SCAN) + 1n : 1n;
  for (let index = m.transactionIndex; index >= lowest; index--) {
    const pdas = transactionPdas(multisig, index);
    const proposal = await conn.getAccountInfo(pdas.proposal, "confirmed");
    if (!proposal || !proposal.owner.equals(SQUADS_PROGRAM_ID)) continue;
    const p = Buffer.from(proposal.data);
    // multisig (8..40) | transaction_index (40..48) | status variant (48) | timestamp (49..57) | bump (57) | approved: u32 count (58..62)
    if (!mine(p, PROPOSAL_DISCRIMINATOR, index, 40) || p.length < 62 || p[48] !== PROPOSAL_EXECUTED) continue;
    const transaction = await conn.getAccountInfo(pdas.transaction, "confirmed");
    if (!transaction || !transaction.owner.equals(SQUADS_PROGRAM_ID)) continue;
    const t = Buffer.from(transaction.data);
    // multisig (8..40) | creator (40..72) | index (72..80) | bump (80) | vault_index (81)
    if (!mine(t, VAULT_TRANSACTION_DISCRIMINATOR, index, 72) || t.length < 82 || t[81] !== vaultIndex) continue;
    return { index: Number(index), proposal: pdas.proposal.toBase58(), transaction: pdas.transaction.toBase58(), vaultIndex, executedAt: Number(p.readBigInt64LE(49)), approvals: p.readUInt32LE(58) };
  }
  return null;
}

// ---- What the multisig is expected to be (security/REVIEW-ROUND3-2026-10.md R3-09) ---------------------------------------
//
// "Handed over" used to mean "the authority is the off-curve address that was typed in". The multisig behind that
// address was read once, at `propose`, and never again: a threshold lowered to 1, a member swapped or a config
// authority added afterwards went unseen. Now `propose`, `resolve`, `check` and `verify.ts --expect multisig` each read
// the account and hold it against what the OWNER configured, and the vault is derived from the account, not taken on trust:
//
//   MAINNET_MULTISIG_MEMBERS         the member keys, comma separated. Required: without it nothing says who should be
//                                    able to sign. `key` expects every permission (initiate, vote, execute); `key:ive`
//                                    names them (any of i, v, e). No other member may exist.
//   MAINNET_MULTISIG_THRESHOLD       votes needed. Default 2; never below 2.
//   MAINNET_MULTISIG_MIN_TIME_LOCK   seconds. When set, the multisig's time lock must be at least this.
//   MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK   A time lock of 0 is REFUSED (security/REVIEW-ROUND5-2026-10.md R5-17: it was a
//                                    pass with a note): the multisig's time lock is the only delay on a program
//                                    upgrade, and with none an upgrade two members approve replaces the program at
//                                    once. An owner who decides to run that way says so with exactly
//                                    MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK=upgrades-take-effect-at-once; the hand-over and
//                                    every verification then carry the recorded exception `multisig-zero-time-lock`
//                                    and are never a plain pass.
//   MAINNET_MULTISIG_VAULT_INDEX     which vault of the multisig holds the programs. Default 0.
export type MultisigExpectation = { members: { key: string; mask: number }[] | null; threshold: number; minTimeLockSeconds: number | null; vaultIndex: number; /** The owner accepted a multisig with no time lock, in the words of ZERO_TIME_LOCK_ACK. */ zeroTimeLockAcknowledged?: boolean };
export const ZERO_TIME_LOCK_ACK = "upgrades-take-effect-at-once";
const PERMISSION_LETTERS: [string, number][] = [["i", 1], ["v", 2], ["e", 4]];
export const permissionNames = (mask: number) => [(mask & 1) ? "initiate" : "", (mask & 2) ? "vote" : "", (mask & 4) ? "execute" : ""].filter(Boolean).join("+") || "none";
const maskOf = (m: Pick<Member, "initiate" | "vote" | "execute">) => (m.initiate ? 1 : 0) | (m.vote ? 2 : 0) | (m.execute ? 4 : 0);
/** Reads the expectation from options and the environment; returns what is malformed instead of exiting. */
export function multisigExpectation(env: Record<string, string | undefined> = process.env, options: { members?: string; threshold?: string; minTimeLock?: string } = {}): { expect: MultisigExpectation; problems: string[] } {
  const problems: string[] = [];
  const raw = (options.members ?? env.MAINNET_MULTISIG_MEMBERS ?? "").trim();
  let members: MultisigExpectation["members"] = null;
  if (raw) {
    members = [];
    for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [k, perms] = part.split(":");
      let key: string;
      try { key = new PublicKey(k!).toBase58(); } catch { problems.push(`MAINNET_MULTISIG_MEMBERS: ${k} is not a base58 public key`); continue; }
      let mask = 7;
      if (perms !== undefined) {
        if (!/^[ive]{1,3}$/.test(perms)) { problems.push(`MAINNET_MULTISIG_MEMBERS: permissions "${perms}" of ${key} must be letters of i (initiate), v (vote), e (execute)`); continue; }
        mask = PERMISSION_LETTERS.reduce((m, [letter, bit]) => (perms.includes(letter) ? m | bit : m), 0);
      }
      if (members.some((m) => m.key === key)) problems.push(`MAINNET_MULTISIG_MEMBERS names ${key} twice`);
      members.push({ key, mask });
    }
  }
  const number = (name: string, value: string | undefined, fallback: number | null, min: number, max: number): number | null => {
    const v = value?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) { problems.push(`${name} must be an integer from ${min} to ${max}`); return fallback; }
    return Number(v);
  };
  // A threshold of 1 is never an expectation this kit accepts: one key would again be enough for everything.
  const threshold = number("MAINNET_MULTISIG_THRESHOLD", options.threshold ?? env.MAINNET_MULTISIG_THRESHOLD, 2, 2, 64)!;
  const minTimeLockSeconds = number("MAINNET_MULTISIG_MIN_TIME_LOCK", options.minTimeLock ?? env.MAINNET_MULTISIG_MIN_TIME_LOCK, null, 0, 4_294_967_295);
  const vaultIndex = number("MAINNET_MULTISIG_VAULT_INDEX", env.MAINNET_MULTISIG_VAULT_INDEX, 0, 0, 255)!;
  // An acknowledgement is the sentence, typed out, or it is nothing: "yes" and "true" acknowledge anything.
  const ack = env.MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK?.trim();
  if (ack && ack !== ZERO_TIME_LOCK_ACK) problems.push(`MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK must be exactly ${ZERO_TIME_LOCK_ACK} (it accepts a multisig with no time lock: a program upgrade two members approve takes effect at once), or be unset`);
  return { expect: { members, threshold, minTimeLockSeconds, vaultIndex, zeroTimeLockAcknowledged: ack === ZERO_TIME_LOCK_ACK }, problems };
}

export type MultisigException = { id: string; detail: string };
/**
 * Holds a multisig account against the expectation. `problems` refuse (a hand-over is not proposed, not resolved, not
 * recorded as complete, and no report is written); `notes` are for the operator to read; `exceptions` are bypasses that
 * were asked for (`untestedOk`), which the caller must record: they never make a plain pass.
 *   - the vault that holds (or is to hold) the programs is the vault PDA derived from THIS account and the expected index
 *   - the threshold is at least 2, equals the expected one, and can be met by the voting members
 *   - the members are exactly the expected set, each with exactly the expected permissions
 *   - no config authority: a "controlled" multisig lets one key rewrite members and threshold without a vote
 *   - the time lock: at least the configured minimum; shorter than a pause lasts; 0 is a problem unless the owner
 *     acknowledged it (MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK), and then an exception (R5-17)
 *   - the multisig has EXECUTED a vault transaction of this vault (`executed`, read by `readExecutedVaultTransaction`):
 *     it is known to work. Having created transactions shows nothing (R4-29). `untestedOk` accepts a multisig that has
 *     not, as a recorded exception; it is a rehearsal's flag (`untestedBypassRefusal`).
 */
export function appraiseMultisig(m: Multisig, vault: PublicKey, operator: PublicKey, expect: MultisigExpectation, o: { untestedOk?: boolean; executed?: ExecutedVaultTransaction | null } = {}): { problems: string[]; notes: string[]; exceptions: MultisigException[] } {
  const problems: string[] = [], notes: string[] = [], exceptions: MultisigException[] = [];
  const derived = vaultPda(new PublicKey(m.address), expect.vaultIndex);
  if (!derived.equals(vault)) problems.push(`the vault ${vault.toBase58()} is not vault ${expect.vaultIndex} of multisig ${m.address} (that is ${derived.toBase58()})`);
  if (m.threshold < 2) problems.push(`the multisig's threshold is ${m.threshold} (of ${m.voters} voting members), expected ${expect.threshold}: one member alone could move every authority`);
  else if (m.threshold !== expect.threshold) problems.push(`the multisig's threshold is ${m.threshold} (of ${m.voters} voting members), expected ${expect.threshold} (MAINNET_MULTISIG_THRESHOLD)`);
  if (m.threshold > m.voters) problems.push(`the multisig's threshold (${m.threshold}) is above its ${m.voters} voting members: it can approve nothing`);
  if (!expect.members) problems.push("the expected members are not configured: set MAINNET_MULTISIG_MEMBERS (or --multisig-members) to the member keys, so that the account on chain can be held against them");
  else {
    for (const want of expect.members) {
      const have = m.members.find((x) => x.key === want.key);
      if (!have) problems.push(`expected member ${want.key} is missing from the multisig`);
      else if (maskOf(have) !== want.mask) problems.push(`member ${want.key} has permissions ${permissionNames(maskOf(have))}, expected ${permissionNames(want.mask)}`);
    }
    for (const have of m.members) if (!expect.members.some((x) => x.key === have.key)) problems.push(`member ${have.key} (${permissionNames(maskOf(have))}) is not an expected member (MAINNET_MULTISIG_MEMBERS)`);
    if (new Set(m.members.map((x) => x.key)).size !== m.members.length) problems.push("the multisig lists a member twice");
  }
  if (m.configAuthority) problems.push(`this is a controlled multisig: its config authority ${m.configAuthority} can change members and threshold without a vote; create it as an autonomous multisig (no config authority)`);
  if (m.members.some((x) => x.key === operator.toBase58())) notes.push("the operator (deployer) key is a member of the multisig: fine while it is one of several, but it must not be reused as a hot key");
  // The programs carry their own 24 h timelock on every loosening change and every hand-over. The multisig's time lock
  // is on top of that and is the ONLY delay on a program upgrade, which no program can bound.
  if (expect.minTimeLockSeconds !== null && m.timeLockSeconds < expect.minTimeLockSeconds) problems.push(`the multisig's time lock is ${m.timeLockSeconds} s, below the configured minimum (MAINNET_MULTISIG_MIN_TIME_LOCK) of ${expect.minTimeLockSeconds} s`);
  // No time lock is a refusal, not a remark (R5-17). Accepted only in the owner's own words, and then as a recorded exception.
  const NO_TIME_LOCK = "the multisig has NO time lock (0 s): a program upgrade approved by the threshold takes effect at once, with no notice to anyone (config changes still wait the programs' own 24 h)";
  if (m.timeLockSeconds === 0 && expect.zeroTimeLockAcknowledged) exceptions.push({ id: "multisig-zero-time-lock", detail: `${NO_TIME_LOCK}; acknowledged with MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK` });
  else if (m.timeLockSeconds === 0) problems.push(`${NO_TIME_LOCK}. Give the multisig a time lock (below 72 hours, so that a pause can still be renewed), or, if running without one is the owner's decision, say so with MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK=${ZERO_TIME_LOCK_ACK}: the result is then a recorded exception, never a plain pass`);
  else notes.push(`multisig time lock ${m.timeLockSeconds} s: it delays every vault transaction, upgrades included, and comes on top of the programs' own 24 h for config changes`);
  // After the hand-over the vault is the authority, and only the authority renews a pause, which lapses 72 hours after
  // it was last set. A vault transaction waits out the multisig's time lock before it can execute, so a time lock of 72
  // hours or more means NO pause can ever be held past its first 72 hours, and a shorter one eats into the time to react.
  if (m.timeLockSeconds >= PAUSE_TTL_SECONDS) problems.push(`the multisig's time lock (${m.timeLockSeconds} s) is not shorter than a pause lasts (${PAUSE_TTL_SECONDS} s): after the hand-over a pause could never be renewed before it lapses. Use a shorter time lock.`);
  else if (m.timeLockSeconds > 0) notes.push(`a pause lasts ${PAUSE_TTL_SECONDS / 3600} h and only the vault renews it after the hand-over: with this time lock a renewal must be created and approved at least ${(m.timeLockSeconds / 3600).toFixed(1)} h before the pause lapses`);
  if (o.executed) notes.push(`vault transaction ${o.executed.index} was executed (${o.executed.approvals} approval(s), proposal ${o.executed.proposal}): the members have made this vault sign`);
  else {
    const what = m.transactionIndex === 0n ? "this multisig has never created a transaction" : `this multisig has created ${m.transactionIndex} transaction(s) and none of ${m.transactionIndex > BigInt(EXECUTED_SCAN) ? `the latest ${EXECUTED_SCAN}` : "them"} is an executed vault transaction of vault ${expect.vaultIndex} (a proposal in state Executed with its VaultTransaction account still on chain)`;
    if (o.untestedOk) exceptions.push({ id: "multisig-untested-ok", detail: `${what}; accepted with --multisig-untested-ok` });
    else problems.push(`${what}. Before it becomes the only key to the programs, have the members approve and EXECUTE one small vault transaction (for example a tiny SOL transfer out of the vault), and leave its accounts open until the hand-over is recorded. A rehearsal may pass --multisig-untested-ok, and that is recorded.`);
  }
  return { problems, notes, exceptions };
}

/** What was read, for the record and the verification report. */
export function multisigEvidence(m: Multisig, vault: PublicKey, expect: MultisigExpectation, executed: ExecutedVaultTransaction | null = null): Record<string, unknown> {
  return {
    address: m.address, owner: SQUADS_V4_PROGRAM, threshold: m.threshold, voters: m.voters, timeLockSeconds: m.timeLockSeconds, configAuthority: m.configAuthority,
    transactionsCreated: Number(m.transactionIndex), executedVaultTransaction: executed, members: m.members.map((x) => ({ key: x.key, initiate: x.initiate, vote: x.vote, execute: x.execute })),
    vault: vault.toBase58(), vaultIndex: expect.vaultIndex, derivedVault: vaultPda(new PublicKey(m.address), expect.vaultIndex).toBase58(),
    expectedThreshold: expect.threshold, expectedMembers: expect.members?.map((x) => x.key) ?? null, ...(expect.minTimeLockSeconds !== null ? { minTimeLockSeconds: expect.minTimeLockSeconds } : {}),
    ...(m.timeLockSeconds === 0 && expect.zeroTimeLockAcknowledged ? { zeroTimeLockAcknowledged: true } : {}),
  };
}

export type MultisigJudgement = { multisig: Multisig | null; problems: string[]; notes: string[]; exceptions: MultisigException[]; evidence: Record<string, unknown> | null };
/** Read the account and judge it: the one call `handover.ts` and `verify.ts` make, every time. A missing account address is a problem, not a skip. */
export async function judgeMultisig(conn: Pick<Connection, "getAccountInfo">, account: PublicKey | null, vault: PublicKey, operator: PublicKey, expect: MultisigExpectation, o: { untestedOk?: boolean } = {}): Promise<MultisigJudgement> {
  if (!account) return { multisig: null, problems: ["the Squads multisig account is not known (--multisig-account, MAINNET_MULTISIG_ACCOUNT, or the record): without it the vault is only an address, and nothing says who can sign for it"], notes: [], exceptions: [], evidence: null };
  const res = await readMultisig(conn, account);
  if ("error" in res) return { multisig: null, problems: [res.error], notes: [], exceptions: [], evidence: null };
  const executed = await readExecutedVaultTransaction(conn, res.multisig, expect.vaultIndex);
  return { multisig: res.multisig, ...appraiseMultisig(res.multisig, vault, operator, expect, { ...o, executed }), evidence: multisigEvidence(res.multisig, vault, expect, executed) };
}
/**
 * Why --multisig-untested-ok is refused; null when it may be passed. Mainnet never takes it, in any phase (R4-29): the
 * vault is about to become the only key to the programs, and "it has never made the vault sign" is exactly what must
 * not be waved through there. A rehearsal's stand-in vault creates no Squads transaction, so there it is the honest case.
 */
export function untestedBypassRefusal(mode: Mode, phase: string): string | null {
  return mode === "mainnet" ? `--multisig-untested-ok is not accepted on mainnet (${phase}): have the members approve and execute one small vault transaction first, so that the multisig is known to make its vault sign before the programs are proposed to it.` : null;
}
/** The lines every caller prints for a multisig it read. */
export function describeMultisig(m: Multisig): string[] {
  return [`Squads multisig ${m.address}: threshold ${m.threshold} of ${m.voters} voting members, time lock ${m.timeLockSeconds} s, ${m.configAuthority ? `config authority ${m.configAuthority}` : "no config authority (autonomous)"}, ${m.transactionIndex} transaction(s) created so far`, ...m.members.map((x) => `  member ${x.key}  ${permissionNames(maskOf(x))}`)];
}

// ---- How the vault signs -----------------------------------------------------------------------------------------------
//
// A vault never signs a transaction itself: Squads' `vault_transaction_execute` runs the stored instructions through
// `invoke_signed` with the vault's seeds. Any OTHER signer those instructions need must have signed the outer execute
// transaction; Squads checks exactly that (squads-protocol/v4, utils/executable_transaction_message.rs:
// "If the account is marked as signer in the message, it must be a signer in the account infos too. Unless it's a vault
// or an ephemeral signer PDA"). The hand-over's resolving instruction needs the operator key beside the vault, so the
// member who executes the vault transaction sends it together with the operator's signature.
//
// The rehearsal cannot run the real Squads program (it is not part of this repository and is not fetched), so
// scripts/mainnet/rehearsal-vault is loaded at the Squads program id on the throwaway validator: it applies the same
// rule and nothing else. `rehearsalVaultExecuteIx` is the instruction of that stand-in. It is not a Squads instruction.

const REHEARSAL_EXECUTE = createHash("sha256").update("global:execute").digest().subarray(0, 8);
/** Rehearsal only: run `inner` with the vault of `multisig` as a signer, through the stand-in loaded at the Squads id. */
export function rehearsalVaultExecuteIx(multisig: PublicKey, inner: TransactionInstruction[], vaultIndex = 0): TransactionInstruction {
  const vault = vaultPda(multisig, vaultIndex);
  const remaining: AccountMeta[] = [];
  const indexOf = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): number => {
    let i = remaining.findIndex((m) => m.pubkey.equals(pubkey));
    if (i < 0) { remaining.push({ pubkey, isSigner: false, isWritable: false }); i = remaining.length - 1; }
    // The vault cannot sign the outer transaction (nobody holds its key); every other inner signer must.
    remaining[i]!.isSigner ||= isSigner && !pubkey.equals(vault);
    remaining[i]!.isWritable ||= isWritable;
    return i;
  };
  const parts: Buffer[] = [REHEARSAL_EXECUTE, Buffer.from([vaultIndex]), u32(inner.length)];
  for (const ix of inner) {
    const accounts = ix.keys.map((k) => Buffer.from([indexOf(k.pubkey, k.isSigner, k.isWritable), k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]));
    parts.push(Buffer.from([indexOf(ix.programId, false, false)]), u32(accounts.length), ...accounts, u32(ix.data.length), Buffer.from(ix.data));
  }
  return new TransactionInstruction({ programId: SQUADS_PROGRAM_ID, keys: [{ pubkey: multisig, isSigner: false, isWritable: false }, { pubkey: vault, isSigner: false, isWritable: false }, ...remaining], data: Buffer.concat(parts) });
}
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

