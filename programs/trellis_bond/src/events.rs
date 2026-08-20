use anchor_lang::prelude::*;

use crate::state::{DisputeStatus, SlashReason};

#[event]
pub struct BondConfigUpdated {
    pub authority: Pubkey,
    pub slasher: Pubkey,
    pub guardian: Pubkey,
    pub min_bond: u64,
}

#[event]
pub struct BondPauseChanged {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

#[event]
pub struct BondPosted {
    pub bond: Pubkey,
    pub host: Pubkey,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct UnbondRequested {
    pub bond: Pubkey,
    pub host: Pubkey,
    pub unbond_at: i64,
}

#[event]
pub struct UnbondCancelled {
    pub bond: Pubkey,
    pub host: Pubkey,
}

#[event]
pub struct BondWithdrawn {
    pub bond: Pubkey,
    pub host: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SlashProposed {
    pub bond: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub reason: SlashReason,
    pub bps: u16,
    pub fixed_amount: u64,
    pub refund_amount: u64,
    pub evidence_hash: [u8; 32],
    pub window_end: i64,
}

#[event]
pub struct SlashDisputed {
    pub bond: Pubkey,
    pub proposal: Pubkey,
    pub disputed_at: i64,
}

#[event]
pub struct DisputeResolved {
    pub bond: Pubkey,
    pub proposal: Pubkey,
    pub status: DisputeStatus,
}

#[event]
pub struct SlashExecuted {
    pub bond: Pubkey,
    pub proposal: Pubkey,
    pub reason: SlashReason,
    pub amount: u64,
    pub to_refund_pool: u64,
    pub to_treasury: u64,
    pub to_capacity_refund: u64,
    pub strikes: u16,
    pub remaining_bond: u64,
}

#[event]
pub struct ProposalClosed {
    pub bond: Pubkey,
    pub proposal: Pubkey,
}

#[event]
pub struct BondLockChanged {
    pub bond: Pubkey,
    pub locked: u64,
}

#[event]
pub struct BondConfigProposed {
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
    pub changes_authority: bool,
    pub changes_guardian: bool,
    /// The proposal names another program address as the one allowed to lock bonds and file capacity claims.
    pub changes_capacity_claimer: bool,
    /// The proposal replaces the refund pool, the treasury or the capacity refund account.
    pub changes_payout_accounts: bool,
}

/// A pending config change was applied (`applied = true`) or dropped.
#[event]
pub struct BondConfigProposalResolved {
    pub applied: bool,
    pub by: Pubkey,
}

/// The authority proposed to clear `delisted` / `ejected` on a bond; it can be applied from `effective_at`.
#[event]
pub struct ReinstateProposed {
    pub bond: Pubkey,
    pub host: Pubkey,
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
}

/// A pending reinstatement was applied (`applied = true`: the bond is listed again) or dropped.
#[event]
pub struct ReinstateResolved {
    pub bond: Pubkey,
    pub host: Pubkey,
    pub applied: bool,
    pub by: Pubkey,
}
