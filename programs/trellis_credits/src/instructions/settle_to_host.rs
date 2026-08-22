use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    errors::CreditsError,
    events::SettledToHost,
    state::{pause_active, refill_allowance, window_cap, CreditsConfig, SettleLimiter, SpentRoot},
};

#[derive(Accounts)]
#[instruction(amount: u64, hour_root_ref: i64)]
pub struct SettleToHost<'info> {
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
    /// The committed hour this settlement references (must exist).
    #[account(
        seeds = [SPENT_ROOT_SEED, hour_root_ref.to_le_bytes().as_ref()],
        bump = spent_root.bump,
    )]
    pub spent_root: Account<'info, SpentRoot>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = host_token_account.mint == config.usdc_mint @ CreditsError::MintMismatch,
    )]
    pub host_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ CreditsError::MintMismatch)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays a host from the vault. Two bounds hold whoever signs: cumulative settlements never exceed cumulative committed
/// spend (`settled_total + amount <= spent_total`), and the payment must fit the settlement allowance, which refills
/// continuously (`state::refill_allowance`): over ANY interval of `SETTLE_WINDOW` (24h) the host payouts add up to at
/// most `window_cap`, and at most a quarter of that can leave at one moment. There is no window boundary, so a stolen
/// settlement key cannot take one cap just before a reset and another just after it (security re-review RR-01). The
/// cap is a share of the lowest vault balance of the last window, never more than `cap_per_window`: depositing to
/// raise it does not work within a window, and capital left in longer still cannot lift it above the absolute bound
/// (security review round 3, R3-07).
pub fn handle_settle_to_host(ctx: Context<SettleToHost>, amount: u64, hour_root_ref: i64) -> Result<()> {
    require!(amount > 0, CreditsError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let limiter = &mut ctx.accounts.limiter;
    require!(!pause_active(limiter.paused, limiter.paused_until, now), CreditsError::SettlementsPaused);

    let vault_now = ctx.accounts.vault.amount;
    let base = limiter.roll_base(vault_now, now);
    let cap = window_cap(base, limiter.rate_bps, limiter.cap_per_window);
    let allowance = refill_allowance(limiter.settle_allowance, limiter.settle_refilled_at, cap, now);
    require!(amount <= allowance, CreditsError::SettleRateLimited);
    limiter.settle_allowance = allowance - amount;
    limiter.settle_refilled_at = now;
    limiter.note_vault(vault_now.saturating_sub(amount));

    let config = &mut ctx.accounts.config;
    let new_settled = config
        .settled_total
        .checked_add(amount)
        .ok_or(CreditsError::Overflow)?;
    require!(new_settled <= config.spent_total, CreditsError::SettlementExceedsCommittedSpend);
    config.settled_total = new_settled;

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.host_token_account.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(SettledToHost {
        host_token_account: ctx.accounts.host_token_account.key(),
        amount,
        hour_root_ref,
        settled_total: new_settled,
    });
    Ok(())
}
