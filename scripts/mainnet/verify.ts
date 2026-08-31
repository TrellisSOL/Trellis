// Verify the mainnet deployment against deployments/mainnet.json and the mainnet parameters (scripts/mainnet/params.ts).
// Read-only. Every program account of the launch tier, the bytes it runs, the build profile those bytes behave as, every
// config decoded through the router's own clients, every authority and role key, and the treasury token accounts.
//
//   bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet                  check; exit 1 on any mismatch
//   bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet --expect multisig   require the after-hand-over state everywhere
//   bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet --write-report   also write the manifest and report the router's production guard reads
//   bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet --env            also print the router environment lines for this deployment
//   bun scripts/mainnet/verify.ts --rehearsal ...                                 the same against a local validator
//   options: --tier / --programs (default: the tier of the record); --allow-devnet-build (rehearsal only)
//            --multisig-account <address>, --multisig-members a,b,c, --multisig-threshold N, --multisig-min-time-lock S
//                              the Squads multisig behind the vault and what it is expected to be (defaults:
//                              MAINNET_MULTISIG_ACCOUNT or the record, and the MAINNET_MULTISIG_* variables)
//            --rebuild         build the selected programs again now (scripts/mainnet/build.sh --force) and compare the
//                              chain with that build, instead of re-hashing the build output already on this machine
//            rehearsal only:   --allow-dirty (an uncommitted tree), --build-dir <dir> (the directory whose binaries were
//                              deployed with --prebuilt), --multisig-untested-ok
//
// What is looked at (security/REVIEW-ROUND3-2026-10.md R3-08, REVIEW-ROUND4 R4-18). The selection says which programs
// are verified in detail; it never says what is deployed, and neither does the record. The ids of all eight programs
// come from the source (`declare_id!`; on mainnet each must also equal Anchor.toml [programs.mainnet], and a record
// that names another id stops the script), every one of them is read, and a selection that leaves a deployed program
// out FAILS (and with tier `minimal` over a deployed program there is no empty success). After the hand-over, "nothing
// on the deployer key" is judged over every deployed program and every role a config holds.
//
// Once the hand-over is recorded (R4-17). When the record carries `handover.at`, a deployed program whose upgrade
// authority or config authority is not the vault FAILS, with or without --expect: a tier deployed afterwards sits on
// the operator key until its own hand-over resolves, and no report is written for that state.
//
// The bytes (R3-10). deploy.sh wrote the sha256 of every .so it deployed into the record, and this script compares the
// program data on chain with that. But the record is a file: equal numbers say only that nobody changed one of them.
// SOURCE EQUIVALENCE is therefore established in THIS run or not claimed at all: the build output of the current source
// is hashed again (the clean default build that scripts/mainnet/build.sh names after the source key of the commit, or
// target/verifiable; with --rebuild it is built again first) and must equal the bytes on chain, from a tree with no
// uncommitted change. When no such build is on this machine the check reads "NOT ESTABLISHED" and FAILS; no report is
// written. An override directory (TRELLIS_SO_DIR) is never consulted, and on mainnet it stops the script.
//
// What makes a file "a build of the current source" (R4-16). Not its place: a binary that lies in target/verifiable
// was built from whatever was checked out when it was built. It is the manifest the build wrote beside it
// (build.json, scripts/mainnet/build.sh; --verifiable for the Docker build), and three equalities, all made here:
//   the manifest's source key  ==  the source key of the commit checked out now (the program sources and lockfiles as
//                                  git holds them at HEAD, exported and hashed: scripts/mainnet/source-state.sh)
//   the manifest's sha256      ==  the sha256 of the file on disk
//   the file's program hash    ==  the program data on chain
// And "clean" is judged by content: an index entry marked skip-worktree or assume-unchanged, or a build path that
// differs from the commit although `git status` shows nothing, is NOT ESTABLISHED. A rehearsal's --allow-dirty and
// --build-dir compare bytes only and say so; mainnet refuses both. (A manifest is a local file like the binary: it
// binds a build to a commit against staleness and mix-ups, not against someone who can write both.)
//
// The build profile (security/REREVIEW-2026-10.md RR-04). The `devnet` cargo feature gives 1-second floors, a 30-second
// timelock, a 60-second pause and a 10-minute proposal expiry with the same IDL and account layouts, so a hash alone
// says nothing to someone who did not make the build. Every one of the eight programs therefore answers build_profile,
// and this script asks EACH deployed program directly (a simulated call: no signature, no account, nothing is sent):
//   - the profile byte must be 0, and every floor it returns must equal the mainnet floor of scripts/mainnet/plan.ts
//     (MAINNET_FLOORS): the 24 h timelock, the 7-day proposal expiry, the 72 h pause and the 7-day guardian cooldown,
//     and each program's own floors (refund delay, dispute window, unbonding, reclaim grace, root retention, ...);
//   - what the program DOES is held against what it says: a proposal below a floor (credits refund delay 72 h - 1 s, bond
//     dispute window 72 h - 1 s, tab reclaim grace 24 h - 1 s), simulated as the authority, must be refused with
//     OutOfBounds, and a proposal that is pending must carry the timelock build_profile reported.
// A program that does not answer build_profile (an older build, or no funded address to pay the simulated fee) FAILS:
// nothing is assumed. --allow-devnet-build (rehearsal only) accepts a build that says it is the devnet one; nothing
// accepts a build that claims profile 0 with another floor.
//
// The pauses and the limiter. A pause is in force only while its flag is set and its expiry lies ahead (72 h after it
// was last set), judged against the cluster's own clock. A pause in force fails verification; a flag that has lapsed is
// reported, since the program is running again. trellis_credits' outflow limiter is read at ["limiter_v2"]: its rate
// must be the expected one and neither allowance may be paused.
//
// Stage. Before the hand-over resolves the deployer holds upgrade authority and config authority ("operator"); after it
// the multisig vault does ("multisig"). Without --expect each program is expected where the record says it is. In both
// stages the guardian is the guardian key (never the deployer, never the vault) and no operational role is the deployer.
//
// Proposals (R3-20). A pending proposal on any deployed program FAILS: a report meant to be green is not written while
// a new settlement key or a new authority is waiting out its timelock. The below-floor probe cannot run while a
// proposal is pending (a program holds one at a time); that too is a failure, not a note.
//
// The multisig (R3-09). Whenever a program is expected on the vault, the Squads multisig account is read and judged in
// this run (scripts/mainnet/squads.ts) and what was read goes into the report. A bypass (--multisig-untested-ok, or one
// recorded by handover.ts) and anything this script cannot establish (the IDL authority) are RECORDED EXCEPTIONS: they
// are listed in the report and the last line then never reads as a plain "all checks passed".
//
// --write-report writes deployments/mainnet.manifest.json and deployments/mainnet.verification.json in the
// trellis.deployments/v1 shape that src/config.ts (contractPathGuards) requires before a production router starts:
// DEPLOYMENT_MANIFEST and DEPLOYMENT_VERIFICATION point at them. The report is written only when every check passes and
// the tree has no uncommitted change. It is a point-in-time snapshot: run it again after the hand-over, after
// adding a tier and after every upgrade. It is not an audit, and says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { bondClaimerPda } from "../../src/solana/programs/capacity.ts";
import { proposeConfigIx as bondProposeConfigIx } from "../../src/solana/programs/bond.ts";
import { DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS, allowanceNow, creditsPdas, limiterBase, proposeConfigIx as creditsProposeConfigIx, settleWindowCap } from "../../src/solana/programs/credits.ts";
import { feeRouterPdas } from "../../src/solana/programs/fee-router.ts";
import { enforcerPda, proposeConfigIx as tabProposeConfigIx } from "../../src/solana/programs/tab.ts";
import { DEPLOYMENT_SCHEMA } from "../../src/config.ts";
import { accountFor, allRoles, coverageOf, coverageProblems, describeGuardianMember, guardianMemberFindings, handoverFindings, handoverStanding, nameRoles } from "./coverage.ts";
import { MAINNET_FLAG, REHEARSAL_FLAG, ROOT, TIER_OPTIONS, assertCluster, buildEnvironment, connect, deploymentsFile, expectFlags, fail, loadRecord, manifestBindingProblem, modeOf, optionalPubkey, parseArgs, programIds, readBuildManifest, rpcHost, rpcUrl, selection, sourceProblem, sourceState, type ProgramName } from "./lib.ts";
import { MAINNET_USDC, PARAMS, USDC } from "./params.ts";
import { MAINNET_FLOORS, MAINNET_GUARDIAN_COOLDOWN_SECONDS, MAINNET_PROPOSAL_TTL_SECONDS, MAINNET_TIMELOCK_SECONDS, decodePending, describeProfile, pauseFields, pauseView, pendingAddress, proposalLifecycle, readPending, slotProgram, tokenAccountsNeeded, type PauseSlot, type ProfileReading } from "./plan.ts";
import { describeMultisig, judgeMultisig, multisigExpectation, type MultisigJudgement } from "./squads.ts";
import { chainTime, fundedPayer, holders, programHash, readBuildProfile, readChainState, simulateInstructions } from "./state.ts";
import { anchorModeOf, routerTier } from "./tiers.ts";

const args = parseArgs(process.argv.slice(2), ["--expect", "--multisig-account", "--multisig-members", "--multisig-threshold", "--multisig-min-time-lock", "--build-dir", ...TIER_OPTIONS]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--write-report", "--env", "--allow-dirty", "--allow-devnet-build", "--rebuild", "--multisig-untested-ok"]);
const mode = modeOf(args);
// Rehearsal-only overrides: each is refused on mainnet before anything is read.
if (args.options.has("--build-dir") && mode === "mainnet") fail("--build-dir is for rehearsals only: on mainnet the chain is compared with the build of this repository's source (scripts/mainnet/build.sh, or target/verifiable), never with a directory named at verify time.", 2);
if (args.flags.has("--multisig-untested-ok") && mode === "mainnet") fail("--multisig-untested-ok is for rehearsals only here: a bypass accepted at `handover.ts propose` is read from the record and reported.", 2);
// A rehearsal may write its report from an uncommitted tree, to exercise the router's production guard; mainnet may not.
if (args.flags.has("--allow-dirty") && mode === "mainnet") fail("--allow-dirty is for rehearsals only: a mainnet report must name the commit the programs were built from.", 2);
if (args.flags.has("--allow-devnet-build") && mode === "mainnet") fail("--allow-devnet-build is for rehearsals only: on mainnet a program that does not behave as the mainnet build fails verification.", 2);
const ALLOW_DEVNET = args.flags.has("--allow-devnet-build");
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const rec = loadRecord(mode, genesis);
const { tier, programs: selected } = selection(args, rec);
const expectArg = args.options.get("--expect");
if (expectArg && expectArg !== "operator" && expectArg !== "multisig") fail("--expect takes operator or multisig", 2);
const a = rec.authorities ?? {};
const deployer = rec.deployer;
const usdc = MAINNET_USDC;
const vault = a.multisigVault ?? rec.handover?.multisigVault;
const ALLOW_DIRTY = args.flags.has("--allow-dirty");
/** Bypasses and things this run could not establish. Any entry here means the result is not a plain pass. */
const exceptions: { id: string; detail: string }[] = (rec.handover?.exceptions ?? []).map((x) => ({ id: x.id, detail: `${x.detail ?? x.id} (recorded by handover.ts ${x.phase} at ${x.at})` }));
const except = (id: string, detail: string) => { if (!exceptions.some((x) => x.id === id)) exceptions.push({ id, detail }); else exceptions.find((x) => x.id === id)!.detail = detail; };
const measured: Partial<Record<ProgramName, number | null>> = {};
const readings: Partial<Record<ProgramName, ProfileReading>> = {};

let failures = 0;
const failed: string[] = [];
const ok = (cond: boolean, what: string) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) { failures++; failed.push(what); } };
const note = (what: string) => console.log(`  note ${what}`);
const same = (k: PublicKey | string | null | undefined, want: string | undefined) => !!k && !!want && (typeof k === "string" ? k : k.toBase58()) === want;

// All eight ids are read, whatever was selected and whatever the record lists: the ids come from the source
// (declare_id!; lib.ts programIds), and what is DEPLOYED comes from the chain (R4-18).
const ids = programIds(mode, rec, selected);
const state = await readChainState(conn, ids, { hash: true });
const cov = coverageOf(selected, state, rec);
const covProblems = coverageProblems(cov, tier, selected);
if (!selected.length && !cov.deployed.length) {
  console.log(`verifying ${mode} on ${rpcHost(url)} (genesis ${genesis}); tier ${tier}: no Trellis program is deployed at an id this deployment reserves.`);
  console.log("Nothing on chain to verify. Receipt roots are memo transactions signed by the anchorer key; the router needs no deployment manifest (its deployment status is \"none\").");
  if (args.flags.has("--env")) printEnv();
  process.exit(0);
}
if (!deployer) fail("The record names no deployer; run deploy.sh and init.ts first.", 2);
if (expectArg === "multisig" && !vault) fail("The record names no multisig vault.", 2);
/** Where each program's upgrade authority and config authority are expected: the vault once its hand-over resolved. */
const stageOf = (p: ProgramName): "operator" | "multisig" => (expectArg as "operator" | "multisig" | undefined) ?? (rec.handover?.resolved?.[p] || (rec.handover?.at && !rec.handover.resolved) ? "multisig" : "operator");
const holderOf = (p: ProgramName) => (stageOf(p) === "multisig" ? vault! : deployer);
const stages = new Set(selected.map(stageOf));
const stage: "operator" | "multisig" | "mixed" = stages.size === 1 ? [...stages][0]! : stages.size === 0 ? ((expectArg as "operator" | "multisig" | undefined) ?? "operator") : "mixed";

console.log(`verifying ${mode} on ${rpcHost(url)} (genesis ${genesis}); tier ${tier} (${selected.join(", ") || "no program"}); stage: ${stage}\n`);
console.log(`deployed at the ids this deployment reserves: ${cov.found.join(", ") || "none"}`);
ok(!covProblems.length, covProblems.length ? `the selection covers every deployed program: ${covProblems.join("; ")}` : `the selection (tier ${tier}) covers every deployed program`);
for (const p of cov.recorded.filter((x) => !cov.found.includes(x))) ok(false, `${p}: the record lists it as deployed and the chain has no program at its id`);
console.log("");

const now = await chainTime(conn);
// build_profile is simulated with any address that holds SOL as the fee payer: it signs nothing and nothing is sent.
const simulationPayer = await fundedPayer(conn, [deployer, vault, a.guardian, a.settlementAuthority, a.anchorAuthority ?? a.anchorer, a.slasher]);

// ---- Simulation as the authority: nothing is sent, no signature is needed -------------------------------------------------
const errorCode = (logs: string[]) => { const l = logs.find((x) => /Error Code: \w+/.test(x)); return l ? /Error Code: (\w+)/.exec(l)![1]! : null; };
/** A proposal one second below a floor, simulated: the mainnet build answers OutOfBounds. */
async function floorRefused(p: ProgramName, authority: PublicKey): Promise<{ what: string; code: string | null; skipped?: string; odd?: string; note?: string } | null> {
  const below = { trellis_credits: ["refund delay 72 h - 1 s", () => creditsProposeConfigIx(ids[p], { authority, refundDelay: 72n * 3600n - 1n })], trellis_bond: ["dispute window 72 h - 1 s", () => bondProposeConfigIx(ids[p], { authority, disputeWindow: 72n * 3600n - 1n })], trellis_tab: ["reclaim grace 24 h - 1 s", () => tabProposeConfigIx(ids[p], { authority, reclaimGrace: 24n * 3600n - 1n })] } as Partial<Record<ProgramName, [string, () => TransactionInstruction]>>;
  const probe = below[p];
  if (!probe) return null;
  // A proposal is an account the PROGRAM owns at this address. Anyone can send lamports to the address: that makes a
  // system account there, which is no proposal and stops neither the program's next proposal nor this probe (R4-29).
  const address = pendingAddress(p, ids[p]);
  const at = await conn.getAccountInfo(address, "confirmed");
  let noteText: string | undefined;
  if (at && at.owner.equals(ids[p])) {
    if (decodePending(p, at.data)) return { what: probe[0], code: null, skipped: "a proposal is pending and a program holds one at a time, so a second one cannot be simulated" };
    return { what: probe[0], code: null, odd: `the pending-proposal address ${address.toBase58()} holds an account owned by the program that does not decode as a proposal` };
  }
  if (at) noteText = `the pending-proposal address ${address.toBase58()} holds lamports in an account the program does not own (owner ${at.owner.toBase58()}): somebody sent SOL there; it is not a proposal, and the program's next proposal takes the address over`;
  const r = await simulateInstructions(conn, authority, [probe[1]()]);
  return { what: probe[0], code: r.err ? errorCode(r.logs) ?? JSON.stringify(r.err) : "accepted", note: noteText };
}

// ---- Programs ---------------------------------------------------------------------------------------------------------------
// ---- Source equivalence: established now, from a build output hashed in this run, or not at all (R3-10) --------------------
const src = sourceState();
const treeProblem = sourceProblem(src);
// The commit this run can cite: the kit's own HEAD (on mainnet the source root IS this repository, clean).
const kitRevision = (() => { const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; })();
const buildDirArg = args.options.get("--build-dir");
if (args.flags.has("--rebuild") && buildDirArg) fail("--rebuild and --build-dir contradict each other.", 2);
if (args.flags.has("--rebuild") && selected.length) {
  console.log("rebuilding the selected programs (scripts/mainnet/build.sh --force): the chain is compared with THIS build");
  const r = Bun.spawnSync(["bash", join(ROOT, "scripts/mainnet/build.sh"), "--programs", selected.join(","), "--force", ...(ALLOW_DIRTY ? ["--allow-dirty"] : [])], { stdout: "pipe", stderr: "inherit", env: buildEnvironment(process.env) });
  if (r.exitCode !== 0) fail("The rebuild did not complete, so nothing can be compared with the chain.", 1);
}
/**
 * Where the build output of the CURRENT source may lie, most specific first. Nothing here comes from the environment
 * or from the record: the clean build's directory is named after the hash of the sources as they are now.
 */
// The key the build of the CURRENT source is named after: the commit's (what git holds at HEAD), or, for a rehearsal
// whose source no commit names, the key of the tree as it lies.
const currentKey = !treeProblem && /^[0-9a-f]{64}$/.test(src.headKey) ? src.headKey : src.sourceKey;
const buildCandidates: { dir: string; method: string }[] = buildDirArg
  ? [{ dir: resolve(buildDirArg), method: "re-hashed --build-dir (rehearsal only: the directory deployed with --prebuilt)" }]
  : [
    { dir: join(ROOT, ".data/mainnet-build", currentKey), method: `${args.flags.has("--rebuild") ? "rebuilt in this run" : "re-hashed the clean default build of this source"} (scripts/mainnet/build.sh, source key ${currentKey.slice(0, 16)})` },
    { dir: join(src.root, "target/verifiable"), method: "re-hashed target/verifiable (the Docker build; not rebuilt in this run)" },
  ];
/**
 * Whether a binary must be BOUND to the commit by its build manifest (R4-16): always, except in a rehearsal that said
 * its source is not a commit (--allow-dirty), where there is no commit to bind to and bytes alone are compared.
 */
const BIND = !ALLOW_DIRTY;
type ManifestSeen = { kind: string | null; sourceKey: string | null; sourceCommit: string | null; sourceTree: string | null; sha256: string | null };
type Equivalence = { established: boolean; onChainSha256: string | null; buildSha256: string | null; method: string | null; file: string | null; recorded: string | null; why: string | null; manifest: ManifestSeen | null; bound: boolean };
const equivalence: Partial<Record<ProgramName, Equivalence>> = {};
const shownPath = (path: string) => path.replace(ROOT + "/", "");
function sourceEquivalence(p: ProgramName, onChain: string | null): Equivalence {
  const base = { onChainSha256: onChain, recorded: rec.programs[p]?.soHash ?? null };
  const seen: { file: string; sha: string; method: string }[] = [];
  const unbound: { file: string; sha: string; method: string; why: string; manifest: ManifestSeen | null }[] = [];
  for (const c of buildCandidates) {
    const file = join(c.dir, `${p}.so`);
    if (!existsSync(file)) continue;
    const sha = programHash(readFileSync(file));
    const m = readBuildManifest(c.dir);
    const manifest: ManifestSeen | null = m ? { kind: m.kind ?? null, sourceKey: m.sourceKey ?? null, sourceCommit: m.sourceCommit ?? null, sourceTree: m.sourceTree ?? null, sha256: m.programs?.[p]?.sha256 ?? null } : null;
    if (onChain && sha === onChain) {
      // The bytes are the chain's. Whether they are a build of THIS commit is the manifest's to say, not the directory's.
      const why = BIND ? manifestBindingProblem(c.dir, p, src.headKey, shownPath(c.dir)) : null;
      if (!why) return { ...base, established: true, buildSha256: sha, method: c.method, file: shownPath(file), why: null, manifest, bound: BIND };
      unbound.push({ file: shownPath(file), sha, method: c.method, why, manifest });
      continue;
    }
    seen.push({ file: shownPath(file), sha, method: c.method });
  }
  if (unbound.length) return { ...base, established: false, buildSha256: unbound[0]!.sha, method: unbound[0]!.method, file: unbound[0]!.file, manifest: unbound[0]!.manifest, bound: false, why: `the on-chain bytes equal ${unbound[0]!.file}, but nothing binds that file to the commit checked out now: ${unbound.map((x) => x.why).join("; ")}` };
  if (seen.length) return { ...base, established: false, buildSha256: seen[0]!.sha, method: seen[0]!.method, file: seen[0]!.file, manifest: null, bound: false, why: `the on-chain bytes (sha256 ${onChain}) differ from ${seen.map((x) => `${x.file} (sha256 ${x.sha})`).join(" and from ")}` };
  return { ...base, established: false, buildSha256: null, method: null, file: null, manifest: null, bound: false, why: `NOT ESTABLISHED: no build output of the current source is on this machine (looked for ${p}.so in ${buildCandidates.map((c) => c.dir.replace(ROOT + "/", "")).join(" and ")}). Build it (scripts/mainnet/build.sh, or verify.ts --rebuild, or anchor build --verifiable) and run this again; the recorded hash alone establishes nothing` };
}
if (selected.length) ok(!treeProblem || ALLOW_DIRTY, treeProblem ? `source equivalence: ${ALLOW_DIRTY ? `the commit does not name the source (${treeProblem}); accepted for this rehearsal only (--allow-dirty)` : `NOT ESTABLISHED: ${treeProblem}${mode === "rehearsal" ? " (a rehearsal may pass --allow-dirty)" : ""}`}` : `the source tree is clean at commit ${src.commit}: a build of it is a build of that commit`);
const mismatches: string[] = [];
const pendingProposals: Partial<Record<ProgramName, boolean>> = {};
const c = state.configs;
const authorityOf = (p: ProgramName) => holders(state).find((h) => h.program === p && h.role === "authority")?.address ?? null;
const guardianOf = (p: ProgramName) => holders(state).find((h) => h.program === p && h.role === "guardian")?.address ?? null;
for (const p of selected) {
  const s = state.programs[p];
  console.log(`${p} ${s.programId}`);
  ok(s.deployed && s.executable, "deployed and executable");
  ok(s.upgradeable, "owned by the upgradeable loader");
  if (!s.deployed) continue;
  console.log(`  programdata ${s.programData} last deployed in slot ${s.lastDeploySlot} holds ${s.dataLen} bytes, sha256 ${s.dataSha256}`);
  if (rec.handover?.frozen && stageOf(p) === "multisig") ok(s.frozen, "upgrade authority removed (frozen)");
  else ok(same(s.upgradeAuthority, holderOf(p)), `upgrade authority ${s.upgradeAuthority ?? "none (frozen)"} is the ${stageOf(p) === "multisig" ? "multisig vault" : "deployer"}`);
  ok(rec.programs[p]?.programId === s.programId, "program id matches the record");
  // The recorded hash is what deploy.sh deployed after the preflight read its build profile; the chain must still hold those bytes.
  const recorded = rec.programs[p]?.soHash;
  const equal = !!recorded && recorded === s.dataSha256;
  ok(equal, recorded ? `on-chain bytes equal the hash deploy.sh recorded (${recorded})` : "the record carries the hash of the deployed binary (soHash); deploy with scripts/mainnet/deploy.sh so that it does");
  if (!equal) mismatches.push(p);
  const recordedProfile = rec.programs[p]?.profile;
  ok(recordedProfile === "mainnet" || (ALLOW_DEVNET && recordedProfile === "devnet"), `the preflight read those bytes' build_profile as the ${recordedProfile ?? "unknown"} build before the deploy${recordedProfile === "devnet" ? " (accepted for this rehearsal only)" : ""}`);
  // Where deploy.sh says this program came from; the comparison below is with the source as it is NOW.
  const from = rec.programs[p];
  if (from?.sourceCommit) note(`deployed from commit ${from.sourceCommit} (tree: ${from.sourceTree ?? "not recorded"}; ${from.buildKind ?? "build not recorded"})${from.sourceKey && from.sourceKey !== currentKey && !buildDirArg ? `; the program sources have changed since (source key then ${from.sourceKey.slice(0, 16)}, now ${currentKey.slice(0, 16)}): the chain is compared with a build of the sources as they are now` : ""}`);
  const eq = sourceEquivalence(p, s.dataSha256);
  equivalence[p] = eq;
  ok(eq.established, eq.established ? `source equivalence: the on-chain bytes equal ${eq.file} (sha256 ${eq.buildSha256}), ${eq.method}${eq.bound ? `; build.json binds it to source key ${String(eq.manifest?.sourceKey).slice(0, 16)} of commit ${String(eq.manifest?.sourceCommit).slice(0, 12)}, the commit checked out now` : "; bytes only: no commit names this rehearsal's source, so no manifest binds the file to one"}` : `source equivalence: ${eq.why}`);
  // The build, asked of the program itself: build_profile, for every program.
  const reading = await readBuildProfile(conn, p, ids[p], simulationPayer);
  readings[p] = reading;
  measured[p] = reading.timelock;
  const devnetAccepted = ALLOW_DEVNET && reading.kind === "devnet";
  ok(reading.kind === "mainnet" || devnetAccepted, reading.profile === null
    ? `build_profile read on chain: ${reading.problems.join("; ")}`
    : `build_profile read on chain: ${describeProfile(reading)}: ${reading.kind === "mainnet" ? `the mainnet build (all ${Object.keys(MAINNET_FLOORS[p]).length} floors)` : reading.kind === "devnet" ? `the devnet build${devnetAccepted ? " (accepted for this rehearsal only)" : ""}` : "NOT a build this kit knows"}${reading.kind === "mainnet" ? "" : ` [${reading.problems.join("; ")}]`}`);
  ok(reading.timelock === MAINNET_TIMELOCK_SECONDS || devnetAccepted, `config timelock read on chain: ${reading.timelock ?? "not read"} s${reading.timelock === MAINNET_TIMELOCK_SECONDS ? " (24 h)" : devnetAccepted ? " (the devnet build; accepted for this rehearsal only)" : `; the mainnet build has ${MAINNET_TIMELOCK_SECONDS}`}`);
  // What it does, against what it says: a proposal below a floor, simulated as the authority.
  const authorityKey = authorityOf(p);
  if (!authorityKey) { ok(false, "the program has a config (run init.ts): its floors can then be tried as its authority"); continue; }
  const floor = await floorRefused(p, new PublicKey(authorityKey));
  if (floor?.note) note(floor.note);
  if (floor?.skipped) ok(false, `the below-floor probe (${floor.what}) could not be run: ${floor.skipped}. What the program does is then not held against what it says`);
  else if (floor?.odd) ok(false, `the below-floor probe (${floor.what}) could not be run: ${floor.odd}`);
  else if (!floor) note("no below-floor probe exists for this program: its floors are read from build_profile only (a probe exists for trellis_credits, trellis_bond and trellis_tab)");
  else if (floor) ok(floor.code === "OutOfBounds" || devnetAccepted, `a proposal below the floor (${floor.what}) is ${floor.code === "OutOfBounds" ? "refused with OutOfBounds" : `answered with ${floor.code}`}${floor.code !== "OutOfBounds" && devnetAccepted ? " (the devnet build has 1-second floors; accepted for this rehearsal only)" : floor.code !== "OutOfBounds" ? ` (the authority ${authorityKey} must hold SOL for the simulation to reach the program)` : ""}`);
  // A proposal that is pending is a change that has not happened yet: a new settlement key, a new authority, a new
  // guardian. Whatever it is, the deployment is not in the state a green result would vouch for (R3-20).
  const open = await readPending(conn, p, ids[p]);
  pendingProposals[p] = !!open;
  if (!open && floor?.odd) { ok(false, `no proposal is pending: ${floor.odd}; what it is cannot be said`); continue; }
  if (open) {
    const ttl = Number(reading.floors.proposalTtl ?? MAINNET_PROPOSAL_TTL_SECONDS);
    const life = proposalLifecycle(open, now, ttl);
    ok(open.timelock === reading.timelock, `the pending proposal's timelock (${open.timelock} s) is the one build_profile reported`);
    ok(false, `no proposal is pending: a proposal is PENDING (${life.state}): new authority ${open.newAuthority ?? "unchanged"}, guardian ${open.guardian ?? "unchanged"}${open.other.length ? `, also ${open.other.join(", ")}` : ""}; effective ${new Date(open.effectiveAt * 1000).toISOString()}, expires ${new Date(life.expiresAt * 1000).toISOString()}. ${life.state === "expired" ? "It can no longer be applied: clear it (handover.ts cancel) and propose again." : "If this is not the hand-over you proposed, cancel it with the authority key (handover.ts cancel); the guardian cannot. Verify again once it has resolved."}`);
  } else ok(true, "no proposal is pending");
}
if (state.legacy.length) for (const p of state.legacy.filter((x) => selected.includes(x))) ok(false, `${p}: its config is in the layout of an earlier build (no paused_until); run init.ts, which grows it with migrate_config`);

// ---- Configs ----------------------------------------------------------------------------------------------------------------
const has = (p: ProgramName) => selected.includes(p);
const section = (p: ProgramName) => console.log(`\n${p} config ${state.configAddresses[p]}`);
// Every pause slot, judged against the cluster's clock: in force only while the flag is set and its expiry lies ahead.
const views = new Map(pauseFields(c, state.limiter).map((f) => [f.slot, pauseView(f, now, Number(readings[slotProgram(f.slot)]?.floors.guardianPauseCooldown ?? MAINNET_GUARDIAN_COOLDOWN_SECONDS))]));
const paused = (slot: PauseSlot, what: string) => {
  const v = views.get(slot);
  if (!v) { ok(false, `${what} (the pause state could not be read)`); return; }
  ok(!v.active, v.active ? `${what}: PAUSED until ${new Date(v.until * 1000).toISOString()} (set by the ${v.by}; it lapses by itself then unless the authority renews it)` : what);
  if (v.lapsed) note(`${slot}: the pause flag is still set but the pause lapsed at ${new Date(v.until * 1000).toISOString()}; the program runs again. The authority clears the flag with pause.ts --unpause.`);
  if (v.guardianInCooldown) note(`${slot}: the guardian cannot pause this again before ${new Date(v.guardianReadyAt * 1000).toISOString()}; until then only the authority can`);
};
const guardianOk = (g: PublicKey, p: ProgramName) => {
  ok(same(g, a.guardian), `guardian ${g.toBase58()} is the recorded guardian key`);
  ok(!same(g, deployer) && !same(g, vault) && !same(g, authorityOf(p) ?? undefined), "the guardian is a key of its own: not the deployer, not the multisig vault, not the authority");
};

if (has("trellis_credits")) {
  section("trellis_credits");
  if (!c.trellis_credits) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_credits;
    ok(same(x.authority, holderOf("trellis_credits")), `authority ${x.authority.toBase58()}`);
    guardianOk(x.guardian, "trellis_credits");
    ok(same(x.settlementAuthority, a.settlementAuthority), `settlement authority ${x.settlementAuthority.toBase58()} is the recorded settlement key`);
    ok(same(x.usdcMint, usdc), `USDC mint ${x.usdcMint.toBase58()}`);
    ok(x.vault.equals(creditsPdas(ids.trellis_credits).vault), `vault ${x.vault.toBase58()} is the program's ["vault"] PDA`);
    ok(same(x.treasuryTokenAccount, rec.accounts?.treasuryUsdc), `treasury ${x.treasuryTokenAccount.toBase58()}`);
    ok(x.maxBalancePerKey === PARAMS.credits.maxBalancePerKey && x.maxBalancePerKey <= USDC(5_000), `cap per key ${x.maxBalancePerKey} (5,000 USDC)`);
    ok(x.creditTtl === PARAMS.credits.creditTtl, `credit TTL ${x.creditTtl} s (365 d)`);
    ok(x.refundDelay === PARAMS.credits.refundDelay, `refund delay ${x.refundDelay} s (72 h)`);
    ok(x.expiryGrace === PARAMS.credits.expiryGrace, `expiry grace ${x.expiryGrace} s (30 d)`);
    paused("trellis_credits.deposits", "deposits not paused");
    console.log(`  spent_total ${x.spentTotal} settled_total ${x.settledTotal}`);
    // The outflow limiter: two continuously refilled allowances at ["limiter_v2"] (security/REREVIEW-2026-10.md RR-01).
    const l = state.limiter;
    if (!l) ok(false, `outflow limiter ${state.limiterAddress} decodes (["limiter_v2"]; a config from an earlier build gets it with init.ts)`);
    else {
      ok(l.rateBps === PARAMS.credits.settleRateBps, `outflow limiter ${state.limiterAddress}: rate ${l.rateBps} bps of the vault per 24 h (expected ${PARAMS.credits.settleRateBps})`);
      paused("trellis_credits.settlements", "settlements not paused");
      const vaultInfo = await conn.getAccountInfo(x.vault, "confirmed");
      const balance = vaultInfo && vaultInfo.owner.equals(TOKEN_PROGRAM_ID) ? unpackAccount(x.vault, vaultInfo, TOKEN_PROGRAM_ID).amount : null;
      ok(l.capPerWindow === DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS, `outflow limiter: cap per window ${l.capPerWindow} (expected ${DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS}: 25,000 USDC, whatever the vault holds)`);
      if (balance !== null) {
        const window = Number(readings.trellis_credits?.floors.settleWindow ?? 86_400n);
        const cap = settleWindowCap(limiterBase(l, balance, now, window), l.rateBps, l.capPerWindow);
        console.log(`  vault ${balance}; per-window cap ${cap}; payable now: settlements ${allowanceNow(l, "settle", balance, now, window)}, refunds ${allowanceNow(l, "refund", balance, now, window)}`);
      }
    }
    if (state.legacyLimiter) note("the first limiter's account ([\"limiter\"]) still exists; no instruction reads it any more");
  }
}
if (has("trellis_anchor")) {
  section("trellis_anchor");
  if (!c.trellis_anchor) ok(false, "signer set decodes (initialised?)");
  else {
    const x = c.trellis_anchor;
    ok(same(x.authority, a.anchorAuthority), `authority ${x.authority.toBase58()} is the recorded anchorer key (it posts the hourly roots; by design not the multisig)`);
    if (x.rotationCount === 0n) ok(same(x.currentSigner, a.receiptSigner), `current signer ${x.currentSigner.toBase58()} is the recorded first receipt signing key`);
    else note(`the receipt signer was rotated ${x.rotationCount} time(s); current ${x.currentSigner.toBase58()}, previous ${x.previousSigner.toBase58()} (the router publishes its keys at /.well-known/trellis-receipt-keys.json)`);
  }
}
if (has("trellis_rules")) {
  section("trellis_rules");
  if (!c.trellis_rules) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_rules;
    ok(same(x.authority, holderOf("trellis_rules")), `authority ${x.authority.toBase58()}`);
    guardianOk(x.guardian, "trellis_rules");
    ok(x.enforcer.equals(enforcerPda(ids.trellis_tab)), `enforcer is trellis_tab's ["enforcer"] PDA ${x.enforcer.toBase58()}`);
    paused("trellis_rules", "new rulebooks not paused");
  }
}
if (has("trellis_tab")) {
  section("trellis_tab");
  if (!c.trellis_tab) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_tab;
    ok(same(x.authority, holderOf("trellis_tab")), `authority ${x.authority.toBase58()}`);
    guardianOk(x.guardian, "trellis_tab");
    ok(same(x.usdcMint, usdc), `USDC mint ${x.usdcMint.toBase58()}`);
    ok(x.rulesProgram.equals(ids.trellis_rules), `rules program ${x.rulesProgram.toBase58()}${has("trellis_rules") ? "" : " (the id reserved for trellis_rules; not deployed in this tier, so rulebook-bound tabs cannot be opened yet)"}`);
    ok(x.maxCap === PARAMS.tab.maxCap && x.maxCap <= USDC(500), `tab cap ${x.maxCap} (500 USDC)`);
    ok(x.reclaimGrace === PARAMS.tab.reclaimGrace, `reclaim grace ${x.reclaimGrace} s (24 h)`);
    paused("trellis_tab", "not paused");
  }
}
if (has("trellis_bond")) {
  section("trellis_bond");
  if (!c.trellis_bond) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_bond;
    ok(same(x.authority, holderOf("trellis_bond")), `authority ${x.authority.toBase58()}`);
    guardianOk(x.guardian, "trellis_bond");
    ok(same(x.slasher, a.slasher), `slasher ${x.slasher.toBase58()} is the recorded slasher key`);
    ok(same(x.usdcMint, usdc), `USDC mint ${x.usdcMint.toBase58()}`);
    ok(x.minBond === PARAMS.bond.minBond, `minimum bond ${x.minBond} (10,000 USDC)`);
    ok(x.unbondPeriod === PARAMS.bond.unbondPeriod, `unbond period ${x.unbondPeriod} s (14 d)`);
    ok(x.disputeWindow === PARAMS.bond.disputeWindow, `dispute window ${x.disputeWindow} s (72 h)`);
    ok(x.disputeBlock === PARAMS.bond.disputeBlock, `dispute block ${x.disputeBlock} s (7 d)`);
    ok(x.capacityClaimer.equals(bondClaimerPda(ids.trellis_capacity)), `capacity claimer is trellis_capacity's ["bond_claimer"] PDA`);
    ok(same(x.refundPool, rec.accounts?.refundPool), `refund pool ${x.refundPool.toBase58()}`);
    ok(same(x.treasury, rec.accounts?.treasuryUsdc), `treasury ${x.treasury.toBase58()}`);
    ok(same(x.capacityRefund, rec.accounts?.capacityRefund), `capacity refund ${x.capacityRefund.toBase58()}`);
    paused("trellis_bond", "not paused");
  }
}
if (has("trellis_fee_router")) {
  section("trellis_fee_router");
  if (!c.trellis_fee_router) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_fee_router;
    const pdas = feeRouterPdas(ids.trellis_fee_router);
    ok(same(x.authority, holderOf("trellis_fee_router")), `authority ${x.authority.toBase58()}`);
    ok(same(x.feeMint, usdc), `fee mint ${x.feeMint.toBase58()}`);
    ok(same(x.trlsMint, rec.mints?.trls), `$TRLS mint ${x.trlsMint.toBase58()}`);
    ok(x.feeVault.equals(pdas.feeVault) && x.trlsVault.equals(pdas.trlsVault), "fee and $TRLS vaults are the program's PDAs");
    ok(x.workersBps === PARAMS.feeRouter.workersBps && x.treasuryBps === PARAMS.feeRouter.treasuryBps, `split ${x.workersBps}/${x.treasuryBps} bps (no fee split: 0/10000)`);
    ok(same(x.workersVault, rec.accounts?.workersVault), `workers vault ${x.workersVault.toBase58()}`);
    ok(same(x.treasuryVault, rec.accounts?.treasuryUsdc), `treasury vault ${x.treasuryVault.toBase58()}`);
    console.log(`  distributed_total ${x.distributedTotal} burned_total ${x.burnedTotal}`);
  }
}
if (has("trellis_capacity")) {
  section("trellis_capacity");
  if (!c.trellis_capacity) ok(false, "config decodes (initialised?)");
  else {
    const x = c.trellis_capacity;
    ok(same(x.authority, holderOf("trellis_capacity")), `authority ${x.authority.toBase58()}`);
    guardianOk(x.guardian, "trellis_capacity");
    ok(same(x.saleAuthority, a.saleAuthority), `sale authority ${x.saleAuthority.toBase58()}`);
    ok(same(x.hvxAuthority, a.hvxAuthority), `HVX authority ${x.hvxAuthority.toBase58()}`);
    const want = String(rec.parameters?.gradePricesUsdcPerBushel ?? "").split(",").filter(Boolean).map((n) => USDC(Number(n)));
    ok(x.gradePrices.length === 3 && want.length === 3 && x.gradePrices.every((p, i) => BigInt(p) === want[i]), `grade prices ${x.gradePrices.join(",")} match the record (${rec.parameters?.gradePricesUsdcPerBushel} USDC per Bushel)`);
    ok(x.maxOutstandingValue === PARAMS.capacity.maxOutstandingValue && x.maxOutstandingValue <= USDC(250_000), `max prepaid capacity outstanding ${x.maxOutstandingValue} (250,000 USDC)`);
    // A capacity pause is a legitimate launch state (init.ts --pause-capacity), so it is reported, not failed.
    const cv = views.get("trellis_capacity");
    console.log(`  outstanding_value ${x.outstandingValue} paused ${cv?.active ? `until ${new Date(cv.until * 1000).toISOString()} (it lapses by itself then)` : cv?.lapsed ? "flag set, but the pause lapsed: commitments and sales run again" : "no"}`);
  }
}
if (has("trellis_measurements")) {
  section("trellis_measurements");
  if (!c.trellis_measurements) ok(false, "registry decodes (initialised?)");
  else {
    const x = c.trellis_measurements;
    ok(same(x.authority, holderOf("trellis_measurements")), `authority ${x.authority.toBase58()}`);
    console.log(`  registered ${x.registered} revoked ${x.revoked}`);
  }
}

// ---- Roles: nothing operational on the deployer, and after the hand-over nothing at all ------------------------------------
// Judged over EVERY deployed program and every role a config holds (scripts/mainnet/coverage.ts), not over the selection.
console.log("\nrole separation (every deployed program)");
const roles = await allRoles(conn, state);
const findings = handoverFindings(roles, { operator: deployer, vault: vault ?? "", frozen: (p) => !!state.programs[p]?.frozen });
const operational = findings.onOperator.filter((r) => r.kind !== "upgrade" && r.kind !== "authority");
ok(operational.length === 0, operational.length ? `the deployer key holds roles it must never hold: ${nameRoles(operational)}` : "no operational role (guardian, settlement, anchorer, slasher, sale, HVX, receipt signer) and no payout account is on the deployer key");
for (const r of findings.unreadable) ok(false, `${r.program} ${r.role}: ${r.account} is missing or is not an SPL Token account`);
for (const r of roles.filter((x) => x.kind === "payout" && x.address !== null)) ok(/ owner$/.test(r.role) && r.address === vault, `${r.program} ${r.role} of ${r.account} is ${r.address}${/ owner$/.test(r.role) ? (r.address === vault ? " (the multisig vault)" : ": expected the multisig vault") : ": a payout account must have no delegate and no close authority"}`);
ok(findings.guardianIsVault.length === 0, findings.guardianIsVault.length ? `the guardian is the vault on: ${nameRoles(findings.guardianIsVault)}` : "no guardian is the multisig vault");
if (stage === "multisig") {
  ok(findings.onOperator.length === 0, findings.onOperator.length ? `the deployer key still holds: ${nameRoles(findings.onOperator)}` : `the deployer key holds no authority and no role on any of the ${cov.found.length} deployed program(s)`);
  const waiting = findings.notVault.filter((r) => r.address !== deployer);
  ok(waiting.length === 0, waiting.length ? `not held by the multisig vault: ${waiting.map((r) => `${r.program} ${r.role} (${r.address ?? "none"})`).join(", ")}` : "every upgrade authority and config authority is the multisig vault");
}
// R4-17. The record says the hand-over is complete: then it is judged as complete, whatever stage this command was
// asked for and whatever was deployed since. A program that still sits on the operator key (a later tier), or on any
// key but the vault, is a failure, and no report is written.
const standing = handoverStanding(roles, { operator: deployer, vault, recordedAt: rec.handover?.at, stage, frozen: (p) => !!state.programs[p]?.frozen });
if (standing.recordedAt) {
  const held = (r: { address: string | null }) => (r.address === deployer ? "the operator key" : r.address ?? "nobody");
  ok(standing.complete, standing.complete
    ? `the hand-over is recorded as complete (${standing.recordedAt}) and it is: every upgrade authority and config authority is the multisig vault, and nothing is on the deployer key`
    : `the hand-over is recorded as complete (${standing.recordedAt}) and it is not: ${[...findings.notVault.map((r) => `${r.program} ${r.role} is held by ${held(r)}`), ...findings.onOperator.filter((r) => !findings.notVault.includes(r)).map((r) => `${r.program} ${r.role} is on the operator key`)].join(", ")}. A program deployed after the hand-over stays on the operator key until its own hand-over resolves (handover.ts propose, 24 h, resolve, check); until then this deployment does not verify`);
}
const hot = [["settlement", a.settlementAuthority], ["anchorer", a.anchorAuthority ?? a.anchorer], ["slasher", a.slasher], ["guardian", a.guardian]].filter(([, k]) => k && k !== vault) as [string, string][];
ok(new Set(hot.map(([, k]) => k)).size === hot.length, "guardian, settlement, anchorer and slasher are different keys");
// Memo mode: no program holds the anchorer, so the record is the only place it is named; it must be named, and not the deployer.
if (selected.length && anchorModeOf(selected) === "memo") ok(!!(a.anchorer ?? a.anchorAuthority) && (a.anchorer ?? a.anchorAuthority) !== deployer, `memo anchoring: the anchorer key is recorded (${a.anchorer ?? a.anchorAuthority ?? "MISSING: set MAINNET_ANCHORER and run init.ts"}) and is not the deployer`);

// ---- The multisig behind the vault: read and judged in this run (R3-09) -----------------------------------------------------
console.log("\nmultisig");
const multisigAccount = optionalPubkey(args.options.get("--multisig-account") ?? process.env.MAINNET_MULTISIG_ACCOUNT ?? rec.handover?.multisigAccount, "--multisig-account");
const { expect: expectMultisig, problems: expectProblems } = multisigExpectation(process.env, { members: args.options.get("--multisig-members"), threshold: args.options.get("--multisig-threshold"), minTimeLock: args.options.get("--multisig-min-time-lock") });
for (const pr of expectProblems) ok(false, pr);
if (process.env.MAINNET_MULTISIG_VAULT?.trim() && vault) ok(process.env.MAINNET_MULTISIG_VAULT.trim() === vault, `the vault in the record (${vault}) is the one MAINNET_MULTISIG_VAULT names`);
let multisig: MultisigJudgement | null = null;
if (!vault) note("no multisig vault is recorded yet (init.ts records it)");
else if (stage === "operator" && !multisigAccount) note("the multisig account is not known (MAINNET_MULTISIG_ACCOUNT): NOT judged at this stage. It is required, and judged, before anything is handed to its vault");
else {
  multisig = await judgeMultisig(conn, multisigAccount, new PublicKey(vault), new PublicKey(deployer), expectMultisig, { untestedOk: args.flags.has("--multisig-untested-ok") });
  if (multisig.multisig) for (const line of describeMultisig(multisig.multisig)) console.log(`  ${line}`);
  for (const n of multisig.notes) note(n);
  ok(multisig.problems.length === 0, multisig.problems.length ? `the multisig behind the vault is what was configured: ${multisig.problems.join("; ")}` : `the multisig behind the vault is what was configured: owned by the Squads program, threshold ${multisig.multisig!.threshold}, ${multisig.multisig!.members.length} expected members with their permissions, no config authority, and ${vault} is its vault ${expectMultisig.vaultIndex}`);
  for (const x of multisig.exceptions) except(x.id, x.detail);
  // The guardian brakes the authority; a member of the multisig in that seat is one key on both sides (R4-29).
  if (multisig.multisig) {
    const both = guardianMemberFindings(roles, multisig.multisig.members.map((m) => m.key));
    ok(both.length === 0, both.length ? describeGuardianMember(both) : "no guardian is a member of the multisig");
  }
}

// ---- The IDL (R3-30) ------------------------------------------------------------------------------------------------------------
// `anchor idl init` stores an IDL through the Program Metadata program. This kit does not decode that program's accounts,
// so it does not claim anything about them: the item is reported as not established, with the reason.
const IDL_REASON = "the IDL was published through the Program Metadata program (`anchor idl init`). Its canonical metadata account is governed by the program's upgrade authority, which IS verified above; whether an additional metadata authority was set on it is not read: this kit does not decode that program's accounts. Read it with the program-metadata client (`fetch idl <program id>`) before retiring the operator key";
const idlPublished = selected.filter((p) => rec.programs[p]?.idl?.status === "published");
console.log("\nIDL");
if (idlPublished.length) {
  console.log(`  NOT ESTABLISHED  IDL authority of ${idlPublished.join(", ")}: ${IDL_REASON}.`);
  except("idl-authority-not-established", `IDL authority of ${idlPublished.join(", ")} not established: ${IDL_REASON}`);
} else note("the record lists no IDL published by this kit, so there is no IDL authority to hand over as far as the record shows. An IDL published by other means is not looked for");

// ---- Treasury token accounts ---------------------------------------------------------------------------------------------
const neededAccounts = tokenAccountsNeeded(selected);
if (neededAccounts.length) console.log("\ntreasury token accounts");
for (const key of neededAccounts) {
  const name = key === "treasury" ? "treasuryUsdc" : key;
  const address = rec.accounts?.[name];
  if (!address) { ok(false, `${name} is recorded`); continue; }
  const info = await conn.getAccountInfo(new PublicKey(address), "confirmed");
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) { ok(false, `${name} ${address} is an SPL Token account`); continue; }
  const t = unpackAccount(new PublicKey(address), info, TOKEN_PROGRAM_ID);
  ok(same(t.mint, usdc) && same(t.owner, vault), `${name} ${address}: USDC, owned by the multisig vault, balance ${t.amount}`);
  ok(t.delegate === null && t.closeAuthority === null, `${name}: no delegate and no close authority`);
}

if (exceptions.length) { console.log("\nrecorded exceptions (bypasses, and what this run could not establish)"); for (const x of exceptions) console.log(`  - ${x.id}: ${x.detail}`); }
console.log(`\n${failures ? `${failures} check(s) FAILED:\n${failed.map((f) => `  - ${f}`).join("\n")}` : exceptions.length ? `all checks passed, WITH ${exceptions.length} RECORDED EXCEPTION${exceptions.length === 1 ? "" : "S"} (${exceptions.map((x) => x.id).join(", ")}): not a plain pass` : "all checks passed"}`);

// ---- Router environment and the production-guard report ---------------------------------------------------------------------
function printEnv(): void {
  const id = (p: ProgramName) => (selected.includes(p) ? rec.programs[p]?.programId ?? "" : "");
  const line = (name: string, p: ProgramName) => (selected.includes(p) ? `${name}=${id(p)}` : `# ${name}=   (not deployed in tier ${tier})`);
  const memo = anchorModeOf(selected) === "memo";
  console.log(`
# ---- Trellis on ${mode}, tier ${tier} (bun scripts/mainnet/verify.ts --env) ----
CHAIN_ID=101
SOLANA_NETWORK=${rec.network}
X402_NETWORK=${rec.network}
USDC_ADDRESS=${usdc}
# Which programs the production guard requires, and what the router switches off without the others.
LAUNCH_TIER=${routerTier(selected)}
# Receipt roots: ${memo ? "one memo transaction an hour signed by the anchorer key (no anchor program in this tier)" : "trellis_anchor accounts"}.
ANCHOR_MODE=${anchorModeOf(selected)}
# The anchorer's PUBLIC key: on the API (which never holds the secret) it is what the key document and every proof name.
ANCHORER_ADDRESS=${a.anchorAuthority ?? a.anchorer ?? process.env.MAINNET_ANCHORER ?? ""}
${line("TRELLIS_CREDITS_PROGRAM_ID", "trellis_credits")}
${line("TRELLIS_TAB_PROGRAM_ID", "trellis_tab")}
${line("TRELLIS_BOND_PROGRAM_ID", "trellis_bond")}
${line("TRELLIS_ANCHOR_PROGRAM_ID", "trellis_anchor")}
${line("TRELLIS_RULES_PROGRAM_ID", "trellis_rules")}
${line("TRELLIS_FEE_ROUTER_PROGRAM_ID", "trellis_fee_router")}
${line("TRELLIS_CAPACITY_PROGRAM_ID", "trellis_capacity")}
${line("TRELLIS_MEASUREMENTS_PROGRAM_ID", "trellis_measurements")}
# The names the deployment manifest is checked against; they carry the same programs (CALLPAY = trellis_tab, PROVIDER_BOND = trellis_bond).
${line("CREDITS_ADDRESS", "trellis_credits")}
${line("CALLPAY_ADDRESS", "trellis_tab")}
${line("PROVIDER_BOND_ADDRESS", "trellis_bond")}
${line("RECEIPT_ANCHOR_ADDRESS", "trellis_anchor")}
${selected.includes("trellis_bond") ? `HOST_BOND_ADDRESS=${id("trellis_bond")}` : "# HOST_BOND_ADDRESS=   (no host bonds in this tier)"}
TREASURY_ADDRESS=${vault ?? ""}
${rec.accounts?.refundPool ? `REFUND_POOL_ADDRESS=${rec.accounts.refundPool}` : "# REFUND_POOL_ADDRESS=   (the refund pool belongs to trellis_bond)"}
TAB_CAP_USDC=${Number(PARAMS.tab.maxCap) / 1e6}
CREDITS_CAP_USDC=${Number(PARAMS.credits.maxBalancePerKey) / 1e6}
CREDITS_REFUND_DELAY_H=${Number(PARAMS.credits.refundDelay) / 3600}
${selected.includes("trellis_credits") ? "# One settlement commit a day keeps spent-root rent near 0.04 SOL a month (each commit that changes anything creates one small account).\nSETTLEMENT_INTERVAL_MS=86400000" : "# No credits program: the settlement job has nothing on chain to commit."}
# TRLS_TOKEN_ADDRESS=${rec.mints?.trls ?? ""}   # setting it (with HOLDER_TIERS) switches holder tiers on`);
}
if (args.flags.has("--env")) printEnv();

if (args.flags.has("--write-report")) {
  const revision = kitRevision;
  const unestablished = selected.filter((p) => !equivalence[p]?.established);
  const why: string[] = [];
  if (failures) why.push(`${failures} check(s) failed`);
  if (mismatches.length) why.push(`on-chain bytes differ from the recorded hash: ${mismatches.join(", ")}`);
  if (unestablished.length) why.push(`source equivalence was not established in this run for: ${unestablished.join(", ")}`);
  if (covProblems.length) why.push("the selection does not cover every deployed program");
  if (!standing.ok) why.push(`the hand-over is recorded as complete and ${[...new Set([...standing.notOnVault, ...standing.onOperatorKey])].join(", ")} ${standing.notOnVault.length + standing.onOperatorKey.length === 1 ? "is" : "are"} not the vault's`);
  if (!/^[0-9a-f]{40}$/.test(revision)) why.push("git revision unavailable");
  if (treeProblem && !ALLOW_DIRTY) why.push(treeProblem);
  if (why.length) { console.log(`\nNo report written:\n${why.map((w) => `  - ${w}`).join("\n")}`); process.exit(1); }
  const deploySlot = selected.reduce((m, p) => (state.programs[p].lastDeploySlot! > m ? state.programs[p].lastDeploySlot! : m), 0n);
  // Only what is deployed is listed: the router's guard checks each configured program against this map.
  const legacy: [string, ProgramName][] = [["credits", "trellis_credits"], ["callPay", "trellis_tab"], ["providerBond", "trellis_bond"], ["receiptAnchor", "trellis_anchor"]];
  const contracts: Record<string, string> = { ...Object.fromEntries(legacy.filter(([, p]) => selected.includes(p)).map(([k, p]) => [k, ids[p].toBase58()])), usdc };
  const holder = stage === "multisig" ? vault! : stage === "operator" ? deployer : "mixed";
  const manifest = {
    schema: DEPLOYMENT_SCHEMA, mode: "production", network: rec.network, blockNumber: Number(deploySlot),
    tier, launchTier: routerTier(selected), anchorMode: anchorModeOf(selected),
    contracts,
    programs: Object.fromEntries(selected.map((p) => [p, ids[p].toBase58()])),
    roles: { upgradeAuthority: holder, authority: holder, guardian: a.guardian ?? null, anchorAuthority: a.anchorAuthority ?? a.anchorer ?? null, settlementAuthority: a.settlementAuthority ?? null, slasher: a.slasher ?? null, saleAuthority: a.saleAuthority ?? null, hvxAuthority: a.hvxAuthority ?? null, receiptSigner: a.receiptSigner ?? null, multisigVault: vault ?? null },
    stage,
    note: "The router keys `callPay` and `providerBond` are legacy names: they carry trellis_tab and trellis_bond. Programs outside the tier are not deployed and not listed.",
  };
  // Nothing below is a constant "pass": `ok` and the statuses are computed from what this run read, so that a report
  // cannot say ok over a state the checks above would fail (R4-17), even if the gate above were ever loosened.
  const operatorKeyOk = standing.ok && operational.length === 0 && (stage !== "multisig" || findings.onOperator.length === 0);
  const report = {
    ok: failures === 0 && standing.ok && operatorKeyOk && !unestablished.length && !mismatches.length && !covProblems.length,
    verifierRevision: revision,
    // Where the hand-over stands (R4-17). `recordedAt` is the record's `handover.at`. When it is set, `complete` must be
    // true and both lists empty: the router's start-up guard can check exactly that instead of trusting `ok`.
    handover: { recordedAt: standing.recordedAt, complete: standing.complete, stage: standing.stage, vault: standing.vault, operator: standing.operator, onOperatorKey: standing.onOperatorKey, notOnVault: standing.notOnVault },
    verifier: "scripts/mainnet/verify.ts",
    manifest: { schema: manifest.schema, mode: manifest.mode, network: manifest.network, blockNumber: manifest.blockNumber },
    observed: { network: rec.network, genesisHash: genesis, blockNumber: state.slot, at: new Date().toISOString() },
    checks: [
      { id: "contracts.bytecode_present", status: "pass", evidence: Object.fromEntries(Object.entries(contracts).map(([k, address]) => [k, { address, present: true }])) },
      // "pass" is written only when, in THIS run, every program's on-chain bytes equalled a build output that was hashed
      // again (the gate above stops the report otherwise).
      { id: "contracts.source_equivalence", status: "pass", evidence: { sourceRevision: revision, mismatches: [], sourceKey: currentKey, headKey: src.headKey || null, binding: BIND ? "each binary is bound to the commit by the build manifest beside it (build.json): its source key is the commit's, its sha256 is the file's, and the file's bytes are the chain's" : "bytes only (a rehearsal's --allow-dirty: no commit names the source)", tree: treeProblem ? `not clean (${treeProblem}); accepted for this rehearsal only` : "clean", programs: Object.fromEntries(selected.map((p) => [p, { programId: state.programs[p].programId, ...equivalence[p] }])), scope: "Established in this run: the on-chain program bytes equal a build output of the current source that this run hashed again (the method is named per program), and equal the hashes recorded at deploy; each program reported the mainnet build profile and floors through build_profile; every config value equals scripts/mainnet/params.ts. The programs are unaudited; this is not an audit." } },
      { id: "contracts.build_profile", status: "pass", evidence: { expectedTimelockSeconds: MAINNET_TIMELOCK_SECONDS, measuredTimelockSeconds: measured, profiles: Object.fromEntries(selected.map((p) => [p, { profile: readings[p]?.profile ?? null, kind: readings[p]?.kind ?? "unknown", floors: Object.fromEntries(Object.entries(readings[p]?.floors ?? {}).map(([k, v]) => [k, Number(v)])) }])), ...(ALLOW_DEVNET ? { rehearsal: "devnet-feature binaries were accepted for this rehearsal; a mainnet report never carries this field" } : {}), method: "build_profile of every deployed program, simulated: profile 0 and every floor equal to MAINNET_FLOORS (scripts/mainnet/plan.ts); a below-floor proposal simulated as the authority is refused" } },
      { id: "configs.parameters_and_authorities", status: "pass", evidence: { stage, holder, guardian: a.guardian ?? null } },
      { id: "deployment.coverage", status: covProblems.length ? "fail" : "pass", evidence: { selected, deployed: cov.found, accounted: accountFor(selected, state), ids: `the ids of all eight programs are the source's declare_id! lines${mode === "mainnet" ? ", each equal to Anchor.toml [programs.mainnet]" : ""}; a record that names another id stops verification, and one that names none hides nothing`, method: "each of the eight ids read on chain: deployed (and inspected when selected), or no account there; a deployed program outside the selection fails verification" } },
      { id: "handover.complete", status: !standing.recordedAt ? "not_applicable" : standing.complete ? "pass" : "fail", evidence: { recordedAt: standing.recordedAt, onOperatorKey: standing.onOperatorKey, notOnVault: standing.notOnVault, method: "once the record says the hand-over is complete, every deployed program's upgrade authority and config authority must be the multisig vault and no role may be on the operator key" } },
      { id: "roles.operator_key", status: operatorKeyOk ? "pass" : "fail", evidence: { stage, rolesRead: roles.length, onOperatorKey: findings.onOperator.map((r) => `${r.program} ${r.role}`), method: "every key each config names, each upgrade authority, and the owner, delegate and close authority of each payout account, for every deployed program" } },
      { id: "proposals.none_pending", status: "pass", evidence: { programs: pendingProposals } },
      { id: "multisig.account", status: !multisig ? "not_established" : multisig.exceptions.length ? "warn" : "pass", evidence: multisig?.evidence ?? { reason: "the multisig account was not given at the operator stage; it is judged before the hand-over" } },
      { id: "idl.authority", status: idlPublished.length ? "not_established" : "not_published", evidence: idlPublished.length ? { programs: idlPublished, reason: IDL_REASON } : { reason: "the record lists no IDL published by this kit" } },
    ],
    // Bypasses that were accepted and what this run could not establish. Empty for a plain pass.
    exceptions,
  };
  const base = deploymentsFile(mode).replace(/\.json$/, "");
  writeFileSync(`${base}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(`${base}.verification.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nwrote ${dirname(base).replace(ROOT + "/", "")}/ manifest and verification report (tier ${tier}, stage ${stage}, slot ${state.slot})${exceptions.length ? `, WITH ${exceptions.length} RECORDED EXCEPTION${exceptions.length === 1 ? "" : "S"} listed in it` : ""}.`);
  console.log("Point DEPLOYMENT_MANIFEST and DEPLOYMENT_VERIFICATION at them and set RELEASE_COMMIT; write them again after the hand-over, after adding a tier and after every upgrade.");
}
process.exit(failures ? 1 : 0);
