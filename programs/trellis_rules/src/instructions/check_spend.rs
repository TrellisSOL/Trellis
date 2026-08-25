use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::RulesError,
    events::{CommitmentRecorded, SpendRecorded},
    state::{Rulebook, RulesConfig},
};

/// Accounts for `check_spend`.
///
/// CPI account list (in order):
/// 1. `rulebook` — the `Rulebook` PDA `["rulebook", owner, rulebook_id.to_le_bytes()]`,
///    read-only, not a signer.
///
/// No signer, payer or program account is required. From another Anchor program with the
/// `cpi` feature enabled:
///
/// ```ignore
/// trellis_rules::cpi::check_spend(
///     CpiContext::new(
///         rules_program.key(),
///         trellis_rules::cpi::accounts::CheckSpend { rulebook: rulebook.to_account_info() },
///     ),
///     amount,
///     day,
/// )?;
/// ```
#[derive(Accounts)]
pub struct CheckSpend<'info> {
    pub rulebook: Account<'info, Rulebook>,
}

/// Shared validation used by `check_spend` (view) and `record_spend` (mutating).
/// Returns the projected spend for `day` after adding `amount`.
pub fn evaluate(rb: &Rulebook, amount: u64, day: i64, now: i64) -> Result<u64> {
    require!(!rb.killed, RulesError::RulebookKilled);
    require!(now <= rb.expiry, RulesError::RulebookExpired);
    require!(amount > 0, RulesError::ZeroAmount);
    require!(amount <= rb.per_call_max, RulesError::PerCallMaxExceeded);
    let today = now.div_euclid(SECONDS_PER_DAY);
    // Accept today and yesterday so a tab closed just after midnight UTC can still be
    // accounted to the day the usage happened.
    require!(day == today || day == today - 1, RulesError::InvalidDay);
    let projected = rb.spent_on(day).checked_add(amount).ok_or(RulesError::Overflow)?;
    require!(projected <= rb.daily_max, RulesError::DailyMaxExceeded);
    Ok(projected)
}

/// View-like: reverts when `amount` on `day` would violate the rulebook (killed, expired,
/// over `per_call_max`, or over `daily_max` given the spend recorded so far). No state change.
pub fn handle_check_spend(ctx: Context<CheckSpend>, amount: u64, day: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    evaluate(&ctx.accounts.rulebook, amount, day, now)?;
    Ok(())
}

/// Accounts for `record_spend`.
///
/// CPI account list (in order):
/// 1. `enforcer` — signer; either the rulebook owner or `config.enforcer`
///    (the trellis_tab PDA signer in production).
/// 2. `config` — `RulesConfig` PDA `["config"]`, read-only.
/// 3. `rulebook` — the `Rulebook` PDA, writable.
#[derive(Accounts)]
pub struct RecordSpend<'info> {
    pub enforcer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RulesConfig>,
    #[account(
        mut,
        seeds = [RULEBOOK_SEED, rulebook.owner.as_ref(), rulebook.rulebook_id.to_le_bytes().as_ref()],
        bump = rulebook.bump,
        constraint = enforcer.key() == rulebook.owner || enforcer.key() == config.enforcer
            @ RulesError::Unauthorized,
    )]
    pub rulebook: Account<'info, Rulebook>,
}

/// Mutating counterpart of `check_spend`: same checks, then adds `amount` to the day's counter.
pub fn handle_record_spend(ctx: Context<RecordSpend>, amount: u64, day: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rb = &mut ctx.accounts.rulebook;
    let projected = evaluate(rb, amount, day, now)?;
    // The counter only moves forward: recording for yesterday after today would overwrite (reset) today's total.
    require!(day >= rb.spent_day, RulesError::DayRegression);
    rb.spent_day = day;
    rb.spent_today = projected;
    emit!(SpendRecorded {
        rulebook: rb.key(),
        day,
        amount,
        spent_today: projected,
        by: ctx.accounts.enforcer.key(),
    });
    Ok(())
}

/// Records `amount` newly committed (escrowed into a tab) against today's counter, signed by the configured enforcer
/// (`trellis_tab`'s PDA) or the owner. The checks are the rulebook's standing ones: not killed, not expired, and the
/// day's total within `daily_max`. `per_call_max` does not apply: a commitment is a ceiling for many calls, and each
/// call is checked against `per_call_max` by the payee before it is vouched.
pub fn handle_record_commitment(ctx: Context<RecordSpend>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rb = &mut ctx.accounts.rulebook;
    require!(!rb.killed, RulesError::RulebookKilled);
    require!(now <= rb.expiry, RulesError::RulebookExpired);
    require!(amount > 0, RulesError::ZeroAmount);
    let day = now.div_euclid(SECONDS_PER_DAY);
    require!(day >= rb.spent_day, RulesError::DayRegression);
    let projected = rb.spent_on(day).checked_add(amount).ok_or(RulesError::Overflow)?;
    require!(projected <= rb.daily_max, RulesError::DailyMaxExceeded);
    rb.spent_day = day;
    rb.spent_today = projected;
    emit!(CommitmentRecorded {
        rulebook: rb.key(),
        day,
        amount,
        spent_today: projected,
        by: ctx.accounts.enforcer.key(),
    });
    Ok(())
}
