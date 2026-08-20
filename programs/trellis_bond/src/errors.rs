use anchor_lang::prelude::*;

#[error_code]
pub enum BondError {
    #[msg("Signer is not the program authority")]
    Unauthorized,
    #[msg("Signer is not the slasher authority")]
    NotSlasher,
    #[msg("Signer is not the configured capacity claimer PDA")]
    NotCapacityClaimer,
    #[msg("Signer is neither the guardian nor the authority")]
    NotGuardian,
    #[msg("New bonds are paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Bond total would be below the minimum bond")]
    BelowMinimumBond,
    #[msg("Token account mint does not match the configured USDC mint")]
    MintMismatch,
    #[msg("Token account owner does not match the expected owner")]
    TokenOwnerMismatch,
    #[msg("Unbond has not been requested")]
    UnbondNotRequested,
    #[msg("Unbond already requested")]
    UnbondAlreadyRequested,
    #[msg("Unbond period has not elapsed")]
    UnbondPeriodNotElapsed,
    #[msg("Bond has open slash proposals; withdraw is blocked")]
    OpenProposals,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Slash bps is not valid for this reason code")]
    InvalidSlashBps,
    #[msg("Slash bps exceeds 10000")]
    BpsTooLarge,
    #[msg("Unknown slash reason code")]
    UnknownReasonCode,
    #[msg("Fixed-amount claims must use the capacity-shortfall path")]
    UseCapacityClaim,
    #[msg("Refund amount exceeds the slash amount")]
    RefundExceedsSlash,
    #[msg("Dispute window has closed")]
    DisputeWindowClosed,
    #[msg("Proposal already disputed")]
    AlreadyDisputed,
    #[msg("Proposal has not been disputed")]
    NotDisputed,
    #[msg("Proposal already resolved")]
    AlreadyResolved,
    #[msg("Proposal was rejected on dispute and cannot execute")]
    ProposalRejected,
    #[msg("Proposal already executed")]
    AlreadyExecuted,
    #[msg("Dispute window is still open")]
    DisputeWindowOpen,
    #[msg("Execution is blocked by an unresolved dispute")]
    DisputeBlocksExecution,
    #[msg("Proposal is not closable yet")]
    ProposalNotClosable,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Account does not match the configured address")]
    ConfigAccountMismatch,
    #[msg("Bond vault balance is lower than the recorded amount")]
    VaultUnderfunded,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Value is outside the bounds this program enforces")]
    OutOfBounds,
    #[msg("This change loosens a safety parameter: use propose_config and apply_config after the timelock")]
    RequiresTimelock,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Slash bps exceeds the maximum one proposal may carry")]
    SlashBpsAboveProposalMax,
    #[msg("The whole remaining bond is locked behind open capacity commitments")]
    BondLocked,
    #[msg("Only the account that paid a proposal's rent may close it")]
    NotRentPayer,
    #[msg("Invalid configuration value")]
    InvalidConfigValue,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The guardian paused recently and must wait before pausing again; the authority can pause at any time")]
    GuardianCooldown,
    #[msg("The account already has the current layout")]
    AlreadyMigrated,
    #[msg("The account is not one this instruction migrates")]
    NotMigratable,
    #[msg("The bond does not cover this commitment on top of what is already locked and claimed against it")]
    ExceedsBondHeadroom,
    #[msg("A capacity claim cannot exceed what is locked behind the host's commitments")]
    ClaimExceedsLocked,
    #[msg("The cumulative slash cap would cut this slash: only the slasher may execute it now")]
    CapCutNeedsSlasher,
    #[msg("The bond is neither delisted nor ejected")]
    NotDelisted,
    #[msg("A slash was executed against the bond after this reinstatement was proposed; cancel it and propose again")]
    ReinstateStale,
}
