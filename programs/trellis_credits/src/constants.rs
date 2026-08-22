use anchor_lang::prelude::*;

/// PDA seeds.
///
/// | Account            | Seeds                                   | Owner / notes                              |
/// |--------------------|-----------------------------------------|--------------------------------------------|
/// | `CreditsConfig`    | `["config"]`                            | singleton; signs vault transfers           |
/// | vault              | `["vault"]`                             | SPL token account, authority = config      |
/// | `CreditAccount`    | `["credit", key_hash]`                  | one per API-key hash                       |
/// | `SpentRoot`        | `["spent_root", hour.to_le_bytes()]`    | one per hour; second init fails            |
/// | `RefundRequest`    | `["refund", key_hash]`                  | one per closed key                         |
/// | `SettleLimiter`    | `["limiter_v2"]`                        | singleton; outflow rate limits and pause   |
/// | `DepositorShare`   | `["share", key_hash, depositor]`        | what one wallet deposited to one key       |
/// | `PendingConfig`    | `["pending_config"]`                    | a loosening config change waiting its delay|
/// | `CloseGuard`       | `["close_guard", key_hash]`             | when the key may next cancel a closure     |
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const CREDIT_SEED: &[u8] = b"credit";
#[constant]
pub const SPENT_ROOT_SEED: &[u8] = b"spent_root";
#[constant]
pub const REFUND_SEED: &[u8] = b"refund";
/// The limiter that replaced the fixed 24h bucket (security re-review RR-01) lives at a new address: the first
/// limiter's account (`["limiter"]`) has another layout and is no longer read by any instruction.
#[constant]
pub const LIMITER_SEED: &[u8] = b"limiter_v2";
#[constant]
pub const SHARE_SEED: &[u8] = b"share";
#[constant]
pub const PENDING_CONFIG_SEED: &[u8] = b"pending_config";
#[constant]
pub const CLOSE_GUARD_SEED: &[u8] = b"close_guard";

/// USDC has 6 decimals: 5,000 USDC.
#[constant]
pub const DEFAULT_MAX_BALANCE_PER_KEY: u64 = 5_000_000_000u64;
/// The compiled maximum of `max_balance_per_key` while the programs are unaudited: 5,000 USDC. `init_config`,
/// `update_config` and `propose_config` refuse a higher value, so no key can raise the per-key cap above the published
/// figure; that takes a program upgrade (security review round 3). The same in the `devnet` build.
#[constant]
pub const MAX_BALANCE_PER_KEY_LIMIT: u64 = 5_000_000_000u64;
/// The smallest deposit: 1 USDC. A deposit creates a `DepositorShare` that a closure has to screen, read and pay, and
/// it cancels an expiry notice; below this a stranger could queue work in front of a key's owner for dust (R3-22).
#[constant]
pub const MIN_DEPOSIT: u64 = 1_000_000u64;
/// Credits expire 12 months after the latest deposit (Backend §5.1).
#[constant]
pub const DEFAULT_CREDIT_TTL: i64 = 365 * 24 * 60 * 60;
/// Closure refunds wait 72h for the open-dispute check before they can be paid.
#[constant]
pub const DEFAULT_REFUND_DELAY: i64 = 72 * 60 * 60;
/// Expired balances move to treasury only 30 days after the expiry notice.
#[constant]
pub const DEFAULT_EXPIRY_GRACE: i64 = 30 * 24 * 60 * 60;
#[constant]
pub const SECONDS_PER_HOUR: i64 = 3600;

// ---- Floors and bounds the authority cannot bypass ---------------------------------------------------------------
//
// Every delay below is enforced by the program itself: `init_config`, `update_config` and `propose_config` reject a
// value outside [MIN, MAX], so no key can shorten a published delay or stretch one until it overflows. A change that
// loosens safety (see `instructions::admin`) additionally waits `CONFIG_TIMELOCK` between `propose_config` and
// `apply_config`; tightening is immediate.
//
// THE `devnet` CARGO FEATURE IS FOR DEVNET AND LOCAL INTEGRATION TESTS ONLY. It compiles the short values in the
// second block so closure refunds, expiry and the timelock can be watched in minutes. A mainnet build must be made
// WITHOUT `--features devnet`; the default build carries the mainnet values and tests/floors.ts asserts it.

#[cfg(not(feature = "devnet"))]
mod profile {
    /// Minimum seconds between `close_account` and the earliest `pay_refund`: 72 hours.
    pub const MIN_REFUND_DELAY: i64 = 72 * 60 * 60;
    /// Minimum seconds between `notice_expiry` and the earliest `sweep_expired`: 30 days.
    pub const MIN_EXPIRY_GRACE: i64 = 30 * 24 * 60 * 60;
    /// Minimum lifetime of a balance after its latest deposit: 180 days.
    pub const MIN_CREDIT_TTL: i64 = 180 * 24 * 60 * 60;
    /// Delay between `propose_config` and the moment the change can be applied: 24 hours.
    pub const CONFIG_TIMELOCK: i64 = 24 * 60 * 60;
    /// The period the outflow limits are stated over: 24 hours. Over ANY interval of this length `settle_to_host`
    /// pays at most the cap, and so does `pay_refund` (each from its own allowance).
    pub const SETTLE_WINDOW: i64 = 24 * 60 * 60;
    /// A pause set by the guardian or the authority lapses after 72 hours unless the authority sets it again.
    pub const PAUSE_TTL: i64 = 72 * 60 * 60;
    /// After a guardian pause the guardian cannot pause again for 7 days (counted from the moment its pause would
    /// lapse), so one stolen guardian key cannot hold a pause open by setting it again and again.
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 7 * 24 * 60 * 60;
    /// A proposal that was not applied within 7 days of becoming effective can only be cancelled.
    pub const PROPOSAL_TTL: i64 = 7 * 24 * 60 * 60;
    /// After the key itself has cancelled a closure it cannot cancel another one for 60 days: longer than the longest
    /// refund delay (`MAX_REFUND_DELAY`, 30 days) plus a month for the payment to start, so of two parties holding the
    /// same API key neither can keep taking the other's closure back (security review round 3, R3-06).
    pub const KEY_CANCEL_COOLDOWN: i64 = 60 * 24 * 60 * 60;
}

#[cfg(feature = "devnet")]
mod profile {
    pub const MIN_REFUND_DELAY: i64 = 1;
    pub const MIN_EXPIRY_GRACE: i64 = 1;
    pub const MIN_CREDIT_TTL: i64 = 1;
    pub const CONFIG_TIMELOCK: i64 = 30;
    pub const SETTLE_WINDOW: i64 = 60;
    pub const PAUSE_TTL: i64 = 60;
    pub const GUARDIAN_PAUSE_COOLDOWN: i64 = 60;
    pub const PROPOSAL_TTL: i64 = 600;
    pub const KEY_CANCEL_COOLDOWN: i64 = 600;
}

pub use profile::*;

/// Upper bounds: a delay can never be set so long that it blocks its own instruction or overflows a timestamp.
pub const MAX_REFUND_DELAY: i64 = 30 * 24 * 60 * 60;
pub const MAX_EXPIRY_GRACE: i64 = 365 * 24 * 60 * 60;
pub const MAX_CREDIT_TTL: i64 = 10 * 365 * 24 * 60 * 60;

/// Which floors this binary was compiled with: 0 = the mainnet floors (the default build), 1 = the short `devnet`
/// floors. `build_profile` returns it with the floors themselves, so anyone can ask the deployed program which build it
/// is (a simulated call is enough). The IDL is the same file for both flavours and cannot tell them apart.
#[cfg(not(feature = "devnet"))]
pub const BUILD_PROFILE: u8 = 0;
#[cfg(feature = "devnet")]
pub const BUILD_PROFILE: u8 = 1;

/// `settle_to_host` may pay at most this share of the vault over any `SETTLE_WINDOW`; `pay_refund` has the same share
/// from an allowance of its own.
pub const DEFAULT_SETTLE_RATE_BPS: u16 = 2_000;
/// The most that can leave at once (the allowance's ceiling), as a share of the cap of one window: a quarter. The other
/// three quarters arrive evenly over the window, so no interval of one window ever sees more than the cap.
pub const SETTLE_BURST_BPS: u16 = 2_500;
/// The authority can lower the rate at once and raise it only through the timelock, never above this.
pub const MAX_SETTLE_RATE_BPS: u16 = 5_000;
/// A window always allows at least this much (1,000 USDC), so a small vault can still pay its hosts.
pub const SETTLE_WINDOW_FLOOR: u64 = 1_000_000_000;
/// The absolute bound on one window's outflow, whatever the vault holds: 25,000 USDC for host payouts and the same
/// again for refunds, until the authority changes it (`outflow_cap_per_window`: lowered at once, raised only through
/// the timelock, never below `SETTLE_WINDOW_FLOOR`). A percentage of the vault can be inflated by whoever brings
/// capital of its own; this number cannot (security review round 3, R3-07).
pub const DEFAULT_OUTFLOW_CAP_PER_WINDOW: u64 = 25_000_000_000;
pub const BPS_DENOMINATOR: u64 = 10_000;
