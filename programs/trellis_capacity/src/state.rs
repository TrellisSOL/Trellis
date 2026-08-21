//! Account state for `trellis_capacity` (Bushels) and the HVX feed.
//!
//! A Bushel is prepaid inference capacity: 1 Bushel = 1,000,000 output-equivalent tokens
//! (input weighted 0.25, cached input 0.05). THERE IS NO BUSHEL MINT. Lots are ledger entries
//! bound to a buyer's `key_hash`; no instruction can transfer, sell or re-bind a lot. Redemption
//! (into inference credits, issued off-chain against `LotRedeemed`) is the only exit.
//!
//! PDA seeds (all derived from this program id):
//!
//! | Account               | Seeds                                                  |
//! | --------------------- | ------------------------------------------------------ |
//! | `CapacityConfig`      | `["config"]`                                           |
//! | `HostCapacity`        | `["host", host]`                                       |
//! | `CapacityCommitment`  | `["commitment", host, commitment_id.to_le_bytes()]`    |
//! | `BushelLot`           | `["lot", commitment, lot_id.to_le_bytes()]`            |
//! | `HvxFeed`             | `["hvx", [grade]]`                                     |
//! | bond claimer (signer) | `["bond_claimer"]` (no data; signs CPIs into trellis_bond) |
//!
//! All USDC amounts are in base units (6 decimals).

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const HOST_SEED: &[u8] = b"host";
pub const COMMITMENT_SEED: &[u8] = b"commitment";
pub const LOT_SEED: &[u8] = b"lot";
pub const HVX_SEED: &[u8] = b"hvx";
pub const BOND_CLAIMER_SEED: &[u8] = b"bond_claimer";
pub const PENDING_CONFIG_SEED: &[u8] = b"pending_config";

/// Tokens per Bushel.
pub const TOKENS_PER_BUSHEL: u64 = 1_000_000;
/// Number of grades: 0 = G-S (small), 1 = G-M (medium), 2 = G-L (large).
pub const GRADE_COUNT: usize = 3;
/// Default global issuance cap until audit: $250k of outstanding commitments (spec section 10).
pub const DEFAULT_MAX_OUTSTANDING_VALUE: u64 = 250_000_000_000;
/// The most the issuance cap can be set to while the programs are unaudited: 250,000 USDC. Compiled in, the same in
/// every build (the `devnet` feature does not change it): no key raises `max_outstanding_value` above it, at init, at
/// once or through the timelock; a higher cap takes a program upgrade. `commit_capacity` applies it as well, so a
/// config written by an earlier version is held to it too.
pub const MAX_OUTSTANDING_VALUE_CAP: u64 = 250_000_000_000;
/// No grade price can be set above 10,000 USDC per Bushel (per 1M output-equivalent tokens), far above any model's
/// list price. A commitment keeps the price it was made at, so this bounds only what a new commitment locks per
/// Bushel; a host signs the grade and the token count, not the price.
pub const MAX_GRADE_PRICE: u64 = 10_000_000_000;

// ---- Bounds the authority cannot bypass ----------------------------------------------------------------------------
//
// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY. It compiles the short values in the
// second block. A mainnet build must be made WITHOUT `--features devnet`.

#[cfg(not(feature = "devnet"))]
mod profile {
    /// After `window_end` the authority has this long to report a shortfall and file every lot's claim. Then anyone
    /// can settle the commitment and release the bond lock (`release_commitment`): 14 days.
    pub const CLAIM_PERIOD: i64 = 14 * 24 * 60 * 60;
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
    pub const CLAIM_PERIOD: i64 = 30;
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

/// A commitment's window is at most 90 days long and ends at most 180 days from the moment it is made, so a host
/// cannot hold part of the global issuance cap (or keep its own bond locked) for an arbitrary time.
pub const MAX_WINDOW_LENGTH: i64 = 90 * 24 * 60 * 60;
pub const MAX_WINDOW_HORIZON: i64 = 180 * 24 * 60 * 60;

/// Program configuration. Production `authority` is a Squads v4 2-of-3 multisig;
/// `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new commitments and sales, never move funds.
#[account]
#[derive(InitSpace)]
pub struct CapacityConfig {
    pub authority: Pubkey,
    /// Records sales and redemptions (the `mint`/settlement service key).
    pub sale_authority: Pubkey,
    /// The only key allowed to write `HvxFeed`.
    pub hvx_authority: Pubkey,
    pub guardian: Pubkey,
    /// Fixed USDC price per Bushel (per 1M tokens) for each grade, each at most `MAX_GRADE_PRICE`. A new commitment is
    /// valued at it and keeps it; sales never exceed it nor the price their commitment was made at.
    pub grade_prices: [u64; GRADE_COUNT],
    /// Cap on the USDC value of all open commitments. At most `MAX_OUTSTANDING_VALUE_CAP`.
    pub max_outstanding_value: u64,
    /// USDC value of all currently open commitments.
    pub outstanding_value: u64,
    pub paused: bool,
    pub bump: u8,    /// When the pause lapses by itself (`PAUSE_TTL` after it was last set). `paused` is in force only until then.
    pub paused_until: i64,
    /// The guardian may not pause again before this time (`GUARDIAN_PAUSE_COOLDOWN` after its last pause was due to
    /// lapse).
    pub guardian_pause_ready_at: i64,
}

impl CapacityConfig {
    /// Account size before `paused_until` and `guardian_pause_ready_at` were appended (`migrate_config`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 16;

    /// A pause is in force only while its flag is set AND its expiry lies ahead: every pause lapses `PAUSE_TTL` after
    /// it was last set, whoever set it, so nothing stays paused because a key was lost or stolen.
    pub fn pause_active(&self, now: i64) -> bool {
        self.paused && now < self.paused_until
    }
}

/// Per-host aggregate used to keep issuance bond-backed: the summed value of a host's open
/// commitments may never exceed its bonded amount.
#[account]
#[derive(InitSpace)]
pub struct HostCapacity {
    pub host: Pubkey,
    pub committed_value: u64,
    pub open_commitments: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CommitmentStatus {
    /// Sales allowed until `window_end`; headroom reserved against the bond.
    Open,
    /// Window closed with `unserved_tokens > 0`; lots may be rehomed or claimed against the bond.
    ShortfallReported,
    /// Window closed and fully served (or every lot has been handled).
    Settled,
}

#[account]
#[derive(InitSpace)]
pub struct CapacityCommitment {
    pub host: Pubkey,
    /// `trellis_bond::HostBond` backing this commitment.
    pub host_bond: Pubkey,
    pub commitment_id: u64,
    pub grade: u8,
    /// Output-equivalent tokens committed inside the window.
    pub tokens: u64,
    /// Tokens sold as lots so far (including rehomed-in tokens).
    pub sold_tokens: u64,
    pub window_start: i64,
    pub window_end: i64,
    /// `tokens * grade_price / TOKENS_PER_BUSHEL` (ceil) at the price of the moment the host committed; locked in the
    /// bond. Never changes afterwards.
    pub value: u64,
    pub status: CommitmentStatus,
    /// Tokens the host failed to serve, as reported by the authority after `window_end`.
    pub unserved_tokens: u64,
    /// Number of lots sold; also the next `lot_id`.
    pub lots_sold: u32,
    pub bump: u8,
    /// The grade's price per Bushel when the host made this commitment. A lot recorded against it can never be priced
    /// above this, whatever the grade price is changed to later (security review round 3, R3-16). 0 on a commitment
    /// from before the field existed (`migrate_commitment`): nothing more is sold against such a commitment.
    pub price_per_bushel: u64,
    /// Sum of `price_paid` of the lots recorded against this commitment. Never above `value`.
    pub paid_total: u64,
    /// Sum of the shortfall claims filed against the host's bond for this commitment. Never above `value`; it is the
    /// part of the commitment's bond lock that the claims took, so `release_commitment` unlocks `value - claimed_value`.
    pub claimed_value: u64,
}

impl CapacityCommitment {
    /// Account size before `price_per_bushel`, `paid_total` and `claimed_value` were appended (`migrate_commitment`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 24;
}

/// A purchase ledger entry. Bound to `key_hash`; there is no transfer instruction.
#[account]
#[derive(InitSpace)]
pub struct BushelLot {
    pub commitment: Pubkey,
    pub lot_id: u32,
    /// Hash of the buyer's API key; redemption is only ever issued to this key.
    pub key_hash: [u8; 32],
    pub grade: u8,
    pub tokens: u64,
    pub window_start: i64,
    pub window_end: i64,
    /// USDC the buyer actually paid. The only figure a refund can ever reference. At most the lot's share of the
    /// commitment at the price the commitment was made at, and all lots of a commitment together at most its `value`.
    pub price_paid: u64,
    pub redeemed: bool,
    pub redeemed_at: i64,
    /// Set once a shortfall claim for this lot has been filed against the host's bond.
    pub shortfall_claimed: bool,
    /// `price_paid * unserved_tokens / commitment.tokens` filed as the bond claim.
    pub refund_amount: u64,
    /// Commitment on another host of the same grade that honours the unserved part, if any.
    pub rehomed_to: Option<Pubkey>,
    pub bump: u8,
}

/// HVX: hourly $/1M-token index per grade, built off-chain from wash-filtered receipts.
///
/// This account is a PUBLIC STATISTIC ONLY. It is write-only by `hvx_authority`, is never read
/// by any instruction in this program or in `trellis_bond`, and NOTHING SETTLES AGAINST IT:
/// shortfall refunds use `BushelLot.price_paid`, sales use `CapacityConfig.grade_prices`.
#[account]
#[derive(InitSpace)]
pub struct HvxFeed {
    pub grade: u8,
    /// Unix hour (unix_timestamp / 3600) the value refers to. Never ahead of the chain clock's hour and never going
    /// back.
    pub hour: i64,
    /// Index value in micro-USD per 1M output-equivalent tokens.
    pub usd_per_mtoken: u64,
    /// True when the day's volume behind the index is below $50k.
    pub thin: bool,
    pub updated_at: i64,
    pub bump: u8,
}

/// Value of `tokens` at `price_per_bushel`, rounded up to the next micro-USDC.
pub fn tokens_value(tokens: u64, price_per_bushel: u64) -> Option<u64> {
    let num = (tokens as u128).checked_mul(price_per_bushel as u128)?;
    let denom = TOKENS_PER_BUSHEL as u128;
    let v = num.div_ceil(denom);
    u64::try_from(v).ok()
}

/// `price_paid * unserved / total`, rounded down. Never references any index price.
pub fn pro_rata(price_paid: u64, unserved: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return Some(0);
    }
    let num = (price_paid as u128).checked_mul(unserved as u128)?;
    u64::try_from(num / total as u128).ok()
}

/// The fields `update_config` / `propose_config` may change. `None` leaves a field as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, InitSpace)]
pub struct UpdateConfigArgs {
    /// Hand the authority over. Only through the timelock, and the new authority must sign the apply.
    pub new_authority: Option<Pubkey>,
    pub sale_authority: Option<Pubkey>,
    pub hvx_authority: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub grade_prices: Option<[u64; GRADE_COUNT]>,
    pub max_outstanding_value: Option<u64>,
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
    pub claim_period: i64,
}
