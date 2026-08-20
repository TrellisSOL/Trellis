//! Account state for `trellis_bond`.
//!
//! PDA seeds (all derived from this program id):
//!
//! | Account         | Seeds                                              |
//! | --------------- | -------------------------------------------------- |
//! | `BondConfig`    | `["config"]`                                       |
//! | `HostBond`      | `["bond", host]`                                   |
//! | bond vault      | `["vault", host_bond]` (SPL token account, owner = `HostBond`) |
//! | `SlashProposal` | `["proposal", host_bond, proposal_id.to_le_bytes()]` |
//! | `BondLock`      | `["lock", host_bond]` (amount locked behind capacity commitments) |
//! | `SlashLedger`   | `["slash_ledger", host_bond]` (slashes of the last two windows, pending capacity claims) |
//! | `PendingConfig` | `["pending_config"]`                               |
//! | `PendingReinstate` | `["pending_reinstate", host_bond]` (a reinstatement waiting out the timelock) |
//!
//! All USDC amounts are in base units (6 decimals, i.e. micro-USDC).

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const BOND_SEED: &[u8] = b"bond";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const LOCK_SEED: &[u8] = b"lock";
pub const PENDING_CONFIG_SEED: &[u8] = b"pending_config";
pub const SLASH_LEDGER_SEED: &[u8] = b"slash_ledger";
pub const PENDING_REINSTATE_SEED: &[u8] = b"pending_reinstate";

pub const USDC_DECIMALS: u8 = 6;
/// Default minimum bond: 10,000 USDC (spec section 5.3).
pub const DEFAULT_MIN_BOND: u64 = 10_000_000_000;
/// Default unbond period: 14 days.
pub const DEFAULT_UNBOND_PERIOD: i64 = 14 * 24 * 60 * 60;
/// Default public dispute window: 72 hours.
pub const DEFAULT_DISPUTE_WINDOW: i64 = 72 * 60 * 60;
/// Default maximum time a filed dispute blocks execution: 7 days.
pub const DEFAULT_DISPUTE_BLOCK: i64 = 7 * 24 * 60 * 60;
pub const BPS_DENOMINATOR: u64 = 10_000;

// ---- Floors and bounds the authority cannot bypass -----------------------------------------------------------------
//
// `initialize_config`, `update_config` and `propose_config` reject a value outside [MIN, MAX], so no key can remove
// the dispute window, shorten the unbond period, or stretch a delay until it blocks its own instruction. A change that
// loosens safety (see `instructions::config`) additionally waits `CONFIG_TIMELOCK`; tightening is immediate.
//
// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY. It compiles the short values in the
// second block. A mainnet build must be made WITHOUT `--features devnet`; the default build carries the mainnet values
// and tests/floors.ts asserts it.

#[cfg(not(feature = "devnet"))]
mod profile {
    /// A slash proposal can never execute sooner than 72 hours after it is opened.
    pub const MIN_DISPUTE_WINDOW: i64 = 72 * 60 * 60;
    /// A filed dispute blocks execution for at least 7 days unless the authority resolves it.
    pub const MIN_DISPUTE_BLOCK: i64 = 7 * 24 * 60 * 60;
    /// Unbonding never takes less than 14 days (the time slashing evidence has to arrive).
    pub const MIN_UNBOND_PERIOD: i64 = 14 * 24 * 60 * 60;
    /// The period the cumulative slash cap is stated over: 30 days (`MAX_SLASH_BPS_PER_WINDOW`).
    pub const SLASH_WINDOW: i64 = 30 * 24 * 60 * 60;
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
    pub const MIN_DISPUTE_WINDOW: i64 = 1;
    pub const MIN_DISPUTE_BLOCK: i64 = 1;
    pub const MIN_UNBOND_PERIOD: i64 = 1;
    pub const SLASH_WINDOW: i64 = 120;
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

/// Upper bounds: a host's withdrawal or a slash can never be delayed without limit (or until a timestamp overflows).
pub const MAX_DISPUTE_WINDOW: i64 = 30 * 24 * 60 * 60;
pub const MAX_DISPUTE_BLOCK: i64 = 90 * 24 * 60 * 60;
pub const MAX_UNBOND_PERIOD: i64 = 90 * 24 * 60 * 60;
/// One rate-based proposal can never carry more than 50% of a bond, whatever the reason and however many days or
/// incidents it counts (the largest schedule entry, a shadow-mismatch slash, is exactly this).
pub const MAX_SLASH_BPS_PER_PROPOSAL: u16 = 5_000;
/// All rate-based slashes of one bond executed within any `SLASH_WINDOW` (30 days) take at most 50% of it, however
/// many proposals carry them (`SlashLedger`). Before this, N proposals of 50% each left 0.5^N of a bond within one
/// dispute window. Capacity-shortfall claims are not rates and are not counted under this cap. What bounds them is
/// enforced in two places (security review round 3, R3-16):
///
/// - here, `file_capacity_claim` takes a claim's amount out of `BondLock.locked`, the USDC the host locked behind its own
///   commitments, and refuses a claim larger than what is still locked. All capacity claims against a bond together can
///   therefore never exceed what its commitments locked, and `execute_slash` pays a claim at most its filed amount;
/// - in `trellis_capacity`, the lots recorded against one commitment never sum to more than that commitment's value at
///   the price fixed when the host made it, and the claims filed against it never to more than that value.
///
/// Nothing here checks which commitment a claim belongs to: that part rests on `trellis_capacity` being the program
/// behind `BondConfig.capacity_claimer` (replacing it is a timelocked config change).
pub const MAX_SLASH_BPS_PER_WINDOW: u16 = 5_000;
/// The minimum bond can never be set above 1,000,000 USDC, and it changes only through the timelock: raising it
/// makes every smaller bond inactive (security re-review RR-10).
pub const MAX_MIN_BOND: u64 = 1_000_000_000_000;

/// Slash schedule from Backend spec section 5.3, encoded as reason codes.
///
/// | Code | Evidence                                            | Slash                       |
/// | ---- | --------------------------------------------------- | --------------------------- |
/// | 0    | Empty-200 > 2% over 24h                             | 1% (100 bps)                |
/// | 1    | Quantization swap (3/3 canaries)                    | 25% (2500 bps) + delist     |
/// | 2    | Uptime < 95% over 30 days                           | 0.5% (50 bps) per day       |
/// | 3    | Shadow re-execution mismatch                        | 50% (5000 bps) + ejection   |
/// | 4    | SEALED served without fresh attestation             | 5% (500 bps) per incident   |
/// | 5    | Capacity commitment under-delivered (section 5.6)   | exact purchase price of the unserved Bushels (fixed amount, never a rate) |
/// Borsh encodes variants by declaration order, which matches the reason codes above.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum SlashReason {
    EmptyTwoHundred,
    QuantizationSwap,
    UptimeBelow95,
    ShadowMismatch,
    SealedWithoutAttestation,
    CapacityShortfall,
}

impl SlashReason {
    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::EmptyTwoHundred),
            1 => Some(Self::QuantizationSwap),
            2 => Some(Self::UptimeBelow95),
            3 => Some(Self::ShadowMismatch),
            4 => Some(Self::SealedWithoutAttestation),
            5 => Some(Self::CapacityShortfall),
            _ => None,
        }
    }

    /// Schedule entry: `(unit_bps, per_unit)`.
    /// `per_unit == false` means the bps must equal `unit_bps` exactly;
    /// `per_unit == true` means the bps must be a positive multiple of `unit_bps`
    /// (one unit per day / per incident).
    /// `None` means the reason is a fixed amount, not a rate.
    pub fn schedule(self) -> Option<(u16, bool)> {
        match self {
            Self::EmptyTwoHundred => Some((100, false)),
            Self::QuantizationSwap => Some((2_500, false)),
            Self::UptimeBelow95 => Some((50, true)),
            Self::ShadowMismatch => Some((5_000, false)),
            Self::SealedWithoutAttestation => Some((500, true)),
            Self::CapacityShortfall => None,
        }
    }

    pub fn delists(self) -> bool {
        matches!(self, Self::QuantizationSwap | Self::ShadowMismatch)
    }

    pub fn ejects(self) -> bool {
        matches!(self, Self::ShadowMismatch)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DisputeStatus {
    /// No dispute filed.
    None,
    /// Host filed a dispute inside the window; awaiting `resolve_dispute` or the 7-day timeout.
    Open,
    /// Authority upheld the slash; execution may proceed once the window has closed.
    Upheld,
    /// Authority rejected the slash; the proposal can never execute.
    Rejected,
}

/// Program configuration. Production `authority` is a Squads v4 2-of-3 multisig;
/// `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new bonds, never move funds.
#[account]
#[derive(InitSpace)]
pub struct BondConfig {
    pub authority: Pubkey,
    /// Account allowed to open slash proposals (the `slasher` service, behind the multisig).
    pub slasher: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    /// Token account that receives the share of a slash earmarked for affected callers.
    pub refund_pool: Pubkey,
    /// Token account that receives the remainder of a slash.
    pub treasury: Pubkey,
    /// PDA of `trellis_capacity` allowed to file capacity-shortfall claims via CPI.
    pub capacity_claimer: Pubkey,
    /// Token account that receives capacity-shortfall payouts (purchase price of unserved Bushels).
    pub capacity_refund: Pubkey,
    pub min_bond: u64,
    pub unbond_period: i64,
    pub dispute_window: i64,
    pub dispute_block: i64,
    pub paused: bool,
    pub bump: u8,    /// When the pause lapses by itself (`PAUSE_TTL` after it was last set). `paused` is in force only until then.
    pub paused_until: i64,
    /// The guardian may not pause again before this time (`GUARDIAN_PAUSE_COOLDOWN` after its last pause was due to
    /// lapse).
    pub guardian_pause_ready_at: i64,
}

impl BondConfig {
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
pub struct HostBond {
    pub host: Pubkey,
    /// Bonded USDC currently held in the vault and not yet slashed.
    pub amount: u64,
    /// Unix time after which `withdraw_bond` is allowed; 0 = no unbond requested.
    pub unbond_at: i64,
    /// Number of executed slashes against this host.
    pub strikes: u16,
    /// Total USDC slashed over the life of the bond.
    pub slashed_total: u64,
    /// Proposals that are neither executed nor rejected.
    pub open_proposals: u16,
    /// Next proposal id to be assigned (ids are monotonically increasing).
    pub next_proposal_id: u64,
    /// Set by a quantization-swap or shadow-mismatch slash that took something (not by one the cumulative cap cut to
    /// zero). Blocks new capacity commitments. Cleared only by the authority, through `propose_reinstate` and its
    /// timelock.
    pub delisted: bool,
    /// Set by a shadow-mismatch slash that took something. Cleared the same way.
    pub ejected: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl HostBond {
    /// A bond backs new commitments only when it is fully funded, not unbonding and not delisted.
    pub fn is_active(&self, min_bond: u64) -> bool {
        self.amount >= min_bond && self.unbond_at == 0 && !self.delisted && !self.ejected
    }
}

#[account]
#[derive(InitSpace)]
pub struct SlashProposal {
    pub bond: Pubkey,
    pub proposal_id: u64,
    pub evidence_hash: [u8; 32],
    pub reason: SlashReason,
    /// Rate for rate-based reasons; 0 for `CapacityShortfall`.
    pub bps: u16,
    /// Fixed amount for `CapacityShortfall`; 0 for rate-based reasons.
    pub fixed_amount: u64,
    /// Portion of the slash routed to `refund_pool` (rate-based reasons only).
    pub refund_amount: u64,
    pub proposed_at: i64,
    /// `proposed_at + dispute_window`.
    pub window_end: i64,
    pub dispute_status: DisputeStatus,
    pub disputed_at: i64,
    pub executed: bool,
    pub executed_amount: u64,
    /// Account that paid the proposal's rent; refunded by `close_proposal`.
    pub rent_payer: Pubkey,
    pub bump: u8,
    /// When an open dispute stops blocking execution: `disputed_at` plus the dispute block AS IT WAS when the host
    /// disputed. A later change of the block does not move it (security re-review RR-10). 0 until disputed, and on a
    /// proposal created before this field existed (then `disputed_at + config.dispute_block` applies).
    pub unblock_at: i64,
}

impl SlashProposal {
    /// Account size before `unblock_at` was appended (`migrate_proposal`).
    pub const LEGACY_LEN: usize = 8 + Self::INIT_SPACE - 8;

    pub fn is_open(&self) -> bool {
        !self.executed && self.dispute_status != DisputeStatus::Rejected
    }
}

/// USDC of a bond that is locked behind open capacity commitments. PDA `["lock", host_bond]`.
///
/// `trellis_capacity` raises it when a host commits capacity (`lock_bond`, by the commitment's value) and lowers it
/// when the commitment is settled (`unlock_bond`, by what was not claimed). `withdraw_bond` pays `amount - locked`, so a
/// host cannot commit capacity, unbond and leave before a shortfall claim arrives. A shortfall claim is paid for out of
/// the lock: `file_capacity_claim` moves its amount from `locked` to `SlashLedger.pending_claims` and refuses a claim
/// larger than `locked`, so claims can never take more of a bond than its commitments locked (R3-16).
#[account]
#[derive(InitSpace)]
pub struct BondLock {
    pub bond: Pubkey,
    pub locked: u64,
    pub bump: u8,
}

/// What has recently been slashed from a bond, and what capacity claims are still open against it.
/// PDA `["slash_ledger", host_bond]`, created with the bond's first proposal.
///
/// Cumulative slash cap: time is cut into fixed windows of `SLASH_WINDOW`; `slashed_current` and `slashed_previous`
/// are the rate-based slashes executed in the window `now` falls in and in the one before. A slash may only bring
/// their sum up to `MAX_SLASH_BPS_PER_WINDOW` of the bond as it stood before them. Any interval of `SLASH_WINDOW`
/// lies inside two adjacent fixed windows, so no such interval ever sees more than the cap: there is no boundary to
/// straddle (the flaw of a single resetting bucket, security re-review RR-01).
///
/// `pending_claims` is the sum of the capacity-shortfall claims filed and not yet executed or rejected. Each was taken
/// out of `BondLock.locked` when it was filed. It counts against the bond's headroom for new commitments (`lock_bond`),
/// so headroom stays taken until every claim against a commitment is paid or dropped (RR-07).
#[account]
#[derive(InitSpace)]
pub struct SlashLedger {
    pub bond: Pubkey,
    /// `unix_timestamp / SLASH_WINDOW` of `slashed_current`.
    pub window_index: i64,
    pub slashed_current: u64,
    pub slashed_previous: u64,
    pub pending_claims: u64,
    pub bump: u8,
}

impl SlashLedger {
    /// Move to the fixed window `now` falls in.
    pub fn roll(&mut self, now: i64) {
        let index = now.div_euclid(SLASH_WINDOW);
        if index == self.window_index {
            return;
        }
        self.slashed_previous = if index == self.window_index.saturating_add(1) { self.slashed_current } else { 0 };
        self.slashed_current = 0;
        self.window_index = index;
    }

    /// How much more a rate-based slash may take from a bond of `bond_amount` right now (call `roll` first).
    pub fn room(&self, bond_amount: u64) -> u64 {
        let recent = self.slashed_current.saturating_add(self.slashed_previous);
        // The bond as it stood before the slashes of these two windows.
        let base = (bond_amount as u128) + (recent as u128);
        let cap = base * (MAX_SLASH_BPS_PER_WINDOW as u128) / (BPS_DENOMINATOR as u128);
        (cap.min(u64::MAX as u128) as u64).saturating_sub(recent)
    }
}

/// The fields `update_config` / `propose_config` may change. `None` leaves a field as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, InitSpace)]
pub struct UpdateConfigArgs {
    /// Hand the authority over. Only through the timelock, and the new authority must sign the apply.
    pub new_authority: Option<Pubkey>,
    pub slasher: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub capacity_claimer: Option<Pubkey>,
    pub min_bond: Option<u64>,
    pub unbond_period: Option<i64>,
    pub dispute_window: Option<i64>,
    pub dispute_block: Option<i64>,
}

/// A loosening config change waiting out `CONFIG_TIMELOCK`. PDA `["pending_config"]`; one at a time.
#[account]
#[derive(InitSpace)]
pub struct PendingConfig {
    pub args: UpdateConfigArgs,
    /// Replacement payout accounts (mint-checked at proposal), if any.
    pub refund_pool: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub capacity_refund: Option<Pubkey>,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// A reinstatement of a delisted or ejected bond waiting out `CONFIG_TIMELOCK`. PDA `["pending_reinstate", host_bond]`;
/// one per bond. It loosens (a host that was removed for cheating may back commitments again), so it takes the same
/// 24 hours, the same 7-day expiry and the same authority-only cancel as a config change.
#[account]
#[derive(InitSpace)]
pub struct PendingReinstate {
    pub bond: Pubkey,
    /// `HostBond.strikes` when this was proposed. A slash executed since then makes the proposal stale: it cannot
    /// clear a delisting it was not proposed for.
    pub strikes: u16,
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
    pub min_dispute_window: i64,
    pub min_dispute_block: i64,
    pub min_unbond_period: i64,
    pub slash_window: i64,
}
