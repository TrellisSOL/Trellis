// Shared parts of the mainnet scripts: the mode guard (mainnet or a local rehearsal), the RPC connection, the deployer
// keypair, the deployments record and the typed confirmation. Nothing here prints a secret or an RPC URL: a keyed RPC URL
// is shown as its host name only.
//
// Two modes, and a script refuses to start without exactly one of them:
//   --i-understand-this-is-mainnet   the RPC in MAINNET_RPC_URL must report mainnet-beta's genesis hash
//   --rehearsal                      a local validator on loopback only; refuses mainnet, devnet and testnet genesis hashes
// A rehearsal runs the same code against a throwaway chain (see scripts/mainnet/rehearse.sh) and keeps its record under
// the gitignored .data/, so it can never be mistaken for the mainnet record in deployments/mainnet.json.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { SOLANA_DEVNET_CAIP2 } from "../../src/solana/constants.ts";
import { PROGRAMS as CORE_PROGRAMS, ROOT, retryingFetch } from "../devnet/lib.ts";
import { DEVNET_GENESIS_HASH, MAINNET_CAIP2, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "./params.ts";
import { selectPrograms, type Tier } from "./tiers.ts";

export { BPF_UPGRADEABLE_LOADER, ROOT, isDeployed, programDataAddress } from "../devnet/lib.ts";

/**
 * The programs mainnet runs, in deploy order: the funding path first, then receipts, rulebooks, tabs, bonds, fees,
 * capacity (the order of scripts/devnet), then the measurement registry (programs/trellis_measurements, docs §3.2).
 */
export const PROGRAMS = [...new Set<string>([...CORE_PROGRAMS, "trellis_measurements"])] as ProgramName[];
export type ProgramName = (typeof CORE_PROGRAMS)[number] | "trellis_measurements";

/**
 * The programs this run is about: `--tier minimal|credits|payments|full` or `--programs a,b,c` (also MAINNET_TIER /
 * MAINNET_PROGRAMS). Without either: the tier the deployments record was made with, else the recommended `credits`.
 * scripts/mainnet/tiers.ts has the table. PROGRAMS above stays the list of all eight: their ids are reserved from the
 * start, whatever is deployed.
 */
export const TIER_OPTIONS = ["--tier", "--programs"];
export function selection(args: Args, rec?: Record_ | null): { tier: Tier; programs: ProgramName[] } {
  const tier = args.options.get("--tier") ?? (args.options.has("--programs") ? undefined : process.env.MAINNET_TIER?.trim() || undefined);
  const programs = args.options.get("--programs") ?? (tier === undefined ? process.env.MAINNET_PROGRAMS?.trim() || undefined : undefined);
  const r = selectPrograms({ tier, programs, fallback: rec?.selected });
  if (r.problems.length) fail(`Launch tier: ${r.problems.join("; ")}.`, 2);
  return { tier: r.tier, programs: r.programs as ProgramName[] };
}

export type Mode = "mainnet" | "rehearsal";
export const MAINNET_FLAG = "--i-understand-this-is-mainnet";
export const REHEARSAL_FLAG = "--rehearsal";

// ---- Arguments -------------------------------------------------------------------------------------------------------
export type Args = { flags: Set<string>; options: Map<string, string>; positional: string[] };
/** `--flag`, `--option value` (for the names in `valued`) and positionals. Unknown `--names` are rejected by `expect`. */
export function parseArgs(argv: string[], valued: string[]): Args {
  const flags = new Set<string>(), options = new Map<string, string>(), positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`, 2);
      options.set(name, v);
    } else flags.add(a);
  }
  return { flags, options, positional };
}
export function expectFlags(args: Args, allowed: string[]): void {
  for (const f of args.flags) if (!allowed.includes(f)) fail(`unknown flag ${f}; allowed: ${allowed.join(" ")}`, 2);
}
export function fail(message: string, code = 1): never { console.error(message); process.exit(code); }

export function modeOf(args: Args): Mode {
  const mainnet = args.flags.has(MAINNET_FLAG), rehearsal = args.flags.has(REHEARSAL_FLAG);
  if (mainnet === rehearsal) fail(`Refusing to run: pass exactly one of ${MAINNET_FLAG} (the RPC must be mainnet-beta) or ${REHEARSAL_FLAG} (a local validator).`, 2);
  if (mainnet) refuseMainnetOverrides();
  return mainnet ? "mainnet" : "rehearsal";
}
/**
 * Mainnet builds from the repository at a commit and compares the chain with what THIS run hashed. The variables that
 * point the kit at other sources, other binaries or another deployments record are for rehearsals; set on mainnet they
 * stop every script before it reads anything (security/REVIEW-ROUND3-2026-10.md R3-10; REVIEW-ROUND4 R4-18: a record
 * named by the environment could be an older copy that does not list a program deployed since). Binaries built
 * elsewhere are named on the command line (`--prebuilt <dir>`), where the operator and the shell history see them.
 */
export const MAINNET_REFUSED_OVERRIDES = [
  ["TRELLIS_SO_DIR", "a directory of binaries that would stand in for the build"],
  ["TRELLIS_ROOT", "a source root other than this repository"],
  ["TRELLIS_DEPLOYMENTS_FILE", "a deployments record other than deployments/mainnet.json of this repository"],
] as const;
export function refuseMainnetOverrides(env: Record<string, string | undefined> = process.env): void {
  for (const [name, why] of MAINNET_REFUSED_OVERRIDES) {
    if (env[name]?.trim()) fail(`Refusing to run on mainnet: ${name} is set (${why}). It is a rehearsal override; unset it.`, 2);
  }
}

// ---- RPC ---------------------------------------------------------------------------------------------------------------
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function rpcUrl(mode: Mode): string {
  if (mode === "rehearsal") {
    const url = process.env.REHEARSAL_RPC_URL ?? "http://127.0.0.1:8899";
    let host = "";
    try { host = new URL(url).hostname; } catch { /* reported below */ }
    if (!LOOPBACK.has(host)) fail("A rehearsal only runs against a local validator: REHEARSAL_RPC_URL must be on 127.0.0.1 or localhost.", 2);
    return url;
  }
  // Mainnet: from the environment only. There is deliberately no default and no flag, so a keyed URL never lands in a
  // shell history, a process list or a tracked file.
  const url = process.env.MAINNET_RPC_URL;
  if (!url) fail("MAINNET_RPC_URL is not set. Export the mainnet RPC URL from your RPC provider (environment only; never a flag or a tracked file).", 2);
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("MAINNET_RPC_URL is not a URL.", 2); }
  if (parsed.protocol !== "https:") fail("MAINNET_RPC_URL must be https.", 2);
  return url;
}
/** The host of an RPC URL: the only part of it that is ever printed (provider keys sit in the path or the query). */
export const rpcHost = (url: string) => { try { return new URL(url).host; } catch { return "(invalid url)"; } };
/**
 * A failed request must not carry the URL into an error message or a stack dump (a runtime's fetch error names the URL
 * it could not reach, key and all): whatever fetch throws is replaced by an error that names the host only.
 */
const quietFetch = (url: string) => async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  try { return await retryingFetch(input, init); }
  catch (e) { throw new Error(`the RPC at ${rpcHost(url)} could not be reached (${(e as { code?: string }).code ?? (e as Error).name ?? "request failed"})`); }
};
export const connect = (url: string) => new Connection(url, { commitment: "confirmed", fetch: quietFetch(url) as typeof fetch, disableRetryOnRateLimit: true });

/** The cluster guard every script runs before anything else. Returns the genesis hash it saw. */
export async function assertCluster(conn: Connection, mode: Mode): Promise<string> {
  let genesis: string;
  try { genesis = await conn.getGenesisHash(); } catch { fail(`Refusing to run: the RPC at ${rpcHost(conn.rpcEndpoint)} did not answer getGenesisHash, so the cluster cannot be identified.`, 2); }
  if (mode === "mainnet") {
    if (genesis !== MAINNET_GENESIS_HASH) fail(`Refusing to run: the RPC reports genesis hash ${genesis}, not mainnet-beta's ${MAINNET_GENESIS_HASH}.`, 2);
  } else if ([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH].includes(genesis)) {
    fail(`Refusing to rehearse: the RPC reports the genesis hash of a public cluster (${genesis}). A rehearsal runs against a local validator only.`, 2);
  }
  return genesis;
}

// ---- Keys --------------------------------------------------------------------------------------------------------------
/** Why a file that holds a secret key must not be loaded as it is: null when only its owner can read it. */
export function keyFileProblem(path: string): string | null {
  let mode: number;
  try { mode = statSync(path).mode & 0o777; } catch { return `keypair file ${path} does not exist or cannot be examined`; }
  return (mode & 0o077) !== 0 ? `keypair file ${path} is readable by other users (mode ${mode.toString(8)}); chmod 600` : null;
}
/**
 * A keypair file's public key and Keypair. The secret never leaves the Keypair and is never logged. EVERY key the kit
 * loads comes through here (the deployer, the guardian, the program keypairs, a rehearsal's fixtures), and a file that
 * its group or anyone else can read is refused, on mainnet and in a rehearsal alike (R3-21).
 */
export function readKeypairFile(path: string): Keypair {
  const loose = keyFileProblem(path);
  if (loose) fail(loose, 2);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`keypair file ${path} could not be read as JSON`, 2); }
  if (!Array.isArray(raw) || raw.length !== 64) fail(`keypair file ${path} is not a 64-byte keypair`, 2);
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}
/**
 * The deployer: the one operator key that pays for the deploy and holds every authority until handover.ts moves them to
 * the multisig. Mainnet: MAINNET_DEPLOYER_KEYPAIR, a keypair made for this deployment; the devnet deployer is refused.
 */
export function loadDeployer(mode: Mode): Keypair {
  const name = mode === "mainnet" ? "MAINNET_DEPLOYER_KEYPAIR" : "REHEARSAL_DEPLOYER_KEYPAIR";
  const path = process.env[name];
  if (!path) fail(`${name} is not set: the path of the deployer keypair file (mode 0600) for this ${mode === "mainnet" ? "deployment" : "rehearsal"}.`, 2);
  if (!existsSync(path)) fail(`${name} points at a file that does not exist.`, 2);
  const kp = readKeypairFile(path);
  if (mode === "mainnet") {
    const devnet = devnetRecord();
    if (devnet?.deployer && devnet.deployer === kp.publicKey.toBase58()) fail("Refusing to run: MAINNET_DEPLOYER_KEYPAIR is the devnet deployer key. Generate a fresh keypair for mainnet (MAINNET.md, key generation).", 2);
  }
  return kp;
}
export function pubkey(value: string | undefined, what: string): PublicKey {
  if (!value) fail(`${what} is not set.`, 2);
  try { return new PublicKey(value); } catch { fail(`${what} is not a base58 public key.`, 2); }
}
export const optionalPubkey = (value: string | undefined, what: string) => (value ? pubkey(value, what) : null);

// ---- Deployments record --------------------------------------------------------------------------------------------------
export type ProgramRecord = {
  programId: string; status?: "deployed" | "pending"; deploySignature?: string; deployedAt?: string; soBytes?: number;
  /** sha256 of the .so file that was deployed, and the same with trailing zeros dropped (what the chain's bytes hash to). */
  soSha256?: string; soHash?: string;
  /** The build profile the preflight established for those bytes before deploying: "mainnet" (24 h timelock) or "devnet". */
  profile?: string;
  maxLen?: number; upgradeAuthority?: string | null; idl?: { status: string; at?: string; reason?: string };
  /** The commit deploy.sh ran from when it deployed THIS program, whether that tree was clean, and what build it deployed. */
  sourceCommit?: string; sourceTree?: string; sourceKey?: string; buildKind?: string;
};
export type ConfigRecord = { address: string; signature?: string; initialisedAt?: string; status: "initialised" | "exists" };
export type HandoverRecord = {
  multisigVault: string;
  multisigAccount?: string;
  /** Phase 1: when each program's hand-over was proposed, when its timelock ends and when it expires unapplied (unix seconds). */
  proposals?: Partial<Record<ProgramName, { signature: string; proposedAt: string; effectiveAt: number; expiresAt?: number }>>;
  /** Phase 2: the transaction that resolved each program's hand-over (the vault co-signed it). */
  resolved?: Partial<Record<ProgramName, string>>;
  /** Set once nothing is left on the operator key. */
  at?: string;
  signatures?: Record<string, string>;
  frozen?: boolean;
  /** The multisig as `propose` and `check` read it (threshold, members, time lock): a later reading is compared with it. */
  multisig?: Record<string, unknown>;
  /** Set by `propose --set-guardian <key>`: the guardian this hand-over replaces, per program, and the new one. */
  setGuardian?: { to: string; from: Partial<Record<ProgramName, string>>; at: string };
  /** Bypasses that were accepted (`--multisig-untested-ok`): verify.ts carries them into its report. */
  exceptions?: { id: string; phase: string; at: string; detail?: string }[];
};
export type Record_ = {
  cluster: "mainnet" | "rehearsal" | "devnet";
  network: string;
  genesisHash?: string;
  deployer?: string;
  updatedAt?: string;
  sourceCommit?: string;
  /** The launch tier and the programs it selects (scripts/mainnet/tiers.ts); grows when a later tier is added. */
  tier?: Tier;
  selected?: ProgramName[];
  /** The id reserved for every program, deployed or not: other programs' configs point at them. */
  reserved?: Partial<Record<ProgramName, string>>;
  /** How the deployed binaries were built and checked before the deploy (scripts/mainnet/build.sh, simulate.ts). */
  build?: { kind: string; dir: string; sourceKey?: string; sourceCommit?: string; sourceTree?: string; profile: string; checkedAt: string };
  programs: Partial<Record<ProgramName, ProgramRecord>>;
  mints?: { usdc?: string; usdcSource?: string; trls?: string; trlsDecimals?: number };
  accounts?: Record<string, string>;
  authorities?: Record<string, string>;
  parameters?: Record<string, string | number>;
  configs?: Partial<Record<ProgramName, ConfigRecord>>;
  handover?: HandoverRecord;
};
/**
 * The deployments record. Mainnet: deployments/mainnet.json of this repository and nothing else (the environment is
 * not consulted; `modeOf` has already refused a run that sets the override). A rehearsal may name its own file.
 */
export const deploymentsFile = (mode: Mode) =>
  mode === "mainnet" ? join(ROOT, "deployments/mainnet.json") : process.env.TRELLIS_DEPLOYMENTS_FILE ?? join(ROOT, ".data/mainnet-rehearsal/deployment.json");
export function loadRecord(mode: Mode, genesisHash?: string): Record_ {
  const file = deploymentsFile(mode);
  if (!existsSync(file)) return { cluster: mode, network: mode === "mainnet" ? MAINNET_CAIP2 : `solana:${(genesisHash ?? "local").slice(0, 32)}`, genesisHash, programs: {} };
  const rec = JSON.parse(readFileSync(file, "utf8")) as Record_;
  if (rec.cluster !== mode) fail(`${file} is a ${rec.cluster} record, not a ${mode} one.`, 2);
  if (genesisHash && rec.genesisHash && rec.genesisHash !== genesisHash) fail(`${file} was written for genesis hash ${rec.genesisHash}; the RPC reports ${genesisHash}. Remove the stale rehearsal record or fix the RPC.`, 2);
  return rec;
}
export function saveRecord(mode: Mode, rec: Record_): void {
  const file = deploymentsFile(mode);
  rec.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
}
/** deployments/devnet.json, read only to refuse devnet keys on mainnet. */
export function devnetRecord(): { deployer?: string; network?: string; programs?: Record<string, { programId?: string }> } | null {
  const file = join(ROOT, "deployments/devnet.json");
  if (!existsSync(file)) return null;
  try { const r = JSON.parse(readFileSync(file, "utf8")); return r?.network === SOLANA_DEVNET_CAIP2 ? r : null; } catch { return null; }
}
/**
 * Program ids of this deployment: the deployed id of each program in `programs` (a script that needs them fails when
 * one is missing) and, for every other program, the id reserved for it. Reserved ids are what configs point at before
 * the program exists (trellis_tab's rules program, trellis_bond's capacity claimer).
 */
export function recordedIds(rec: Record_, programs: readonly ProgramName[] | boolean = PROGRAMS): Record<ProgramName, PublicKey> {
  const need = programs === true ? PROGRAMS : programs === false ? [] : programs;
  const out = {} as Record<ProgramName, PublicKey>;
  for (const p of PROGRAMS) {
    const id = rec.programs[p]?.programId ?? rec.reserved?.[p];
    if (!id) { if (need.includes(p)) fail(`No program id is recorded for ${p}; run scripts/mainnet/deploy.sh first.`, 2); continue; }
    if (need.includes(p) && !rec.programs[p]?.programId) fail(`${p} is part of this tier but is not recorded as deployed; run scripts/mainnet/deploy.sh --tier ... first.`, 2);
    out[p] = new PublicKey(id);
  }
  return out;
}
/** Programs the record says are deployed, in deploy order. */
export const deployedPrograms = (rec: Record_): ProgramName[] => PROGRAMS.filter((p) => rec.programs[p]?.status === "deployed");

// ---- Output --------------------------------------------------------------------------------------------------------------
export const sol = (lamports: number | bigint) => (Number(lamports) / 1e9).toFixed(4);
export const explorer = (mode: Mode, kind: "address" | "tx", v: string) => (mode === "mainnet" ? `https://explorer.solana.com/${kind}/${v}` : `${kind} ${v} (local validator)`);
export function table(rows: (string | number)[][], indent = "  "): void {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, String(c).length); });
  for (const r of rows) console.log(indent + r.map((c, i) => String(c).padEnd(widths[i]!)).join("  ").trimEnd());
}

/**
 * The typed confirmation. The operator must type `phrase` exactly; anything else aborts. `--yes` skips it in a rehearsal
 * only: on mainnet there is no way to answer in advance, and a script with no terminal attached stops here.
 */
export async function confirm(mode: Mode, phrase: string, args: Args): Promise<void> {
  if (args.flags.has("--yes")) {
    if (mode === "mainnet") fail("--yes is not accepted on mainnet: the confirmation must be typed.", 2);
    console.log(`(rehearsal: confirmation "${phrase}" skipped by --yes)`);
    return;
  }
  if (!process.stdin.isTTY) fail("No terminal attached: the confirmation must be typed by the operator. Nothing was sent.", 2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(`\nType exactly  ${phrase}  to continue (anything else aborts): `, resolve));
  rl.close();
  if (answer.trim() !== phrase) fail("Confirmation did not match. Nothing was sent.", 3);
}

// ---- Inputs: role public keys --------------------------------------------------------------------------------------------
/**
 * The public keys init.ts writes into the configs. Public keys only: the secret halves are generated and kept by the owner
 * (MAINNET.md, key generation) and no mainnet script ever reads one of them. config/mainnet.env.example lists the names.
 * Only what the chosen tier needs is required (in brackets: the program that needs it).
 *
 *   MAINNET_MULTISIG_VAULT        the Squads v4 vault: owns the treasury token accounts, takes every authority at hand-over   [any program]
 *   MAINNET_GUARDIAN              the pause key of credits, tab, bond, capacity and rules: it can pause for 72 h (once
 *                                 per 7 days per program) and nothing else. A key of its own: not the deployer, not the
 *                                 vault, not a worker key. Set at init and not changed by the hand-over.                   [those five]
 *   MAINNET_SETTLEMENT_AUTHORITY  trellis_credits settlement_authority (the SETTLEMENT_PRIVATE_KEY worker)                  [credits]
 *   MAINNET_ANCHORER              the anchorer key (ANCHORER_PRIVATE_KEY): trellis_anchor's authority from init on, and in
 *                                 memo mode the key whose signature makes a memo line a root                               [any program]
 *   MAINNET_RECEIPT_SIGNER        trellis_anchor SignerSet.current_signer: the public key of the first receipt signing key   [anchor]
 *   MAINNET_SLASHER               trellis_bond slasher (SLASHER_PRIVATE_KEY)                                                 [bond]
 *   MAINNET_TRLS_MINT             the $TRLS mint (Token-2022, no extensions)                                                 [fee_router]
 *   MAINNET_GRADE_PRICES_USDC     "s,m,l": USDC per Bushel for grades G-S, G-M, G-L (the docs fix no number)                 [capacity]
 *   MAINNET_SALE_AUTHORITY        optional; trellis_capacity sale_authority, default the settlement key
 *   MAINNET_HVX_AUTHORITY         optional; trellis_capacity hvx_authority, default the multisig vault
 */
export type Roles = { multisigVault: PublicKey; guardian: PublicKey; settlement: PublicKey; anchorer: PublicKey; slasher: PublicKey; receiptSigner: PublicKey; sale: PublicKey; hvx: PublicKey; trlsMint: PublicKey; gradePricesUsdc: [number, number, number] };
const HAS_GUARDIAN: ProgramName[] = ["trellis_credits", "trellis_tab", "trellis_bond", "trellis_capacity", "trellis_rules"];
/** The role inputs a set of programs requires. */
export function requiredRoleEnv(programs: readonly ProgramName[]): string[] {
  const has = (p: ProgramName) => programs.includes(p);
  const out: string[] = [];
  if (programs.length) out.push("MAINNET_MULTISIG_VAULT");
  if (HAS_GUARDIAN.some(has)) out.push("MAINNET_GUARDIAN");
  if (has("trellis_credits")) out.push("MAINNET_SETTLEMENT_AUTHORITY");
  // The anchorer is needed by every deployment, not only by trellis_anchor's init: without that program the roots are
  // memo transactions and the anchorer's signature is the only thing that makes a line a root (R3-21).
  if (programs.length) out.push("MAINNET_ANCHORER");
  if (has("trellis_anchor")) out.push("MAINNET_RECEIPT_SIGNER");
  if (has("trellis_bond")) out.push("MAINNET_SLASHER");
  if (has("trellis_fee_router")) out.push("MAINNET_TRLS_MINT");
  if (has("trellis_capacity")) out.push("MAINNET_GRADE_PRICES_USDC");
  return out;
}

/**
 * Reads the role inputs; returns what is missing or malformed instead of exiting, so preflight can list everything at
 * once. A role the chosen programs do not need may be left unset; one that is set is still checked.
 */
export function readRoles(env: Record<string, string | undefined> = process.env, programs: readonly ProgramName[] = PROGRAMS): { roles: Partial<Roles>; problems: string[] } {
  const problems: string[] = [];
  const required = requiredRoleEnv(programs);
  const key = (name: string, fallback?: PublicKey): PublicKey | undefined => {
    const v = env[name]?.trim();
    if (!v) { if (!fallback && required.includes(name)) problems.push(`${name} is not set`); return fallback; }
    try { return new PublicKey(v); } catch { problems.push(`${name} is not a base58 public key`); return undefined; }
  };
  const multisigVault = key("MAINNET_MULTISIG_VAULT");
  const settlement = key("MAINNET_SETTLEMENT_AUTHORITY");
  const roles: Partial<Roles> = {
    multisigVault, settlement,
    guardian: key("MAINNET_GUARDIAN"),
    anchorer: key("MAINNET_ANCHORER"),
    slasher: key("MAINNET_SLASHER"),
    receiptSigner: key("MAINNET_RECEIPT_SIGNER"),
    trlsMint: key("MAINNET_TRLS_MINT"),
    sale: env.MAINNET_SALE_AUTHORITY?.trim() ? key("MAINNET_SALE_AUTHORITY") : settlement,
    hvx: env.MAINNET_HVX_AUTHORITY?.trim() ? key("MAINNET_HVX_AUTHORITY") : multisigVault,
  };
  const prices = env.MAINNET_GRADE_PRICES_USDC?.trim();
  if (!prices) { if (required.includes("MAINNET_GRADE_PRICES_USDC")) problems.push("MAINNET_GRADE_PRICES_USDC is not set (three USDC prices per Bushel, e.g. \"s,m,l\"; the docs fix no number, so there is no default)"); }
  else {
    const parts = prices.split(",").map((x) => x.trim());
    if (parts.length !== 3 || parts.some((x) => !/^\d{1,9}(\.\d{1,6})?$/.test(x) || !(Number(x) > 0))) problems.push("MAINNET_GRADE_PRICES_USDC must be three positive USDC amounts with at most 6 decimals, comma separated");
    else roles.gradePricesUsdc = parts.map(Number) as [number, number, number];
  }
  return { roles, problems };
}

/**
 * Rules the role keys must satisfy before anything is written on chain. The production guards of src/config.ts refuse a
 * worker that holds two privileged keys, so one key in two on-chain roles could not be operated anyway.
 */
export function roleProblems(roles: Partial<Roles>, deployer: PublicKey): string[] {
  const out: string[] = [];
  const named: [string, PublicKey | undefined][] = [["multisig vault", roles.multisigVault], ["guardian", roles.guardian], ["settlement authority", roles.settlement], ["anchorer", roles.anchorer], ["slasher", roles.slasher], ["sale authority", roles.sale], ["HVX authority", roles.hvx], ["receipt signer", roles.receiptSigner]];
  for (const [name, k] of named) if (k?.equals(deployer)) out.push(`${name} is the deployer key: the operator key must hold no role after handover, so every role needs its own key from the start`);
  const hot: [string, PublicKey | undefined][] = [["settlement authority", roles.settlement], ["anchorer", roles.anchorer], ["slasher", roles.slasher]];
  for (let i = 0; i < hot.length; i++) for (let j = i + 1; j < hot.length; j++) {
    const [a, ka] = hot[i]!, [b, kb] = hot[j]!;
    if (ka && kb && ka.equals(kb) && !(roles.multisigVault && ka.equals(roles.multisigVault))) out.push(`${a} and ${b} are the same key: src/config.ts requires privileged worker signing roles to be isolated`);
  }
  if (roles.receiptSigner && [roles.settlement, roles.anchorer, roles.slasher].some((k) => k?.equals(roles.receiptSigner!))) out.push("receipt signer equals a chain role key: the receipt signing key signs receipts only and holds no funds");
  // The guardian can pause at once, for 72 hours, and do nothing else (it cannot cancel a proposal). It is useful only
  // as a key of its own: as the vault it would need two of three signers to pause, as the deployer or a worker key it
  // would share that key's fate.
  if (roles.guardian) {
    if (roles.multisigVault && roles.guardian.equals(roles.multisigVault)) out.push("MAINNET_GUARDIAN is the multisig vault: the guardian must be a separate key, so that a pause does not need two of three signers and the authority and its brake are not one key");
    for (const [name, k] of hot) if (k && k.equals(roles.guardian)) out.push(`MAINNET_GUARDIAN is the ${name} key: the guardian must not be a worker's hot key`);
    if (roles.receiptSigner?.equals(roles.guardian)) out.push("MAINNET_GUARDIAN is the receipt signing key");
  }
  if (roles.multisigVault && PublicKey.isOnCurve(roles.multisigVault.toBytes())) out.push("MAINNET_MULTISIG_VAULT is an ordinary wallet address (on the ed25519 curve), not a program-derived vault: pass the Squads vault address, not a member key and not the multisig account");
  return out;
}

/**
 * The addresses init.ts is about to write into configs and token accounts, one confirmation each (R3-11 residual). They
 * come from the environment, where a wrong line looks like a right one; so each is shown in full with the variable it
 * came from, and the operator types a phrase that carries its last six characters. Only the roles the programs of this
 * run need are asked for. On mainnet nothing answers in advance (`confirm` refuses --yes there).
 */
export type RoleConfirmation = { role: string; address: string; source: string; phrase: string };
export function roleConfirmations(roles: Partial<Roles>, programs: readonly ProgramName[]): RoleConfirmation[] {
  const has = (p: ProgramName) => programs.includes(p);
  const out: RoleConfirmation[] = [];
  const add = (role: string, k: PublicKey | undefined, source: string) => { if (k) out.push({ role, address: k.toBase58(), source, phrase: `${role} ${k.toBase58().slice(-6)}` }); };
  if (!programs.length) return out;
  add("vault", roles.multisigVault, "MAINNET_MULTISIG_VAULT");
  if (HAS_GUARDIAN.some(has)) add("guardian", roles.guardian, "MAINNET_GUARDIAN");
  if (has("trellis_credits")) add("settlement", roles.settlement, "MAINNET_SETTLEMENT_AUTHORITY");
  // The anchorer is written into trellis_anchor's init; in memo mode it is written into the record, where the router and every verifier take it from.
  add("anchorer", roles.anchorer, "MAINNET_ANCHORER");
  if (has("trellis_anchor")) add("receipt signer", roles.receiptSigner, "MAINNET_RECEIPT_SIGNER");
  if (has("trellis_bond")) add("slasher", roles.slasher, "MAINNET_SLASHER");
  if (has("trellis_capacity")) { add("sale", roles.sale, "MAINNET_SALE_AUTHORITY, else the settlement key"); add("hvx", roles.hvx, "MAINNET_HVX_AUTHORITY, else the multisig vault"); }
  return out;
}

// ---- The source the kit runs from (scripts/mainnet/source-state.sh) ---------------------------------------------------------
export type SourceState = {
  root: string;
  /** False when the source root is not the top of a git work tree of its own (a rehearsal's copy of the sources). */
  ownTree: boolean;
  /** 40-hex HEAD, or "" when there is none. */
  commit: string;
  /** Uncommitted paths (the first 20) and how many there are in all; deployments/ is not counted. */
  dirty: string[]; dirtyCount: number;
  /** sha256 over every file that goes into a program build, as it lies on disk under `root`. */
  sourceKey: string;
  /**
   * The same over those paths AS THE COMMIT HOLDS THEM (git archive HEAD): the source key of the commit. It names
   * build.sh's output directory and is what a build manifest must carry. "" when there is no commit.
   */
  headKey: string;
  /** Index entries marked skip-worktree or assume-unchanged (the first 20) and how many there are: git does not look at them. */
  indexFlags: string[]; indexFlagCount: number;
  /** Build paths whose content on disk is not the commit's although `git status` is clean (the first 20) and how many. */
  differs: string[]; differsCount: number;
  /** Replace refs in the repository (`git replace`): with one, a commit id can name another tree than everybody else gets for it (R5-17). */
  replaceRefCount?: number;
};
/** What git says about the tree the programs are built from. One shell script answers for build.sh, deploy.sh and the TypeScript side. */
export function sourceState(): SourceState {
  const r = Bun.spawnSync(["bash", join(ROOT, "scripts/mainnet/source-state.sh"), "--json"], { stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  if (r.exitCode !== 0) fail(`The state of the source tree could not be read (scripts/mainnet/source-state.sh): ${r.stderr.toString().trim().slice(0, 200)}`, 2);
  return JSON.parse(r.stdout.toString()) as SourceState;
}
/**
 * The environment scripts/mainnet/build.sh is run with (R5-17): the caller's, without anything that names a key file, a
 * key or an RPC endpoint. The build runs the build scripts of every dependency; they have no business knowing where
 * the deployer keypair lies or what the keyed RPC URL is. This hides the names, not the files: a mainnet build belongs
 * on a machine that holds no key (build.sh says so where it starts compiling).
 */
export function buildEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !/KEYPAIR|PRIVATE_KEY|SECRET|TOKEN|PASSWORD|KEYS_DIR|_URL$|^SSH_AUTH_SOCK$/.test(k))) as Record<string, string>;
}
/** Why this tree does not name a commit that a mainnet build, deploy or report could cite; null when it does. */
export function sourceProblem(s: SourceState): string | null {
  if (!s.ownTree) return "the source root is not a git work tree of its own, so no commit names what was built";
  if (!/^[0-9a-f]{40}$/.test(s.commit)) return "the git revision is unavailable";
  if (s.replaceRefCount) return `the repository carries ${s.replaceRefCount} replace ref(s) (git replace): with them a commit id names another tree than the one everybody else gets for it, so the commit does not name what is built`;
  if (s.dirtyCount) return `the source tree has uncommitted changes (${s.dirtyCount} path(s), first: ${s.dirty[0]}), so the commit does not name what is built and what verifies it`;
  // `git status` is clean; that is git's word. The next three are the content's (R4-16).
  if (s.indexFlagCount) return `the index marks ${s.indexFlagCount} path(s) skip-worktree or assume-unchanged (first: ${s.indexFlags[0]}): git does not look at them, so a clean \`git status\` says nothing about what they hold`;
  if (s.differsCount) return `the program sources on disk differ in ${s.differsCount} path(s) from the commit although \`git status\` is clean (first: ${s.differs[0]}): a file an ignore or exclude rule hides, or content the index was told not to compare`;
  if (!/^[0-9a-f]{64}$/.test(s.headKey) || s.headKey !== s.sourceKey) return "the program sources on disk do not hash to the source key of the commit";
  return null;
}

// ---- Build manifests: what binds a binary to a commit (R4-16) ---------------------------------------------------------------
/** build.json as scripts/mainnet/build.sh writes it beside the binaries it built (also `--verifiable`, into target/verifiable). */
export type BuildManifest = { kind?: string; sourceKey?: string; sourceCommit?: string; sourceTree?: string; builtFrom?: string; programs?: Record<string, { sha256?: string; bytes?: number; builtAt?: string }> };
export function readBuildManifest(dir: string): BuildManifest | null {
  const file = join(dir, "build.json");
  if (!existsSync(file)) return null;
  try { const m = JSON.parse(readFileSync(file, "utf8")) as BuildManifest; return m && typeof m === "object" ? m : null; } catch { return null; }
}
const fileSha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/**
 * Why `<dir>/<program>.so` is NOT shown to be a build of the commit whose source key is `headKey`; null when it is.
 * A binary is bound to a commit by the manifest that the build wrote beside it, and by nothing else: a file that merely
 * lies in target/verifiable or in a build directory says nothing about which source it was compiled from.
 *   - the manifest names the source key of the commit, and says it was built from a clean tree
 *   - the manifest records the sha256 of this program's binary, and the file on disk still has it
 * (The third leg, that the chain holds those bytes, is the caller's: verify.ts compares the program data, deploy.sh
 * deploys the file it hashed.)
 */
export function manifestBindingProblem(dir: string, program: ProgramName, headKey: string, shown: string = dir): string | null {
  const m = readBuildManifest(dir);
  if (!m) return `${shown} holds no build manifest (build.json): nothing says which commit ${program}.so was built from. scripts/mainnet/build.sh writes one beside what it builds (--verifiable for the Docker build)`;
  if (!m.sourceKey || m.sourceKey !== headKey) return `${shown}/build.json names source key ${String(m.sourceKey ?? "none").slice(0, 16)} (commit ${String(m.sourceCommit ?? "unknown").slice(0, 12)}); the commit checked out now has ${headKey.slice(0, 16)}: the binaries were not built from this source`;
  if (m.sourceTree !== "clean") return `${shown}/build.json says the binaries were not built from a clean tree at a commit (${m.sourceTree ?? "no sourceTree"})`;
  const recorded = m.programs?.[program]?.sha256;
  if (!recorded) return `${shown}/build.json records no sha256 for ${program}: the build that wrote it did not build this program`;
  const file = join(dir, `${program}.so`);
  if (!existsSync(file)) return `${shown}/${program}.so does not exist`;
  const now = fileSha256(file);
  if (now !== recorded) return `${shown}/build.json records sha256 ${recorded} for ${program}.so; the file there now has ${now}: it is not the binary that build produced`;
  return null;
}
/**
 * `--prebuilt <dir>` (preflight.ts). Mainnet: every selected binary must be bound to the current commit by the
 * directory's manifest. A rehearsal may deploy a directory nobody wrote a manifest for (its devnet-feature binaries);
 * but a manifest that IS there is held against the files in a rehearsal too.
 */
export function prebuiltProblems(mode: Mode, dir: string, programs: readonly ProgramName[], headKey: string, shown: string = dir): string[] {
  const out: string[] = [];
  const m = readBuildManifest(dir);
  for (const p of programs) {
    if (mode === "mainnet") { const why = manifestBindingProblem(dir, p, headKey, shown); if (why) out.push(why); continue; }
    const recorded = m?.programs?.[p]?.sha256, file = join(dir, `${p}.so`);
    if (recorded && existsSync(file) && fileSha256(file) !== recorded) out.push(`${shown}/build.json records sha256 ${recorded} for ${p}.so; the file there now has ${fileSha256(file)}: it is not the binary that build produced`);
  }
  return [...new Set(out)];
}
/**
 * A directory as it may be written into the deployments record (which may be published): relative to the repository
 * when it lies inside it, and otherwise not at all. An absolute path names the machine and the account it was run on.
 */
export const OUTSIDE_REPOSITORY = "(outside the repository: not recorded; the binaries are identified by their recorded sha256)";
export function recordableDir(dir: string): string {
  const rel = relative(ROOT, resolve(dir));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : OUTSIDE_REPOSITORY;
}

// ---- Program ids: what is inspected does not depend on what the record names (R4-18) -----------------------------------------
/** The id each program's source declares (`declare_id!` in programs/<name>/src/lib.rs under `root`), as scripts/mainnet/keys.sh --apply writes it. */
export function declaredProgramIds(root: string): Partial<Record<ProgramName, string>> {
  const out: Partial<Record<ProgramName, string>> = {};
  for (const p of PROGRAMS) {
    const file = join(root, "programs", p, "src", "lib.rs");
    if (!existsSync(file)) continue;
    const m = /^declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/m.exec(readFileSync(file, "utf8"));
    if (m) out[p] = m[1]!;
  }
  return out;
}
export type IdWitness = { ids: Partial<Record<ProgramName, string>>; problems: string[]; notes: string[] };
/**
 * The id of every one of the eight programs, from the source and not from the record. The record is a file that can be
 * old, edited or replaced; a program it does not name would simply not be looked at (the round-4 probe: a copy of the
 * record from before a later tier was deployed gave a green hand-over). So:
 *   - the id of a program is the one its source DECLARES. The record may repeat it (`programs`, `reserved`); a record
 *     that names another id is a refusal, and one that names none changes nothing: the chain is read at the declared id;
 *   - mainnet: all eight must be declared, each must equal Anchor.toml [programs.mainnet] (the second place keys.sh
 *     --apply writes it), and none may be an id of the devnet or localnet deployment;
 *   - a rehearsal whose source root declares no id for a program (a bare copy of the manifests) falls back to the
 *     record's id for it, and says so. Mainnet never does.
 */
export function programIdWitness(mode: Mode, rec: Pick<Record_, "programs" | "reserved">, o: { root: string; anchorToml: Partial<Record<ProgramName, string>>; devnetIds?: ReadonlySet<string> }): IdWitness {
  const declared = declaredProgramIds(o.root);
  const ids: Partial<Record<ProgramName, string>> = {}, problems: string[] = [], notes: string[] = [];
  for (const p of PROGRAMS) {
    // Both places a record can name an id are held against the source, each by itself.
    const named = [...new Set([rec.programs?.[p]?.programId, rec.reserved?.[p]].filter((x): x is string => !!x))];
    const recorded = named[0];
    const d = declared[p];
    if (!d) {
      if (mode === "mainnet") { problems.push(`${p}: no declare_id! line in programs/${p}/src/lib.rs, so nothing says where this program may be deployed`); continue; }
      if (recorded) { ids[p] = recorded; notes.push(`${p}: the source root declares no id (rehearsal only: the record's ${recorded} is taken)`); }
      continue;
    }
    ids[p] = d;
    for (const id of named) if (id !== d) problems.push(`${p}: the deployments record names ${id}, the source's declare_id! is ${d}. The record does not decide where a program is looked for`);
    if (mode !== "mainnet") continue;
    const toml = o.anchorToml[p];
    if (!toml) problems.push(`${p}: Anchor.toml [programs.mainnet] has no entry for it (scripts/mainnet/keys.sh --apply writes all eight ids there and into declare_id!)`);
    else if (toml !== d) problems.push(`${p}: Anchor.toml [programs.mainnet] names ${toml}, the source's declare_id! is ${d} (scripts/mainnet/keys.sh --check)`);
    if (o.devnetIds?.has(d)) problems.push(`${p}: declare_id! is the devnet/localnet id ${d}. Mainnet uses fresh program ids (scripts/mainnet/keys.sh --apply on the release branch)`);
  }
  return { ids, problems, notes };
}
/** Every id Anchor.toml reserves for devnet or localnet, and the devnet record's: never a mainnet id. */
export function devnetProgramIds(): Set<string> {
  const out = new Set<string>([...Object.values(anchorTomlIds("devnet")), ...Object.values(anchorTomlIds("localnet"))]);
  for (const p of Object.values(devnetRecord()?.programs ?? {})) if (p.programId) out.add(p.programId);
  return out;
}
/**
 * The ids every kit script reads the chain at: all eight, from the source (see `programIdWitness`), each one read
 * whether or not the record lists it. `need` are the programs the command works on: they must be recorded as deployed,
 * as before. Exits (2) when the record and the source disagree, or, on mainnet, when the id set is not complete.
 */
export function programIds(mode: Mode, rec: Record_, need: readonly ProgramName[] | boolean = PROGRAMS): Record<ProgramName, PublicKey> {
  const w = programIdWitness(mode, rec, { root: mode === "mainnet" ? ROOT : process.env.TRELLIS_ROOT?.trim() || ROOT, anchorToml: anchorTomlIds("mainnet"), devnetIds: mode === "mainnet" ? devnetProgramIds() : undefined });
  if (w.problems.length) fail(`The program ids of this deployment are not established:\n${w.problems.map((x) => `  - ${x}`).join("\n")}`, 2);
  if (w.notes.length) console.error(`note: ${w.notes.length} program id(s) come from the deployments record alone, because this rehearsal's source root declares none for them (${w.notes.length === PROGRAMS.length ? "all eight" : PROGRAMS.filter((p) => w.notes.some((n) => n.startsWith(`${p}:`))).join(", ")}). Mainnet never does that.`);
  const wanted = need === true ? PROGRAMS : need === false ? [] : need;
  const out = {} as Record<ProgramName, PublicKey>;
  for (const p of PROGRAMS) {
    if (wanted.includes(p) && !rec.programs[p]?.programId) fail(`${p} is part of this tier but is not recorded as deployed; run scripts/mainnet/deploy.sh --tier ... first.`, 2);
    if (w.ids[p]) out[p] = new PublicKey(w.ids[p]!);
  }
  return out;
}

// ---- Program ids for the incident scripts (security/REVIEW-ROUND5-2026-10.md R5-16) -------------------------------------------
/**
 * The ids pause.ts and config-change.ts work at. `programIds` above takes them from the source's declare_id! lines, which
 * on mainnet means the release checkout: right for a hand-over or a verification (a record must not hide a program),
 * wrong for the brake. A guardian on a device of its own has a normal checkout, whose declare_id! lines are the
 * localnet ids. So here the id of a program the command works on is the one the deployments RECORD names (the record
 * of this cluster and of this chain: its genesis hash must be the RPC's), or the one typed with
 * `--program-id <program>=<id>`. The record is then a single file that decides where a pause lands, so everything else
 * that could contradict it is held against it, and any contradiction is a refusal:
 *   - a `--program-id` that names another id than the record (the holder's own note of the id, made at the hand-over);
 *   - the record's two places for one id (`programs`, `reserved`) naming different ids;
 *   - mainnet: an id of the devnet or localnet deployment;
 *   - mainnet: this checkout's Anchor.toml [programs.mainnet] naming another id, or its declare_id! naming an id that is
 *     neither the recorded one nor a devnet/localnet one. A checkout that IS a release checkout stays the witness.
 * What it cannot catch: a record AND every other witness on this machine rewritten to an attacker's look-alike program.
 * Both scripts print each id and where it came from; MAINNET.md has the holder write the id down at the hand-over.
 */
export type IncidentIds = { ids: Partial<Record<ProgramName, string>>; from: Partial<Record<ProgramName, string>>; problems: string[] };
export function incidentIdWitness(mode: Mode, rec: Pick<Record_, "programs" | "reserved" | "genesisHash">, genesis: string, need: readonly ProgramName[], o: { pins: Partial<Record<ProgramName, string>>; declared: Partial<Record<ProgramName, string>>; anchorToml: Partial<Record<ProgramName, string>>; nonMainnetIds: ReadonlySet<string> }): IncidentIds {
  const ids: Partial<Record<ProgramName, string>> = {}, from: Partial<Record<ProgramName, string>> = {}, problems: string[] = [];
  let usesRecord = false;
  for (const p of PROGRAMS) {
    const wanted = need.includes(p);
    const pin = o.pins[p], recorded = rec.programs?.[p]?.programId, reserved = rec.reserved?.[p];
    if (recorded && reserved && recorded !== reserved) { problems.push(`${p}: the deployments record names two ids for it (programs: ${recorded}, reserved: ${reserved})`); continue; }
    const named = recorded ?? reserved;
    if (pin && named && pin !== named) { problems.push(`${p}: --program-id names ${pin}, the deployments record names ${named}. One of them is wrong: find out which before anything is signed`); continue; }
    const id = pin ?? named;
    if (!id) { if (wanted) problems.push(`${p}: no program id is known (no deployments record names it): pass --program-id ${p}=<id>`); continue; }
    try { new PublicKey(id); } catch { problems.push(`${p}: ${pin ? "--program-id" : "the deployments record"} names "${id}", which is not a base58 public key`); continue; }
    if (wanted && !pin && rec.programs?.[p]?.status !== "deployed") { problems.push(`${p}: it is not recorded as deployed in the deployments record (pass --program-id ${p}=<id> to name it yourself)`); continue; }
    if (!pin) usesRecord = true;
    if (mode === "mainnet") {
      if (o.nonMainnetIds.has(id)) { problems.push(`${p}: ${id} is a devnet or localnet program id, not a mainnet one`); continue; }
      const toml = o.anchorToml[p], d = o.declared[p];
      if (toml && toml !== id) { problems.push(`${p}: Anchor.toml [programs.mainnet] of this checkout names ${toml}, not ${id}`); continue; }
      if (d && d !== id && !o.nonMainnetIds.has(d)) { problems.push(`${p}: this checkout's declare_id! is ${d}, which is neither the recorded id nor a devnet or localnet id: this is the release checkout of another set of ids`); continue; }
    }
    ids[p] = id;
    from[p] = pin ? "--program-id" : "the deployments record";
  }
  // The record names ids only for the chain it was written for.
  if (usesRecord && !rec.genesisHash) problems.push("the deployments record carries no genesis hash, so nothing says which chain its program ids are of (deploy.sh writes one): pass --program-id <program>=<id>");
  else if (usesRecord && rec.genesisHash !== genesis) problems.push(`the deployments record was written for genesis hash ${rec.genesisHash}; the RPC reports ${genesis}`);
  return { ids, from, problems };
}
/** `--program-id a=<id>,b=<id>` as a map; exits (2) on a name that is not a program or a part that is not `name=id`. */
export function programIdPins(value: string | undefined): Partial<Record<ProgramName, string>> {
  const out: Partial<Record<ProgramName, string>> = {};
  for (const part of (value ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const name = (eq > 0 ? part.slice(0, eq) : "") as ProgramName, id = part.slice(eq + 1);
    if (!PROGRAMS.includes(name) || !id) fail(`--program-id takes <program>=<id>[,<program>=<id>...] with a program of ${PROGRAMS.join(", ")}; got "${part}"`, 2);
    out[name] = id;
  }
  return out;
}
/** The ids an incident script reads the chain and builds its instructions at (see `incidentIdWitness`). Exits (2) on any contradiction. */
export function incidentProgramIds(mode: Mode, rec: Record_, genesis: string, need: readonly ProgramName[], pinsOption?: string): { ids: Record<ProgramName, PublicKey>; from: Partial<Record<ProgramName, string>> } {
  const w = incidentIdWitness(mode, rec, genesis, need, { pins: programIdPins(pinsOption), declared: declaredProgramIds(mode === "mainnet" ? ROOT : process.env.TRELLIS_ROOT?.trim() || ROOT), anchorToml: anchorTomlIds("mainnet"), nonMainnetIds: mode === "mainnet" ? devnetProgramIds() : new Set() });
  if (w.problems.length) fail(`The program ids to act on are not established:\n${w.problems.map((x) => `  - ${x}`).join("\n")}\nNothing was read from the chain and nothing was sent.`, 2);
  return { ids: Object.fromEntries(Object.entries(w.ids).map(([p, id]) => [p, new PublicKey(id!)])) as Record<ProgramName, PublicKey>, from: w.from };
}

/** The ids Anchor.toml reserves in `[programs.<section>]`: on mainnet a second witness of where a program may be deployed. */
export function anchorTomlIds(section: string): Partial<Record<ProgramName, string>> {
  const file = join(ROOT, "Anchor.toml");
  if (!existsSync(file)) return {};
  const m = new RegExp(`^\\[programs\\.${section}\\]\\s*\\n([^\\[]*)`, "m").exec(readFileSync(file, "utf8"));
  return Object.fromEntries([...(m?.[1] ?? "").matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm)].filter((x) => (PROGRAMS as string[]).includes(x[1]!)).map((x) => [x[1]!, x[2]!]));
}
