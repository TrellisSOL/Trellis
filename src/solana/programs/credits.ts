import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { IdlProgram, le64, programDataAddress, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_credits.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

// trellis_credits (docs/Trellis_Backend.md §5.1), built from src/solana/idl/trellis_credits.json. Spend-only USDC
// credits per API key:
//   deposit(key_hash, amount)                      anyone's USDC token account -> vault; CreditAccount{key_hash, balance,
//                                                  expires_at}. A depositor gains nothing over the key.
//   commit_spent_root(hour, root, spent_delta)     one SpentRoot per hour (unix seconds, multiple of 3600, not in the
//                                                  future; hours strictly increase); config.spent_total += spent_delta,
//                                                  and committed-but-unsettled spend never exceeds the vault
//                                                  also DepositorShare{depositor, deposited, refunded, refund_to}: what
//                                                  this wallet put into this key and where it wants it back (by default
//                                                  the token account it paid from)
//   close_account(key_hash)                        signed by the KEY ITSELF (the ed25519 keypair derived from the API
//                                                  key; key_hash = sha256(its public key)) plus any fee payer: balance
//                                                  -> 0, closed, RefundRequest{amount, payable_at}. The key names NO
//                                                  destination (security re-review RR-05)
//   close_account_by_owner(key_hash)               the same closure, asked for by the key's registered owner wallet
//                                                  without the key (CreditAccount.authority, registered with the key's
//                                                  AND the wallet's signature; the key alone cannot change it)
//   cancel_close(key_hash)                         whoever asked for the closure, or the owner wallet, takes it back
//                                                  while nothing has been paid; the key at most once per 60 days
//                                                  (CloseGuard), and never a closure the owner asked for. A depositor
//                                                  has no say over a closure (security review round 3, R3-06)
//   set_refund_destination(key_hash)               a depositor (its wallet signs) names another USDC token account for
//                                                  its own refunds from this key
//   pay_refund(amount)                             settlement authority, after the request's payable_at: vault -> one
//                                                  depositor's refund_to, at most what that depositor put in, cumulative,
//                                                  never more than the request, within the refund allowance
//   settle_to_host(amount, hour_root_ref)          settlement authority, bounded by spent_total - settled_total and by
//                                                  the SettleLimiter's settlement allowance: over ANY 24h a share of the
//                                                  LOWEST vault balance of the last 24h (a fresh deposit does not count)
//                                                  and never more than cap_per_window (R3-07)
//   update_config / propose_config / resolve_config   tightening is immediate; loosening waits a 24h timelock and
//                                                  expires 7 days after it; only the authority cancels
// There is no withdraw instruction. PDA seeds: ["config"], ["vault"], ["limiter_v2"], ["pending_config"],
// ["credit", key_hash], ["share", key_hash, depositor], ["spent_root", hour LE], ["refund", key_hash],
// ["close_guard", key_hash]. A deposit is at least MIN_DEPOSIT_UNITS; the per-key cap is at most MAX_BALANCE_PER_KEY_LIMIT_UNITS.

export const CREDITS_IDL = idl as unknown as TrellisIdl;
export const creditsIdl = new IdlProgram(CREDITS_IDL);
export const creditsAt = (programId: PublicKey | string) => creditsIdl.at(programId);

export const SEEDS = {
  config: [Buffer.from("config")],
  vault: [Buffer.from("vault")],
  credit: (keyHash: Uint8Array) => [Buffer.from("credit"), Buffer.from(keyHash)],
  spentRoot: (hour: bigint | number) => [Buffer.from("spent_root"), le64(hour)],
  refund: (keyHash: Uint8Array) => [Buffer.from("refund"), Buffer.from(keyHash)],
  limiter: [Buffer.from("limiter_v2")],
  share: (keyHash: Uint8Array, depositor: PublicKey) => [Buffer.from("share"), Buffer.from(keyHash), depositor.toBuffer()],
  pendingConfig: [Buffer.from("pending_config")],
  closeGuard: (keyHash: Uint8Array) => [Buffer.from("close_guard"), Buffer.from(keyHash)],
};

/** Compiled into the program (constants.rs): the smallest deposit (1 USDC) and the highest per-key cap any key can set (5,000 USDC). */
export const MIN_DEPOSIT_UNITS = 1_000_000n;
export const MAX_BALANCE_PER_KEY_LIMIT_UNITS = 5_000_000_000n;
/** The absolute outflow bound per window a new limiter starts with (25,000 USDC for each allowance). */
export const DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS = 25_000_000_000n;
/** How long the key itself must wait after cancelling a closure before it can cancel another (60 days; 600 s on the devnet build). */
export const KEY_CANCEL_COOLDOWN_SECONDS = 60 * 24 * 3600;
export const closeGuardPda = (programId: PublicKey, keyHash: Uint8Array) => PublicKey.findProgramAddressSync(SEEDS.closeGuard(keyHash), programId)[0];

export const SECONDS_PER_HOUR = 3600n;
/** The on-chain `hour` of a unix time: seconds, floored to the hour (the program requires a multiple of 3600). */
export const hourOf = (unixSeconds: number | bigint) => (BigInt(unixSeconds) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

export function creditsPdas(programId: PublicKey, keyHash?: Uint8Array) {
  const [config] = PublicKey.findProgramAddressSync(SEEDS.config, programId);
  const [vault] = PublicKey.findProgramAddressSync(SEEDS.vault, programId);
  const credit = keyHash ? PublicKey.findProgramAddressSync(SEEDS.credit(keyHash), programId)[0] : null;
  const refundRequest = keyHash ? PublicKey.findProgramAddressSync(SEEDS.refund(keyHash), programId)[0] : null;
  const [limiter] = PublicKey.findProgramAddressSync(SEEDS.limiter, programId);
  const [pendingConfig] = PublicKey.findProgramAddressSync(SEEDS.pendingConfig, programId);
  return { config, vault, credit, refundRequest, limiter, pendingConfig };
}
/** The DepositorShare of one wallet in one key: what it deposited there and where its refunds go. */
export const sharePda = (programId: PublicKey, keyHash: Uint8Array, depositor: PublicKey) => PublicKey.findProgramAddressSync(SEEDS.share(keyHash, depositor), programId)[0];
export const spentRootPda = (programId: PublicKey, hour: bigint | number) => PublicKey.findProgramAddressSync(SEEDS.spentRoot(hour), programId)[0];

// ---- Accounts --------------------------------------------------------------------------------------------------------

export type CreditsConfig = { authority: PublicKey; settlementAuthority: PublicKey; guardian: PublicKey; usdcMint: PublicKey; vault: PublicKey; treasuryTokenAccount: PublicKey; maxBalancePerKey: bigint; creditTtl: bigint; refundDelay: bigint; expiryGrace: bigint; spentTotal: bigint; settledTotal: bigint; latestHour: bigint; depositsPaused: boolean; depositsPausedUntil: bigint; depositsGuardianReadyAt: bigint };
export function decodeCreditsConfig(data: Uint8Array): CreditsConfig | null {
  const r = creditsIdl.decodeAccount<Raw>("CreditsConfig", data);
  if (!r) return null;
  return { authority: r.authority, settlementAuthority: r.settlement_authority, guardian: r.guardian, usdcMint: r.usdc_mint, vault: r.vault, treasuryTokenAccount: r.treasury_token_account, maxBalancePerKey: r.max_balance_per_key, creditTtl: r.credit_ttl, refundDelay: r.refund_delay, expiryGrace: r.expiry_grace, spentTotal: r.spent_total, settledTotal: r.settled_total, latestHour: r.latest_hour, depositsPaused: r.deposits_paused, depositsPausedUntil: r.deposits_paused_until, depositsGuardianReadyAt: r.deposits_guardian_ready_at };
}

export type CreditAccount = { keyHash: Uint8Array; authority: PublicKey; balance: bigint; depositedTotal: bigint; expiresAt: bigint; expiryNoticeAt: bigint; closed: boolean };
export function decodeCreditAccount(data: Uint8Array): CreditAccount | null {
  const r = creditsIdl.decodeAccount<Raw>("CreditAccount", data);
  if (!r) return null;
  return { keyHash: r.key_hash, authority: r.authority, balance: r.balance, depositedTotal: r.deposited_total, expiresAt: r.expires_at, expiryNoticeAt: r.expiry_notice_at, closed: r.closed };
}

export type SpentRoot = { hour: bigint; root: Uint8Array; spentDelta: bigint; cumulativeSpent: bigint; committedAt: bigint };
export function decodeSpentRoot(data: Uint8Array): SpentRoot | null {
  const r = creditsIdl.decodeAccount<Raw>("SpentRoot", data);
  if (!r) return null;
  return { hour: r.hour, root: r.root, spentDelta: r.spent_delta, cumulativeSpent: r.cumulative_spent, committedAt: r.committed_at };
}

/** A queued closure refund. It names no destination: refunds return to the key's depositors (DepositorShare). */
export type RefundRequest = { keyHash: Uint8Array; amount: bigint; requestedAt: bigint; payableAt: bigint; paidAmount: bigint; paid: boolean; rentPayer: PublicKey; /** Who asked for the closure: the key's own address or its owner wallet. Only that party or the owner can cancel. */ requestedBy: PublicKey };
export function decodeRefundRequest(data: Uint8Array): RefundRequest | null {
  // A request written before `requested_by` existed is 32 bytes short. The program can no longer cancel or pay it; the
  // router still reads it (a paid closure of that time is history it must recognise), with no requester on record.
  const full = creditsIdl.accountSize("RefundRequest");
  if (data.length === full - 32) { const padded = new Uint8Array(full); padded.set(data); data = padded; }
  const r = creditsIdl.decodeAccount<Raw>("RefundRequest", data);
  if (!r) return null;
  return { keyHash: r.key_hash, amount: r.amount, requestedAt: r.requested_at, payableAt: r.payable_at, paidAmount: r.paid_amount, paid: r.paid, rentPayer: r.rent_payer, requestedBy: r.requested_by };
}

/** When the key itself may next cancel a closure (created by its first cancel; absent means "now"). */
export type CloseGuard = { keyHash: Uint8Array; keyCancelBlockedUntil: bigint };
export function decodeCloseGuard(data: Uint8Array): CloseGuard | null {
  const r = creditsIdl.decodeAccount<Raw>("CloseGuard", data);
  if (!r) return null;
  return { keyHash: r.key_hash, keyCancelBlockedUntil: r.key_cancel_blocked_until };
}

/** What one wallet deposited to one key, what of it was refunded, and the USDC token account its refunds are paid to. */
export type DepositorShare = { keyHash: Uint8Array; depositor: PublicKey; refundTo: PublicKey; deposited: bigint; refunded: bigint; lastDepositAt: bigint };
export function decodeDepositorShare(data: Uint8Array): DepositorShare | null {
  const r = creditsIdl.decodeAccount<Raw>("DepositorShare", data);
  if (!r) return null;
  return { keyHash: r.key_hash, depositor: r.depositor, refundTo: r.refund_to, deposited: r.deposited, refunded: r.refunded, lastDepositAt: r.last_deposit_at };
}

/**
 * The outflow limiter: two independent, continuously refilled allowances (host settlements, closure refunds). Over ANY
 * 24h each pays at most the window's cap, and at most a quarter of that at one moment. The cap is `rateBps` of the
 * LOWEST balance the vault has had over the last window (so a deposit counts only after a full window in the vault),
 * never more than `capPerWindow` and never less than 1,000 USDC. `paused` (in force until `pausedUntil`) stops the
 * settlement outflows, never refunds.
 */
export type SettleLimiter = { rateBps: number; settleAllowance: bigint; settleRefilledAt: bigint; baseCur: bigint; refundAllowance: bigint; refundRefilledAt: bigint; basePrev: bigint; paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint; baseEpoch: bigint; lastVault: bigint; capPerWindow: bigint };
export function decodeSettleLimiter(data: Uint8Array): SettleLimiter | null {
  const r = creditsIdl.decodeAccount<Raw>("SettleLimiter", data);
  if (!r) return null;
  return { rateBps: r.rate_bps, settleAllowance: r.settle_allowance, settleRefilledAt: r.settle_refilled_at, baseCur: r.base_cur, refundAllowance: r.refund_allowance, refundRefilledAt: r.refund_refilled_at, basePrev: r.base_prev, paused: r.paused, pausedUntil: r.paused_until, guardianPauseReadyAt: r.guardian_pause_ready_at, baseEpoch: r.base_epoch, lastVault: r.last_vault, capPerWindow: r.cap_per_window };
}

// The limiter's arithmetic, as the program does it (programs/trellis_credits/src/state.rs `roll_base`, `window_cap`,
// `refill_allowance`): the settlement job reads the account and knows what a pay_refund or settle_to_host may move now.
export const SETTLE_WINDOW_FLOOR_UNITS = 1_000_000_000n;
export const SETTLE_BURST_BPS = 2_500n;
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
/** The cap of one window for a base of `base`: `rateBps` of it, at most `capPerWindow`, never less than the floor. */
export const settleWindowCap = (base: bigint, rateBps: number, capPerWindow: bigint = DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS) => { const share = minBig((base * BigInt(rateBps)) / 10_000n, capPerWindow); return share > SETTLE_WINDOW_FLOOR_UNITS ? share : SETTLE_WINDOW_FLOOR_UNITS; };
/**
 * The base the program would compute at `now` for a vault holding `vaultNow` (`SettleLimiter::roll_base`, without
 * writing): the lowest balance recorded over the current and the previous epoch of `windowSeconds`, and the balance now.
 */
export function limiterBase(l: Pick<SettleLimiter, "baseCur" | "basePrev" | "baseEpoch" | "lastVault">, vaultNow: bigint, now: bigint | number, windowSeconds = 86_400): bigint {
  const t = BigInt(now) < 0n ? 0n : BigInt(now);
  const epoch = t / BigInt(windowSeconds);
  let cur = l.baseCur, prev = l.basePrev;
  if (epoch !== l.baseEpoch) { prev = epoch === l.baseEpoch + 1n ? l.baseCur : l.lastVault; cur = l.lastVault; }
  return minBig(prev, minBig(cur, vaultNow));
}
/**
 * What one allowance holds at `now` (unix seconds). `windowSeconds` is the program's SETTLE_WINDOW: 86,400 on the
 * default build (60 on the devnet build; read it from build_profile when it matters).
 */
export function allowanceNow(l: SettleLimiter, which: "settle" | "refund", vaultNow: bigint, now: bigint | number, windowSeconds = 86_400): bigint {
  const allowance = which === "settle" ? l.settleAllowance : l.refundAllowance;
  const refilledAt = which === "settle" ? l.settleRefilledAt : l.refundRefilledAt;
  const cap = settleWindowCap(limiterBase(l, vaultNow, now, windowSeconds), l.rateBps, l.capPerWindow);
  const burst = (cap * SETTLE_BURST_BPS) / 10_000n;
  if (refilledAt === 0n) return burst;
  let elapsed = BigInt(now) - refilledAt;
  if (elapsed < 0n) elapsed = 0n;
  if (elapsed > BigInt(windowSeconds)) elapsed = BigInt(windowSeconds);
  const next = allowance + ((cap - burst) * elapsed) / BigInt(windowSeconds);
  return next < burst ? next : burst;
}
/** A config change waiting out the timelock (propose_config). */
export type PendingCreditsConfig = { proposedAt: bigint; effectiveAt: bigint; newTreasury: PublicKey | null; params: Raw };
export function decodePendingCreditsConfig(data: Uint8Array): PendingCreditsConfig | null {
  const r = creditsIdl.decodeAccount<Raw>("PendingConfig", data);
  if (!r) return null;
  return { proposedAt: r.proposed_at, effectiveAt: r.effective_at, newTreasury: r.new_treasury ?? null, params: r.params };
}

// ---- Events ----------------------------------------------------------------------------------------------------------
// Every helper takes the program id the router is configured with (it differs per cluster) and returns only the events
// that program itself emitted: a `Program data:` line another program logged is not a trellis_credits event (TR-01).

export type DepositedEvent = { keyHash: Uint8Array; depositor: PublicKey; amount: bigint; newBalance: bigint; expiresAt: bigint };
export const depositedEvents = (programId: PublicKey | string, logs: readonly string[]): DepositedEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("Deposited", logs).map((e) => ({ keyHash: e.key_hash, depositor: e.depositor, amount: e.amount, newBalance: e.new_balance, expiresAt: e.expires_at }));

export type RefundPaidEvent = { keyHash: Uint8Array; amount: bigint; refundTo: PublicKey; depositor: PublicKey };
export const refundPaidEvents = (programId: PublicKey | string, logs: readonly string[]): RefundPaidEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("RefundPaid", logs).map((e) => ({ keyHash: e.key_hash, amount: e.amount, refundTo: e.refund_to, depositor: e.depositor }));

export type SpentRootCommittedEvent = { hour: bigint; root: Uint8Array; spentDelta: bigint; spentTotal: bigint };
export const spentRootCommittedEvents = (programId: PublicKey | string, logs: readonly string[]): SpentRootCommittedEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("SpentRootCommitted", logs).map((e) => ({ hour: e.hour, root: e.root, spentDelta: e.spent_delta, spentTotal: e.spent_total }));

export type CloseRequestedEvent = { keyHash: Uint8Array; amount: bigint; requestedAt: bigint; payableAt: bigint };
export const closeRequestedEvents = (programId: PublicKey | string, logs: readonly string[]): CloseRequestedEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("CloseRequested", logs).map((e) => ({ keyHash: e.key_hash, amount: e.amount, requestedAt: e.requested_at, payableAt: e.payable_at }));
export type CloseCancelledEvent = { keyHash: Uint8Array; amount: bigint; by: PublicKey };
/** `CloseCancelled` (cancel_close): a queued closure was taken back; the key is open again with its balance. */
export const closeCancelledEvents = (programId: PublicKey | string, logs: readonly string[]): CloseCancelledEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("CloseCancelled", logs).map((e) => ({ keyHash: e.key_hash, amount: e.amount, by: e.by }));
export type SettledToHostEvent = { hostTokenAccount: PublicKey; amount: bigint; hourRootRef: bigint; settledTotal: bigint };
/** `SettledToHost` (settle_to_host): USDC that left the vault for a host's (or the fee router's) token account. */
export const settledToHostEvents = (programId: PublicKey | string, logs: readonly string[]): SettledToHostEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("SettledToHost", logs).map((e) => ({ hostTokenAccount: e.host_token_account, amount: e.amount, hourRootRef: e.hour_root_ref, settledTotal: e.settled_total }));
export type ExpiredSweptEvent = { keyHash: Uint8Array; amount: bigint };
/** `ExpiredSwept` (sweep_expired): the expired balance that moved from the vault to the treasury. */
export const expiredSweptEvents = (programId: PublicKey | string, logs: readonly string[]): ExpiredSweptEvent[] => creditsIdl.at(programId).eventsNamed<Raw>("ExpiredSwept", logs).map((e) => ({ keyHash: e.key_hash, amount: e.amount }));

// ---- Instructions ----------------------------------------------------------------------------------------------------

export type CreditsConfigChange = { newAuthority?: PublicKey | null; settlementAuthority?: PublicKey | null; guardian?: PublicKey | null; maxBalancePerKey?: bigint | null; creditTtl?: bigint | null; refundDelay?: bigint | null; expiryGrace?: bigint | null; settleRateBps?: number | null; writeDownSpent?: boolean; /** The absolute outflow bound per window (each allowance): lowering is immediate, raising waits the timelock; never below 1,000 USDC. */ outflowCapPerWindow?: bigint | null };
const configParams = (a: CreditsConfigChange) => ({ new_authority: a.newAuthority ?? null, settlement_authority: a.settlementAuthority ?? null, guardian: a.guardian ?? null, max_balance_per_key: a.maxBalancePerKey ?? null, credit_ttl: a.creditTtl ?? null, refund_delay: a.refundDelay ?? null, expiry_grace: a.expiryGrace ?? null, settle_rate_bps: a.settleRateBps ?? null, write_down_spent: a.writeDownSpent ?? false, outflow_cap_per_window: a.outflowCapPerWindow ?? null });

/**
 * init_config(params): creates the config, the vault (a token account owned by the config PDA) and the outflow limiter.
 * `authority` must be the program's upgrade authority (TR-13). Timings default to the spec (365 d, 72 h, 30 d); a value
 * below the program's floors is refused.
 */
export function initConfigIx(programId: PublicKey, a: { authority: PublicKey; usdcMint: PublicKey; treasuryTokenAccount: PublicKey; settlementAuthority: PublicKey; guardian: PublicKey; maxBalancePerKey?: bigint; creditTtl?: bigint | null; refundDelay?: bigint | null; expiryGrace?: bigint | null }): TransactionInstruction {
  return creditsAt(programId).instruction("init_config", { params: { settlement_authority: a.settlementAuthority, guardian: a.guardian, max_balance_per_key: a.maxBalancePerKey ?? 0n, credit_ttl: a.creditTtl ?? null, refund_delay: a.refundDelay ?? null, expiry_grace: a.expiryGrace ?? null } }, { authority: a.authority, usdc_mint: a.usdcMint, treasury_token_account: a.treasuryTokenAccount, program_data: programDataAddress(programId), token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId });
}

/** migrate_config(): grows a config created before the pause-expiry fields existed to the current layout. Anyone may pay; works once. */
export function migrateConfigIx(programId: PublicKey, a: { payer: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("migrate_config", {}, { payer: a.payer, system_program: SystemProgram.programId });
}

/** migrate_limiter(): grows a limiter created before the base tracker and the absolute cap existed (R3-07). Anyone may pay; works once. */
export function migrateLimiterIx(programId: PublicKey, a: { payer: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("migrate_limiter", {}, { payer: a.payer, system_program: SystemProgram.programId });
}

/** init_limiter(): creates the outflow limiter for a config initialised before it existed. Anyone may pay. */
export function initLimiterIx(programId: PublicKey, a: { payer: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("init_limiter", {}, { payer: a.payer, system_program: SystemProgram.programId });
}

/**
 * update_config(params) by the admin authority: TIGHTENING ONLY, effective at once (a lower per-key cap, a longer
 * lifetime / refund delay / expiry grace, a lower settlement rate). Anything else is refused on chain with
 * `RequiresTimelock`: use proposeConfigIx, wait CONFIG_TIMELOCK (24 h), then resolveConfigIx(apply).
 */
export function updateConfigIx(programId: PublicKey, a: { authority: PublicKey } & CreditsConfigChange): TransactionInstruction {
  return creditsAt(programId).instruction("update_config", { params: configParams(a) }, { authority: a.authority });
}

/** propose_config(params): records any change (roles, treasury, an authority hand-over, looser numbers) for the timelock. */
export function proposeConfigIx(programId: PublicKey, a: { authority: PublicKey; newTreasury?: PublicKey | null } & CreditsConfigChange): TransactionInstruction {
  return creditsAt(programId).instruction("propose_config", { params: configParams(a) }, { authority: a.authority, new_treasury: a.newTreasury ?? null, system_program: SystemProgram.programId });
}

/**
 * resolve_config(apply). apply = true: `signer` (the authority) installs the pending change after the timelock and
 * within 7 days of it; when it hands the authority over, `newAuthority` must sign too. apply = false: the authority
 * drops it (the guardian cannot); anyone may clear a proposal that has expired.
 * `authority` is the current config authority (it receives the pending account's rent).
 */
export function resolveConfigIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return creditsAt(programId).instruction("resolve_config", { apply: a.apply }, { signer: a.signer, authority: a.authority, new_authority: a.newAuthority ?? null });
}

/**
 * set_settlements_paused(paused): the guardian or the authority pauses commits, host settlement and sweeps for 72h (it
 * lapses by itself; the authority may set it again, the guardian not for 7 days); only the authority resumes early.
 */
export function setSettlementsPausedIx(programId: PublicKey, a: { signer: PublicKey; paused: boolean }): TransactionInstruction {
  return creditsAt(programId).instruction("set_settlements_paused", { paused: a.paused }, { signer: a.signer });
}

/** deposit(key_hash, amount): the depositor signs; its USDC token account funds the vault. Anyone may top up any key. */
export function depositIx(programId: PublicKey, a: { depositor: PublicKey; depositorToken: PublicKey; mint: PublicKey; keyHash: Uint8Array; amount: bigint; tokenProgram?: PublicKey }): TransactionInstruction {
  const { vault } = creditsPdas(programId);
  return creditsAt(programId).instruction("deposit", { key_hash: a.keyHash, amount: a.amount }, { depositor: a.depositor, depositor_token_account: a.depositorToken, vault, usdc_mint: a.mint, token_program: a.tokenProgram ?? TOKEN_PROGRAM_ID });
}

/** commit_spent_root(hour, root, spent_delta) by the settlement authority. `hour` is unix seconds, a multiple of 3600, not in the future. */
export function commitSpentRootIx(programId: PublicKey, a: { settlement: PublicKey; hour: bigint; root: Uint8Array; spentDelta: bigint }): TransactionInstruction {
  if (a.hour < 0n || a.hour % SECONDS_PER_HOUR !== 0n) throw new RangeError("hour must be unix seconds on an hour boundary");
  return creditsAt(programId).instruction("commit_spent_root", { hour: a.hour, root: a.root, spent_delta: a.spentDelta }, { settlement_authority: a.settlement, vault: creditsPdas(programId).vault, system_program: SystemProgram.programId });
}

/**
 * close_account(key_hash): signed by the key itself (`key` = the API key's ed25519 address, whose sha256 is `keyHash`)
 * and by `payer`, any wallet that pays the fee and the RefundRequest rent. It carries no destination: the refund returns
 * to the wallets that deposited to the key.
 */
export function closeAccountIx(programId: PublicKey, a: { key: PublicKey; payer: PublicKey; keyHash: Uint8Array }): TransactionInstruction {
  return creditsAt(programId).instruction("close_account", { key_hash: a.keyHash }, { key: a.key, payer: a.payer, system_program: SystemProgram.programId });
}

/**
 * close_account_by_owner(key_hash): the same closure, signed by the key's registered owner wallet (`owner` =
 * CreditAccount.authority) instead of the key. A closure asked for this way cannot be cancelled with the key.
 */
export function closeAccountByOwnerIx(programId: PublicKey, a: { owner: PublicKey; payer: PublicKey; keyHash: Uint8Array }): TransactionInstruction {
  return creditsAt(programId).instruction("close_account_by_owner", { key_hash: a.keyHash }, { owner: a.owner, payer: a.payer, system_program: SystemProgram.programId });
}

/**
 * cancel_close(key_hash): takes a queued closure back while nothing has been paid. `signer` is whoever asked for the
 * closure (the key itself, for a closure the key asked for) or the key's registered owner wallet; nobody else, however
 * much they deposited. When the key cancels it cannot cancel again for KEY_CANCEL_COOLDOWN (the CloseGuard account,
 * created here on first use and paid by `payer`). `rentPayer` is the wallet that paid the RefundRequest's rent
 * (RefundRequest.rentPayer); it gets it back.
 */
export function cancelCloseIx(programId: PublicKey, a: { signer: PublicKey; payer: PublicKey; keyHash: Uint8Array; rentPayer: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("cancel_close", { key_hash: a.keyHash }, { signer: a.signer, payer: a.payer, rent_payer: a.rentPayer, system_program: SystemProgram.programId });
}

/** set_refund_destination(key_hash): `depositor` (its wallet signs) names the USDC token account its refunds from this key are paid to. */
export function setRefundDestinationIx(programId: PublicKey, a: { depositor: PublicKey; keyHash: Uint8Array; refundToToken: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("set_refund_destination", { key_hash: a.keyHash }, { depositor: a.depositor, refund_to: a.refundToToken });
}

/**
 * pay_refund(amount): the settlement authority pays (part of) a queued refund from the vault to ONE depositor of the
 * key: to that depositor's `refund_to` (`refundToToken` must be it) and at most what that depositor put in.
 */
export function payRefundIx(programId: PublicKey, a: { settlement: PublicKey; keyHash: Uint8Array; depositor: PublicKey; amount: bigint; refundToToken: PublicKey; mint: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  const { vault, refundRequest } = creditsPdas(programId, a.keyHash);
  return creditsAt(programId).instruction("pay_refund", { amount: a.amount }, { settlement_authority: a.settlement, refund_request: refundRequest, share: sharePda(programId, a.keyHash, a.depositor), vault, refund_to: a.refundToToken, usdc_mint: a.mint, token_program: a.tokenProgram ?? TOKEN_PROGRAM_ID });
}

/** settle_to_host(amount, hour_root_ref): vault -> a host's USDC token account, bounded by committed spend and the per-window limit. */
export function settleToHostIx(programId: PublicKey, a: { settlement: PublicKey; hour: bigint; amount: bigint; hostToken: PublicKey; mint: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  const { vault } = creditsPdas(programId);
  return creditsAt(programId).instruction("settle_to_host", { amount: a.amount, hour_root_ref: a.hour }, { settlement_authority: a.settlement, vault, host_token_account: a.hostToken, usdc_mint: a.mint, token_program: a.tokenProgram ?? TOKEN_PROGRAM_ID });
}

/**
 * set_key_authority(key_hash, new_authority): registers the key's owner wallet. While the key has no owner, `signer` is
 * the key itself and the wallet (`newAuthority`) must sign too; once an owner is registered, `signer` is that owner and
 * the key alone can no longer change it. `newAuthority` = the default key clears the owner (current owner only).
 */
export function setKeyAuthorityIx(programId: PublicKey, a: { signer: PublicKey; keyHash: Uint8Array; newAuthority: PublicKey }): TransactionInstruction {
  return creditsAt(programId).instruction("set_key_authority", { key_hash: a.keyHash, new_authority: a.newAuthority }, { signer: a.signer, new_owner: a.newAuthority.equals(PublicKey.default) ? null : a.newAuthority });
}

/** notice_expiry(key_hash) by the settlement authority: starts the grace period of an expired balance. */
export function noticeExpiryIx(programId: PublicKey, a: { settlement: PublicKey; keyHash: Uint8Array }): TransactionInstruction {
  return creditsAt(programId).instruction("notice_expiry", { key_hash: a.keyHash }, { settlement_authority: a.settlement });
}

/**
 * sweep_expired(key_hash, amount) by the settlement authority, after the grace period: `amount` (the key's UNSPENT
 * balance, never more than its on-chain balance) moves vault -> treasury; what the key spent stays for host settlement.
 */
export function sweepExpiredIx(programId: PublicKey, a: { settlement: PublicKey; keyHash: Uint8Array; amount: bigint; treasuryToken: PublicKey; mint: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  const { vault } = creditsPdas(programId);
  return creditsAt(programId).instruction("sweep_expired", { key_hash: a.keyHash, amount: a.amount }, { settlement_authority: a.settlement, vault, treasury_token_account: a.treasuryToken, usdc_mint: a.mint, token_program: a.tokenProgram ?? TOKEN_PROGRAM_ID });
}
