// Parameter sets for the program configs: what `init.ts --profile <name>` initialises or brings a config to, and what
// `verify.ts` expects on chain.
//
//   mainnet   the spec values (docs/Trellis_Backend.md §5, §10): closure refunds wait 72 h, expired credits move after a
//             30-day grace, a host bond is at least 10,000 USDC, unbonding takes 14 days, a slash waits out a 72 h
//             dispute window and an open dispute blocks it for 7 days. Mainnet keeps these; nothing here shortens them
//             there (scripts/mainnet/** has its own checks and never reads the devnet set).
//   devnet    the same programs with short timings and a small minimum bond, so the money paths that wait (closure
//             refund, slash, unbond) can be watched end to end in minutes with a few devnet USDC
//             (scripts/demo/devnet-paths.ts). These values are DEVNET ONLY. They differ from the spec on purpose and are
//             recorded in deployments/devnet.json under `profile` and `devnetOverrides` beside the transactions that set
//             them.
//
// The programs enforce floors the config authority cannot go below (security review §3): 72 h refund delay, 30 d expiry
// grace, 72 h dispute window, 7 d dispute block, 14 d unbonding. The devnet values above are below every one of them, so
// they exist only on a program built with the cargo feature `devnet` (scripts/devnet/build.sh -> target/deploy-devnet),
// which is what devnet runs. The default build, the one mainnet deploys, refuses them with OutOfBounds.
//
// A change that loosens a config (a shorter delay, a smaller bond) cannot be applied at once: it is proposed
// (`propose_config`), waits the program's config timelock (24 h; 30 s in the devnet build) and is then applied
// (`resolve_config`). A change that only tightens goes through `update_config` immediately. applyProfile does whichever
// the change needs and waits out the devnet timelock itself; against a 24 h timelock it proposes, says when the change
// can be applied, and applies it on a later run.
//
// Only the values below differ between the two sets. Everything else (caps, the credit lifetime of 365 days, the tab
// reclaim grace, the fee split, grade prices) is the same on both and stays as init.ts creates it.
import { PublicKey, Transaction, sendAndConfirmTransaction, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { creditsPdas, decodeCreditsConfig, decodePendingCreditsConfig, proposeConfigIx as creditsProposeConfigIx, resolveConfigIx as creditsResolveConfigIx, updateConfigIx as creditsUpdateConfigIx } from "../../src/solana/programs/credits.ts";
import { BOND_SEEDS, bondIdl, bondPdas, decodeBondConfig, proposeConfigIx as bondProposeConfigIx, resolveConfigIx as bondResolveConfigIx, updateConfigIx as bondUpdateConfigIx } from "../../src/solana/programs/bond.ts";
import { explorer, loadDeployments, saveDeployments, type Deployments } from "./lib.ts";

export type ProfileName = "devnet" | "mainnet";
export const PROFILE_NAMES: readonly ProfileName[] = ["devnet", "mainnet"];

export type Profile = {
  /** trellis_credits: seconds a closure refund waits after close_account. */
  refundDelayS: bigint;
  /** trellis_credits: seconds between notice_expiry and sweep_expired. (The router never sweeps sooner than 30 days after its own notice, whatever this says.) */
  expiryGraceS: bigint;
  /** trellis_bond: the smallest bond post_bond accepts, in USDC base units. */
  minBondUnits: bigint;
  /** trellis_bond: seconds between request_unbond and withdraw_bond. */
  unbondPeriodS: bigint;
  /** trellis_bond: seconds a slash proposal waits before execute_slash. */
  disputeWindowS: bigint;
  /** trellis_bond: seconds an open dispute blocks execution. */
  disputeBlockS: bigint;
};

const HOUR = 3_600n, DAY = 86_400n, USDC = 1_000_000n;

export const PROFILES: Record<ProfileName, Profile> = {
  // The spec. These are also the programs' own defaults (constants.rs / state.rs).
  mainnet: { refundDelayS: 72n * HOUR, expiryGraceS: 30n * DAY, minBondUnits: 10_000n * USDC, unbondPeriodS: 14n * DAY, disputeWindowS: 72n * HOUR, disputeBlockS: 7n * DAY },
  // Devnet only: minutes instead of days, and a bond a faucet-funded wallet can post.
  devnet: { refundDelayS: 180n, expiryGraceS: HOUR, minBondUnits: 2n * USDC, unbondPeriodS: 300n, disputeWindowS: 180n, disputeBlockS: 600n },
};

export const isProfileName = (v: unknown): v is ProfileName => v === "devnet" || v === "mainnet";

/** The profile recorded in deployments/devnet.json, or "mainnet" (the spec values) when none is. */
export const recordedProfile = (d: Deployments): ProfileName => (isProfileName(d.profile) ? d.profile : "mainnet");

const human = (seconds: bigint) => (seconds % DAY === 0n ? `${seconds / DAY} d` : seconds % HOUR === 0n ? `${seconds / HOUR} h` : seconds % 60n === 0n ? `${seconds / 60n} min` : `${seconds} s`);
export const describeSeconds = (seconds: bigint) => `${seconds} s (${human(seconds)})`;
export const describeUsdc = (units: bigint) => `${units} (${Number(units) / 1e6} USDC)`;

type Field = { program: "trellis_credits" | "trellis_bond"; name: keyof Profile; label: string; show: (v: bigint) => string };
export const FIELDS: readonly Field[] = [
  { program: "trellis_credits", name: "refundDelayS", label: "refund delay", show: describeSeconds },
  { program: "trellis_credits", name: "expiryGraceS", label: "expiry grace", show: describeSeconds },
  { program: "trellis_bond", name: "minBondUnits", label: "min bond", show: describeUsdc },
  { program: "trellis_bond", name: "unbondPeriodS", label: "unbond period", show: describeSeconds },
  { program: "trellis_bond", name: "disputeWindowS", label: "dispute window", show: describeSeconds },
  { program: "trellis_bond", name: "disputeBlockS", label: "dispute block", show: describeSeconds },
];

export type Onchain = { credits: Pick<Profile, "refundDelayS" | "expiryGraceS"> & { authority: PublicKey } | null; bond: Pick<Profile, "minBondUnits" | "unbondPeriodS" | "disputeWindowS" | "disputeBlockS"> & { authority: PublicKey } | null };

/** The profile's fields as the two configs hold them now (null for a config that is not initialised). */
export async function readOnchain(conn: Connection, ids: { trellis_credits: PublicKey; trellis_bond: PublicKey }): Promise<Onchain> {
  const [c, b] = await Promise.all([conn.getAccountInfo(creditsPdas(ids.trellis_credits).config, "confirmed"), conn.getAccountInfo(bondPdas(ids.trellis_bond).config, "confirmed")]);
  const credits = c ? decodeCreditsConfig(new Uint8Array(c.data)) : null;
  const bond = b ? decodeBondConfig(new Uint8Array(b.data)) : null;
  return {
    credits: credits ? { authority: credits.authority, refundDelayS: credits.refundDelay, expiryGraceS: credits.expiryGrace } : null,
    bond: bond ? { authority: bond.authority, minBondUnits: bond.minBond, unbondPeriodS: bond.unbondPeriod, disputeWindowS: bond.disputeWindow, disputeBlockS: bond.disputeBlock } : null,
  };
}

export type Difference = { program: Field["program"]; name: keyof Profile; label: string; onchain: bigint; want: bigint; show: Field["show"] };

/** Every field of `profile` the chain holds another value for. */
export function profileDiff(onchain: Onchain, profile: Profile): Difference[] {
  const out: Difference[] = [];
  for (const f of FIELDS) {
    const side = f.program === "trellis_credits" ? onchain.credits : onchain.bond;
    if (!side) continue;
    const have = (side as unknown as Record<string, bigint>)[f.name];
    if (have !== profile[f.name]) out.push({ program: f.program, name: f.name, label: f.label, onchain: have, want: profile[f.name], show: f.show });
  }
  return out;
}

type Ids = { trellis_credits: PublicKey; trellis_bond: PublicKey };
type Change = { program: Field["program"]; /** True when every differing field moves in the safer direction (longer delay, larger bond). */ tightening: boolean; update: TransactionInstruction; propose: TransactionInstruction; resolve: TransactionInstruction; pending: PublicKey };

/** For each program whose config differs from `profile`: the immediate update, and the propose / resolve pair for a change that loosens. */
export function profileChanges(ids: Ids, authority: PublicKey, profile: Profile, diff: Difference[]): Change[] {
  const out: Change[] = [];
  // Every profile field is a delay or a minimum: larger is tighter.
  const tightening = (program: Field["program"]) => diff.filter((d) => d.program === program).every((d) => d.want >= d.onchain);
  if (diff.some((d) => d.program === "trellis_credits")) {
    const a = { authority, refundDelay: profile.refundDelayS, expiryGrace: profile.expiryGraceS };
    out.push({ program: "trellis_credits", tightening: tightening("trellis_credits"), update: creditsUpdateConfigIx(ids.trellis_credits, a), propose: creditsProposeConfigIx(ids.trellis_credits, a), resolve: creditsResolveConfigIx(ids.trellis_credits, { signer: authority, authority, apply: true }), pending: creditsPdas(ids.trellis_credits).pendingConfig });
  }
  if (diff.some((d) => d.program === "trellis_bond")) {
    const a = { authority, minBond: profile.minBondUnits, unbondPeriod: profile.unbondPeriodS, disputeWindow: profile.disputeWindowS, disputeBlock: profile.disputeBlockS };
    out.push({ program: "trellis_bond", tightening: tightening("trellis_bond"), update: bondUpdateConfigIx(ids.trellis_bond, a), propose: bondProposeConfigIx(ids.trellis_bond, a), resolve: bondResolveConfigIx(ids.trellis_bond, { signer: authority, authority, apply: true }), pending: PublicKey.findProgramAddressSync(BOND_SEEDS.pendingConfig, ids.trellis_bond)[0] });
  }
  return out;
}

/** When a pending config change can be applied (unix seconds), or null when none is pending. */
async function pendingEffectiveAt(conn: Connection, c: Change): Promise<bigint | null> {
  const info = await conn.getAccountInfo(c.pending, "confirmed");
  if (!info) return null;
  if (c.program === "trellis_credits") return decodePendingCreditsConfig(new Uint8Array(info.data))?.effectiveAt ?? null;
  return (bondIdl.decodeAccount("PendingConfig", new Uint8Array(info.data)) as { effective_at: bigint } | null)?.effective_at ?? null;
}
const chainTime = async (conn: Connection) => BigInt((await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000));
/** The longest this script waits for a timelock by itself (the devnet build's is 30 s). */
const MAX_WAIT_S = 120n;

const num = (v: bigint) => Number(v);
/** The `parameters` entries of deployments/devnet.json for a profile: what the chain holds once it is applied. */
export function profileParameters(profile: Profile): Record<string, number> {
  return {
    refundDelaySeconds: num(profile.refundDelayS),
    expiryGraceSeconds: num(profile.expiryGraceS),
    bondMinUsdc: num(profile.minBondUnits) / 1e6,
    unbondSeconds: num(profile.unbondPeriodS),
    disputeWindowSeconds: num(profile.disputeWindowS),
    disputeBlockSeconds: num(profile.disputeBlockS),
  };
}

export type ApplyResult = { profile: ProfileName; changed: Difference[]; signatures: Partial<Record<Field["program"], string>>; skipped?: string; /** Programs whose change is proposed and waits out the timelock: when it can be applied. */ pending?: Partial<Record<Field["program"], string>> };

/**
 * Bring the credits and bond configs to `name`, signed by `authority` (the config authority: the deployer on devnet),
 * and record it in deployments/devnet.json. A change that only tightens is applied at once with update_config; one that
 * loosens is proposed, waits the program's timelock and is applied with resolve_config (see the header). Idempotent: a
 * config already at the profile's values is left alone, a change already proposed is applied when its time has come.
 * `dryRun` reports the differences and sends nothing. Never call this against mainnet with "devnet".
 */
export async function applyProfile(conn: Connection, authority: Keypair, ids: Ids, name: ProfileName, o: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<ApplyResult> {
  const log = o.log ?? (() => undefined);
  const profile = PROFILES[name];
  const onchain = await readOnchain(conn, ids);
  const changed = profileDiff(onchain, profile);
  const signatures: ApplyResult["signatures"] = {};
  const pending: NonNullable<ApplyResult["pending"]> = {};
  for (const d of changed) log(`${d.program}: ${d.label} ${d.show(d.onchain)} -> ${d.show(d.want)}`);
  if (o.dryRun) return { profile: name, changed, signatures, ...(changed.length ? { skipped: "dry run" } : {}) };
  const send = (ix: TransactionInstruction) => sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority], { commitment: "confirmed" });
  for (const c of profileChanges(ids, authority.publicKey, profile, changed)) {
    const holder = c.program === "trellis_credits" ? onchain.credits!.authority : onchain.bond!.authority;
    if (!holder.equals(authority.publicKey)) throw new Error(`${c.program}: the config authority is ${holder.toBase58()}, not this key; the config change must be sent by that authority`);
    if (c.tightening) {
      signatures[c.program] = await send(c.update);
      log(`${c.program}: update_config sent (${explorer("tx", signatures[c.program]!)})`);
      continue;
    }
    let effectiveAt = await pendingEffectiveAt(conn, c);
    if (effectiveAt === null) {
      const sig = await send(c.propose);
      log(`${c.program}: propose_config sent (${explorer("tx", sig)})`);
      effectiveAt = await pendingEffectiveAt(conn, c);
      if (effectiveAt === null) throw new Error(`${c.program}: the proposal is not on chain after propose_config`);
    }
    const wait = effectiveAt - (await chainTime(conn));
    if (wait > MAX_WAIT_S) {
      pending[c.program] = new Date(Number(effectiveAt) * 1000).toISOString();
      log(`${c.program}: the change is proposed and can be applied after ${pending[c.program]} (the program's config timelock); run this again then`);
      continue;
    }
    while ((await chainTime(conn)) < effectiveAt) await Bun.sleep(2_000);
    signatures[c.program] = await send(c.resolve);
    log(`${c.program}: resolve_config sent (${explorer("tx", signatures[c.program]!)})`);
  }
  if (Object.keys(pending).length) return { profile: name, changed, signatures, pending, skipped: "waiting for the config timelock" };
  recordProfile(name, signatures);
  return { profile: name, changed, signatures };
}

/** Write the applied profile, the values it sets and the transactions that set them into deployments/devnet.json. */
export function recordProfile(name: ProfileName, signatures: ApplyResult["signatures"] = {}): Deployments {
  const dep = loadDeployments();
  const profile = PROFILES[name];
  const at = new Date().toISOString();
  dep.profile = name;
  // Seconds, as the chain holds them. The hour/day keys older records carried are dropped so nothing reads a stale spec value.
  const { refundDelayHours: _a, expiryGraceDays: _b, unbondDays: _c, disputeWindowHours: _d, disputeBlockDays: _e, ...rest } = (dep.parameters ?? {}) as Record<string, string | number>;
  dep.parameters = { ...rest, ...profileParameters(profile) };
  for (const [program, sig] of Object.entries(signatures)) {
    const cfg = dep.configs?.[program as Field["program"]];
    if (cfg && sig) dep.configs![program as Field["program"]] = { ...cfg, status: "updated", updateSignature: sig, updatedAt: at, note: `config brought to the ${name} profile (scripts/devnet/profile.ts)` };
  }
  if (name === "devnet") {
    const previous = dep.devnetOverrides?.transactions ?? {};
    dep.devnetOverrides = {
      note: "DEVNET ONLY. Short timings and a small minimum bond so closure refunds, slashes and unbonding can be watched in minutes. They are below the floors of the default build and exist only on the devnet build of the programs (cargo feature `devnet`). Mainnet keeps the spec values (specDefaults).",
      values: profileParameters(profile),
      specDefaults: profileParameters(PROFILES.mainnet),
      transactions: { ...previous, ...signatures },
      appliedAt: Object.keys(signatures).length ? at : (dep.devnetOverrides?.appliedAt ?? at),
    };
  } else delete dep.devnetOverrides;
  saveDeployments(dep);
  return dep;
}
