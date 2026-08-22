use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    errors::CreditsError,
    events::ConfigInitialized,
    instructions::admin::{init_limiter_fields, validate_params},
    state::{CreditsConfig, SettleLimiter, UpdateConfigParams},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitConfigParams {
    pub settlement_authority: Pubkey,
    pub guardian: Pubkey,
    /// 0 selects `DEFAULT_MAX_BALANCE_PER_KEY`.
    pub max_balance_per_key: u64,
    /// `None` selects the defaults (365 days, 72h, 30 days). A value outside the program's floors is rejected.
    pub credit_ttl: Option<i64>,
    pub refund_delay: Option<i64>,
    pub expiry_grace: Option<i64>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Admin key (Squads 2-of-3 in production). Pays for the config and vault accounts. Must be the program's upgrade
    /// authority, so nobody else can initialise the program between deploy and init.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + CreditsConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, CreditsConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + SettleLimiter::INIT_SPACE,
        seeds = [LIMITER_SEED],
        bump
    )]
    pub limiter: Account<'info, SettleLimiter>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// Program-owned USDC vault; authority is the config PDA.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = treasury_token_account.mint == usdc_mint.key() @ CreditsError::MintMismatch)]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_config(ctx: Context<InitConfig>, params: InitConfigParams) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.authority.key())?;
    // The vault is a classic SPL Token account (USDC's own program). A Token-2022 mint could carry a transfer fee, and
    // a deposit would then credit more than the vault receives.
    require_keys_eq!(ctx.accounts.token_program.key(), anchor_spl::token::ID, CreditsError::MintMismatch);
    require!(params.settlement_authority != Pubkey::default(), CreditsError::InvalidConfigValue);
    require!(params.guardian != Pubkey::default(), CreditsError::InvalidConfigValue);
    validate_params(&UpdateConfigParams {
        max_balance_per_key: if params.max_balance_per_key == 0 { None } else { Some(params.max_balance_per_key) },
        credit_ttl: params.credit_ttl,
        refund_delay: params.refund_delay,
        expiry_grace: params.expiry_grace,
        ..Default::default()
    })?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.settlement_authority = params.settlement_authority;
    config.guardian = params.guardian;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.vault = ctx.accounts.vault.key();
    config.treasury_token_account = ctx.accounts.treasury_token_account.key();
    config.max_balance_per_key = if params.max_balance_per_key == 0 {
        DEFAULT_MAX_BALANCE_PER_KEY
    } else {
        params.max_balance_per_key
    };
    config.credit_ttl = params.credit_ttl.unwrap_or(DEFAULT_CREDIT_TTL);
    config.refund_delay = params.refund_delay.unwrap_or(DEFAULT_REFUND_DELAY);
    config.expiry_grace = params.expiry_grace.unwrap_or(DEFAULT_EXPIRY_GRACE);
    config.spent_total = 0;
    config.settled_total = 0;
    config.latest_hour = -1;
    config.deposits_paused = false;
    config.deposits_paused_until = 0;
    config.deposits_guardian_ready_at = 0;
    config.bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault;
    init_limiter_fields(&mut ctx.accounts.limiter, ctx.bumps.limiter);

    emit!(ConfigInitialized {
        authority: config.authority,
        settlement_authority: config.settlement_authority,
        guardian: config.guardian,
        usdc_mint: config.usdc_mint,
        vault: config.vault,
        treasury_token_account: config.treasury_token_account,
        max_balance_per_key: config.max_balance_per_key,
    });
    Ok(())
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, CreditsError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, CreditsError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        CreditsError::NotUpgradeAuthority
    );
    Ok(())
}
