use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::AnchorError,
    events::{RootClosed, RootPosted},
    state::{ReceiptRoot, SignerSet},
};

#[derive(Accounts)]
#[instruction(hour: i64)]
pub struct PostRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
    /// One account per hour. A second `post_root` for the same hour fails at `init`
    /// (account already in use), which makes posting idempotent per hour.
    #[account(
        init,
        payer = authority,
        space = 8 + ReceiptRoot::INIT_SPACE,
        seeds = [RECEIPT_ROOT_SEED, hour.to_le_bytes().as_ref()],
        bump
    )]
    pub receipt_root: Account<'info, ReceiptRoot>,
    pub system_program: Program<'info, System>,
}

/// Posts the sha256 Merkle root of `count` receipts issued during `hour` (unix seconds,
/// multiple of 3600). See `crate::merkle` for the tree definition.
pub fn handle_post_root(ctx: Context<PostRoot>, hour: i64, root: [u8; 32], count: u64) -> Result<()> {
    require!(hour >= 0 && hour % SECONDS_PER_HOUR == 0, AnchorError::InvalidHour);
    let now = Clock::get()?.unix_timestamp;
    // One root per hour and no way to correct it: a root for an hour that has not started could only be a guess.
    require!(hour <= now, AnchorError::HourInFuture);
    // An hour whose root could already have been closed is never posted (again): one root per hour, for ever.
    require!(closable_at(hour).ok_or(AnchorError::Overflow)? > now, AnchorError::HourTooOld);
    let rr = &mut ctx.accounts.receipt_root;
    rr.hour = hour;
    rr.root = root;
    rr.count = count;
    rr.signer = ctx.accounts.signer_set.current_signer;
    rr.posted_at = now;
    rr.bump = ctx.bumps.receipt_root;
    emit!(RootPosted { hour, root, count, signer: rr.signer, posted_at: now });
    Ok(())
}

#[derive(Accounts)]
#[instruction(hour: i64)]
pub struct CloseRoot<'info> {
    /// The authority paid the root's rent and gets it back.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
    #[account(
        mut,
        close = authority,
        seeds = [RECEIPT_ROOT_SEED, hour.to_le_bytes().as_ref()],
        bump = receipt_root.bump,
    )]
    pub receipt_root: Account<'info, ReceiptRoot>,
}

/// Closes the root of an hour that ended at least `ROOT_RETENTION` ago and returns its rent to the authority. The hour
/// can never be posted again (`post_root` refuses it), and the closed root stays provable from the transaction that
/// posted it: its instruction data and its `RootPosted` event carry the hour, the root and the count.
pub fn handle_close_root(ctx: Context<CloseRoot>, hour: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= closable_at(hour).ok_or(AnchorError::Overflow)?, AnchorError::RetentionNotElapsed);
    let rr = &ctx.accounts.receipt_root;
    emit!(RootClosed { hour: rr.hour, root: rr.root, count: rr.count, posted_at: rr.posted_at });
    Ok(())
}
