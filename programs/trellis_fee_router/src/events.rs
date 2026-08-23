use anchor_lang::prelude::*;

#[event]
pub struct FeeConfigInitialized {
    pub authority: Pubkey,
    pub fee_mint: Pubkey,
    pub trls_mint: Pubkey,
    pub fee_vault: Pubkey,
    pub trls_vault: Pubkey,
    pub workers_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub workers_bps: u16,
    pub treasury_bps: u16,
}

#[event]
pub struct FeeConfigUpdated {
    pub workers_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub workers_bps: u16,
    pub treasury_bps: u16,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct FeesDistributed {
    pub period: i64,
    pub total: u64,
    pub workers_amount: u64,
    pub treasury_amount: u64,
    pub distributed_at: i64,
}

#[event]
pub struct InferencePaymentBurned {
    pub amount: u64,
    pub burned_total: u64,
}

#[event]
pub struct ChangeProposed {
    pub new_authority: Option<Pubkey>,
    pub workers_vault: Option<Pubkey>,
    pub treasury_vault: Option<Pubkey>,
    pub effective_at: i64,
}
