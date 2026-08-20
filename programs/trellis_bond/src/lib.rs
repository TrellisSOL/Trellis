//! `trellis_bond` — host bonds for the Trellis network (Backend spec section 5.3).
//!
//! Hosts post at least 10,000 USDC. Unbonding takes 14 days. The slasher authority opens a
//! slash proposal with an evidence hash; a 72h public dispute window follows. The host may
//! dispute inside the window, which blocks execution until the authority resolves it or 7 days
//! pass. Executed slashes pay affected callers first (`refund_pool`), the remainder goes to
//! treasury; capacity-shortfall claims pay the exact purchase price of unserved Bushels to the
//! capacity refund account.
//!
//! Floors no key can bypass (`state.rs`): the dispute window is at least 72h, a dispute blocks for at least 7 days,
//! unbonding takes at least 14 days, one proposal slashes at most 50% and all rate-based slashes of a bond within any
//! 30 days at most 50% together (`SlashLedger`), loosening config changes (including the payout
//! accounts) and authority hand-overs wait a 24h timelock, and `initialize_config` only accepts the program's upgrade
//! authority. USDC locked behind open capacity commitments (`BondLock`) cannot be withdrawn, and capacity-shortfall
//! claims are paid for out of that lock: together they never exceed what the host's commitments locked. A slash the
//! cumulative cap would cut is executed by the slasher only, one cut to zero neither delists nor ejects, and a delisted
//! bond is reinstated only by the authority through the same 24h timelock.
//!
//! Authorities: `authority` and `slasher` are single pubkeys here; in production they are a
//! Squads v4 2-of-3 multisig. The `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new bonds and never moves funds.

#![allow(unexpected_cfgs)]

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use state::*;

declare_id!("EEiEdi8PVvCALtEXpgReQb32R5bUGz29zfAeoh1Kc8Vo");

#[program]
pub mod trellis_bond {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
        instructions::config::handle_initialize_config(ctx, args)
    }

    /// Authority: tightening changes only, effective at once. Loosening is refused (`RequiresTimelock`).
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

    /// Guardian or authority: pause for `PAUSE_TTL` (72h). A guardian pause cannot be repeated for 7 days.
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::config::handle_pause(ctx)
    }

    /// Authority only.
    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::config::handle_unpause(ctx)
    }

    pub fn post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
        instructions::bond::handle_post_bond(ctx, amount)
    }

    pub fn request_unbond(ctx: Context<HostOnly>) -> Result<()> {
        instructions::bond::handle_request_unbond(ctx)
    }

    pub fn cancel_unbond(ctx: Context<HostOnly>) -> Result<()> {
        instructions::bond::handle_cancel_unbond(ctx)
    }

    pub fn withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
        instructions::bond::handle_withdraw_bond(ctx)
    }

    /// `trellis_capacity` only (CPI): lock part of a bond behind a capacity commitment.
    pub fn lock_bond(ctx: Context<LockBond>, amount: u64) -> Result<()> {
        instructions::bond::handle_lock_bond(ctx, amount)
    }

    /// `trellis_capacity` only (CPI): release a settled commitment's lock.
    pub fn unlock_bond(ctx: Context<UnlockBond>, amount: u64) -> Result<()> {
        instructions::bond::handle_unlock_bond(ctx, amount)
    }

    pub fn propose_slash(
        ctx: Context<ProposeSlash>,
        proposal_id: u64,
        evidence_hash: [u8; 32],
        bps: u16,
        reason_code: u8,
        refund_amount: u64,
    ) -> Result<()> {
        instructions::slash::handle_propose_slash(
            ctx,
            proposal_id,
            evidence_hash,
            bps,
            reason_code,
            refund_amount,
        )
    }

    pub fn file_capacity_claim(
        ctx: Context<FileCapacityClaim>,
        proposal_id: u64,
        evidence_hash: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::slash::handle_file_capacity_claim(ctx, proposal_id, evidence_hash, amount)
    }

    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        instructions::slash::handle_dispute(ctx)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, upheld: bool) -> Result<()> {
        instructions::slash::handle_resolve_dispute(ctx, upheld)
    }

    pub fn execute_slash(ctx: Context<ExecuteSlash>) -> Result<()> {
        instructions::slash::handle_execute_slash(ctx)
    }

    /// Authority: drop a proposal that has not executed, disputed or not (for example one that can never execute).
    pub fn void_proposal(ctx: Context<VoidProposal>) -> Result<()> {
        instructions::slash::handle_void_proposal(ctx)
    }

    /// Grows a proposal created by an earlier version to the current layout (anyone may pay; works once).
    pub fn migrate_proposal(ctx: Context<MigrateProposal>) -> Result<()> {
        instructions::config::handle_migrate_proposal(ctx)
    }

    pub fn close_proposal(ctx: Context<CloseProposal>) -> Result<()> {
        instructions::slash::handle_close_proposal(ctx)
    }

    /// Authority: propose to clear `delisted` / `ejected` on a bond. Applicable after `CONFIG_TIMELOCK` (24h).
    pub fn propose_reinstate(ctx: Context<ProposeReinstate>) -> Result<()> {
        instructions::slash::handle_propose_reinstate(ctx)
    }

    /// `apply = true`: the authority reinstates the bond after the timelock. `apply = false`: the authority drops the
    /// proposal; anyone may clear an expired one.
    pub fn resolve_reinstate(ctx: Context<ResolveReinstate>, apply: bool) -> Result<()> {
        instructions::slash::handle_resolve_reinstate(ctx, apply)
    }
}
