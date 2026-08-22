use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    errors::CreditsError,
    events::SpentRootCommitted,
    state::{pause_active, CreditsConfig, SettleLimiter, SpentRoot},
};

#[derive(Accounts)]
#[instruction(hour: i64)]
pub struct CommitSpentRoot<'info> {
    #[account(mut)]
    pub settlement_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settlement_authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
    /// One account per hour: a second commit for the same hour fails at `init`.
    #[account(
        init,
        payer = settlement_authority,
        space = 8 + SpentRoot::INIT_SPACE,
        seeds = [SPENT_ROOT_SEED, hour.to_le_bytes().as_ref()],
        bump
    )]
    pub spent_root: Account<'info, SpentRoot>,
    #[account(address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

/// Commits the hour's spend root and advances `spent_total` by `spent_delta`, the USDC spent
/// (6 decimals) across all keys during that hour. `settle_to_host` is bounded by this total.
///
/// Bounds on the settlement key: the hour cannot be in the future (a far-future hour would block every later commit),
/// and committed-but-unsettled spend can never exceed what the vault actually holds.
pub fn handle_commit_spent_root(
    ctx: Context<CommitSpentRoot>,
    hour: i64,
    root: [u8; 32],
    spent_delta: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let limiter = &mut ctx.accounts.limiter;
    require!(!pause_active(limiter.paused, limiter.paused_until, now), CreditsError::SettlementsPaused);
    // Record the vault balance for the outflow limiter's base (it moves nothing here): the hourly commit is what keeps
    // the "lowest balance of the last window" current between payouts.
    let vault_now = ctx.accounts.vault.amount;
    limiter.roll_base(vault_now, now);
    limiter.note_vault(vault_now);
    require!(hour >= 0 && hour % SECONDS_PER_HOUR == 0, CreditsError::InvalidHour);
    require!(hour <= now, CreditsError::HourInFuture);
    let config = &mut ctx.accounts.config;
    require!(hour > config.latest_hour, CreditsError::HourNotIncreasing);

    let new_total = config
        .spent_total
        .checked_add(spent_delta)
        .ok_or(CreditsError::Overflow)?;
    if spent_delta > 0 {
        let unsettled = new_total
            .checked_sub(config.settled_total)
            .ok_or(CreditsError::Overflow)?;
        require!(unsettled <= ctx.accounts.vault.amount, CreditsError::SpendExceedsVault);
    }
    config.spent_total = new_total;
    config.latest_hour = hour;

    let spent_root = &mut ctx.accounts.spent_root;
    spent_root.hour = hour;
    spent_root.root = root;
    spent_root.spent_delta = spent_delta;
    spent_root.cumulative_spent = config.spent_total;
    spent_root.committed_at = now;
    spent_root.bump = ctx.bumps.spent_root;

    emit!(SpentRootCommitted { hour, root, spent_delta, spent_total: config.spent_total });
    Ok(())
}
