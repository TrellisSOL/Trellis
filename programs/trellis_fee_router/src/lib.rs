//! trellis_fee_router: protocol fee collection into the treasury vault and the $TRLS inference-payment burn
//! (Trellis Backend §5.7, Overview §4).
//!
//! - `FeeConfig{workers_bps = 0, treasury_bps = 10_000}`: no fee split. Protocol fees go 100% to the
//!   treasury; the two values must still sum to 10,000 and are the only recipients the instruction
//!   knows. Weekly `distribute(period)` moves the fee vault into the treasury vault (and the workers
//!   vault, should governance ever set a non-zero workers share). Hosts are paid their list price;
//!   relay operators and canary runners receive flat service fees from the treasury off-chain.
//! - `burn_inference_payment(amount)` burns $TRLS (Token-2022) received as payment for
//!   inference. It is the only burn path. No fees are paid to token holders or stakers.
//! - `authority` is a single pubkey for now; production authority is a Squads 2-of-3 multisig.
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

declare_id!("68siMcyf6bvCae4v4TJLkqjBoeM4GfJmTmNSZp8CFRAt");

#[program]
pub mod trellis_fee_router {
    use super::*;

    pub fn init_fee_config(
        ctx: Context<InitFeeConfig>,
        authority: Pubkey,
        workers_bps: u16,
        treasury_bps: u16,
    ) -> Result<()> {
        instructions::admin::handle_init_fee_config(ctx, authority, workers_bps, treasury_bps)
    }

    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        workers_bps: Option<u16>,
        treasury_bps: Option<u16>,
    ) -> Result<()> {
        instructions::admin::handle_update_fee_config(ctx, workers_bps, treasury_bps)
    }

    /// Authority: record replacement payout vaults and / or a new authority; they can be installed after
    /// `CONFIG_TIMELOCK` (24h).
    pub fn propose_change(ctx: Context<ProposeChange>, new_authority: Option<Pubkey>) -> Result<()> {
        instructions::admin::handle_propose_change(ctx, new_authority)
    }

    /// Authority: `apply = true` installs the pending change after the timelock (a new authority must co-sign);
    /// `apply = false` drops it.
    pub fn resolve_change(ctx: Context<ResolveChange>, apply: bool) -> Result<()> {
        instructions::admin::handle_resolve_change(ctx, apply)
    }


    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::admin::handle_build_profile(ctx)
    }

    /// Authority: route the fee vault for `period` per the configured split (default 0/10,000: all to the treasury).
    pub fn distribute(ctx: Context<Distribute>, period: i64) -> Result<()> {
        instructions::distribute::handle_distribute(ctx, period)
    }

    /// Authority: burn $TRLS received as inference payment.
    pub fn burn_inference_payment(ctx: Context<BurnInferencePayment>, amount: u64) -> Result<()> {
        instructions::burn::handle_burn_inference_payment(ctx, amount)
    }
}
