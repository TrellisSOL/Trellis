// Read-only view of a Trellis deployment on any cluster: each program account and its upgrade authority, and every
// config decoded through the router's own clients (src/solana/programs/*.ts), trellis_credits' outflow limiter, and what
// each program says about its own build. verify.ts, handover.ts, pause.ts and scripts/monitor.ts all read the chain
// through this one module, so they cannot disagree about who holds what, what is paused or which build is running.
import { createHash } from "node:crypto";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { anchorPdas, decodeSignerSet, type SignerSet } from "../../src/solana/programs/anchor.ts";
import { bondPdas, decodeBondConfig, type BondConfig } from "../../src/solana/programs/bond.ts";
import { capacityConfigPda, decodeCapacityConfig, type CapacityConfig } from "../../src/solana/programs/capacity.ts";
import { creditsPdas, decodeCreditsConfig, decodeSettleLimiter, type CreditsConfig, type SettleLimiter } from "../../src/solana/programs/credits.ts";
import { decodeFeeConfig, feeRouterPdas, type FeeConfig } from "../../src/solana/programs/fee-router.ts";
import { decodeRulesConfig, rulesConfigPda, type RulesConfig } from "../../src/solana/programs/rules.ts";
import { decodeRegistry, registryPda, type Registry } from "../../src/solana/programs/measurements.ts";
import { decodeTabConfig, tabConfigPda, type TabConfig } from "../../src/solana/programs/tab.ts";
import { BPF_UPGRADEABLE_LOADER, programDataAddress } from "../devnet/lib.ts";
import { PROGRAMS as ALL_PROGRAMS, type ProgramName } from "./lib.ts";
import { PAUSABLE, PROGRAM_IDL, appraiseBuildProfile, buildProfileIx, type ProfileReading } from "./plan.ts";

/** Bytes of the ProgramData header: u32 variant (3) | u64 slot | Option<Pubkey> upgrade authority (1 + 32). */
export const PROGRAMDATA_HEADER = 45;

export type ProgramState = {
  name: ProgramName;
  programId: string;
  deployed: boolean;
  executable: boolean;
  upgradeable: boolean;
  programData: string | null;
  /** null with `frozen: true` means the program can never be upgraded again. */
  upgradeAuthority: string | null;
  frozen: boolean;
  lastDeploySlot: bigint | null;
  /** Length of the program bytes the ProgramData account can hold (its max_len). */
  dataLen: number | null;
  /** sha256 of the program bytes with trailing zero padding removed: what `solana-verify get-program-hash` reports. */
  dataSha256: string | null;
};
export type Configs = {
  trellis_credits: CreditsConfig | null;
  trellis_anchor: SignerSet | null;
  trellis_rules: RulesConfig | null;
  trellis_tab: TabConfig | null;
  trellis_bond: BondConfig | null;
  trellis_fee_router: FeeConfig | null;
  trellis_capacity: CapacityConfig | null;
  trellis_measurements: Registry | null;
};
export type ChainState = {
  programs: Record<ProgramName, ProgramState>; configs: Configs; configAddresses: Record<ProgramName, string>; slot: number;
  /**
   * Programs whose config account exists but is SHORTER than the current layout: it was created by a build from before
   * `paused_until` / `guardian_pause_ready_at`. Its config is reported as absent (null) here, never decoded from the
   * short bytes (the decoder would read the missing fields as zero without complaint); `migrate_config` grows it.
   */
  legacy: ProgramName[];
  /** trellis_credits' outflow limiter at `["limiter_v2"]`; null when credits is not deployed or the account is missing. */
  limiter: SettleLimiter | null;
  limiterAddress: string;
  /** True when the first limiter's account (`["limiter"]`, another layout, read by no instruction) still exists. */
  legacyLimiter: boolean;
};
/** The name of each program's config account in its IDL. */
export const CONFIG_ACCOUNT: Record<ProgramName, string> = { trellis_credits: "CreditsConfig", trellis_anchor: "SignerSet", trellis_rules: "RulesConfig", trellis_tab: "TabConfig", trellis_bond: "BondConfig", trellis_fee_router: "FeeConfig", trellis_capacity: "CapacityConfig", trellis_measurements: "Registry" };
/** Bytes of a config account in the current layout (discriminator included), from the IDL. */
export const configSize = (p: ProgramName): number => (PROGRAM_IDL[p].coder.accounts as unknown as { size(name: string): number }).size(CONFIG_ACCOUNT[p]);

export const configAddress = (p: ProgramName, id: PublicKey): PublicKey =>
  p === "trellis_credits" ? creditsPdas(id).config
  : p === "trellis_anchor" ? anchorPdas(id).signerSet
  : p === "trellis_rules" ? rulesConfigPda(id)
  : p === "trellis_tab" ? tabConfigPda(id)
  : p === "trellis_bond" ? bondPdas(id).config
  : p === "trellis_fee_router" ? feeRouterPdas(id).feeConfig
  : p === "trellis_measurements" ? registryPda(id)
  : capacityConfigPda(id);

/** sha256 of program bytes after dropping trailing zeros (the padding up to max_len), as solana-verify hashes a program. */
export function programHash(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
}

export async function readProgram(conn: Connection, name: ProgramName, id: PublicKey, opts: { hash?: boolean } = {}): Promise<ProgramState> {
  const base: ProgramState = { name, programId: id.toBase58(), deployed: false, executable: false, upgradeable: false, programData: null, upgradeAuthority: null, frozen: false, lastDeploySlot: null, dataLen: null, dataSha256: null };
  const info = await conn.getAccountInfo(id, "confirmed");
  if (!info) return base;
  base.deployed = true;
  base.executable = info.executable;
  base.upgradeable = info.owner.equals(BPF_UPGRADEABLE_LOADER);
  if (!base.upgradeable) return base;
  const pdAddress = programDataAddress(id);
  base.programData = pdAddress.toBase58();
  // Without the hash only the header is fetched: the monitor reads this every few minutes and does not need 2 MB of program bytes.
  const pd = await conn.getAccountInfo(pdAddress, opts.hash ? { commitment: "confirmed" } : { commitment: "confirmed", dataSlice: { offset: 0, length: PROGRAMDATA_HEADER } });
  if (!pd || pd.data.length < PROGRAMDATA_HEADER) return base;
  base.lastDeploySlot = pd.data.readBigUInt64LE(4);
  const hasAuthority = pd.data[12] === 1;
  base.upgradeAuthority = hasAuthority ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  base.frozen = !hasAuthority;
  if (opts.hash) {
    base.dataLen = pd.data.length - PROGRAMDATA_HEADER;
    base.dataSha256 = programHash(pd.data.subarray(PROGRAMDATA_HEADER));
  }
  return base;
}

/**
 * `ids` may leave a program out (the devnet record predates the measurement registry): it is then reported as not
 * deployed and its config as absent.
 */
export async function readChainState(conn: Pick<Connection, "getAccountInfo" | "getSlot">, ids: Partial<Record<ProgramName, PublicKey>>, opts: { hash?: boolean } = {}): Promise<ChainState> {
  const programs = {} as Record<ProgramName, ProgramState>;
  const configAddresses = {} as Record<ProgramName, string>;
  for (const p of ALL_PROGRAMS) {
    const id = ids[p];
    if (!id) { programs[p] = { name: p, programId: "", deployed: false, executable: false, upgradeable: false, programData: null, upgradeAuthority: null, frozen: false, lastDeploySlot: null, dataLen: null, dataSha256: null }; configAddresses[p] = ""; continue; }
    programs[p] = await readProgram(conn as Connection, p, id, opts);
    configAddresses[p] = configAddress(p, id).toBase58();
  }
  const legacy: ProgramName[] = [];
  const data = async (p: ProgramName) => (programs[p].deployed ? (await conn.getAccountInfo(new PublicKey(configAddresses[p]), "confirmed"))?.data ?? null : null);
  const dec = async <T>(p: ProgramName, decode: (d: Uint8Array) => T | null): Promise<T | null> => {
    const d = await data(p);
    if (!d) return null;
    let out: T | null;
    try { out = decode(d); } catch { return null; }
    // A config of the right type that is too short predates the current layout: not decoded, reported as legacy.
    if (out && (PAUSABLE as readonly string[]).includes(p) && d.length < configSize(p)) { legacy.push(p); return null; }
    return out;
  };
  const configs: Configs = {
    trellis_credits: await dec("trellis_credits", decodeCreditsConfig),
    trellis_anchor: await dec("trellis_anchor", decodeSignerSet),
    trellis_rules: await dec("trellis_rules", decodeRulesConfig),
    trellis_tab: await dec("trellis_tab", decodeTabConfig),
    trellis_bond: await dec("trellis_bond", decodeBondConfig),
    trellis_fee_router: await dec("trellis_fee_router", decodeFeeConfig),
    trellis_capacity: await dec("trellis_capacity", decodeCapacityConfig),
    trellis_measurements: await dec("trellis_measurements", decodeRegistry),
  };
  let limiter: SettleLimiter | null = null, limiterAddress = "", legacyLimiter = false;
  const credits = ids.trellis_credits;
  if (credits && programs.trellis_credits.deployed) {
    const address = creditsPdas(credits).limiter;
    limiterAddress = address.toBase58();
    const info = await conn.getAccountInfo(address, "confirmed");
    try { limiter = info ? decodeSettleLimiter(info.data) : null; } catch { limiter = null; }
    legacyLimiter = !!(await conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("limiter")], credits)[0], "confirmed"));
  }
  return { programs, configs, configAddresses, slot: await conn.getSlot("confirmed"), legacy, limiter, limiterAddress, legacyLimiter };
}

/** The cluster's own clock (the block time of the confirmed head): what the programs compare a pause or a proposal with. */
export async function chainTime(conn: Pick<Connection, "getSlot" | "getBlockTime">): Promise<number> {
  const t = await conn.getBlockTime(await conn.getSlot("confirmed")).catch(() => null);
  return t ?? Math.floor(Date.now() / 1000);
}

// ---- Simulation: nothing is sent, no signature is needed ------------------------------------------------------------------------
export type Simulated = { err: unknown; logs: string[]; account: Buffer | null; returnData: Buffer | null };
/** Simulate instructions with `payer` as the fee payer (it must hold SOL; it signs nothing). `read` returns one account as the simulation left it. */
export async function simulateInstructions(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], read?: PublicKey): Promise<Simulated> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", ...(read ? { accounts: { encoding: "base64" as const, addresses: [read.toBase58()] } } : {}) });
  const acct = r.value.accounts?.[0];
  return { err: r.value.err, logs: r.value.logs ?? [], account: acct ? Buffer.from(acct.data[0], "base64") : null, returnData: r.value.returnData ? Buffer.from(r.value.returnData.data[0], "base64") : null };
}
/** The first of `candidates` that holds SOL: a simulated transaction needs a fee payer that exists, and nothing more. */
export async function fundedPayer(conn: Pick<Connection, "getBalance">, candidates: (PublicKey | string | null | undefined)[]): Promise<PublicKey | null> {
  for (const c of candidates) {
    if (!c) continue;
    let key: PublicKey;
    try { key = typeof c === "string" ? new PublicKey(c) : c; } catch { continue; }
    if ((await conn.getBalance(key, "confirmed").catch(() => 0)) > 0) return key;
  }
  return null;
}
/**
 * Ask a DEPLOYED program which build it is: build_profile, simulated. The answer is judged by `appraiseBuildProfile`
 * (profile 0 and every mainnet floor, or it is not the mainnet build). A program that does not answer (an older build,
 * a payer without SOL, an RPC that does not return data) reads as "unknown", which every caller treats as a failure.
 */
export async function readBuildProfile(conn: Connection, p: ProgramName, id: PublicKey, payer: PublicKey | null): Promise<ProfileReading> {
  if (!payer) return { kind: "unknown", profile: null, timelock: null, floors: {}, problems: ["build_profile could not be simulated: no address with SOL is known to pay the simulated fee"] };
  let r: Simulated;
  try { r = await simulateInstructions(conn, payer, [buildProfileIx(p, id)]); } catch (e) { return { kind: "unknown", profile: null, timelock: null, floors: {}, problems: [`build_profile could not be simulated (${(e as Error).name})`] }; }
  if (r.err || !r.returnData) return { kind: "unknown", profile: null, timelock: null, floors: {}, problems: [`build_profile did not answer (${r.err ? JSON.stringify(r.err) : "no return data"}): the deployed program predates it, or is not this program`] };
  return appraiseBuildProfile(p, r.returnData);
}

/**
 * Every privileged key of the deployment, one row per (program, role).
 *   upgrade     the program's upgrade authority (can replace the code)
 *   authority   the config authority (parameters, roles, unpause, resolve disputes; for trellis_anchor it also posts the
 *               hourly roots and rotates the receipt signing key, so there it is the anchorer key by design)
 *   guardian    may pause (tighten) only
 *   settlement, slasher, sale, hvx   the operational role keys the workers sign with
 */
export type Holder = { program: ProgramName; role: "upgrade" | "authority" | "guardian" | "settlement" | "slasher" | "sale" | "hvx"; address: string | null };
export function holders(state: ChainState): Holder[] {
  const out: Holder[] = [];
  const b58 = (k: PublicKey | undefined | null) => (k ? k.toBase58() : null);
  for (const p of ALL_PROGRAMS) if (state.programs[p].deployed) out.push({ program: p, role: "upgrade", address: state.programs[p].upgradeAuthority });
  const c = state.configs;
  if (c.trellis_credits) out.push({ program: "trellis_credits", role: "authority", address: b58(c.trellis_credits.authority) }, { program: "trellis_credits", role: "guardian", address: b58(c.trellis_credits.guardian) }, { program: "trellis_credits", role: "settlement", address: b58(c.trellis_credits.settlementAuthority) });
  if (c.trellis_anchor) out.push({ program: "trellis_anchor", role: "authority", address: b58(c.trellis_anchor.authority) });
  if (c.trellis_rules) out.push({ program: "trellis_rules", role: "authority", address: b58(c.trellis_rules.authority) }, { program: "trellis_rules", role: "guardian", address: b58(c.trellis_rules.guardian) });
  if (c.trellis_tab) out.push({ program: "trellis_tab", role: "authority", address: b58(c.trellis_tab.authority) }, { program: "trellis_tab", role: "guardian", address: b58(c.trellis_tab.guardian) });
  if (c.trellis_bond) out.push({ program: "trellis_bond", role: "authority", address: b58(c.trellis_bond.authority) }, { program: "trellis_bond", role: "guardian", address: b58(c.trellis_bond.guardian) }, { program: "trellis_bond", role: "slasher", address: b58(c.trellis_bond.slasher) });
  if (c.trellis_fee_router) out.push({ program: "trellis_fee_router", role: "authority", address: b58(c.trellis_fee_router.authority) });
  if (c.trellis_capacity) out.push({ program: "trellis_capacity", role: "authority", address: b58(c.trellis_capacity.authority) }, { program: "trellis_capacity", role: "guardian", address: b58(c.trellis_capacity.guardian) }, { program: "trellis_capacity", role: "sale", address: b58(c.trellis_capacity.saleAuthority) }, { program: "trellis_capacity", role: "hvx", address: b58(c.trellis_capacity.hvxAuthority) });
  if (c.trellis_measurements) out.push({ program: "trellis_measurements", role: "authority", address: b58(c.trellis_measurements.authority) });
  return out;
}

/**
 * The holders a deployments record expects (deployments/<cluster>.json `authorities`, plus each program's recorded
 * upgrade authority). `anchorAuthority` is optional: the devnet record predates it and one key holds everything there.
 */
export function expectedHolder(h: Holder, rec: { deployer?: string; authorities?: Record<string, string>; programs?: Partial<Record<string, { upgradeAuthority?: string | null }>>; handover?: { resolved?: Partial<Record<string, string>> } }): string | null | undefined {
  const a = rec.authorities ?? {};
  // A program added after the hand-over (a later tier) stays with the deployer until its own hand-over resolves.
  const waiting = !!rec.handover?.resolved && !rec.handover.resolved[h.program] && !!rec.deployer;
  switch (h.role) {
    case "upgrade": return rec.programs?.[h.program]?.upgradeAuthority ?? (waiting ? rec.deployer : a.upgradeAuthority);
    case "authority": return h.program === "trellis_anchor" ? a.anchorAuthority ?? a.authority : waiting ? rec.deployer : a.authority;
    case "guardian": return a.guardian;
    case "settlement": return a.settlementAuthority;
    case "slasher": return a.slasher;
    case "sale": return a.saleAuthority;
    case "hvx": return a.hvxAuthority;
  }
}
