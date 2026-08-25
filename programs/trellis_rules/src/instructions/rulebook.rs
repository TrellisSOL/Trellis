use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::RulesError,
    events::{RulebookClosed, RulebookCreated, RulebookKilled, RulebookUpdated},
    state::{Rulebook, RulesConfig},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RulebookParams {
    pub per_call_max: u64,
    pub daily_max: u64,
    pub payee_allowlist_root: [u8; 32],
    pub model_allowlist_root: [u8; 32],
    pub ask_first_above: u64,
    /// Unix timestamp; must be in the future.
    pub expiry: i64,
}

fn validate(params: &RulebookParams, now: i64) -> Result<()> {
    require!(params.per_call_max > 0, RulesError::InvalidParams);
    require!(params.daily_max >= params.per_call_max, RulesError::InvalidParams);
    require!(params.expiry > now, RulesError::InvalidParams);
    Ok(())
}

fn apply(rb: &mut Rulebook, params: &RulebookParams) {
    rb.per_call_max = params.per_call_max;
    rb.daily_max = params.daily_max;
    rb.payee_allowlist_root = params.payee_allowlist_root;
    rb.model_allowlist_root = params.model_allowlist_root;
    rb.ask_first_above = params.ask_first_above;
    rb.expiry = params.expiry;
}

#[derive(Accounts)]
#[instruction(rulebook_id: u64)]
pub struct CreateRulebook<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RulesConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + Rulebook::INIT_SPACE,
        seeds = [RULEBOOK_SEED, owner.key().as_ref(), rulebook_id.to_le_bytes().as_ref()],
        bump
    )]
    pub rulebook: Account<'info, Rulebook>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_rulebook(ctx: Context<CreateRulebook>, rulebook_id: u64, params: RulebookParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.pause_active(now), RulesError::NewRulebooksPaused);
    validate(&params, now)?;
    let rb = &mut ctx.accounts.rulebook;
    rb.owner = ctx.accounts.owner.key();
    rb.rulebook_id = rulebook_id;
    apply(rb, &params);
    rb.killed = false;
    rb.spent_day = 0;
    rb.spent_today = 0;
    rb.bump = ctx.bumps.rulebook;
    emit!(RulebookCreated {
        rulebook: rb.key(),
        owner: rb.owner,
        rulebook_id,
        per_call_max: rb.per_call_max,
        daily_max: rb.daily_max,
        payee_allowlist_root: rb.payee_allowlist_root,
        model_allowlist_root: rb.model_allowlist_root,
        ask_first_above: rb.ask_first_above,
        expiry: rb.expiry,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct OwnerRulebook<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [RULEBOOK_SEED, owner.key().as_ref(), rulebook.rulebook_id.to_le_bytes().as_ref()],
        bump = rulebook.bump,
        has_one = owner @ RulesError::Unauthorized,
    )]
    pub rulebook: Account<'info, Rulebook>,
}

pub fn handle_update_rulebook(ctx: Context<OwnerRulebook>, params: RulebookParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    validate(&params, now)?;
    let rb = &mut ctx.accounts.rulebook;
    require!(!rb.killed, RulesError::RulebookKilled);
    apply(rb, &params);
    emit!(RulebookUpdated {
        rulebook: rb.key(),
        per_call_max: rb.per_call_max,
        daily_max: rb.daily_max,
        payee_allowlist_root: rb.payee_allowlist_root,
        model_allowlist_root: rb.model_allowlist_root,
        ask_first_above: rb.ask_first_above,
        expiry: rb.expiry,
    });
    Ok(())
}

/// Permanent kill switch: every later `check_spend` / `record_spend` reverts, and the router
/// stops the key on its side when it sees the `RulebookKilled` event.
pub fn handle_kill_rulebook(ctx: Context<OwnerRulebook>) -> Result<()> {
    let rb = &mut ctx.accounts.rulebook;
    require!(!rb.killed, RulesError::RulebookKilled);
    rb.killed = true;
    emit!(RulebookKilled { rulebook: rb.key(), owner: rb.owner, killed_at: Clock::get()?.unix_timestamp });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseRulebook<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [RULEBOOK_SEED, owner.key().as_ref(), rulebook.rulebook_id.to_le_bytes().as_ref()],
        bump = rulebook.bump,
        has_one = owner @ RulesError::Unauthorized,
    )]
    pub rulebook: Account<'info, Rulebook>,
}

/// Reclaims rent of an expired rulebook. A killed rulebook is never closed: its account stays as a tombstone, so the
/// same address cannot come back as a fresh rulebook ("kill is permanent").
pub fn handle_close_rulebook(ctx: Context<CloseRulebook>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rb = &ctx.accounts.rulebook;
    require!(!rb.killed, RulesError::KilledRulebookIsPermanent);
    require!(now > rb.expiry, RulesError::RulebookStillActive);
    emit!(RulebookClosed { rulebook: rb.key(), owner: rb.owner });
    Ok(())
}
