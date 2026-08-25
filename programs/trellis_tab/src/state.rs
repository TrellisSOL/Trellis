//! Account state for `trellis_tab`.
//!
//! PDA seeds (all derived from this program id):
//!
//! | Account            | Seeds                                               |
//! | ------------------ | --------------------------------------------------- |
//! | `TabConfig`        | `["config"]`                                        |
//! | `Tab`              | `["tab", payer, payee, tab_id.to_le_bytes()]`       |
//! | escrow             | `["escrow", tab]` (SPL token account, owner = `Tab`) |
//! | enforcer (signer)  | `["enforcer"]` (signs CPIs into `trellis_rules`)    |
//! | `PendingConfig`    | `["pending_config"]`                                |
//!
//! All USDC amounts are in base units (6 decimals).
//!
//! Voucher message (signed off-chain by the payer's `session_key` with Ed25519, verified on
//! chain through the Ed25519 precompile + instruction introspection):
//!
//! ```text
//! msg = "trellis:tab:voucher:v1" (22 bytes) || program_id (32 bytes) || tab_pubkey (32 bytes)
//!       || tab.created_at (i64 LE, 8 bytes) || cumulative_used (u64 LE, 8 bytes) || seq (u64 LE, 8 bytes)
//! ```
//!
//! 110 bytes. The prefix separates vouchers from anything else a session key signs, the program id binds a voucher to
//! this deployment (and so to its cluster), and `created_at` binds it to one opening of the tab address.

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const TAB_SEED: &[u8] = b"tab";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const PENDING_CONFIG_SEED: &[u8] = b"pending_config";

/// Domain separator that starts every voucher message. A change of the signed layout takes a new version here.
pub const VOUCHER_DOMAIN: &[u8; 22] = b"trellis:tab:voucher:v1";
/// Voucher message length: 22 (domain) + 32 (program id) + 32 (tab) + 8 (created_at) + 8 + 8.
pub const VOUCHER_MSG_LEN: usize = 110;
/// Default per-tab cap until audit: 500 USDC (Backend spec section 10).
pub const DEFAULT_MAX_CAP: u64 = 500_000_000;
/// The most `max_cap` can be set to while the programs are unaudited: 500 USDC. Compiled in, the same in every build
/// (the `devnet` feature does not change it): no key raises the cap above it, at init, at once or through the timelock;
/// a higher cap takes a program upgrade. `open_tab` and `top_up` apply it as well, so a config written by an earlier
/// version is held to it too.
pub const MAX_CAP_LIMIT: u64 = 500_000_000;
/// Default grace after `expiry` before the escrow can be reclaimed: 24h.
pub const DEFAULT_RECLAIM_GRACE: i64 = 24 * 60 * 60;

// ---- Floors and bounds the authority cannot bypass -----------------------------------------------------------------
//
// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY. It compiles the short values in the
// second block. A mainnet build must be made WITHOUT `--features devnet`; the default build carries the mainnet values
// and tests/floors.ts asserts it.

#[cfg(not(feature = "devnet"))]
mod profile {
    /// The payee always has at least this long after `expiry` to close before anyone can reclaim: 24 hours.
    pub const MIN_RECLAIM_GRACE: i64 = 24 * 60 * 60;
    /// Delay between `propose_config` and the moment the change can be applied: 24 hours.
    pub const CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
    /// A pause set by the guardian or the authority lapses after 72 hours unless the authority sets it again.
    pub const PAUSE_TTL: i64 = 72 * 60 * 60;
    /// After a guardian pause the guardian cannot pause again for 7 days (counted from the moment its pause would
    /// lapse), so one stolen guardian key cannot hold a pause open by setting it again and again.
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 7 * 24 * 60 * 60;
    /// A proposal that was not applied within 7 days of becoming effective can only be cancelled.
    pub const PROPOSAL_TTL: i64 = 7 * 24 * 60 * 60;
}

#[cfg(feature = "devnet")]
mod profile {
    pub const MIN_RECLAIM_GRACE: i64 = 1;
    pub const CONFIG_TIMELOCK: i64 = 30;
    pub const PAUSE_TTL: i64 = 60;
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 60;
    pub const PROPOSAL_TTL: i64 = 600;
}

pub use profile::*;

/// Which floors this binary was compiled with: 0 = the mainnet floors (the default build), 1 = the short `devnet`
/// floors. `build_profile` returns it with the floors themselves, so anyone can ask the deployed program which build it
/// is (a simulated call is enough). The IDL is the same file for both flavours and cannot tell them apart.
#[cfg(not(feature = "devnet"))]
pub const BUILD_PROFILE: u8 = 0;
#[cfg(feature = "devnet")]
pub const BUILD_PROFILE: u8 = 1;

/// The grace can never be stretched until it blocks reclaim: at most 7 days.
pub const MAX_RECLAIM_GRACE: i64 = 7 * 24 * 60 * 60;
/// A tab's `expiry` is at most this far from the moment it is opened (30 days), so `expiry + reclaim_grace` cannot
/// overflow and an escrow cannot be locked for an arbitrary time.
pub const MAX_TAB_LIFETIME: i64 = 30 * 24 * 60 * 60;

/// Program configuration. Production `authority` is a Squads v4 2-of-3 multisig;
/// `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new tabs, never move funds.
#[account]
#[derive(InitSpace)]
pub struct TabConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    /// `trellis_rules` program id; tabs opened with a rulebook CPI into it when USDC is committed.
    pub rules_program: Pubkey,
    /// Maximum escrow per tab (cap + top-ups). At most `MAX_CAP_LIMIT`.
    pub max_cap: u64,
    /// Seconds after `expiry` before `reclaim` is allowed. Within `[MIN_RECLAIM_GRACE, MAX_RECLAIM_GRACE]`.
    pub reclaim_grace: i64,
    pub paused: bool,
    pub bump: u8,    /// When the pause lapses by itself (`PAUSE_TTL` after it was last set). `paused` is in force only until then.
    pub paused_until: i64,
    /// The guardian may not pause again before this time (`GUARDIAN_PAUSE_COOLDOWN` after its last pause was due to
    /// lapse).
    pub guardian_pause_ready_at: i64,
}

impl TabConfig {
    /// Account size before `paused_until` and `guardian_pause_ready_at` were appended (`migrate_config`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 16;

    /// A pause is in force only while its flag is set AND its expiry lies ahead: every pause lapses `PAUSE_TTL` after
    /// it was last set, whoever set it, so nothing stays paused because a key was lost or stolen.
    pub fn pause_active(&self, now: i64) -> bool {
        self.paused && now < self.paused_until
    }
}

#[account]
#[derive(InitSpace)]
pub struct Tab {
    pub payer: Pubkey,
    pub payee: Pubkey,
    /// Ed25519 key that signs vouchers. Registered by the payer at `open_tab`; the payer's
    /// wallet itself never signs vouchers.
    pub session_key: Pubkey,
    pub mint: Pubkey,
    pub tab_id: u64,
    /// While the tab is open: total USDC escrowed (initial cap plus top-ups), the ceiling for vouchers.
    /// Once settlement has started (`is_final`): what this record still owes (see `settle`).
    pub cap: u64,
    /// Highest `cumulative_used` the payee has posted (`post_voucher` / `close`) and not yet been paid.
    pub posted_used: u64,
    /// Highest voucher `seq` accepted so far (replay protection). `FINAL_SEQ` once settlement has started.
    pub posted_seq: u64,
    pub expiry: i64,
    pub created_at: i64,
    /// Optional `trellis_rules` Rulebook (owned by the payer) checked when USDC is committed.
    pub rulebook: Option<Pubkey>,
    pub bump: u8,
    pub escrow_bump: u8,
}

impl Tab {
    /// `posted_seq` value that marks a tab whose settlement has started: no voucher can carry a higher seq, so no
    /// voucher or top-up is accepted any more, and what is left in escrow can be delivered at any time with `reclaim`.
    pub const FINAL_SEQ: u64 = u64::MAX;

    pub fn is_final(&self) -> bool {
        self.posted_seq == Self::FINAL_SEQ
    }
}

/// The fields `update_config` / `propose_config` may change. `None` leaves a field as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, InitSpace)]
pub struct UpdateConfigArgs {
    /// Hand the authority over. Only through the timelock, and the new authority must sign the apply.
    pub new_authority: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub rules_program: Option<Pubkey>,
    pub max_cap: Option<u64>,
    pub reclaim_grace: Option<i64>,
}

/// A loosening config change waiting out `CONFIG_TIMELOCK`. PDA `["pending_config"]`; one at a time.
#[account]
#[derive(InitSpace)]
pub struct PendingConfig {
    pub args: UpdateConfigArgs,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
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
    pub min_reclaim_grace: i64,
}
