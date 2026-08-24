use anchor_lang::prelude::*;

#[error_code]
pub enum MeasurementError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Authority must not be the default pubkey")]
    InvalidAuthority,
    #[msg("Unknown measurement kind")]
    InvalidKind,
    #[msg("Digest must not be all zeros")]
    InvalidDigest,
    #[msg("Label is longer than 64 bytes")]
    LabelTooLong,
    #[msg("Measurement is already revoked")]
    AlreadyRevoked,
    #[msg("Measurement is not revoked")]
    NotRevoked,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("The timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("The proposal expired; cancel it and propose again")]
    ProposalExpired,
    #[msg("The entry already exists; a revoked entry comes back only through propose_reinstate")]
    AlreadyRegistered,
    #[msg("The pending proposal is of the other kind (registration or reinstatement)")]
    WrongProposalKind,
}
