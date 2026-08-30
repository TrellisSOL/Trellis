// Initialise the Trellis program configs on devnet through the router's own instruction builders
// (src/solana/programs/*.ts), the same calls tests/integration/router-chain.ts makes against the local validator.
//
//   bun scripts/devnet/init.ts              every program must be deployed (scripts/devnet/deploy.sh); refuses otherwise
//   bun scripts/devnet/init.ts --partial    initialise only the programs that are deployed, skip the rest
//   bun scripts/devnet/init.ts --precheck   read-only: balance, which programs and configs exist, which mints; sends nothing
//   bun scripts/devnet/init.ts --profile devnet|mainnet
//                                           which parameter set the credits and bond configs carry (scripts/devnet/profile.ts).
//                                           mainnet = the spec values (72 h refund delay, 10,000 USDC minimum bond, 14-day unbond,
//                                           72 h dispute window). devnet = DEVNET-ONLY short timings and a 2 USDC minimum bond,
//                                           so the slow money paths can be watched in minutes. The devnet set is below the
//                                           programs' floors and is accepted only by the devnet build (cargo feature `devnet`,
//                                           scripts/devnet/build.sh). An existing config is brought to the chosen set through the
//                                           program's own config path: update_config when the change only tightens, otherwise
//                                           propose_config, the config timelock (30 s in the devnet build), resolve_config.
//                                           Without the flag the profile recorded in deployments/devnet.json is kept (the spec
//                                           values when none is recorded). Mainnet is never initialised by this script.
//
// Authority, guardian, settlement, slasher, sale and HVX authorities are all the deployer key for now; production
// authority is a Squads v4 2-of-3 and the guardian is the same multisig (docs/Trellis_Backend.md §10), with separate
// role keys. Every init instruction accepts only the program's upgrade authority (security review TR-13), which on devnet
// is the deployer. Idempotent: a config PDA that already exists is left alone and recorded as "exists", except the fee router's
// split, which is brought to the no-fee-split default (workers 0 / treasury 10,000 bps) with update_fee_config whenever
// the chain holds another value (recorded as "updated"). A program that is not deployed
// (not executable on chain) stops the run with the deploy command to use, unless --partial asks for the deployed subset.
// Writes PDAs, mints, token accounts and signatures to deployments/devnet.json. The receipt signing key's secret goes
// only to deployments/devnet.secrets.json (gitignored, mode 0600); this script prints no secret.
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAccount, createMint, getAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { creditsIdl, creditsPdas, initConfigIx as creditsInitConfigIx, initLimiterIx } from "../../src/solana/programs/credits.ts";
import { anchorIdl, anchorPdas, initSignerSetIx } from "../../src/solana/programs/anchor.ts";
import { initConfigIx as rulesInitConfigIx, rulesConfigPda, rulesIdl } from "../../src/solana/programs/rules.ts";
import { enforcerPda, initializeConfigIx as tabInitializeConfigIx, tabConfigPda, tabIdl } from "../../src/solana/programs/tab.ts";
import { bondIdl, bondPdas, initializeConfigIx as bondInitializeConfigIx } from "../../src/solana/programs/bond.ts";
import { decodeFeeConfig, feeRouterIdl, feeRouterPdas, initFeeConfigIx, isTreasuryOnly, TREASURY_BPS, updateFeeConfigIx, WORKERS_BPS } from "../../src/solana/programs/fee-router.ts";
import { bondClaimerPda, capacityConfigPda, capacityIdl, commitmentAccountSize, initializeConfigIx as capacityInitializeConfigIx, migrateCommitmentIx } from "../../src/solana/programs/capacity.ts";
import { base58Encode } from "../../src/solana/constants.ts";
import { initRegistryIx, measurementsIdl, registryPda } from "../../src/solana/programs/measurements.ts";
import { DEVNET_USDC, PROGRAMS, connection, explorer, isDeployed, loadDeployments, loadKeypair, loadSecrets, programIds, rpcLabel, saveDeployments, saveSecrets, type ProgramName } from "./lib.ts";
import { PROFILES, applyProfile, isProfileName, profileDiff, profileParameters, readOnchain, recordedProfile } from "./profile.ts";
import type { IdlProgram } from "../../src/solana/programs/idl.ts";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
// Spec defaults (docs/Trellis_Backend.md §5, §10) shared by every profile: credits TTL 365 d, tab reclaim grace 24 h,
// capacity max outstanding 250,000 USDC (the programs' own defaults, passed as null so the chain stays the source of
// truth). The values that differ between devnet and mainnet (refund delay, expiry grace, minimum bond, unbond period,
// dispute window, dispute block) are in scripts/devnet/profile.ts and chosen with --profile.
const PARAMS = {
  tabCapUsdc: 500,
  creditsCapPerKeyUsdc: 5_000,
  creditTtlDays: 365,
  // No fee split: every protocol fee to the treasury (the program's defaults; hosts get their list price, operators flat fees).
  workersBps: WORKERS_BPS,
  treasuryBps: TREASURY_BPS,
  // USDC per Bushel (1M tokens) for grades G-S, G-M, G-L: the values the program tests use; the docs fix no number.
  gradePricesUsdc: (process.env.DEVNET_GRADE_PRICES_USDC ?? "1,2,4").split(",").map(Number) as [number, number, number],
  trlsDecimals: 9,
};

const ARGV = process.argv.slice(2);
let profileArg: string | undefined;
const FLAGS = new Set<string>();
for (let i = 0; i < ARGV.length; i++) {
  if (ARGV[i] === "--profile") profileArg = ARGV[++i] ?? "";
  else if (ARGV[i].startsWith("--profile=")) profileArg = ARGV[i].slice("--profile=".length);
  else FLAGS.add(ARGV[i]);
}
const PARTIAL = FLAGS.has("--partial");
const PRECHECK = FLAGS.has("--precheck");
for (const f of FLAGS) if (!["--partial", "--precheck"].includes(f)) { console.error(`unknown flag ${f}; use --partial, --precheck or --profile devnet|mainnet`); process.exit(2); }
if (profileArg !== undefined && !isProfileName(profileArg)) { console.error(`unknown profile "${profileArg}"; use --profile devnet or --profile mainnet`); process.exit(2); }

const conn = connection();
const deployer = loadKeypair();
const authority = deployer.publicKey;
const dep = loadDeployments();
// The parameter set: the flag, else what the record says the chain carries, else the spec values.
const PROFILE_NAME = isProfileName(profileArg) ? profileArg : recordedProfile(dep);
const PROFILE = PROFILES[PROFILE_NAME];
const secrets = loadSecrets();
dep.deployer = authority.toBase58();
const log = (...a: unknown[]) => console.log(...a);

const ids = programIds(dep, { trellis_credits: creditsIdl.programId, trellis_anchor: anchorIdl.programId, trellis_rules: rulesIdl.programId, trellis_tab: tabIdl.programId, trellis_bond: bondIdl.programId, trellis_fee_router: feeRouterIdl.programId, trellis_capacity: capacityIdl.programId, trellis_measurements: measurementsIdl.programId });

async function send(ixs: TransactionInstruction[], signers: Keypair[] = [deployer]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
const exists = async (k: PublicKey) => !!(await conn.getAccountInfo(k, "confirmed"));
const tokenAccountExists = async (k?: string) => { if (!k) return false; try { await getAccount(conn, new PublicKey(k), "confirmed"); return true; } catch { return false; } };

/**
 * Configs created before the October 2026 re-review fixes are 16 bytes shorter than the programs now expect (the pause
 * expiry and the guardian cooldown were appended): `migrate_config` grows them in place. Anyone may pay, the appended
 * fields start at zero, and it works once. A config that already reads with the current layout is left alone.
 */
async function migrateLegacyConfigs(live: Record<ProgramName, boolean>) {
  const targets: [ProgramName, IdlProgram, string, PublicKey][] = [
    ["trellis_credits", creditsIdl.at(ids.trellis_credits), "CreditsConfig", creditsPdas(ids.trellis_credits).config],
    ["trellis_rules", rulesIdl.at(ids.trellis_rules), "RulesConfig", rulesConfigPda(ids.trellis_rules)],
    ["trellis_tab", tabIdl.at(ids.trellis_tab), "TabConfig", tabConfigPda(ids.trellis_tab)],
    ["trellis_bond", bondIdl.at(ids.trellis_bond), "BondConfig", bondPdas(ids.trellis_bond).config],
    ["trellis_capacity", capacityIdl.at(ids.trellis_capacity), "CapacityConfig", capacityConfigPda(ids.trellis_capacity)],
  ];
  for (const [name, program, account, pda] of targets) {
    if (!live[name]) continue;
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) continue;
    // By size, not by decoding: the decoder reads a short account's missing tail as zeros, the program refuses it.
    if (info.data.length >= program.accountSize(account)) continue;
    const sig = await send([program.instruction("migrate_config", {}, { payer: authority, system_program: SystemProgram.programId })]);
    const after = await conn.getAccountInfo(pda, "confirmed");
    log(`${name}: config ${pda.toBase58()} grown from ${info.data.length} to ${after?.data.length} bytes with migrate_config (${explorer("tx", sig)})`);
    dep.configs ??= {};
    dep.configs[name] = { ...(dep.configs[name] ?? {}), address: pda.toBase58(), status: dep.configs[name]?.status ?? "exists", note: `migrate_config ${sig}` };
    saveDeployments(dep);
  }
  // The credits outflow limiter grew by 24 bytes in the third security pass (the base tracker and the absolute cap,
  // R3-07): migrate_limiter grows an earlier one once, keeps rate, allowances and pause, and starts the cap at its default.
  if (live.trellis_credits) {
    const program = creditsIdl.at(ids.trellis_credits);
    const { limiter } = creditsPdas(ids.trellis_credits);
    const info = await conn.getAccountInfo(limiter, "confirmed");
    if (info && info.data.length < program.accountSize("SettleLimiter")) {
      const sig = await send([program.instruction("migrate_limiter", {}, { payer: authority, system_program: SystemProgram.programId })]);
      const after = await conn.getAccountInfo(limiter, "confirmed");
      log(`trellis_credits: limiter ${limiter.toBase58()} grown from ${info.data.length} to ${after?.data.length} bytes with migrate_limiter (${explorer("tx", sig)})`);
      dep.configs ??= {};
      const prior = dep.configs.trellis_credits;
      if (prior) dep.configs.trellis_credits = { ...prior, note: `migrate_limiter ${sig}` };
      saveDeployments(dep);
    }
  }
  // Capacity commitments grew by 24 bytes in the third security pass (the price fixed at commit time, what the lots
  // paid and what was claimed, R3-16). The upgraded program cannot read an earlier one until migrate_commitment grows
  // it: anyone may pay, the new fields start at zero (so nothing more is sold against it; its lots can still be claimed,
  // within its value), and it works once per commitment.
  if (live.trellis_capacity) {
    const program = capacityIdl.at(ids.trellis_capacity);
    const size = commitmentAccountSize();
    const found = await conn.getProgramAccounts(ids.trellis_capacity, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: base58Encode(program.accountDiscriminator("CapacityCommitment")) } }] });
    for (const { pubkey, account } of found) {
      if (account.data.length >= size) continue;
      const sig = await send([migrateCommitmentIx(ids.trellis_capacity, { payer: authority, commitment: pubkey })]);
      log(`trellis_capacity: commitment ${pubkey.toBase58()} grown from ${account.data.length} to ${size} bytes with migrate_commitment (${explorer("tx", sig)})`);
    }
  }
}

/** Creates `name`'s config unless its PDA exists; records address, signature and status. */
async function initOnce(name: ProgramName, pda: PublicKey, build: () => TransactionInstruction | Promise<TransactionInstruction>, signers?: Keypair[]) {
  dep.configs ??= {};
  if (await exists(pda)) {
    log(`${name}: config ${pda.toBase58()} already exists; skipping`);
    dep.configs[name] = { ...(dep.configs[name] ?? {}), address: pda.toBase58(), status: dep.configs[name]?.status ?? "exists" };
    return;
  }
  const sig = await send([await build()], signers);
  dep.configs[name] = { address: pda.toBase58(), signature: sig, initialisedAt: new Date().toISOString(), status: "initialised" };
  log(`${name}: config ${pda.toBase58()} initialised (${explorer("tx", sig)})`);
  saveDeployments(dep);
}

async function main() {
  log(`deployer ${authority.toBase58()} on ${rpcLabel()}`);
  log(`profile ${PROFILE_NAME}${PROFILE_NAME === "devnet" ? " (DEVNET-ONLY short timings and a small minimum bond; mainnet keeps the spec values)" : " (the spec values)"}`);
  const lamports = await conn.getBalance(authority, "confirmed");
  log(`balance ${(lamports / 1e9).toFixed(4)} SOL`);

  // Which programs are live.
  const live: Record<ProgramName, boolean> = {} as never;
  for (const p of PROGRAMS) live[p] = await isDeployed(conn, ids[p]);
  log("deployed:", PROGRAMS.filter((p) => live[p]).join(" ") || "(none)");
  const pending = PROGRAMS.filter((p) => !live[p]);
  if (pending.length) log("not deployed:", pending.map((p) => `${p} (${ids[p].toBase58()})`).join(", "));

  if (PRECHECK) {
    // Read-only report: what init would do.
    const circleInfo = await conn.getAccountInfo(new PublicKey(DEVNET_USDC), "confirmed");
    log(`USDC: Circle devnet mint ${DEVNET_USDC} ${circleInfo?.owner.equals(TOKEN_PROGRAM_ID) && circleInfo.data.length === 82 ? "found" : "NOT found (a test mint would be created)"}`);
    log(`$TRLS: ${dep.mints?.trls && (await exists(new PublicKey(dep.mints.trls))) ? `recorded mint ${dep.mints.trls}` : "a Token-2022 test mint would be created"}`);
    const configPdas: Record<ProgramName, PublicKey> = {
      trellis_credits: creditsPdas(ids.trellis_credits).config, trellis_anchor: anchorPdas(ids.trellis_anchor).signerSet, trellis_rules: rulesConfigPda(ids.trellis_rules), trellis_tab: tabConfigPda(ids.trellis_tab),
      trellis_bond: bondPdas(ids.trellis_bond).config, trellis_fee_router: feeRouterPdas(ids.trellis_fee_router).feeConfig, trellis_capacity: capacityConfigPda(ids.trellis_capacity),
      trellis_measurements: registryPda(ids.trellis_measurements),
    };
    for (const p of PROGRAMS) {
      const state = !live[p] ? "program not deployed" : (await exists(configPdas[p])) ? "config exists (would skip)" : "would initialise";
      log(`  ${p.padEnd(20)} ${configPdas[p].toBase58().padEnd(45)} ${state}`);
    }
    const feeInfo = live.trellis_fee_router ? await conn.getAccountInfo(configPdas.trellis_fee_router, "confirmed") : null;
    const fee = feeInfo ? decodeFeeConfig(new Uint8Array(feeInfo.data)) : null;
    if (live.trellis_credits && live.trellis_bond) {
      const diff = profileDiff(await readOnchain(conn, ids), PROFILE);
      for (const d of diff) log(`  ${d.program} ${d.label}: on chain ${d.show(d.onchain)}, the ${PROFILE_NAME} profile sets ${d.show(d.want)} (would send the config change)`);
      if (!diff.length) log(`  credits and bond configs already carry the ${PROFILE_NAME} profile`);
    }
    if (fee) log(`  trellis_fee_router split ${fee.workersBps}/${fee.treasuryBps} bps: ${isTreasuryOnly(fee) ? "already the no-fee-split default" : `would send update_fee_config(${PARAMS.workersBps}, ${PARAMS.treasuryBps})`}`);
    log(`precheck only; nothing sent. ${pending.length ? `Deploy first: scripts/devnet/deploy.sh (${pending.length} pending)` : "Ready: bun scripts/devnet/init.ts"}`);
    return;
  }
  if (pending.length && !PARTIAL) {
    throw new Error(`${pending.length} program(s) are not deployed on devnet: ${pending.join(", ")}.\nRun scripts/devnet/deploy.sh first (scripts/devnet/deploy.sh --dry-run shows the SOL it needs), or pass --partial to initialise only the deployed programs.`);
  }
  if (lamports < 50_000_000) throw new Error("balance below 0.05 SOL; the config accounts and mints need rent");

  await migrateLegacyConfigs(live);

  // ---- Mints -----------------------------------------------------------------------------------------------------------
  dep.mints ??= {};
  let usdcMint: PublicKey;
  const circle = new PublicKey(DEVNET_USDC);
  const circleInfo = await conn.getAccountInfo(circle, "confirmed");
  if (circleInfo && circleInfo.owner.equals(TOKEN_PROGRAM_ID) && circleInfo.data.length === 82) {
    usdcMint = circle;
    dep.mints.usdc = circle.toBase58();
    dep.mints.usdcSource = "circle-devnet";
    log(`USDC: Circle devnet mint ${usdcMint.toBase58()} (decimals ${(await getMint(conn, usdcMint)).decimals})`);
  } else if (dep.mints.usdc && (await exists(new PublicKey(dep.mints.usdc)))) {
    usdcMint = new PublicKey(dep.mints.usdc);
    log(`USDC: recorded test mint ${usdcMint.toBase58()}`);
  } else {
    usdcMint = await createMint(conn, deployer, authority, null, 6);
    dep.mints.usdc = usdcMint.toBase58();
    dep.mints.usdcSource = "test-mint";
    log(`USDC: Circle's devnet mint was not found; created a 6-decimal test mint ${usdcMint.toBase58()}`);
    saveDeployments(dep);
  }

  let trlsMint: PublicKey;
  if (dep.mints.trls && (await exists(new PublicKey(dep.mints.trls)))) {
    trlsMint = new PublicKey(dep.mints.trls);
    log(`$TRLS: recorded Token-2022 test mint ${trlsMint.toBase58()}`);
  } else {
    // Token-2022, no extensions, mint authority = deployer, no freeze authority.
    const kp = Keypair.generate();
    trlsMint = await createMint(conn, deployer, authority, null, PARAMS.trlsDecimals, kp, undefined, TOKEN_2022_PROGRAM_ID);
    dep.mints.trls = trlsMint.toBase58();
    dep.mints.trlsDecimals = PARAMS.trlsDecimals;
    log(`$TRLS: created Token-2022 test mint ${trlsMint.toBase58()} (${PARAMS.trlsDecimals} decimals)`);
    saveDeployments(dep);
  }

  // ---- USDC token accounts the configs name ------------------------------------------------------------------------------
  // Treasury: the deployer's USDC ATA (credits treasury, bond treasury, fee-router treasury vault). Refund pool, capacity
  // refund and the workers vault are separate token accounts owned by the deployer.
  dep.accounts ??= {};
  const treasury = (await getOrCreateAssociatedTokenAccount(conn, deployer, usdcMint, authority)).address;
  dep.accounts.treasuryUsdc = treasury.toBase58();
  for (const name of ["refundPool", "capacityRefund", "workersVault"] as const) {
    if (await tokenAccountExists(dep.accounts[name])) continue;
    const acct = await createAccount(conn, deployer, usdcMint, authority, Keypair.generate());
    dep.accounts[name] = acct.toBase58();
    log(`${name}: created USDC token account ${acct.toBase58()}`);
    saveDeployments(dep);
  }
  const refundPool = new PublicKey(dep.accounts.refundPool!);
  const capacityRefund = new PublicKey(dep.accounts.capacityRefund!);
  const workersVault = new PublicKey(dep.accounts.workersVault!);
  log(`treasury USDC ATA ${treasury.toBase58()}`);

  // ---- Configs -----------------------------------------------------------------------------------------------------------
  if (live.trellis_credits) {
    await initOnce("trellis_credits", creditsPdas(ids.trellis_credits).config, () =>
      creditsInitConfigIx(ids.trellis_credits, { authority, usdcMint, treasuryTokenAccount: treasury, settlementAuthority: authority, guardian: authority, maxBalancePerKey: USDC(PARAMS.creditsCapPerKeyUsdc), refundDelay: PROFILE.refundDelayS, expiryGrace: PROFILE.expiryGraceS }));
    dep.accounts.creditsVault = creditsPdas(ids.trellis_credits).vault.toBase58();
    // The outflow limiter (["limiter_v2"]: the continuously refilled allowances that replaced the fixed 24h bucket).
    // init_config creates it; a config initialised before it existed (devnet, before the October 2026 re-review upgrade)
    // gets it here. Without it commit_spent_root, settle_to_host, pay_refund and sweep_expired fail. The first limiter's
    // account (["limiter"]) stays on chain, unread.
    const { limiter } = creditsPdas(ids.trellis_credits);
    if (!(await exists(limiter))) {
      const sig = await send([initLimiterIx(ids.trellis_credits, { payer: authority })]);
      log(`trellis_credits: outflow limiter ${limiter.toBase58()} created (${explorer("tx", sig)})`);
      dep.configs!.trellis_credits = { ...dep.configs!.trellis_credits!, note: `init_limiter ${sig}` };
    }
    dep.accounts.creditsLimiter = limiter.toBase58();
  }

  if (live.trellis_anchor) {
    const { signerSet } = anchorPdas(ids.trellis_anchor);
    await initOnce("trellis_anchor", signerSet, () => {
      // A fresh receipt signing key. The secret is written to the gitignored secrets file before the transaction is sent so
      // a confirmed init can never outlive its key; the public key is recorded in deployments/devnet.json.
      const signer = Keypair.generate();
      secrets.receiptSigner = { publicKey: signer.publicKey.toBase58(), secretKey: Array.from(signer.secretKey) };
      saveSecrets(secrets);
      dep.authorities = { ...(dep.authorities ?? {}), receiptSigner: signer.publicKey.toBase58() };
      log(`trellis_anchor: receipt signing key ${signer.publicKey.toBase58()} (secret in deployments/devnet.secrets.json)`);
      return initSignerSetIx(ids.trellis_anchor, { authority, initialSigner: signer.publicKey });
    });
    if (!secrets.receiptSigner) log("trellis_anchor: the signer set exists but no receipt signing key is in the secrets file; propose a new key (propose_signer) and install it once the program's timelock has run (resolve_signer) before anchoring");
  }

  if (live.trellis_rules) {
    await initOnce("trellis_rules", rulesConfigPda(ids.trellis_rules), () =>
      rulesInitConfigIx(ids.trellis_rules, { authority, guardian: authority, enforcer: enforcerPda(ids.trellis_tab) }));
    dep.accounts.tabEnforcer = enforcerPda(ids.trellis_tab).toBase58();
  }

  if (live.trellis_tab) {
    await initOnce("trellis_tab", tabConfigPda(ids.trellis_tab), () =>
      tabInitializeConfigIx(ids.trellis_tab, { authority, usdcMint, guardian: authority, rulesProgram: ids.trellis_rules, maxCap: USDC(PARAMS.tabCapUsdc), reclaimGrace: null }));
  }

  if (live.trellis_bond) {
    await initOnce("trellis_bond", bondPdas(ids.trellis_bond).config, () =>
      bondInitializeConfigIx(ids.trellis_bond, { authority, usdcMint, refundPool, treasury, capacityRefund, slasher: authority, guardian: authority, capacityClaimer: bondClaimerPda(ids.trellis_capacity), minBond: PROFILE.minBondUnits, unbondPeriod: PROFILE.unbondPeriodS, disputeWindow: PROFILE.disputeWindowS, disputeBlock: PROFILE.disputeBlockS }));
    dep.accounts.capacityBondClaimer = bondClaimerPda(ids.trellis_capacity).toBase58();
  }

  if (live.trellis_fee_router) {
    const pdas = feeRouterPdas(ids.trellis_fee_router);
    await initOnce("trellis_fee_router", pdas.feeConfig, () =>
      initFeeConfigIx(ids.trellis_fee_router, { authority, feeMint: usdcMint, trlsMint, workersVault, treasuryVault: treasury, workersBps: PARAMS.workersBps, treasuryBps: PARAMS.treasuryBps }));
    dep.accounts.feeVault = pdas.feeVault.toBase58();
    dep.accounts.trlsVault = pdas.trlsVault.toBase58();
    // An existing config with another split is brought to the default through update_fee_config (idempotent: a config
    // already at 0/10,000 is left alone).
    const info = await conn.getAccountInfo(pdas.feeConfig, "confirmed");
    const feeConfig = info ? decodeFeeConfig(new Uint8Array(info.data)) : null;
    if (feeConfig && !isTreasuryOnly(feeConfig)) {
      if (!feeConfig.authority.equals(authority)) log(`trellis_fee_router: split is ${feeConfig.workersBps}/${feeConfig.treasuryBps} but the authority is ${feeConfig.authority.toBase58()}, not the deployer; update_fee_config(${PARAMS.workersBps}, ${PARAMS.treasuryBps}) must be sent by that authority`);
      else {
        const sig = await send([updateFeeConfigIx(ids.trellis_fee_router, { authority, workersBps: PARAMS.workersBps, treasuryBps: PARAMS.treasuryBps })]);
        dep.configs!.trellis_fee_router = { ...dep.configs!.trellis_fee_router!, status: "updated", updateSignature: sig, updatedAt: new Date().toISOString(), note: `update_fee_config(${PARAMS.workersBps}, ${PARAMS.treasuryBps}) from ${feeConfig.workersBps}/${feeConfig.treasuryBps}` };
        log(`trellis_fee_router: split ${feeConfig.workersBps}/${feeConfig.treasuryBps} -> ${PARAMS.workersBps}/${PARAMS.treasuryBps} (${explorer("tx", sig)})`);
        saveDeployments(dep);
      }
    } else if (feeConfig) log(`trellis_fee_router: split already ${feeConfig.workersBps}/${feeConfig.treasuryBps}`);
  }

  if (live.trellis_capacity) {
    await initOnce("trellis_capacity", capacityConfigPda(ids.trellis_capacity), () =>
      capacityInitializeConfigIx(ids.trellis_capacity, { authority, saleAuthority: authority, hvxAuthority: authority, guardian: authority, gradePrices: PARAMS.gradePricesUsdc.map((n) => USDC(n)) as [bigint, bigint, bigint], maxOutstandingValue: null }));
  }

  // The measurement registry (docs/Trellis_Backend.md §3.2): one Registry account whose authority registers and revokes
  // entries. The deployer on devnet; a Squads 2-of-3 in production. Entries are not created here.
  if (live.trellis_measurements) {
    await initOnce("trellis_measurements", registryPda(ids.trellis_measurements), () =>
      initRegistryIx(ids.trellis_measurements, { payer: authority, authority }));
  }

  // The profile's timings and minimum bond: both configs are initialised with the profile; an existing config that holds
  // other values is brought to it here (idempotent; a change that loosens waits out the config timelock). The devnet set
  // is devnet only; see scripts/devnet/profile.ts.
  saveDeployments(dep);
  if (live.trellis_credits && live.trellis_bond) {
    const applied = await applyProfile(conn, deployer, ids, PROFILE_NAME, { log });
    if (!applied.changed.length) log(`credits and bond configs already carry the ${PROFILE_NAME} profile`);
    if (applied.pending) log(`a config change is proposed and waits for the timelock (${Object.entries(applied.pending).map(([p, at]) => `${p}: ${at}`).join(", ")}); run this again after that`);
    Object.assign(dep, loadDeployments());
  }

  dep.authorities = {
    ...(dep.authorities ?? {}),
    authority: authority.toBase58(),
    guardian: authority.toBase58(),
    settlementAuthority: authority.toBase58(),
    slasher: authority.toBase58(),
    saleAuthority: authority.toBase58(),
    hvxAuthority: authority.toBase58(),
    measurementAuthority: authority.toBase58(),
    upgradeAuthority: authority.toBase58(),
    note: "deployer key holds every role on devnet; production: Squads v4 2-of-3 authority, the same multisig as guardian, separate role keys",
  };
  dep.parameters = {
    tabCapUsdc: PARAMS.tabCapUsdc,
    creditsCapPerKeyUsdc: PARAMS.creditsCapPerKeyUsdc,
    creditTtlDays: PARAMS.creditTtlDays,
    tabReclaimGraceHours: 24,
    // refundDelaySeconds, expiryGraceSeconds, bondMinUsdc, unbondSeconds, disputeWindowSeconds, disputeBlockSeconds: the profile's (scripts/devnet/profile.ts).
    ...(live.trellis_credits && live.trellis_bond ? profileParameters(PROFILE) : {}),
    feeSplit: `${PARAMS.workersBps / 100}/${PARAMS.treasuryBps / 100}`, // workers/treasury percent: no fee split, 100% treasury
    feeSplitBps: `${PARAMS.workersBps}/${PARAMS.treasuryBps}`,
    gradePricesUsdcPerBushel: PARAMS.gradePricesUsdc.join(","),
    capacityMaxOutstandingUsdc: 250_000,
    settleRateBpsPerWindow: 2_000, // trellis_credits: settle_to_host moves at most 20% of the vault per window (or 1,000 USDC, if that is more)
    trlsDecimals: PARAMS.trlsDecimals,
  };
  saveDeployments(dep);

  const done = PROGRAMS.filter((p) => dep.configs?.[p]);
  log(`\nconfigs: ${done.map((p) => `${p}=${dep.configs![p]!.status}`).join(" ") || "(none)"}`);
  if (pending.length) log(`skipped (program not deployed): ${pending.join(" ")}`);
  log(`balance ${((await conn.getBalance(authority, "confirmed")) / 1e9).toFixed(4)} SOL; next: bun scripts/devnet/verify.ts`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
