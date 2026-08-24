//! trellis_rules: agent rulebooks (Trellis Backend §5.5).
//!
//! `Rulebook{owner, per_call_max, daily_max, payee_allowlist_root, model_allowlist_root,
//! ask_first_above, expiry, killed}` is enforced by the router off-chain (per call) and by trellis_tab
//! on-chain when USDC is committed (`open_tab` / `top_up` CPI into `record_commitment`). Settlement of a
//! signed voucher never depends on the rulebook (see `state::Rulebook`). Build the crate with
//! the `cpi` feature to get `trellis_rules::cpi::*`.
//!
//! `authority` is a single pubkey for now; production uses a Squads 2-of-3 multisig.
//! `guardian` can only pause creation of new rulebooks.
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

declare_id!("GAsF9tHESV7vWxK7nNQy8S7nGtGxGVd4SHNBvSVCjYj5");

#[program]
pub mod trellis_rules {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, guardian: Pubkey, enforcer: Pubkey) -> Result<()> {
        instructions::admin::handle_init_config(ctx, guardian, enforcer)
    }

    /// Authority: record an authority / guardian / enforcer change; it can be applied after `CONFIG_TIMELOCK` (24h).
    pub fn propose_config(
        ctx: Context<ProposeConfig>,
        new_authority: Option<Pubkey>,
        guardian: Option<Pubkey>,
        enforcer: Option<Pubkey>,
    ) -> Result<()> {
        instructions::admin::handle_propose_config(ctx, new_authority, guardian, enforcer)
    }

    /// `apply = true`: the authority installs the pending change after the timelock (a new authority must co-sign).
    /// `apply = false`: the authority drops it (the guardian cannot); anyone may clear an expired one.
    pub fn resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
        instructions::admin::handle_resolve_config(ctx, apply)
    }

    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::admin::handle_build_profile(ctx)
    }

    /// Grows a config created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::admin::handle_migrate_config(ctx)
    }

    /// Guardian or authority: pause creation of new rulebooks for `PAUSE_TTL`. Only the authority unpauses.
    pub fn set_new_rulebooks_paused(ctx: Context<SetNewRulebooksPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_new_rulebooks_paused(ctx, paused)
    }

    pub fn create_rulebook(ctx: Context<CreateRulebook>, rulebook_id: u64, params: RulebookParams) -> Result<()> {
        instructions::rulebook::handle_create_rulebook(ctx, rulebook_id, params)
    }

    pub fn update_rulebook(ctx: Context<OwnerRulebook>, params: RulebookParams) -> Result<()> {
        instructions::rulebook::handle_update_rulebook(ctx, params)
    }

    /// Owner: permanent kill switch.
    pub fn kill_rulebook(ctx: Context<OwnerRulebook>) -> Result<()> {
        instructions::rulebook::handle_kill_rulebook(ctx)
    }

    /// Owner: reclaim rent of an expired rulebook (a killed one stays as a tombstone).
    pub fn close_rulebook(ctx: Context<CloseRulebook>) -> Result<()> {
        instructions::rulebook::handle_close_rulebook(ctx)
    }

    /// View-like: reverts if `amount` on `day` (unix days) violates the rulebook.
    pub fn check_spend(ctx: Context<CheckSpend>, amount: u64, day: i64) -> Result<()> {
        instructions::check_spend::handle_check_spend(ctx, amount, day)
    }

    /// Owner or configured enforcer: check and record `amount` against the day's counter.
    pub fn record_spend(ctx: Context<RecordSpend>, amount: u64, day: i64) -> Result<()> {
        instructions::check_spend::handle_record_spend(ctx, amount, day)
    }

    /// Owner or configured enforcer (`trellis_tab`): record USDC newly escrowed under this rulebook today.
    pub fn record_commitment(ctx: Context<RecordSpend>, amount: u64) -> Result<()> {
        instructions::check_spend::handle_record_commitment(ctx, amount)
    }
}
