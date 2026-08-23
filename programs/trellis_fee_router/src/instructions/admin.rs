use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    errors::FeeRouterError,
    events::{AuthorityTransferred, ChangeProposed, FeeConfigInitialized, FeeConfigUpdated},
    state::{FeeConfig, PendingChange},
};

fn check_split(workers_bps: u16, treasury_bps: u16) -> Result<()> {
    let sum = (workers_bps as u32)
        .checked_add(treasury_bps as u32)
        .ok_or(FeeRouterError::Overflow)?;
    require!(sum == BPS_DENOMINATOR as u32, FeeRouterError::InvalidSplit);
    Ok(())
}

/// `distribute` takes the fee vault, the workers vault and the treasury vault as three writable accounts, and the
/// runtime checks refuse the same account twice. A config in which two of them are one account could therefore never
/// distribute again: the fees would sit in the vault until a proposal replaced it, 24 hours later at best (security
/// review round 3, R3-27). Refused wherever a config is written: at init, when a change is proposed and when it is
/// applied.
fn check_distinct_vaults(fee_vault: &Pubkey, workers_vault: &Pubkey, treasury_vault: &Pubkey) -> Result<()> {
    require!(
        workers_vault != treasury_vault && workers_vault != fee_vault && treasury_vault != fee_vault,
        FeeRouterError::DuplicateVault
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitFeeConfig<'info> {
    /// Admin key (Squads 2-of-3 in production).
    /// Pays for the accounts. Must be the program's upgrade authority, so nobody else can initialise the program
    /// between deploy and init.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + FeeConfig::INIT_SPACE,
        seeds = [FEE_CONFIG_SEED],
        bump
    )]
    pub fee_config: Account<'info, FeeConfig>,
    /// Mint fees are collected in (USDC).
    pub fee_mint: InterfaceAccount<'info, Mint>,
    /// $TRLS mint; must be a Token-2022 mint.
    #[account(
        constraint = trls_mint.to_account_info().owner == &Token2022::id()
            @ FeeRouterError::NotToken2022Mint,
    )]
    pub trls_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [FEE_VAULT_SEED],
        bump,
        token::mint = fee_mint,
        token::authority = fee_config,
        token::token_program = fee_token_program,
    )]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        seeds = [TRLS_VAULT_SEED],
        bump,
        token::mint = trls_mint,
        token::authority = fee_config,
        token::token_program = token_2022_program,
    )]
    pub trls_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = workers_vault.mint == fee_mint.key() @ FeeRouterError::MintMismatch)]
    pub workers_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = treasury_vault.mint == fee_mint.key() @ FeeRouterError::MintMismatch)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub fee_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// `authority` is the key that will distribute fees and burn $TRLS (the settlement service key, or the multisig); it
/// need not be the payer.
pub fn handle_init_fee_config(
    ctx: Context<InitFeeConfig>,
    authority: Pubkey,
    workers_bps: u16,
    treasury_bps: u16,
) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.payer.key())?;
    require!(authority != Pubkey::default(), FeeRouterError::InvalidConfigValue);
    check_split(workers_bps, treasury_bps)?;
    check_distinct_vaults(
        &ctx.accounts.fee_vault.key(),
        &ctx.accounts.workers_vault.key(),
        &ctx.accounts.treasury_vault.key(),
    )?;
    let c = &mut ctx.accounts.fee_config;
    c.authority = authority;
    c.fee_mint = ctx.accounts.fee_mint.key();
    c.trls_mint = ctx.accounts.trls_mint.key();
    c.fee_vault = ctx.accounts.fee_vault.key();
    c.trls_vault = ctx.accounts.trls_vault.key();
    c.workers_vault = ctx.accounts.workers_vault.key();
    c.treasury_vault = ctx.accounts.treasury_vault.key();
    c.workers_bps = workers_bps;
    c.treasury_bps = treasury_bps;
    c.last_period = -1;
    c.distributed_total = 0;
    c.burned_total = 0;
    c.bump = ctx.bumps.fee_config;
    c.fee_vault_bump = ctx.bumps.fee_vault;
    c.trls_vault_bump = ctx.bumps.trls_vault;
    emit!(FeeConfigInitialized {
        authority: c.authority,
        fee_mint: c.fee_mint,
        trls_mint: c.trls_mint,
        fee_vault: c.fee_vault,
        trls_vault: c.trls_vault,
        workers_vault: c.workers_vault,
        treasury_vault: c.treasury_vault,
        workers_bps,
        treasury_bps,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ FeeRouterError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,
}

/// Updates the split between the two configured vaults (both values, summing to 10,000). Immediate: whatever the
/// split, fees only ever reach the configured vaults, and those change only through `propose_change` and its timelock.
pub fn handle_update_fee_config(
    ctx: Context<UpdateFeeConfig>,
    workers_bps: Option<u16>,
    treasury_bps: Option<u16>,
) -> Result<()> {
    let c = &mut ctx.accounts.fee_config;
    match (workers_bps, treasury_bps) {
        (Some(w), Some(t)) => {
            check_split(w, t)?;
            c.workers_bps = w;
            c.treasury_bps = t;
        }
        (None, None) => {}
        _ => return err!(FeeRouterError::InvalidSplit),
    }
    emit!(FeeConfigUpdated {
        workers_vault: c.workers_vault,
        treasury_vault: c.treasury_vault,
        workers_bps: c.workers_bps,
        treasury_bps: c.treasury_bps,
    });
    Ok(())
}

// Where fees are paid to, and who the authority is, change only through the timelock: `propose_change` records the
// replacement vaults and / or the new authority, `resolve_change(apply = true)` installs them after `CONFIG_TIMELOCK`
// (24h) (a new authority must co-sign) and before it expires (`PROPOSAL_TTL` later), `resolve_change(apply = false)`
// drops the proposal. This program has no guardian: only the authority resolves a proposal either way.

#[derive(Accounts)]
pub struct ProposeChange<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ FeeRouterError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingChange::INIT_SPACE,
        seeds = [PENDING_CHANGE_SEED],
        bump
    )]
    pub pending_change: Account<'info, PendingChange>,
    #[account(constraint = new_workers_vault.mint == fee_config.fee_mint @ FeeRouterError::MintMismatch)]
    pub new_workers_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = new_treasury_vault.mint == fee_config.fee_mint @ FeeRouterError::MintMismatch)]
    pub new_treasury_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_change(ctx: Context<ProposeChange>, new_authority: Option<Pubkey>) -> Result<()> {
    require!(new_authority != Some(Pubkey::default()), FeeRouterError::InvalidConfigValue);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_change;
    pending.new_authority = new_authority;
    pending.workers_vault = ctx.accounts.new_workers_vault.as_ref().map(|v| v.key());
    pending.treasury_vault = ctx.accounts.new_treasury_vault.as_ref().map(|v| v.key());
    require!(
        new_authority.is_some() || pending.workers_vault.is_some() || pending.treasury_vault.is_some(),
        FeeRouterError::InvalidConfigValue
    );
    // The config as it would stand once this proposal is applied.
    let c = &ctx.accounts.fee_config;
    check_distinct_vaults(
        &c.fee_vault,
        &pending.workers_vault.unwrap_or(c.workers_vault),
        &pending.treasury_vault.unwrap_or(c.treasury_vault),
    )?;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(FeeRouterError::Overflow)?;
    pending.bump = ctx.bumps.pending_change;
    emit!(ChangeProposed {
        new_authority,
        workers_vault: pending.workers_vault,
        treasury_vault: pending.treasury_vault,
        effective_at: pending.effective_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveChange<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ FeeRouterError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(mut, close = authority, seeds = [PENDING_CHANGE_SEED], bump = pending_change.bump)]
    pub pending_change: Account<'info, PendingChange>,
    /// Required only when the pending change hands the authority over: the new authority must sign to take it.
    pub new_authority: Option<Signer<'info>>,
}

pub fn handle_resolve_change(ctx: Context<ResolveChange>, apply: bool) -> Result<()> {
    if !apply {
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;
    let pending = &ctx.accounts.pending_change;
    require!(now >= pending.effective_at, FeeRouterError::TimelockNotElapsed);
    require!(now <= pending.effective_at.saturating_add(PROPOSAL_TTL), FeeRouterError::ProposalExpired);
    let c = &mut ctx.accounts.fee_config;
    if let Some(v) = pending.workers_vault {
        c.workers_vault = v;
    }
    if let Some(v) = pending.treasury_vault {
        c.treasury_vault = v;
    }
    check_distinct_vaults(&c.fee_vault, &c.workers_vault, &c.treasury_vault)?;
    if let Some(new_authority) = pending.new_authority {
        let accepted = ctx.accounts.new_authority.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), FeeRouterError::Unauthorized);
        let old = c.authority;
        c.authority = new_authority;
        emit!(AuthorityTransferred { old_authority: old, new_authority });
    }
    emit!(FeeConfigUpdated {
        workers_vault: c.workers_vault,
        treasury_vault: c.treasury_vault,
        workers_bps: c.workers_bps,
        treasury_bps: c.treasury_bps,
    });
    Ok(())
}

/// `build_profile` takes no account: it only reports constants.
#[derive(Accounts)]
pub struct ReadBuildProfile {}

/// The floors this binary was compiled with, as return data. Read-only and free to simulate: it is how a deployed
/// program is told apart from a `devnet`-feature build, whose IDL and account layouts are identical.
pub fn handle_build_profile(_ctx: Context<ReadBuildProfile>) -> Result<crate::state::BuildProfile> {
    Ok(crate::state::BuildProfile {
        profile: BUILD_PROFILE,
        config_timelock: CONFIG_TIMELOCK,
        proposal_ttl: PROPOSAL_TTL,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, FeeRouterError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, FeeRouterError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        FeeRouterError::NotUpgradeAuthority
    );
    Ok(())
}
