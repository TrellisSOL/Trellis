use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub enforcer: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub guardian: Pubkey,
    pub enforcer: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct NewRulebooksPausedSet {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

/// A pending config change was applied (`applied = true`) or dropped.
#[event]
pub struct ConfigProposalResolved {
    pub applied: bool,
    pub by: Pubkey,
}

#[event]
pub struct RulebookCreated {
    pub rulebook: Pubkey,
    pub owner: Pubkey,
    pub rulebook_id: u64,
    pub per_call_max: u64,
    pub daily_max: u64,
    pub payee_allowlist_root: [u8; 32],
    pub model_allowlist_root: [u8; 32],
    pub ask_first_above: u64,
    pub expiry: i64,
}

#[event]
pub struct RulebookUpdated {
    pub rulebook: Pubkey,
    pub per_call_max: u64,
    pub daily_max: u64,
    pub payee_allowlist_root: [u8; 32],
    pub model_allowlist_root: [u8; 32],
    pub ask_first_above: u64,
    pub expiry: i64,
}

#[event]
pub struct RulebookKilled {
    pub rulebook: Pubkey,
    pub owner: Pubkey,
    pub killed_at: i64,
}

#[event]
pub struct RulebookClosed {
    pub rulebook: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct SpendRecorded {
    pub rulebook: Pubkey,
    pub day: i64,
    pub amount: u64,
    pub spent_today: u64,
    pub by: Pubkey,
}

#[event]
pub struct ConfigProposed {
    pub new_authority: Option<Pubkey>,
    pub guardian: Option<Pubkey>,
    pub enforcer: Option<Pubkey>,
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
}

#[event]
pub struct CommitmentRecorded {
    pub rulebook: Pubkey,
    pub day: i64,
    pub amount: u64,
    pub spent_today: u64,
    pub by: Pubkey,
}
