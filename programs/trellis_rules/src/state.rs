use anchor_lang::prelude::*;

/// Program configuration. PDA `["config"]`.
///
/// `authority` is a single pubkey for now; production uses a Squads 2-of-3 multisig.
/// `guardian` can only pause creation of new rulebooks. `enforcer` is the key (in production
/// the trellis_tab program's PDA signer) allowed to `record_spend` against any rulebook.
#[account]
#[derive(InitSpace)]
pub struct RulesConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub enforcer: Pubkey,
    pub new_rulebooks_paused: bool,
    pub bump: u8,
    /// When the pause lapses by itself (`PAUSE_TTL` after it was last set). The flag is in force only until then.
    pub paused_until: i64,
    /// The guardian may not pause again before this time (`GUARDIAN_PAUSE_COOLDOWN` after its last pause was due to
    /// lapse).
    pub guardian_pause_ready_at: i64,
}

impl RulesConfig {
    /// Account size before `paused_until` and `guardian_pause_ready_at` were appended (`migrate_config`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 16;

    /// A pause is in force only while its flag is set AND its expiry lies ahead.
    pub fn pause_active(&self, now: i64) -> bool {
        self.new_rulebooks_paused && now < self.paused_until
    }
}

/// What `build_profile` returns: the floors compiled into this binary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile {
    /// 0 = mainnet floors (the default build); 1 = the `devnet` cargo feature.
    pub profile: u8,
    pub config_timelock: i64,
    pub pause_ttl: i64,
    pub guardian_pause_cooldown: i64,
    pub proposal_ttl: i64,
}

/// An agent rulebook (Backend §5.5). PDA `["rulebook", owner, rulebook_id.to_le_bytes()]`.
///
/// Amounts are USDC base units (6 decimals). `payee_allowlist_root` and
/// `model_allowlist_root` are sha256 Merkle roots (see trellis_anchor::merkle) the router
/// checks off-chain; all-zero means "no allowlist". `expiry` is a unix timestamp after which
/// `check_spend` reverts. `killed` is set once by the owner and is permanent: a killed rulebook can never be
/// updated or closed, so its address stays a tombstone and cannot be re-created as a fresh rulebook.
///
/// What the limits bind (decided in security/REVIEW-2026-10.md, TR-04 / TR-10):
/// - `daily_max` bounds what the owner can newly commit per UTC day. `trellis_tab` records the escrowed amount of
///   every `open_tab` / `top_up` against it (`record_commitment`), and refuses a killed or expired rulebook.
/// - `per_call_max` bounds one call. Calls happen off chain; the payee checks each request against it before it
///   accepts the voucher (`check_spend` is the same rule for off-chain callers and other programs).
/// - Settlement never depends on the rulebook: once a voucher is signed, `trellis_tab::close` pays it whatever
///   happens to the rulebook afterwards. A rulebook can stop new commitments and new calls; it cannot take back
///   usage already vouched.
#[account]
#[derive(InitSpace)]
pub struct Rulebook {
    pub owner: Pubkey,
    pub rulebook_id: u64,
    pub per_call_max: u64,
    pub daily_max: u64,
    pub payee_allowlist_root: [u8; 32],
    pub model_allowlist_root: [u8; 32],
    pub ask_first_above: u64,
    pub expiry: i64,
    pub killed: bool,
    /// UTC day number (unix_timestamp / 86400) of `spent_today`.
    pub spent_day: i64,
    /// Spend recorded on `spent_day` via `record_spend`.
    pub spent_today: u64,
    pub bump: u8,
}

impl Rulebook {
    /// Spend already recorded for `day` (0 if the counter belongs to another day).
    pub fn spent_on(&self, day: i64) -> u64 {
        if self.spent_day == day {
            self.spent_today
        } else {
            0
        }
    }
}

/// An authority / guardian / enforcer change waiting out `CONFIG_TIMELOCK`. PDA `["pending_config"]`; one at a time.
#[account]
#[derive(InitSpace)]
pub struct PendingConfig {
    pub new_authority: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub enforcer: Option<Pubkey>,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}
