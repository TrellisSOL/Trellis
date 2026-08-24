use anchor_lang::prelude::*;

#[error_code]
pub enum RulesError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Creating new rulebooks is paused")]
    NewRulebooksPaused,
    #[msg("Rulebook has been killed")]
    RulebookKilled,
    #[msg("Rulebook has expired")]
    RulebookExpired,
    #[msg("Rulebook is still active; kill it or wait for expiry before closing")]
    RulebookStillActive,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount exceeds per_call_max")]
    PerCallMaxExceeded,
    #[msg("Spend would exceed daily_max")]
    DailyMaxExceeded,
    #[msg("Day is not the current or previous UTC day")]
    InvalidDay,
    #[msg("Invalid rulebook parameters")]
    InvalidParams,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Spend can only be recorded for the day already being counted or a later one")]
    DayRegression,
    #[msg("A killed rulebook stays on chain as a tombstone and cannot be closed")]
    KilledRulebookIsPermanent,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The guardian paused recently and must wait before pausing again; the authority can pause at any time")]
    GuardianCooldown,
    #[msg("The account already has the current layout")]
    AlreadyMigrated,
    #[msg("The account is not one this instruction migrates")]
    NotMigratable,
}
