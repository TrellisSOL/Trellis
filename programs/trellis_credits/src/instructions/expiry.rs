use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    errors::CreditsError,
    events::{ExpiredSwept, ExpiryNoticed},
    state::{pause_active, CreditAccount, CreditsConfig, SettleLimiter},
};

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct NoticeExpiry<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settlement_authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [CREDIT_SEED, key_hash.as_ref()], bump = credit.bump)]
    pub credit: Account<'info, CreditAccount>,
}

/// Records the 30-day grace notice for an expired balance. The emitted event is what the
/// off-chain notifier relays to the key owner. A deposit after the notice extends the balance
/// and clears the notice.
pub fn handle_notice_expiry(ctx: Context<NoticeExpiry>, key_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let credit = &mut ctx.accounts.credit;
    require!(!credit.closed, CreditsError::AccountClosed);
    require!(credit.balance > 0, CreditsError::EmptyBalance);
    require!(now >= credit.expires_at, CreditsError::NotExpired);
    require!(credit.expiry_notice_at == 0, CreditsError::ExpiryNoticeAlreadyGiven);
    credit.expiry_notice_at = now;
    emit!(ExpiryNoticed {
        key_hash,
        balance: credit.balance,
        notice_at: now,
        sweepable_at: now
            .checked_add(ctx.accounts.config.expiry_grace)
            .ok_or(CreditsError::Overflow)?,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct SweepExpired<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settlement_authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
    #[account(mut, seeds = [CREDIT_SEED, key_hash.as_ref()], bump = credit.bump)]
    pub credit: Account<'info, CreditAccount>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.treasury_token_account @ CreditsError::MintMismatch)]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ CreditsError::MintMismatch)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Moves the unspent part of an expired, noticed balance to treasury once the grace period has elapsed.
///
/// `credit.balance` is the key's gross on-chain deposits: spend is tracked off chain and paid to hosts out of the same
/// vault. `amount` is therefore what the key has NOT spent (the settlement service passes the key's remaining ledger
/// balance), never more than `credit.balance`; the spent part stays in the vault for `settle_to_host`. The whole
/// balance is then cleared, so a key is swept once.
pub fn handle_sweep_expired(ctx: Context<SweepExpired>, key_hash: [u8; 32], amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let limiter = &mut ctx.accounts.limiter;
    require!(!pause_active(limiter.paused, limiter.paused_until, now), CreditsError::SettlementsPaused);
    let config = &ctx.accounts.config;
    let credit = &mut ctx.accounts.credit;
    require!(!credit.closed, CreditsError::AccountClosed);
    require!(credit.balance > 0, CreditsError::EmptyBalance);
    require!(amount <= credit.balance, CreditsError::SweepExceedsBalance);
    // A sweep lowers the vault: record what it leaves for the outflow limiter's base.
    let vault_now = ctx.accounts.vault.amount;
    limiter.roll_base(vault_now, now);
    limiter.note_vault(vault_now.saturating_sub(amount));
    require!(now >= credit.expires_at, CreditsError::NotExpired);
    require!(credit.expiry_notice_at != 0, CreditsError::ExpiryNoticeMissing);
    let sweepable_at = credit
        .expiry_notice_at
        .checked_add(config.expiry_grace)
        .ok_or(CreditsError::Overflow)?;
    require!(now >= sweepable_at, CreditsError::GracePeriodNotElapsed);

    credit.balance = 0;
    credit.expiry_notice_at = 0;

    if amount == 0 {
        emit!(ExpiredSwept {
            key_hash,
            amount,
            treasury_token_account: ctx.accounts.treasury_token_account.key(),
        });
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(ExpiredSwept {
        key_hash,
        amount,
        treasury_token_account: ctx.accounts.treasury_token_account.key(),
    });
    Ok(())
}
