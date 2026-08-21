use anchor_lang::prelude::*;
use trellis_bond::{program::TrellisBond, BondConfig, HostBond};

use crate::{errors::CapacityError, events::*, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CommitCapacityArgs {
    pub commitment_id: u64,
    pub grade: u8,
    pub tokens: u64,
    pub window_start: i64,
    pub window_end: i64,
}

#[derive(Accounts)]
#[instruction(args: CommitCapacityArgs)]
pub struct CommitCapacity<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CapacityConfig>,
    /// `trellis_bond` config (for `min_bond`). `Account<..>` enforces the owner is `trellis_bond`.
    #[account(
        seeds = [trellis_bond::CONFIG_SEED],
        bump = bond_config.bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_config: Account<'info, BondConfig>,
    /// The host's bond; must be active and have enough headroom for this commitment.
    #[account(
        seeds = [trellis_bond::BOND_SEED, host.key().as_ref()],
        bump = host_bond.bump,
        seeds::program = trellis_bond::ID,
        constraint = host_bond.host == host.key() @ CapacityError::BondHostMismatch,
    )]
    pub host_bond: Account<'info, HostBond>,
    #[account(
        init_if_needed,
        payer = host,
        space = 8 + HostCapacity::INIT_SPACE,
        seeds = [HOST_SEED, host.key().as_ref()],
        bump
    )]
    pub host_capacity: Account<'info, HostCapacity>,
    #[account(
        init,
        payer = host,
        space = 8 + CapacityCommitment::INIT_SPACE,
        seeds = [COMMITMENT_SEED, host.key().as_ref(), &args.commitment_id.to_le_bytes()],
        bump
    )]
    pub commitment: Account<'info, CapacityCommitment>,
    /// CHECK: PDA that signs the lock CPI; `trellis_bond` checks it against `BondConfig.capacity_claimer`.
    #[account(seeds = [BOND_CLAIMER_SEED], bump)]
    pub bond_claimer: UncheckedAccount<'info>,
    /// CHECK: `trellis_bond`'s lock account for this bond (`["lock", host_bond]`); created by that program.
    #[account(
        mut,
        seeds = [trellis_bond::LOCK_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_lock: UncheckedAccount<'info>,
    /// CHECK: `trellis_bond`'s slash ledger for this bond (`["slash_ledger", host_bond]`); that program reads the
    /// claims still open against the bond from it.
    #[account(
        seeds = [trellis_bond::SLASH_LEDGER_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub slash_ledger: UncheckedAccount<'info>,
    pub bond_program: Program<'info, TrellisBond>,
    pub system_program: Program<'info, System>,
}

/// `commit_capacity(host, grade, tokens, window, bond)`: record a bond-backed commitment.
/// Issuance is capped by the bond: the summed value of the host's open commitments (at the
/// grade price of the moment, which the commitment then keeps) can never exceed `host_bond.amount`, and all open
/// commitments together stay under the global issuance cap. The commitment's value is locked in the bond (`trellis_bond::lock_bond`) until
/// the commitment is settled, so the bond cannot be withdrawn from under it. `lock_bond` itself refuses a lock the
/// bond does not cover on top of what is already locked and of every claim still open against it: a commitment whose
/// shortfall was reported keeps its lock until `release_commitment`, and its claims keep counting until each is paid
/// or dropped, so that headroom cannot be committed a second time (security re-review RR-07).
pub fn handle_commit_capacity(ctx: Context<CommitCapacity>, args: CommitCapacityArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    require!(!config.pause_active(now), CapacityError::Paused);
    require!((args.grade as usize) < GRADE_COUNT, CapacityError::InvalidGrade);
    require!(args.tokens > 0, CapacityError::ZeroTokens);
    require!(
        args.window_end > args.window_start && args.window_end > now,
        CapacityError::InvalidWindow
    );
    // Bounded windows: a commitment (and the bond lock behind it) cannot be held open for an arbitrary time.
    let length = args.window_end.checked_sub(args.window_start).ok_or(CapacityError::Overflow)?;
    let horizon = args.window_end.checked_sub(now).ok_or(CapacityError::Overflow)?;
    require!(
        length <= MAX_WINDOW_LENGTH && horizon <= MAX_WINDOW_HORIZON,
        CapacityError::WindowTooLong
    );

    let bond = &ctx.accounts.host_bond;
    require!(
        bond.is_active(ctx.accounts.bond_config.min_bond),
        CapacityError::BondInactive
    );

    let price = config.grade_prices[args.grade as usize];
    let value = tokens_value(args.tokens, price).ok_or(CapacityError::Overflow)?;

    let host_capacity = &mut ctx.accounts.host_capacity;
    if host_capacity.host == Pubkey::default() {
        host_capacity.host = ctx.accounts.host.key();
        host_capacity.bump = ctx.bumps.host_capacity;
    }
    let new_committed = host_capacity
        .committed_value
        .checked_add(value)
        .ok_or(CapacityError::Overflow)?;
    require!(new_committed <= bond.amount, CapacityError::ExceedsBondHeadroom);
    let new_outstanding = config
        .outstanding_value
        .checked_add(value)
        .ok_or(CapacityError::Overflow)?;
    // The configured cap, and never more than the compiled maximum (a config written before the maximum existed
    // cannot carry a higher one into use).
    require!(
        new_outstanding <= config.max_outstanding_value.min(MAX_OUTSTANDING_VALUE_CAP),
        CapacityError::ExceedsIssuanceCap
    );

    host_capacity.committed_value = new_committed;
    host_capacity.open_commitments = host_capacity
        .open_commitments
        .checked_add(1)
        .ok_or(CapacityError::Overflow)?;
    config.outstanding_value = new_outstanding;

    let c = &mut ctx.accounts.commitment;
    c.host = ctx.accounts.host.key();
    c.host_bond = bond.key();
    c.commitment_id = args.commitment_id;
    c.grade = args.grade;
    c.tokens = args.tokens;
    c.sold_tokens = 0;
    c.window_start = args.window_start;
    c.window_end = args.window_end;
    c.value = value;
    c.status = CommitmentStatus::Open;
    c.unserved_tokens = 0;
    c.lots_sold = 0;
    c.bump = ctx.bumps.commitment;
    // The price is fixed here for the life of the commitment: a later change of the grade price changes neither
    // `value` nor what a lot recorded against this commitment may say was paid (R3-16).
    c.price_per_bushel = price;
    c.paid_total = 0;
    c.claimed_value = 0;

    let seeds: &[&[u8]] = &[BOND_CLAIMER_SEED, &[ctx.bumps.bond_claimer]];
    trellis_bond::cpi::lock_bond(
        CpiContext::new_with_signer(
            ctx.accounts.bond_program.key(),
            trellis_bond::cpi::accounts::LockBond {
                capacity_claimer: ctx.accounts.bond_claimer.to_account_info(),
                payer: ctx.accounts.host.to_account_info(),
                config: ctx.accounts.bond_config.to_account_info(),
                bond: ctx.accounts.host_bond.to_account_info(),
                slash_ledger: ctx.accounts.slash_ledger.to_account_info(),
                bond_lock: ctx.accounts.bond_lock.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        value,
    )?;

    let c = &ctx.accounts.commitment;
    emit!(CapacityCommitted {
        commitment: c.key(),
        host: c.host,
        host_bond: c.host_bond,
        commitment_id: c.commitment_id,
        grade: c.grade,
        tokens: c.tokens,
        window_start: c.window_start,
        window_end: c.window_end,
        value,
    });
    Ok(())
}

/// The `trellis_bond` accounts every instruction that settles a commitment passes (spelled out in each accounts struct,
/// so the IDL stays flat): the claimer PDA that signs, the bond config, the host's bond, its lock and the bond program.
struct BondUnlock<'a, 'info> {
    bond_claimer: &'a UncheckedAccount<'info>,
    bond_config: &'a Account<'info, BondConfig>,
    host_bond: &'a Account<'info, HostBond>,
    bond_lock: &'a UncheckedAccount<'info>,
    bond_program: &'a Program<'info, TrellisBond>,
}

fn unlock(u: &BondUnlock, claimer_bump: u8, amount: u64) -> Result<()> {
    // A commitment made before bond locks existed has no lock account: there is nothing to release.
    if u.bond_lock.data_is_empty() {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[BOND_CLAIMER_SEED, &[claimer_bump]];
    trellis_bond::cpi::unlock_bond(
        CpiContext::new_with_signer(
            u.bond_program.key(),
            trellis_bond::cpi::accounts::UnlockBond {
                capacity_claimer: u.bond_claimer.to_account_info(),
                config: u.bond_config.to_account_info(),
                bond: u.host_bond.to_account_info(),
                bond_lock: u.bond_lock.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct ReportShortfall<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CapacityError::Unauthorized,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, commitment.host.as_ref(), &commitment.commitment_id.to_le_bytes()],
        bump = commitment.bump,
    )]
    pub commitment: Account<'info, CapacityCommitment>,
    #[account(
        mut,
        seeds = [HOST_SEED, commitment.host.as_ref()],
        bump = host_capacity.bump,
        constraint = host_capacity.host == commitment.host @ CapacityError::BondHostMismatch,
    )]
    pub host_capacity: Account<'info, HostCapacity>,
    /// CHECK: PDA that signs the unlock CPI.
    #[account(seeds = [BOND_CLAIMER_SEED], bump)]
    pub bond_claimer: UncheckedAccount<'info>,
    #[account(
        seeds = [trellis_bond::CONFIG_SEED],
        bump = bond_config.bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_config: Account<'info, BondConfig>,
    #[account(address = commitment.host_bond @ CapacityError::BondHostMismatch)]
    pub host_bond: Account<'info, HostBond>,
    /// CHECK: `trellis_bond`'s lock account for this bond. The address is pinned to the PDA here, so nobody can pass
    /// another (empty) account to settle a commitment without releasing its lock.
    #[account(
        mut,
        seeds = [trellis_bond::LOCK_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_lock: UncheckedAccount<'info>,
    pub bond_program: Program<'info, TrellisBond>,
}

/// After `window_end` the authority reports how many committed tokens went unserved.
/// `unserved_tokens == 0` settles the commitment outright and releases its bond lock. Either way the commitment's
/// value leaves this program's running totals (the host's `committed_value` and the global cap); the bond itself stays
/// locked for a reported shortfall, and `trellis_bond::lock_bond` is what refuses a new commitment against it. With a shortfall, each sold lot is
/// then either rehomed (`rehome_lot`) or claimed against the bond (`claim_lot_shortfall`) for
/// `price_paid * unserved / tokens` — never an index-derived amount — and the bond lock stays until
/// `release_commitment` (after `CLAIM_PERIOD`), so the bond is still there when the claims arrive.
pub fn handle_report_shortfall(ctx: Context<ReportShortfall>, unserved_tokens: u64) -> Result<()> {
    let c = &mut ctx.accounts.commitment;
    require!(c.status == CommitmentStatus::Open, CapacityError::CommitmentNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= c.window_end, CapacityError::WindowNotEnded);
    require!(unserved_tokens <= c.tokens, CapacityError::UnservedExceedsCommitted);

    c.unserved_tokens = unserved_tokens;
    c.status = if unserved_tokens == 0 {
        CommitmentStatus::Settled
    } else {
        CommitmentStatus::ShortfallReported
    };

    let hc = &mut ctx.accounts.host_capacity;
    hc.committed_value = hc.committed_value.saturating_sub(c.value);
    hc.open_commitments = hc.open_commitments.saturating_sub(1);
    let config = &mut ctx.accounts.config;
    config.outstanding_value = config.outstanding_value.saturating_sub(c.value);

    if c.status == CommitmentStatus::Settled {
        unlock(
            &BondUnlock {
                bond_claimer: &ctx.accounts.bond_claimer,
                bond_config: &ctx.accounts.bond_config,
                host_bond: &ctx.accounts.host_bond,
                bond_lock: &ctx.accounts.bond_lock,
                bond_program: &ctx.accounts.bond_program,
            },
            ctx.bumps.bond_claimer,
            c.value.saturating_sub(c.claimed_value),
        )?;
    }

    emit!(ShortfallReported {
        commitment: c.key(),
        host: c.host,
        tokens: c.tokens,
        unserved_tokens,
        settled: c.status == CommitmentStatus::Settled,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseCommitment<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, commitment.host.as_ref(), &commitment.commitment_id.to_le_bytes()],
        bump = commitment.bump,
    )]
    pub commitment: Account<'info, CapacityCommitment>,
    #[account(
        mut,
        seeds = [HOST_SEED, commitment.host.as_ref()],
        bump = host_capacity.bump,
        constraint = host_capacity.host == commitment.host @ CapacityError::BondHostMismatch,
    )]
    pub host_capacity: Account<'info, HostCapacity>,
    /// CHECK: PDA that signs the unlock CPI.
    #[account(seeds = [BOND_CLAIMER_SEED], bump)]
    pub bond_claimer: UncheckedAccount<'info>,
    #[account(
        seeds = [trellis_bond::CONFIG_SEED],
        bump = bond_config.bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_config: Account<'info, BondConfig>,
    #[account(address = commitment.host_bond @ CapacityError::BondHostMismatch)]
    pub host_bond: Account<'info, HostBond>,
    /// CHECK: `trellis_bond`'s lock account for this bond. The address is pinned to the PDA here, so nobody can pass
    /// another (empty) account to settle a commitment without releasing its lock.
    #[account(
        mut,
        seeds = [trellis_bond::LOCK_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_lock: UncheckedAccount<'info>,
    pub bond_program: Program<'info, TrellisBond>,
}

/// Anyone, once `window_end + CLAIM_PERIOD` has passed: settle the commitment and release its bond lock.
///
/// - A commitment with a reported shortfall: the authority has had the whole claim period to rehome or claim every lot;
///   lots not claimed by now can no longer be claimed against this bond. The lock released is the commitment's value
///   less what its claims already took out of it.
/// - A commitment the authority never reported on: it is treated as served (the host is not held hostage by an
///   authority that went silent), and its headroom is released as well.
pub fn handle_release_commitment(ctx: Context<ReleaseCommitment>) -> Result<()> {
    let c = &mut ctx.accounts.commitment;
    require!(c.status != CommitmentStatus::Settled, CapacityError::CommitmentSettled);
    let now = Clock::get()?.unix_timestamp;
    let release_at = c.window_end.checked_add(CLAIM_PERIOD).ok_or(CapacityError::Overflow)?;
    require!(now >= release_at, CapacityError::ClaimPeriodNotElapsed);

    if c.status == CommitmentStatus::Open {
        let hc = &mut ctx.accounts.host_capacity;
        hc.committed_value = hc.committed_value.saturating_sub(c.value);
        hc.open_commitments = hc.open_commitments.saturating_sub(1);
        let config = &mut ctx.accounts.config;
        config.outstanding_value = config.outstanding_value.saturating_sub(c.value);
    }
    c.status = CommitmentStatus::Settled;
    unlock(
            &BondUnlock {
                bond_claimer: &ctx.accounts.bond_claimer,
                bond_config: &ctx.accounts.bond_config,
                host_bond: &ctx.accounts.host_bond,
                bond_lock: &ctx.accounts.bond_lock,
                bond_program: &ctx.accounts.bond_program,
            },
            ctx.bumps.bond_claimer,
            // What the filed claims took out of the lock is no longer in it (`trellis_bond::file_capacity_claim`).
            c.value.saturating_sub(c.claimed_value),
        )?;

    emit!(CommitmentReleased {
        commitment: c.key(),
        host: c.host,
        value: c.value,
    });
    Ok(())
}
