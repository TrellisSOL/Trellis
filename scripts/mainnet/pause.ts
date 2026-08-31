// Pause, renew or lift a pause on the programs that have one: the on-chain brake of MAINNET.md's incident section.
//
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet --status                      read-only: every pause slot, until when, who set it, the guardian's cooldown
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet                               the GUARDIAN key pauses (MAINNET_GUARDIAN_KEYPAIR), after a typed confirmation
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet --as-authority                the AUTHORITY pauses instead (the operator key, before the hand-over): said explicitly, never a fallback
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet --print --signer <key>        the instructions for whoever holds that key (a hardware wallet, a Squads proposal); sends nothing
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet --renew                       the AUTHORITY sets a running pause again: another 72 hours from now
//   bun scripts/mainnet/pause.ts --i-understand-this-is-mainnet --unpause                     the reverse: the AUTHORITY only (the operator key before the hand-over)
//   bun scripts/mainnet/pause.ts --rehearsal [--yes] ...                                      the same against a local validator
//   --only trellis_tab,trellis_credits                                                        a subset (default: every pausable program of the launch tier)
//   --settlements                                                                             also trellis_credits' second brake: settlements (commits, host payouts, sweeps)
//   --program-id trellis_credits=<id>[,...]                                                   the program id, typed (see below); it must agree with the deployments record when there is one
//
// It runs from ANY checkout of this repository (security/REVIEW-ROUND5-2026-10.md R5-16): the program ids are the ones
// the deployments record names (deployments/mainnet.json, which must be of this chain), not this tree's declare_id!
// lines, so the guardian's device needs no release branch, no program keypairs and no Rust toolchain: bun, this
// repository at any commit that has the record, MAINNET_RPC_URL and the guardian key. With no record at all, pass
// --program-id. Every id it acts on is printed with where it came from; a record, a --program-id, Anchor.toml
// [programs.mainnet] or a release checkout's declare_id! that disagree stop the run before anything is read.
//
// What a pause does, per program (it never moves funds, and exits stay open):
//   trellis_credits   set_deposits_paused(true): no new deposits. Closure refunds, settlement and sweeps continue.
//                     --settlements: set_settlements_paused(true): no spent root, host payout or sweep. Closure refunds continue.
//   trellis_tab       pause: no new tabs. Existing tabs can be vouched, topped up, closed and reclaimed.
//   trellis_bond      pause: no new bonds. Unbonding, slashing and disputes continue.
//   trellis_capacity  pause: no new commitments or sales. Redemptions, shortfall reports and claims continue.
//   trellis_rules     set_new_rulebooks_paused(true): no new rulebooks. Existing ones keep working.
// trellis_anchor, trellis_fee_router and trellis_measurements have no pause.
//
// A PAUSE LASTS 72 HOURS AND THEN LAPSES BY ITSELF (security/REREVIEW-2026-10.md RR-02). The flag stays set in the
// account, but the program runs again from `paused_until` on. Nothing here can make a pause permanent:
//   - the AUTHORITY keeps one going by setting it again (--renew), each time for 72 hours from that moment, as often as
//     it likes. After the hand-over the authority is the multisig vault: a renewal is a Squads vault transaction
//     (--renew --print --signer <vault>), so start it well before the pause lapses. The monitor pages 12 hours ahead;
//   - the GUARDIAN pauses once: after a guardian pause it cannot set that pause again until 7 days after the moment it
//     was due to lapse. A stolen guardian key buys one pause of at most 72 hours per program, and replacing the
//     guardian (a 24 h proposal, which the guardian can no longer cancel) fits inside the cooldown;
//   - only the authority lifts a pause early (--unpause). The same instruction clears the flag of a pause that has
//     lapsed, which is tidy and changes nothing.
//
// Who can sign: the guardian or the config authority may pause; only the authority may renew at will or unpause.
//   The guardian is a key of its own from init on (MAINNET_GUARDIAN): one signature, no timelock, no multisig. That is
//   the point of it: a pause in minutes. Keep it where it can be reached in an incident and nowhere a worker can read it.
//   With its keypair file in MAINNET_GUARDIAN_KEYPAIR this script sends the pause; for a hardware wallet use --print.
//   The authority is the operator key before the hand-over and the multisig vault after it. To UNPAUSE or RENEW after
//   the hand-over: --unpause (or --renew) --print --signer <vault>, one Squads vault transaction from the printed
//   instructions.
// The guardian can do nothing else: it cannot cancel a proposal and cannot unpause. While credits deposits are paused the
// router reports not ready (its custody check reads that pause): expected.
//
// Exit status (security/REVIEW-ROUND3-2026-10.md R3-21). This is the script run in an incident, so its exit status says
// whether the brake is on: 0 only when every pause that was asked for is in force afterwards (it was sent and read
// back, or it was in force already), and for --unpause only when none is left. A slot that was skipped (the guardian
// in its cooldown, a signer that is neither guardian nor authority, a program that is not initialised, an account that
// could not be read) makes the run FAIL with "NOT PAUSED: <slots>". And a pause is the guardian's key or, when asked
// for with --as-authority, the authority's: without a guardian keypair file the script stops; it does not reach for
// the deployer key by itself.
// What was asked for is decided by the command, never by what happened to be readable (REVIEW-ROUND4 R4-29): with
// --settlements the settlement brake is a slot of this run even when the outflow limiter account does not read, and it
// is then reported as NOT PAUSED. --print follows the same rule: it prints what it can and exits 1 when the printed
// instructions do not cover everything that was asked for.
import { ComputeBudgetProgram, Transaction, sendAndConfirmTransaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { existsSync } from "node:fs";
import { MAINNET_FLAG, REHEARSAL_FLAG, TIER_OPTIONS, assertCluster, confirm, connect, expectFlags, explorer, fail, incidentProgramIds, loadDeployer, loadRecord, modeOf, parseArgs, pubkey, readKeypairFile, rpcHost, rpcUrl, selection, table, type ProgramName } from "./lib.ts";
import { MAINNET_GUARDIAN_COOLDOWN_SECONDS, MAINNET_PAUSE_TTL_SECONDS, PAUSABLE, PAUSE_SLOTS, SLOT_STOPS, mayPause, pauseFields, pauseIx, pauseView, slotProgram, type PauseSlot, type PauseView } from "./plan.ts";
import { chainTime, fundedPayer, readBuildProfile, readChainState } from "./state.ts";

const args = parseArgs(process.argv.slice(2), ["--signer", "--only", "--program-id", ...TIER_OPTIONS]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--print", "--unpause", "--renew", "--status", "--settlements", "--as-authority", "--yes"]);
const mode = modeOf(args);
const PRINT = args.flags.has("--print");
const STATUS = args.flags.has("--status");
const RENEW = args.flags.has("--renew");
const pause = !args.flags.has("--unpause");
if (RENEW && !pause) fail("--renew and --unpause contradict each other.", 2);
const AS_AUTHORITY = args.flags.has("--as-authority");
if (AS_AUTHORITY && (RENEW || !pause || PRINT || STATUS)) fail("--as-authority belongs to a pause that this script sends: --renew and --unpause are the authority's already, and --print names its signer with --signer.", 2);
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const rec = loadRecord(mode, genesis);
const { programs: selected } = selection(args, rec);
type Pausable = (typeof PAUSABLE)[number];
const only = (args.options.get("--only") ?? PAUSABLE.filter((p) => selected.includes(p)).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
for (const p of only) if (!(PAUSABLE as readonly string[]).includes(p)) fail(`${p} has no pause; choose from ${PAUSABLE.join(", ")}`, 2);
for (const p of only) if (!selected.includes(p as ProgramName)) fail(`${p} is not part of this deployment's tier`, 2);
// The ids of the programs to pause: the record's (or --program-id), NOT this checkout's declare_id! lines, so that the
// brake works from any checkout (R5-16; lib.ts incidentIdWitness says what the record is held against).
const { ids, from: idFrom } = incidentProgramIds(mode, rec, genesis, only as ProgramName[], args.options.get("--program-id"));

// Who signs when this script sends: a pause is the guardian's (its keypair file), a renewal or an unpause the
// authority's (the operator key, before the hand-over). The authority may pause too, but only when the command says so
// (--as-authority): a missing or mistyped guardian keypair path must stop the run, not quietly put the deployer key,
// which holds every authority, on the machine an incident is being handled from.
const guardianVar = mode === "mainnet" ? "MAINNET_GUARDIAN_KEYPAIR" : "REHEARSAL_GUARDIAN_KEYPAIR";
const guardianFile = process.env[guardianVar];
function pauseSigner() {
  if (AS_AUTHORITY) return loadDeployer(mode);
  if (!guardianFile) fail(`${guardianVar} is not set: a pause is signed by the guardian key, so nothing was sent and NOTHING IS PAUSED. Set it to the guardian's keypair file, or use --print --signer <guardian> for a hardware wallet. To pause with the authority's key instead (the operator key, before the hand-over), pass --as-authority.`, 2);
  if (!existsSync(guardianFile)) fail(`${guardianVar} points at a file that does not exist: nothing was sent and NOTHING IS PAUSED. (The authority's key pauses only with --as-authority.)`, 2);
  return readKeypairFile(guardianFile);
}
const sender = PRINT || STATUS ? null : pause && !RENEW ? pauseSigner() : loadDeployer(mode);
const signer: PublicKey | null = STATUS ? null : PRINT ? pubkey(args.options.get("--signer"), "--signer <the guardian or authority that will sign>") : sender!.publicKey;

const state = await readChainState(conn, ids);
const now = await chainTime(conn);
// The terms are the deployed build's own (72 h and 7 days on the mainnet build), read from build_profile.
const payer = await fundedPayer(conn, [signer, rec.deployer, rec.authorities?.multisigVault, rec.authorities?.guardian]);
const terms: Partial<Record<Pausable, { ttl: number; cooldown: number }>> = {};
for (const p of only as Pausable[]) {
  const reading = state.programs[p].deployed ? await readBuildProfile(conn, p, ids[p], payer) : null;
  terms[p] = { ttl: Number(reading?.floors.pauseTtl ?? MAINNET_PAUSE_TTL_SECONDS), cooldown: Number(reading?.floors.guardianPauseCooldown ?? MAINNET_GUARDIAN_COOLDOWN_SECONDS) };
}
const views = new Map<PauseSlot, PauseView>(pauseFields(state.configs, state.limiter).map((f) => [f.slot, pauseView(f, now, terms[slotProgram(f.slot) as Pausable]?.cooldown ?? MAINNET_GUARDIAN_COOLDOWN_SECONDS)]));
const iso = (t: number) => new Date(t * 1000).toISOString();
const span = (seconds: number) => (seconds < 3600 ? `${Math.max(0, Math.ceil(seconds / 60))} min` : `${(seconds / 3600).toFixed(1)} h`);
const describe = (v: PauseView) => (v.active ? `PAUSED until ${iso(v.until)} (${span(v.left)} left; set by the ${v.by})` : v.lapsed ? `running: the pause lapsed ${iso(v.until)}, the flag is still set` : "running");
// The slots this run is about: each chosen program's own pause, and the settlement brake only when asked for. Taken
// from the command, not from what could be read: a slot whose account does not read is still a slot of this run.
const asked = PAUSE_SLOTS.filter((s) => only.includes(slotProgram(s)) && (s !== "trellis_credits.settlements" || args.flags.has("--settlements") || STATUS));
const slots = asked.filter((s) => views.has(s));
/** Asked for, its program is initialised, and its pause state did not read: the settlement brake without its limiter account. */
const unread = asked.filter((s) => !views.has(s) && !!state.configs[slotProgram(s)]);
const UNREAD_WHY = `the outflow limiter account (["limiter_v2"] ${state.limiterAddress || "address unknown"}) could not be read, so this brake can be neither set nor judged from here`;

if (STATUS) {
  console.log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal"} pause status on ${rpcHost(url)} at ${iso(now)} (the cluster's clock). Read-only.`);
  const rows: (string | number)[][] = [["pause", "state", "guardian may pause", "what it stops"]];
  for (const s of asked) {
    const v = views.get(s);
    if (v) rows.push([s, describe(v), v.guardianInCooldown ? `not before ${iso(v.guardianReadyAt)}` : "yes", SLOT_STOPS[s]]);
    else if (unread.includes(s)) rows.push([s, `NOT READ: ${UNREAD_WHY}`, "-", SLOT_STOPS[s]]);
  }
  for (const p of only) if (!state.configs[p as ProgramName]) rows.push([p, state.legacy.includes(p as ProgramName) ? "config in an earlier layout: run init.ts (migrate_config)" : "not initialised", "-", "-"]);
  table(rows);
  const active = slots.filter((s) => views.get(s)!.active);
  if (active.length) console.log(`\nA pause lapses by itself. To keep one going the AUTHORITY renews it before then: pause.ts --renew${args.flags.has("--settlements") ? " --settlements" : ""} (after the hand-over: --renew --print --signer <vault>).`);
  process.exit(0);
}

const roleOf = (s: PauseSlot): "authority" | "guardian" | null => {
  const c = state.configs[slotProgram(s)] as { authority: PublicKey; guardian?: PublicKey } | null;
  return !c ? null : c.authority.equals(signer!) ? "authority" : c.guardian?.equals(signer!) ? "guardian" : null;
};
const action = RENEW ? "RENEW" : pause ? "PAUSE" : "UNPAUSE";
console.log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal"} ${action} on ${rpcHost(url)}; signer ${signer!.toBase58()}${AS_AUTHORITY ? " (the authority, --as-authority)" : ""}${PRINT ? "  (print only: nothing is sent)" : ""}`);
// Where each program is: compare with the id written down at the hand-over (MAINNET.md, "Rollback and incidents").
table((only as ProgramName[]).filter((p) => ids[p]).map((p) => [p, ids[p].toBase58(), `(${idFrom[p]})`]));
const todo: { slot: PauseSlot; ix: TransactionInstruction }[] = [];
/** Slots (or programs) that are not, and will not be, in the state this run was asked for: the reason for a non-zero exit. */
const missed: string[] = [];
for (const p of only as Pausable[]) if (!state.configs[p]) { console.log(`  ${p}: ${state.legacy.includes(p) ? "its config is in an earlier layout; run init.ts (migrate_config) first" : "not initialised"}; skipped`); if (pause) missed.push(p); }
// A brake that was asked for and cannot be read is not paused, not renewed and not known to be lifted: it is missed.
for (const s of unread) { console.log(`  ${s}: ${UNREAD_WHY}; skipped`); missed.push(s); }
for (const s of slots) {
  const v = views.get(s)!, role = roleOf(s), term = terms[slotProgram(s) as Pausable]!;
  let why: string | null = null;
  // `holds`: the state asked for is already there, so skipping the slot is not a failure.
  let holds = false;
  if (!pause) {
    // Lifting a pause, or clearing the flag of one that lapsed: the authority only.
    if (!v.flag) { why = "running; nothing to lift"; holds = true; }
    else if (role !== "authority") { why = `only the authority unpauses${PRINT ? "; this signer cannot" : " (after the hand-over: --unpause --print --signer <vault> and a Squads proposal)"}`; holds = !v.active; }
  } else if (RENEW) {
    if (!v.active) why = v.lapsed ? "its pause has lapsed; pause it again without --renew if it should be paused" : "not paused; nothing to renew";
    else if (role !== "authority") why = `a renewal at will is the authority's${role === "guardian" && !v.guardianInCooldown ? " (the guardian could set it once more, without --renew, and then waits 7 days)" : ""}`;
  } else {
    const may = mayPause(v, role);
    if (v.active) { why = `already paused until ${iso(v.until)}; the authority extends it with --renew`; holds = true; }
    else if (!may.ok) why = `${may.why}${role === null && !PRINT ? ` (set ${guardianVar} to the guardian's keypair file, or use --print --signer <guardian>)` : ""}`;
  }
  if (why) { console.log(`  ${s}: ${why}; skipped   [${describe(v)}]`); if (!holds) missed.push(s); continue; }
  const ix = pauseIx(s, ids[slotProgram(s)], { signer: signer!, paused: pause });
  todo.push({ slot: s, ix });
  console.log(`  ${s}: ${!pause ? (v.active ? "unpause" : "clear the flag of the lapsed pause") : `${RENEW ? "renew" : "pause"}: in force until ${iso(now + term.ttl)} (${span(term.ttl)}), then it lapses by itself${role === "guardian" ? `; the guardian cannot pause it again before ${iso(now + term.ttl + term.cooldown)}` : ""}`}`);
  if (PRINT) {
    console.log(`      program ${ix.programId.toBase58()}`);
    for (const k of ix.keys) console.log(`      account ${k.pubkey.toBase58()}${k.isSigner ? " signer" : ""}${k.isWritable ? " writable" : ""}`);
    console.log(`      data    hex ${Buffer.from(ix.data).toString("hex")}  base64 ${Buffer.from(ix.data).toString("base64")}`);
  }
}
const NOT = RENEW ? "NOT RENEWED" : pause ? "NOT PAUSED" : "STILL PAUSED";
if (PRINT) {
  console.log(`\n${todo.length} instruction(s) printed. Nothing was sent.${pause && todo.length ? " A pause is counted from the moment the transaction lands, not from now." : ""}`);
  if (missed.length) { console.log(`${NOT} by these instructions: ${missed.join(", ")} (see the lines marked skipped).`); process.exit(1); }
  process.exit(0);
}
if (!todo.length) {
  console.log("\nNothing to send.");
  if (missed.length) fail(`${NOT}: ${missed.join(", ")}. Nothing was sent; see the lines marked skipped for why.`);
  process.exit(0);
}
await confirm(mode, `${RENEW ? "renew" : pause ? "pause" : "unpause"} ${todo.length} programs on ${mode}`, args);
// One transaction: the programs stop together.
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.COMPUTE_UNIT_PRICE ?? 5000) }), ...todo.map((t) => t.ix));
const sig = await sendAndConfirmTransaction(conn, tx, [sender!], { commitment: "confirmed" });
console.log(`\n${RENEW ? "renewed" : pause ? "paused" : "unpaused"} ${todo.map((t) => t.slot).join(", ")}  ${explorer(mode, "tx", sig)}`);
// Read it back: the exit status vouches for the chain, not for a transaction that was sent.
const afterState = await readChainState(conn, ids);
const afterNow = await chainTime(conn);
const afterViews = new Map<PauseSlot, PauseView>(pauseFields(afterState.configs, afterState.limiter).map((f) => [f.slot, pauseView(f, afterNow)]));
for (const t of todo) { const v = afterViews.get(t.slot); if (!v || (pause ? !v.active : v.flag)) missed.push(t.slot); }
if (pause) console.log(`Each pause lapses by itself (see above). To keep one going the AUTHORITY renews it before then: bun scripts/mainnet/pause.ts ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --renew${args.flags.has("--settlements") ? " --settlements" : ""}; \`--status\` shows what is left.`);
if (missed.length) fail(`${NOT}: ${missed.join(", ")}. The transaction above covered ${todo.length} slot(s); the rest was skipped or does not read back as expected.`);
