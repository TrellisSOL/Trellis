use anchor_lang::prelude::*;

#[event]
pub struct SignerSetInitialized {
    pub authority: Pubkey,
    pub signer: Pubkey,
}

/// A proposed signer was installed after the timelock: it is the current signer, the outgoing one the previous.
#[event]
pub struct SignerRotated {
    pub previous_signer: Pubkey,
    pub current_signer: Pubkey,
    pub rotated_at: i64,
    pub rotation_count: u64,
}

/// The authority proposed a new receipt signer; it can be installed from `effective_at` (`resolve_signer`).
#[event]
pub struct SignerProposed {
    pub new_signer: Pubkey,
    pub effective_at: i64,
    /// After this the proposal can only be cancelled.
    pub expires_at: i64,
}

/// A pending signer proposal was dropped without being installed.
#[event]
pub struct SignerProposalCancelled {
    pub new_signer: Pubkey,
    pub by: Pubkey,
}

/// A key was removed from the signer set at once. `was_current`: it was the current signer (the set has no current
/// signer until a proposed one is installed); otherwise it was the previous signer.
#[event]
pub struct SignerRevoked {
    pub signer: Pubkey,
    pub was_current: bool,
    pub revoked_at: i64,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct RootPosted {
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub signer: Pubkey,
    pub posted_at: i64,
}

#[event]
pub struct HostRootPosted {
    pub provider_id_hash: [u8; 32],
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub signer: Pubkey,
    pub posted_at: i64,
}

#[event]
pub struct AuthorityTransferProposed {
    pub new_authority: Pubkey,
    pub effective_at: i64,
}

/// A root older than `ROOT_RETENTION` was closed and its rent returned. The root itself stays in the `RootPosted`
/// event and the instruction data of the transaction that posted it.
#[event]
pub struct RootClosed {
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub posted_at: i64,
}

#[event]
pub struct HostRootClosed {
    pub provider_id_hash: [u8; 32],
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub posted_at: i64,
}
