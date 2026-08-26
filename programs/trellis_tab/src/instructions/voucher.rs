use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    ed25519::verify_voucher,
    errors::TabError,
    events::*,
    instructions::tab::{can_receive, payer_ata, settle},
    state::*,
};

/// Common voucher checks: within cap, strictly increasing `seq`, never below what the payee
/// has already posted (replay protection), and attested by the Ed25519 precompile.
fn check_voucher(
    tab: &Tab,
    tab_key: &Pubkey,
    instructions_sysvar: &AccountInfo,
    cumulative_used: u64,
    seq: u64,
) -> Result<()> {
    require!(!tab.is_final(), TabError::TabFinal);
    require!(cumulative_used <= tab.cap, TabError::VoucherExceedsCap);
    require!(seq > tab.posted_seq && seq != Tab::FINAL_SEQ, TabError::VoucherSeqNotIncreasing);
    require!(cumulative_used >= tab.posted_used, TabError::VoucherBelowPosted);
    verify_voucher(
        instructions_sysvar,
        &tab.session_key,
        tab_key,
        tab.created_at,
        cumulative_used,
        seq,
    )
}

#[derive(Accounts)]
pub struct PostVoucher<'info> {
    pub payee: Signer<'info>,
    #[account(
        mut,
        seeds = [TAB_SEED, tab.payer.as_ref(), tab.payee.as_ref(), &tab.tab_id.to_le_bytes()],
        bump = tab.bump,
        has_one = payee @ TabError::Unauthorized,
    )]
    pub tab: Account<'info, Tab>,
    /// CHECK: address-checked against the instructions sysvar id.
    #[account(address = solana_instructions_sysvar::ID @ TabError::BadInstructionsSysvar)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// Payee records the highest voucher it holds without closing the tab. It needs nothing but the tab and the voucher
/// (no token account, no rulebook), so the payee can always secure its vouched usage against a later `reclaim`.
pub fn handle_post_voucher(ctx: Context<PostVoucher>, cumulative_used: u64, seq: u64) -> Result<()> {
    let tab_key = ctx.accounts.tab.key();
    check_voucher(
        &ctx.accounts.tab,
        &tab_key,
        &ctx.accounts.instructions_sysvar.to_account_info(),
        cumulative_used,
        seq,
    )?;
    let tab = &mut ctx.accounts.tab;
    tab.posted_used = cumulative_used;
    tab.posted_seq = seq;
    emit!(VoucherPosted {
        tab: tab_key,
        cumulative_used,
        seq,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Close<'info> {
    pub payee: Signer<'info>,
    /// CHECK: receives the tab's rent; must equal `tab.payer`.
    #[account(mut, address = tab.payer @ TabError::Unauthorized)]
    pub payer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [TAB_SEED, tab.payer.as_ref(), tab.payee.as_ref(), &tab.tab_id.to_le_bytes()],
        bump = tab.bump,
        has_one = payee @ TabError::Unauthorized,
        has_one = mint @ TabError::MintMismatch,
    )]
    pub tab: Account<'info, Tab>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TabConfig>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, tab.key().as_ref()],
        bump = tab.escrow_bump,
        token::mint = mint,
        token::authority = tab,
    )]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: the payer's USDC token account. It does NOT have to exist: the payer controls it, and a closed or frozen
    /// account must not stop the payee from being paid. When it cannot receive, it must be the payer's associated
    /// token account address and the refund stays in escrow for `reclaim` (see `settle`).
    #[account(mut)]
    pub payer_token: UncheckedAccount<'info>,
    /// CHECK: the payee's USDC token account; `close` requires that it can receive (checked in the handler).
    #[account(mut)]
    pub payee_token: UncheckedAccount<'info>,
    /// CHECK: address-checked against the instructions sysvar id.
    #[account(address = solana_instructions_sysvar::ID @ TabError::BadInstructionsSysvar)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Payee closes the tab with the final voucher: pays `cumulative_used` to the payee and refunds the rest of the escrow
/// to the payer. Nothing the payer controls can make it fail: not its token account (the refund then waits in escrow),
/// not a rulebook (never consulted at settlement), not a stray deposit (settlement works from the real balance).
pub fn handle_close(ctx: Context<Close>, cumulative_used: u64, seq: u64) -> Result<()> {
    let tab_key = ctx.accounts.tab.key();
    check_voucher(
        &ctx.accounts.tab,
        &tab_key,
        &ctx.accounts.instructions_sysvar.to_account_info(),
        cumulative_used,
        seq,
    )?;

    {
        let tab = &ctx.accounts.tab;
        // The payee signs: its own account must be able to receive.
        require!(
            cumulative_used == 0 || can_receive(&ctx.accounts.payee_token, &tab.mint, &tab.payee),
            TabError::PayeeTokenAccountInvalid
        );
        // The payee cannot defer the payer's refund by naming a bogus account: either the named account can receive,
        // or it is the payer's own associated token account (which then simply does not exist or is frozen).
        require!(
            can_receive(&ctx.accounts.payer_token, &tab.mint, &tab.payer)
                || ctx.accounts.payer_token.key() == payer_ata(tab),
            TabError::TokenOwnerMismatch
        );
    }

    let (payer, payee) = (ctx.accounts.tab.payer, ctx.accounts.tab.payee);
    let tab = &mut ctx.accounts.tab;
    tab.posted_used = cumulative_used;
    tab.posted_seq = seq;

    let s = settle(
        tab,
        &ctx.accounts.escrow,
        &ctx.accounts.mint,
        &ctx.accounts.payee_token,
        &ctx.accounts.payer_token,
        &ctx.accounts.payer,
        &ctx.accounts.token_program,
    )?;

    emit!(TabClosed {
        tab: tab_key,
        payer,
        payee,
        used: s.paid_payee,
        refunded: s.paid_payer,
        seq,
    });
    Ok(())
}
