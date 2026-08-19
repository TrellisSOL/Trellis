use anchor_lang::prelude::*;

/// PDA seeds.
///
/// | Account       | Seeds                                   | Notes                              |
/// |---------------|-----------------------------------------|------------------------------------|
/// | `SignerSet`   | `["signer_set"]`                        | singleton                          |
/// | `ReceiptRoot` | `["receipt_root", hour.to_le_bytes()]`  | one per hour; second post fails    |
/// | `HostRoot`    | `["host_root", provider_id_hash, hour.to_le_bytes()]` | one per host and hour  |
#[constant]
pub const SIGNER_SET_SEED: &[u8] = b"signer_set";
#[constant]
pub const RECEIPT_ROOT_SEED: &[u8] = b"receipt_root";
#[constant]
pub const HOST_ROOT_SEED: &[u8] = b"host_root";
#[constant]
pub const SECONDS_PER_HOUR: i64 = 3600;

#[constant]
pub const PENDING_AUTHORITY_SEED: &[u8] = b"pending_authority";
/// A proposed receipt signer waiting out `CONFIG_TIMELOCK`. PDA `["pending_signer"]`; one at a time.
#[constant]
pub const PENDING_SIGNER_SEED: &[u8] = b"pending_signer";

/// Delay between `transfer_authority` and the moment the new authority can accept, and between `propose_signer` and
/// the moment the new receipt signer can be installed: 24 hours.
///
/// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY; a mainnet build must not enable it.
#[cfg(not(feature = "devnet"))]
pub const CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const CONFIG_TIMELOCK: i64 = 30;

/// How long a posted root keeps its account. A `ReceiptRoot` or `HostRoot` may be closed (its rent returned to the
/// authority) only once the hour it covers ended at least this long ago, and a root can only be posted for an hour that
/// is not yet closable. Together: an hour never gets a second root, closed or not. 400 days covers the 365-day credit
/// lifetime plus its 30-day expiry grace. A closed root stays provable from the transaction that posted it.
///
/// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY; a mainnet build must not enable it.
#[cfg(not(feature = "devnet"))]
pub const ROOT_RETENTION: i64 = 400 * 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const ROOT_RETENTION: i64 = 2 * 24 * 60 * 60;

/// The moment the root of `hour` becomes closable (and stops being postable): the end of the hour plus the retention.
pub fn closable_at(hour: i64) -> Option<i64> {
    hour.checked_add(SECONDS_PER_HOUR)?.checked_add(ROOT_RETENTION)
}

/// Which floors this binary was compiled with: 0 = the mainnet floors (the default build), 1 = the short `devnet`
/// floors. `build_profile` returns it together with the floors themselves, so anyone can ask the deployed program
/// which build it is (a simulated call is enough; it takes no account and changes nothing).
#[cfg(not(feature = "devnet"))]
pub const BUILD_PROFILE: u8 = 0;
#[cfg(feature = "devnet")]
pub const BUILD_PROFILE: u8 = 1;
/// The mainnet values, as the default build carries them and as the IDL publishes them. A deployed binary proves its own
/// values through `build_profile`, not through the IDL (the IDL is the same file for both flavours).
#[constant]
pub const MAINNET_CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
#[constant]
pub const MAINNET_ROOT_RETENTION: i64 = 400 * 24 * 60 * 60;

/// A proposed change that was not taken up within 7 days of becoming effective can only be cancelled: it cannot be
/// applied months later with no fresh notice (security re-review RR-09).
#[cfg(not(feature = "devnet"))]
pub const PROPOSAL_TTL: i64 = 7 * 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const PROPOSAL_TTL: i64 = 600;
