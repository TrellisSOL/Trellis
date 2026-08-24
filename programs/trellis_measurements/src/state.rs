use anchor_lang::prelude::*;

/// The registry. PDA `["registry"]`.
///
/// `authority` registers, revokes and reinstates entries. Revoking is immediate; registering and reinstating are
/// proposed first and applied `CONFIG_TIMELOCK` (24h) later. In production it is a Squads 2-of-3 multisig. `registered` counts every entry ever created and `revoked` the entries
/// revoked right now, so `registered - revoked` is the size of the live allow-list.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub authority: Pubkey,
    pub registered: u64,
    pub revoked: u64,
    pub bump: u8,
}

/// One allow-listed digest. PDA `["measurement", [kind], digest]`.
///
/// Live while `revoked_at` is `None`. `label` is free text set at registration (at most 64
/// bytes; the router writes the hash of the entry's transparency-log record).
/// `policy_version` is the version of the measurement policy the entry was approved under.
#[account]
#[derive(InitSpace)]
pub struct Measurement {
    pub kind: u8,
    pub digest: [u8; 32],
    #[max_len(64)]
    pub label: String,
    pub policy_version: u32,
    pub registered_at: i64,
    pub revoked_at: Option<i64>,
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

/// A registration (`reinstate = false`) or a reinstatement (`reinstate = true`) waiting out `CONFIG_TIMELOCK`.
/// PDA `["pending_measurement", [kind], digest]`. Until it is applied the allow-list is unchanged: a registration has no
/// `Measurement` account yet, and a revoked entry stays revoked, so a reader that knows nothing of proposals sees
/// exactly what is in force.
#[account]
#[derive(InitSpace)]
pub struct PendingMeasurement {
    pub kind: u8,
    pub digest: [u8; 32],
    /// The label the entry will be registered with (empty for a reinstatement: the entry keeps its own).
    #[max_len(64)]
    pub label: String,
    pub policy_version: u32,
    pub reinstate: bool,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// What `build_profile` returns: the floors compiled into this binary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile {
    /// 0 = mainnet floors (the default build); 1 = the `devnet` cargo feature.
    pub profile: u8,
    pub config_timelock: i64,
    pub proposal_ttl: i64,
}
