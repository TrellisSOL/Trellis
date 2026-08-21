use anchor_lang::prelude::*;

use crate::{errors::CapacityError, events::*, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigArgs {
    pub sale_authority: Pubkey,
    pub hvx_authority: Pubkey,
    pub guardian: Pubkey,
    /// USDC per Bushel for grades G-S, G-M, G-L.
    pub grade_prices: [u64; GRADE_COUNT],
    pub max_outstanding_value: Option<u64>,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// The initial authority. In production this is a Squads v4 2-of-3 multisig. Must be the program's upgrade
    /// authority, so nobody else can initialise the program between deploy and init.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + CapacityConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, CapacityConfig>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn validate_args(a: &UpdateConfigArgs) -> Result<()> {
    if let Some(v) = a.new_authority {
        require!(v != Pubkey::default(), CapacityError::InvalidConfigValue);
    }
    for key in [a.sale_authority, a.hvx_authority, a.guardian].into_iter().flatten() {
        require!(key != Pubkey::default(), CapacityError::InvalidConfigValue);
    }
    if let Some(v) = a.grade_prices {
        require!(v.iter().all(|p| *p > 0), CapacityError::ZeroPrice);
        require!(v.iter().all(|p| *p <= MAX_GRADE_PRICE), CapacityError::OutOfBounds);
    }
    if let Some(v) = a.max_outstanding_value {
        // The compiled maximum while unaudited: whoever sets the cap, and however (init, at once, the timelock).
        require!(v <= MAX_OUTSTANDING_VALUE_CAP, CapacityError::OutOfBounds);
    }
    Ok(())
}

fn apply_args(config: &mut CapacityConfig, a: &UpdateConfigArgs) {
    if let Some(v) = a.sale_authority {
        config.sale_authority = v;
    }
    if let Some(v) = a.hvx_authority {
        config.hvx_authority = v;
    }
    if let Some(v) = a.guardian {
        config.guardian = v;
    }
    if let Some(v) = a.grade_prices {
        config.grade_prices = v;
    }
    if let Some(v) = a.max_outstanding_value {
        config.max_outstanding_value = v;
    }
}

fn emit_updated(config: &CapacityConfig) {
    emit!(CapacityConfigUpdated {
        authority: config.authority,
        sale_authority: config.sale_authority,
        hvx_authority: config.hvx_authority,
        guardian: config.guardian,
        grade_prices: config.grade_prices,
        max_outstanding_value: config.max_outstanding_value,
    });
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.authority.key())?;
    validate_args(&UpdateConfigArgs {
        new_authority: None,
        sale_authority: Some(args.sale_authority),
        hvx_authority: Some(args.hvx_authority),
        guardian: Some(args.guardian),
        grade_prices: Some(args.grade_prices),
        max_outstanding_value: args.max_outstanding_value,
    })?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.sale_authority = args.sale_authority;
    config.hvx_authority = args.hvx_authority;
    config.guardian = args.guardian;
    config.grade_prices = args.grade_prices;
    config.max_outstanding_value = args
        .max_outstanding_value
        .unwrap_or(DEFAULT_MAX_OUTSTANDING_VALUE);
    config.outstanding_value = 0;
    config.paused = false;
    config.paused_until = 0;
    config.guardian_pause_ready_at = 0;
    config.bump = ctx.bumps.config;
    emit_updated(config);
    Ok(())
}

// Lowering the global issuance cap only tightens and is immediate (`update_config`). Everything else (the sale, HVX
// and guardian keys, the grade prices new commitments are valued at, a higher issuance cap) goes through
// `propose_config` -> wait `CONFIG_TIMELOCK` (24h) -> `resolve_config(apply = true)`; the authority can cancel it (the guardian cannot).
// Whatever the path, a grade price stays at or below `MAX_GRADE_PRICE` and the issuance cap at or below
// `MAX_OUTSTANDING_VALUE_CAP` (`validate_args`).

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CapacityError::Unauthorized,
    )]
    pub config: Account<'info, CapacityConfig>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_args(&args)?;
    let config = &mut ctx.accounts.config;
    let tightening = args.new_authority.is_none()
        && args.sale_authority.is_none()
        && args.hvx_authority.is_none()
        && args.guardian.is_none()
        && args.grade_prices.is_none()
        && args.max_outstanding_value.is_none_or(|v| v <= config.max_outstanding_value);
    require!(tightening, CapacityError::RequiresTimelock);
    apply_args(config, &args);
    emit_updated(config);
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CapacityError::Unauthorized,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingConfig::INIT_SPACE,
        seeds = [PENDING_CONFIG_SEED],
        bump
    )]
    pub pending_config: Account<'info, PendingConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_config(ctx: Context<ProposeConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_args(&args)?;
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_config;
    pending.args = args;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(CapacityError::Overflow)?;
    pending.bump = ctx.bumps.pending_config;
    emit!(CapacityConfigProposed {
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
        changes_authority: pending.args.new_authority.is_some(),
        changes_guardian: pending.args.guardian.is_some(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveConfig<'info> {
    /// Applying or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CapacityConfig>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ CapacityError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_CONFIG_SEED], bump = pending_config.bump)]
    pub pending_config: Account<'info, PendingConfig>,
    /// Required only when the pending change hands the authority over: the new authority must sign to take it.
    pub new_authority: Option<Signer<'info>>,
}

/// `apply = true`: the authority installs the pending change once `CONFIG_TIMELOCK` has elapsed and before it expires
/// (`PROPOSAL_TTL` later). A change of authority also needs the new authority's signature, so a mistyped address cannot
/// strand the program. `apply = false`: the authority drops the pending change; once it has expired anyone may. The
/// guardian cannot cancel: a guardian that could would be able to veto its own replacement and every hand-over of the
/// authority (security re-review RR-02).
pub fn handle_resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let pending = &ctx.accounts.pending_config;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !apply {
        require!(signer == config.authority || expired, CapacityError::Unauthorized);
        emit!(CapacityConfigProposalResolved { applied: false, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, CapacityError::Unauthorized);
    require!(now >= pending.effective_at, CapacityError::TimelockNotElapsed);
    require!(!expired, CapacityError::ProposalExpired);
    validate_args(&pending.args)?;
    let args = pending.args.clone();
    apply_args(config, &args);
    if let Some(new_authority) = args.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), CapacityError::Unauthorized);
        config.authority = new_authority;
    }
    emit!(CapacityConfigProposalResolved { applied: true, by: signer });
    emit_updated(config);
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CapacityConfig>,
}

/// The guardian or the authority pauses new commitments and sales for `PAUSE_TTL` (72h). It never moves funds and never stops anyone
/// from taking their own funds out. The pause lapses by itself; the authority may set it again as often as it likes.
/// The guardian, after a pause, must wait `GUARDIAN_PAUSE_COOLDOWN` (7 days from the moment that pause was due to
/// lapse) before it can pause again, so a stolen guardian key buys one pause of at most 72h (security re-review RR-02).
pub fn handle_pause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(
        signer == config.guardian || signer == config.authority,
        CapacityError::NotGuardian
    );
    let now = Clock::get()?.unix_timestamp;
    let until = now.checked_add(PAUSE_TTL).ok_or(CapacityError::Overflow)?;
    if signer != config.authority {
        require!(now >= config.guardian_pause_ready_at, CapacityError::GuardianCooldown);
        config.guardian_pause_ready_at = until.checked_add(GUARDIAN_PAUSE_COOLDOWN).ok_or(CapacityError::Overflow)?;
    }
    config.paused = true;
    config.paused_until = until;
    emit!(CapacityPauseChanged { paused: true, by: signer, paused_until: until });
    Ok(())
}

/// Only the authority may unpause before the pause lapses (the guardian can only tighten).
pub fn handle_unpause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(signer == config.authority, CapacityError::Unauthorized);
    config.paused = false;
    config.paused_until = 0;
    emit!(CapacityPauseChanged { paused: false, by: signer, paused_until: 0 });
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the config PDA in its earlier, shorter layout; `grow_account` checks owner, type and length.
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
        CapacityConfig::DISCRIMINATOR,
        CapacityConfig::LEGACY_LEN,
        8 + CapacityConfig::INIT_SPACE,
    )
}

#[derive(Accounts)]
pub struct MigrateCommitment<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a `CapacityCommitment` in its earlier, shorter layout; `grow_account` checks owner, type and length.
    #[account(mut)]
    pub commitment: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a commitment created before `price_per_bushel`, `paid_total` and `claimed_value` existed to the current
/// layout. The three fields start at zero: no price is fixed on it, so nothing more can be sold against it, and
/// whatever is claimed for its existing lots is counted from zero and stays within its value. Anyone may pay; it works
/// once per commitment.
pub fn handle_migrate_commitment(ctx: Context<MigrateCommitment>) -> Result<()> {
    grow_account(
        &ctx.accounts.commitment.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        CapacityCommitment::DISCRIMINATOR,
        CapacityCommitment::LEGACY_LEN,
        8 + CapacityCommitment::INIT_SPACE,
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
    require_keys_eq!(*account.owner, crate::ID, CapacityError::NotMigratable);
    require!(account.data_len() != new_len, CapacityError::AlreadyMigrated);
    require!(account.data_len() == old_len, CapacityError::NotMigratable);
    require!(account.try_borrow_data()?[..8] == *discriminator, CapacityError::NotMigratable);
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

/// `build_profile` takes no account: it only reports constants.
#[derive(Accounts)]
pub struct ReadBuildProfile {}

/// The floors this binary was compiled with, as return data. Read-only and free to simulate: it is how a deployed
/// program is told apart from a `devnet`-feature build, whose IDL and account layouts are identical.
pub fn handle_build_profile(_ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
    Ok(BuildProfile {
        profile: BUILD_PROFILE,
        config_timelock: CONFIG_TIMELOCK,
        pause_ttl: PAUSE_TTL,
        guardian_pause_cooldown: GUARDIAN_PAUSE_COOLDOWN,
        proposal_ttl: PROPOSAL_TTL,
        claim_period: CLAIM_PERIOD,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, CapacityError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, CapacityError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        CapacityError::NotUpgradeAuthority
    );
    Ok(())
}
