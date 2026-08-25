use anchor_lang::prelude::*;

#[event]
pub struct TabConfigUpdated {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub rules_program: Pubkey,
    pub max_cap: u64,
}

#[event]
pub struct TabPauseChanged {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

#[event]
pub struct TabOpened {
    pub tab: Pubkey,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub session_key: Pubkey,
    pub mint: Pubkey,
    pub tab_id: u64,
    pub cap: u64,
    pub expiry: i64,
    pub rulebook: Option<Pubkey>,
}

#[event]
pub struct TabToppedUp {
    pub tab: Pubkey,
    pub amount: u64,
    pub cap: u64,
}

#[event]
pub struct VoucherPosted {
    pub tab: Pubkey,
    pub cumulative_used: u64,
    pub seq: u64,
}

#[event]
pub struct TabClosed {
    pub tab: Pubkey,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub used: u64,
    pub refunded: u64,
    pub seq: u64,
}

#[event]
pub struct TabReclaimed {
    pub tab: Pubkey,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub paid_to_payee: u64,
    pub refunded: u64,
}

/// Part of a tab's escrow could not be paid out because its owner's token account was missing, closed or frozen. It
/// stays in escrow and anyone can deliver it later with `reclaim`.
#[event]
pub struct TabSettlementDeferred {
    pub tab: Pubkey,
    pub owed_to_payee: u64,
    pub owed_to_payer: u64,
}

#[event]
pub struct TabConfigProposed {
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
    pub changes_authority: bool,
    pub changes_guardian: bool,
}

/// A pending config change was applied (`applied = true`) or dropped.
#[event]
pub struct TabConfigProposalResolved {
    pub applied: bool,
    pub by: Pubkey,
}
