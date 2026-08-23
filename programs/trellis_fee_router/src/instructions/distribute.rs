use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    errors::FeeRouterError,
    events::FeesDistributed,
    state::{Distribution, FeeConfig},
};

#[derive(Accounts)]
#[instruction(period: i64)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ FeeRouterError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,
    /// One per period; a second `distribute` for the same period fails at `init`.
    #[account(
        init,
        payer = authority,
        space = 8 + Distribution::INIT_SPACE,
        seeds = [DISTRIBUTION_SEED, period.to_le_bytes().as_ref()],
        bump
    )]
    pub distribution: Account<'info, Distribution>,
    #[account(mut, address = fee_config.fee_vault)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = fee_config.workers_vault @ FeeRouterError::MintMismatch)]
    pub workers_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = fee_config.treasury_vault @ FeeRouterError::MintMismatch)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = fee_config.fee_mint @ FeeRouterError::MintMismatch)]
    pub fee_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Splits the whole fee vault balance for `period` (weekly index, strictly increasing):
/// `workers = total * workers_bps / 10_000`, `treasury = total - workers`.
pub fn handle_distribute(ctx: Context<Distribute>, period: i64) -> Result<()> {
    let total = ctx.accounts.fee_vault.amount;
    require!(total > 0, FeeRouterError::NothingToDistribute);
    let c = &mut ctx.accounts.fee_config;
    require!(period > c.last_period, FeeRouterError::PeriodNotIncreasing);
    // Periods are whole weeks since the unix epoch. A period beyond the current week would block every later
    // distribution (periods must increase), so it is refused.
    let current_week = Clock::get()?.unix_timestamp.div_euclid(SECONDS_PER_WEEK);
    require!(period <= current_week, FeeRouterError::PeriodInFuture);

    let workers_amount: u64 = (total as u128)
        .checked_mul(c.workers_bps as u128)
        .ok_or(FeeRouterError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(FeeRouterError::Overflow)?
        .try_into()
        .map_err(|_| FeeRouterError::Overflow)?;
    let treasury_amount = total.checked_sub(workers_amount).ok_or(FeeRouterError::Overflow)?;

    c.last_period = period;
    c.distributed_total = c.distributed_total.checked_add(total).ok_or(FeeRouterError::Overflow)?;

    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CONFIG_SEED, &[c.bump]]];
    let decimals = ctx.accounts.fee_mint.decimals;
    if workers_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.fee_vault.to_account_info(),
                    mint: ctx.accounts.fee_mint.to_account_info(),
                    to: ctx.accounts.workers_vault.to_account_info(),
                    authority: c.to_account_info(),
                },
                signer_seeds,
            ),
            workers_amount,
            decimals,
        )?;
    }
    if treasury_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.fee_vault.to_account_info(),
                    mint: ctx.accounts.fee_mint.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: c.to_account_info(),
                },
                signer_seeds,
            ),
            treasury_amount,
            decimals,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let d = &mut ctx.accounts.distribution;
    d.period = period;
    d.total = total;
    d.workers_amount = workers_amount;
    d.treasury_amount = treasury_amount;
    d.distributed_at = now;
    d.bump = ctx.bumps.distribution;

    emit!(FeesDistributed { period, total, workers_amount, treasury_amount, distributed_at: now });
    Ok(())
}
