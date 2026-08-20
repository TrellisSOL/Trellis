use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::AnchorError,
    events::{HostRootClosed, HostRootPosted},
    state::{HostRoot, SignerSet},
};

#[derive(Accounts)]
#[instruction(provider_id_hash: [u8; 32], hour: i64)]
pub struct PostHostRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
    /// One account per (host, hour). A second `post_host_root` for the same pair fails at
    /// `init` (account already in use), which makes posting idempotent per host and hour.
    #[account(
        init,
        payer = authority,
        space = 8 + HostRoot::INIT_SPACE,
        seeds = [HOST_ROOT_SEED, provider_id_hash.as_ref(), hour.to_le_bytes().as_ref()],
        bump
    )]
    pub host_root: Account<'info, HostRoot>,
    pub system_program: Program<'info, System>,
}

/// Posts the sha256 Merkle root of `count` receipts one attested host issued during `hour`
/// (unix seconds, multiple of 3600). `provider_id_hash` is sha256 of the router's provider id,
/// the same id hash the other programs use. See `crate::merkle` for the tree definition.
pub fn handle_post_host_root(
    ctx: Context<PostHostRoot>,
    provider_id_hash: [u8; 32],
    hour: i64,
    root: [u8; 32],
    count: u64,
) -> Result<()> {
    require!(hour >= 0 && hour % SECONDS_PER_HOUR == 0, AnchorError::InvalidHour);
    require!(provider_id_hash != [0u8; 32], AnchorError::InvalidProviderId);
    let now = Clock::get()?.unix_timestamp;
    // One root per hour and no way to correct it: a root for an hour that has not started could only be a guess.
    require!(hour <= now, AnchorError::HourInFuture);
    // An hour whose root could already have been closed is never posted (again): one root per host and hour, for ever.
    require!(closable_at(hour).ok_or(AnchorError::Overflow)? > now, AnchorError::HourTooOld);
    let hr = &mut ctx.accounts.host_root;
    hr.provider_id_hash = provider_id_hash;
    hr.hour = hour;
    hr.root = root;
    hr.count = count;
    hr.signer = ctx.accounts.signer_set.current_signer;
    hr.posted_at = now;
    hr.bump = ctx.bumps.host_root;
    emit!(HostRootPosted { provider_id_hash, hour, root, count, signer: hr.signer, posted_at: now });
    Ok(())
}

#[derive(Accounts)]
#[instruction(provider_id_hash: [u8; 32], hour: i64)]
pub struct CloseHostRoot<'info> {
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
        seeds = [HOST_ROOT_SEED, provider_id_hash.as_ref(), hour.to_le_bytes().as_ref()],
        bump = host_root.bump,
    )]
    pub host_root: Account<'info, HostRoot>,
}

/// Closes one host's root of an hour that ended at least `ROOT_RETENTION` ago; see `handle_close_root`.
pub fn handle_close_host_root(ctx: Context<CloseHostRoot>, _provider_id_hash: [u8; 32], hour: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= closable_at(hour).ok_or(AnchorError::Overflow)?, AnchorError::RetentionNotElapsed);
    let hr = &ctx.accounts.host_root;
    emit!(HostRootClosed { provider_id_hash: hr.provider_id_hash, hour: hr.hour, root: hr.root, count: hr.count, posted_at: hr.posted_at });
    Ok(())
}
