use anchor_lang::prelude::*;

/// PDA seeds.
///
/// | Account       | Seeds                              | Notes                               |
/// |---------------|------------------------------------|-------------------------------------|
/// | `Registry`    | `["registry"]`                     | singleton                           |
/// | `Measurement` | `["measurement", [kind], digest]`  | one per kind and digest; never closed |
#[constant]
pub const REGISTRY_SEED: &[u8] = b"registry";
#[constant]
pub const MEASUREMENT_SEED: &[u8] = b"measurement";

/// Measurement kinds (`kind: u8`).
///
/// | Kind | Name             | Digest                                                        |
/// |------|------------------|---------------------------------------------------------------|
/// | 0    | `model_digest`   | the digest the sidecar computes over the served weights       |
/// | 1    | `compose_hash`   | sha256 of the confidential VM's app-compose file (RTMR3)      |
/// | 2    | `os_image`       | the image digest the quote commits to                         |
/// | 3    | `sidecar_source` | sha256 of the sidecar source tarball the compose file pins    |
#[constant]
pub const KIND_MODEL_DIGEST: u8 = 0;
#[constant]
pub const KIND_COMPOSE_HASH: u8 = 1;
#[constant]
pub const KIND_OS_IMAGE: u8 = 2;
#[constant]
pub const KIND_SIDECAR_SOURCE: u8 = 3;
#[constant]
pub const KIND_COUNT: u8 = 4;

/// Longest `label`, in bytes: room for a 64-hex transparency-log entry hash.
#[constant]
pub const MAX_LABEL_LEN: u32 = 64;

#[constant]
pub const PENDING_AUTHORITY_SEED: &[u8] = b"pending_authority";
/// A registration or reinstatement waiting out `CONFIG_TIMELOCK`. PDA `["pending_measurement", [kind], digest]`: one
/// per entry, any number of entries side by side.
#[constant]
pub const PENDING_MEASUREMENT_SEED: &[u8] = b"pending_measurement";

/// Delay between `transfer_authority` and the moment the new authority can accept, and between proposing a
/// measurement (or its reinstatement) and the moment it can be put on the allow-list: 24 hours.
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
