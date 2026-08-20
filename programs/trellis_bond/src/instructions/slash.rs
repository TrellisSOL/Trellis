use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{errors::BondError, events::*, state::*};

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(BondError::Overflow)?
        / BPS_DENOMINATOR as u128;
    u64::try_from(v).map_err(|_| BondError::Overflow.into())
}

fn init_proposal(
    proposal: &mut SlashProposal,
    bond: &mut HostBond,
    config: &BondConfig,
    bond_key: Pubkey,
    proposal_id: u64,
    evidence_hash: [u8; 32],
    reason: SlashReason,
    bps: u16,
    fixed_amount: u64,
    refund_amount: u64,
    rent_payer: Pubkey,
    bump: u8,
) -> Result<i64> {
    require_eq!(proposal_id, bond.next_proposal_id, BondError::ConfigAccountMismatch);
    let now = Clock::get()?.unix_timestamp;
    let window_end = now
        .checked_add(config.dispute_window)
        .ok_or(BondError::Overflow)?;

    proposal.bond = bond_key;
    proposal.proposal_id = proposal_id;
    proposal.evidence_hash = evidence_hash;
    proposal.reason = reason;
    proposal.bps = bps;
    proposal.fixed_amount = fixed_amount;
    proposal.refund_amount = refund_amount;
    proposal.proposed_at = now;
    proposal.window_end = window_end;
    proposal.dispute_status = DisputeStatus::None;
    proposal.disputed_at = 0;
    proposal.executed = false;
    proposal.executed_amount = 0;
    proposal.rent_payer = rent_payer;
    proposal.bump = bump;
    proposal.unblock_at = 0;

    bond.open_proposals = bond.open_proposals.checked_add(1).ok_or(BondError::Overflow)?;
    bond.next_proposal_id = bond.next_proposal_id.checked_add(1).ok_or(BondError::Overflow)?;
    Ok(window_end)
}

fn init_ledger(ledger: &mut SlashLedger, bond: Pubkey, bump: u8) {
    if ledger.bond == Pubkey::default() {
        ledger.bond = bond;
        ledger.bump = bump;
    }
}

/// A capacity claim that will not execute any more stops counting against the bond's headroom.
fn release_pending_claim(ledger: &mut SlashLedger, proposal: &SlashProposal) {
    if proposal.reason == SlashReason::CapacityShortfall {
        ledger.pending_claims = ledger.pending_claims.saturating_sub(proposal.fixed_amount);
    }
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ProposeSlash<'info> {
    /// The slasher authority (the `slasher` service key; production sits behind the Squads multisig).
    #[account(mut)]
    pub slasher: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = slasher @ BondError::NotSlasher,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        init,
        payer = slasher,
        space = 8 + SlashProposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, SlashProposal>,
    /// The bond's slash ledger; created with its first proposal (`init_if_needed`: it is never closed).
    #[account(
        init_if_needed,
        payer = slasher,
        space = 8 + SlashLedger::INIT_SPACE,
        seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()],
        bump
    )]
    pub slash_ledger: Account<'info, SlashLedger>,
    pub system_program: Program<'info, System>,
}

/// Open a rate-based slash proposal. `bps` must match the schedule for `reason_code`
/// (exact for fixed-rate reasons, a positive multiple of the unit for per-day / per-incident
/// reasons). `refund_amount` is the portion earmarked for affected callers; it is paid to
/// `refund_pool` first and the remainder goes to treasury. A 72h public dispute window opens.
pub fn handle_propose_slash(
    ctx: Context<ProposeSlash>,
    proposal_id: u64,
    evidence_hash: [u8; 32],
    bps: u16,
    reason_code: u8,
    refund_amount: u64,
) -> Result<()> {
    let reason = SlashReason::from_code(reason_code).ok_or(BondError::UnknownReasonCode)?;
    let (unit_bps, per_unit) = reason.schedule().ok_or(BondError::UseCapacityClaim)?;
    require!(bps > 0 && bps as u64 <= BPS_DENOMINATOR, BondError::BpsTooLarge);
    // Whatever the reason and however many days or incidents are counted, one proposal carries at most 50%.
    require!(bps <= MAX_SLASH_BPS_PER_PROPOSAL, BondError::SlashBpsAboveProposalMax);
    if per_unit {
        require!(bps % unit_bps == 0, BondError::InvalidSlashBps);
    } else {
        require_eq!(bps, unit_bps, BondError::InvalidSlashBps);
    }
    // The refund share can never exceed what the slash could yield today.
    let max_slash = mul_bps(ctx.accounts.bond.amount, bps)?;
    require!(refund_amount <= max_slash, BondError::RefundExceedsSlash);

    let bond_key = ctx.accounts.bond.key();
    init_ledger(&mut ctx.accounts.slash_ledger, bond_key, ctx.bumps.slash_ledger);
    let window_end = init_proposal(
        &mut ctx.accounts.proposal,
        &mut ctx.accounts.bond,
        &ctx.accounts.config,
        bond_key,
        proposal_id,
        evidence_hash,
        reason,
        bps,
        0,
        refund_amount,
        ctx.accounts.slasher.key(),
        ctx.bumps.proposal,
    )?;

    emit!(SlashProposed {
        bond: bond_key,
        proposal: ctx.accounts.proposal.key(),
        proposal_id,
        reason,
        bps,
        fixed_amount: 0,
        refund_amount,
        evidence_hash,
        window_end,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct FileCapacityClaim<'info> {
    /// `trellis_capacity`'s claimer PDA; only reachable via CPI from that program.
    pub capacity_claimer: Signer<'info>,
    /// Pays the proposal rent (the capacity authority that reported the shortfall).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = capacity_claimer @ BondError::NotCapacityClaimer,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        init,
        payer = payer,
        space = 8 + SlashProposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, SlashProposal>,
    /// The bond's slash ledger; created with its first proposal (`init_if_needed`: it is never closed).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SlashLedger::INIT_SPACE,
        seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()],
        bump
    )]
    pub slash_ledger: Account<'info, SlashLedger>,
    /// What the host locked behind its commitments. The claim is paid for out of it, so the account must exist: a bond
    /// that never locked anything cannot be claimed against.
    #[account(mut, seeds = [LOCK_SEED, bond.key().as_ref()], bump = bond_lock.bump)]
    pub bond_lock: Account<'info, BondLock>,
    pub system_program: Program<'info, System>,
}

/// Record a capacity-shortfall claim: the exact purchase price of unserved Bushels
/// (computed by `trellis_capacity`, never from any index price). Follows the same dispute
/// window as every other slash; on execution the amount is paid to `capacity_refund`.
///
/// The claim's amount is taken out of `BondLock.locked` and becomes a pending claim. A claim larger than what is still
/// locked is refused: whatever `trellis_capacity` asks for, all claims against a bond together never exceed what the
/// host locked behind its own commitments (security review round 3, R3-16). A claim that is later rejected or voided
/// frees its amount for the host; it does not go back into the lock.
pub fn handle_file_capacity_claim(
    ctx: Context<FileCapacityClaim>,
    proposal_id: u64,
    evidence_hash: [u8; 32],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, BondError::ZeroAmount);
    let bond_key = ctx.accounts.bond.key();
    init_ledger(&mut ctx.accounts.slash_ledger, bond_key, ctx.bumps.slash_ledger);
    let lock = &mut ctx.accounts.bond_lock;
    require!(amount <= lock.locked, BondError::ClaimExceedsLocked);
    lock.locked = lock.locked.checked_sub(amount).ok_or(BondError::Overflow)?;
    emit!(BondLockChanged { bond: bond_key, locked: lock.locked });
    // Counted against the bond's headroom until this claim is executed or dropped (`lock_bond`).
    let ledger = &mut ctx.accounts.slash_ledger;
    ledger.pending_claims = ledger.pending_claims.checked_add(amount).ok_or(BondError::Overflow)?;
    let window_end = init_proposal(
        &mut ctx.accounts.proposal,
        &mut ctx.accounts.bond,
        &ctx.accounts.config,
        bond_key,
        proposal_id,
        evidence_hash,
        SlashReason::CapacityShortfall,
        0,
        amount,
        0,
        ctx.accounts.payer.key(),
        ctx.bumps.proposal,
    )?;
    emit!(SlashProposed {
        bond: bond_key,
        proposal: ctx.accounts.proposal.key(),
        proposal_id,
        reason: SlashReason::CapacityShortfall,
        bps: 0,
        fixed_amount: amount,
        refund_amount: 0,
        evidence_hash,
        window_end,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Dispute<'info> {
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
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        has_one = bond,
    )]
    pub proposal: Account<'info, SlashProposal>,
}

/// The host disputes a proposal inside the window. Execution is then blocked until the
/// authority resolves the dispute or `dispute_block` (7 days) passes, whichever is first. The moment the block ends is
/// fixed here (`unblock_at`): raising `dispute_block` afterwards does not keep this bond blocked any longer.
pub fn handle_dispute(ctx: Context<Dispute>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    require!(!proposal.executed, BondError::AlreadyExecuted);
    require!(
        proposal.dispute_status == DisputeStatus::None,
        BondError::AlreadyDisputed
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < proposal.window_end, BondError::DisputeWindowClosed);
    proposal.dispute_status = DisputeStatus::Open;
    proposal.disputed_at = now;
    proposal.unblock_at = now
        .checked_add(ctx.accounts.config.dispute_block)
        .ok_or(BondError::Overflow)?;
    emit!(SlashDisputed {
        bond: proposal.bond,
        proposal: proposal.key(),
        disputed_at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BondError::Unauthorized,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        has_one = bond,
    )]
    pub proposal: Account<'info, SlashProposal>,
    #[account(mut, seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()], bump = slash_ledger.bump)]
    pub slash_ledger: Account<'info, SlashLedger>,
}

/// Authority (Squads 2-of-3) resolves an open dispute. `upheld = false` rejects the slash for good.
pub fn handle_resolve_dispute(ctx: Context<ResolveDispute>, upheld: bool) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    require!(!proposal.executed, BondError::AlreadyExecuted);
    require!(
        proposal.dispute_status == DisputeStatus::Open,
        BondError::NotDisputed
    );
    proposal.dispute_status = if upheld {
        DisputeStatus::Upheld
    } else {
        let bond = &mut ctx.accounts.bond;
        bond.open_proposals = bond.open_proposals.saturating_sub(1);
        release_pending_claim(&mut ctx.accounts.slash_ledger, proposal);
        DisputeStatus::Rejected
    };
    emit!(DisputeResolved {
        bond: proposal.bond,
        proposal: proposal.key(),
        status: proposal.dispute_status,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteSlash<'info> {
    /// Anyone may crank execution once the proposal is executable; funds only ever move
    /// to the configured payout accounts. Pays the slash ledger's rent if the bond has none yet.
    /// One exception: a rate-based slash that the cumulative cap would cut today is executed by the slasher only
    /// (`CapCutNeedsSlasher`), so the host cannot crank its own proposal at a moment when it takes nothing.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        has_one = bond,
    )]
    pub proposal: Account<'info, SlashProposal>,
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
    // The three payout accounts are pinned to the config by address and are NOT deserialised here: only the one(s)
    // that receive something are touched, by the token program. A payout account that was closed or frozen therefore
    // blocks only the slashes that pay into it, not every proposal of every bond (security re-review RR-13).
    /// CHECK: address pinned to `config.refund_pool`.
    #[account(mut, address = config.refund_pool @ BondError::ConfigAccountMismatch)]
    pub refund_pool: UncheckedAccount<'info>,
    /// CHECK: address pinned to `config.treasury`.
    #[account(mut, address = config.treasury @ BondError::ConfigAccountMismatch)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: address pinned to `config.capacity_refund`.
    #[account(mut, address = config.capacity_refund @ BondError::ConfigAccountMismatch)]
    pub capacity_refund: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = cranker,
        space = 8 + SlashLedger::INIT_SPACE,
        seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()],
        bump
    )]
    pub slash_ledger: Account<'info, SlashLedger>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_execute_slash(ctx: Context<ExecuteSlash>) -> Result<()> {
    let config = &ctx.accounts.config;
    let proposal = &ctx.accounts.proposal;
    let bond = &ctx.accounts.bond;
    require!(!proposal.executed, BondError::AlreadyExecuted);
    require!(
        proposal.dispute_status != DisputeStatus::Rejected,
        BondError::ProposalRejected
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= proposal.window_end, BondError::DisputeWindowOpen);
    if proposal.dispute_status == DisputeStatus::Open {
        // Fixed when the host disputed. (A proposal from before `unblock_at` existed falls back to the config.)
        let unblock_at = if proposal.unblock_at != 0 {
            proposal.unblock_at
        } else {
            proposal
                .disputed_at
                .checked_add(config.dispute_block)
                .ok_or(BondError::Overflow)?
        };
        require!(now >= unblock_at, BondError::DisputeBlocksExecution);
    }

    let bond_key = bond.key();
    init_ledger(&mut ctx.accounts.slash_ledger, bond_key, ctx.bumps.slash_ledger);
    let ledger = &mut ctx.accounts.slash_ledger;
    ledger.roll(now);

    // Compute the slash against the bond as it stands today, never more than is bonded. A rate-based slash is further
    // cut to what the cumulative cap leaves: with everything slashed in this fixed window and the one before, it may
    // take at most `MAX_SLASH_BPS_PER_WINDOW` of the bond as it stood before those slashes. What the cap cuts off is
    // forgone, not deferred: the proposal counts as executed.
    //
    // Two consequences of a cut are closed here (security review round 3, R3-26):
    // - only the slasher may execute a proposal the cap would cut. Anyone else (the host, first of all) could crank it
    //   at the moment it takes least, or nothing, and have the rest forgone; the slasher can wait until the earlier
    //   slashes have aged out of the cap (two windows at most), after which anyone may execute it in full, or the
    //   authority can void it;
    // - a slash cut to ZERO neither delists nor ejects: a penalty that took nothing leaves no permanent mark.
    let mut cut_to_zero = false;
    let amount = match proposal.reason.schedule() {
        Some(_) => {
            let uncapped = mul_bps(bond.amount, proposal.bps)?
                .min(bond.amount)
                .min(ctx.accounts.vault.amount);
            let capped = uncapped.min(ledger.room(bond.amount));
            if capped < uncapped {
                require_keys_eq!(ctx.accounts.cranker.key(), config.slasher, BondError::CapCutNeedsSlasher);
                cut_to_zero = capped == 0;
            }
            ledger.slashed_current = ledger.slashed_current.checked_add(capped).ok_or(BondError::Overflow)?;
            capped
        }
        // A capacity claim pays at most its filed amount, which `file_capacity_claim` took out of the bond lock, and
        // never more than the claims still recorded as pending against this bond.
        None => proposal
            .fixed_amount
            .min(bond.amount)
            .min(ctx.accounts.vault.amount)
            .min(ledger.pending_claims),
    };
    release_pending_claim(ledger, proposal);

    let (to_capacity, to_refund, to_treasury) = if proposal.reason == SlashReason::CapacityShortfall {
        (amount, 0u64, 0u64)
    } else {
        let refund = proposal.refund_amount.min(amount);
        (0u64, refund, amount - refund)
    };

    let host_key = bond.host;
    let bump = bond.bump;
    let seeds: &[&[u8]] = &[BOND_SEED, host_key.as_ref(), &[bump]];
    let payouts = [
        (ctx.accounts.capacity_refund.to_account_info(), to_capacity),
        (ctx.accounts.refund_pool.to_account_info(), to_refund),
        (ctx.accounts.treasury.to_account_info(), to_treasury),
    ];
    for (to, value) in payouts {
        if value == 0 {
            continue;
        }
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.bond.to_account_info(),
                },
                &[seeds],
            ),
            value,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    let reason = proposal.reason;
    let bond = &mut ctx.accounts.bond;
    bond.amount = bond.amount.checked_sub(amount).ok_or(BondError::Overflow)?;
    bond.slashed_total = bond.slashed_total.checked_add(amount).ok_or(BondError::Overflow)?;
    bond.strikes = bond.strikes.checked_add(1).ok_or(BondError::Overflow)?;
    bond.open_proposals = bond.open_proposals.saturating_sub(1);
    if !cut_to_zero {
        if reason.delists() {
            bond.delisted = true;
        }
        if reason.ejects() {
            bond.ejected = true;
        }
    }

    let proposal = &mut ctx.accounts.proposal;
    proposal.executed = true;
    proposal.executed_amount = amount;

    emit!(SlashExecuted {
        bond: bond.key(),
        proposal: proposal.key(),
        reason,
        amount,
        to_refund_pool: to_refund,
        to_treasury,
        to_capacity_refund: to_capacity,
        strikes: bond.strikes,
        remaining_bond: bond.amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseProposal<'info> {
    /// The account that paid the proposal's rent, and only it: a proposal closed by a stranger right after execution
    /// would erase the record refunds are settled against (`executed_amount`).
    #[account(mut)]
    pub rent_payer: Signer<'info>,
    #[account(seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        has_one = bond,
        has_one = rent_payer @ BondError::NotRentPayer,
    )]
    pub proposal: Account<'info, SlashProposal>,
}

#[derive(Accounts)]
pub struct VoidProposal<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BondError::Unauthorized,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, bond.key().as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        has_one = bond,
    )]
    pub proposal: Account<'info, SlashProposal>,
    #[account(mut, seeds = [SLASH_LEDGER_SEED, bond.key().as_ref()], bump = slash_ledger.bump)]
    pub slash_ledger: Account<'info, SlashLedger>,
}

/// The authority drops a proposal that has not executed, whether or not the host disputed it: the slash can never
/// happen and the bond stops counting it as open. Without this, a proposal that cannot execute (its payout account is
/// gone, say) kept the bond unwithdrawable until the config was repaired (security re-review RR-13). Voiding only ever
/// favours the host.
pub fn handle_void_proposal(ctx: Context<VoidProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    require!(!proposal.executed, BondError::AlreadyExecuted);
    require!(
        proposal.dispute_status != DisputeStatus::Rejected,
        BondError::ProposalRejected
    );
    proposal.dispute_status = DisputeStatus::Rejected;
    let bond = &mut ctx.accounts.bond;
    bond.open_proposals = bond.open_proposals.saturating_sub(1);
    release_pending_claim(&mut ctx.accounts.slash_ledger, proposal);
    emit!(DisputeResolved {
        bond: proposal.bond,
        proposal: proposal.key(),
        status: proposal.dispute_status,
    });
    Ok(())
}

/// Reclaim rent for a proposal that is executed or rejected. The event history remains.
pub fn handle_close_proposal(ctx: Context<CloseProposal>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    require!(!proposal.is_open(), BondError::ProposalNotClosable);
    emit!(ProposalClosed {
        bond: proposal.bond,
        proposal: proposal.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeReinstate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BondError::Unauthorized,
    )]
    pub config: Account<'info, BondConfig>,
    #[account(seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingReinstate::INIT_SPACE,
        seeds = [PENDING_REINSTATE_SEED, bond.key().as_ref()],
        bump
    )]
    pub pending_reinstate: Account<'info, PendingReinstate>,
    pub system_program: Program<'info, System>,
}

/// The authority proposes to clear `delisted` and `ejected` on a bond. Nothing changes yet: the proposal sits in a
/// public account for `CONFIG_TIMELOCK` (24h) and is announced by `ReinstateProposed`. Before round 3 nothing cleared
/// the two flags at all (R3-26).
pub fn handle_propose_reinstate(ctx: Context<ProposeReinstate>) -> Result<()> {
    let bond = &ctx.accounts.bond;
    require!(bond.delisted || bond.ejected, BondError::NotDelisted);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_reinstate;
    pending.bond = bond.key();
    pending.strikes = bond.strikes;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(BondError::Overflow)?;
    pending.bump = ctx.bumps.pending_reinstate;
    emit!(ReinstateProposed {
        bond: pending.bond,
        host: bond.host,
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveReinstate<'info> {
    /// Applying or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BondConfig>,
    /// CHECK: the config authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = config.authority @ BondError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [BOND_SEED, bond.host.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, HostBond>,
    #[account(
        mut,
        close = authority,
        seeds = [PENDING_REINSTATE_SEED, bond.key().as_ref()],
        bump = pending_reinstate.bump,
        has_one = bond,
    )]
    pub pending_reinstate: Account<'info, PendingReinstate>,
}

/// `apply = true`: the authority clears `delisted` and `ejected` once `CONFIG_TIMELOCK` has elapsed and before the
/// proposal expires (`PROPOSAL_TTL` later), provided no slash was executed against the bond in between. The strikes and
/// the slashed total stay as the record of what happened. `apply = false`: the authority drops the proposal; once it
/// has expired anyone may. Neither the slasher nor the guardian nor the host resolves it.
pub fn handle_resolve_reinstate(ctx: Context<ResolveReinstate>, apply: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let config = &ctx.accounts.config;
    let pending = &ctx.accounts.pending_reinstate;
    let now = Clock::get()?.unix_timestamp;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    let bond = &mut ctx.accounts.bond;
    if !apply {
        require!(signer == config.authority || expired, BondError::Unauthorized);
        emit!(ReinstateResolved { bond: bond.key(), host: bond.host, applied: false, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, config.authority, BondError::Unauthorized);
    require!(now >= pending.effective_at, BondError::TimelockNotElapsed);
    require!(!expired, BondError::ProposalExpired);
    require!(bond.strikes == pending.strikes, BondError::ReinstateStale);
    bond.delisted = false;
    bond.ejected = false;
    emit!(ReinstateResolved { bond: bond.key(), host: bond.host, applied: true, by: signer });
    Ok(())
}
