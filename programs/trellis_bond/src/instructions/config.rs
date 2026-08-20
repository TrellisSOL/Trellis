use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{errors::BondError, events::*, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigArgs {
    pub slasher: Pubkey,
    pub guardian: Pubkey,
    /// PDA of `trellis_capacity` (seeds `["bond_claimer"]`) allowed to file shortfall claims and lock bonds.
    pub capacity_claimer: Pubkey,
    pub min_bond: Option<u64>,
    pub unbond_period: Option<i64>,
    pub dispute_window: Option<i64>,
    pub dispute_block: Option<i64>,
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
        space = 8 + BondConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, BondConfig>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = refund_pool.mint == usdc_mint.key() @ BondError::MintMismatch)]
    pub refund_pool: Account<'info, TokenAccount>,
    #[account(constraint = treasury.mint == usdc_mint.key() @ BondError::MintMismatch)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(constraint = capacity_refund.mint == usdc_mint.key() @ BondError::MintMismatch)]
    pub capacity_refund: Account<'info, TokenAccount>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Bounds every value must satisfy, whoever sets it and however.
pub fn validate_args(a: &UpdateConfigArgs) -> Result<()> {
    if let Some(v) = a.new_authority {
        require!(v != Pubkey::default(), BondError::InvalidConfigValue);
    }
    for key in [a.slasher, a.guardian, a.capacity_claimer].into_iter().flatten() {
        require!(key != Pubkey::default(), BondError::InvalidConfigValue);
    }
    if let Some(v) = a.min_bond {
        require!(v > 0, BondError::InvalidConfigValue);
        require!(v <= MAX_MIN_BOND, BondError::OutOfBounds);
    }
    if let Some(v) = a.unbond_period {
        require!((MIN_UNBOND_PERIOD..=MAX_UNBOND_PERIOD).contains(&v), BondError::OutOfBounds);
    }
    if let Some(v) = a.dispute_window {
        require!((MIN_DISPUTE_WINDOW..=MAX_DISPUTE_WINDOW).contains(&v), BondError::OutOfBounds);
    }
    if let Some(v) = a.dispute_block {
        require!((MIN_DISPUTE_BLOCK..=MAX_DISPUTE_BLOCK).contains(&v), BondError::OutOfBounds);
    }
    Ok(())
}

fn apply_args(config: &mut BondConfig, a: &UpdateConfigArgs) {
    if let Some(v) = a.slasher {
        config.slasher = v;
    }
    if let Some(v) = a.guardian {
        config.guardian = v;
    }
    if let Some(v) = a.capacity_claimer {
        config.capacity_claimer = v;
    }
    if let Some(v) = a.min_bond {
        config.min_bond = v;
    }
    if let Some(v) = a.unbond_period {
        config.unbond_period = v;
    }
    if let Some(v) = a.dispute_window {
        config.dispute_window = v;
    }
    if let Some(v) = a.dispute_block {
        config.dispute_block = v;
    }
}

fn emit_updated(config: &BondConfig) {
    emit!(BondConfigUpdated {
        authority: config.authority,
        slasher: config.slasher,
        guardian: config.guardian,
        min_bond: config.min_bond,
    });
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.authority.key())?;
    validate_args(&UpdateConfigArgs {
        new_authority: None,
        slasher: Some(args.slasher),
        guardian: Some(args.guardian),
        capacity_claimer: Some(args.capacity_claimer),
        min_bond: args.min_bond,
        unbond_period: args.unbond_period,
        dispute_window: args.dispute_window,
        dispute_block: args.dispute_block,
    })?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.slasher = args.slasher;
    config.guardian = args.guardian;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.refund_pool = ctx.accounts.refund_pool.key();
    config.treasury = ctx.accounts.treasury.key();
    config.capacity_claimer = args.capacity_claimer;
    config.capacity_refund = ctx.accounts.capacity_refund.key();
    config.min_bond = args.min_bond.unwrap_or(DEFAULT_MIN_BOND);
    config.unbond_period = args.unbond_period.unwrap_or(DEFAULT_UNBOND_PERIOD);
    config.dispute_window = args.dispute_window.unwrap_or(DEFAULT_DISPUTE_WINDOW);
    config.dispute_block = args.dispute_block.unwrap_or(DEFAULT_DISPUTE_BLOCK);
    config.paused = false;
    config.paused_until = 0;
    config.guardian_pause_ready_at = 0;
    config.bump = ctx.bumps.config;
    emit_updated(config);
    Ok(())
}

// Configuration changes come in two kinds.
//
// Tightening (immediate, `update_config`): a longer unbond period, a longer dispute window, a longer dispute block.
// None of these lets anyone take a bond sooner, and none reaches back: an unbond request, a proposal's window and a
// dispute's block are fixed when they are made (`HostBond.unbond_at`, `SlashProposal.window_end` / `unblock_at`).
//
// Everything else is loosening and goes through `propose_config` -> wait `CONFIG_TIMELOCK` (24h) -> `resolve_config(apply = true)`:
// replacing the slasher, the guardian, the capacity claimer or any payout account (refund pool, treasury, capacity
// refund), ANY change of the minimum bond (raising it makes smaller bonds inactive), shortening any delay. The pending change sits in a public account for the whole
// delay and the authority can cancel it (the guardian cannot). Whatever the path, the floors and bounds in `state.rs` hold.

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BondError::Unauthorized,
    )]
    pub config: Account<'info, BondConfig>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_args(&args)?;
    let config = &mut ctx.accounts.config;
    let tightening = args.new_authority.is_none()
        && args.slasher.is_none()
        && args.guardian.is_none()
        && args.capacity_claimer.is_none()
        && args.min_bond.is_none()
        && args.unbond_period.is_none_or(|v| v >= config.unbond_period)
        && args.dispute_window.is_none_or(|v| v >= config.dispute_window)
        && args.dispute_block.is_none_or(|v| v >= config.dispute_block);
    require!(tightening, BondError::RequiresTimelock);
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
        has_one = authority @ BondError::Unauthorized,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingConfig::INIT_SPACE,
        seeds = [PENDING_CONFIG_SEED],
        bump
    )]
    pub pending_config: Account<'info, PendingConfig>,
    /// Optional replacements for the payout accounts; each must be a USDC token account.
    #[account(constraint = refund_pool.mint == config.usdc_mint @ BondError::MintMismatch)]
    pub refund_pool: Option<Account<'info, TokenAccount>>,
    #[account(constraint = treasury.mint == config.usdc_mint @ BondError::MintMismatch)]
    pub treasury: Option<Account<'info, TokenAccount>>,
    #[account(constraint = capacity_refund.mint == config.usdc_mint @ BondError::MintMismatch)]
    pub capacity_refund: Option<Account<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_config(ctx: Context<ProposeConfig>, args: UpdateConfigArgs) -> Result<()> {
    validate_args(&args)?;
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_config;
    pending.args = args;
    pending.refund_pool = ctx.accounts.refund_pool.as_ref().map(|a| a.key());
    pending.treasury = ctx.accounts.treasury.as_ref().map(|a| a.key());
    pending.capacity_refund = ctx.accounts.capacity_refund.as_ref().map(|a| a.key());
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(BondError::Overflow)?;
    pending.bump = ctx.bumps.pending_config;
    emit!(BondConfigProposed {
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
        changes_authority: pending.args.new_authority.is_some(),
        changes_guardian: pending.args.guardian.is_some(),
        changes_capacity_claimer: pending.args.capacity_claimer.is_some(),
        changes_payout_accounts: pending.refund_pool.is_some()
            || pending.treasury.is_some()
            || pending.capacity_refund.is_some(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveConfig<'info> {
    /// Applying or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ BondError::Unauthorized)]
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
        require!(signer == config.authority || expired, BondError::Unauthorized);
        emit!(BondConfigProposalResolved { applied: false, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, BondError::Unauthorized);
    require!(now >= pending.effective_at, BondError::TimelockNotElapsed);
    require!(!expired, BondError::ProposalExpired);
    validate_args(&pending.args)?;
    let args = pending.args.clone();
    apply_args(config, &args);
    if let Some(v) = pending.refund_pool {
        config.refund_pool = v;
    }
    if let Some(v) = pending.treasury {
        config.treasury = v;
    }
    if let Some(v) = pending.capacity_refund {
        config.capacity_refund = v;
    }
    if let Some(new_authority) = args.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), BondError::Unauthorized);
        config.authority = new_authority;
    }
    emit!(BondConfigProposalResolved { applied: true, by: signer });
    emit_updated(config);
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
}

/// The guardian or the authority pauses new bonds for `PAUSE_TTL` (72h). It never moves funds and never stops anyone
/// from taking their own funds out. The pause lapses by itself; the authority may set it again as often as it likes.
/// The guardian, after a pause, must wait `GUARDIAN_PAUSE_COOLDOWN` (7 days from the moment that pause was due to
/// lapse) before it can pause again, so a stolen guardian key buys one pause of at most 72h (security re-review RR-02).
pub fn handle_pause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(
        signer == config.guardian || signer == config.authority,
        BondError::NotGuardian
    );
    let now = Clock::get()?.unix_timestamp;
    let until = now.checked_add(PAUSE_TTL).ok_or(BondError::Overflow)?;
    if signer != config.authority {
        require!(now >= config.guardian_pause_ready_at, BondError::GuardianCooldown);
        config.guardian_pause_ready_at = until.checked_add(GUARDIAN_PAUSE_COOLDOWN).ok_or(BondError::Overflow)?;
    }
    config.paused = true;
    config.paused_until = until;
    emit!(BondPauseChanged { paused: true, by: signer, paused_until: until });
    Ok(())
}

/// Only the authority may unpause before the pause lapses (the guardian can only tighten).
pub fn handle_unpause(ctx: Context<SetPaused>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();
    require!(signer == config.authority, BondError::Unauthorized);
    config.paused = false;
    config.paused_until = 0;
    emit!(BondPauseChanged { paused: false, by: signer, paused_until: 0 });
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
        BondConfig::DISCRIMINATOR,
        BondConfig::LEGACY_LEN,
        8 + BondConfig::INIT_SPACE,
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
    require_keys_eq!(*account.owner, crate::ID, BondError::NotMigratable);
    require!(account.data_len() != new_len, BondError::AlreadyMigrated);
    require!(account.data_len() == old_len, BondError::NotMigratable);
    require!(account.try_borrow_data()?[..8] == *discriminator, BondError::NotMigratable);
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

#[derive(Accounts)]
pub struct MigrateProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a `SlashProposal` in its earlier, shorter layout; `grow_account` checks owner, type and length.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a proposal created before `unblock_at` existed to the current layout (the field starts at zero, which keeps the
/// earlier rule for that proposal). Anyone may pay; it works once per proposal.
pub fn handle_migrate_proposal(ctx: Context<MigrateProposal>) -> Result<()> {
    grow_account(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        SlashProposal::DISCRIMINATOR,
        SlashProposal::LEGACY_LEN,
        8 + SlashProposal::INIT_SPACE,
    )
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
        min_dispute_window: MIN_DISPUTE_WINDOW,
        min_dispute_block: MIN_DISPUTE_BLOCK,
        min_unbond_period: MIN_UNBOND_PERIOD,
        slash_window: SLASH_WINDOW,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, BondError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, BondError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        BondError::NotUpgradeAuthority
    );
    Ok(())
}
