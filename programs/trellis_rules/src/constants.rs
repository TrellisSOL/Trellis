use anchor_lang::prelude::*;

/// PDA seeds.
///
/// | Account       | Seeds                                                  | Notes      |
/// |---------------|--------------------------------------------------------|------------|
/// | `RulesConfig` | `["config"]`                                           | singleton  |
/// | `Rulebook`    | `["rulebook", owner, rulebook_id.to_le_bytes()]`       | per owner  |
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const RULEBOOK_SEED: &[u8] = b"rulebook";
#[constant]
pub const SECONDS_PER_DAY: i64 = 86_400;
#[constant]
pub const PENDING_CONFIG_SEED: &[u8] = b"pending_config";

/// Delay between proposing a guardian / enforcer change or an authority hand-over and the moment it can take effect.
/// The enforcer can record spend against every rulebook, so replacing it is never immediate.
///
/// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY; a mainnet build must not enable it.
#[cfg(not(feature = "devnet"))]
mod profile {
    pub const CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
    /// A pause set by the guardian or the authority lapses after 72 hours unless the authority sets it again.
    pub const PAUSE_TTL: i64 = 72 * 60 * 60;
    /// After a guardian pause the guardian cannot pause again for 7 days (counted from the moment its pause would
    /// lapse), so one stolen guardian key cannot hold a pause open by setting it again and again.
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 7 * 24 * 60 * 60;
    /// A proposal that was not applied within 7 days of becoming effective can only be cancelled.
    pub const PROPOSAL_TTL: i64 = 7 * 24 * 60 * 60;
    /// 0 = the mainnet floors (the default build), 1 = the short `devnet` floors. See `build_profile`.
    pub const BUILD_PROFILE: u8 = 0;
}
#[cfg(feature = "devnet")]
mod profile {
    pub const CONFIG_TIMELOCK: i64 = 30;
    pub const PAUSE_TTL: i64 = 60;
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 60;
    pub const PROPOSAL_TTL: i64 = 600;
    pub const BUILD_PROFILE: u8 = 1;
}
pub use profile::*;
