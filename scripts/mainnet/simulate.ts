// Run the whole mainnet procedure on the exact program binaries, in an in-process SVM, before any SOL is spent.
//
//   every binary answers build_profile: profile 0 and the mainnet floors, or it is not the mainnet build
//   -> init (every selected program, the real parameters and role keys)
//   -> the pauses: the guardian pauses, cannot pause again (cooldown) and cannot unpause; the authority renews; 72 hours
//      later the pause has lapsed by itself; the authority clears the flag
//   -> a proposal that is left alone: the guardian cannot cancel it, and after the timelock plus 7 days it can no longer
//      be applied (ProposalExpired); it is cleared and the slot is free again
//   -> the hand-over is proposed -> each pending account's timelock equals what build_profile reported
//   -> resolving early is refused -> resolving without the vault's signature is refused
//   -> the clock is moved past the timelock -> the hand-over resolves with the operator and the vault both signing
//   -> the upgrade authority moves with SetAuthorityChecked -> who holds what is read back
//
// Two things come out of it:
//   1. the build profile of each binary, READ FROM THE BINARY: build_profile returns the profile byte (0 = the default
//      build, 1 = the `devnet` cargo feature) and every floor compiled in. The two builds have the same IDL and nearly
//      the same size, so this is how the preflight refuses a devnet-featured binary whatever directory it came from
//      (security/REREVIEW-2026-10.md RR-04). What the binary then DOES is held against what it said: the pending
//      account of its proposal must carry the same timelock;
//   2. proof that the instruction set of plan.ts (what init.ts, pause.ts and handover.ts send) works end to end on the
//      default build with its real 24 hours, 72 hours and 7 days, which a rehearsal on a local validator cannot wait for.
//
// The SVM is LiteSVM, the same one the Anchor suite runs in (tests/svm.ts). Signature checks are switched off here so
// that the vault (a program-derived address nobody holds a key for) can be named as a signer: the programs still see
// exactly which accounts signed, which is all they check. Nothing leaves this process.
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Account, Clock, LiteSvm } from "litesvm/dist/internal";
import { creditsPdas } from "../../src/solana/programs/credits.ts";
import { programDataAddress } from "../devnet/lib.ts";
import type { ProgramName, Roles } from "./lib.ts";
import { HANDOVER_KIND, MAINNET_GUARDIAN_COOLDOWN_SECONDS, MAINNET_PAUSE_TTL_SECONDS, MAINNET_PROPOSAL_TTL_SECONDS, PAUSABLE, appraiseBuildProfile, buildProfileIx, cancelIx, createLimiterIx, decodePending, describeProfile, initSteps, mayPause, migrateConfigIx, pauseFields, pauseIx, pauseView, pendingAddress, proposalLifecycle, proposeIx, resolveInstructions, resolveIx, returnDataFromLogs, slotProgram, tokenAccounts, tokenAccountsNeeded, type PauseSlot, type PauseView, type Pending, type ProfileKind, type ProfileReading } from "./plan.ts";
import { allRoles, type RoleRow } from "./coverage.ts";
import { configAddress, holders, readChainState, type ChainState } from "./state.ts";

export type Profile = {
  /** config_timelock as build_profile reported it. */
  timelock: number | null;
  profile: ProfileKind;
  how: string;
  /** Why the binary is not the mainnet build (empty for one that is). */
  problems: string[];
  floors: Record<string, bigint>;
};
export type Simulation = {
  ok: boolean;
  /** Everything that did not go as the procedure requires. Empty when ok. */
  problems: string[];
  /** What was done, one line per step. */
  log: string[];
  profiles: Partial<Record<ProgramName, Profile>>;
  /** True when a role key was not set and a throwaway key stood in for it. */
  placeholders: string[];
  /**
   * The chain as the run left it: the state every script reads, every role a config names with the owners of the
   * payout accounts (scripts/mainnet/coverage.ts), and who the operator and the vault were. Absent when the run
   * stopped before init.
   */
  final?: { state: ChainState; roles: RoleRow[]; operator: string; vault: string };
};
export type SimulationInput = {
  /** The selected programs and the binary of each. */
  programs: { name: ProgramName; so: string }[];
  ids: Record<ProgramName, PublicKey>;
  operator: PublicKey;
  roles: Partial<Roles>;
  usdcMint: PublicKey;
  pauseCapacity?: boolean;
  /** Stop after reading the build profiles (nothing is initialised). */
  profileOnly?: boolean;
  /**
   * After init, cut every pausable config back to the layout from before `paused_until` / `guardian_pause_ready_at`
   * and remove the credits limiter, as a deployment made by an earlier build has them; the procedure must then notice
   * and repair them (migrate_config, init_limiter) before it goes on.
   */
  legacyLayout?: boolean;
  /**
   * Hand over only these programs and leave the rest of `programs` deployed, initialised and on the operator key: a
   * tier that was added after the hand-over of an earlier one (security/REVIEW-ROUND3-2026-10.md R3-08). Default: all.
   */
  handOver?: readonly ProgramName[];
};

class SendError extends Error {
  constructor(message: string, readonly logs: string[]) { super(message); }
}

function environment(input: SimulationInput) {
  const svm = new LiteSvm();
  svm.setSigverify(false);
  const c0 = svm.getClock();
  svm.setClock(new Clock(c0.slot, c0.epochStartTimestamp, c0.epoch, c0.leaderScheduleEpoch, BigInt(Math.floor(Date.now() / 1000))));
  // The one real key in here: it pays the fees, so every transaction has a signature of its own.
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey.toBytes(), 1_000_000_000_000n);
  const rent = (bytes: number) => svm.minimumBalanceForRentExemption(BigInt(bytes));
  const put = (address: PublicKey, owner: PublicKey, data: Uint8Array) => svm.setAccount(address.toBytes(), new Account(rent(data.length), data, owner.toBytes(), false, 0n));
  const mint = (address: PublicKey, program: PublicKey, decimals: number) => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: payer.publicKey, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    put(address, program, data);
  };
  const tokenAccount = (address: PublicKey, mintAddress: PublicKey, owner: PublicKey) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({ mint: mintAddress, owner, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    put(address, TOKEN_PROGRAM_ID, data);
  };
  const fund = (k: PublicKey) => void svm.airdrop(k.toBytes(), 100_000_000_000n);
  const setUpgradeAuthority = (programId: PublicKey, authority: PublicKey) => {
    const address = programDataAddress(programId);
    const a = svm.getAccount(address.toBytes());
    if (!a) throw new Error(`no ProgramData account for ${programId.toBase58()}`);
    const data = Uint8Array.from(a.data());
    data[12] = 1;
    data.set(authority.toBytes(), 13);
    svm.setAccount(address.toBytes(), new Account(a.lamports(), data, a.owner(), a.executable(), a.rentEpoch()));
  };
  /** Send instructions; `payer` pays, and every account an instruction marks as a signer counts as having signed. */
  const send = (ixs: TransactionInstruction[]): string[] => {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: svm.latestBlockhash() }).add(...ixs);
    tx.partialSign(payer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = svm.sendLegacyTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    svm.expireBlockhash();
    if (typeof r.err === "function") throw new SendError(String(r.toString()).slice(0, 300), r.meta().logs());
    return r.logs();
  };
  const warp = (seconds: number) => {
    const c = svm.getClock();
    svm.setClock(new Clock(c.slot + BigInt(Math.max(1, Math.ceil(seconds * 2.5))), c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(Math.ceil(seconds))));
    svm.expireBlockhash();
  };
  /** What state.ts reads a chain through. */
  const conn = {
    getAccountInfo: async (k: PublicKey, o?: { dataSlice?: { offset: number; length: number } } | string) => {
      const a = svm.getAccount(k.toBytes());
      if (!a || (a.lamports() === 0n && a.data().length === 0)) return null;
      let data = Buffer.from(a.data());
      const slice = typeof o === "object" ? o?.dataSlice : undefined;
      if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
      return { data, executable: a.executable(), lamports: Number(a.lamports()), owner: new PublicKey(a.owner()), rentEpoch: 0 };
    },
    getSlot: async () => Number(svm.getClock().slot),
  };
  for (const p of input.programs) {
    svm.addProgramFromFile(input.ids[p.name].toBytes(), p.so);
    setUpgradeAuthority(input.ids[p.name], input.operator);
  }
  fund(input.operator);
  const now = () => Number(svm.getClock().unixTimestamp);
  /** Rewrite an account's bytes in place (same owner and lamports), or remove it: for the legacy-layout leg only. */
  const rewrite = (address: PublicKey, change: (data: Uint8Array) => Uint8Array | null) => {
    const a = svm.getAccount(address.toBytes());
    if (!a) throw new Error(`no account at ${address.toBase58()}`);
    const next = change(Uint8Array.from(a.data()));
    svm.setAccount(address.toBytes(), next ? new Account(a.lamports(), next, a.owner(), a.executable(), a.rentEpoch()) : new Account(0n, new Uint8Array(0), PublicKey.default.toBytes(), false, 0n));
  };
  return { svm, send, warp, now, conn, mint, tokenAccount, fund, rewrite, payer: payer.publicKey };
}

const errorName = (e: unknown): string => {
  const logs = e instanceof SendError ? e.logs : [];
  const line = logs.find((l) => /Error Code: \w+/.test(l));
  return line ? /Error Code: (\w+)/.exec(line)![1]! : (e as Error).message.slice(0, 120);
};

/**
 * The procedure on these binaries. Never throws for something the procedure itself got wrong: that comes back in
 * `problems`. Role keys that are not set are replaced by throwaway keys and listed in `placeholders`.
 */
export async function simulateDeployment(input: SimulationInput): Promise<Simulation> {
  const problems: string[] = [], log: string[] = [], profiles: Simulation["profiles"] = {}, placeholders: string[] = [];
  const selected = input.programs.map((p) => p.name);
  const stand = <K extends keyof Roles>(name: K, onCurve = true): Roles[K] => {
    if (input.roles[name] !== undefined) return input.roles[name] as Roles[K];
    placeholders.push(name);
    return (onCurve ? Keypair.generate().publicKey : PublicKey.findProgramAddressSync([Buffer.from("simulated-vault")], TOKEN_PROGRAM_ID)[0]) as Roles[K];
  };
  const vault = stand("multisigVault", false);
  const settlement = stand("settlement");
  const roles: Roles = {
    multisigVault: vault, settlement, guardian: stand("guardian"), anchorer: stand("anchorer"), slasher: stand("slasher"), receiptSigner: stand("receiptSigner"),
    sale: input.roles.sale ?? settlement, hvx: input.roles.hvx ?? vault, trlsMint: stand("trlsMint"), gradePricesUsdc: input.roles.gradePricesUsdc ?? [1, 2, 4],
  };
  if (!input.roles.gradePricesUsdc && selected.includes("trellis_capacity")) placeholders.push("gradePricesUsdc");
  let env: ReturnType<typeof environment>;
  try { env = environment(input); } catch (e) { return { ok: false, problems: [`the binaries could not be loaded: ${(e as Error).message}`], log, profiles, placeholders }; }
  const { send, warp, conn } = env;
  let final: Simulation["final"];
  const done = () => ({ ok: problems.length === 0, problems, log, profiles, placeholders, final });

  // ---- which build is each binary? It says so itself -------------------------------------------------------------------------
  const readings: Partial<Record<ProgramName, ProfileReading>> = {};
  for (const p of selected) {
    let reading: ProfileReading;
    try { reading = appraiseBuildProfile(p, returnDataFromLogs(send([buildProfileIx(p, input.ids[p])]), input.ids[p])); }
    catch (e) { reading = { kind: "unknown", profile: null, timelock: null, floors: {}, problems: [`build_profile failed (${errorName(e)}): the binary predates it or is not ${p}`] }; }
    readings[p] = reading;
    profiles[p] = { timelock: reading.timelock, profile: reading.kind, how: "build_profile", problems: reading.problems, floors: reading.floors };
    log.push(`${p}: build_profile says ${describeProfile(reading)}: timelock ${reading.timelock ?? "?"} s (${reading.kind} build)`);
    if (reading.kind === "unknown") problems.push(`${p}: ${reading.problems.join("; ")}`);
  }
  if (input.profileOnly) return done();
  const floor = (p: ProgramName, name: string, fallback: number) => Number(readings[p]?.floors[name] ?? fallback);

  const accounts = await tokenAccounts(input.operator, input.usdcMint, vault);
  env.mint(input.usdcMint, TOKEN_PROGRAM_ID, 6);
  if (selected.includes("trellis_fee_router")) env.mint(roles.trlsMint, TOKEN_2022_PROGRAM_ID, 9);
  for (const name of tokenAccountsNeeded(selected)) env.tokenAccount(accounts[name], input.usdcMint, vault);
  env.fund(vault);
  env.fund(roles.anchorer);
  const ctx = { ids: input.ids, programs: selected, operator: input.operator, roles, usdcMint: input.usdcMint, accounts, pauseCapacity: input.pauseCapacity };
  const read = () => readChainState(conn as never, Object.fromEntries(selected.map((p) => [p, input.ids[p]])) as Partial<Record<ProgramName, PublicKey>>) as Promise<ChainState>;
  const pending = async (p: ProgramName): Promise<Pending | null> => { const info = await conn.getAccountInfo(pendingAddress(p, input.ids[p])); return info ? decodePending(p, info.data) : null; };
  /** Send and require a refusal; `want` names the program error it must be (any refusal when omitted). */
  const refused = (what: string, ixs: TransactionInstruction[], want?: string): boolean => {
    try { send(ixs); problems.push(`${what} was ACCEPTED`); return false; }
    catch (e) { if (want && errorName(e) !== want) { problems.push(`${what} failed with ${errorName(e)}, expected ${want}`); return false; } return true; }
  };

  // ---- init ----------------------------------------------------------------------------------------------------------------
  for (const s of initSteps(ctx)) {
    try { send(s.build()); log.push(`init ${s.program}: ${s.what}`); } catch (e) { problems.push(`init of ${s.program} failed: ${errorName(e)}`); }
  }
  let state = await read();

  // ---- a deployment from before the current layout is noticed and repaired ------------------------------------------------------
  if (input.legacyLayout) {
    const old = PAUSABLE.filter((p) => selected.includes(p) && state.configs[p]);
    for (const p of old) env.rewrite(configAddress(p, input.ids[p]), (d) => d.subarray(0, d.length - 16));
    if (old.includes("trellis_credits")) env.rewrite(creditsPdas(input.ids.trellis_credits).limiter, () => null);
    state = await read();
    for (const p of old) if (!state.legacy.includes(p) || state.configs[p]) problems.push(`${p}: a config in the earlier layout was not reported as legacy`);
    if (old.includes("trellis_credits") && state.limiter) problems.push("trellis_credits: the limiter is reported although its account is gone");
    for (const p of state.legacy) {
      try { send([migrateConfigIx(p, input.ids[p], env.payer)!]); } catch (e) { problems.push(`${p}: migrate_config failed: ${errorName(e)}`); continue; }
      refused(`${p}: a second migrate_config`, [migrateConfigIx(p, input.ids[p], env.payer)!], "AlreadyMigrated");
    }
    if (old.includes("trellis_credits")) { try { send([createLimiterIx(input.ids.trellis_credits, env.payer)]); } catch (e) { problems.push(`trellis_credits: init_limiter failed: ${errorName(e)}`); } }
    state = await read();
    if (state.legacy.length) problems.push(`still in the earlier layout after migrate_config: ${state.legacy.join(", ")}`);
    log.push(`earlier layout: ${old.join(", ") || "nothing"} reported as legacy, grown with migrate_config${old.includes("trellis_credits") ? "; the limiter recreated with init_limiter" : ""}`);
  }
  for (const p of selected) if (!state.configs[p]) problems.push(`${p}: no config after init`);
  if (selected.includes("trellis_credits") && state.configs.trellis_credits && !state.limiter) problems.push("trellis_credits: no outflow limiter at [\"limiter_v2\"] after init");
  for (const h of holders(state)) {
    const want = h.role === "upgrade" ? input.operator : h.role === "guardian" ? roles.guardian : h.role === "authority" ? (h.program === "trellis_anchor" ? roles.anchorer : input.operator) : null;
    if (want && h.address !== want.toBase58()) problems.push(`${h.program}: after init the ${h.role} is ${h.address}, expected ${want.toBase58()}`);
  }

  // ---- the pauses: 72 hours and no longer, the guardian once, the authority as often as it likes -----------------------------
  const views = async (): Promise<Map<PauseSlot, PauseView>> => {
    const s = await read();
    return new Map(pauseFields(s.configs, s.limiter).map((f) => [f.slot, pauseView(f, env.now(), floor(slotProgram(f.slot), "guardianPauseCooldown", MAINNET_GUARDIAN_COOLDOWN_SECONDS))]));
  };
  const slots = [...(await views()).keys()];
  if (slots.length) {
    const id = (slot: PauseSlot) => input.ids[slotProgram(slot)];
    const ttl = (slot: PauseSlot) => floor(slotProgram(slot), "pauseTtl", MAINNET_PAUSE_TTL_SECONDS);
    for (const [slot, v] of await views()) if (v.flag || v.active || v.guardianInCooldown) problems.push(`${slot}: paused or in cooldown straight after init`);
    const t0 = env.now();
    for (const slot of slots) { try { send([pauseIx(slot, id(slot), { signer: roles.guardian, paused: true })]); } catch (e) { problems.push(`${slot}: the guardian could not pause: ${errorName(e)}`); } }
    for (const [slot, v] of await views()) {
      if (!v.active || v.until !== t0 + ttl(slot)) problems.push(`${slot}: after the guardian's pause it is ${v.active ? "active" : "not active"} until ${v.until}, expected ${t0 + ttl(slot)}`);
      if (v.by !== "guardian") problems.push(`${slot}: the guardian's pause reads as set by ${v.by}`);
      if (mayPause(v, "guardian").ok) problems.push(`${slot}: the kit would let the guardian pause again inside its cooldown`);
      refused(`${slot}: a second pause by the guardian inside its cooldown`, [pauseIx(slot, id(slot), { signer: roles.guardian, paused: true })], "GuardianCooldown");
      refused(`${slot}: an unpause by the guardian`, [pauseIx(slot, id(slot), { signer: roles.guardian, paused: false })]);
    }
    // The authority renews: another full term from now, whatever the guardian's cooldown says.
    warp(600);
    const t1 = env.now();
    for (const slot of slots) { try { send([pauseIx(slot, id(slot), { signer: input.operator, paused: true })]); } catch (e) { problems.push(`${slot}: the authority could not renew the pause: ${errorName(e)}`); } }
    for (const [slot, v] of await views()) {
      if (!v.active || v.until !== t1 + ttl(slot)) problems.push(`${slot}: after the authority's renewal the pause runs until ${v.until}, expected ${t1 + ttl(slot)}`);
      if (v.by !== "authority") problems.push(`${slot}: the authority's renewal reads as set by ${v.by}`);
    }
    // Nobody renews: the pause lapses by itself, with the flag still up.
    warp(Math.max(...slots.map(ttl)) + 1);
    for (const [slot, v] of await views()) if (v.active || !v.lapsed) problems.push(`${slot}: ${ttl(slot)} s after the last renewal the pause is ${v.active ? "still in force" : "not reported as lapsed"}`);
    for (const slot of slots) { try { send([pauseIx(slot, id(slot), { signer: input.operator, paused: false })]); } catch (e) { problems.push(`${slot}: the authority could not clear the lapsed pause: ${errorName(e)}`); } }
    for (const [slot, v] of await views()) if (v.flag) problems.push(`${slot}: the flag is still set after the authority's unpause`);
    log.push(`pauses (${slots.join(", ")}): the guardian pauses once and is refused a second time (GuardianCooldown) and an unpause; the authority renews; the pause lapses by itself after its term; the authority clears the flag`);
  }

  // ---- a proposal nobody resolves: the guardian cannot cancel it, and once expired it cannot be applied -------------------------
  const handing = selected.filter((p) => HANDOVER_KIND[p] !== "none" && state.configs[p]);
  const timelockOf = (p: ProgramName) => readings[p]?.timelock ?? 0;
  const ttlOf = (p: ProgramName) => floor(p, "proposalTtl", MAINNET_PROPOSAL_TTL_SECONDS);
  const stranger = Keypair.generate().publicKey;
  const stale: ProgramName[] = [];
  for (const p of handing) {
    try { send([proposeIx(p, input.ids[p], { operator: input.operator, vault })!]); stale.push(p); } catch (e) { problems.push(`${p}: the hand-over could not be proposed: ${errorName(e)}`); }
  }
  for (const p of stale) {
    for (const [who, key] of [["the guardian", roles.guardian], ["a stranger", stranger]] as const) {
      const ix = cancelIx(p, input.ids[p], { operator: input.operator, signer: key });
      if (ix) refused(`${p}: a cancellation of a live proposal by ${who}`, [ix], "Unauthorized");
    }
  }
  if (stale.length) {
    warp(Math.max(...stale.map((p) => timelockOf(p) + ttlOf(p))) + 2);
    for (const p of stale) {
      const x = await pending(p);
      if (!x || proposalLifecycle(x, env.now(), ttlOf(p)).state !== "expired") problems.push(`${p}: ${ttlOf(p)} s after it became effective the proposal does not read as expired`);
      refused(`${p}: applying an expired proposal`, resolveInstructions(p, input.ids[p], { operator: input.operator, vault, config: true, upgrade: false }), "ProposalExpired");
      // Clearing it: anyone for the five config programs, the authority for the fee router and the registry.
      const byAnyone = cancelIx(p, input.ids[p], { operator: input.operator, signer: stranger });
      try { send([byAnyone ?? cancelIx(p, input.ids[p], { operator: input.operator })!]); } catch (e) { problems.push(`${p}: the expired proposal could not be cleared: ${errorName(e)}`); }
      if (await pending(p)) problems.push(`${p}: the expired proposal is still there after it was cleared`);
    }
    log.push("a proposal left alone: the guardian and a stranger cannot cancel it (Unauthorized); past its expiry it cannot be applied (ProposalExpired) and is cleared");
  }

  // ---- the hand-over is proposed; what each binary does is held against what it said ----------------------------------------------
  const proposed: ProgramName[] = [];
  /** Whether this run hands `p` over; the rest stay on the operator key (a tier added after an earlier hand-over). */
  const over = (p: ProgramName) => !input.handOver || input.handOver.includes(p);
  for (const p of handing.filter(over)) {
    try {
      send([proposeIx(p, input.ids[p], { operator: input.operator, vault })!]);
      const x = await pending(p);
      if (!x) { problems.push(`${p}: the proposal left no pending account`); continue; }
      if (x.newAuthority !== vault.toBase58()) problems.push(`${p}: the proposal names ${x.newAuthority}, not the vault`);
      if (x.other.length || x.guardian) problems.push(`${p}: the hand-over proposal also changes ${[...(x.guardian ? ["guardian"] : []), ...x.other].join(", ")}`);
      if (x.timelock !== timelockOf(p)) problems.push(`${p}: build_profile says the timelock is ${timelockOf(p)} s, but its proposal becomes effective after ${x.timelock} s`);
      proposed.push(p);
      log.push(`${p}: hand-over proposed; the pending account's timelock is ${x.timelock} s, as build_profile said`);
    } catch (e) { problems.push(`${p}: the hand-over could not be proposed: ${errorName(e)}`); }
  }

  // ---- too early, and without the vault: both refused ---------------------------------------------------------------------------
  warp(20);
  for (const p of proposed) refused(`${p}: resolving the hand-over 20 seconds after it was proposed`, resolveInstructions(p, input.ids[p], { operator: input.operator, vault, config: true, upgrade: true }), "TimelockNotElapsed");
  warp(Math.max(0, ...proposed.map(timelockOf)));
  for (const p of proposed) {
    if (HANDOVER_KIND[p] === "transfer") continue; // the new authority alone accepts there: nothing to leave out
    // The same instruction with the vault NOT marked as a signer: the new authority has not accepted.
    const ix = resolveIx(p, input.ids[p], { operator: input.operator, vault })!;
    for (const k of ix.keys) if (k.pubkey.equals(vault)) k.isSigner = false;
    refused(`${p}: resolving the hand-over without the vault's signature`, [ix]);
  }
  log.push(`resolving early is refused (TimelockNotElapsed); resolving without the vault's signature is refused`);

  // ---- after the timelock and inside the expiry: the operator and the vault resolve together, the upgrade authority follows ---
  for (const p of selected.filter(over)) {
    const config = proposed.includes(p);
    try { send(resolveInstructions(p, input.ids[p], { operator: input.operator, vault, config, upgrade: true })); log.push(`${p}: ${config ? "hand-over resolved (operator + vault), " : ""}upgrade authority moved with SetAuthorityChecked`); }
    catch (e) { problems.push(`${p}: resolving the hand-over after the timelock failed: ${errorName(e)}`); }
  }
  state = await read();
  final = { state, roles: await allRoles(conn as never, state), operator: input.operator.toBase58(), vault: vault.toBase58() };
  for (const h of holders(state).filter((x) => over(x.program))) {
    const want = h.role === "upgrade" || (h.role === "authority" && h.program !== "trellis_anchor") ? vault : h.role === "guardian" ? roles.guardian : h.role === "authority" ? roles.anchorer : null;
    if (want && h.address !== want.toBase58()) problems.push(`${h.program}: after the hand-over the ${h.role} is ${h.address}, expected ${want.toBase58()}`);
    if (h.address === input.operator.toBase58()) problems.push(`${h.program}: the operator key still holds ${h.role}`);
  }
  for (const p of handing.filter(over)) if (await pending(p)) problems.push(`${p}: a pending proposal is left after the hand-over`);
  // The old authority is out: it can no longer pause, and the guardian's key did not change hands.
  for (const slot of slots.filter((x) => over(slotProgram(x)))) refused(`${slot}: a pause by the operator key after the hand-over`, [pauseIx(slot, input.ids[slotProgram(slot)], { signer: input.operator, paused: true })]);
  return done();
}
