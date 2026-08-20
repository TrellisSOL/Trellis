use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{errors::BondError, events::*, state::*};

#[derive(Accounts)]
pub struct PostBond<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    #[account(
        init_if_needed,
        payer = host,
        space = 8 + HostBond::INIT_SPACE,
        seeds = [BOND_SEED, host.key().as_ref()],
        bump
    )]
    pub bond: Account<'info, HostBond>,
    #[account(address = config.usdc_mint @ BondError::MintMismatch)]
    pub usdc_mint: Account<'info, Mint>,
    /// Vault holding the bonded USDC; authority is the `HostBond` PDA.
    #[account(
        init_if_needed,
        payer = host,
        seeds = [VAULT_SEED, bond.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = bond,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = host_token.mint == config.usdc_mint @ BondError::MintMismatch,
        constraint = host_token.owner == host.key() @ BondError::TokenOwnerMismatch,
    )]
    pub host_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Post (or top up) a host bond. The resulting total must be at least `min_bond`.
pub fn handle_post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
    require!(amount > 0, BondError::ZeroAmount);
    let config = &ctx.accounts.config;
    let bond = &mut ctx.accounts.bond;

    if bond.host == Pubkey::default() {
        // Fresh bond: new postings are subject to the guardian pause.
        require!(!config.pause_active(Clock::get()?.unix_timestamp), BondError::Paused);
        bond.host = ctx.accounts.host.key();
        bond.bump = ctx.bumps.bond;
        bond.vault_bump = ctx.bumps.vault;
    } else {
        require_keys_eq!(bond.host, ctx.accounts.host.key(), BondError::Unauthorized);
    }

    let new_total = bond.amount.checked_add(amount).ok_or(BondError::Overflow)?;
    require!(new_total >= config.min_bond, BondError::BelowMinimumBond);

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.host_token.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.host.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    bond.amount = new_total;
    emit!(BondPosted {
        bond: bond.key(),
        host: bond.host,
        amount,
        total: new_total,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct HostOnly<'info> {
    pub host: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    #[account(
        mut,
        seeds = [BOND_SEED, host.key().as_ref()],
        bump = bond.bump,
        has_one = host @ BondError::Unauthorized,
    )]
    pub bond: Account<'info, HostBond>,
}

/// Start the 14-day unbond clock. While unbonding the bond no longer backs new capacity
/// commitments (see `HostBond::is_active`).
pub fn handle_request_unbond(ctx: Context<HostOnly>) -> Result<()> {
    let bond = &mut ctx.accounts.bond;
    require!(bond.unbond_at == 0, BondError::UnbondAlreadyRequested);
    let now = Clock::get()?.unix_timestamp;
    bond.unbond_at = now
        .checked_add(ctx.accounts.config.unbond_period)
        .ok_or(BondError::Overflow)?;
    emit!(UnbondRequested {
        bond: bond.key(),
        host: bond.host,
        unbond_at: bond.unbond_at,
    });
    Ok(())
}

pub fn handle_cancel_unbond(ctx: Context<HostOnly>) -> Result<()> {
    let bond = &mut ctx.accounts.bond;
    require!(bond.unbond_at != 0, BondError::UnbondNotRequested);
    bond.unbond_at = 0;
    emit!(UnbondCancelled {
        bond: bond.key(),
        host: bond.host,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    pub host: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    #[account(
        mut,
        seeds = [BOND_SEED, host.key().as_ref()],
        bump = bond.bump,
        has_one = host @ BondError::Unauthorized,
    )]
    pub bond: Account<'info, HostBond>,
    /// CHECK: this bond's lock PDA. Mandatory (a host cannot leave it out to skip the lock); it holds no data until
    /// the host has committed capacity, and then counts as zero locked.
    #[account(seeds = [LOCK_SEED, bond.key().as_ref()], bump)]
    pub bond_lock: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ BondError::MintMismatch)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, bond.key().as_ref()],
        bump = bond.vault_bump,
        token::mint = usdc_mint,
        token::authority = bond,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = host_token.mint == config.usdc_mint @ BondError::MintMismatch,
        constraint = host_token.owner == host.key() @ BondError::TokenOwnerMismatch,
    )]
    pub host_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// USDC of this bond locked behind open capacity commitments (0 when the lock account was never created).
pub fn locked_amount(bond_lock: &UncheckedAccount) -> Result<u64> {
    if bond_lock.owner != &crate::ID || bond_lock.data_is_empty() {
        return Ok(0);
    }
    let data = bond_lock.try_borrow_data()?;
    Ok(BondLock::try_deserialize(&mut &data[..])?.locked)
}

/// Withdraw the bond after the unbond period, provided no slash proposal is open. What is locked behind open capacity
/// commitments stays (and stays slashable) until `trellis_capacity` releases it; the host withdraws the rest now and
/// calls again once the lock is gone.
pub fn handle_withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
    let bond = &ctx.accounts.bond;
    require!(bond.unbond_at != 0, BondError::UnbondNotRequested);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= bond.unbond_at, BondError::UnbondPeriodNotElapsed);
    require!(bond.open_proposals == 0, BondError::OpenProposals);
    require!(bond.amount > 0, BondError::NothingToWithdraw);
    require!(ctx.accounts.vault.amount >= bond.amount, BondError::VaultUnderfunded);

    let locked = locked_amount(&ctx.accounts.bond_lock)?;
    let amount = bond.amount.saturating_sub(locked);
    require!(amount > 0, BondError::BondLocked);

    let host_key = bond.host;
    let seeds: &[&[u8]] = &[BOND_SEED, host_key.as_ref(), &[bond.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.host_token.to_account_info(),
                authority: ctx.accounts.bond.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let bond = &mut ctx.accounts.bond;
    bond.amount = bond.amount.checked_sub(amount).ok_or(BondError::Overflow)?;
    // The bond keeps unbonding (and so backs no new commitment) while a locked remainder is left.
    if bond.amount == 0 {
        bond.unbond_at = 0;
    }
    emit!(BondWithdrawn {
        bond: bond.key(),
        host: bond.host,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct LockBond<'info> {
    /// `trellis_capacity`'s claimer PDA; only reachable via CPI from that program.
    pub capacity_claimer: Signer<'info>,
    /// Pays the lock account's rent the first time (the host committing capacity).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = capacity_claimer @ BondError::NotCapacityClaimer,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    /// CHECK: this bond's slash ledger PDA. Mandatory (it cannot be left out to hide pending claims); it holds no data
    /// until the bond's first proposal, and then counts as nothing pending.
    #[account(seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()], bump)]
    pub slash_ledger: UncheckedAccount<'info>,
    /// `init_if_needed`: the lock is created by the first commitment and never closed, so it cannot be re-initialised.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BondLock::INIT_SPACE,
        seeds = [LOCK_SEED, bond.key().as_ref()],
        bump
    )]
    pub bond_lock: Account<'info, BondLock>,
    pub system_program: Program<'info, System>,
}

/// Capacity-shortfall claims filed against this bond and not yet executed or rejected (0 when the ledger was never
/// created).
pub fn pending_claims(slash_ledger: &UncheckedAccount) -> Result<u64> {
    if slash_ledger.owner != &crate::ID || slash_ledger.data_is_empty() {
        return Ok(0);
    }
    let data = slash_ledger.try_borrow_data()?;
    Ok(SlashLedger::try_deserialize(&mut &data[..])?.pending_claims)
}

/// `trellis_capacity` locks `amount` of the bond behind a new capacity commitment.
///
/// The bond must cover it on top of everything already locked AND every claim still open against it: the lock, not
/// `trellis_capacity`'s own running total, is the true figure. A commitment whose shortfall has been reported keeps its
/// lock until it is released, and its filed claims keep counting until each is paid or dropped, so the same USDC can
/// never back a second commitment in the meantime (security re-review RR-07).
pub fn handle_lock_bond(ctx: Context<LockBond>, amount: u64) -> Result<()> {
    let pending = pending_claims(&ctx.accounts.slash_ledger)?;
    let lock = &mut ctx.accounts.bond_lock;
    lock.bond = ctx.accounts.bond.key();
    lock.bump = ctx.bumps.bond_lock;
    lock.locked = lock.locked.checked_add(amount).ok_or(BondError::Overflow)?;
    let needed = lock.locked.checked_add(pending).ok_or(BondError::Overflow)?;
    require!(needed <= ctx.accounts.bond.amount, BondError::ExceedsBondHeadroom);
    emit!(BondLockChanged { bond: lock.bond, locked: lock.locked });
    Ok(())
}

#[derive(Accounts)]
pub struct UnlockBond<'info> {
    /// `trellis_capacity`'s claimer PDA; only reachable via CPI from that program.
    pub capacity_claimer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = capacity_claimer @ BondError::NotCapacityClaimer,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(mut, seeds = [LOCK_SEED, bond.key().as_ref()], bump = bond_lock.bump)]
    pub bond_lock: Account<'info, BondLock>,
}

/// `trellis_capacity` releases `amount` when a commitment is settled.
pub fn handle_unlock_bond(ctx: Context<UnlockBond>, amount: u64) -> Result<()> {
    let lock = &mut ctx.accounts.bond_lock;
    lock.locked = lock.locked.saturating_sub(amount);
    emit!(BondLockChanged { bond: lock.bond, locked: lock.locked });
    Ok(())
}
