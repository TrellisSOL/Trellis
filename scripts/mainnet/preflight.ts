// Read-only preflight for the mainnet deploy: builds the tier's programs with the default profile, checks the cluster, the
// build, the program keypairs and the role inputs, runs the whole procedure on the exact binaries in an in-process SVM,
// prints everything the deploy and init will do and what it costs, and writes the plan deploy.sh executes. Sends nothing.
//
//   bun scripts/mainnet/preflight.ts --i-understand-this-is-mainnet [--tier minimal|credits|payments|full | --programs a,b,c]
//   bun scripts/mainnet/preflight.ts --rehearsal ...
//
//   --tier / --programs        what this deployment has (scripts/mainnet/tiers.ts). Default: the tier of the deployments
//                              record, else `credits`. A later, larger tier deploys only what is missing.
//   --prebuilt <dir>           deploy the .so files of this directory instead of building (for the Docker build:
//                              `scripts/mainnet/build.sh --verifiable`, then --prebuilt target/verifiable). They go
//                              through the same checks, including the build profile. On mainnet the directory must
//                              carry the build manifest (build.json) that binds each binary to the commit checked out
//                              now: its source key is the commit's and its sha256 is the file's (R4-16). A directory
//                              outside the repository is never written into the plan or the record as a path (R4-29).
//   --allow-devnet-build       REHEARSAL ONLY: accept binaries that say they are the `devnet` build (profile 1: 30 s
//                              timelock, 60 s pause, 10 min proposal expiry), so a rehearsal can wait out the hand-over on
//                              a real validator. Refused on mainnet. A binary that claims profile 0 with any other floor
//                              is refused with or without this flag.
//   --allow-dirty              REHEARSAL ONLY: build and plan from a tree with uncommitted changes, or from a copy of the
//                              sources that is not a git tree of its own. Refused on mainnet: a mainnet build starts
//                              from a clean tree at a commit, and the plan carries that commit.
//   --headroom-bytes N         spare bytes reserved in each ProgramData account for later upgrades (default 0)
//   --role-float-sol X         SOL each fee-paying role key is funded with (default 0.1; MAINNET_ROLE_FLOAT_SOL)
//   --spent-roots-per-day N    settlement commits a day, for the monthly cost (default 1: SETTLEMENT_INTERVAL_MS=86400000)
//   --plan-out <file>          write the plan as JSON (deploy.sh passes this)
//
// The build: unless --prebuilt is given, scripts/mainnet/build.sh compiles the selected programs with NO cargo feature
// in a clean target directory and refuses to start when anything could switch the `devnet` feature on. Whatever the
// source of the binaries, scripts/mainnet/simulate.ts then loads them into an in-process SVM and asks EVERY one of them
// for its build_profile: the profile byte must be 0 and every floor it returns must be the mainnet floor
// (scripts/mainnet/plan.ts MAINNET_FLOORS: the 24 h timelock, the 7-day proposal expiry, the 72 h pause, the 7-day
// guardian cooldown and each program's own). Anything else is refused (RR-04 of security/REREVIEW-2026-10.md). The
// simulation then initialises them with these parameters and runs the pauses, an expiring proposal and the whole
// hand-over on them, and holds what each binary does against what it said (its proposal's timelock).
//
// Environment (config/mainnet.env.example): MAINNET_RPC_URL, MAINNET_DEPLOYER_KEYPAIR, TRELLIS_MAINNET_KEYS_DIR,
// TRELLIS_IDL_DIR, the MAINNET_* role public keys, COMPUTE_UNIT_PRICE.
// Exit codes: 0 ready, 1 something blocks the deploy (listed), 2 usage or cluster refused.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, MINT_SIZE, unpackMint } from "@solana/spl-token";
import { MAINNET_FLAG, PROGRAMS, REHEARSAL_FLAG, ROOT, TIER_OPTIONS, assertCluster, buildEnvironment, connect, devnetRecord, expectFlags, fail, loadDeployer, loadRecord, modeOf, parseArgs, prebuiltProblems, readBuildManifest, readKeypairFile, readRoles, recordableDir, requiredRoleEnv, roleProblems, rpcHost, rpcUrl, selection, sol, sourceProblem, sourceState, table, type ProgramName } from "./lib.ts";
import { MAINNET_GENESIS_HASH, MAINNET_USDC, PARAMS, USDC_DECIMALS, describeParams } from "./params.ts";
import { tokenAccountsNeeded } from "./plan.ts";
import { simulateDeployment, type Simulation } from "./simulate.ts";
import { PROGRAMDATA_HEADER, programHash, readProgram } from "./state.ts";
import { DEFERRED, LAMPORTS_PER_SOL, TIER_GIVES, anchorModeOf, monthlyCost, roleFunding, routerTier, tierOf, type TierName } from "./tiers.ts";

const args = parseArgs(process.argv.slice(2), ["--plan-out", "--headroom-bytes", "--prebuilt", "--role-float-sol", "--spent-roots-per-day", ...TIER_OPTIONS]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--skip-id-embed-check", "--allow-devnet-build", "--allow-dirty", "--skip-idl", "--yes", "--dry-run"]);
const mode = modeOf(args);
if (args.flags.has("--allow-devnet-build") && mode === "mainnet") fail("--allow-devnet-build is for rehearsals only: mainnet takes the default build, whose timelock is 24 hours.", 2);
if (args.flags.has("--allow-dirty") && mode === "mainnet") fail("--allow-dirty is for rehearsals only: a mainnet build starts from a clean tree at a commit.", 2);
const ALLOW_DIRTY = args.flags.has("--allow-dirty");
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const deployer = loadDeployer(mode);
const rec = loadRecord(mode, genesis);
const { tier, programs: selected } = selection(args, rec);

const keysDir = process.env.TRELLIS_MAINNET_KEYS_DIR ?? (mode === "mainnet" ? join(homedir(), ".config/trellis/mainnet/program-keys") : join(ROOT, "target/deploy"));
const idlDir = process.env.TRELLIS_IDL_DIR ?? join(ROOT, "target/idl");
const headroom = Number(args.options.get("--headroom-bytes") ?? process.env.PROGRAM_HEADROOM_BYTES ?? 0);
if (!Number.isInteger(headroom) || headroom < 0 || headroom > 1_000_000) fail("--headroom-bytes must be an integer between 0 and 1000000", 2);
const cuPrice = Number(process.env.COMPUTE_UNIT_PRICE ?? 5000); // micro-lamports per compute unit, as scripts/devnet/deploy.sh
if (!Number.isInteger(cuPrice) || cuPrice < 0) fail("COMPUTE_UNIT_PRICE must be a non-negative integer (micro-lamports per compute unit)", 2);
const floatSol = Number(args.options.get("--role-float-sol") ?? process.env.MAINNET_ROLE_FLOAT_SOL ?? 0.1);
if (!(floatSol >= 0.01) || floatSol > 10) fail("--role-float-sol must be between 0.01 and 10 SOL (a fee payer below 0.01 SOL stops working after a few hundred transactions)", 2);
const spentRootsPerDay = Number(args.options.get("--spent-roots-per-day") ?? process.env.MAINNET_SPENT_ROOTS_PER_DAY ?? 1);
if (!Number.isInteger(spentRootsPerDay) || spentRootsPerDay < 1 || spentRootsPerDay > 24) fail("--spent-roots-per-day must be an integer from 1 to 24", 2);

const blockers: string[] = [];
const warnings: string[] = [];
// Paths inside the repository are shown relative to it. (What is shown is not what is recorded: see `recordableDir`.)
const short = (m: string) => m.split(`${ROOT}/`).join("");
const block = (m: string) => { blockers.push(short(m)); };
const warn = (m: string) => { warnings.push(m); };

console.log(`Trellis ${mode === "mainnet" ? "MAINNET" : "rehearsal (local validator)"} preflight. Read-only: nothing is sent.`);
console.log(`  rpc host       ${rpcHost(url)}`);
console.log(`  genesis hash   ${genesis}${genesis === MAINNET_GENESIS_HASH ? "  (mainnet-beta)" : ""}`);
console.log(`  deployer       ${deployer.publicKey.toBase58()}`);
const balance = await conn.getBalance(deployer.publicKey, "confirmed");
console.log(`  balance        ${sol(balance)} SOL`);
console.log(`\nLaunch tier: ${tier}${tier === "custom" ? "" : `  (${TIER_GIVES[tier as TierName]})`}`);
console.log(`  programs       ${selected.length ? selected.join(", ") : "none: nothing is deployed"}`);
console.log(`  receipt roots  ${anchorModeOf(selected) === "memo" ? "memo transactions signed by the anchorer key (ANCHOR_MODE=memo; no account, no rent)" : "trellis_anchor accounts (ANCHOR_MODE=program; rent returned after 400 days)"}`);
console.log(`  router         LAUNCH_TIER=${routerTier(selected)}`);
const off = PROGRAMS.filter((p) => !selected.includes(p));
if (off.length) { console.log("  not deployed in this tier (off in the router, and said so at /api/v1/status):"); for (const p of off) console.log(`    ${p.padEnd(22)} ${DEFERRED[p]}`); }

// ---- The source (R3-10): a clean tree at a commit, or a rehearsal that says it is not -------------------------------------
const src = sourceState();
const srcProblem = sourceProblem(src);
const sourceTree = srcProblem ? "dirty (rehearsal only)" : "clean";
console.log(`\nSource: ${srcProblem ? `NOT a clean tree at a commit: ${srcProblem}` : `commit ${src.commit}, no uncommitted change`}`);
if (srcProblem && !ALLOW_DIRTY) fail(`Refusing to go on: ${srcProblem}.${mode === "rehearsal" ? " A rehearsal may pass --allow-dirty; everything it writes then says so." : " Commit first: the deployment records the commit it was built from, and verify.ts compares the chain with a build of that commit."}`, 1);
if (srcProblem) console.log("  accepted for this rehearsal only (--allow-dirty)");

// ---- The build ------------------------------------------------------------------------------------------------------------
// Binaries built elsewhere are named on the command line only. There is no environment fallback: a directory set in a
// shell profile must not stand in for the build without the operator seeing it (TRELLIS_SO_DIR stops a mainnet run).
const prebuilt = args.options.get("--prebuilt");
let soDir: string;
let build: { kind: string; dir: string; sourceKey?: string };
if (prebuilt) {
  soDir = resolve(prebuilt);
  // What goes into the plan, and from there into the record, is a path inside the repository or no path at all.
  build = { kind: "prebuilt", dir: recordableDir(soDir) };
  console.log(`\nBuild: prebuilt binaries from ${short(soDir)} (not built by this run; checked below like any other)`);
  // The manifest the build wrote beside the binaries says what they were built from. On mainnet it is required and
  // must bind every selected binary to the commit checked out now; a rehearsal may deploy a directory without one.
  const manifest = readBuildManifest(soDir);
  if (manifest) build.sourceKey = manifest.sourceKey;
  for (const why of prebuiltProblems(mode, soDir, selected, src.headKey, short(soDir))) block(`--prebuilt: ${why}`);
  if (manifest && mode !== "mainnet") console.log(`  build.json there: ${manifest.kind ?? "a build"} of source key ${String(manifest.sourceKey ?? "unknown").slice(0, 16)} (commit ${String(manifest.sourceCommit ?? "unknown").slice(0, 12)}, tree: ${manifest.sourceTree ?? "unknown"})`);
} else if (selected.length) {
  console.log(`\nBuild: default profile, clean target directory (scripts/mainnet/build.sh)`);
  const r = Bun.spawnSync(["bash", join(ROOT, "scripts/mainnet/build.sh"), "--programs", selected.join(","), ...(ALLOW_DIRTY ? ["--allow-dirty"] : [])], { stdout: "pipe", stderr: "inherit", env: buildEnvironment(process.env) });
  if (r.exitCode !== 0) fail("The build did not complete; nothing was sent.", 1);
  soDir = r.stdout.toString().trim().split("\n").at(-1)!;
  const manifest = JSON.parse(readFileSync(join(soDir, "build.json"), "utf8")) as { sourceKey: string };
  build = { kind: "clean-default-build", dir: recordableDir(soDir), sourceKey: manifest.sourceKey };
  console.log(`  output         ${short(soDir)}`);
} else { soDir = join(ROOT, "target/deploy"); build = { kind: "none", dir: "" }; }

// ---- Programs: keypairs, build, size, rent ------------------------------------------------------------------------------
const devnet = devnetRecord();
const devnetIds = new Set(Object.values(devnet?.programs ?? {}).map((p) => p.programId).filter(Boolean) as string[]);
const anchorToml = existsSync(join(ROOT, "Anchor.toml")) ? readFileSync(join(ROOT, "Anchor.toml"), "utf8") : "";
const tomlSection = (name: string): Record<string, string> => {
  const m = new RegExp(`^\\[programs\\.${name}\\]\\s*\\n([^\\[]*)`, "m").exec(anchorToml);
  return Object.fromEntries([...(m?.[1] ?? "").matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm)].map((x) => [x[1]!, x[2]!]));
};
const tomlMainnet = tomlSection("mainnet");
for (const id of Object.values(tomlSection("devnet"))) devnetIds.add(id);
for (const id of Object.values(tomlSection("localnet"))) devnetIds.add(id);

/** True when the binary carries the 32-byte id as the eight 4-byte immediates the SBF compiler emits for `declare_id!`. */
function embedsId(so: Buffer, id: PublicKey): boolean {
  const b = id.toBuffer();
  for (let i = 0; i < 32; i += 4) if (so.indexOf(b.subarray(i, i + 4)) < 0) return false;
  return true;
}

// Every program has an id from the start, deployed or not: other programs' configs point at them.
const reserved = {} as Record<ProgramName, PublicKey>;
for (const p of PROGRAMS) {
  const keypair = join(keysDir, `${p}-keypair.json`);
  if (!existsSync(keypair)) { if (selected.length) block(`${p}: no program keypair at ${keypair} (scripts/mainnet/keys.sh generates all eight; an id costs nothing until its program is deployed)`); continue; }
  reserved[p] = readKeypairFile(keypair).publicKey;
  const recorded = rec.programs[p]?.programId ?? rec.reserved?.[p];
  if (recorded && recorded !== reserved[p].toBase58()) block(`${p}: the deployments record names ${recorded}, the keypair is ${reserved[p].toBase58()}`);
}

type Plan = { program: ProgramName; programId: string; keypair: string; so: string; idl: string; bytes: number; sha256: string; hash: string; maxLen: number; rentLamports: number; feeLamports: number; idlLamports: number; deployed: boolean; profile?: string; timelock?: number | null; floors?: Record<string, number> };
const plan: Plan[] = [];
const programAccountRent = await conn.getMinimumBalanceForRentExemption(36);
const rows: (string | number)[][] = [["program", "program id", "bytes", "max_len", "rent SOL", "fees SOL", "state"]];
for (const p of selected) {
  const keypair = join(keysDir, `${p}-keypair.json`);
  const so = join(soDir, `${p}.so`);
  const idl = join(idlDir, `${p}.json`);
  const id = reserved[p];
  if (!id) continue;
  if (!existsSync(so)) { block(`${p}: no build at ${so}`); continue; }
  if (mode === "mainnet") {
    // (readKeypairFile above already refused a keypair file that others can read, in either mode.)
    if ((statSync(keypair).mode & 0o077) !== 0) block(`${p}: ${keypair} is readable by other users; chmod 600`);
    if (devnetIds.has(id.toBase58())) block(`${p}: the program keypair is the devnet/localnet one (${id.toBase58()}). Mainnet uses fresh program keypairs (scripts/mainnet/keys.sh explains why).`);
    if (tomlMainnet[p] !== id.toBase58()) block(`${p}: Anchor.toml [programs.mainnet] ${tomlMainnet[p] ? `names ${tomlMainnet[p]}` : "has no entry"}, the keypair is ${id.toBase58()} (scripts/mainnet/keys.sh --apply)`);
  }
  const bytes = readFileSync(so);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The cheap check first: the very file scripts/devnet/build.sh produced is never deployed, whatever it is called.
  const devnetSo = join(ROOT, "target/deploy-devnet", `${p}.so`);
  if (existsSync(devnetSo) && createHash("sha256").update(readFileSync(devnetSo)).digest("hex") === sha256 && !args.flags.has("--allow-devnet-build")) block(`${p}: ${so} is byte for byte target/deploy-devnet/${p}.so, the build with the \`devnet\` cargo feature (1-second floors, 30-second timelock, 60-second pause). Mainnet deploys the default build.`);
  // --skip-idl: no IDL is published, so none is compared (the id compiled into the binary is checked just below).
  if (args.flags.has("--skip-idl")) { /* nothing to compare */ } else if (existsSync(idl)) {
    const address = (JSON.parse(readFileSync(idl, "utf8")) as { address?: string }).address;
    if (address !== id.toBase58()) block(`${p}: the IDL at ${idl} was built for ${address}; the keypair is ${id.toBase58()}. Sync declare_id! (scripts/mainnet/keys.sh --apply) and rebuild.`);
  } else block(`${p}: no IDL at ${idl}; build it (anchor build, or anchor idl build) or pass --skip-idl`);
  if (!embedsId(bytes, id) && !args.flags.has("--skip-id-embed-check")) block(`${p}: ${so} does not carry the program id ${id.toBase58()}: it was built before declare_id! was synced. Rebuild; a program deployed at an id it was not built for rejects every instruction.`);
  const state = await readProgram(conn, p, id);
  const maxLen = bytes.length + headroom;
  const rentLamports = (await conn.getMinimumBalanceForRentExemption(maxLen + PROGRAMDATA_HEADER)) + programAccountRent;
  // One write transaction carries about 1,000 program bytes and pays the 5,000-lamport signature fee plus the priority
  // fee on a few thousand compute units; a flat 0.01 SOL covers the deploy transaction and landed retries.
  const writes = Math.ceil(bytes.length / 1000);
  const feeLamports = writes * (5000 + Math.ceil((cuPrice * 5000) / 1e6)) + 10_000_000;
  // The IDL is stored compressed in a Program Metadata account; its rent is estimated from the gzip size plus a header.
  const idlLamports = existsSync(idl) && !args.flags.has("--skip-idl") ? (await conn.getMinimumBalanceForRentExemption(gzipSync(readFileSync(idl)).length + 512)) + 2_000_000 : 0;
  plan.push({ program: p, programId: id.toBase58(), keypair, so, idl, bytes: bytes.length, sha256, hash: programHash(bytes), maxLen, rentLamports, feeLamports, idlLamports, deployed: state.deployed });
  rows.push([p, id.toBase58(), bytes.length, maxLen, sol(rentLamports), sol(feeLamports + idlLamports), state.deployed ? `already deployed (upgrade authority ${state.upgradeAuthority ?? "none"})` : "to deploy"]);
  if (state.deployed && state.upgradeAuthority !== deployer.publicKey.toBase58()) warn(`${p} is already deployed and its upgrade authority is ${state.upgradeAuthority ?? "none (frozen)"}, not the deployer`);
}
if (selected.length) {
  console.log("\nPrograms");
  table(rows);
  if (headroom === 0) console.log("  max_len equals the build size: a later upgrade to a larger build needs `solana program extend` first (signed by the upgrade authority, so by the multisig after the hand-over). --headroom-bytes reserves room now at 0.00000696 SOL per byte.");
}

// ---- Mints ----------------------------------------------------------------------------------------------------------------
console.log("\nMints");
const usdcInfo = await conn.getAccountInfo(new PublicKey(MAINNET_USDC), "confirmed");
if (!usdcInfo) block(`USDC mint ${MAINNET_USDC} does not exist on this cluster`);
else if (!usdcInfo.owner.equals(TOKEN_PROGRAM_ID) || usdcInfo.data.length !== MINT_SIZE) block(`USDC mint ${MAINNET_USDC} is not a classic SPL Token mint`);
else {
  const mint = unpackMint(new PublicKey(MAINNET_USDC), usdcInfo, TOKEN_PROGRAM_ID);
  if (mint.decimals !== USDC_DECIMALS) block(`USDC mint has ${mint.decimals} decimals, expected ${USDC_DECIMALS}`);
  console.log(`  USDC   ${MAINNET_USDC}  SPL Token, ${mint.decimals} decimals, freeze authority ${mint.freezeAuthority?.toBase58() ?? "none"}${mode === "mainnet" ? " (Circle can freeze USDC accounts; docs Overview §7)" : ""}`);
}
const { roles, problems } = readRoles(process.env, selected);
for (const pr of problems) block(pr);
for (const pr of roleProblems(roles, deployer.publicKey)) block(pr);
if (roles.trlsMint) {
  const info = await conn.getAccountInfo(roles.trlsMint, "confirmed");
  const needed = selected.includes("trellis_fee_router");
  const say = needed ? block : warn;
  if (!info) say(`$TRLS mint ${roles.trlsMint.toBase58()} does not exist on this cluster`);
  else if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) say(`$TRLS mint ${roles.trlsMint.toBase58()} is owned by ${info.owner.toBase58()}, not the Token-2022 program`);
  else if (info.data.length !== MINT_SIZE) say(`$TRLS mint carries Token-2022 extensions (account is ${info.data.length} bytes, a plain mint is ${MINT_SIZE}); the design is "Token-2022, no extensions"`);
  else {
    const mint = unpackMint(roles.trlsMint, info, TOKEN_2022_PROGRAM_ID);
    if (mint.decimals !== PARAMS.trlsDecimals) say(`$TRLS mint has ${mint.decimals} decimals; the router default TRLS_TOKEN_DECIMALS is ${PARAMS.trlsDecimals}`);
    console.log(`  $TRLS  ${roles.trlsMint.toBase58()}  Token-2022, no extensions, ${mint.decimals} decimals, supply ${mint.supply}, mint authority ${mint.mintAuthority?.toBase58() ?? "none"}, freeze authority ${mint.freezeAuthority?.toBase58() ?? "none"}`);
    if (mint.freezeAuthority) warn("$TRLS has a freeze authority; say so publicly or remove it before launch");
    if (mint.mintAuthority?.equals(deployer.publicKey)) warn("$TRLS mint authority is the deployer key; move it to the multisig or remove it");
  }
} else console.log("  $TRLS  not set (only trellis_fee_router needs it)");

// ---- Roles ----------------------------------------------------------------------------------------------------------------
if (selected.length) {
  console.log("\nRoles (public keys init.ts writes into the configs; only what this tier needs is required)");
  const need = requiredRoleEnv(selected);
  const show = (k: PublicKey | undefined, env: string) => k?.toBase58() ?? (need.includes(env) ? "NOT SET" : "not needed in this tier");
  table([
    ["upgrade authority and config authority", `${deployer.publicKey.toBase58()}  (the deployer, until the hand-over resolves; then the multisig vault)`],
    ["multisig vault (treasury owner; takes both at the hand-over)", show(roles.multisigVault, "MAINNET_MULTISIG_VAULT")],
    ["guardian (pause key; its own key from init on)", show(roles.guardian, "MAINNET_GUARDIAN")],
    ["trellis_credits settlement_authority", show(roles.settlement, "MAINNET_SETTLEMENT_AUTHORITY")],
    ["anchorer (trellis_anchor authority from init on; signs memo roots)", show(roles.anchorer, "MAINNET_ANCHORER")],
    ["trellis_anchor receipt signer", show(roles.receiptSigner, "MAINNET_RECEIPT_SIGNER")],
    ["trellis_bond slasher", show(roles.slasher, "MAINNET_SLASHER")],
    ["trellis_capacity sale_authority", selected.includes("trellis_capacity") ? roles.sale?.toBase58() ?? "NOT SET" : "not needed in this tier"],
    ["trellis_capacity hvx_authority", selected.includes("trellis_capacity") ? roles.hvx?.toBase58() ?? "NOT SET" : "not needed in this tier"],
  ]);
  if (roles.multisigVault) {
    const vaultInfo = await conn.getAccountInfo(roles.multisigVault, "confirmed");
    if (vaultInfo && !vaultInfo.owner.equals(PublicKey.default)) block(`the multisig vault ${roles.multisigVault.toBase58()} is owned by ${vaultInfo.owner.toBase58()}; a Squads vault is a plain system account (you may have passed the multisig account instead of its vault)`);
  }
  console.log("\nParameters init.ts will set (rows of programs outside this tier do not apply yet)");
  table(describeParams(roles.gradePricesUsdc ?? null));
}

// ---- The procedure, run on these binaries -------------------------------------------------------------------------------------
const todo = plan.filter((p) => !p.deployed);
let simulation: Simulation | null = null;
if (todo.length && todo.every((p) => existsSync(p.so)) && PROGRAMS.every((p) => reserved[p])) {
  console.log("\nSimulation (in-process SVM, the exact binaries above; nothing leaves this machine)");
  try {
    simulation = await simulateDeployment({ programs: todo.map((p) => ({ name: p.program, so: p.so })), ids: reserved, operator: deployer.publicKey, roles, usdcMint: new PublicKey(MAINNET_USDC), pauseCapacity: false });
  } catch (e) {
    block(`the simulation could not run: ${(e as Error).message.slice(0, 200)}`);
  }
  if (simulation) {
    for (const p of todo) {
      const pr = simulation.profiles[p.program];
      p.profile = pr?.profile ?? "unknown";
      p.timelock = pr?.timelock ?? null;
      p.floors = Object.fromEntries(Object.entries(pr?.floors ?? {}).map(([k, v]) => [k, Number(v)]));
      console.log(`  ${p.program.padEnd(22)} build_profile: ${pr?.profile ?? "unknown"} build${pr?.profile === "mainnet" ? `, all ${Object.keys(pr.floors).length} floors (timelock ${pr.timelock} s, proposal expiry ${pr.floors.proposalTtl} s${pr.floors.pauseTtl !== undefined ? `, pause ${pr.floors.pauseTtl} s` : ""})` : pr ? `: ${pr.problems.join("; ")}` : ""}`);
      if (pr?.profile === "mainnet") continue;
      const message = `${p.program}: ${short(p.so)} is not the mainnet build: ${pr ? pr.problems.join("; ") : "build_profile was not read"}${pr?.profile === "devnet" ? ` (config timelock ${pr.timelock} s; the default build's is 86400 s)` : ""}`;
      if (args.flags.has("--allow-devnet-build") && pr?.profile === "devnet") warn(`${message}. Accepted for this rehearsal only (--allow-devnet-build).`);
      else block(message);
    }
    for (const line of simulation.log.filter((l) => !/^init |build_profile says|hand-over proposed;/.test(l))) console.log(`  ${line}`);
    for (const pr of simulation.problems) block(`simulation: ${pr}`);
    if (simulation.placeholders.length && !problems.length) console.log(`  (throwaway keys stood in for roles this tier does not need: ${simulation.placeholders.join(", ")})`);
    if (simulation.ok) console.log("  build profiles, init, pauses (72 h, guardian cooldown), proposal expiry, refusal before the timelock, refusal without the vault, resolution by operator and vault, upgrade authority: all as planned");
  }
} else if (selected.length && !todo.length) console.log("\nSimulation: every selected program is already deployed; verify.ts checks what is on chain.");

// ---- SOL ------------------------------------------------------------------------------------------------------------------
const rent = todo.reduce((s, p) => s + p.rentLamports, 0);
const fees = todo.reduce((s, p) => s + p.feeLamports, 0);
const idls = todo.reduce((s, p) => s + p.idlLamports, 0);
// Per program: a config account, its vaults or limiter where it has them, and the fees. Per token account: its rent.
const tokenAccountRent = await conn.getMinimumBalanceForRentExemption(165);
const initAllowance = todo.length * 8_000_000 + tokenAccountsNeeded(selected).length * (tokenAccountRent + 10_000);
// The proposal of each program is an account whose rent comes back when it resolves; the fees do not.
const handoverAllowance = selected.length ? selected.length * 3_000_000 + 1_000_000 : 0;
const deployerTotal = rent + fees + idls + initAllowance + handoverAllowance;
if (selected.length) {
  console.log("\nSOL the deployer needs");
  table([
    ["rent, ProgramData and program accounts (exact for these builds; stays for as long as the programs live)", sol(rent)],
    ["deploy transaction fees (upper estimate)", sol(fees)],
    ["IDL accounts (estimate)", sol(idls)],
    ["init: configs, vaults, treasury token accounts (allowance)", sol(initAllowance)],
    ["hand-over: proposal accounts (returned) and fees (allowance)", sol(handoverAllowance)],
    ["total", sol(deployerTotal)],
    ["balance", sol(balance)],
    [balance >= deployerTotal ? "spare" : "SHORTFALL", sol(Math.abs(balance - deployerTotal))],
  ]);
  console.log("  The rent stays in the program accounts (recoverable only by closing a program, which retires its address for good). A deploy that fails midway leaves its rent in a buffer account: `solana program close --buffers` returns it.");
  if (balance < deployerTotal) block(`the deployer holds ${sol(balance)} SOL and needs ${sol(deployerTotal)} SOL`);
}

// Role keys: a float for fees, plus a month of rent where a key pays rent. Shown with what each address holds now.
const funding = roleFunding(selected, { floatLamports: Math.round(floatSol * LAMPORTS_PER_SOL), spentRootsPerDay, facilitator: !!process.env.MONITOR_FACILITATOR_RELAY_ADDRESS?.trim() });
console.log(`\nSOL for the keys that pay fees (a float of ${floatSol} SOL each; --role-float-sol changes it)`);
const fundRows: (string | number)[][] = [["key", "target SOL", "holds now", "to send", "why"]];
let toSend = 0;
for (const f of funding) {
  const address = process.env[f.env]?.trim();
  let held: number | null = null;
  if (address) { try { held = await conn.getBalance(new PublicKey(address), "confirmed"); } catch { held = null; } }
  const send = Math.max(0, f.lamports - (held ?? 0));
  toSend += send;
  fundRows.push([f.role, sol(f.lamports), held === null ? `unknown (${f.env} not set)` : sol(held), sol(send), f.why]);
}
table(fundRows);
const monthly = monthlyCost(selected, { spentRootsPerDay });
console.log("\nMonthly on-chain cost once running (a root every hour: an hour without traffic posts nothing)");
table([["item", "SOL a month", "kind", "note"], ...monthly.map((m) => [m.item, (m.lamports / LAMPORTS_PER_SOL).toFixed(4), m.kind, m.note])]);
const monthlyTotal = monthly.reduce((s, m) => s + m.lamports, 0);
console.log(`  total ${(monthlyTotal / LAMPORTS_PER_SOL).toFixed(4)} SOL a month, of which ${(monthly.filter((m) => m.kind === "fee").reduce((s, m) => s + m.lamports, 0) / LAMPORTS_PER_SOL).toFixed(4)} SOL is fees. The network fee of a per-call x402 payment is fronted by the router key and passed through to the payer at cost, as its own receipt line.`);
const totalSol = deployerTotal + roleFunding(selected, { floatLamports: Math.round(floatSol * LAMPORTS_PER_SOL), spentRootsPerDay, facilitator: !!process.env.MONITOR_FACILITATOR_RELAY_ADDRESS?.trim() }).reduce((s, f) => s + f.lamports, 0);
console.log(`\nTOTAL to have ready for tier ${tier}: ${sol(totalSol)} SOL  (deployer ${sol(deployerTotal)} + role keys ${sol(totalSol - deployerTotal)}); still to send to role keys now: ${sol(toSend)} SOL`);

const recordSelected = PROGRAMS.filter((p) => selected.includes(p) || !!rec.selected?.includes(p) || !!rec.programs[p]?.programId);
if (recordSelected.some((p) => !selected.includes(p))) warn(`this run selects tier ${tier}, and the record already holds ${recordSelected.filter((p) => !selected.includes(p)).join(", ")}: the record's tier stays ${tierOf(recordSelected)} (verify.ts and handover.ts refuse a selection that leaves a deployed program out)`);
if (warnings.length) { console.log("\nWarnings"); for (const w of warnings) console.log(`  - ${w}`); }
if (args.options.has("--plan-out")) {
  writeFileSync(args.options.get("--plan-out")!, JSON.stringify({
    mode, genesis, deployer: deployer.publicKey.toBase58(), cuPrice, tier, selected, routerTier: routerTier(selected), anchorMode: anchorModeOf(selected),
    // What the record's tier becomes: everything selected so far, deployed or recorded. A later, narrower --tier never shrinks it.
    recordSelected, recordTier: tierOf(recordSelected),
    source: { commit: src.commit, tree: sourceTree, sourceKey: src.sourceKey },
    reserved: Object.fromEntries(Object.entries(reserved).map(([k, v]) => [k, v.toBase58()])),
    build: { ...build, sourceKey: build.sourceKey ?? (build.kind === "clean-default-build" ? src.sourceKey : undefined), sourceCommit: src.commit, sourceTree, profile: todo.every((p) => p.profile === "mainnet") ? "mainnet" : todo.some((p) => p.profile === "devnet") ? "devnet (rehearsal only)" : "unknown", checkedAt: new Date().toISOString() },
    totalLamports: deployerTotal, roleFundingLamports: totalSol - deployerTotal, monthlyLamports: monthlyTotal, blockers, programs: plan,
  }, null, 2) + "\n", { mode: 0o600 });
}
if (blockers.length) {
  console.log(`\nNOT READY: ${blockers.length} blocker(s)`);
  for (const b of blockers) console.log(`  - ${b}`);
  process.exit(1);
}
console.log("\nPreflight passed. Nothing was sent.");
