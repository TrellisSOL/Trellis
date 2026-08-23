use anchor_lang::prelude::*;

#[error_code]
pub enum FeeRouterError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("workers_bps + treasury_bps must equal 10,000")]
    InvalidSplit,
    #[msg("Token account mint does not match the configured mint")]
    MintMismatch,
    #[msg("$TRLS mint must be owned by the Token-2022 program")]
    NotToken2022Mint,
    #[msg("Period must be greater than the last distributed period")]
    PeriodNotIncreasing,
    #[msg("Fee vault is empty")]
    NothingToDistribute,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid configuration value")]
    InvalidConfigValue,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Period is later than the current week")]
    PeriodInFuture,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The fee vault, the workers vault and the treasury vault must be three different accounts")]
    DuplicateVault,
}
