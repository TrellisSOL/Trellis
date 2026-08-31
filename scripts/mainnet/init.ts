// Initialise the Trellis program configs of a launch tier on mainnet through the router's own instruction builders
// (src/solana/programs/*.ts), with the mainnet parameters of scripts/mainnet/params.ts.
//
//   bun scripts/mainnet/init.ts --i-understand-this-is-mainnet --precheck   read-only: what exists, what would be sent
//   bun scripts/mainnet/init.ts --i-understand-this-is-mainnet --prepare    create the treasury token accounts the tier needs (can run BEFORE the deploy)
//   bun scripts/mainnet/init.ts --i-understand-this-is-mainnet              typed confirmation, then every missing config
//   bun scripts/mainnet/init.ts --rehearsal [--yes]                         the same against a local validator
//   options: --tier / --programs   the launch tier (default: the tier of the deployments record)
//            --pause-capacity      pause trellis_capacity right after its init. A PAUSE LAPSES AFTER 72 HOURS: this keeps
//                                  commitments and sales closed only while the authority renews it (pause.ts --renew). To
//                                  keep capacity closed for longer, leave the program out of the tier.
//
// Run it right after scripts/mainnet/deploy.sh. Every init instruction requires the signature of the program's UPGRADE
// AUTHORITY and reads it from the ProgramData account (security review TR-13), so nobody else can create a config
// between the deploy and this script; this script still checks before and after, and refuses to run when the deployer
// is not (or no longer) the upgrade authority of a program it is about to initialise. An immutable program can never be
// initialised, which is why the hand-over moves the upgrade authority only after every program has its config.
//
// Who holds what after this script:
//   deployer (the one operator key)   upgrade authority and config authority of every program, until the hand-over resolves
//   MAINNET_GUARDIAN                  guardian (pause) of credits, tab, bond, capacity and rules: the FINAL key, a key of
//                                     its own, never the deployer and never the multisig vault
//   MAINNET_ANCHORER                  trellis_anchor authority, named in the init instruction itself: it posts the hourly roots
//   MAINNET_SETTLEMENT_AUTHORITY, MAINNET_SLASHER, sale and HVX authorities: the role keys named in the environment
//   MAINNET_MULTISIG_VAULT            owner of the treasury token accounts
// handover.ts then proposes the vault as the new authority, and 24 hours later the vault takes it (and the upgrade authority).
//
// A later tier: run deploy.sh with the larger --tier, then this script with the same --tier. Configs that exist are
// left alone; only the new programs are initialised. If the hand-over already happened, the deployer is no longer the
// upgrade authority of anything: the new programs are deployed by the deployer (which is their upgrade authority),
// initialised here, and handed over with handover.ts in the same two steps.
//
// A deployment made by an earlier build: a config from before `paused_until` / `guardian_pause_ready_at` is shorter than
// today's layout, and trellis_credits' outflow limiter moved to ["limiter_v2"]. Such a config is NOT decoded here (its
// missing fields would silently read as "nothing is paused"); this script grows it with migrate_config and creates the
// limiter with init_limiter. Both can be paid for by anyone, choose nothing and work once. After init the script reads
// everything back: every config in the current layout, no pause set, the guardian free to pause, and the limiter at
// the expected rate with both allowances untouched.
//
// The record (security/REVIEW-ROUND3-2026-10.md R3-21). Nothing about roles, authorities or parameters is written to the
// deployments record until EVERYTHING has been read back and found as the environment says: every config in the
// current layout, the authority, the guardian, and every role and payout account a config names (settlement, slasher,
// sale, HVX, the anchorer, the first receipt signer, the treasury accounts). What is then written is what was READ from
// the chain. A run whose read-back fails leaves the record's roles as they were: a changed MAINNET_* variable on a rerun
// is a refusal, never a silent rewrite of what verify.ts and the monitor compare the chain with.
//
// The addresses (security/REVIEW-ROUND3-2026-10.md R3-11, residual). The guardian, the settlement key, the anchorer, the
// vault and every other role come from the environment, where a wrong line looks exactly like a right one. So before
// a config is created, each address this run would write is shown in full, with the variable it came from, and is
// confirmed by itself: the operator types its role and its last six characters (`guardian a1B2c3`). The same for the
// vault before --prepare creates token accounts it will own. On mainnet nothing answers in advance (no --yes).
//
// This script reads public keys only. It generates no key and never sees a role key's secret.
// Idempotent: a config that exists with the expected authority is left alone and recorded.
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, unpackAccount } from "@solana/spl-token";
import { bondClaimerPda } from "../../src/solana/programs/capacity.ts";
import { creditsPdas } from "../../src/solana/programs/credits.ts";
import { feeRouterPdas } from "../../src/solana/programs/fee-router.ts";
import { enforcerPda } from "../../src/solana/programs/tab.ts";
import { MAINNET_FLAG, REHEARSAL_FLAG, TIER_OPTIONS, assertCluster, confirm, connect, expectFlags, explorer, fail, loadDeployer, loadRecord, modeOf, parseArgs, programIds, readRoles, roleConfirmations, roleProblems, rpcHost, rpcUrl, saveRecord, selection, sol, table, type ProgramName, type Roles } from "./lib.ts";
import { MAINNET_USDC, PARAMS, describeParams } from "./params.ts";
import { SEEDED, createLimiterIx, initSteps, migrateConfigIx, pauseFields, pauseView, tokenAccounts, tokenAccountsNeeded, type Step } from "./plan.ts";
import { chainTime, holders, readChainState } from "./state.ts";
import { tierOf } from "./tiers.ts";

const args = parseArgs(process.argv.slice(2), [...TIER_OPTIONS]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--precheck", "--prepare", "--pause-capacity", "--yes"]);
const mode = modeOf(args);
const PRECHECK = args.flags.has("--precheck");
const PREPARE = args.flags.has("--prepare");
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const deployer = loadDeployer(mode);
const authority = deployer.publicKey;
const rec = loadRecord(mode, genesis);
const { tier, programs: selected } = selection(args, rec);
const cuPrice = Number(process.env.COMPUTE_UNIT_PRICE ?? 5000);
const log = (...a: unknown[]) => console.log(...a);

log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal"} init on ${rpcHost(url)}; tier ${tier} (${selected.join(", ") || "no programs"}); deployer ${authority.toBase58()}, balance ${sol(await conn.getBalance(authority, "confirmed"))} SOL`);
if (!selected.length) { log("\nThis tier deploys no program, so there is nothing to initialise."); process.exit(0); }

const { roles: partial, problems } = readRoles(process.env, selected);
const blocking = [...problems, ...roleProblems(partial, authority)];
if (blocking.length) fail(`Role inputs are not ready:\n${blocking.map((b) => `  - ${b}`).join("\n")}\nSee config/mainnet.env.example.`, 2);
const roles = partial as Roles;
const usdcMint = new PublicKey(MAINNET_USDC);

/**
 * Shows each address with where it came from and what to type, then asks for each one in turn. Nothing is sent before
 * the last of them is typed; a mismatch, or a run without a terminal, stops here.
 */
async function confirmAddresses(list: ReturnType<typeof roleConfirmations>, title: string): Promise<void> {
  if (!list.length) return;
  log(`\n${title}. Compare each with its source (the device or the file the key was made on), character by character:`);
  table([["role", "address", "from", "type to confirm"], ...list.map((x) => [x.role, x.address, x.source, x.phrase])]);
  for (const x of list) await confirm(mode, x.phrase, args);
}
async function send(ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, [deployer], { commitment: "confirmed" });
}
const exists = async (k: PublicKey) => !!(await conn.getAccountInfo(k, "confirmed"));

// ---- Treasury token accounts (owned by the multisig vault from the start, so they need no hand-over) ----------------------
// The treasury is the vault's associated USDC account. The other three are separate USDC accounts at addresses derived
// from the deployer key and a fixed seed, so a rerun finds them again without any local record. Only the accounts the
// tier's programs pay into are created: `credits` needs the treasury alone.
const accounts = await tokenAccounts(authority, usdcMint, roles.multisigVault);
const neededAccounts = tokenAccountsNeeded(selected);

/** A token account that exists must be a USDC account owned by the vault; anything else stops the run. */
async function tokenAccountState(address: PublicKey, what: string): Promise<"missing" | "ok"> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) return "missing";
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) fail(`${what} ${address.toBase58()} exists but is not an SPL Token account.`);
  const acct = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!acct.mint.equals(usdcMint) || !acct.owner.equals(roles.multisigVault)) fail(`${what} ${address.toBase58()} exists with mint ${acct.mint.toBase58()} and owner ${acct.owner.toBase58()}; expected USDC owned by the multisig vault.`);
  return "ok";
}
async function prepareTokenAccounts(dryRun: boolean): Promise<void> {
  const rent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  if (neededAccounts.includes("treasury")) {
    if ((await tokenAccountState(accounts.treasury, "treasury")) === "missing") {
      log(`treasury: ${dryRun ? "would create" : "creating"} the vault's associated USDC account ${accounts.treasury.toBase58()}`);
      if (!dryRun) log(`  ${explorer(mode, "tx", await send([createAssociatedTokenAccountIdempotentInstruction(authority, accounts.treasury, roles.multisigVault, usdcMint)]))}`);
    } else log(`treasury: ${accounts.treasury.toBase58()} exists`);
  }
  for (const [name, seed] of Object.entries(SEEDED) as [keyof typeof SEEDED, string][]) {
    if (!neededAccounts.includes(name)) continue;
    const address = accounts[name];
    if ((await tokenAccountState(address, name)) === "ok") { log(`${name}: ${address.toBase58()} exists`); continue; }
    log(`${name}: ${dryRun ? "would create" : "creating"} USDC account ${address.toBase58()} owned by the multisig vault`);
    if (dryRun) continue;
    const sig = await send([
      SystemProgram.createAccountWithSeed({ fromPubkey: authority, basePubkey: authority, seed, newAccountPubkey: address, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(address, usdcMint, roles.multisigVault),
    ]);
    log(`  ${explorer(mode, "tx", sig)}`);
  }
}
function recordAccounts(ids: Partial<Record<ProgramName, PublicKey>>): void {
  rec.mints = { ...(rec.mints ?? {}), usdc: usdcMint.toBase58(), usdcSource: mode === "mainnet" ? "circle-mainnet" : "rehearsal", ...(roles.trlsMint ? { trls: roles.trlsMint.toBase58(), trlsDecimals: PARAMS.trlsDecimals } : {}) };
  rec.accounts = { ...(rec.accounts ?? {}) };
  if (neededAccounts.includes("treasury")) rec.accounts.treasuryUsdc = accounts.treasury.toBase58();
  for (const name of ["refundPool", "capacityRefund", "workersVault"] as const) if (neededAccounts.includes(name)) rec.accounts[name] = accounts[name].toBase58();
  const has = (p: ProgramName) => selected.includes(p) && ids[p];
  if (has("trellis_credits")) { rec.accounts.creditsVault = creditsPdas(ids.trellis_credits!).vault.toBase58(); rec.accounts.creditsLimiter = creditsPdas(ids.trellis_credits!).limiter.toBase58(); }
  if (has("trellis_tab")) rec.accounts.tabEnforcer = enforcerPda(ids.trellis_tab!).toBase58();
  if (has("trellis_capacity")) rec.accounts.capacityBondClaimer = bondClaimerPda(ids.trellis_capacity!).toBase58();
  if (has("trellis_fee_router")) { const p = feeRouterPdas(ids.trellis_fee_router!); rec.accounts.feeVault = p.feeVault.toBase58(); rec.accounts.trlsVault = p.trlsVault.toBase58(); }
}

if (PREPARE) {
  // Before the deploy: only the token accounts, which depend on no Trellis program.
  log(`\n--prepare: treasury token accounts for tier ${tier}: ${neededAccounts.join(", ") || "none"}`);
  table([["owner of each", roles.multisigVault.toBase58()], ["USDC mint", usdcMint.toBase58()]]);
  if (!PRECHECK && neededAccounts.length) {
    // The token accounts are created for this owner and can never be given another one by this kit: confirm it by itself.
    await confirmAddresses(roleConfirmations(roles, selected).filter((x) => x.role === "vault"), "The owner of every token account this run creates");
    await confirm(mode, `prepare ${mode} treasury accounts`, args);
  }
  await prepareTokenAccounts(PRECHECK);
  recordAccounts(programIds(mode, rec, false));
  if (!PRECHECK) saveRecord(mode, rec);
  log(PRECHECK ? "\nprecheck only; nothing sent." : "\ntreasury token accounts are ready. Next: scripts/mainnet/deploy.sh");
  process.exit(0);
}

// ---- The configs -----------------------------------------------------------------------------------------------------------
const ids = programIds(mode, rec, selected);
const state = await readChainState(conn, ids);
const missing = selected.filter((p) => !state.programs[p].deployed);
if (missing.length) fail(`Not deployed: ${missing.join(", ")}. Run scripts/mainnet/deploy.sh --tier ${tier} first; init does not run on a partial deployment.`, PRECHECK ? 1 : 2);

// A program can be invoked from the slot AFTER the one it was deployed in. Straight after deploy.sh that slot may not
// have come yet: wait for it instead of failing with "Program is not deployed".
const newest = selected.reduce((m, p) => (state.programs[p].lastDeploySlot !== null && state.programs[p].lastDeploySlot! > m ? state.programs[p].lastDeploySlot! : m), 0n);
for (let i = 0; i < 60 && BigInt(await conn.getSlot("confirmed")) <= newest + 1n; i++) await new Promise((r) => setTimeout(r, 500));

const steps = initSteps({ ids, programs: selected, operator: authority, roles, usdcMint, accounts, pauseCapacity: args.flags.has("--pause-capacity") });

/** The authority a config that already exists must carry: the deployer, or the multisig once handed over (the anchorer for trellis_anchor). */
function foreign(program: ProgramName): string | null {
  const h = holders(state).find((x) => x.program === program && x.role === "authority");
  if (!h?.address) return "exists but does not decode";
  const ok = program === "trellis_anchor" ? [roles.anchorer.toBase58()] : [authority.toBase58(), roles.multisigVault.toBase58()];
  return ok.includes(h.address) ? null : h.address;
}

log("\nConfigs");
const plan: (string | number)[][] = [["program", "config account", "action"]];
const todo: Step[] = [];
// Accounts of an earlier build, repaired before anything else is read from them.
const repairs: { program: ProgramName; what: string; build: () => TransactionInstruction[] }[] = [];
for (const p of state.legacy.filter((x) => selected.includes(x))) repairs.push({ program: p, what: "migrate_config (grow the config to the current layout; the new pause fields start at zero)", build: () => [migrateConfigIx(p, ids[p], authority)!] });
if (selected.includes("trellis_credits") && (state.configs.trellis_credits || state.legacy.includes("trellis_credits")) && !state.limiter) repairs.push({ program: "trellis_credits", what: `init_limiter (create the outflow limiter at ["limiter_v2"] ${state.limiterAddress})`, build: () => [createLimiterIx(ids.trellis_credits, authority)] });
for (const s of steps) {
  if (state.legacy.includes(s.program)) {
    // Its authority cannot be read until it is migrated; the read-back after the migration checks it.
    plan.push([s.program, s.pda.toBase58(), "exists in an earlier layout; migrate_config, then check"]);
    rec.configs = { ...(rec.configs ?? {}), [s.program]: { ...(rec.configs?.[s.program] ?? {}), address: s.pda.toBase58(), status: rec.configs?.[s.program]?.status ?? "exists" } };
  } else if (await exists(s.pda)) {
    const other = foreign(s.program);
    if (other) fail(`\nSTOP: ${s.program}'s config ${s.pda.toBase58()} already exists and its authority is ${other}.\nThat is not a key of this deployment. Do not continue and do not route funds to it. With the upgrade authority still on the deployer, close the program (solana program close <id>, which retires the address) and redeploy with fresh program keypairs.`);
    plan.push([s.program, s.pda.toBase58(), "exists with the expected authority; skip"]);
    rec.configs = { ...(rec.configs ?? {}), [s.program]: { ...(rec.configs?.[s.program] ?? {}), address: s.pda.toBase58(), status: rec.configs?.[s.program]?.status ?? "exists" } };
  } else {
    // Only the upgrade authority can initialise: say so before the chain does.
    const upgrade = state.programs[s.program].upgradeAuthority;
    if (upgrade !== authority.toBase58()) fail(`\n${s.program} has no config yet and its upgrade authority is ${upgrade ?? "none (the program is immutable and can never be initialised)"}, not the deployer. Its init instruction only accepts the upgrade authority. If that is the multisig vault, the init is a Squads proposal carrying this instruction (init.ts --precheck prints what it does); if the program is immutable, redeploy at a fresh address.`);
    plan.push([s.program, s.pda.toBase58(), s.what]);
    todo.push(s);
  }
}
table(plan);
log("\nRoles");
const has = (p: ProgramName) => selected.includes(p);
table([
  ["upgrade authority, config authority, registry authority", `${authority.toBase58()} (deployer, until the hand-over resolves)`],
  ["guardian (final; not changed by the hand-over)", roles.guardian?.toBase58() ?? "not needed in this tier"],
  ...(has("trellis_anchor") ? [["trellis_anchor authority (final)", roles.anchorer.toBase58()], ["receipt signer", roles.receiptSigner.toBase58()]] : []),
  ...(has("trellis_credits") ? [["settlement authority", roles.settlement.toBase58()]] : []),
  ...(has("trellis_bond") ? [["slasher", roles.slasher.toBase58()]] : []),
  ...(has("trellis_capacity") ? [["sale authority", roles.sale.toBase58()], ["HVX authority", roles.hvx.toBase58()]] : []),
  ["treasury token accounts owned by", roles.multisigVault.toBase58()],
]);
log("\nParameters (rows of programs outside this tier do not apply)");
table(describeParams(roles.gradePricesUsdc ?? null));

if (repairs.length) { log("\nAccounts made by an earlier build"); table(repairs.map((r) => [r.program, r.what])); }
if (PRECHECK) {
  await prepareTokenAccounts(true);
  log(`\nprecheck only; nothing sent. ${todo.length ? `${todo.length} config(s) would be initialised.` : "Every config exists."}${repairs.length ? ` ${repairs.length} account(s) of an earlier build would be brought to the current layout.` : ""}`);
  process.exit(0);
}
// Every address this run writes into a config that does not exist yet, each confirmed by itself, then the run as a whole.
if (todo.length) await confirmAddresses(roleConfirmations(roles, todo.map((s) => s.program)), `The addresses this run writes into ${todo.length} new config(s), from the environment`);
if (todo.length || repairs.length) await confirm(mode, `initialise ${todo.length} configs on ${mode}`, args);
for (const r of repairs) log(`${r.program}: ${r.what}  ${explorer(mode, "tx", await send(r.build()))}`);
await prepareTokenAccounts(false);

for (const s of todo) {
  // Re-check right before sending.
  if (await exists(s.pda)) fail(`STOP: ${s.program}'s config appeared while this script was running. Run it again with --precheck and read the result before doing anything else.`);
  const sig = await send(s.build());
  // A confirmed transaction is a fact and is recorded at once; who holds what is recorded only after the read-back below.
  rec.configs = { ...(rec.configs ?? {}), [s.program]: { address: s.pda.toBase58(), signature: sig, initialisedAt: new Date().toISOString(), status: "initialised" } };
  saveRecord(mode, rec);
  log(`${s.program}: ${s.what}  ${explorer(mode, "tx", sig)}`);
}

// ---- Read everything back; only then record who holds what ------------------------------------------------------------------
const after = await readChainState(conn, ids);
const bad: string[] = [];
for (const p of selected) if (!after.configs[p]) bad.push(`${p}: config does not decode${after.legacy.includes(p) ? " (it is still in the layout of an earlier build)" : ""}`);
// The outflow limiter and the pauses, as a fresh init leaves them.
if (has("trellis_credits")) {
  if (!after.limiter) bad.push(`trellis_credits: no outflow limiter at ["limiter_v2"] ${after.limiterAddress}`);
  else if (after.limiter.rateBps !== PARAMS.credits.settleRateBps) bad.push(`trellis_credits: the outflow limiter's rate is ${after.limiter.rateBps} bps, expected ${PARAMS.credits.settleRateBps}`);
}
const freshly = new Set(todo.map((s) => s.program));
const nowOnChain = await chainTime(conn);
for (const f of pauseFields(after.configs, after.limiter)) {
  const v = pauseView(f, nowOnChain);
  const program = f.slot.split(".")[0] as ProgramName;
  if (!selected.includes(program)) continue;
  const expected = f.slot === "trellis_capacity" && args.flags.has("--pause-capacity");
  // A config this run created must carry no pause and no guardian cooldown (except the capacity pause that was asked for).
  if (freshly.has(program) && !expected && (v.flag || f.until !== 0 || f.guardianReadyAt !== 0)) bad.push(`${f.slot}: a fresh config carries pause state (flag ${v.flag}, until ${f.until}, guardian ready at ${f.guardianReadyAt})`);
  if (v.active) log(`note: ${f.slot} is PAUSED until ${new Date(v.until * 1000).toISOString()}${expected ? " (--pause-capacity; it lapses by itself then: the authority renews it with pause.ts --renew for as long as capacity should stay closed)" : ""}`);
  else if (v.lapsed) log(`note: ${f.slot}: a pause flag is set but lapsed ${new Date(v.until * 1000).toISOString()}; the program runs`);
}
for (const h of holders(after)) {
  if (!selected.includes(h.program)) continue;
  if (h.role === "authority") {
    const want = h.program === "trellis_anchor" ? [roles.anchorer.toBase58()] : [authority.toBase58(), roles.multisigVault.toBase58()];
    if (!h.address || !want.includes(h.address)) bad.push(`${h.program}: authority is ${h.address}, expected ${want[0]}`);
  }
  if (h.role === "guardian" && h.address !== roles.guardian.toBase58()) bad.push(`${h.program}: guardian is ${h.address}, expected the guardian key ${roles.guardian.toBase58()}`);
}
// Every other role and payout account a config names, against what the environment says it should be. A config that
// existed before this run was "left alone": if the environment has moved since, this is where that is caught, BEFORE
// the record is touched.
const c = after.configs;
const differs = (program: ProgramName, what: string, onChain: PublicKey | undefined | null, wanted: PublicKey | undefined, source: string) => {
  if (onChain && wanted && !onChain.equals(wanted)) bad.push(`${program}: ${what} on chain is ${onChain.toBase58()}, the environment (${source}) names ${wanted.toBase58()}. The config was left as it is; change the role on chain through a proposal, or correct ${source}`);
};
if (has("trellis_credits") && c.trellis_credits) { differs("trellis_credits", "the settlement authority", c.trellis_credits.settlementAuthority, roles.settlement, "MAINNET_SETTLEMENT_AUTHORITY"); differs("trellis_credits", "the treasury token account", c.trellis_credits.treasuryTokenAccount, accounts.treasury, "the associated USDC account of MAINNET_MULTISIG_VAULT"); }
if (has("trellis_anchor") && c.trellis_anchor && c.trellis_anchor.rotationCount === 0n) differs("trellis_anchor", "the first receipt signer", c.trellis_anchor.currentSigner, roles.receiptSigner, "MAINNET_RECEIPT_SIGNER");
if (has("trellis_bond") && c.trellis_bond) { differs("trellis_bond", "the slasher", c.trellis_bond.slasher, roles.slasher, "MAINNET_SLASHER"); differs("trellis_bond", "the refund pool", c.trellis_bond.refundPool, accounts.refundPool, "the refund pool derived from the deployer"); differs("trellis_bond", "the treasury", c.trellis_bond.treasury, accounts.treasury, "the associated USDC account of MAINNET_MULTISIG_VAULT"); differs("trellis_bond", "the capacity refund account", c.trellis_bond.capacityRefund, accounts.capacityRefund, "the capacity refund account derived from the deployer"); }
if (has("trellis_capacity") && c.trellis_capacity) { differs("trellis_capacity", "the sale authority", c.trellis_capacity.saleAuthority, roles.sale, "MAINNET_SALE_AUTHORITY or its default, the settlement key"); differs("trellis_capacity", "the HVX authority", c.trellis_capacity.hvxAuthority, roles.hvx, "MAINNET_HVX_AUTHORITY or its default, the multisig vault"); }
if (has("trellis_fee_router") && c.trellis_fee_router) { differs("trellis_fee_router", "the $TRLS mint", c.trellis_fee_router.trlsMint, roles.trlsMint, "MAINNET_TRLS_MINT"); differs("trellis_fee_router", "the workers vault", c.trellis_fee_router.workersVault, accounts.workersVault, "the workers vault derived from the deployer"); differs("trellis_fee_router", "the treasury vault", c.trellis_fee_router.treasuryVault, accounts.treasury, "the associated USDC account of MAINNET_MULTISIG_VAULT"); }
if (bad.length) fail(`\nINIT DID NOT END IN THE EXPECTED STATE:\n${bad.map((b) => `  - ${b}`).join("\n")}\nThe roles, authorities and parameters in the deployments record were NOT rewritten. Do not accept deposits. Investigate before anything else.`);

// Everything was read back as expected: record it, from what the chain holds.
const b58 = (k: PublicKey | undefined | null) => (k ? k.toBase58() : undefined);
const onChainAuthorities = selected.filter((p) => p !== "trellis_anchor").map((p) => holders(after).find((h) => h.program === p && h.role === "authority")?.address);
const onChainUpgrades = selected.map((p) => after.programs[p].upgradeAuthority);
const vaultKey = roles.multisigVault.toBase58();
recordAccounts(ids);
rec.selected = [...new Set([...(rec.selected ?? []), ...selected])];
rec.tier = tierOf(rec.selected);
rec.authorities = {
  ...(rec.authorities ?? {}),
  // A program whose hand-over resolved carries the vault; one added later stays with the deployer until its own does
  // (the monitor reads `handover.resolved` for which is which).
  authority: onChainAuthorities.includes(vaultKey) ? vaultKey : authority.toBase58(),
  upgradeAuthority: onChainUpgrades.includes(vaultKey) ? vaultKey : authority.toBase58(),
  multisigVault: vaultKey,
  ...(roles.guardian ? { guardian: roles.guardian.toBase58() } : {}),
  // Memo mode has no account that names the anchorer: this one value is the input, not a reading.
  ...(has("trellis_anchor") && c.trellis_anchor ? { anchorAuthority: b58(c.trellis_anchor.authority)!, ...(c.trellis_anchor.rotationCount === 0n ? { receiptSigner: b58(c.trellis_anchor.currentSigner)! } : {}) } : roles.anchorer ? { anchorer: roles.anchorer.toBase58() } : {}),
  ...(has("trellis_credits") && c.trellis_credits ? { settlementAuthority: b58(c.trellis_credits.settlementAuthority)! } : {}),
  ...(has("trellis_bond") && c.trellis_bond ? { slasher: b58(c.trellis_bond.slasher)! } : {}),
  ...(has("trellis_capacity") && c.trellis_capacity ? { saleAuthority: b58(c.trellis_capacity.saleAuthority)!, hvxAuthority: b58(c.trellis_capacity.hvxAuthority)! } : {}),
};
rec.parameters = {
  ...(rec.parameters ?? {}),
  ...(has("trellis_credits") ? { creditsCapPerKeyUsdc: Number(PARAMS.credits.maxBalancePerKey) / 1e6, creditTtlSeconds: Number(PARAMS.credits.creditTtl), refundDelaySeconds: Number(PARAMS.credits.refundDelay), expiryGraceSeconds: Number(PARAMS.credits.expiryGrace), settleRateBps: PARAMS.credits.settleRateBps } : {}),
  ...(has("trellis_tab") ? { tabCapUsdc: Number(PARAMS.tab.maxCap) / 1e6, tabReclaimGraceSeconds: Number(PARAMS.tab.reclaimGrace) } : {}),
  ...(has("trellis_bond") ? { bondMinUsdc: Number(PARAMS.bond.minBond) / 1e6, unbondSeconds: Number(PARAMS.bond.unbondPeriod), disputeWindowSeconds: Number(PARAMS.bond.disputeWindow), disputeBlockSeconds: Number(PARAMS.bond.disputeBlock) } : {}),
  ...(has("trellis_fee_router") ? { feeSplitBps: `${PARAMS.feeRouter.workersBps}/${PARAMS.feeRouter.treasuryBps}` } : {}),
  ...(has("trellis_capacity") ? { gradePricesUsdcPerBushel: roles.gradePricesUsdc.join(","), capacityMaxOutstandingUsdc: Number(PARAMS.capacity.maxOutstandingValue) / 1e6 } : {}),
  trlsDecimals: PARAMS.trlsDecimals,
};
saveRecord(mode, rec);
log(`\nall ${selected.length} config(s) of tier ${tier} exist with the expected authority, guardian and roles, read back from the chain; balance ${sol(await conn.getBalance(authority, "confirmed"))} SOL`);
log(`next: bun scripts/mainnet/verify.ts ${mode === "mainnet" ? MAINNET_FLAG : REHEARSAL_FLAG}`);
