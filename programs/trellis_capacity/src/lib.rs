//! `trellis_capacity` — Bushels (prepaid capacity) and the HVX feed (Backend spec section 5.6).
//!
//! A Bushel is prepaid inference capacity, not a token: THERE IS NO MINT, NO TRANSFER
//! INSTRUCTION AND NO SECONDARY MARKET. Hosts commit capacity backed by their `trellis_bond`
//! bond (issuance is capped by the bond and by a global cap). The sale authority records
//! purchases as `BushelLot`s bound to the buyer's key hash. Redeeming a lot (credits issued
//! off-chain against the event) is the only exit. If a host under-delivers, unserved lots are
//! honoured on another host of the same grade or the buyer gets back `price_paid` for the
//! unserved share, claimed from the host's bond. No payout ever references the HVX index. A commitment keeps the
//! grade price it was made at: its lots together are worth at most its value, and so are the claims against it.
//!
//! Authorities: `authority`, `sale_authority` and `hvx_authority` are single pubkeys here; in
//! production `authority` is a Squads v4 2-of-3 multisig. The `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new
//! commitments and sales and never moves funds.

#![allow(unexpected_cfgs)]

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use state::*;

declare_id!("G4cDQ3duVPoSQunY1zRMyn1n7r1rsf7hh9J65iKPzYNy");

#[program]
pub mod trellis_capacity {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
        instructions::config::handle_initialize_config(ctx, args)
    }

    /// Authority: tightening only (a lower issuance cap), effective at once. Loosening is refused (`RequiresTimelock`).
    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::config::handle_update_config(ctx, args)
    }

    /// Authority: record any config change (including an authority hand-over); it can be applied after
    /// `CONFIG_TIMELOCK` (24h).
    pub fn propose_config(ctx: Context<ProposeConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::config::handle_propose_config(ctx, args)
    }

    /// `apply = true`: the authority installs the pending change after the timelock (a new authority must co-sign).
    /// `apply = false`: the authority drops it (the guardian cannot); anyone may clear an expired one.
    pub fn resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
        instructions::config::handle_resolve_config(ctx, apply)
    }

    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::config::handle_build_profile(ctx)
    }

    /// Grows a config created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::config::handle_migrate_config(ctx)
    }

    /// Grows a commitment created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_commitment(ctx: Context<MigrateCommitment>) -> Result<()> {
        instructions::config::handle_migrate_commitment(ctx)
    }

    /// Guardian or authority: pause for `PAUSE_TTL` (72h). A guardian pause cannot be repeated for 7 days.
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::config::handle_pause(ctx)
    }

    /// Authority only.
    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::config::handle_unpause(ctx)
    }

    /// Host records a bond-backed capacity commitment.
    pub fn commit_capacity(ctx: Context<CommitCapacity>, args: CommitCapacityArgs) -> Result<()> {
        instructions::commitment::handle_commit_capacity(ctx, args)
    }

    /// Sale authority records a purchase bound to `key_hash`. No transfer exists.
    pub fn buy_lot(ctx: Context<BuyLot>, args: BuyLotArgs) -> Result<()> {
        instructions::lot::handle_buy_lot(ctx, args)
    }

    /// Sale authority marks a lot redeemed; credits are issued off-chain against the event.
    pub fn redeem_lot(ctx: Context<RedeemLot>) -> Result<()> {
        instructions::lot::handle_redeem_lot(ctx)
    }

    /// Authority reports unserved tokens after `window_end` (0 settles the commitment).
    pub fn report_shortfall(ctx: Context<ReportShortfall>, unserved_tokens: u64) -> Result<()> {
        instructions::commitment::handle_report_shortfall(ctx, unserved_tokens)
    }

    /// Anyone, after `window_end + CLAIM_PERIOD`: settle a commitment and release its bond lock.
    pub fn release_commitment(ctx: Context<ReleaseCommitment>) -> Result<()> {
        instructions::commitment::handle_release_commitment(ctx)
    }

    /// Authority honours a lot's unserved share on another host of the same grade.
    pub fn rehome_lot(ctx: Context<RehomeLot>) -> Result<()> {
        instructions::lot::handle_rehome_lot(ctx)
    }

    /// Authority files `price_paid * unserved / tokens` against the host's bond; all claims of a commitment together
    /// stay within its value, and the bond pays them out of what the commitment locked.
    pub fn claim_lot_shortfall(
        ctx: Context<ClaimLotShortfall>,
        proposal_id: u64,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lot::handle_claim_lot_shortfall(ctx, proposal_id, evidence_hash)
    }

    /// HVX authority publishes the hourly index (never for a future hour). Nothing settles against it.
    pub fn publish_hvx(
        ctx: Context<PublishHvx>,
        grade: u8,
        hour: i64,
        usd_per_mtoken: u64,
        thin: bool,
    ) -> Result<()> {
        instructions::hvx::handle_publish_hvx(ctx, grade, hour, usd_per_mtoken, thin)
    }
}
