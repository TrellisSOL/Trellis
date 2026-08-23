use anchor_lang::prelude::*;

/// PDA seeds.
///
/// | Account        | Seeds                                     | Notes                                   |
/// |----------------|-------------------------------------------|-----------------------------------------|
/// | `FeeConfig`    | `["fee_config"]`                          | singleton; signs vault transfers/burns  |
/// | fee vault      | `["fee_vault"]`                           | USDC token account, authority = config  |
/// | $TRLS vault    | `["trls_vault"]`                          | Token-2022 account, authority = config  |
/// | `Distribution` | `["distribution", period.to_le_bytes()]`  | one per period; second distribute fails |
#[constant]
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
#[constant]
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
#[constant]
pub const TRLS_VAULT_SEED: &[u8] = b"trls_vault";
#[constant]
pub const DISTRIBUTION_SEED: &[u8] = b"distribution";

#[constant]
pub const BPS_DENOMINATOR: u16 = 10_000;
/// No fee split: 100% of protocol fees to the treasury (workers 0 bps). No other recipients exist.
#[constant]
pub const DEFAULT_WORKERS_BPS: u16 = 0;
#[constant]
pub const DEFAULT_TREASURY_BPS: u16 = 10_000;

#[constant]
pub const PENDING_CHANGE_SEED: &[u8] = b"pending_change";
/// `distribute` periods are whole weeks since the unix epoch.
#[constant]
pub const SECONDS_PER_WEEK: i64 = 7 * 24 * 60 * 60;

/// Delay between proposing new payout vaults or an authority hand-over and the moment they can take effect: 24 hours.
///
/// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY; a mainnet build must not enable it.
#[cfg(not(feature = "devnet"))]
pub const CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const CONFIG_TIMELOCK: i64 = 30;

/// A proposed change that was not taken up within 7 days of becoming effective can only be cancelled: it cannot be
/// applied months later with no fresh notice (security re-review RR-09).
#[cfg(not(feature = "devnet"))]
pub const PROPOSAL_TTL: i64 = 7 * 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const PROPOSAL_TTL: i64 = 600;

/// Which floors this binary was compiled with: 0 = the mainnet floors (the default build), 1 = the short `devnet`
/// floors. `build_profile` returns it with the floors themselves, so anyone can ask the deployed program which build it
/// is (a simulated call is enough). The IDL is the same file for both flavours and cannot tell them apart.
#[cfg(not(feature = "devnet"))]
pub const BUILD_PROFILE: u8 = 0;
#[cfg(feature = "devnet")]
pub const BUILD_PROFILE: u8 = 1;
