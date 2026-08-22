use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    errors::CreditsError,
    events::RefundPaid,
    state::{refill_allowance, window_cap, CreditsConfig, DepositorShare, RefundRequest, SettleLimiter},
};

#[derive(Accounts)]
pub struct PayRefund<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settlement_authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
    #[account(
        mut,
        seeds = [REFUND_SEED, refund_request.key_hash.as_ref()],
        bump = refund_request.bump,
    )]
    pub refund_request: Account<'info, RefundRequest>,
    /// The share of one wallet that deposited to this key: the refund is that wallet's own USDC coming back.
    #[account(
        mut,
        seeds = [SHARE_SEED, refund_request.key_hash.as_ref(), share.depositor.as_ref()],
        bump = share.bump,
    )]
    pub share: Account<'info, DepositorShare>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        address = share.refund_to @ CreditsError::InvalidRefundDestination,
        constraint = refund_to.mint == config.usdc_mint @ CreditsError::MintMismatch,
    )]
    pub refund_to: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ CreditsError::MintMismatch)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays (part of) a queued closure refund to one of the key's depositors, after the request's `payable_at`.
///
/// Where it can go and how much, whoever holds the settlement key or the API key:
/// - only to `share.refund_to`, the token account that depositor named (the key names none);
/// - at most what that depositor put into the key (`share.refunded <= share.deposited`);
/// - at most the request in total (`paid_amount <= amount`); payments are cumulative, so a partial payment never
///   forfeits the rest;
/// - within the refund allowance, which refills like the host-settlement allowance but is separate from it: host
///   payouts cannot use up what refunds may take, and refunds cannot hold up host payouts.
/// `amount` may be lower than the request when spend was still uncommitted at closure; the remainder stays in the vault
/// to be settled to hosts. This instruction is never paused.
pub fn handle_pay_refund(ctx: Context<PayRefund>, amount: u64) -> Result<()> {
    require!(amount > 0, CreditsError::ZeroAmount);
    let request = &mut ctx.accounts.refund_request;
    require!(!request.paid, CreditsError::RefundAlreadyPaid);
    let paid_amount = request.paid_amount.checked_add(amount).ok_or(CreditsError::Overflow)?;
    require!(paid_amount <= request.amount, CreditsError::RefundExceedsRequest);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= request.payable_at, CreditsError::RefundDelayNotElapsed);

    let share = &mut ctx.accounts.share;
    let refunded = share.refunded.checked_add(amount).ok_or(CreditsError::Overflow)?;
    require!(refunded <= share.deposited, CreditsError::RefundExceedsShare);

    let limiter = &mut ctx.accounts.limiter;
    let vault_now = ctx.accounts.vault.amount;
    let base = limiter.roll_base(vault_now, now);
    let cap = window_cap(base, limiter.rate_bps, limiter.cap_per_window);
    let allowance = refill_allowance(limiter.refund_allowance, limiter.refund_refilled_at, cap, now);
    require!(amount <= allowance, CreditsError::RefundRateLimited);
    limiter.refund_allowance = allowance - amount;
    limiter.refund_refilled_at = now;
    limiter.note_vault(vault_now.saturating_sub(amount));

    share.refunded = refunded;
    request.paid_amount = paid_amount;
    request.paid = paid_amount == request.amount;

    let config = &ctx.accounts.config;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.refund_to.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(RefundPaid {
        key_hash: request.key_hash,
        amount,
        refund_to: share.refund_to,
        depositor: share.depositor,
    });
    Ok(())
}
