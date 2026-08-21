use anchor_lang::prelude::*;

#[error_code]
pub enum CapacityError {
    #[msg("Signer is not the program authority")]
    Unauthorized,
    #[msg("Signer is not the sale authority")]
    NotSaleAuthority,
    #[msg("Signer is not the HVX authority")]
    NotHvxAuthority,
    #[msg("Signer is neither the guardian nor the authority")]
    NotGuardian,
    #[msg("New commitments and sales are paused")]
    Paused,
    #[msg("Unknown grade (expected 0 = G-S, 1 = G-M, 2 = G-L)")]
    InvalidGrade,
    #[msg("Grade price must be greater than zero")]
    ZeroPrice,
    #[msg("Tokens must be greater than zero")]
    ZeroTokens,
    #[msg("Window end must be after window start and in the future")]
    InvalidWindow,
    #[msg("Host bond does not belong to this host")]
    BondHostMismatch,
    #[msg("Host bond is not active (under-funded, unbonding, delisted or ejected)")]
    BondInactive,
    #[msg("Commitment value exceeds the host's remaining bond headroom")]
    ExceedsBondHeadroom,
    #[msg("Commitment value exceeds the global issuance cap")]
    ExceedsIssuanceCap,
    #[msg("Commitment is not open")]
    CommitmentNotOpen,
    #[msg("Commitment window has ended; no more sales")]
    WindowEnded,
    #[msg("Commitment window has not ended yet")]
    WindowNotEnded,
    #[msg("Not enough unsold capacity in this commitment")]
    InsufficientCapacity,
    #[msg("Lot id must equal the commitment's next lot id")]
    LotIdMismatch,
    #[msg("Price paid must be greater than zero and at most the list price")]
    InvalidPrice,
    #[msg("Key hash must not be all zeros")]
    InvalidKeyHash,
    #[msg("Lot already redeemed")]
    AlreadyRedeemed,
    #[msg("Unserved tokens exceed committed tokens")]
    UnservedExceedsCommitted,
    #[msg("Commitment has no reported shortfall")]
    NoShortfall,
    #[msg("Lot shortfall already claimed or rehomed")]
    LotAlreadyHandled,
    #[msg("Replacement commitment must be a different, open commitment of the same grade")]
    InvalidReplacement,
    #[msg("Nothing to claim for this lot")]
    NothingToClaim,
    #[msg("HVX hour must not go backwards")]
    HvxHourNotMonotonic,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("This change loosens a safety parameter: use propose_config and apply_config after the timelock")]
    RequiresTimelock,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Window is longer, or ends further away, than this program allows")]
    WindowTooLong,
    #[msg("The claim period after the window has not elapsed")]
    ClaimPeriodNotElapsed,
    #[msg("Commitment is already settled")]
    CommitmentSettled,
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
    #[msg("The lots recorded against a commitment cannot be worth more than the commitment")]
    ExceedsCommitmentValue,
    #[msg("The claims filed for a commitment cannot exceed the commitment's value")]
    ClaimExceedsCommitment,
    #[msg("HVX hour is in the future")]
    HvxHourInFuture,
    #[msg("Value is outside the bounds this program enforces")]
    OutOfBounds,
}
