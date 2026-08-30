// Verify the devnet deployment: each program account (executable, upgradeable loader, upgrade authority, last deploy
// slot), then every initialised config decoded through the router's own clients (src/solana/programs/*.ts) and checked
// against deployments/devnet.json and the parameter set that file records (scripts/devnet/profile.ts): the spec values
// ("mainnet"), or the DEVNET-ONLY short timings and small minimum bond ("devnet") once `init.ts --profile devnet` or the
// devnet walkthrough has applied them. The devnet values differ from the spec on purpose; mainnet keeps the spec values
// and is never checked against the devnet set. Each program's on-chain bytes are compared with the local devnet build
// (target/deploy-devnet, scripts/devnet/build.sh) when that build is present, so "upgraded" means the code on chain is
// the code in this tree. Exits 1 on any mismatch, 2 when programs are still pending.
//
//   bun scripts/devnet/verify.ts
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { pauseActive, type IdlProgram } from "../../src/solana/programs/idl.ts";
import { creditsPdas, decodeCreditsConfig, decodeSettleLimiter, MAX_BALANCE_PER_KEY_LIMIT_UNITS } from "../../src/solana/programs/credits.ts";
import { anchorPdas, decodeSignerSet } from "../../src/solana/programs/anchor.ts";
import { decodeRulesConfig, rulesConfigPda } from "../../src/solana/programs/rules.ts";
import { decodeTabConfig, enforcerPda, tabConfigPda } from "../../src/solana/programs/tab.ts";
import { bondPdas, decodeBondConfig } from "../../src/solana/programs/bond.ts";
import { decodeFeeConfig, feeRouterPdas, TREASURY_BPS, WORKERS_BPS } from "../../src/solana/programs/fee-router.ts";
import { bondClaimerPda, capacityConfigPda, decodeCapacityConfig } from "../../src/solana/programs/capacity.ts";
import { creditsIdl } from "../../src/solana/programs/credits.ts";
import { anchorIdl } from "../../src/solana/programs/anchor.ts";
import { rulesIdl } from "../../src/solana/programs/rules.ts";
import { tabIdl } from "../../src/solana/programs/tab.ts";
import { bondIdl } from "../../src/solana/programs/bond.ts";
import { feeRouterIdl } from "../../src/solana/programs/fee-router.ts";
import { capacityIdl } from "../../src/solana/programs/capacity.ts";
import { decodeRegistry, measurementsIdl, registryPda } from "../../src/solana/programs/measurements.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BPF_UPGRADEABLE_LOADER, PROGRAMS, ROOT, connection, loadDeployments, programDataAddress, programIds, rpcLabel, type ProgramName } from "./lib.ts";
import { PROFILES, describeSeconds, describeUsdc, profileParameters, recordedProfile } from "./profile.ts";

const conn = connection();
const dep = loadDeployments();
// What the chain is expected to carry: the recorded profile's values (the spec values when none is recorded).
const PROFILE_NAME = recordedProfile(dep);
const PROFILE = PROFILES[PROFILE_NAME];
const DEVNET_ONLY = PROFILE_NAME === "devnet" ? "; devnet-only override of the spec" : "";
const ids = programIds(dep, { trellis_credits: creditsIdl.programId, trellis_anchor: anchorIdl.programId, trellis_rules: rulesIdl.programId, trellis_tab: tabIdl.programId, trellis_bond: bondIdl.programId, trellis_fee_router: feeRouterIdl.programId, trellis_capacity: capacityIdl.programId, trellis_measurements: measurementsIdl.programId });
let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };
const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : String(v));
const eq = (a: PublicKey | undefined, b: string | undefined) => !!a && !!b && a.toBase58() === b;

async function programStatus(p: ProgramName): Promise<boolean> {
  const id = ids[p];
  const info = await conn.getAccountInfo(id, "confirmed");
  if (!info) { console.log(`${p} ${id.toBase58()}: not deployed`); return false; }
  console.log(`${p} ${id.toBase58()}`);
  ok(info.executable, "executable");
  ok(info.owner.equals(BPF_UPGRADEABLE_LOADER), `owner is the upgradeable loader (${info.owner.toBase58()})`);
  const pd = await conn.getAccountInfo(programDataAddress(id), "confirmed");
  if (pd) {
    // ProgramData: u32 enum (3) | u64 slot | Option<Pubkey> upgrade authority (1 + 32) | program bytes
    const slot = pd.data.readBigUInt64LE(4);
    const hasAuthority = pd.data[12] === 1;
    const auth = hasAuthority ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : "none (frozen)";
    const bytes = pd.data.length - 45;
    console.log(`  programdata ${programDataAddress(id).toBase58()} slot ${slot} authority ${auth} ${bytes} bytes`);
    const rec = dep.programs[p];
    if (rec?.upgradeAuthority) ok(auth === rec.upgradeAuthority, "upgrade authority matches deployments/devnet.json");
    if (rec?.soBytes) ok(bytes >= rec.soBytes, `program data holds the ${rec.soBytes}-byte build`);
    // The devnet build of this tree, byte for byte (the rest of the program data account is zero padding).
    const so = join(ROOT, "target/deploy-devnet", `${p}.so`);
    if (existsSync(so)) {
      const local = readFileSync(so);
      const onchain = pd.data.subarray(45);
      ok(onchain.length >= local.length && onchain.subarray(0, local.length).equals(local) && onchain.subarray(local.length).every((b) => b === 0), `on-chain code is the local devnet build (${local.length} bytes, target/deploy-devnet/${p}.so)`);
    } else console.log(`  (no local devnet build to compare with; scripts/devnet/build.sh)`);
  } else ok(false, "programdata account present");
  if (dep.programs[p]?.programId) ok(dep.programs[p]!.programId === id.toBase58(), "program id matches deployments/devnet.json");
  return true;
}

async function fetchData(k: PublicKey) { return (await conn.getAccountInfo(k, "confirmed"))?.data ?? null; }

async function verifyConfigs(live: Set<ProgramName>) {
  const authority = dep.authorities?.authority ?? dep.deployer;
  const usdc = dep.mints?.usdc;
  if (live.has("trellis_credits")) {
    const { config, vault } = creditsPdas(ids.trellis_credits);
    const data = await fetchData(config);
    console.log(`\ntrellis_credits config ${config.toBase58()}`);
    const c = data ? decodeCreditsConfig(data) : null;
    if (!c) ok(false, "config account decodes (initialised?)");
    else {
      ok(eq(c.authority, authority), `authority ${str(c.authority)}`);
      ok(eq(c.guardian, authority), `guardian ${str(c.guardian)}`);
      ok(eq(c.usdcMint, usdc), `usdc mint ${str(c.usdcMint)}`);
      ok(c.vault.equals(vault), `vault ${str(c.vault)}`);
      ok(c.maxBalancePerKey === 5_000_000_000n, `max balance per key ${str(c.maxBalancePerKey)} (5,000 USDC)`);
      ok(c.creditTtl === 365n * 86_400n, `credit ttl ${str(c.creditTtl)} s (365 d)`);
      ok(c.refundDelay === PROFILE.refundDelayS, `refund delay ${describeSeconds(c.refundDelay)}, ${PROFILE_NAME} profile expects ${describeSeconds(PROFILE.refundDelayS)}${DEVNET_ONLY}`);
      ok(c.expiryGrace === PROFILE.expiryGraceS, `expiry grace ${describeSeconds(c.expiryGrace)}, ${PROFILE_NAME} profile expects ${describeSeconds(PROFILE.expiryGraceS)}${DEVNET_ONLY}`);
      ok(eq(c.treasuryTokenAccount, dep.accounts?.treasuryUsdc), `treasury ${str(c.treasuryTokenAccount)}`);
      console.log(`  spent_total ${str(c.spentTotal)} settled_total ${str(c.settledTotal)} deposits_paused ${c.depositsPaused}`);
      // The settle_to_host outflow limiter (security review §3): present, at most half the vault per window, not paused.
      const { limiter, pendingConfig } = creditsPdas(ids.trellis_credits);
      const l = await fetchData(limiter).then((d) => (d ? decodeSettleLimiter(d) : null));
      ok(!!l, `outflow limiter ${limiter.toBase58()} exists (init_limiter)`);
      if (l) {
        ok(l.rateBps > 0 && l.rateBps <= 5_000, `outflow rate ${l.rateBps} bps of the vault over any window (host payouts and refunds each have their own allowance)`);
        // Round 3 (R3-07): the limiter carries the base tracker and the absolute cap (migrate_limiter grew an earlier one).
        const limiterData = await fetchData(limiter);
        ok(!!limiterData && limiterData.length >= creditsIdl.accountSize("SettleLimiter"), `outflow limiter has the current layout (${limiterData?.length} bytes; run scripts/devnet/init.ts for migrate_limiter otherwise)`);
        ok(l.capPerWindow >= 1_000_000_000n, `absolute outflow cap ${str(l.capPerWindow)} units per window (never below the 1,000 USDC floor)`);
        ok(c.maxBalancePerKey <= MAX_BALANCE_PER_KEY_LIMIT_UNITS, `per-key cap ${str(c.maxBalancePerKey)} within the compiled maximum`);
        ok(!pauseActive(l.paused, l.pausedUntil), `settlements not paused${l.paused ? ` (a pause lapsed at ${new Date(Number(l.pausedUntil) * 1000).toISOString()})` : ""}`);
        console.log(`  settle allowance ${str(l.settleAllowance)} (refilled ${str(l.settleRefilledAt)}), refund allowance ${str(l.refundAllowance)} (refilled ${str(l.refundRefilledAt)})`);
      }
      ok(!pauseActive(c.depositsPaused, c.depositsPausedUntil), "deposits not paused");
      ok(!(await fetchData(pendingConfig)), "no config change is waiting in the timelock");
    }
  }
  if (live.has("trellis_anchor")) {
    const { signerSet } = anchorPdas(ids.trellis_anchor);
    const data = await fetchData(signerSet);
    console.log(`\ntrellis_anchor signer set ${signerSet.toBase58()}`);
    const s = data ? decodeSignerSet(data) : null;
    if (!s) ok(false, "signer set decodes (initialised?)");
    else {
      ok(eq(s.authority, authority), `authority ${str(s.authority)}`);
      ok(eq(s.currentSigner, dep.authorities?.receiptSigner), `current signer ${str(s.currentSigner)} is the recorded receipt signing key`);
      console.log(`  previous signer ${str(s.previousSigner)} rotations ${str(s.rotationCount)}`);
    }
  }
  if (live.has("trellis_rules")) {
    const pda = rulesConfigPda(ids.trellis_rules);
    const data = await fetchData(pda);
    console.log(`\ntrellis_rules config ${pda.toBase58()}`);
    const r = data ? decodeRulesConfig(data) : null;
    if (!r) ok(false, "config decodes (initialised?)");
    else {
      ok(eq(r.authority, authority), `authority ${str(r.authority)}`);
      ok(r.enforcer.equals(enforcerPda(ids.trellis_tab)), `enforcer is trellis_tab's ["enforcer"] PDA ${str(r.enforcer)}`);
      ok(!pauseActive(r.newRulebooksPaused, r.pausedUntil), "new rulebooks not paused");
    }
  }
  if (live.has("trellis_tab")) {
    const pda = tabConfigPda(ids.trellis_tab);
    const data = await fetchData(pda);
    console.log(`\ntrellis_tab config ${pda.toBase58()}`);
    const t = data ? decodeTabConfig(data) : null;
    if (!t) ok(false, "config decodes (initialised?)");
    else {
      ok(eq(t.authority, authority), `authority ${str(t.authority)}`);
      ok(eq(t.usdcMint, usdc), `usdc mint ${str(t.usdcMint)}`);
      ok(t.rulesProgram.equals(ids.trellis_rules), `rules program ${str(t.rulesProgram)}`);
      ok(t.maxCap === 500_000_000n, `max cap ${str(t.maxCap)} (500 USDC)`);
      ok(t.reclaimGrace === 86_400n, `reclaim grace ${str(t.reclaimGrace)} s (24 h)`);
      ok(!pauseActive(t.paused, t.pausedUntil), "not paused");
    }
  }
  if (live.has("trellis_bond")) {
    const { config } = bondPdas(ids.trellis_bond);
    const data = await fetchData(config);
    console.log(`\ntrellis_bond config ${config.toBase58()}`);
    const b = data ? decodeBondConfig(data) : null;
    if (!b) ok(false, "config decodes (initialised?)");
    else {
      ok(eq(b.authority, authority), `authority ${str(b.authority)}`);
      ok(eq(b.usdcMint, usdc), `usdc mint ${str(b.usdcMint)}`);
      ok(b.minBond === PROFILE.minBondUnits, `min bond ${describeUsdc(b.minBond)}, ${PROFILE_NAME} profile expects ${describeUsdc(PROFILE.minBondUnits)}${DEVNET_ONLY}`);
      ok(b.unbondPeriod === PROFILE.unbondPeriodS, `unbond period ${describeSeconds(b.unbondPeriod)}, ${PROFILE_NAME} profile expects ${describeSeconds(PROFILE.unbondPeriodS)}${DEVNET_ONLY}`);
      ok(b.disputeWindow === PROFILE.disputeWindowS, `dispute window ${describeSeconds(b.disputeWindow)}, ${PROFILE_NAME} profile expects ${describeSeconds(PROFILE.disputeWindowS)}${DEVNET_ONLY}`);
      ok(b.disputeBlock === PROFILE.disputeBlockS, `dispute block ${describeSeconds(b.disputeBlock)}, ${PROFILE_NAME} profile expects ${describeSeconds(PROFILE.disputeBlockS)}${DEVNET_ONLY}`);
      ok(b.capacityClaimer.equals(bondClaimerPda(ids.trellis_capacity)), `capacity claimer is trellis_capacity's ["bond_claimer"] PDA`);
      ok(eq(b.refundPool, dep.accounts?.refundPool), `refund pool ${str(b.refundPool)}`);
      ok(eq(b.treasury, dep.accounts?.treasuryUsdc), `treasury ${str(b.treasury)}`);
      ok(eq(b.capacityRefund, dep.accounts?.capacityRefund), `capacity refund ${str(b.capacityRefund)}`);
      ok(!pauseActive(b.paused, b.pausedUntil), "not paused");
    }
  }
  if (live.has("trellis_fee_router")) {
    const { feeConfig, feeVault, trlsVault } = feeRouterPdas(ids.trellis_fee_router);
    const data = await fetchData(feeConfig);
    console.log(`\ntrellis_fee_router config ${feeConfig.toBase58()}`);
    const f = data ? decodeFeeConfig(data) : null;
    if (!f) ok(false, "config decodes (initialised?)");
    else {
      ok(eq(f.authority, authority), `authority ${str(f.authority)}`);
      ok(eq(f.feeMint, usdc), `fee mint ${str(f.feeMint)}`);
      ok(eq(f.trlsMint, dep.mints?.trls), `$TRLS mint ${str(f.trlsMint)}`);
      ok(f.feeVault.equals(feeVault) && f.trlsVault.equals(trlsVault), `vaults ${str(f.feeVault)} / ${str(f.trlsVault)}`);
      ok(f.workersBps === WORKERS_BPS && f.treasuryBps === TREASURY_BPS, `split ${f.workersBps}/${f.treasuryBps} bps (no fee split: ${WORKERS_BPS}/${TREASURY_BPS})`);
      ok(eq(f.workersVault, dep.accounts?.workersVault), `workers vault ${str(f.workersVault)}`);
      ok(eq(f.treasuryVault, dep.accounts?.treasuryUsdc), `treasury vault ${str(f.treasuryVault)}`);
    }
  }
  if (live.has("trellis_capacity")) {
    const pda = capacityConfigPda(ids.trellis_capacity);
    const data = await fetchData(pda);
    console.log(`\ntrellis_capacity config ${pda.toBase58()}`);
    const c = data ? decodeCapacityConfig(data) : null;
    if (!c) ok(false, "config decodes (initialised?)");
    else {
      ok(eq(c.authority, authority), `authority ${str(c.authority)}`);
      ok(c.gradePrices.length === 3 && c.gradePrices.every((p) => p > 0n), `grade prices ${c.gradePrices.map(str).join(",")} (USDC base units per Bushel)`);
      ok(c.maxOutstandingValue === 250_000_000_000n, `max outstanding ${str(c.maxOutstandingValue)} (250,000 USDC)`);
      ok(!pauseActive(c.paused, c.pausedUntil), "not paused");
    }
  }
  if (live.has("trellis_measurements")) {
    const pda = registryPda(ids.trellis_measurements);
    const data = await fetchData(pda);
    console.log(`\ntrellis_measurements registry ${pda.toBase58()}`);
    const r = data ? decodeRegistry(data) : null;
    if (!r) ok(false, "registry decodes (initialised?)");
    else {
      ok(eq(r.authority, dep.authorities?.measurementAuthority ?? authority), `authority ${str(r.authority)}`);
      ok(r.revoked <= r.registered, `entries: ${str(r.registered)} registered, ${str(r.revoked)} of them revoked`);
      if (dep.configs?.trellis_measurements?.address) ok(dep.configs.trellis_measurements.address === pda.toBase58(), "registry address matches deployments/devnet.json");
    }
  }
}

/**
 * Every program answers `build_profile` with the floors compiled into it (security re-review RR-04). On devnet the
 * deployed binaries are the devnet-flavour build: profile 1 and the 30 s config timelock. A program that says profile 0
 * here carries the mainnet floors (the walkthroughs would wait 72 h); one that does not answer predates the instruction.
 */
async function verifyBuildProfiles(live: Set<ProgramName>) {
  const programs: Record<ProgramName, IdlProgram> = { trellis_credits: creditsIdl, trellis_anchor: anchorIdl, trellis_rules: rulesIdl, trellis_tab: tabIdl, trellis_bond: bondIdl, trellis_fee_router: feeRouterIdl, trellis_capacity: capacityIdl, trellis_measurements: measurementsIdl };
  console.log("\nbuild profiles (build_profile, simulated)");
  const payer = new PublicKey(dep.deployer!);
  for (const p of PROGRAMS) {
    if (!live.has(p)) continue;
    const program = programs[p].at(ids[p]);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [program.buildProfileInstruction()] }).compileToV0Message());
    const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const profile = r.value.returnData ? program.decodeBuildProfile(Buffer.from(r.value.returnData.data[0], "base64")) : null;
    if (!profile) { ok(false, `${p} answers build_profile (${r.value.err ? JSON.stringify(r.value.err) : "no return data"})`); continue; }
    ok(profile.profile === 1 && profile.configTimelock === 30n, `${p} is the devnet build: profile ${profile.profile}, config timelock ${profile.configTimelock} s${Object.entries(profile.floors).filter(([k]) => k !== "configTimelock").map(([k, v]) => `, ${k} ${v}`).join("")}`);
  }
}

async function main() {
  console.log(`verifying on ${rpcLabel()} (deployer ${dep.deployer ?? "?"})`);
  console.log(`parameter set: ${PROFILE_NAME}${PROFILE_NAME === "devnet" ? " (DEVNET-ONLY short timings and minimum bond, recorded in deployments/devnet.json devnetOverrides; mainnet keeps the spec values)" : " (the spec values)"}\n`);
  // The record must agree with the profile it names, so a hand-edited file cannot pass for the chain.
  const recorded = dep.parameters ?? {};
  for (const [k, v] of Object.entries(profileParameters(PROFILE))) if (k in recorded) ok(recorded[k] === v, `deployments/devnet.json parameters.${k} = ${recorded[k]} matches the ${PROFILE_NAME} profile (${v})`);
  const live = new Set<ProgramName>();
  for (const p of PROGRAMS) if (await programStatus(p)) live.add(p);
  await verifyConfigs(live);
  await verifyBuildProfiles(live);
  const pending = PROGRAMS.filter((p) => !live.has(p));
  console.log(`\nlive: ${[...live].join(" ") || "(none)"}`);
  if (pending.length) console.log(`pending: ${pending.join(" ")}`);
  if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
  if (pending.length) process.exit(2);
  console.log("all checks passed");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
