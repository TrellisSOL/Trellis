use anchor_lang::prelude::*;

#[error_code]
pub enum TabError {
    #[msg("Signer is not the program authority")]
    Unauthorized,
    #[msg("Signer is neither the guardian nor the authority")]
    NotGuardian,
    #[msg("New tabs are paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Cap exceeds the configured maximum tab cap")]
    CapTooLarge,
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("Tab has expired; top-ups are no longer allowed")]
    TabExpired,
    #[msg("Token account mint does not match the tab mint")]
    MintMismatch,
    #[msg("Token account owner does not match the expected owner")]
    TokenOwnerMismatch,
    #[msg("Payer and payee must differ")]
    PayerIsPayee,
    #[msg("Session key must not be the default pubkey")]
    InvalidSessionKey,
    #[msg("Voucher cumulative_used exceeds the tab cap")]
    VoucherExceedsCap,
    #[msg("Voucher seq must be greater than the last posted seq")]
    VoucherSeqNotIncreasing,
    #[msg("Voucher cumulative_used is lower than an already posted voucher")]
    VoucherBelowPosted,
    #[msg("Instructions sysvar account is invalid")]
    BadInstructionsSysvar,
    #[msg("The instruction immediately before this one must be an Ed25519 program instruction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction is malformed")]
    MalformedEd25519Instruction,
    #[msg("Ed25519 instruction must carry exactly one signature")]
    Ed25519SignatureCount,
    #[msg("Ed25519 instruction references data in another instruction")]
    Ed25519ForeignReference,
    #[msg("Ed25519 public key does not match the tab session key")]
    Ed25519PubkeyMismatch,
    #[msg("Ed25519 message does not match the voucher")]
    Ed25519MessageMismatch,
    #[msg("Reclaim is not yet allowed (expiry + grace not reached)")]
    ReclaimTooEarly,
    #[msg("Rulebook account does not match the tab's rulebook")]
    RulebookMismatch,
    #[msg("Rules program account does not match the configured trellis_rules program")]
    RulesProgramMismatch,
    #[msg("Rulebook account is not owned by the configured trellis_rules program")]
    RulebookOwnerMismatch,
    #[msg("Tab was opened with a rulebook; rulebook and rules program accounts are required")]
    RulebookRequired,
    #[msg("The rulebook must be owned by the tab's payer")]
    RulebookNotOwnedByPayer,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Value is outside the bounds this program enforces")]
    OutOfBounds,
    #[msg("This change loosens a safety parameter: use propose_config and apply_config after the timelock")]
    RequiresTimelock,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Expiry is further away than the maximum tab lifetime")]
    ExpiryTooFar,
    #[msg("The tab is being settled: no more vouchers or top-ups")]
    TabFinal,
    #[msg("The payee's token account cannot receive the payment")]
    PayeeTokenAccountInvalid,
    #[msg("Neither side's token account can receive its share yet; nothing was settled")]
    NothingToSettle,
    #[msg("Invalid configuration value")]
    InvalidConfigValue,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The guardian paused recently and must wait before pausing again; the authority can pause at any time")]
    GuardianCooldown,
    #[msg("The account already has the current layout")]
    AlreadyMigrated,
    #[msg("The account is not one this instruction migrates")]
    NotMigratable,
    #[msg("A tab cannot be closed in the second it was opened; try again a second later")]
    CloseTooSoon,
}
