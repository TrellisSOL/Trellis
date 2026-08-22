use anchor_lang::prelude::*;

/// Program configuration. Singleton PDA `["config"]`; also the signing authority of the vault.
///
/// `authority` is the admin key. In production this is a Squads 2-of-3 multisig; a single
/// pubkey is used until then. `settlement_authority` is the hot key of the settlement
/// service (commits spent roots, pays settlements and refunds, runs expiry). `guardian` can
/// only pause; it can never move funds.
#[account]
#[derive(InitSpace)]
pub struct CreditsConfig {
    pub authority: Pubkey,
    pub settlement_authority: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    /// Token account PDA `["vault"]`, authority = this config PDA.
    pub vault: Pubkey,
    /// Destination for swept expired balances. Must be a token account of `usdc_mint`.
    pub treasury_token_account: Pubkey,
    pub max_balance_per_key: u64,
    /// Seconds a balance lives after the latest deposit (default 365 days, never below `MIN_CREDIT_TTL`).
    pub credit_ttl: i64,
    /// Seconds between `close_account` and the earliest `pay_refund` (default 72h, never below `MIN_REFUND_DELAY`).
    pub refund_delay: i64,
    /// Seconds between `notice_expiry` and the earliest `sweep_expired` (default 30 days, never below `MIN_EXPIRY_GRACE`).
    pub expiry_grace: i64,
    /// Cumulative spend committed via `commit_spent_root`. Upper bound for host settlement.
    pub spent_total: u64,
    /// Cumulative USDC paid out to hosts via `settle_to_host`. Never exceeds `spent_total`.
    pub settled_total: u64,
    /// Last hour committed; hours must strictly increase.
    pub latest_hour: i64,
    /// True while a deposit pause is set. It is in force only until `deposits_paused_until` (see `pause_active`).
    pub deposits_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    /// When the deposit pause lapses by itself (`PAUSE_TTL` after it was last set). 0 on a config that never paused.
    pub deposits_paused_until: i64,
    /// The guardian may not pause deposits again before this time (`GUARDIAN_PAUSE_COOLDOWN` after its last pause
    /// was due to lapse).
    pub deposits_guardian_ready_at: i64,
}

impl CreditsConfig {
    /// Account size before `deposits_paused_until` and `deposits_guardian_ready_at` were appended (`migrate_config`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 16;
}

/// A pause is in force only while its flag is set AND its expiry lies ahead: every pause lapses `PAUSE_TTL` after it
/// was last set, whoever set it, so nothing stays paused because a key was lost or stolen.
pub fn pause_active(paused: bool, paused_until: i64, now: i64) -> bool {
    paused && now < paused_until
}

/// One per API key. PDA `["credit", key_hash]` where `key_hash = sha256(key address)` and the key address is the
/// ed25519 public key derived from the API key.
///
/// Spend is tracked off-chain and committed hourly as `SpentRoot`s, so `balance` is the
/// prepaid amount still on-chain, not the live remaining balance. There is no withdraw
/// instruction: the only outflows are `pay_refund` (closure), `settle_to_host` and
/// `sweep_expired`.
#[account]
#[derive(InitSpace)]
pub struct CreditAccount {
    pub key_hash: [u8; 32],
    /// The key's owner wallet, or the default pubkey when none is registered. Registered once with
    /// `set_key_authority`, signed by the key AND by the wallet; from then on only that wallet can change or clear it
    /// (the key alone cannot). The owner can ask for a closure without the key (`close_account_by_owner`) and can
    /// cancel any closure of the key; a closure the owner asked for cannot be cancelled with the key. It gives no claim
    /// on funds: refunds go back to the wallets that deposited. Depositing gives no way to become the owner.
    /// (Accounts created before the TR-05 fix may carry their first depositor here: clear it on devnet by closing.)
    pub authority: Pubkey,
    pub balance: u64,
    pub deposited_total: u64,
    /// Latest deposit time + `credit_ttl`; every deposit extends the whole balance.
    pub expires_at: i64,
    /// Unix time of `notice_expiry`, or 0 if no notice is outstanding.
    pub expiry_notice_at: i64,
    pub closed: bool,
    pub bump: u8,
}

/// Hourly commitment of off-chain spend. PDA `["spent_root", hour]`.
///
/// `root` is a sha256 Merkle root over the hour's spend records (leaf = sha256(sha256(bytes)),
/// node = sha256(min(a,b) || max(a,b)); see `trellis_anchor`).
#[account]
#[derive(InitSpace)]
pub struct SpentRoot {
    pub hour: i64,
    pub root: [u8; 32],
    pub spent_delta: u64,
    pub cumulative_spent: u64,
    pub committed_at: i64,
    pub bump: u8,
}

/// What one wallet has deposited to one key, and where that wallet wants it back. PDA `["share", key_hash, depositor]`.
///
/// A closure refund never goes anywhere the key chooses (security re-review RR-05): it is paid back to the wallets
/// that funded the key, each at most what it put in, to the token account that wallet named. `refund_to` starts as the
/// token account the first deposit came from and only `depositor` can change it (`set_refund_destination`). Holding
/// the API key gives no way to redirect a balance, and depositing to someone's key gives no claim on anything but the
/// depositor's own USDC.
#[account]
#[derive(InitSpace)]
pub struct DepositorShare {
    pub key_hash: [u8; 32],
    pub depositor: Pubkey,
    /// USDC token account this depositor's refunds are paid to.
    pub refund_to: Pubkey,
    /// Cumulative USDC this wallet deposited to the key.
    pub deposited: u64,
    /// Cumulative USDC refunded to this wallet from the key. Never exceeds `deposited`.
    pub refunded: u64,
    pub last_deposit_at: i64,
    pub bump: u8,
}

/// Queued closure refund. PDA `["refund", key_hash]`. Created by `close_account` (signed by the key) or
/// `close_account_by_owner` (signed by the key's registered owner wallet), removed again by `cancel_close` while nothing
/// has been paid.
#[account]
#[derive(InitSpace)]
pub struct RefundRequest {
    pub key_hash: [u8; 32],
    /// The key's on-chain balance when it was closed: the most that can ever be refunded.
    pub amount: u64,
    pub requested_at: i64,
    /// Earliest `pay_refund`: `requested_at` plus the refund delay AS IT WAS when the key was closed. A later change of
    /// the delay does not move a request that is already queued (security re-review RR-10).
    pub payable_at: i64,
    /// Cumulative amount paid so far; `pay_refund` may be called more than once and never pays more than `amount`.
    pub paid_amount: u64,
    /// True once `paid_amount == amount`.
    pub paid: bool,
    /// Who paid this account's rent; gets it back if the closure is cancelled.
    pub rent_payer: Pubkey,
    pub bump: u8,
    /// Who asked for this closure: the key's own address or the owner wallet. Only this party, or the owner, can
    /// cancel it (security review round 3, R3-06).
    pub requested_by: Pubkey,
}

/// When the key itself may next cancel a closure. PDA `["close_guard", key_hash]`, created by the key's first cancel.
///
/// Two parties can hold the same API key (its owner and whoever it leaked to). Without this, one of them could take
/// every closure of the other back just before it became payable, for ever. The key may cancel one closure and then
/// none for `KEY_CANCEL_COOLDOWN`, which is longer than any refund delay: the next closure runs to payment. The
/// registered owner wallet is not bound by it.
#[account]
#[derive(InitSpace)]
pub struct CloseGuard {
    pub key_hash: [u8; 32],
    pub key_cancel_blocked_until: i64,
    pub bump: u8,
}

/// Outflow limiter. Singleton PDA `["limiter_v2"]`.
///
/// Two independent allowances, one for `settle_to_host` and one for `pay_refund`, so host payouts can never use up
/// what refunds may take and refunds can never hold up host payouts. Each is a continuously refilled allowance
/// (`refill_allowance`), not a bucket that resets: the cap of one `SETTLE_WINDOW` is `window_cap(base)`, at most
/// `SETTLE_BURST_BPS` of it can be held at once, and the rest arrives evenly over the window. Over ANY interval of one
/// window the outflow is therefore at most the cap; there is no boundary to straddle (security re-review RR-01).
///
/// The cap has two bounds (security review round 3, R3-07):
/// - a share (`rate_bps`) of `base`, and `base` is never more than the LOWEST balance the vault has had over the last
///   `SETTLE_WINDOW`. A deposit therefore counts only once it has been in the vault for a whole window: whoever holds
///   the settlement key cannot raise the cap by depositing and paying one unit, as it could when the base was the
///   balance after the previous payment;
/// - `cap_per_window`, an absolute amount set by the authority. Capital that sits in the vault long enough does raise
///   the share; this number it cannot raise.
///
/// How `base` is kept without touching `deposit`: every instruction that can lower the vault (`settle_to_host`,
/// `pay_refund`, `sweep_expired`) and `commit_spent_root` record the balance they leave behind (`last_vault`). Between
/// two of them the vault can only rise, so the lowest balance of any stretch is the one recorded at its start.
/// `base_cur` is the lowest balance of the current epoch (`now / SETTLE_WINDOW`), starting from `last_vault` when the
/// epoch is first seen; `base_prev` that of the epoch before (`last_vault` when nothing was recorded in it). The base
/// is `min(base_prev, base_cur, vault now)`, and any stretch of one window lies inside those two epochs.
///
/// `paused` (in force until `paused_until`) stops `commit_spent_root`, `settle_to_host` and `sweep_expired`. It never
/// stops deposits, closures or closure refunds.
#[account]
#[derive(InitSpace)]
pub struct SettleLimiter {
    pub rate_bps: u16,
    /// What `settle_to_host` may still pay right now (as of `settle_refilled_at`).
    pub settle_allowance: u64,
    pub settle_refilled_at: i64,
    /// The lowest vault balance seen in epoch `base_epoch` (in the earlier layout: the balance after the last payout).
    pub base_cur: u64,
    /// What `pay_refund` may still pay right now (as of `refund_refilled_at`).
    pub refund_allowance: u64,
    pub refund_refilled_at: i64,
    /// The lowest vault balance of the epoch before `base_epoch` (in the earlier layout: the balance after the last
    /// refund).
    pub base_prev: u64,
    pub paused: bool,
    /// When the settlement pause lapses by itself (`PAUSE_TTL` after it was last set).
    pub paused_until: i64,
    /// The guardian may not pause settlements again before this time.
    pub guardian_pause_ready_at: i64,
    pub bump: u8,
    /// The epoch (`unix time / SETTLE_WINDOW`) `base_cur` belongs to.
    pub base_epoch: i64,
    /// The vault balance left behind by the last instruction that recorded it.
    pub last_vault: u64,
    /// The absolute bound on one window's outflow, for each of the two allowances. Never below `SETTLE_WINDOW_FLOOR`.
    pub cap_per_window: u64,
}

impl SettleLimiter {
    /// Account size before `base_epoch`, `last_vault` and `cap_per_window` were appended (`migrate_limiter`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 24;

    /// Bring the base tracker to `now` and return the base this instruction's allowance is computed from:
    /// never more than the lowest vault balance of the last `SETTLE_WINDOW`.
    pub fn roll_base(&mut self, vault_now: u64, now: i64) -> u64 {
        let epoch = now.max(0) / crate::constants::SETTLE_WINDOW;
        if epoch != self.base_epoch {
            // Since the last record the vault can only have risen, so `last_vault` is a lower bound of every balance
            // in the epochs that passed unseen and of the balance this epoch began with.
            self.base_prev = if epoch == self.base_epoch.saturating_add(1) { self.base_cur } else { self.last_vault };
            self.base_cur = self.last_vault;
            self.base_epoch = epoch;
        }
        self.base_cur = self.base_cur.min(vault_now);
        self.base_prev.min(self.base_cur)
    }

    /// Record the balance this instruction leaves in the vault.
    pub fn note_vault(&mut self, vault_after: u64) {
        self.base_cur = self.base_cur.min(vault_after);
        self.last_vault = vault_after;
    }
}

/// The cap of one `SETTLE_WINDOW` for a base of `base`: `rate_bps` of it, at most `cap_per_window`, and never less than
/// `SETTLE_WINDOW_FLOOR` (so a small vault can still pay; `cap_per_window` itself is never below the floor).
pub fn window_cap(base: u64, rate_bps: u16, cap_per_window: u64) -> u64 {
    let share = (base as u128) * (rate_bps as u128) / (crate::constants::BPS_DENOMINATOR as u128);
    (share.min(cap_per_window as u128) as u64).max(crate::constants::SETTLE_WINDOW_FLOOR)
}

/// The most an allowance can hold at once: `SETTLE_BURST_BPS` of the window's cap.
pub fn burst_of(cap: u64) -> u64 {
    ((cap as u128) * (crate::constants::SETTLE_BURST_BPS as u128) / (crate::constants::BPS_DENOMINATOR as u128)) as u64
}

/// Refill one allowance up to `now` and return what may be paid at this moment.
///
/// `cap = window_cap(base, ..)` with the base from `SettleLimiter::roll_base`, `burst = burst_of(cap)`. The allowance
/// grows by `(cap - burst) * elapsed / SETTLE_WINDOW` and is clamped to `burst` (so a lower rate, a lower absolute cap
/// or a smaller vault takes effect at once). An allowance that has never been used starts at `burst`. Rounding is
/// always down. Why no interval of one window can pay more than the cap in force: it starts with at most `burst` and
/// gains at most `cap - burst` in `SETTLE_WINDOW` seconds.
pub fn refill_allowance(allowance: u64, refilled_at: i64, cap: u64, now: i64) -> u64 {
    let burst = burst_of(cap);
    if refilled_at == 0 {
        return burst;
    }
    let window = crate::constants::SETTLE_WINDOW;
    let elapsed = now.saturating_sub(refilled_at).clamp(0, window) as u128;
    let gained = ((cap - burst) as u128) * elapsed / (window as u128);
    ((allowance as u128) + gained).min(burst as u128) as u64
}

/// The fields `update_config` / `propose_config` may change. `None` leaves a field as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, InitSpace)]
pub struct UpdateConfigParams {
    /// Hand the authority over. Only through the timelock, and the new authority must sign the apply.
    pub new_authority: Option<Pubkey>,
    pub settlement_authority: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub max_balance_per_key: Option<u64>,
    pub credit_ttl: Option<i64>,
    pub refund_delay: Option<i64>,
    pub expiry_grace: Option<i64>,
    /// Share of the vault `settle_to_host` may pay per window, in bps (at most `MAX_SETTLE_RATE_BPS`).
    pub settle_rate_bps: Option<u16>,
    /// Write `spent_total` down to `settled_total`: the repair for a spent root that committed spend which never
    /// happened (security re-review RR-06). Only through the timelock.
    pub write_down_spent: bool,
    /// The absolute bound on one window's outflow (each allowance). Lowering is immediate, raising goes through the
    /// timelock; never below `SETTLE_WINDOW_FLOOR`.
    pub outflow_cap_per_window: Option<u64>,
}

/// A loosening config change waiting out `CONFIG_TIMELOCK`. PDA `["pending_config"]`; one at a time.
#[account]
#[derive(InitSpace)]
pub struct PendingConfig {
    pub params: UpdateConfigParams,
    /// Replacement treasury token account (mint-checked at proposal), if any.
    pub new_treasury: Option<Pubkey>,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// What `build_profile` returns: the floors compiled into this binary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile {
    /// 0 = mainnet floors (the default build); 1 = the `devnet` cargo feature.
    pub profile: u8,
    pub min_refund_delay: i64,
    pub min_expiry_grace: i64,
    pub min_credit_ttl: i64,
    pub config_timelock: i64,
    pub settle_window: i64,
    pub pause_ttl: i64,
    pub guardian_pause_cooldown: i64,
    pub proposal_ttl: i64,
}
