use anchor_lang::prelude::*;

#[error_code]
pub enum CreditsError {
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Deposit would exceed max_balance_per_key")]
    MaxBalanceExceeded,
    #[msg("Credit account is closed")]
    AccountClosed,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Hour must be a non-negative multiple of 3600")]
    InvalidHour,
    #[msg("Hour must be greater than the last committed hour")]
    HourNotIncreasing,
    #[msg("Settlement would exceed the committed spend total")]
    SettlementExceedsCommittedSpend,
    #[msg("Refund delay has not elapsed")]
    RefundDelayNotElapsed,
    #[msg("Refund request already paid")]
    RefundAlreadyPaid,
    #[msg("Refund amount exceeds the requested amount")]
    RefundExceedsRequest,
    #[msg("Refund destination does not match the request")]
    InvalidRefundDestination,
    #[msg("Credit account has not expired")]
    NotExpired,
    #[msg("Expiry notice already given")]
    ExpiryNoticeAlreadyGiven,
    #[msg("Expiry notice has not been given")]
    ExpiryNoticeMissing,
    #[msg("Expiry grace period has not elapsed")]
    GracePeriodNotElapsed,
    #[msg("Credit balance is zero")]
    EmptyBalance,
    #[msg("Token account mint does not match the configured USDC mint")]
    MintMismatch,
    #[msg("Invalid configuration value")]
    InvalidConfigValue,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Value is outside the bounds this program enforces")]
    OutOfBounds,
    #[msg("This change loosens a safety parameter: use propose_config and apply_config after the timelock")]
    RequiresTimelock,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Signer's public key does not hash to this key_hash")]
    NotTheKey,
    #[msg("Hour is in the future")]
    HourInFuture,
    #[msg("Committed spend would exceed what the vault holds")]
    SpendExceedsVault,
    #[msg("Settlement would exceed the per-window outflow limit")]
    SettleRateLimited,
    #[msg("Settlements are paused")]
    SettlementsPaused,
    #[msg("Sweep amount exceeds the key's on-chain balance")]
    SweepExceedsBalance,
    #[msg("Key hash must not be all zero")]
    InvalidKeyHash,
    #[msg("Refund would exceed the per-window refund limit; pay the rest later")]
    RefundRateLimited,
    #[msg("Refund would exceed what this depositor put in")]
    RefundExceedsShare,
    #[msg("This closure has already been paid in part or in full and can no longer be cancelled")]
    RefundInProgress,
    #[msg("Only whoever requested this closure, or the key's registered owner wallet, can cancel it")]
    NotRequesterOrOwner,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The guardian paused recently and must wait before pausing again; the authority can pause at any time")]
    GuardianCooldown,
    #[msg("The account already has the current layout")]
    AlreadyMigrated,
    #[msg("The account is not one this instruction migrates")]
    NotMigratable,
    #[msg("The key cancelled a closure recently and cannot cancel another yet; the registered owner wallet can")]
    KeyCancelCooldown,
    #[msg("Deposit is below the minimum deposit")]
    DepositTooSmall,
    #[msg("The key has no registered owner wallet")]
    NoOwner,
    #[msg("The new owner wallet must sign")]
    OwnerMustSign,
}
