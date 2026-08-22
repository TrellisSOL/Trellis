use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    errors::CreditsError,
    events::{Deposited, KeyAuthorityChanged},
    state::{pause_active, CreditAccount, CreditsConfig, DepositorShare},
};

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    /// Anyone may deposit to any key hash ("top up a key"). `init_if_needed` is justified here: a deposit is the only way a credit account comes
    /// into existence (there is no separate "open" instruction, per Backend §5.1), and the
    /// re-initialisation attack does not apply because this program never closes a
    /// `CreditAccount` (closure sets `closed = true` and keeps the account).
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + CreditAccount::INIT_SPACE,
        seeds = [CREDIT_SEED, key_hash.as_ref()],
        bump
    )]
    pub credit: Account<'info, CreditAccount>,
    /// What this wallet has put into this key, and where it wants it back. `init_if_needed`: created by the wallet's
    /// first deposit to the key and never closed, so it cannot be re-initialised.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + DepositorShare::INIT_SPACE,
        seeds = [SHARE_SEED, key_hash.as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub share: Account<'info, DepositorShare>,
    #[account(
        mut,
        constraint = depositor_token_account.mint == config.usdc_mint @ CreditsError::MintMismatch,
    )]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ CreditsError::MintMismatch)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, key_hash: [u8; 32], amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    require!(
        !pause_active(config.deposits_paused, config.deposits_paused_until, now),
        CreditsError::DepositsPaused
    );
    require!(amount > 0, CreditsError::ZeroAmount);
    require!(amount >= MIN_DEPOSIT, CreditsError::DepositTooSmall);

    let credit = &mut ctx.accounts.credit;

    require!(key_hash != [0u8; 32], CreditsError::InvalidKeyHash);
    if credit.key_hash == [0u8; 32] {
        // Freshly created by init_if_needed. The depositor gains nothing over the key: `authority` stays unset until
        // the key itself registers an owner wallet (`set_key_authority`, which that wallet must sign too), and only
        // the key or that owner can close the account.
        credit.key_hash = key_hash;
        credit.authority = Pubkey::default();
        credit.bump = ctx.bumps.credit;
    } else {
        require!(!credit.closed, CreditsError::AccountClosed);
        require!(credit.key_hash == key_hash, CreditsError::Unauthorized);
    }

    let new_balance = credit.balance.checked_add(amount).ok_or(CreditsError::Overflow)?;
    require!(new_balance <= config.max_balance_per_key, CreditsError::MaxBalanceExceeded);
    credit.balance = new_balance;
    credit.deposited_total = credit
        .deposited_total
        .checked_add(amount)
        .ok_or(CreditsError::Overflow)?;
    // Every deposit extends the whole balance and cancels any outstanding expiry notice.
    credit.expires_at = now.checked_add(config.credit_ttl).ok_or(CreditsError::Overflow)?;
    credit.expiry_notice_at = 0;

    // The depositor's own record: a closure refund of this USDC can only go back to this wallet, to the token account
    // it names. It starts as the account the first deposit came from.
    let share = &mut ctx.accounts.share;
    if share.depositor == Pubkey::default() {
        share.key_hash = key_hash;
        share.depositor = ctx.accounts.depositor.key();
        share.refund_to = ctx.accounts.depositor_token_account.key();
        share.bump = ctx.bumps.share;
    }
    share.deposited = share.deposited.checked_add(amount).ok_or(CreditsError::Overflow)?;
    share.last_deposit_at = now;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(Deposited {
        key_hash,
        depositor: ctx.accounts.depositor.key(),
        amount,
        new_balance,
        expires_at: credit.expires_at,
    });
    Ok(())
}

/// `sha256(key address)`: the id a key's credit account is derived from.
pub fn key_hash_of(key: &Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hash(key.as_ref()).to_bytes()
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct SetKeyAuthority<'info> {
    /// While the key has no owner: the API key's own ed25519 keypair (its public key must hash to `key_hash`). Once an
    /// owner is registered: that owner wallet. The key alone can never replace or clear a registered owner.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, key_hash.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, CreditAccount>,
    /// The wallet being registered as owner. It must sign: a key cannot name a wallet that has not agreed (and so
    /// cannot borrow someone else's standing, security review round 3 R3-23). Omitted only when the owner clears itself.
    pub new_owner: Option<Signer<'info>>,
}

/// Registers, changes or clears the key's owner wallet (`CreditAccount::authority`).
///
/// - No owner yet: signed by the key and by the wallet. First registration wins, so register the owner when the key is
///   created, before it can leak.
/// - An owner is registered: signed by that owner (and by the new owner, unless it is cleared with the default pubkey).
/// The owner can close the key without the key and cancel any closure; it has no claim on funds.
pub fn handle_set_key_authority(
    ctx: Context<SetKeyAuthority>,
    key_hash: [u8; 32],
    new_authority: Pubkey,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let credit = &mut ctx.accounts.credit;
    require!(!credit.closed, CreditsError::AccountClosed);
    let old = credit.authority;
    if old == Pubkey::default() {
        require!(key_hash_of(&signer) == key_hash, CreditsError::NotTheKey);
        require!(new_authority != Pubkey::default(), CreditsError::InvalidConfigValue);
    } else {
        require_keys_eq!(signer, old, CreditsError::Unauthorized);
    }
    if new_authority != Pubkey::default() {
        let accepted = ctx.accounts.new_owner.as_ref().map(|s| s.key());
        require!(accepted == Some(new_authority), CreditsError::OwnerMustSign);
    }
    credit.authority = new_authority;
    emit!(KeyAuthorityChanged { key_hash, old_authority: old, new_authority });
    Ok(())
}
