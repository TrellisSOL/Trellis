use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::RulesError,
    events::{
        AuthorityTransferred, ConfigInitialized, ConfigProposalResolved, ConfigProposed, ConfigUpdated,
        NewRulebooksPausedSet,
    },
    state::{BuildProfile, PendingConfig, RulesConfig},
};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Admin key (Squads 2-of-3 in production). Must be the program's upgrade authority.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + RulesConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RulesConfig>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_config(ctx: Context<InitConfig>, guardian: Pubkey, enforcer: Pubkey) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.authority.key())?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.guardian = guardian;
    config.enforcer = enforcer;
    config.new_rulebooks_paused = false;
    config.paused_until = 0;
    config.guardian_pause_ready_at = 0;
    config.bump = ctx.bumps.config;
    emit!(ConfigInitialized { authority: config.authority, guardian, enforcer });
    Ok(())
}

// The authority, the guardian and the enforcer are roles: replacing any of them is never immediate. `propose_config`
// records the change, `resolve_config(apply = true)` installs it after `CONFIG_TIMELOCK` (24h) (a new authority must
// co-sign) and before it expires (`PROPOSAL_TTL` later), and the AUTHORITY can cancel it meanwhile
// (`resolve_config(apply = false)`). The guardian cannot: a guardian that could cancel could veto its own replacement
// and every hand-over of the authority (security re-review RR-02). Anyone may clear a proposal that has expired.

#[derive(Accounts)]
pub struct ProposeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ RulesError::Unauthorized,
    )]
    pub config: Account<'info, RulesConfig>,
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

pub fn handle_propose_config(
    ctx: Context<ProposeConfig>,
    new_authority: Option<Pubkey>,
    guardian: Option<Pubkey>,
    enforcer: Option<Pubkey>,
) -> Result<()> {
    require!(new_authority != Some(Pubkey::default()), RulesError::InvalidParams);
    require!(guardian != Some(Pubkey::default()), RulesError::InvalidParams);
    require!(enforcer != Some(Pubkey::default()), RulesError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_config;
    pending.new_authority = new_authority;
    pending.guardian = guardian;
    pending.enforcer = enforcer;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(RulesError::Overflow)?;
    pending.bump = ctx.bumps.pending_config;
    emit!(ConfigProposed {
        new_authority,
        guardian,
        enforcer,
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveConfig<'info> {
    /// Applying or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RulesConfig>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ RulesError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_CONFIG_SEED], bump = pending_config.bump)]
    pub pending_config: Account<'info, PendingConfig>,
    /// Required only when the pending change hands the authority over: the new authority must sign to take it.
    pub new_authority: Option<Signer<'info>>,
}

/// `apply = true`: the authority installs the pending change once `CONFIG_TIMELOCK` has elapsed. A change of authority
/// also needs the new authority's signature, so a mistyped address cannot strand the program.
/// `apply = false`: the authority drops the pending change; once it has expired anyone may. Never the guardian.
pub fn handle_resolve_config(ctx: Context<ResolveConfig>, apply: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let pending = &ctx.accounts.pending_config;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !apply {
        require!(signer == config.authority || expired, RulesError::Unauthorized);
        emit!(ConfigProposalResolved { applied: false, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, RulesError::Unauthorized);
    require!(now >= pending.effective_at, RulesError::TimelockNotElapsed);
    require!(!expired, RulesError::ProposalExpired);
    if let Some(g) = pending.guardian {
        config.guardian = g;
    }
    if let Some(e) = pending.enforcer {
        config.enforcer = e;
    }
    if let Some(new_authority) = pending.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), RulesError::Unauthorized);
        let old = config.authority;
        config.authority = new_authority;
        emit!(AuthorityTransferred { old_authority: old, new_authority });
    }
    emit!(ConfigProposalResolved { applied: true, by: signer });
    emit!(ConfigUpdated { guardian: config.guardian, enforcer: config.enforcer });
    Ok(())
}

#[derive(Accounts)]
pub struct SetNewRulebooksPaused<'info> {
    /// Either the guardian or the authority.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = signer.key() == config.guardian || signer.key() == config.authority
            @ RulesError::Unauthorized,
    )]
    pub config: Account<'info, RulesConfig>,
}

/// The guardian or the authority pauses the creation of new rulebooks for `PAUSE_TTL` (72h); only the authority lifts
/// the pause early. Existing rulebooks keep working: updating, killing and closing one, and every spend check, are
/// never paused. After a guardian pause the guardian must wait `GUARDIAN_PAUSE_COOLDOWN` before pausing again, so a
/// stolen guardian key buys one pause of at most 72h (security re-review RR-02).
pub fn handle_set_new_rulebooks_paused(ctx: Context<SetNewRulebooksPaused>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    let by_authority = signer == config.authority;
    if !paused {
        require!(by_authority, RulesError::Unauthorized);
        config.new_rulebooks_paused = false;
        config.paused_until = 0;
        emit!(NewRulebooksPausedSet { paused: false, by: signer, paused_until: 0 });
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;
    let until = now.checked_add(PAUSE_TTL).ok_or(RulesError::Overflow)?;
    if !by_authority {
        require!(now >= config.guardian_pause_ready_at, RulesError::GuardianCooldown);
        config.guardian_pause_ready_at = until.checked_add(GUARDIAN_PAUSE_COOLDOWN).ok_or(RulesError::Overflow)?;
    }
    config.new_rulebooks_paused = true;
    config.paused_until = until;
    emit!(NewRulebooksPausedSet { paused: true, by: signer, paused_until: until });
    Ok(())
}

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
    let account = ctx.accounts.config.to_account_info();
    let new_len = 8 + RulesConfig::INIT_SPACE;
    require_keys_eq!(*account.owner, crate::ID, RulesError::NotMigratable);
    require!(account.data_len() != new_len, RulesError::AlreadyMigrated);
    require!(account.data_len() == RulesConfig::LEGACY_LEN, RulesError::NotMigratable);
    require!(account.try_borrow_data()?[..8] == *RulesConfig::DISCRIMINATOR, RulesError::NotMigratable);
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(account.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: account.clone(),
                },
            ),
            need,
        )?;
    }
    account.resize(new_len)?;
    Ok(())
}

/// `build_profile` only reports constants. The clock sysvar is not read: this program is also built as a CPI client
/// for other Trellis programs, and Anchor's CPI client needs an accounts struct to hold at least one account.
#[derive(Accounts)]
pub struct ReadBuildProfile<'info> {
    pub clock: Sysvar<'info, Clock>,
}

/// The floors this binary was compiled with, as return data. Read-only and free to simulate: it is how a deployed
/// program is told apart from a `devnet`-feature build, whose IDL and account layouts are identical.
pub fn handle_build_profile(_ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
    Ok(BuildProfile {
        profile: BUILD_PROFILE,
        config_timelock: CONFIG_TIMELOCK,
        pause_ttl: PAUSE_TTL,
        guardian_pause_cooldown: GUARDIAN_PAUSE_COOLDOWN,
        proposal_ttl: PROPOSAL_TTL,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, RulesError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, RulesError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        RulesError::NotUpgradeAuthority
    );
    Ok(())
}
