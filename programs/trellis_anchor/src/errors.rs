use anchor_lang::prelude::*;

#[error_code]
pub enum AnchorError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Hour must be a non-negative multiple of 3600")]
    InvalidHour,
    #[msg("Signer pubkey must not be the default pubkey")]
    InvalidSigner,
    #[msg("New signer equals the current signer")]
    SignerUnchanged,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Provider id hash must not be all zeros")]
    InvalidProviderId,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Hour is in the future")]
    HourInFuture,
    #[msg("Hour is older than the retention period: its root could already have been closed")]
    HourTooOld,
    #[msg("The root is younger than the retention period")]
    RetentionNotElapsed,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The key is neither the current nor the previous signer")]
    SignerNotInSet,
}
