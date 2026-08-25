//! `trellis_tab` — the tab x402 scheme (Backend spec section 5.2).
//!
//! A payer opens a tab by escrowing `cap` USDC in a PDA token account and registering a
//! session key. Off-chain, the session key signs vouchers `{tab, cumulative_used, seq}` with
//! Ed25519, over a message that is domain-separated and bound to this program and to this opening
//! of the tab (`ed25519::voucher_message`, security review TR-19). The payee closes the tab with the final voucher: the Ed25519 precompile instruction
//! immediately preceding `close` is introspected through the instructions sysvar, the payee is
//! paid `cumulative_used`, the payer gets the rest of the escrow back, and both PDAs close.
//! If the payee never closes, anyone can deliver the escrow after `expiry + 24h` (`reclaim`): the payee is
//! still paid the highest voucher it posted with `post_voucher`, the payer gets the rest.
//!
//! Settlement guarantees (security/REVIEW-2026-10.md TR-03, TR-04, TR-10):
//! - it works from the escrow's real balance, so a stray deposit cannot freeze a tab (it is refunded to the payer);
//! - neither side can block the other: a side whose token account is missing, closed or frozen leaves its share in
//!   escrow, claimable later, while the other side is paid;
//! - a rulebook is consulted only when USDC is committed (`open_tab`, `top_up`), never at settlement.
//!
//! Authorities: `authority` is a single pubkey here; in production it is a Squads v4 2-of-3
//! multisig. The `guardian` (a separate key, held by neither the operator nor the multisig) can only pause new tabs and never moves funds.
//! Cap per tab is limited to `max_cap` (500 USDC by default, and no key can set it above 500 USDC: `MAX_CAP_LIMIT`) until audit. `reclaim_grace` has compiled bounds, loosening
//! config changes wait a 24h timelock, and `initialize_config` only accepts the program's upgrade authority.

#![allow(unexpected_cfgs)]

pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use state::*;

declare_id!("9ZmEvfrQrZuVXGc4PovskV83KNxVvpFpvSu3K6R9a9tL");

#[program]
pub mod trellis_tab {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
        instructions::config::handle_initialize_config(ctx, args)
    }

    /// Authority: tightening only (a lower `max_cap`), effective at once. Loosening is refused (`RequiresTimelock`).
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

    /// `open_tab(payer, payee, mint, cap, expiry)`: escrow `cap` USDC and register the session key.
    pub fn open_tab(ctx: Context<OpenTab>, args: OpenTabArgs) -> Result<()> {
        instructions::tab::handle_open_tab(ctx, args)
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        instructions::tab::handle_top_up(ctx, amount)
    }

    /// Payee records a voucher without closing. Requires a preceding Ed25519 instruction.
    pub fn post_voucher(ctx: Context<PostVoucher>, cumulative_used: u64, seq: u64) -> Result<()> {
        instructions::voucher::handle_post_voucher(ctx, cumulative_used, seq)
    }

    /// Payee closes with the final voucher. Requires a preceding Ed25519 instruction.
    pub fn close(ctx: Context<Close>, cumulative_used: u64, seq: u64) -> Result<()> {
        instructions::voucher::handle_close(ctx, cumulative_used, seq)
    }

    /// Anyone: deliver the escrow after `expiry + reclaim_grace`, or at any time once the payee has closed.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        instructions::tab::handle_reclaim(ctx)
    }
}
