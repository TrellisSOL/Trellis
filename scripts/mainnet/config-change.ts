// The config changes of trellis_credits that MAINNET.md's incident section names (security/REVIEW-ROUND5-2026-10.md
// R5-16): replace the settlement key, replace the guardian, write a made-up spent root down, clamp the vault's outflows
// at once, and cancel a proposal that is not yours. One script, one action per run, and NOTHING IS SENT unless the
// command says --send.
//
//   bun scripts/mainnet/config-change.ts status  --i-understand-this-is-mainnet
//   bun scripts/mainnet/config-change.ts propose --i-understand-this-is-mainnet --settlement <new key> [--write-down]
//   bun scripts/mainnet/config-change.ts propose --i-understand-this-is-mainnet --guardian <new key>
//   bun scripts/mainnet/config-change.ts apply   --i-understand-this-is-mainnet <the same change flags as the proposal>
//   bun scripts/mainnet/config-change.ts cancel  --i-understand-this-is-mainnet
//   bun scripts/mainnet/config-change.ts tighten --i-understand-this-is-mainnet --outflow-cap-usdc 1000
//   bun scripts/mainnet/config-change.ts record  --i-understand-this-is-mainnet
//   bun scripts/mainnet/config-change.ts <action> --rehearsal [--yes] ...          the same against a local validator
//
// Actions (the instruction of programs/trellis_credits each one builds; no other program is touched):
//   status    read-only: authority, settlement key, guardian, outflow rate and cap, spent and settled totals, and the
//             pending proposal with what it would change and where its timelock stands
//   propose   propose_config: recorded on chain, applicable 24 hours later (CONFIG_TIMELOCK) and for 7 days after that.
//             One proposal can carry several changes; a program holds ONE proposal at a time.
//   apply     resolve_config(apply = true) of the pending proposal. The command repeats the change flags, and the
//             proposal on chain must be exactly that change: a proposal somebody else made is never applied from here.
//   cancel    resolve_config(apply = false): drops the pending proposal, whatever it is (this is how a proposal you did
//             not make is answered). The authority only; anyone once the proposal has expired.
//   tighten   update_config: takes effect AT ONCE, and only ever tightens: a lower outflow cap per 24 hours (each of the
//             two allowances, host payouts and closure refunds; never below 1,000 USDC) or a lower settlement rate.
//             This is the brake on closure refunds, which no pause stops. The way back is `propose` and 24 hours.
//   record    after an `apply` that was executed elsewhere (a Squads vault transaction): write the settlement key and
//             the guardian the chain now names into the deployments record, after a typed confirmation, so that
//             verify.ts and the monitor's authority.drift judge against the new keys. `apply --send` does it itself.
//
// The change (propose, apply):
//   --settlement <key>          the new settlement authority (the public key of the new SETTLEMENT_PRIVATE_KEY)
//   --guardian <key>            the new guardian (a key of its own: not the authority, a worker key or a multisig member)
//   --write-down                write spent_total down to settled_total when the proposal is applied: the repair for a
//                               spent root a stolen settlement key committed. It forgets ALL committed-but-unsettled
//                               spend, honest or not; the settlement worker commits again from what was really settled.
//   --outflow-cap-usdc <n>      the absolute outflow bound per 24 hours, in whole USDC (propose: raise it again; tighten: lower it)
//   --settle-rate-bps <n>       the share of the vault per 24 hours, in basis points (at most 5000)
//
// Who signs. The config authority: the operator key before the hand-over, the multisig vault after it.
//   (default)                   DRY RUN. The instruction is built for the authority the chain names, printed (program,
//                               accounts, data) and simulated against the chain. Nothing is sent, no key is loaded.
//   --send                      the operator key (MAINNET_DEPLOYER_KEYPAIR) signs and sends, after a typed confirmation
//                               that cannot be answered in advance on mainnet. Refused when the chain's authority is
//                               not that key (after the hand-over).
//   --print --signer <vault>    after the hand-over: the same instruction with the vault as its signer, printed and
//                               written to deployments/<cluster>.config-change.json for ONE Squads vault transaction
//                               (vault 0; the vault is the only signer, so no second signature is needed at execution;
//                               `propose` makes the vault pay about 0.002 SOL of rent, returned when it resolves).
//                               Refused when <vault> is not the authority the chain names. Sends nothing.
//   --via-rehearsal-vault       rehearsal only: execute as the vault through the stand-in loaded at the Squads program id
//   --program-id trellis_credits=<id>   the program id, typed; it must agree with the deployments record when there is one
//
// Like pause.ts it runs from ANY checkout: the program id is the deployments record's (or --program-id), never this
// tree's declare_id! line (lib.ts incidentIdWitness). It reads the chain every time and judges the command against
// what is there: a second run of the same command finds its work done and sends nothing.
//
// What this script does not do: hand the AUTHORITY over (handover.ts), change the treasury account, the per-key cap or
// the timings (no incident procedure names them), or touch another program. trellis_credits is the one program of the
// launch tier; the guardians of trellis_tab, trellis_bond, trellis_capacity and trellis_rules (later tiers) have no
// script here yet. And it does not create the Squads proposal: it prints what the members put into one. How a printed
// instruction becomes a vault transaction (the Squads SDK or CLI, or the app's transaction builder) has not been run
// against the real Squads program by this kit; the rehearsal executes it through a stand-in.
import { writeFileSync } from "node:fs";
import { ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { SETTLE_WINDOW_FLOOR_UNITS, decodePendingCreditsConfig, proposeConfigIx, resolveConfigIx, updateConfigIx, type CreditsConfigChange } from "../../src/solana/programs/credits.ts";
import { MAINNET_FLAG, REHEARSAL_FLAG, assertCluster, confirm, connect, deploymentsFile, expectFlags, explorer, fail, incidentProgramIds, loadDeployer, loadRecord, modeOf, optionalPubkey, parseArgs, pubkey, rpcHost, rpcUrl, saveRecord, table } from "./lib.ts";
import { USDC } from "./params.ts";
import { MAINNET_PROPOSAL_TTL_SECONDS, pendingAddress, proposalLifecycle, type Lifecycle } from "./plan.ts";
import { SQUADS_PROGRAM_ID, rehearsalVaultExecuteIx, vaultPda } from "./squads.ts";
import { chainTime, fundedPayer, readBuildProfile, readChainState, simulateInstructions } from "./state.ts";

const P = "trellis_credits" as const;
/** MAX_SETTLE_RATE_BPS of programs/trellis_credits/src/constants.rs: the program refuses a higher rate by any path. */
const MAX_SETTLE_RATE_BPS = 5_000;
const ACTIONS = ["status", "propose", "apply", "cancel", "tighten", "record"] as const;
const args = parseArgs(process.argv.slice(2), ["--settlement", "--guardian", "--outflow-cap-usdc", "--settle-rate-bps", "--signer", "--program-id", "--multisig-account"]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--write-down", "--send", "--print", "--via-rehearsal-vault", "--yes"]);
const action = args.positional[0] as (typeof ACTIONS)[number] | undefined;
if (!action || !ACTIONS.includes(action) || args.positional.length !== 1) fail(`usage: bun scripts/mainnet/config-change.ts <${ACTIONS.join("|")}> ${MAINNET_FLAG}|${REHEARSAL_FLAG} [--settlement <key>] [--guardian <key>] [--write-down] [--outflow-cap-usdc <n>] [--settle-rate-bps <n>] [--send | --print --signer <vault>]\nWithout --send nothing is sent: the instruction is built, printed and simulated.`, 2);
const mode = modeOf(args);
const SEND = args.flags.has("--send"), PRINT = args.flags.has("--print"), VIA_STAND_IN = args.flags.has("--via-rehearsal-vault");
if (VIA_STAND_IN && mode === "mainnet") fail("--via-rehearsal-vault is for rehearsals only: on mainnet the Squads program id is the real Squads program.", 2);
if ([SEND, PRINT, VIA_STAND_IN].filter(Boolean).length > 1) fail("--send, --print and --via-rehearsal-vault are three different ways to run: pass one of them, or none for a dry run.", 2);
if (PRINT !== args.options.has("--signer")) fail("--print and --signer <the authority that will sign> go together: --print --signer <vault>.", 2);
if (action === "status" && (SEND || PRINT || VIA_STAND_IN)) fail("status only reads.", 2);
if (action === "record" && (PRINT || VIA_STAND_IN)) fail("record writes the deployments record on this machine: it takes --send (after a typed confirmation) or nothing (to show what it would write).", 2);

// ---- The change the command names ----------------------------------------------------------------------------------------------
type Change = { settlement: string | null; guardian: string | null; writeDown: boolean; outflowCap: bigint | null; settleRateBps: number | null };
function integer(name: string, min: number, max: number): number | null {
  const v = args.options.get(name);
  if (v === undefined) return null;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) fail(`${name} must be a whole number from ${min} to ${max}.`, 2);
  return Number(v);
}
const capUsdc = integer("--outflow-cap-usdc", Number(SETTLE_WINDOW_FLOOR_UNITS / 1_000_000n), 999_999_999);
const named: Change = {
  settlement: optionalPubkey(args.options.get("--settlement"), "--settlement <the new settlement key>")?.toBase58() ?? null,
  guardian: optionalPubkey(args.options.get("--guardian"), "--guardian <the new guardian key>")?.toBase58() ?? null,
  writeDown: args.flags.has("--write-down"),
  outflowCap: capUsdc === null ? null : USDC(capUsdc),
  settleRateBps: integer("--settle-rate-bps", 0, MAX_SETTLE_RATE_BPS),
};
const changes = (c: Change) => [c.settlement ? `settlement key -> ${c.settlement}` : "", c.guardian ? `guardian -> ${c.guardian}` : "", c.writeDown ? "write spent_total down to settled_total" : "", c.outflowCap !== null ? `outflow cap per 24 h -> ${usdc(c.outflowCap)} USDC` : "", c.settleRateBps !== null ? `settlement rate -> ${c.settleRateBps} bps` : ""].filter(Boolean);
const usdc = (units: bigint) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const sameChange = (a: Change, b: Change) => a.settlement === b.settlement && a.guardian === b.guardian && a.writeDown === b.writeDown && a.outflowCap === b.outflowCap && a.settleRateBps === b.settleRateBps;
const namesSomething = changes(named).length > 0;
if ((action === "status" || action === "cancel" || action === "record") && namesSomething) fail(`${action} takes no change flags.`, 2);
if ((action === "propose" || action === "apply" || action === "tighten") && !namesSomething) fail(`${action} needs the change: --settlement <key>, --guardian <key>, --write-down, --outflow-cap-usdc <n> or --settle-rate-bps <n>.${action === "apply" ? " apply repeats what was proposed, and applies the pending proposal only when it is exactly that." : ""}`, 2);
if (action === "tighten" && (named.settlement || named.guardian || named.writeDown)) fail("tighten takes --outflow-cap-usdc and --settle-rate-bps only: a new key or a write-down waits the 24 hours (propose).", 2);

// ---- The chain, as it is now -----------------------------------------------------------------------------------------------------
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const rec = loadRecord(mode, genesis);
const { ids, from: idFrom } = incidentProgramIds(mode, rec, genesis, [P], args.options.get("--program-id"));
const id = ids[P];
type Pending = { change: Change; other: string[]; effectiveAt: number; life: Lifecycle };
async function read() {
  const state = await readChainState(conn, { [P]: id });
  const config = state.configs[P], limiter = state.limiter;
  if (!state.programs[P].deployed || !state.programs[P].upgradeable) fail(`No upgradeable program is deployed at ${id.toBase58()} (${idFrom[P]}) on this chain. Nothing was sent.`, 1);
  if (!config || !limiter) fail(`trellis_credits at ${id.toBase58()} is not initialised (${state.legacy.includes(P) ? "its config is in an earlier layout: run init.ts" : !config ? "no config account" : "no outflow limiter account"}). Nothing was sent.`, 1);
  const now = await chainTime(conn);
  const info = await conn.getAccountInfo(pendingAddress(P, id), "confirmed");
  let pending: Pending | null = null;
  // Lamports somebody sent to the address are not a proposal: the account must be the program's and decode as one.
  const raw = info && info.owner.equals(id) ? decodePendingCreditsConfig(info.data) : null;
  if (raw) {
    const p = raw.params as Record<string, unknown>;
    const b58 = (k: unknown) => (k ? (k as PublicKey).toBase58() : null);
    const change: Change = { settlement: b58(p.settlement_authority), guardian: b58(p.guardian), writeDown: p.write_down_spent === true, outflowCap: (p.outflow_cap_per_window as bigint | null) ?? null, settleRateBps: (p.settle_rate_bps as number | null) ?? null };
    // Everything else a proposal can carry is something this script never proposes: a hand-over, a treasury, a cap, a timing.
    const known = new Set(["settlement_authority", "guardian", "write_down_spent", "outflow_cap_per_window", "settle_rate_bps"]);
    const other = [...Object.entries(p).filter(([k, v]) => !known.has(k) && v !== null && v !== undefined && v !== false).map(([k, v]) => `${k} = ${v instanceof PublicKey ? v.toBase58() : String(v)}`), ...(raw.newTreasury ? [`new_treasury = ${raw.newTreasury.toBase58()}`] : [])];
    pending = { change, other, effectiveAt: Number(raw.effectiveAt), life: proposalLifecycle({ effectiveAt: Number(raw.effectiveAt) }, now, proposalTtl) };
  }
  return { config, limiter, pending, now };
}
// PROPOSAL_TTL is the deployed build's own (7 days on the mainnet build), asked of the program once.
const payer = await fundedPayer(conn, [rec.deployer, rec.authorities?.multisigVault, rec.authorities?.guardian, rec.authorities?.settlementAuthority]);
const profile = await readBuildProfile(conn, P, id, payer);
const proposalTtl = Number(profile.floors.proposalTtl ?? MAINNET_PROPOSAL_TTL_SECONDS);
let { config, limiter, pending, now } = await read();
const authority = config.authority;
const iso = (t: number) => new Date(t * 1000).toISOString();
const span = (s: number) => (s < 3600 ? `${Math.max(0, Math.ceil(s / 60))} min` : s < 2 * 86_400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86_400).toFixed(1)} d`);
const describePending = (p: Pending) => `${[...changes(p.change), ...p.other].join("; ") || "nothing"}  [${p.life.state === "pending" ? `applicable in ${span(p.life.toEffective)} (${iso(p.effectiveAt)})` : p.life.state === "applicable" ? `APPLICABLE NOW, until ${iso(p.life.expiresAt)}` : `EXPIRED ${iso(p.life.expiresAt)}: it can only be cancelled`}]`;
const heldBy = authority.toBase58() === rec.deployer ? "the operator key" : authority.toBase58() === (rec.handover?.multisigVault ?? rec.authorities?.multisigVault) ? "the multisig vault" : "a key the deployments record does not name";

console.log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal"} config change: ${action} on ${rpcHost(url)}${action === "status" ? "  (read-only)" : SEND ? (action === "record" ? "" : "  (--send: signed by the operator key)") : PRINT ? "  (print only: nothing is sent)" : VIA_STAND_IN ? "  (rehearsal: executed as the vault through the stand-in)" : "  (DRY RUN: nothing is sent)"}`);
function show(): void {
  table([
    ["program", `${id.toBase58()}  (${idFrom[P]})`],
    ["config authority", `${authority.toBase58()}  (${heldBy})`],
    ["settlement key", config.settlementAuthority.toBase58()],
    ["guardian", config.guardian.toBase58()],
    ["outflow limit", `${limiter.rateBps} bps of the vault per 24 h, at most ${usdc(limiter.capPerWindow)} USDC, never under ${usdc(SETTLE_WINDOW_FLOOR_UNITS)} (each of host payouts and closure refunds)`],
    ["spent / settled", `${usdc(config.spentTotal)} / ${usdc(config.settledTotal)} USDC${config.spentTotal > config.settledTotal ? `  (${usdc(config.spentTotal - config.settledTotal)} committed and not paid out)` : ""}`],
    ["pending proposal", pending ? describePending(pending) : "none"],
  ]);
}
show();
if (action === "status") process.exit(0);

// ---- record: the record follows the chain, visibly ------------------------------------------------------------------------------
/** What the record says against what the chain names, for the two keys this script can replace. */
function recordDiff(): [string, string, string | undefined, string][] {
  const a = rec.authorities ?? {};
  return ([["settlement key", "settlementAuthority", a.settlementAuthority, config.settlementAuthority.toBase58()], ["guardian", "guardian", a.guardian, config.guardian.toBase58()]] as [string, string, string | undefined, string][]).filter(([, , was, is]) => was !== is);
}
function writeRecord(diff: ReturnType<typeof recordDiff>): void {
  rec.authorities = { ...(rec.authorities ?? {}) };
  for (const [what, field, was, is] of diff) { rec.authorities[field] = is; console.log(`  deployments record: ${what} ${was ?? "(not recorded)"} -> ${is}`); }
  saveRecord(mode, rec);
}
if (action === "record") {
  const diff = recordDiff();
  if (!diff.length) { console.log("\nThe deployments record names the settlement key and the guardian the chain names. Nothing to write."); process.exit(0); }
  console.log(`\nThe chain names ${diff.length === 1 ? "a key" : "keys"} the deployments record does not:`);
  table(diff.map(([what, , was, is]) => [what, `record ${was ?? "(not recorded)"}`, `chain ${is}`]));
  if (pending) fail("A proposal is pending: the record is written when nothing is in flight. Nothing was written.", 1);
  if (!SEND) { console.log("\nDry run: nothing was written. With --send the record takes the chain's keys, after a typed confirmation. Only do that for a change YOU applied: a key you did not install is an incident, not a record to update."); process.exit(0); }
  await confirm(mode, `record ${diff.map(([what, , , is]) => `${what.split(" ")[0]} ${is.slice(-6)}`).join(" ")}`, args);
  writeRecord(diff);
  console.log(`\nnext: update ${diff.map(([what]) => (what === "guardian" ? "MAINNET_GUARDIAN" : "MAINNET_SETTLEMENT_AUTHORITY")).join(" and ")} in .env.mainnet.local, then bun scripts/mainnet/verify.ts ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --write-report`);
  process.exit(0);
}

// ---- Who signs ---------------------------------------------------------------------------------------------------------------------
const operator = SEND || VIA_STAND_IN ? loadDeployer(mode) : null;
const multisigAccount = VIA_STAND_IN ? pubkey(args.options.get("--multisig-account") ?? process.env.MAINNET_MULTISIG_ACCOUNT ?? rec.handover?.multisigAccount, "--multisig-account (to execute through the rehearsal vault)") : null;
const signer: PublicKey = SEND ? operator!.publicKey : PRINT ? pubkey(args.options.get("--signer"), "--signer <the authority that will sign>") : VIA_STAND_IN ? vaultPda(multisigAccount!) : authority;
const problems: string[] = [];
/** The state asked for is already there: nothing to send, and that is a success. */
let done: string | null = null;
const expiredCancel = action === "cancel" && pending?.life.state === "expired";
if (!signer.equals(authority) && !expiredCancel) {
  problems.push(SEND ? `the operator key ${signer.toBase58()} is not the config authority: the chain names ${authority.toBase58()} (${heldBy}). After the hand-over this is a Squads vault transaction: run the same command with --print --signer ${authority.toBase58()}`
    : `${signer.toBase58()} is not the config authority: the chain names ${authority.toBase58()} (${heldBy}). Only the authority can ${action === "tighten" ? "change the config" : `${action} a proposal`}`);
}

// ---- What the command asks, judged against the chain -----------------------------------------------------------------------------
const b = (k: string | null) => (k ? new PublicKey(k) : null);
const asParams = (c: Change): CreditsConfigChange => ({ settlementAuthority: b(c.settlement), guardian: b(c.guardian), writeDownSpent: c.writeDown, outflowCapPerWindow: c.outflowCap, settleRateBps: c.settleRateBps });
/** Whether the chain already carries everything `c` sets (a write-down: nothing is left to write down). */
const carried = (c: Change) => (!c.settlement || c.settlement === config.settlementAuthority.toBase58()) && (!c.guardian || c.guardian === config.guardian.toBase58()) && (!c.writeDown || config.spentTotal <= config.settledTotal) && (c.outflowCap === null || c.outflowCap === limiter.capPerWindow) && (c.settleRateBps === null || c.settleRateBps === limiter.rateBps);
let ix: TransactionInstruction | null = null;
let what = "";
if (action === "tighten") {
  const cap = named.outflowCap, rate = named.settleRateBps;
  if (cap !== null && cap > limiter.capPerWindow) problems.push(`--outflow-cap-usdc ${usdc(cap)} is ABOVE the cap on chain (${usdc(limiter.capPerWindow)} USDC): that loosens, and loosening waits 24 hours (config-change.ts propose --outflow-cap-usdc ${usdc(cap).replace(/,/g, "")})`);
  if (rate !== null && rate > limiter.rateBps) problems.push(`--settle-rate-bps ${rate} is ABOVE the rate on chain (${limiter.rateBps} bps): that loosens, and loosening waits 24 hours (propose)`);
  if (!problems.length && carried(named)) done = "the chain already carries exactly these values";
  ix = updateConfigIx(id, { authority: signer, outflowCapPerWindow: cap, settleRateBps: rate });
  what = `update_config (at once): ${changes(named).join("; ")}`;
} else if (action === "propose") {
  if (pending && sameChange(pending.change, named) && !pending.other.length) done = `exactly this change is proposed already: ${describePending(pending)}`;
  else if (pending) problems.push(`another proposal is pending: ${describePending(pending)}. A program holds one proposal at a time: apply it or cancel it first (if it is not yours: cancel, and treat the authority key as stolen)`);
  // The keys: each role is a key of its own (the production guards refuse a worker with two roles, and a guardian that
  // is the authority or one of its signers is no brake).
  const a = rec.authorities ?? {};
  const members = ((rec.handover?.multisig as { members?: { key: string }[] } | undefined)?.members ?? []).map((m): [string, string | undefined] => ["a member of the multisig", m.key]);
  const others: [string, string | undefined][] = [["the config authority", authority.toBase58()], ["the operator (deployer) key", rec.deployer], ["the multisig vault", rec.handover?.multisigVault ?? a.multisigVault], ["the anchorer key", a.anchorer ?? a.anchorAuthority], ["the all-zero address", PublicKey.default.toBase58()], ...members];
  for (const [flag, k, taken] of [["--settlement", named.settlement, [...others, ["the guardian", config.guardian.toBase58()], ["the guardian this proposal names", named.guardian ?? undefined]]], ["--guardian", named.guardian, [...others, ["the settlement key", config.settlementAuthority.toBase58()], ["the settlement key this proposal names", named.settlement ?? undefined]]]] as [string, string | null, [string, string | undefined][]][]) {
    if (!k) continue;
    for (const [whose, key] of taken) if (key === k) problems.push(`${flag} names ${whose} (${k}): every role is a key of its own`);
  }
  if (!done && named.settlement === config.settlementAuthority.toBase58()) problems.push(`--settlement names the settlement key the chain already carries (${named.settlement}): there is nothing to replace`);
  if (!done && named.guardian === config.guardian.toBase58()) problems.push(`--guardian names the guardian the chain already carries (${named.guardian}): there is nothing to replace`);
  // A change that only tightens needs no 24 hours, and waiting them in an incident is the mistake to prevent.
  const numeric = !named.settlement && !named.guardian && !named.writeDown;
  if (!done && numeric && (named.outflowCap === null || named.outflowCap <= limiter.capPerWindow) && (named.settleRateBps === null || named.settleRateBps <= limiter.rateBps)) problems.push("this change only tightens (or changes nothing): it takes effect at once with `config-change.ts tighten`, and needs no proposal");
  if (named.writeDown && config.spentTotal <= config.settledTotal) console.log(`  note: nothing is committed beyond what was settled right now (${usdc(config.spentTotal)} / ${usdc(config.settledTotal)} USDC); the write-down acts on what is there when the proposal is applied`);
  ix = proposeConfigIx(id, { authority: signer, ...asParams(named) });
  what = `propose_config (applicable 24 hours after it lands, then for 7 days): ${changes(named).join("; ")}`;
} else if (action === "apply") {
  if (!pending) { if (carried(named)) done = "no proposal is pending and the chain already carries this change: it was applied"; else problems.push("nothing is proposed: run `config-change.ts propose` with this change and wait out the 24 hours"); }
  else if (!sameChange(pending.change, named) || pending.other.length) problems.push(`the pending proposal is NOT what this command names. Pending: ${describePending(pending)}. Named: ${changes(named).join("; ")}. Nothing is applied from here unless both agree; a proposal you did not make is cancelled (config-change.ts cancel), never applied`);
  else if (pending.life.state === "pending") problems.push(`the timelock has not passed: applicable in ${span(pending.life.toEffective)} (${iso(pending.effectiveAt)})`);
  else if (pending.life.state === "expired") problems.push(`the proposal expired on ${iso(pending.life.expiresAt)}: the program no longer applies it. Cancel it (config-change.ts cancel) and propose again`);
  ix = resolveConfigIx(id, { signer, authority, apply: true });
  what = `resolve_config(apply = true): ${changes(named).join("; ")}`;
} else {
  if (!pending) done = "no proposal is pending";
  else console.log(`\nCancelling: ${describePending(pending)}${expiredCancel && !signer.equals(authority) ? "  (expired: anyone may clear it; its rent returns to the authority)" : ""}`);
  ix = resolveConfigIx(id, { signer, authority, apply: false });
  what = "resolve_config(apply = false): drop the pending proposal";
}

if (done && !problems.length) { console.log(`\nNothing to send: ${done}.`); process.exit(0); }
console.log(`\n  [1] ${what}`);
console.log(`      program ${ix.programId.toBase58()}`);
for (const k of ix.keys) console.log(`      account ${k.pubkey.toBase58()}${k.isSigner ? " signer" : ""}${k.isWritable ? " writable" : ""}${k.isSigner ? `   <- ${k.pubkey.equals(authority) ? `the authority (${heldBy})` : "the signer"}` : ""}`);
console.log(`      data    hex ${Buffer.from(ix.data).toString("hex")}  base64 ${Buffer.from(ix.data).toString("base64")}`);
if (problems.length) fail(`\nRefusing to ${action}:\n${problems.map((p) => `  - ${p}`).join("\n")}\nNothing was sent.`, 1);

// What the chain itself says to this instruction, before anybody signs it. No signature is needed and nothing is sent.
const simPayer = await fundedPayer(conn, [signer, payer]);
let simulated = "not simulated: no address with SOL is known to pay the simulated fee";
let refused = false;
if (simPayer) {
  const r = await simulateInstructions(conn, simPayer, [ix]).catch((e: Error) => ({ err: e.name, logs: [] as string[] }));
  refused = !!r.err;
  simulated = r.err ? `the chain would REFUSE it: ${r.logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean) ?? JSON.stringify(r.err)}` : "the chain accepts it";
}
console.log(`      simulation: ${simulated}`);
if (refused) fail("\nThe chain would refuse this instruction as it stands (see the simulation line). Nothing was sent.", 1);

if (!SEND && !VIA_STAND_IN) {
  if (PRINT) {
    const file = deploymentsFile(mode).replace(/\.json$/, ".config-change.json");
    writeFileSync(file, JSON.stringify({
      cluster: mode, network: rec.network, vault: signer.toBase58(), action, change: changes(named), generatedAt: new Date().toISOString(),
      note: "One Squads vault transaction, vault index 0, with exactly this instruction. The vault is its only signer.",
      transactions: [{ program: P, coSigners: [], instructions: [{ what, programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase64: Buffer.from(ix.data).toString("base64") }] }],
    }, null, 2) + "\n");
    console.log(`\n1 instruction printed for a Squads vault transaction (vault 0), and written to ${file.split("/").slice(-2).join("/")}. Nothing was sent.`);
    console.log("A member creates the vault transaction with exactly this instruction; two members approve after comparing every account and the data with this printout; any member executes it. Then run `config-change.ts status`.");
  } else console.log(`\nDry run: 1 instruction built${simPayer ? " and simulated" : ""}. Nothing was sent. ${signer.toBase58() === rec.deployer ? "To send it with the operator key: the same command with --send." : `The authority is ${heldBy}: the same command with --print --signer ${authority.toBase58()} writes it out for a Squads vault transaction.`}`);
  process.exit(0);
}

// ---- Send ----------------------------------------------------------------------------------------------------------------------------
if (VIA_STAND_IN) {
  const standIn = await conn.getAccountInfo(SQUADS_PROGRAM_ID, "confirmed");
  if (!standIn?.executable) fail("No program is loaded at the Squads program id on this validator: start it with scripts/mainnet/rehearse.sh, which loads the rehearsal vault there.", 2);
}
const short = (c: Change) => [c.settlement ? `settlement ${c.settlement.slice(-6)}` : "", c.guardian ? `guardian ${c.guardian.slice(-6)}` : "", c.writeDown ? "write-down" : "", c.outflowCap !== null ? `cap ${usdc(c.outflowCap).replace(/,/g, "")}` : "", c.settleRateBps !== null ? `rate ${c.settleRateBps}` : ""].filter(Boolean).join(" ");
await confirm(mode, action === "cancel" ? `cancel proposal on ${mode}` : `${action} ${short(named)}`, args);
const outer = VIA_STAND_IN ? rehearsalVaultExecuteIx(multisigAccount!, [ix]) : ix;
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.COMPUTE_UNIT_PRICE ?? 5000) }), outer), [operator!], { commitment: "confirmed" });
console.log(`\nsent  ${explorer(mode, "tx", sig)}`);

// Read it back: the exit status vouches for the chain, not for a transaction that was sent.
({ config, limiter, pending, now } = await read());
console.log("\nAfter it landed");
show();
const landed = action === "propose" ? !!pending && sameChange(pending.change, named) && !pending.other.length : action === "cancel" ? !pending : action === "apply" ? !pending && carried(named) : carried(named);
if (!landed) fail(`\nThe transaction landed but the chain does not read back as asked (${action}). Stop and look at the table above.`, 1);
if (action === "propose") console.log(`\nProposed. Applicable from ${iso(pending!.effectiveAt)} (in ${span(pending!.life.toEffective)}) until ${iso(pending!.life.expiresAt)}; the monitor reports it the whole time (config.proposed). Then: the same flags with \`apply\`.`);
if (action === "apply") {
  // The record follows the keys THIS apply installed, and no other: a difference that was there before is not this
  // run's to settle (that is drift, and `config-change.ts record` shows it and asks).
  const diff = recordDiff().filter(([, field]) => (field === "guardian" ? !!named.guardian : !!named.settlement));
  if (diff.length) { writeRecord(diff); console.log(`next: update ${diff.map(([w]) => (w === "guardian" ? "MAINNET_GUARDIAN" : "MAINNET_SETTLEMENT_AUTHORITY")).join(" and ")} in .env.mainnet.local, then bun scripts/mainnet/verify.ts ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG} --write-report`); }
}
