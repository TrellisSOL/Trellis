use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{errors::TabError, events::*, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigArgs {
    pub guardian: Pubkey,
    /// `trellis_rules` program id.
    pub rules_program: Pubkey,
    pub max_cap: Option<u64>,
    pub reclaim_grace: Option<i64>,
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
        space = 8 + TabConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, TabConfig>,
    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Bounds every value must satisfy, whoever sets it and however.
pub fn validate_args(a: &UpdateConfigArgs) -> Result<()> {
    if let Some(v) = a.new_authority {
        require!(v != Pubkey::default(), TabError::InvalidConfigValue);
    }
    if let Some(v) = a.guardian {
        require!(v != Pubkey::default(), TabError::InvalidConfigValue);
    }
    if let Some(v) = a.rules_program {
        require!(v != Pubkey::default(), TabError::InvalidConfigValue);
    }
    if let Some(v) = a.reclaim_grace {
        require!((MIN_RECLAIM_GRACE..=MAX_RECLAIM_GRACE).contains(&v), TabError::OutOfBounds);
    }
    if let Some(v) = a.max_cap {
        // The compiled maximum while unaudited: whoever sets the cap, and however (init, at once, the timelock).
        require!(v <= MAX_CAP_LIMIT, TabError::OutOfBounds);
    }
    Ok(())
}

fn apply_args(config: &mut TabConfig, a: &UpdateConfigArgs) {
    if let Some(v) = a.guardian {
        config.guardian = v;
    }
    if let Some(v) = a.rules_program {
        config.rules_program = v;
    }
    if let Some(v) = a.max_cap {
        config.max_cap = v;
    }
    if let Some(v) = a.reclaim_grace {
        config.reclaim_grace = v;
    }
}

fn emit_updated(config: &TabConfig) {
    emit!(TabConfigUpdated {
        authority: config.authority,
        guardian: config.guardian,
        rules_program: config.rules_program,
        max_cap: config.max_cap,
    });
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.authority.key())?;
    validate_args(&UpdateConfigArgs {
        new_authority: None,
        guardian: Some(args.guardian),
        rules_program: Some(args.rules_program),
        max_cap: args.max_cap,
        reclaim_grace: args.reclaim_grace,
    })?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.guardian = args.guardian;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.rules_program = args.rules_program;
    config.max_cap = args.max_cap.unwrap_or(DEFAULT_MAX_CAP);
    config.reclaim_grace = args.reclaim_grace.unwrap_or(DEFAULT_RECLAIM_GRACE);
    config.paused = false;
    config.paused_until = 0;
    config.guardian_pause_ready_at = 0;
    config.bump = ctx.bumps.config;
    emit_updated(config);
    Ok(())
}

// Configuration changes come in two kinds. Lowering `max_cap` only tightens and is immediate (`update_config`); no
// path raises it above `MAX_CAP_LIMIT` (500 USDC, `validate_args`).
// Everything else (the guardian, the rules program, a higher cap, any change of the reclaim grace) goes through
// `propose_config` -> wait `CONFIG_TIMELOCK` (24h) -> `resolve_config(apply = true)`, and the authority can cancel it (the guardian cannot).

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ TabError::Unauthorized,
    )]
    pub config: Account<'info, TabConfig>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_args(&args)?;
    let config = &mut ctx.accounts.config;
    let tightening = args.new_authority.is_none()
        && args.guardian.is_none()
        && args.rules_program.is_none()
        && args.reclaim_grace.is_none()
        && args.max_cap.is_none_or(|v| v <= config.max_cap);
    require!(tightening, TabError::RequiresTimelock);
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
        has_one = authority @ TabError::Unauthorized,
    )]
    pub config: Account<'info, TabConfig>,
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
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(TabError::Overflow)?;
    pending.bump = ctx.bumps.pending_config;
    emit!(TabConfigProposed {
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
    pub config: Account<'info, TabConfig>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ TabError::Unauthorized)]
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
        require!(signer == config.authority || expired, TabError::Unauthorized);
        emit!(TabConfigProposalResolved { applied: false, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, TabError::Unauthorized);
    require!(now >= pending.effective_at, TabError::TimelockNotElapsed);
    require!(!expired, TabError::ProposalExpired);
    validate_args(&pending.args)?;
    let args = pending.args.clone();
    apply_args(config, &args);
    if let Some(new_authority) = args.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), TabError::Unauthorized);
        config.authority = new_authority;
    }
    emit!(TabConfigProposalResolved { applied: true, by: signer });
    emit_updated(config);
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TabConfig>,
}

/// The guardian or the authority pauses new tabs for `PAUSE_TTL` (72h). It never moves funds and never stops anyone
/// from taking their own funds out. The pause lapses by itself; the authority may set it again as often as it likes.
/// The guardian, after a pause, must wait `GUARDIAN_PAUSE_COOLDOWN` (7 days from the moment that pause was due to
/// lapse) before it can pause again, so a stolen guardian key buys one pause of at most 72h (security re-review RR-02).
pub fn handle_pause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(
        signer == config.guardian || signer == config.authority,
        TabError::NotGuardian
    );
    let now = Clock::get()?.unix_timestamp;
    let until = now.checked_add(PAUSE_TTL).ok_or(TabError::Overflow)?;
    if signer != config.authority {
        require!(now >= config.guardian_pause_ready_at, TabError::GuardianCooldown);
        config.guardian_pause_ready_at = until.checked_add(GUARDIAN_PAUSE_COOLDOWN).ok_or(TabError::Overflow)?;
    }
    config.paused = true;
    config.paused_until = until;
    emit!(TabPauseChanged { paused: true, by: signer, paused_until: until });
    Ok(())
}

/// Only the authority may unpause before the pause lapses (the guardian can only tighten).
pub fn handle_unpause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(signer == config.authority, TabError::Unauthorized);
    config.paused = false;
    config.paused_until = 0;
    emit!(TabPauseChanged { paused: false, by: signer, paused_until: 0 });
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
        TabConfig::DISCRIMINATOR,
        TabConfig::LEGACY_LEN,
        8 + TabConfig::INIT_SPACE,
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
    require_keys_eq!(*account.owner, crate::ID, TabError::NotMigratable);
    require!(account.data_len() != new_len, TabError::AlreadyMigrated);
    require!(account.data_len() == old_len, TabError::NotMigratable);
    require!(account.try_borrow_data()?[..8] == *discriminator, TabError::NotMigratable);
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
        min_reclaim_grace: MIN_RECLAIM_GRACE,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, TabError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, TabError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        TabError::NotUpgradeAuthority
    );
    Ok(())
}
