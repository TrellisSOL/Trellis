use anchor_lang::prelude::*;

#[event]
pub struct CapacityConfigUpdated {
    pub authority: Pubkey,
    pub sale_authority: Pubkey,
    pub hvx_authority: Pubkey,
    pub guardian: Pubkey,
    pub grade_prices: [u64; 3],
    pub max_outstanding_value: u64,
}

#[event]
pub struct CapacityPauseChanged {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

#[event]
pub struct CapacityCommitted {
    pub commitment: Pubkey,
    pub host: Pubkey,
    pub host_bond: Pubkey,
    pub commitment_id: u64,
    pub grade: u8,
    pub tokens: u64,
    pub window_start: i64,
    pub window_end: i64,
    pub value: u64,
}

#[event]
pub struct LotSold {
    pub lot: Pubkey,
    pub commitment: Pubkey,
    pub lot_id: u32,
    pub key_hash: [u8; 32],
    pub grade: u8,
    pub tokens: u64,
    pub window_start: i64,
    pub window_end: i64,
    pub price_paid: u64,
}

/// Credits of `grade` for `tokens` are issued off-chain to `key_hash` against this event.
#[event]
pub struct LotRedeemed {
    pub lot: Pubkey,
    pub commitment: Pubkey,
    pub key_hash: [u8; 32],
    pub grade: u8,
    pub tokens: u64,
    pub redeemed_at: i64,
}

#[event]
pub struct ShortfallReported {
    pub commitment: Pubkey,
    pub host: Pubkey,
    pub tokens: u64,
    pub unserved_tokens: u64,
    pub settled: bool,
}

#[event]
pub struct LotRehomed {
    pub lot: Pubkey,
    pub from_commitment: Pubkey,
    pub to_commitment: Pubkey,
    pub tokens_rehomed: u64,
}

/// `refund_amount = price_paid * unserved_tokens / committed_tokens`; filed against the host bond.
#[event]
pub struct LotShortfallClaimed {
    pub lot: Pubkey,
    pub commitment: Pubkey,
    pub host_bond: Pubkey,
    pub proposal: Pubkey,
    pub key_hash: [u8; 32],
    pub refund_amount: u64,
}

#[event]
pub struct HvxPublished {
    pub grade: u8,
    pub hour: i64,
    pub usd_per_mtoken: u64,
    pub thin: bool,
}

/// A commitment was settled and its bond lock released without a report, after the claim period.
#[event]
pub struct CommitmentReleased {
    pub commitment: Pubkey,
    pub host: Pubkey,
    pub value: u64,
}

#[event]
pub struct CapacityConfigProposed {
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
    pub changes_authority: bool,
    pub changes_guardian: bool,
}

/// A pending config change was applied (`applied = true`) or dropped.
#[event]
pub struct CapacityConfigProposalResolved {
    pub applied: bool,
    pub by: Pubkey,
}
