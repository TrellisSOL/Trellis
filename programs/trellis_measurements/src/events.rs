use anchor_lang::prelude::*;

#[event]
pub struct RegistryInitialized {
    pub authority: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct MeasurementRegistered {
    pub kind: u8,
    pub digest: [u8; 32],
    pub label: String,
    pub policy_version: u32,
    pub registered_at: i64,
}

#[event]
pub struct MeasurementRevoked {
    pub kind: u8,
    pub digest: [u8; 32],
    pub reason_code: u8,
    pub revoked_at: i64,
}

#[event]
pub struct MeasurementReinstated {
    pub kind: u8,
    pub digest: [u8; 32],
    pub reinstated_at: i64,
}

#[event]
pub struct AuthorityTransferProposed {
    pub new_authority: Pubkey,
    pub effective_at: i64,
}

/// The authority proposed to add an entry to the allow-list (`reinstate = false`) or to clear the revocation of an
/// existing one (`reinstate = true`). It can be applied from `effective_at`.
#[event]
pub struct MeasurementProposed {
    pub kind: u8,
    pub digest: [u8; 32],
    pub label: String,
    pub policy_version: u32,
    pub reinstate: bool,
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
}

/// A pending proposal was dropped without being applied.
#[event]
pub struct MeasurementProposalCancelled {
    pub kind: u8,
    pub digest: [u8; 32],
    pub reinstate: bool,
    pub by: Pubkey,
}
