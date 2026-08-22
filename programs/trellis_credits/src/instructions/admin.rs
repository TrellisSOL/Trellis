use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    errors::CreditsError,
    events::{
        AuthorityTransferred, ConfigProposalApplied, ConfigProposalCancelled, ConfigProposed, ConfigUpdated,
        DepositsPausedSet, OutflowCapSet, SettleRateSet, SettlementsPausedSet, SpentTotalWrittenDown,
    },
    state::{BuildProfile, CreditsConfig, PendingConfig, SettleLimiter, UpdateConfigParams},
};

// Configuration changes come in two kinds.
//
// Tightening (immediate, `update_config`): a lower per-key cap, a longer credit lifetime, a longer refund delay, a
// longer expiry grace, a lower settlement rate. None of these can move anyone's funds sooner or further.
//
// Everything else is loosening and goes through `propose_config` -> wait `CONFIG_TIMELOCK` (24h) ->
// `resolve_config(apply = true)`: handing over the authority (the new authority must co-sign the apply), replacing the
// settlement authority, the guardian or the treasury account, raising the per-key cap, shortening any delay, raising
// the settlement rate, writing `spent_total` down. The pending change sits in a public account for the whole delay
// and the AUTHORITY can cancel it (`resolve_config(apply = false)`). The guardian cannot: a guardian that could cancel
// could veto its own replacement and every hand-over of the authority (security re-review RR-02). A proposal that was
// not applied within `PROPOSAL_TTL` of becoming effective can no longer be applied, and anyone may then clear it
// (RR-09). Whatever the path, a value outside the program's floors and bounds is rejected.

/// Bounds every value must satisfy, whoever sets it and however.
pub fn validate_params(p: &UpdateConfigParams) -> Result<()> {
    if let Some(v) = p.new_authority {
        require!(v != Pubkey::default(), CreditsError::InvalidConfigValue);
    }
    if let Some(v) = p.settlement_authority {
        require!(v != Pubkey::default(), CreditsError::InvalidConfigValue);
    }
    if let Some(v) = p.guardian {
        require!(v != Pubkey::default(), CreditsError::InvalidConfigValue);
    }
    if let Some(v) = p.max_balance_per_key {
        require!(v > 0, CreditsError::InvalidConfigValue);
        // The compiled maximum while unaudited: no key raises the per-key cap above it, by any path.
        require!(v <= MAX_BALANCE_PER_KEY_LIMIT, CreditsError::OutOfBounds);
    }
    if let Some(v) = p.credit_ttl {
        require!((MIN_CREDIT_TTL..=MAX_CREDIT_TTL).contains(&v), CreditsError::OutOfBounds);
    }
    if let Some(v) = p.refund_delay {
        require!((MIN_REFUND_DELAY..=MAX_REFUND_DELAY).contains(&v), CreditsError::OutOfBounds);
    }
    if let Some(v) = p.expiry_grace {
        require!((MIN_EXPIRY_GRACE..=MAX_EXPIRY_GRACE).contains(&v), CreditsError::OutOfBounds);
    }
    if let Some(v) = p.settle_rate_bps {
        require!(v <= MAX_SETTLE_RATE_BPS, CreditsError::OutOfBounds);
    }
    if let Some(v) = p.outflow_cap_per_window {
        // Never below the floor: an absolute cap of zero would be a pause of refunds, and exits are never paused.
        require!(v >= SETTLE_WINDOW_FLOOR, CreditsError::OutOfBounds);
    }
    Ok(())
}

/// Whether `p` only tightens: no role or treasury change, and every number moves in the safe direction.
pub fn is_tightening(config: &CreditsConfig, limiter: &SettleLimiter, p: &UpdateConfigParams, new_treasury: bool) -> bool {
    !new_treasury
        && p.new_authority.is_none()
        && p.settlement_authority.is_none()
        && p.guardian.is_none()
        && p.max_balance_per_key.is_none_or(|v| v <= config.max_balance_per_key)
        && p.credit_ttl.is_none_or(|v| v >= config.credit_ttl)
        && p.refund_delay.is_none_or(|v| v >= config.refund_delay)
        && p.expiry_grace.is_none_or(|v| v >= config.expiry_grace)
        && p.settle_rate_bps.is_none_or(|v| v <= limiter.rate_bps)
        && p.outflow_cap_per_window.is_none_or(|v| v <= limiter.cap_per_window)
        && !p.write_down_spent
}

fn apply_params(
    config: &mut CreditsConfig,
    limiter: &mut SettleLimiter,
    p: &UpdateConfigParams,
    new_treasury: Option<Pubkey>,
) {
    if let Some(v) = p.settlement_authority {
        config.settlement_authority = v;
    }
    if let Some(v) = p.guardian {
        config.guardian = v;
    }
    if let Some(v) = p.max_balance_per_key {
        config.max_balance_per_key = v;
    }
    if let Some(v) = p.credit_ttl {
        config.credit_ttl = v;
    }
    if let Some(v) = p.refund_delay {
        config.refund_delay = v;
    }
    if let Some(v) = p.expiry_grace {
        config.expiry_grace = v;
    }
    if let Some(v) = p.settle_rate_bps {
        limiter.rate_bps = v;
    }
    if let Some(v) = p.outflow_cap_per_window {
        limiter.cap_per_window = v;
    }
    if let Some(t) = new_treasury {
        config.treasury_token_account = t;
    }
}

fn emit_updated(config: &CreditsConfig, limiter: &SettleLimiter) {
    emit!(ConfigUpdated {
        settlement_authority: config.settlement_authority,
        guardian: config.guardian,
        treasury_token_account: config.treasury_token_account,
        max_balance_per_key: config.max_balance_per_key,
        credit_ttl: config.credit_ttl,
        refund_delay: config.refund_delay,
        expiry_grace: config.expiry_grace,
    });
    emit!(SettleRateSet { rate_bps: limiter.rate_bps });
    emit!(OutflowCapSet { cap_per_window: limiter.cap_per_window });
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
}

/// Immediate, tightening-only. Anything that loosens is refused with `RequiresTimelock`.
pub fn handle_update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
    validate_params(&params)?;
    require!(
        is_tightening(&ctx.accounts.config, &ctx.accounts.limiter, &params, false),
        CreditsError::RequiresTimelock
    );
    apply_params(&mut ctx.accounts.config, &mut ctx.accounts.limiter, &params, None);
    emit_updated(&ctx.accounts.config, &ctx.accounts.limiter);
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    /// One pending change at a time: a second proposal fails at `init` until this one is applied or cancelled.
    #[account(
        init,
        payer = authority,
        space = 8 + PendingConfig::INIT_SPACE,
        seeds = [PENDING_CONFIG_SEED],
        bump
    )]
    pub pending_config: Account<'info, PendingConfig>,
    /// Optional new treasury token account; must hold the configured USDC mint.
    #[account(constraint = new_treasury.mint == config.usdc_mint @ CreditsError::MintMismatch)]
    pub new_treasury: Option<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

/// Records a config change that takes effect no sooner than `CONFIG_TIMELOCK` from now.
pub fn handle_propose_config(ctx: Context<ProposeConfig>, params: UpdateConfigParams) -> Result<()> {
    validate_params(&params)?;
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_config;
    pending.params = params;
    pending.new_treasury = ctx.accounts.new_treasury.as_ref().map(|t| t.key());
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(CreditsError::Overflow)?;
    pending.bump = ctx.bumps.pending_config;
    emit!(ConfigProposed {
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
        changes_authority: pending.params.new_authority.is_some(),
        changes_guardian: pending.params.guardian.is_some(),
        changes_settlement_authority: pending.params.settlement_authority.is_some(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveConfig<'info> {
    /// Applying or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ CreditsError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_CONFIG_SEED], bump = pending_config.bump)]
    pub pending_config: Account<'info, PendingConfig>,
    /// Required only when the pending change hands the authority over: the new authority must sign to take it.
    pub new_authority: Option<Signer<'info>>,
}

/// `apply = true`: the authority installs the pending change once `CONFIG_TIMELOCK` has elapsed and before it
/// expires. A change of authority also needs the new authority's signature, so a mistyped address cannot strand the
/// program. `apply = false`: the authority drops the pending change; once it has expired anyone may.
pub fn handle_resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let pending = &ctx.accounts.pending_config;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !apply {
        require!(signer == config.authority || expired, CreditsError::Unauthorized);
        emit!(ConfigProposalCancelled { by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, CreditsError::Unauthorized);
    require!(now >= pending.effective_at, CreditsError::TimelockNotElapsed);
    require!(!expired, CreditsError::ProposalExpired);
    validate_params(&pending.params)?;
    let params = pending.params.clone();
    let new_treasury = pending.new_treasury;
    apply_params(config, &mut ctx.accounts.limiter, &params, new_treasury);
    if params.write_down_spent && config.spent_total > config.settled_total {
        // Committed spend that was never paid out is forgotten; `settled_total <= spent_total` still holds, and the
        // next honest `commit_spent_root` starts again from what has really been settled.
        let from = config.spent_total;
        config.spent_total = config.settled_total;
        emit!(SpentTotalWrittenDown { from, to: config.spent_total });
    }
    if let Some(new_authority) = params.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), CreditsError::Unauthorized);
        let old = config.authority;
        config.authority = new_authority;
        emit!(AuthorityTransferred { old_authority: old, new_authority });
    }
    emit!(ConfigProposalApplied { by: signer });
    emit_updated(config, &ctx.accounts.limiter);
    Ok(())
}

// ---- Pauses -------------------------------------------------------------------------------------------------------
//
// What a pause can stop: new deposits (`set_deposits_paused`) and the settlement key's outflows
// (`set_settlements_paused`: `commit_spent_root`, `settle_to_host`, `sweep_expired`). What no pause can stop: a key
// closing its account, a closure being cancelled, a depositor moving its refund destination, and `pay_refund`.
//
// The guardian can pause and do nothing else (security re-review RR-02). Every pause lapses `PAUSE_TTL` (72h) after it
// was last set. The authority can set it again as often as it likes, and only the authority can lift it early. After a
// guardian pause the guardian must wait `GUARDIAN_PAUSE_COOLDOWN` (7 days, counted from the moment its pause was due
// to lapse) before it can pause again, so a stolen guardian key buys one pause of at most 72h, and replacing that
// guardian (24h timelock, which the guardian can no longer cancel) fits well inside the cooldown.

/// The new `(paused, paused_until, guardian_ready_at)` for a pause request, or the reason it is refused.
pub fn next_pause(
    by_authority: bool,
    paused: bool,
    now: i64,
    guardian_ready_at: i64,
) -> Result<(bool, i64, i64)> {
    if !paused {
        require!(by_authority, CreditsError::Unauthorized);
        return Ok((false, 0, guardian_ready_at));
    }
    let until = now.checked_add(PAUSE_TTL).ok_or(CreditsError::Overflow)?;
    if by_authority {
        return Ok((true, until, guardian_ready_at));
    }
    require!(now >= guardian_ready_at, CreditsError::GuardianCooldown);
    let ready = until.checked_add(GUARDIAN_PAUSE_COOLDOWN).ok_or(CreditsError::Overflow)?;
    Ok((true, until, ready))
}

#[derive(Accounts)]
pub struct SetDepositsPaused<'info> {
    /// Either the guardian or the authority.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = signer.key() == config.guardian || signer.key() == config.authority
            @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
}

/// The guardian or the authority pauses new deposits for `PAUSE_TTL`; only the authority resumes them early.
pub fn handle_set_deposits_paused(ctx: Context<SetDepositsPaused>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let (flag, until, ready) =
        next_pause(signer == config.authority, paused, now, config.deposits_guardian_ready_at)?;
    config.deposits_paused = flag;
    config.deposits_paused_until = until;
    config.deposits_guardian_ready_at = ready;
    emit!(DepositsPausedSet { paused: flag, by: signer, paused_until: until });
    Ok(())
}

#[derive(Accounts)]
pub struct SetSettlementsPaused<'info> {
    /// The guardian or the authority may pause; only the authority may unpause.
    pub signer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = signer.key() == config.guardian || signer.key() == config.authority
            @ CreditsError::Unauthorized,
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(mut, seeds = [LIMITER_SEED], bump = limiter.bump)]
    pub limiter: Account<'info, SettleLimiter>,
}

/// Stops `commit_spent_root`, `settle_to_host` and `sweep_expired` (what a stolen settlement key would use) for
/// `PAUSE_TTL`. Deposits, closures and closure refunds are not affected.
pub fn handle_set_settlements_paused(ctx: Context<SetSettlementsPaused>, paused: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let limiter = &mut ctx.accounts.limiter;
    let (flag, until, ready) = next_pause(
        signer == ctx.accounts.config.authority,
        paused,
        now,
        limiter.guardian_pause_ready_at,
    )?;
    limiter.paused = flag;
    limiter.paused_until = until;
    limiter.guardian_pause_ready_at = ready;
    emit!(SettlementsPausedSet { paused: flag, by: signer, paused_until: until });
    Ok(())
}

// ---- Limiter ------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitLimiter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    #[account(
        init,
        payer = payer,
        space = 8 + SettleLimiter::INIT_SPACE,
        seeds = [LIMITER_SEED],
        bump
    )]
    pub limiter: Account<'info, SettleLimiter>,
    pub system_program: Program<'info, System>,
}

/// Creates the limiter with the default rate for a config that was initialised before this limiter existed. Anyone
/// may pay for it: the values are fixed by the program, and `settle_to_host` cannot run without it.
pub fn handle_init_limiter(ctx: Context<InitLimiter>) -> Result<()> {
    init_limiter_fields(&mut ctx.accounts.limiter, ctx.bumps.limiter);
    Ok(())
}

pub fn init_limiter_fields(limiter: &mut SettleLimiter, bump: u8) {
    limiter.rate_bps = DEFAULT_SETTLE_RATE_BPS;
    limiter.settle_allowance = 0;
    limiter.settle_refilled_at = 0;
    limiter.base_cur = 0;
    limiter.refund_allowance = 0;
    limiter.refund_refilled_at = 0;
    limiter.base_prev = 0;
    limiter.paused = false;
    limiter.paused_until = 0;
    limiter.guardian_pause_ready_at = 0;
    limiter.bump = bump;
    // A new limiter knows no balance history: its base is 0 (the floor applies) until the vault has been recorded in
    // two epochs, the same wait a deposit has before it counts.
    limiter.base_epoch = 0;
    limiter.last_vault = 0;
    limiter.cap_per_window = DEFAULT_OUTFLOW_CAP_PER_WINDOW;
}

#[derive(Accounts)]
pub struct MigrateLimiter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the limiter PDA in its earlier, shorter layout; `handle_migrate_limiter` checks owner, type and length.
    #[account(mut, seeds = [LIMITER_SEED], bump)]
    pub limiter: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a limiter created before the base tracker and the absolute cap existed (security review round 3, R3-07) to the
/// current layout. The rate, both allowances and the pause are kept; the base starts from zero history (so only the
/// floor applies until the vault has been recorded in two epochs) and the absolute cap starts at the default. Anyone
/// may pay: nothing is chosen by the caller, and it works exactly once.
pub fn handle_migrate_limiter(ctx: Context<MigrateLimiter>) -> Result<()> {
    let info = ctx.accounts.limiter.to_account_info();
    grow_account(
        &info,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        SettleLimiter::DISCRIMINATOR,
        SettleLimiter::LEGACY_LEN,
        8 + SettleLimiter::INIT_SPACE,
    )?;
    let mut limiter: SettleLimiter = {
        let data = info.try_borrow_data()?;
        SettleLimiter::try_deserialize(&mut &data[..])?
    };
    // The two fields that held "the balance after the last payment" now hold epoch minima; drop the old meaning.
    limiter.base_cur = 0;
    limiter.base_prev = 0;
    limiter.base_epoch = 0;
    limiter.last_vault = 0;
    limiter.cap_per_window = DEFAULT_OUTFLOW_CAP_PER_WINDOW;
    let mut data = info.try_borrow_mut_data()?;
    limiter.try_serialize(&mut &mut data[..])?;
    emit!(OutflowCapSet { cap_per_window: limiter.cap_per_window });
    Ok(())
}

// ---- Migration ----------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the config PDA in its earlier, shorter layout; `handle_migrate_config` checks owner, type and length.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a config created before the pause expiry fields existed to the current layout. The two appended fields start
/// at zero, which reads as "no pause in force, guardian free to pause". Anyone may pay: nothing is chosen by the
/// caller, and it works exactly once.
pub fn handle_migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
    grow_account(
        &ctx.accounts.config.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        CreditsConfig::DISCRIMINATOR,
        CreditsConfig::LEGACY_LEN,
        8 + CreditsConfig::INIT_SPACE,
    )
}

/// Extends a program-owned account of a known type and exact earlier length to `new_len`; the added bytes are zero.
pub fn grow_account<'info>(
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    discriminator: &[u8],
    old_len: usize,
    new_len: usize,
) -> Result<()> {
    require_keys_eq!(*account.owner, crate::ID, CreditsError::NotMigratable);
    require!(account.data_len() != new_len, CreditsError::AlreadyMigrated);
    require!(account.data_len() == old_len, CreditsError::NotMigratable);
    require!(account.try_borrow_data()?[..8] == *discriminator, CreditsError::NotMigratable);
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(account.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.key(),
                anchor_lang::system_program::Transfer { from: payer.clone(), to: account.clone() },
            ),
            need,
        )?;
    }
    account.resize(new_len)?;
    Ok(())
}

// ---- Build profile ------------------------------------------------------------------------------------------------

/// `build_profile` takes no account: it only reports constants.
#[derive(Accounts)]
pub struct ReadBuildProfile {}

/// The floors this binary was compiled with, as return data. Read-only and free to simulate: it is how a deployed
/// program is told apart from a `devnet`-feature build, whose IDL and account layouts are identical.
pub fn handle_build_profile(_ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
    Ok(BuildProfile {
        profile: BUILD_PROFILE,
        min_refund_delay: MIN_REFUND_DELAY,
        min_expiry_grace: MIN_EXPIRY_GRACE,
        min_credit_ttl: MIN_CREDIT_TTL,
        config_timelock: CONFIG_TIMELOCK,
        settle_window: SETTLE_WINDOW,
        pause_ttl: PAUSE_TTL,
        guardian_pause_cooldown: GUARDIAN_PAUSE_COOLDOWN,
        proposal_ttl: PROPOSAL_TTL,
    })
}
