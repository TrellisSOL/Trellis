//! trellis_credits: prepaid, spend-only USDC inference credits (Trellis Backend §5.1).
//!
//! Invariants
//! - There is no `withdraw` instruction. The only vault outflows are `settle_to_host`
//!   (bounded by committed spend), `pay_refund` (queued closure refund after a delay) and
//!   `sweep_expired` (expired balance to treasury after a grace notice).
//! - `settled_total <= spent_total` at all times.
//! - `authority` is the admin key: a Squads 2-of-3 multisig in production, a single pubkey
//!   until then. `guardian` can only pause (deposits, and the settlement outflows): a pause lapses after 72h unless the
//!   authority sets it again, the guardian must then wait 7 days before pausing again, and it cannot cancel a proposal.
//! - No key can bypass the floors in `constants.rs`: every delay has a compiled minimum, `settle_to_host` and
//!   `pay_refund` are each rate-limited over any 24h (continuously refilled allowances, no window to straddle),
//!   committed spend can never exceed the vault, loosening config changes and authority hand-overs wait a 24h timelock
//!   and expire 7 days after it, and `init_config` only accepts the program's upgrade authority.
//! - A key's credit account can only be closed with the key's own signature (`key_hash = sha256(key address)`) or
//!   that of the owner wallet the key registered, and neither can say where the refund goes: it returns to the wallets
//!   that deposited (`DepositorShare`), each at most what it put in, to the token account that wallet named. A leaked
//!   API key cannot redirect a balance, and it cannot keep taking closures back: only the requester or the owner can
//!   cancel one, and the key at most once per `KEY_CANCEL_COOLDOWN`. Depositing gives no power over a key.
//! - The outflow caps are a share of the lowest vault balance of the last window (a fresh deposit does not count) and
//!   never more than `cap_per_window`; the per-key cap can never be set above `MAX_BALANCE_PER_KEY_LIMIT`; a deposit
//!   is at least `MIN_DEPOSIT`.
//! - Closing an account, cancelling a closure, moving a refund destination and paying a refund are never paused.
#![allow(unexpected_cfgs)]

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("dtwL4NqHvvF2QAB84y9VjfNdkEUGw6NWbNWRtgjifAi");

#[program]
pub mod trellis_credits {
    use super::*;

    /// Upgrade authority only: creates the config, the vault and the outflow limiter.
    pub fn init_config(ctx: Context<InitConfig>, params: InitConfigParams) -> Result<()> {
        instructions::init_config::handle_init_config(ctx, params)
    }

    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::admin::handle_build_profile(ctx)
    }

    /// Grows a config created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::admin::handle_migrate_config(ctx)
    }

    /// Creates the outflow limiter for a config initialised before it existed (anyone may pay).
    pub fn init_limiter(ctx: Context<InitLimiter>) -> Result<()> {
        instructions::admin::handle_init_limiter(ctx)
    }

    /// Grows a limiter created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_limiter(ctx: Context<MigrateLimiter>) -> Result<()> {
        instructions::admin::handle_migrate_limiter(ctx)
    }

    /// Authority: tightening changes only, effective at once. Loosening is refused (`RequiresTimelock`).
    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
        instructions::admin::handle_update_config(ctx, params)
    }

    /// Authority: record any config change (including an authority hand-over); it can be applied after
    /// `CONFIG_TIMELOCK` (24h).
    pub fn propose_config(ctx: Context<ProposeConfig>, params: UpdateConfigParams) -> Result<()> {
        instructions::admin::handle_propose_config(ctx, params)
    }

    /// `apply = true`: the authority installs the pending change after the timelock (a new authority must co-sign).
    /// `apply = false`: the authority drops it (the guardian cannot); anyone may clear an expired one.
    pub fn resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
        instructions::admin::handle_resolve_config(ctx, apply)
    }

    /// Guardian or authority pauses new deposits for `PAUSE_TTL`; only the authority unpauses. Never affects outflows.
    pub fn set_deposits_paused(ctx: Context<SetDepositsPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_deposits_paused(ctx, paused)
    }

    /// Guardian or authority pauses spend commits, host settlement and sweeps for `PAUSE_TTL`; only the authority
    /// unpauses. Closures and closure refunds are never paused.
    pub fn set_settlements_paused(ctx: Context<SetSettlementsPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_settlements_paused(ctx, paused)
    }

    /// Deposit USDC for `key_hash`; creates the credit account on first use and extends
    /// `expires_at` to now + `credit_ttl`. Anyone may deposit to any key; it gives the depositor no rights over it.
    pub fn deposit(ctx: Context<Deposit>, key_hash: [u8; 32], amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, key_hash, amount)
    }

    /// Register the key's owner wallet (signed by the key and by the wallet), or, once one is registered, change or
    /// clear it (signed by the current owner; a new owner signs too). The key alone cannot change a registered owner.
    pub fn set_key_authority(
        ctx: Context<SetKeyAuthority>,
        key_hash: [u8; 32],
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::deposit::handle_set_key_authority(ctx, key_hash, new_authority)
    }

    /// Settlement authority: commit the hour's spend root and advance `spent_total`.
    pub fn commit_spent_root(
        ctx: Context<CommitSpentRoot>,
        hour: i64,
        root: [u8; 32],
        spent_delta: u64,
    ) -> Result<()> {
        instructions::commit_spent_root::handle_commit_spent_root(ctx, hour, root, spent_delta)
    }

    /// Settlement authority: pay a host from the vault, bounded by committed spend and the per-window limit.
    pub fn settle_to_host(ctx: Context<SettleToHost>, amount: u64, hour_root_ref: i64) -> Result<()> {
        instructions::settle_to_host::handle_settle_to_host(ctx, amount, hour_root_ref)
    }

    /// Signed by the key itself: close the key and queue a refund of the unspent balance to the wallets that funded it.
    pub fn close_account(ctx: Context<CloseAccount>, key_hash: [u8; 32]) -> Result<()> {
        instructions::close_account::handle_close_account(ctx, key_hash)
    }

    /// Signed by the key's registered owner wallet, without the key: close the key and queue the same refund. A closure
    /// asked for this way cannot be cancelled with the key.
    pub fn close_account_by_owner(ctx: Context<CloseAccountByOwner>, key_hash: [u8; 32]) -> Result<()> {
        instructions::close_account::handle_close_account_by_owner(ctx, key_hash)
    }

    /// Whoever asked for the closure, or the key's registered owner wallet: take a queued closure back while nothing has
    /// been paid. The key may do this once per `KEY_CANCEL_COOLDOWN`. A depositor has no say over a closure.
    pub fn cancel_close(ctx: Context<CancelClose>, key_hash: [u8; 32]) -> Result<()> {
        instructions::close_account::handle_cancel_close(ctx, key_hash)
    }

    /// A depositor: name another USDC token account for its own refunds from this key.
    pub fn set_refund_destination(ctx: Context<SetRefundDestination>, key_hash: [u8; 32]) -> Result<()> {
        instructions::close_account::handle_set_refund_destination(ctx, key_hash)
    }

    /// Settlement authority: pay (part of) a queued refund to one depositor's destination, after the request's
    /// `payable_at` and within the refund allowance.
    pub fn pay_refund(ctx: Context<PayRefund>, amount: u64) -> Result<()> {
        instructions::pay_refund::handle_pay_refund(ctx, amount)
    }

    /// Settlement authority: start the grace period for an expired balance.
    pub fn notice_expiry(ctx: Context<NoticeExpiry>, key_hash: [u8; 32]) -> Result<()> {
        instructions::expiry::handle_notice_expiry(ctx, key_hash)
    }

    /// Settlement authority: move the unspent part of an expired, noticed balance to treasury after the grace period.
    pub fn sweep_expired(ctx: Context<SweepExpired>, key_hash: [u8; 32], amount: u64) -> Result<()> {
        instructions::expiry::handle_sweep_expired(ctx, key_hash, amount)
    }
}
