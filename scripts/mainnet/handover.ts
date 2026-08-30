// Hand what the operator (deployer) key holds to the Squads v4 multisig vault: each program's config authority and each
// program's upgrade authority. Two phases with at least 24 hours between them, because the programs allow nothing else:
//
//   1. propose    the operator names the vault as the next authority of every program          (operator signs; today)
//      ... CONFIG_TIMELOCK: 24 hours in the mainnet build. The operator, and only the operator, can still cancel:
//          the guardian cannot (it can pause and nothing else; security/REREVIEW-2026-10.md RR-02) ...
//   2. resolve    the change is applied in an instruction the VAULT signs as the new authority  (a Squads vault
//                 transaction; the operator key co-signs it, see below), and in the same transaction the upgrade
//                 authority moves with SetAuthorityChecked, which the vault signs as well
//      ... PROPOSAL_TTL: the resolution must land within 7 DAYS of the moment the proposal became effective. After
//          that the programs refuse it (ProposalExpired); `cancel` clears the expired proposals and `propose` starts
//          again with a fresh 24 hours (RR-09). Plan the multisig's approvals inside that week.
//
//   bun scripts/mainnet/handover.ts propose --i-understand-this-is-mainnet --multisig <vault> --multisig-account <multisig> [--dry-run]
//   bun scripts/mainnet/handover.ts status  --i-understand-this-is-mainnet --multisig <vault>
//   bun scripts/mainnet/handover.ts resolve --i-understand-this-is-mainnet --multisig <vault> --multisig-account <multisig> --print
//   bun scripts/mainnet/handover.ts check   --i-understand-this-is-mainnet --multisig <vault>
//   bun scripts/mainnet/handover.ts cancel  --i-understand-this-is-mainnet --multisig <vault>          withdraw what was proposed
//   bun scripts/mainnet/handover.ts <phase> --rehearsal ...                                            the same against a local validator
//
//   --multisig <address>          the Squads VAULT address (vault 0): the address that signs for the multisig. Not a member
//                                 key and not the multisig (settings) account.
//   --multisig-account <address>  the Squads multisig account (also MAINNET_MULTISIG_ACCOUNT, or the record). Read from the
//                                 chain and judged EVERY time, by propose, resolve and check: owned by the Squads v4
//                                 program, the expected threshold and members (MAINNET_MULTISIG_MEMBERS,
//                                 MAINNET_MULTISIG_THRESHOLD; scripts/mainnet/squads.ts), no config authority, the
//                                 configured minimum time lock, --multisig equal to the vault derived from THIS account,
//                                 and a vault transaction of that vault EXECUTED already (created is not enough). `check`
//                                 writes what it read into the record.
//   --multisig-members a,b,c      the expected member keys (default MAINNET_MULTISIG_MEMBERS); --multisig-threshold N
//                                 and --multisig-min-time-lock <seconds> likewise override their environment values
//   --tier / --programs           which programs (default: the tier of the deployments record). The selection never
//                                 narrows what `check` looks at: every program deployed at an id this deployment
//                                 reserves is read, and a selection that leaves one out is refused (R3-08).
//   --set-guardian <key>          propose only: ALSO replace the guardian with <key> in the same proposals. Without this
//                                 flag the hand-over never touches the guardian: a MAINNET_GUARDIAN, --guardian or record
//                                 value that differs from the guardian on chain is a refusal (R3-11). With it, the old
//                                 and the new key are shown and a confirmation naming both must be typed.
//   --guardian <key>              the guardian the configs are EXPECTED to carry (default MAINNET_GUARDIAN, then the record)
//   --dry-run                     propose: print every instruction (program, accounts, data) and send nothing
//   --print                       resolve: print each program's vault transaction for a Squads proposal, and write the
//                                 same as JSON beside the deployments record. Sends nothing.
//   --freeze-upgrades             resolve only, NOT the default: remove the upgrade authority instead of moving it. The
//                                 programs become immutable forever. Read scripts/mainnet/README.md first.
//   --multisig-untested-ok        REHEARSAL ONLY: accept a multisig that has not executed a vault transaction. Recorded in
//                                 the record and carried into verify.ts's report: the result is then never a plain pass.
//                                 Refused on mainnet in every phase, before anything is read (R4-29).
//   --via-rehearsal-vault         rehearsal only: execute the resolving transactions through the stand-in loaded at the
//                                 Squads program id (scripts/mainnet/rehearsal-vault), with the operator co-signing
//
// Why the operator co-signs phase 2. `resolve_config(apply = true)` of trellis_credits, tab, bond, capacity and rules,
// and `resolve_change` of the fee router, check two signatures in one instruction: the CURRENT authority (it applies
// its own proposal) and the NEW authority (it proves it can sign, so a mistyped address cannot strand the program).
// The vault can only sign inside a Squads vault transaction, so that transaction's instruction lists the operator key
// as a second signer, and the member who executes it must send the execution together with the operator's signature.
// Squads v4 allows this (it requires any non-vault signer of the stored message to have signed the execute
// transaction); the Squads web app has no field for a second signer, so the execution is sent with the Squads SDK or
// CLI. THIS STEP HAS NOT BEEN RUN AGAINST THE REAL SQUADS PROGRAM: the rehearsal runs it against a stand-in that applies
// the same signer rule (scripts/mainnet/README.md says exactly what that does and does not show).
//
// What does not move, by design: the guardian (its own key from init on: the hand-over leaves it alone, unless
// --set-guardian says otherwise), trellis_anchor's authority (the anchorer key posts a root every hour) and the
// operational role keys (settlement, slasher, sale). After the hand-over the multisig can replace any of them through
// a 24 h proposal, except the anchorer, which only hands itself on. Replacing the guardian no longer needs the
// guardian's consent: it cannot cancel that proposal.
//
// Before proposing, every program is asked which build it is (build_profile). On mainnet a program that does not report
// profile 0 and the mainnet floors stops the proposal: the 24 hours above are a property of the build, not of this script.
//
// Every phase is idempotent: what is already proposed, resolved or held by the vault is skipped. `check` reads the chain
// and fails ("HANDOVER INCOMPLETE", exit 1, nothing recorded) unless, for EVERY deployed program whatever the selection:
// the vault holds the config and the upgrade authority, no role at all is on the operator key (settlement, slasher,
// sale, HVX, anchorer, receipt signer: scripts/mainnet/coverage.ts lists them and what each must be), every account a
// program pays into is owned by the vault and has no delegate and no close authority, no guardian is a member of the
// multisig, no proposal is pending, and the multisig account behind the vault is what was configured.
// "Every deployed program" is all eight ids of the source's declare_id! lines, read on chain whether or not the record
// lists them (R4-18): a record that names another id stops the script.
import { writeFileSync } from "node:fs";
import { ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { allRoles, coverageOf, coverageProblems, describeGuardianMember, describePayout, guardianMemberFindings, handoverFindings, nameRoles, payoutFindings, type Coverage, type RoleRow } from "./coverage.ts";
import { MAINNET_FLAG, PROGRAMS, REHEARSAL_FLAG, TIER_OPTIONS, assertCluster, confirm, connect, deploymentsFile, expectFlags, explorer, fail, loadDeployer, loadRecord, modeOf, optionalPubkey, parseArgs, programIds, pubkey, rpcHost, rpcUrl, saveRecord, selection, sol, table, type ProgramName } from "./lib.ts";
import { HANDOVER_KIND, MAINNET_PROPOSAL_TTL_SECONDS, cancelIx, describeProfile, proposalLifecycle, proposeIx, readPending, resolveInstructions, type Lifecycle, type Pending, type ProfileReading } from "./plan.ts";
import { describeMultisig, judgeMultisig, multisigExpectation, rehearsalVaultExecuteIx, SQUADS_PROGRAM_ID, untestedBypassRefusal, type MultisigJudgement } from "./squads.ts";
import { chainTime, fundedPayer, readBuildProfile, readChainState, type ChainState } from "./state.ts";

const args = parseArgs(process.argv.slice(2), ["--multisig", "--multisig-account", "--guardian", "--set-guardian", "--multisig-members", "--multisig-threshold", "--multisig-min-time-lock", ...TIER_OPTIONS]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--dry-run", "--print", "--freeze-upgrades", "--multisig-untested-ok", "--via-rehearsal-vault", "--yes"]);
const PHASES = ["propose", "status", "resolve", "check", "cancel"] as const;
const phase = args.positional[0] as (typeof PHASES)[number] | undefined;
if (!phase || !PHASES.includes(phase) || args.positional.length !== 1) fail(`usage: bun scripts/mainnet/handover.ts <${PHASES.join("|")}> --multisig <vault> [--multisig-account <multisig>] ...\nThe hand-over is two phases at least 24 hours apart: propose (the operator), then resolve (a Squads vault transaction the operator co-signs).`, 2);
const mode = modeOf(args);
// A rehearsal's flag: refused on mainnet in every phase, before anything is read (R4-29).
if (args.flags.has("--multisig-untested-ok")) { const no = untestedBypassRefusal(mode, phase); if (no) fail(no, 2); }
const DRY = args.flags.has("--dry-run");
const PRINT = args.flags.has("--print");
const FREEZE = args.flags.has("--freeze-upgrades");
const VIA_STAND_IN = args.flags.has("--via-rehearsal-vault");
if (VIA_STAND_IN && mode === "mainnet") fail("--via-rehearsal-vault is for rehearsals only: on mainnet the Squads program id is the real Squads program.", 2);
if (FREEZE && phase !== "resolve") fail("--freeze-upgrades belongs to the resolve phase.", 2);
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const rec = loadRecord(mode, genesis);
const { tier, programs: selected } = selection(args, rec);
// All eight ids, selected or not, listed in the record or not: the ids come from the source (declare_id!; lib.ts
// programIds), and what is DEPLOYED is read from the chain, never from the selection or the record (R4-18).
const ids = programIds(mode, rec, selected);
const first = await readChainState(conn, ids);
const cov: Coverage = coverageOf(selected, first, rec);
const covProblems = coverageProblems(cov, tier, selected);
if (!selected.length && !cov.deployed.length) { console.log(`Tier ${tier} deploys no program and none is deployed at an id this deployment reserves: there is no authority to hand over.`); process.exit(0); }
/** The programs every table and every judgement is about: the selection and everything deployed beside it. */
const scope = PROGRAMS.filter((p) => selected.includes(p) || cov.deployed.includes(p));
const vault = pubkey(args.options.get("--multisig") ?? process.env.MAINNET_MULTISIG_VAULT, "--multisig <vault address>");
const multisigAccount = optionalPubkey(args.options.get("--multisig-account") ?? process.env.MAINNET_MULTISIG_ACCOUNT ?? rec.handover?.multisigAccount, "--multisig-account");
const { expect: expectMultisig, problems: expectProblems } = multisigExpectation(process.env, { members: args.options.get("--multisig-members"), threshold: args.options.get("--multisig-threshold"), minTimeLock: args.options.get("--multisig-min-time-lock") });
if (expectProblems.length) fail(`The expected multisig is not configured correctly:\n${expectProblems.map((p) => `  - ${p}`).join("\n")}`, 2);
const UNTESTED_OK = args.flags.has("--multisig-untested-ok");
// The operator key signs propose, cancel and the rehearsal's resolve; everything else needs only its public key.
const signs = (phase === "propose" && !DRY) || phase === "cancel" || (phase === "resolve" && VIA_STAND_IN);
const signer = signs ? loadDeployer(mode) : null;
const operator = signer?.publicKey ?? pubkey(rec.deployer, "the deployer in the deployments record");
if (PublicKey.isOnCurve(vault.toBytes())) fail("--multisig is an ordinary wallet address (on the ed25519 curve). A Squads vault is a program-derived address: pass the vault, not a member key.", 2);
if (vault.equals(operator)) fail("--multisig is the operator key itself.", 2);
// The guardian the configs are EXPECTED to carry. It is compared with the chain; it is never written to it from here.
const guardianSource = args.options.has("--guardian") ? "--guardian" : process.env.MAINNET_GUARDIAN ? "MAINNET_GUARDIAN" : "the deployments record";
const guardian = optionalPubkey(args.options.get("--guardian") ?? process.env.MAINNET_GUARDIAN ?? rec.authorities?.guardian, "MAINNET_GUARDIAN");
// The one way this script changes a guardian: named on the command line, for this proposal (R3-11).
const setGuardian = optionalPubkey(args.options.get("--set-guardian"), "--set-guardian <the new guardian key>");
if (setGuardian && phase !== "propose") fail("--set-guardian belongs to the propose phase.", 2);
const cuPrice = Number(process.env.COMPUTE_UNIT_PRICE ?? 5000);
const v = vault.toBase58(), op = operator.toBase58();
/** The guardian a pending hand-over may carry: the one named with --set-guardian now, or recorded when it was proposed. */
const proposedGuardian = setGuardian?.toBase58() ?? rec.handover?.setGuardian?.to ?? null;

const hasConfigHandover = (p: ProgramName) => HANDOVER_KIND[p] !== "none";
// Which build each program is, asked of the program itself once per run (a simulated build_profile; nothing is sent).
// Its PROPOSAL_TTL is what decides when a proposal expires.
const profiles: Partial<Record<ProgramName, ProfileReading>> = {};
const payer = await fundedPayer(conn, [operator, vault, guardian, rec.authorities?.settlementAuthority, rec.authorities?.anchorAuthority]);
const ttlOf = (p: ProgramName) => Number(profiles[p]?.floors.proposalTtl ?? MAINNET_PROPOSAL_TTL_SECONDS);
type Row = { program: ProgramName; authority: string | null; guardian: string | null; upgrade: string | null; frozen: boolean; pending: Pending | null; life: Lifecycle | null; initialised: boolean; deployed: boolean; selected: boolean; roles: RoleRow[] };
async function read(): Promise<{ state: ChainState; rows: Row[]; now: number }> {
  const state = await readChainState(conn, ids);
  const now = await chainTime(conn);
  // Every key every config names, and who owns each account the programs pay into (scripts/mainnet/coverage.ts).
  const roles = await allRoles(conn, state);
  const rows: Row[] = [];
  for (const p of scope) {
    const mine = roles.filter((r) => r.program === p);
    const of = (role: string) => mine.find((r) => r.role === role)?.address ?? null;
    const deployed = !!state.programs[p]?.deployed;
    if (deployed && !profiles[p]) profiles[p] = await readBuildProfile(conn, p, ids[p], payer);
    // Every program has one pending account (trellis_anchor too: its authority hands itself on through it).
    const pending = deployed ? await readPending(conn, p, ids[p]) : null;
    rows.push({ program: p, authority: of("authority"), guardian: of("guardian"), upgrade: state.programs[p]?.upgradeAuthority ?? null, frozen: !!state.programs[p]?.frozen, pending, life: pending ? proposalLifecycle(pending, now, ttlOf(p)) : null, initialised: !!state.configs[p], deployed, selected: selected.includes(p), roles: mine });
  }
  return { state, rows, now };
}
/** A pending proposal is this hand-over when it names the vault and changes nothing else, except the guardian that --set-guardian named. */
const isHandover = (x: Pending) => x.newAuthority === v && x.other.length === 0 && (x.guardian === null || x.guardian === proposedGuardian);
const wait = (seconds: number) => (seconds <= 0 ? "ready" : seconds < 3600 ? `in ${Math.ceil(seconds / 60)} min` : `in ${(seconds / 3600).toFixed(1)} h`);
const span = (seconds: number) => (seconds < 3600 ? `${Math.max(0, Math.ceil(seconds / 60))} min` : seconds < 2 * 86_400 ? `${(seconds / 3600).toFixed(1)} h` : `${(seconds / 86_400).toFixed(1)} d`);
const iso = (t: number) => new Date(t * 1000).toISOString();
/** Where a pending proposal stands, for the table: waiting, resolvable (and until when), or expired. */
const stand = (r: Row) => (r.life!.state === "pending" ? wait(r.life!.toEffective) : r.life!.state === "applicable" ? `ready; expires in ${span(r.life!.toExpiry)}` : `EXPIRED ${iso(r.life!.expiresAt)}`);

function printInstruction(n: number, what: string, ix: TransactionInstruction): void {
  console.log(`  [${n}] ${what}`);
  console.log(`      program ${ix.programId.toBase58()}`);
  for (const k of ix.keys) console.log(`      account ${k.pubkey.toBase58()}${k.isSigner ? " signer" : ""}${k.isWritable ? " writable" : ""}${k.pubkey.equals(vault) ? "   <- the vault" : k.pubkey.equals(operator) ? "   <- the operator key" : ""}`);
  console.log(`      data    hex ${Buffer.from(ix.data).toString("hex")}  base64 ${Buffer.from(ix.data).toString("base64")}`);
}

/**
 * Who holds what, for every deployed program, and whether anything at all is left on the operator key or pending.
 * `good`: nothing is wrong (before the hand-over the operator rightly holds the two authorities). `complete`: the vault
 * holds both authorities of every deployed program, no role of any kind is on the operator key, nothing is pending.
 */
function report(rows: Row[], now: number): { good: boolean; complete: boolean; left: RoleRow[] } {
  const out: (string | number)[][] = [["program", "config authority", "guardian", "upgrade authority", "other roles on the operator key", "pending", "result"]];
  let good = true, complete = true;
  const left: RoleRow[] = [];
  const anchorer = rec.authorities?.anchorAuthority;
  const expectedGuardian = guardian?.toBase58();
  for (const r of rows) {
    const problems: string[] = [];
    if (!r.deployed) problems.push(cov.recorded.includes(r.program) && !r.selected ? "listed in the record but not found on chain" : "not deployed");
    else if (!r.initialised) problems.push("not initialised");
    if (r.deployed && cov.unrecorded.includes(r.program)) problems.push("deployed at its reserved id but not listed in the deployments record");
    if (r.deployed && !r.selected) problems.push(`outside the selected tier (${tier}): the hand-over covers every deployed program, so run with a --tier / MAINNET_TIER that includes it`);
    const name = (k: string | null) => (k === v ? "vault" : k === op ? "OPERATOR" : k === expectedGuardian ? "guardian key" : k === anchorer ? "anchorer" : k ?? "-");
    const found = handoverFindings(r.roles, { operator: op, vault: v, frozen: () => r.frozen });
    left.push(...found.onOperator);
    if (found.onOperator.length || found.notVault.length) complete = false;
    if (r.program === "trellis_anchor") { if (r.authority === op) problems.push("authority is the operator key"); else if (anchorer && r.authority !== anchorer) problems.push("authority is not the recorded anchorer"); }
    else if (r.deployed && r.authority !== v && r.authority !== op) problems.push("authority is neither the operator nor the vault");
    if (r.guardian !== null && (r.guardian === op || r.guardian === v)) problems.push(`guardian is the ${r.guardian === op ? "operator key" : "vault"}: it must be a key of its own`);
    if (r.guardian !== null && expectedGuardian && r.guardian !== expectedGuardian) problems.push(`guardian is not the guardian key ${guardianSource} names`);
    if (r.deployed && !r.frozen && r.upgrade !== v && r.upgrade !== op) problems.push("upgrade authority is neither the operator nor the vault");
    // Before the hand-over the operator holds the two authorities and nothing else. Any OTHER role on it is wrong at any stage.
    const stray = found.onOperator.filter((x) => x.kind !== "authority" && x.kind !== "upgrade" && !(x.program === "trellis_anchor" && x.role === "authority") && x.kind !== "guardian");
    if (stray.length) problems.push(`the operator key holds ${stray.map((x) => x.role).join(", ")}`);
    for (const x of found.unreadable) problems.push(`${x.role}: ${x.account} is missing or is not an SPL Token account`);
    // What the program pays out goes to these accounts: the vault's, with nobody else able to move or close them (R4-29).
    for (const x of payoutFindings(r.roles, v)) problems.push(describePayout(x));
    const pending = r.pending ? `${isHandover(r.pending) ? "hand-over to the vault" : `NOT the hand-over (authority ${r.pending.newAuthority ?? "unchanged"}${r.pending.guardian ? `, guardian ${r.pending.guardian}` : ""}${r.pending.other.length ? `, ${r.pending.other.join(", ")}` : ""})`}${r.pending.guardian && isHandover(r.pending) ? ` and guardian -> ${r.pending.guardian}` : ""}, ${stand(r)}` : "-";
    if (r.pending) complete = false;
    if (r.pending && !isHandover(r.pending)) problems.push("a proposal that is not this hand-over is pending");
    if (r.life?.state === "expired") problems.push(`its proposal expired (it had to be applied within ${span(ttlOf(r.program))} of becoming effective): clear it with \`handover.ts cancel\` and propose again`);
    if (problems.length) good = false;
    out.push([r.program, name(r.authority), r.guardian === null ? "n/a" : name(r.guardian), !r.deployed ? "-" : r.frozen ? "none (immutable)" : name(r.upgrade), stray.length ? stray.map((x) => x.role).join(", ") : "-", pending, problems.length ? `FAIL: ${problems.join("; ")}` : "ok"]);
  }
  table(out);
  if (left.length) console.log(`\nstill on the operator key: ${nameRoles(left)}`);
  return { good, complete, left };
}
/**
 * Guardians that are members of the multisig (R4-29): judged against the members as read now. A guardian that the
 * pending or the about-to-be-made proposal replaces (--set-guardian) is not held against the hand-over that removes it.
 */
function guardianIsMember(rs: Row[], j: MultisigJudgement | null): string[] {
  if (!j?.multisig) return [];
  const kept = rs.filter((r) => !(phase === "propose" && setGuardian && r.guardian !== setGuardian.toBase58()) && !(r.pending && isHandover(r.pending) && r.pending.guardian));
  const both = guardianMemberFindings(kept.flatMap((r) => r.roles), j.multisig.members.map((m) => m.key));
  return both.length ? [describeGuardianMember(both)] : [];
}
/** The multisig account, read and judged now; what was read is printed. */
async function multisigNow(): Promise<MultisigJudgement> {
  const j = await judgeMultisig(conn, multisigAccount, vault, operator, expectMultisig, { untestedOk: UNTESTED_OK });
  if (j.multisig) { console.log(""); for (const line of describeMultisig(j.multisig)) console.log(line); }
  for (const n of j.notes) console.log(`  note: ${n}`);
  for (const x of j.exceptions) console.log(`  EXCEPTION (recorded): ${x.detail}`);
  // Compared with what `propose` read: a change since then is said, whether or not it is also a refusal.
  const before = rec.handover?.multisig as { threshold?: number; timeLockSeconds?: number; configAuthority?: string | null; members?: { key: string }[] } | undefined;
  if (j.multisig && before) {
    const changed = [before.threshold !== j.multisig.threshold ? `threshold ${before.threshold} -> ${j.multisig.threshold}` : "", before.timeLockSeconds !== j.multisig.timeLockSeconds ? `time lock ${before.timeLockSeconds} s -> ${j.multisig.timeLockSeconds} s` : "", (before.configAuthority ?? null) !== j.multisig.configAuthority ? `config authority ${before.configAuthority ?? "none"} -> ${j.multisig.configAuthority ?? "none"}` : "", JSON.stringify((before.members ?? []).map((m) => m.key).sort()) !== JSON.stringify(j.multisig.members.map((m) => m.key).sort()) ? "the member list" : ""].filter(Boolean);
    if (changed.length) console.log(`  CHANGED since it was last recorded: ${changed.join("; ")}`);
  }
  return j;
}

console.log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal"} hand-over: ${phase} on ${rpcHost(url)}; tier ${tier}${DRY ? "  (DRY RUN: nothing is sent)" : PRINT ? "  (print only: nothing is sent)" : ""}`);
table([["operator key (gives up everything)", op], ["multisig vault (receives)", v], ["multisig account", multisigAccount?.toBase58() ?? "not given"], ["guardian key (stays; a key of its own)", guardian?.toBase58() ?? "not known (set MAINNET_GUARDIAN)"]]);

let { rows, now } = await read();

// ---- status and check: read-only ---------------------------------------------------------------------------------------------
if (phase === "status" || phase === "check") {
  console.log(`\nWho holds what, read from the chain (every program deployed at an id this deployment reserves: ${cov.deployed.join(", ") || "none"})`);
  const r = report(rows, now);
  for (const p of covProblems) console.log(`\nNOT COVERED: ${p}.`);
  const vaultSol = await conn.getBalance(vault, "confirmed");
  console.log(`\nvault balance ${sol(vaultSol)} SOL${vaultSol < 5_000_000 ? "  (after the hand-over the vault pays the rent of every config proposal, about 0.002 SOL each, returned when it resolves: send it some SOL)" : ""}`);
  if (phase === "status") {
    const waiting = rows.filter((x) => x.pending && isHandover(x.pending));
    if (r.complete && !covProblems.length) console.log("\nNothing is on the operator key and nothing is pending. `handover.ts check` judges the multisig behind the vault and records the hand-over.");
    else if (waiting.length) {
      const last = Math.max(...waiting.map((x) => x.pending!.effectiveAt));
      const firstExpiry = Math.min(...waiting.map((x) => x.life!.expiresAt));
      const expired = waiting.filter((x) => x.life!.state === "expired");
      if (expired.length) console.log(`\n${expired.length} proposal(s) EXPIRED (${expired.map((x) => x.program).join(", ")}): they can no longer be applied. Run \`handover.ts cancel\`, then \`handover.ts propose\` again.`);
      else console.log(`\n${waiting.length} program(s) proposed. ${last <= now ? `The timelock has passed: run \`handover.ts resolve --print\` and execute the vault transactions before ${iso(firstExpiry)} (in ${span(firstExpiry - now)}); after that the proposals expire and the hand-over starts again.` : `Resolvable from ${iso(last)} (${wait(last - now)}) until ${iso(firstExpiry)}: the proposals expire ${span(ttlOf(waiting[0]!.program))} after they become effective.`}`);
      for (const x of waiting) if (profiles[x.program]?.kind !== "mainnet") console.log(`  note: ${x.program} is not the mainnet build (${profiles[x.program] ? describeProfile(profiles[x.program]!) : "build_profile not read"}); its proposal waits ${x.pending!.timelock} s, not 86400.`);
    } else if (!r.complete) console.log("\nNothing is proposed yet: run `handover.ts propose`.");
    process.exit(r.good && !covProblems.length ? 0 : 1);
  }
  // check: the multisig behind the vault is read and judged now, whatever `propose` saw (R3-09).
  const j = await multisigNow();
  const why = [
    ...covProblems,
    ...(r.good ? [] : ["see the rows marked FAIL"]),
    ...(r.left.length ? [`the operator key still holds: ${nameRoles(r.left)}`] : []),
    ...(r.complete || r.left.length ? [] : ["some authorities have not moved to the vault yet, or a proposal is pending (see the table)"]),
    ...j.problems.map((p) => `the multisig: ${p}`),
    ...guardianIsMember(rows, j),
  ];
  if (!why.length) {
    const exceptions = [...(rec.handover?.exceptions ?? []).filter((x) => !j.exceptions.some((y) => y.id === x.id)), ...j.exceptions.map((x) => ({ id: x.id, phase: "check", at: new Date().toISOString(), detail: x.detail }))];
    const deployed = rows.filter((x) => x.deployed);
    const guardians = [...new Set(deployed.map((x) => x.guardian).filter(Boolean))];
    rec.handover = { ...(rec.handover ?? { multisigVault: v }), multisigVault: v, multisigAccount: multisigAccount!.toBase58(), multisig: j.evidence ?? undefined, at: rec.handover?.at ?? new Date().toISOString(), resolved: { ...(rec.handover?.resolved ?? {}), ...Object.fromEntries(deployed.map((x) => [x.program, rec.handover?.resolved?.[x.program] ?? "observed on chain"])) }, ...(deployed.every((x) => x.frozen) ? { frozen: true } : {}), ...(exceptions.length ? { exceptions } : {}) };
    rec.authorities = { ...(rec.authorities ?? {}), authority: v, upgradeAuthority: deployed.every((x) => x.frozen) ? "none" : v, multisigVault: v, ...(guardians.length === 1 ? { guardian: guardians[0]! } : {}) };
    for (const x of deployed) if (rec.programs[x.program]) rec.programs[x.program]!.upgradeAuthority = x.frozen ? null : x.upgrade;
    saveRecord(mode, rec);
    console.log(`\nNo authority and no role remains on the operator key, and no proposal is pending, on any of the ${deployed.length} deployed program(s).`);
    if (exceptions.length) console.log(`HAND-OVER RECORDED WITH ${exceptions.length} RECORDED EXCEPTION${exceptions.length === 1 ? "" : "S"} (${exceptions.map((x) => x.id).join(", ")}): not a plain pass; verify.ts carries ${exceptions.length === 1 ? "it" : "them"} into its report.`);
    console.log(`next: bun scripts/mainnet/verify.ts ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --expect multisig --write-report, then retire the operator key (MAINNET.md).`);
    process.exit(0);
  }
  fail(`\nHANDOVER INCOMPLETE. Nothing was recorded.\n${why.map((w) => `  - ${w}`).join("\n")}`);
}

// ---- The multisig itself, and the guardian ------------------------------------------------------------------------------------
const problems: string[] = [];
let judgement: MultisigJudgement | null = null;
if (phase !== "cancel") {
  // A hand-over is of everything deployed: a selection that leaves a deployed program out proposes or resolves a part
  // of it and reads as if it were the whole.
  problems.push(...covProblems);
  if (multisigAccount || !DRY) {
    judgement = await multisigNow();
    problems.push(...judgement.problems, ...guardianIsMember(rows, judgement));
  } else console.log("\nnote: --multisig-account not given; the vault is NOT checked against a Squads multisig in this dry run.");
  if (!guardian) problems.push("the guardian key is not known (MAINNET_GUARDIAN, or the record written by init.ts): the hand-over leaves the guardian where it is and must know that it is a key of its own");
  else if (guardian.equals(vault) || guardian.equals(operator)) problems.push("the guardian key is the vault or the operator key: it must be a separate key");
  if (setGuardian) {
    const a = rec.authorities ?? {};
    const taken: [string, string | undefined][] = [["the multisig vault", v], ["the operator key", op], ["the settlement key", a.settlementAuthority], ["the anchorer key", a.anchorAuthority ?? a.anchorer], ["the slasher key", a.slasher], ["the sale key", a.saleAuthority], ["the receipt signing key", a.receiptSigner], ...(judgement?.multisig?.members ?? []).map((m): [string, string] => ["a member of the multisig", m.key])];
    for (const [what, k] of taken) if (k === setGuardian.toBase58()) problems.push(`--set-guardian names ${what}: the guardian must be a key of its own (a pause must not need two of three signers, and the brake must not share a key with what it brakes)`);
    if (PublicKey.default.equals(setGuardian)) problems.push("--set-guardian names the all-zero address");
  }
}
const sendTx = async (ixs: TransactionInstruction[]) => sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...ixs), [signer!], { commitment: "confirmed" });

// ---- cancel -------------------------------------------------------------------------------------------------------------------
if (phase === "cancel") {
  const todo = rows.filter((r) => r.selected && HANDOVER_KIND[r.program] !== "none" && r.pending && r.authority === op);
  if (!todo.length) { console.log("\nNo proposal of the operator key is pending. Nothing to send."); process.exit(0); }
  console.log(`\nWithdrawing ${todo.length} pending proposal(s): ${todo.map((r) => `${r.program}${r.life?.state === "expired" ? " (expired)" : ""}`).join(", ")}`);
  await confirm(mode, `cancel ${todo.length} proposals on ${mode}`, args);
  for (const r of todo) {
    const sig = await sendTx([cancelIx(r.program, ids[r.program], { operator })!]);
    if (rec.handover?.proposals) delete rec.handover.proposals[r.program];
    if (rec.handover?.setGuardian) { delete rec.handover.setGuardian.from[r.program]; if (!Object.keys(rec.handover.setGuardian.from).length) delete rec.handover.setGuardian; }
    saveRecord(mode, rec);
    console.log(`${r.program}: proposal withdrawn  ${explorer(mode, "tx", sig)}`);
  }
  process.exit(0);
}

// ---- propose ------------------------------------------------------------------------------------------------------------------
if (phase === "propose") {
  const plan: { program: ProgramName; what: string; ix: TransactionInstruction }[] = [];
  /** Guardians this proposal replaces (--set-guardian only): program -> the key it carries now. */
  const replaced: Partial<Record<ProgramName, string>> = {};
  console.log("\nPlan (one transaction per program, signed by the operator key)");
  for (const r of rows.filter((x) => x.selected)) {
    const p = r.program;
    console.log(`\n${p}  ${ids[p].toBase58()}`);
    if (!r.deployed || !r.initialised) { problems.push(`${p}: ${r.deployed ? "not initialised" : "not deployed"}: every program of the tier is initialised before any authority moves (an init needs the upgrade authority)`); continue; }
    if (!hasConfigHandover(p)) { console.log(`  nothing to propose: its authority is the anchorer key from init on (${r.authority}). Its upgrade authority moves in the resolve phase.`); if (r.authority === op) problems.push(`${p}: its authority is the operator key. init.ts names the anchorer in the init instruction; this deployment predates that and the anchorer must be handed the authority first (transfer_authority, then the anchorer accepts after 24 h).`); continue; }
    if (r.authority === v) { console.log("  the vault already holds the config authority"); continue; }
    if (r.authority !== op) { problems.push(`${p}: the config authority is ${r.authority}, neither the operator nor the vault`); continue; }
    const profile = profiles[p];
    if (profile?.kind !== "mainnet") {
      const what = `${p} is not the mainnet build: ${profile ? profile.problems.join("; ") : "build_profile was not read"}`;
      if (mode === "mainnet") { problems.push(`${what}. The 24 hours between this proposal and its resolution, and the 7 days it stays valid, are compiled into the program: do not hand over a program that reports other floors (verify.ts shows them).`); continue; }
      console.log(`  note: ${what} (a rehearsal may run the devnet build)`);
    }
    if (r.pending) {
      if (isHandover(r.pending) && r.life?.state === "expired") { problems.push(`${p}: the hand-over proposed earlier expired on ${iso(r.life.expiresAt)} and can no longer be applied. Clear it first (handover.ts cancel), then propose again.`); continue; }
      if (isHandover(r.pending)) { console.log(`  already proposed; resolvable ${wait(r.pending.effectiveAt - now)} (${iso(r.pending.effectiveAt)}) until ${iso(r.life!.expiresAt)}`); continue; }
      problems.push(`${p}: another proposal is pending (new authority ${r.pending.newAuthority ?? "unchanged"}${r.pending.guardian ? `, guardian ${r.pending.guardian}` : ""}${r.pending.other.length ? `, ${r.pending.other.join(", ")}` : ""}). A program holds one proposal at a time: resolve or cancel it first (handover.ts cancel).`);
      continue;
    }
    // The guardian. The proposal sets it ONLY when --set-guardian names the new key; a value from --guardian, the
    // environment or the record that differs from the chain is a mismatch to be explained, never an instruction.
    let newGuardian: PublicKey | null = null;
    if (r.guardian !== null) {
      if (setGuardian) { if (r.guardian !== setGuardian.toBase58()) { newGuardian = setGuardian; replaced[p] = r.guardian; } }
      else if (r.guardian === op || r.guardian === v) { problems.push(`${p}: its guardian is the ${r.guardian === op ? "operator key" : "vault"} (${r.guardian}). The hand-over does not replace a guardian by itself: name the guardian key with --set-guardian <key> to replace it in this proposal.`); continue; }
      else if (guardian && r.guardian !== guardian.toBase58()) { problems.push(`${p}: the guardian on chain is ${r.guardian}, but ${guardianSource} names ${guardian.toBase58()}. The hand-over does not replace a guardian by itself. If the key on chain is right, correct ${guardianSource}; to replace it in this proposal, pass --set-guardian ${guardian.toBase58()} (both keys are shown and a confirmation naming them must be typed).`); continue; }
    }
    const ix = proposeIx(p, ids[p], { operator, vault, guardian: newGuardian })!;
    const what = `${p}: propose new authority = vault${newGuardian ? `, and REPLACES THE GUARDIAN: ${r.guardian} -> ${newGuardian.toBase58()}` : ""}`;
    plan.push({ program: p, what, ix });
    printInstruction(plan.length, what, ix);
  }
  const olds = [...new Set(Object.values(replaced))] as string[];
  if (olds.length) {
    console.log(`\n--set-guardian: this proposal REPLACES THE GUARDIAN of ${Object.keys(replaced).join(", ")}.`);
    table([["old guardian (loses the pause key when the proposal resolves)", olds.join(", ")], ["new guardian", setGuardian!.toBase58()]]);
    console.log("  A wrong key here leaves the pause with nobody once the hand-over resolves; only a 24 h multisig proposal repairs that.");
    for (const old of olds) console.log(`  to confirm you will type exactly:  replace guardian ${old.slice(-6)} with ${setGuardian!.toBase58().slice(-6)}`);
  } else if (setGuardian) console.log(`\n--set-guardian ${setGuardian.toBase58()}: every program to be proposed carries that guardian already; nothing is replaced.`);
  if (DRY) {
    console.log(`\nDry run: ${plan.length} proposal(s) would be sent. Nothing was sent. After them: wait 24 hours, then \`handover.ts resolve\`.`);
    if (problems.length) { console.log(`\nA real run would refuse:\n${problems.map((p) => `  - ${p}`).join("\n")}`); process.exit(1); }
    process.exit(0);
  }
  if (problems.length) fail(`\nRefusing to propose:\n${problems.map((p) => `  - ${p}`).join("\n")}\nNothing was sent.`);
  if (!plan.length) { console.log("\nNothing to propose. `handover.ts status` shows where the hand-over stands."); process.exit(0); }
  console.log(`\nThese ${plan.length} proposals name the vault as the next authority. Nothing changes hands yet: in 24 hours the vault must accept, in a transaction it signs.`);
  console.log("Until then only the operator key can withdraw them (handover.ts cancel); the guardian key cannot. The vault must accept within 7 days of that moment, or the proposals expire and the hand-over starts again.");
  console.log("Open the Squads app, find the vault address there, and compare it with the one above character by character.");
  // The guardian replacement is confirmed by itself, with both keys in the phrase, before anything else is asked.
  for (const old of olds) await confirm(mode, `replace guardian ${old.slice(-6)} with ${setGuardian!.toBase58().slice(-6)}`, args);
  await confirm(mode, `propose handover ${v.slice(-6)}`, args);
  const exceptions = [...(rec.handover?.exceptions ?? []).filter((x) => !(judgement?.exceptions ?? []).some((y) => y.id === x.id)), ...(judgement?.exceptions ?? []).map((x) => ({ id: x.id, phase: "propose", at: new Date().toISOString(), detail: x.detail }))];
  rec.handover = { ...(rec.handover ?? {}), multisigVault: v, multisigAccount: multisigAccount?.toBase58(), multisig: judgement?.evidence ?? rec.handover?.multisig, proposals: rec.handover?.proposals ?? {}, ...(exceptions.length ? { exceptions } : {}) };
  if (olds.length) rec.handover.setGuardian = { to: setGuardian!.toBase58(), from: { ...(rec.handover.setGuardian?.to === setGuardian!.toBase58() ? rec.handover.setGuardian.from : {}), ...replaced }, at: new Date().toISOString() };
  for (const s of plan) {
    const sig = await sendTx([s.ix]);
    const pending = await readPending(conn, s.program, ids[s.program]);
    rec.handover.proposals![s.program] = { signature: sig, proposedAt: new Date().toISOString(), effectiveAt: pending?.effectiveAt ?? 0, expiresAt: pending ? pending.effectiveAt + ttlOf(s.program) : 0 };
    saveRecord(mode, rec);
    console.log(`${s.program}: proposed; effective ${pending ? iso(pending.effectiveAt) : "?"} (timelock ${pending?.timelock ?? "?"} s), expires ${pending ? iso(pending.effectiveAt + ttlOf(s.program)) : "?"}  ${explorer(mode, "tx", sig)}`);
    if (pending && pending.timelock !== profiles[s.program]?.timelock) fail(`${s.program}: the proposal becomes effective after ${pending.timelock} s, but the program's build_profile reports ${profiles[s.program]?.timelock ?? "nothing"} s. Stop: the program does not behave as it says. Cancel the proposals (handover.ts cancel) and investigate.`);
    if (pending && pending.timelock !== 86_400) console.log(`  note: a ${pending.timelock}-second timelock is not the mainnet build's 86400.`);
  }
  if (exceptions.length) console.log(`\nProposed WITH ${exceptions.length} RECORDED EXCEPTION${exceptions.length === 1 ? "" : "S"} (${exceptions.map((x) => x.id).join(", ")}): written into the record; verify.ts carries ${exceptions.length === 1 ? "it" : "them"} into its report.`);
  console.log(`\nnext: bun scripts/mainnet/handover.ts status ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --multisig ${v}   (and after the timelock: resolve)`);
  process.exit(0);
}

// ---- resolve ------------------------------------------------------------------------------------------------------------------
type Resolution = { program: ProgramName; instructions: TransactionInstruction[]; what: string[] };
const resolutions: Resolution[] = [];
console.log(`\nThe resolving transaction of each program (signers: the vault${rows.some((r) => HANDOVER_KIND[r.program] !== "transfer") ? " and the operator key" : ""})`);
let n = 0;
for (const r of rows.filter((x) => x.selected)) {
  const p = r.program;
  console.log(`\n${p}  ${ids[p].toBase58()}`);
  if (!r.deployed || !r.initialised) { problems.push(`${p}: ${r.deployed ? "not initialised" : "not deployed"}`); continue; }
  let config = false;
  if (hasConfigHandover(p) && r.authority !== v) {
    if (!r.pending) { problems.push(`${p}: nothing is proposed. Run \`handover.ts propose\` and wait out the timelock.`); continue; }
    if (!isHandover(r.pending)) { problems.push(`${p}: the pending proposal is not this hand-over (new authority ${r.pending.newAuthority ?? "unchanged"}${r.pending.guardian ? `, guardian ${r.pending.guardian}` : ""}${r.pending.other.length ? `, also ${r.pending.other.join(", ")}` : ""}). Do not resolve it from here.`); continue; }
    if (r.pending.guardian) console.log(`  THIS PROPOSAL ALSO REPLACES THE GUARDIAN: ${r.guardian} -> ${r.pending.guardian} (named with --set-guardian when it was proposed)`);
    if (r.pending.effectiveAt > now) { problems.push(`${p}: the timelock has not passed: resolvable ${wait(r.pending.effectiveAt - now)} (${iso(r.pending.effectiveAt)})`); continue; }
    if (r.life?.state === "expired") { problems.push(`${p}: the proposal expired on ${iso(r.life.expiresAt)}: the programs no longer apply it. Clear it (handover.ts cancel) and propose again.`); continue; }
    console.log(`  resolvable now; the proposal expires ${iso(r.life!.expiresAt)} (in ${span(r.life!.toExpiry)})`);
    config = true;
  }
  const upgrade = !r.frozen && r.upgrade === op;
  if (!r.frozen && r.upgrade !== op && r.upgrade !== v) { problems.push(`${p}: the upgrade authority is ${r.upgrade}, neither the operator nor the vault`); continue; }
  const instructions = resolveInstructions(p, ids[p], { operator, vault, config, upgrade, freeze: FREEZE });
  if (!instructions.length) { console.log("  nothing to send: the vault already holds it"); continue; }
  const what = [...(config ? [HANDOVER_KIND[p] === "transfer" ? "resolve_authority_transfer(accept): the vault accepts" : `${HANDOVER_KIND[p] === "change" ? "resolve_change" : "resolve_config"}(apply): the operator applies, the vault accepts`] : []), ...(upgrade ? [FREEZE ? "upgradeable loader SetAuthority(none)  [IMMUTABLE FOREVER]" : "upgradeable loader SetAuthorityChecked: the operator hands over, the vault accepts"] : [])];
  resolutions.push({ program: p, instructions, what });
  instructions.forEach((ix, i) => printInstruction(++n, what[i]!, ix));
}
if (FREEZE) console.log("\n--freeze-upgrades: the upgrade authority of every program above is REMOVED, not moved. This cannot be undone by anyone.");
if (problems.length) fail(`\nNot resolvable now:\n${problems.map((p) => `  - ${p}`).join("\n")}\nNothing was sent.`);
if (!resolutions.length) { console.log("\nNothing to resolve. Run `handover.ts check`."); process.exit(0); }

// The earliest expiry among the proposals about to be resolved: every vault transaction must execute before it.
const deadline = Math.min(...rows.filter((r) => r.selected && r.life?.state === "applicable" && r.pending && isHandover(r.pending)).map((r) => r.life!.expiresAt));
if (!VIA_STAND_IN) {
  // The transactions the multisig has to make. Written as JSON too, for a script that builds the Squads proposals.
  const file = deploymentsFile(mode).replace(/\.json$/, ".handover-resolve.json");
  writeFileSync(file, JSON.stringify({
    cluster: mode, network: rec.network, vault: v, multisigAccount: multisigAccount?.toBase58() ?? null, operator: op, generatedAt: new Date().toISOString(),
    executeBefore: Number.isFinite(deadline) ? iso(deadline) : null,
    note: "One Squads vault transaction per program, vault index 0. Each instruction is listed with its accounts; an account with signer=true that is not the vault must sign the transaction that EXECUTES the vault transaction (the operator key).",
    transactions: resolutions.map((r) => ({ program: r.program, coSigners: [...new Set(r.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner && !k.pubkey.equals(vault)).map((k) => k.pubkey.toBase58())))], instructions: r.instructions.map((ix, i) => ({ what: r.what[i], programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase64: Buffer.from(ix.data).toString("base64") })) })),
  }, null, 2) + "\n");
  console.log(`\n${resolutions.length} vault transaction(s), ${n} instruction(s). Nothing was sent. The same is written to ${file.split("/").slice(-2).join("/")}.`);
  console.log("How they are executed (scripts/mainnet/README.md, \"The resolve phase\"):");
  console.log("  1. For each program, a member creates a Squads vault transaction (vault 0) with exactly the instructions above and its proposal.");
  console.log("  2. Two members approve it, on their own devices, after comparing every account and the data with this printout.");
  console.log("  3. A member with the execute permission sends the execution WITH the operator key as an additional signer of that transaction");
  console.log("     (the Squads SDK and CLI take extra signers; the web app does not). Without the operator's signature the execution fails and nothing moves.");
  console.log(`  4. bun scripts/mainnet/handover.ts check ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --multisig ${v}`);
  if (Number.isFinite(deadline)) console.log(`Execute all of them before ${iso(deadline)} (in ${span(deadline - now)}): a proposal that is not applied within 7 days of becoming effective expires.`);
  console.log("This execution path has not been run against the real Squads program by this kit; try it first with one program (or on devnet with a second multisig).");
  if (!PRINT) console.log("\n(resolve only prints on mainnet: pass --print to say so explicitly.)");
  process.exit(0);
}

// Rehearsal: the stand-in at the Squads program id signs as the vault, the operator signs the outer transaction.
if (!multisigAccount) fail("--multisig-account is required to execute through the rehearsal vault.", 2);
const standIn = await conn.getAccountInfo(SQUADS_PROGRAM_ID, "confirmed");
if (!standIn?.executable) fail("No program is loaded at the Squads program id on this validator: start it with scripts/mainnet/rehearse.sh, which loads the rehearsal vault there.", 2);
await confirm(mode, FREEZE ? `freeze upgrades forever ${v.slice(-6)}` : `resolve handover ${v.slice(-6)}`, args);
rec.handover = { ...(rec.handover ?? {}), multisigVault: v, multisigAccount: multisigAccount.toBase58(), resolved: rec.handover?.resolved ?? {} };
for (const r of resolutions) {
  const sig = await sendTx([rehearsalVaultExecuteIx(multisigAccount, r.instructions)]);
  rec.handover.resolved![r.program] = sig;
  saveRecord(mode, rec);
  console.log(`${r.program}: ${r.instructions.length} instruction(s) executed as the vault, co-signed by the operator  ${explorer(mode, "tx", sig)}`);
}
({ rows, now } = await read());
console.log("\nAfter the resolution");
const after = report(rows, now);
console.log(after.good && after.complete ? "\nResolved. Run `handover.ts check`: it judges the multisig and records the hand-over." : "\nNot complete yet; see the table.");
process.exit(after.good ? 0 : 1);
