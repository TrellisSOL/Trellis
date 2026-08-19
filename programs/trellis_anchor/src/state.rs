use anchor_lang::prelude::*;

/// The receipt signing key set. PDA `["signer_set"]`.
///
/// `authority` rotates the signer weekly. A new signer is never installed at once: `propose_signer` announces it,
/// `resolve_signer(true)` installs it `CONFIG_TIMELOCK` (24h) later. Removing a key is immediate (`revoke_signer`), so a
/// compromised signer is cut off in one transaction and its replacement follows a day later; until then
/// `current_signer` is the default (all-zero) key, which is no key at all. In production the authority is a Squads
/// 2-of-3 multisig. `previous_signer` is retained so receipts signed just before a rotation still verify.
#[account]
#[derive(InitSpace)]
pub struct SignerSet {
    pub authority: Pubkey,
    pub current_signer: Pubkey,
    pub previous_signer: Pubkey,
    pub rotated_at: i64,
    pub rotation_count: u64,
    pub bump: u8,
}

/// Hourly receipt Merkle root. PDA `["receipt_root", hour.to_le_bytes()]`.
///
/// `root` is a sha256 Merkle root (see `crate::merkle`). `signer` is the receipt signing key
/// that was current when the root was posted (the default key if the current signer had been revoked and its
/// replacement was still waiting out the timelock). It is a record, not a check: posting a root needs the authority's
/// signature only.
#[account]
#[derive(InitSpace)]
pub struct ReceiptRoot {
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub signer: Pubkey,
    pub posted_at: i64,
    pub bump: u8,
}

/// Hourly receipt Merkle root of one attested host (Trellis Backend §3: per-host receipts).
/// PDA `["host_root", provider_id_hash, hour.to_le_bytes()]`.
///
/// `provider_id_hash` is sha256 of the router's provider id. `root` is a sha256 Merkle root over
/// the host's sidecar receipt leaves collected for `hour` (see `crate::merkle`); `signer` is the
/// router receipt signing key that was current when the root was posted.
#[account]
#[derive(InitSpace)]
pub struct HostRoot {
    pub provider_id_hash: [u8; 32],
    pub hour: i64,
    pub root: [u8; 32],
    pub count: u64,
    pub signer: Pubkey,
    pub posted_at: i64,
    pub bump: u8,
}

/// An authority hand-over waiting for the new authority to accept after `CONFIG_TIMELOCK`. PDA `["pending_authority"]`.
#[account]
#[derive(InitSpace)]
pub struct PendingAuthority {
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// A receipt signer waiting out `CONFIG_TIMELOCK` before it can be installed. PDA `["pending_signer"]`; one at a time.
#[account]
#[derive(InitSpace)]
pub struct PendingSigner {
    pub new_signer: Pubkey,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// What `build_profile` returns: the floors compiled into this binary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile {
    /// 0 = mainnet floors (the default build); 1 = the `devnet` cargo feature.
    pub profile: u8,
    /// Seconds between `transfer_authority` and the moment the new authority can accept (and between `propose_signer`
    /// and the moment the signer can be installed).
    pub config_timelock: i64,
    /// Seconds after an hour's end before its root may be closed (and after which it can no longer be posted).
    pub root_retention: i64,
    /// Seconds after a hand-over becomes effective during which the new authority can still accept it.
    pub proposal_ttl: i64,
}
