use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub settlement_authority: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub treasury_token_account: Pubkey,
    pub max_balance_per_key: u64,
}

#[event]
pub struct ConfigUpdated {
    pub settlement_authority: Pubkey,
    pub guardian: Pubkey,
    pub treasury_token_account: Pubkey,
    pub max_balance_per_key: u64,
    pub credit_ttl: i64,
    pub refund_delay: i64,
    pub expiry_grace: i64,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct DepositsPausedSet {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

#[event]
pub struct Deposited {
    pub key_hash: [u8; 32],
    pub depositor: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
    pub expires_at: i64,
}

#[event]
pub struct KeyAuthorityChanged {
    pub key_hash: [u8; 32],
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct SpentRootCommitted {
    pub hour: i64,
    pub root: [u8; 32],
    pub spent_delta: u64,
    pub spent_total: u64,
}

#[event]
pub struct SettledToHost {
    pub host_token_account: Pubkey,
    pub amount: u64,
    pub hour_root_ref: i64,
    pub settled_total: u64,
}

#[event]
pub struct CloseRequested {
    pub key_hash: [u8; 32],
    pub amount: u64,
    pub requested_at: i64,
    pub payable_at: i64,
}

/// Emitted with `CloseRequested`: who asked for the closure (the key's own address, or the key's registered owner
/// wallet). Only that party or the owner can cancel it. A separate event so that `CloseRequested` keeps its layout.
#[event]
pub struct CloseRequester {
    pub key_hash: [u8; 32],
    pub requested_by: Pubkey,
}

/// A queued closure was withdrawn before anything was paid: the key is open again with its balance.
#[event]
pub struct CloseCancelled {
    pub key_hash: [u8; 32],
    pub amount: u64,
    pub by: Pubkey,
}

#[event]
pub struct RefundPaid {
    pub key_hash: [u8; 32],
    pub amount: u64,
    pub refund_to: Pubkey,
    /// The wallet whose deposits this refund returns.
    pub depositor: Pubkey,
}

/// A depositor named another token account for its refunds from one key.
#[event]
pub struct RefundDestinationSet {
    pub key_hash: [u8; 32],
    pub depositor: Pubkey,
    pub refund_to: Pubkey,
}

#[event]
pub struct ExpiryNoticed {
    pub key_hash: [u8; 32],
    pub balance: u64,
    pub notice_at: i64,
    pub sweepable_at: i64,
}

#[event]
pub struct ExpiredSwept {
    pub key_hash: [u8; 32],
    pub amount: u64,
    pub treasury_token_account: Pubkey,
}

#[event]
pub struct ConfigProposed {
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
    pub changes_authority: bool,
    pub changes_guardian: bool,
    pub changes_settlement_authority: bool,
}

#[event]
pub struct ConfigProposalCancelled {
    pub by: Pubkey,
}

#[event]
pub struct ConfigProposalApplied {
    pub by: Pubkey,
}

#[event]
pub struct SettlementsPausedSet {
    pub paused: bool,
    pub by: Pubkey,
    /// When the pause lapses by itself (0 when `paused` is false).
    pub paused_until: i64,
}

/// `spent_total` was written down to `settled_total` (a timelocked repair).
#[event]
pub struct SpentTotalWrittenDown {
    pub from: u64,
    pub to: u64,
}

#[event]
pub struct SettleRateSet {
    pub rate_bps: u16,
}

/// The absolute bound on one window's outflow (each of the two allowances), as it stands after a config change.
#[event]
pub struct OutflowCapSet {
    pub cap_per_window: u64,
}
