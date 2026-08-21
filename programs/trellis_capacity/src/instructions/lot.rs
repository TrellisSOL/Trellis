use anchor_lang::prelude::*;
use trellis_bond::{program::TrellisBond, BondConfig, HostBond};

use crate::{errors::CapacityError, events::*, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BuyLotArgs {
    pub lot_id: u32,
    pub key_hash: [u8; 32],
    pub tokens: u64,
    pub price_paid: u64,
}

#[derive(Accounts)]
#[instruction(args: BuyLotArgs)]
pub struct BuyLot<'info> {
    #[account(mut)]
    pub sale_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = sale_authority @ CapacityError::NotSaleAuthority,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, commitment.host.as_ref(), &commitment.commitment_id.to_le_bytes()],
        bump = commitment.bump,
    )]
    pub commitment: Account<'info, CapacityCommitment>,
    #[account(
        init,
        payer = sale_authority,
        space = 8 + BushelLot::INIT_SPACE,
        seeds = [LOT_SEED, commitment.key().as_ref(), &args.lot_id.to_le_bytes()],
        bump
    )]
    pub lot: Account<'info, BushelLot>,
    pub system_program: Program<'info, System>,
}

/// `buy_lot(commitment, key_hash, tokens, price_paid)`: record a sale against an open
/// commitment. The lot is bound to `key_hash` for life; there is no transfer instruction.
/// `price_paid` is what the buyer paid in USDC off-chain. It is bounded three ways (security review round 3, R3-16):
/// by the lot's value at the price the commitment was made at (a grade price raised later raises nothing here), by its
/// value at today's grade price (a lowered price still caps a sale), and by the commitment itself: all lots recorded
/// against a commitment together never exceed its `value`, which is what the host locked for it.
pub fn handle_buy_lot(ctx: Context<BuyLot>, args: BuyLotArgs) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.pause_active(Clock::get()?.unix_timestamp), CapacityError::Paused);
    require!(args.tokens > 0, CapacityError::ZeroTokens);
    require!(args.key_hash != [0u8; 32], CapacityError::InvalidKeyHash);

    let c = &mut ctx.accounts.commitment;
    require!(c.status == CommitmentStatus::Open, CapacityError::CommitmentNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < c.window_end, CapacityError::WindowEnded);
    require_eq!(args.lot_id, c.lots_sold, CapacityError::LotIdMismatch);
    let new_sold = c
        .sold_tokens
        .checked_add(args.tokens)
        .ok_or(CapacityError::Overflow)?;
    require!(new_sold <= c.tokens, CapacityError::InsufficientCapacity);

    let list_price = tokens_value(args.tokens, config.grade_prices[c.grade as usize])
        .ok_or(CapacityError::Overflow)?;
    let committed_price = tokens_value(args.tokens, c.price_per_bushel).ok_or(CapacityError::Overflow)?;
    require!(
        args.price_paid > 0 && args.price_paid <= list_price.min(committed_price),
        CapacityError::InvalidPrice
    );
    let new_paid = c
        .paid_total
        .checked_add(args.price_paid)
        .ok_or(CapacityError::Overflow)?;
    require!(new_paid <= c.value, CapacityError::ExceedsCommitmentValue);

    c.paid_total = new_paid;
    c.sold_tokens = new_sold;
    c.lots_sold = c.lots_sold.checked_add(1).ok_or(CapacityError::Overflow)?;

    let lot = &mut ctx.accounts.lot;
    lot.commitment = c.key();
    lot.lot_id = args.lot_id;
    lot.key_hash = args.key_hash;
    lot.grade = c.grade;
    lot.tokens = args.tokens;
    lot.window_start = c.window_start;
    lot.window_end = c.window_end;
    lot.price_paid = args.price_paid;
    lot.redeemed = false;
    lot.redeemed_at = 0;
    lot.shortfall_claimed = false;
    lot.refund_amount = 0;
    lot.rehomed_to = None;
    lot.bump = ctx.bumps.lot;

    emit!(LotSold {
        lot: lot.key(),
        commitment: lot.commitment,
        lot_id: lot.lot_id,
        key_hash: lot.key_hash,
        grade: lot.grade,
        tokens: lot.tokens,
        window_start: lot.window_start,
        window_end: lot.window_end,
        price_paid: lot.price_paid,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RedeemLot<'info> {
    pub sale_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = sale_authority @ CapacityError::NotSaleAuthority,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        mut,
        seeds = [LOT_SEED, lot.commitment.as_ref(), &lot.lot_id.to_le_bytes()],
        bump = lot.bump,
    )]
    pub lot: Account<'info, BushelLot>,
}

/// Mark a lot redeemed. Inference credits of the lot's grade are issued off-chain to
/// `key_hash` against the `LotRedeemed` event. Redemption is the only exit for a lot.
pub fn handle_redeem_lot(ctx: Context<RedeemLot>) -> Result<()> {
    let lot = &mut ctx.accounts.lot;
    require!(!lot.redeemed, CapacityError::AlreadyRedeemed);
    let now = Clock::get()?.unix_timestamp;
    lot.redeemed = true;
    lot.redeemed_at = now;
    emit!(LotRedeemed {
        lot: lot.key(),
        commitment: lot.commitment,
        key_hash: lot.key_hash,
        grade: lot.grade,
        tokens: lot.tokens,
        redeemed_at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RehomeLot<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CapacityError::Unauthorized,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        seeds = [COMMITMENT_SEED, commitment.host.as_ref(), &commitment.commitment_id.to_le_bytes()],
        bump = commitment.bump,
    )]
    pub commitment: Account<'info, CapacityCommitment>,
    #[account(
        mut,
        seeds = [LOT_SEED, commitment.key().as_ref(), &lot.lot_id.to_le_bytes()],
        bump = lot.bump,
        has_one = commitment,
    )]
    pub lot: Account<'info, BushelLot>,
    /// Open commitment on another host, same grade, that will serve the unserved tokens.
    #[account(
        mut,
        seeds = [COMMITMENT_SEED, replacement.host.as_ref(), &replacement.commitment_id.to_le_bytes()],
        bump = replacement.bump,
    )]
    pub replacement: Account<'info, CapacityCommitment>,
}

/// Honour the unserved part of a lot on another host of the same grade. The replacement
/// commitment's unsold capacity is consumed; no money moves and no bond claim is filed.
pub fn handle_rehome_lot(ctx: Context<RehomeLot>) -> Result<()> {
    let c = &ctx.accounts.commitment;
    require!(
        c.status == CommitmentStatus::ShortfallReported,
        CapacityError::NoShortfall
    );
    let lot = &ctx.accounts.lot;
    require!(
        !lot.shortfall_claimed && lot.rehomed_to.is_none(),
        CapacityError::LotAlreadyHandled
    );
    let r = &ctx.accounts.replacement;
    require!(
        r.key() != c.key() && r.grade == c.grade && r.status == CommitmentStatus::Open,
        CapacityError::InvalidReplacement
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < r.window_end, CapacityError::WindowEnded);

    let unserved = pro_rata(lot.tokens, c.unserved_tokens, c.tokens).ok_or(CapacityError::Overflow)?;
    require!(unserved > 0, CapacityError::NothingToClaim);
    let new_sold = r.sold_tokens.checked_add(unserved).ok_or(CapacityError::Overflow)?;
    require!(new_sold <= r.tokens, CapacityError::InsufficientCapacity);

    let r = &mut ctx.accounts.replacement;
    r.sold_tokens = new_sold;
    let lot = &mut ctx.accounts.lot;
    lot.rehomed_to = Some(r.key());
    emit!(LotRehomed {
        lot: lot.key(),
        from_commitment: lot.commitment,
        to_commitment: r.key(),
        tokens_rehomed: unserved,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ClaimLotShortfall<'info> {
    /// Pays the rent of the bond proposal.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
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
        seeds = [LOT_SEED, commitment.key().as_ref(), &lot.lot_id.to_le_bytes()],
        bump = lot.bump,
        has_one = commitment,
    )]
    pub lot: Account<'info, BushelLot>,
    /// CHECK: PDA that signs the CPI; `trellis_bond` checks it against `BondConfig.capacity_claimer`.
    #[account(seeds = [BOND_CLAIMER_SEED], bump)]
    pub bond_claimer: UncheckedAccount<'info>,
    #[account(
        seeds = [trellis_bond::CONFIG_SEED],
        bump = bond_config.bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_config: Account<'info, BondConfig>,
    #[account(
        mut,
        address = commitment.host_bond @ CapacityError::BondHostMismatch,
    )]
    pub host_bond: Account<'info, HostBond>,
    /// CHECK: created by `trellis_bond` at `["proposal", host_bond, proposal_id]`.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: `trellis_bond`'s slash ledger for this bond; that program creates it if needed and counts the claim as
    /// pending against the bond's headroom.
    #[account(
        mut,
        seeds = [trellis_bond::SLASH_LEDGER_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub slash_ledger: UncheckedAccount<'info>,
    /// CHECK: `trellis_bond`'s lock account for this bond (`["lock", host_bond]`); that program takes the claim's
    /// amount out of it and refuses a claim larger than what is locked.
    #[account(
        mut,
        seeds = [trellis_bond::LOCK_SEED, host_bond.key().as_ref()],
        bump,
        seeds::program = trellis_bond::ID,
    )]
    pub bond_lock: UncheckedAccount<'info>,
    pub bond_program: Program<'info, TrellisBond>,
    pub system_program: Program<'info, System>,
}

/// File the lot's shortfall claim against the host's bond:
/// `refund = price_paid * unserved_tokens / committed_tokens` (what the buyer paid for the
/// unserved share — never an HVX or any other index price). `trellis_bond` opens a
/// `CapacityShortfall` proposal with the usual dispute window; on execution the amount is paid
/// to the capacity refund account and returned to the buyer off-chain by settlement.
///
/// Bounded twice (security review round 3, R3-16): the claims of one commitment never sum to more than the
/// commitment's `value` (checked here), and `trellis_bond` takes each claim out of the bond lock and refuses one larger
/// than what is locked. So a host can lose to shortfall claims at most what it locked for the commitment that fell
/// short, whatever the grade prices are today and whatever the lots say.
pub fn handle_claim_lot_shortfall(
    ctx: Context<ClaimLotShortfall>,
    proposal_id: u64,
    evidence_hash: [u8; 32],
) -> Result<()> {
    let c = &ctx.accounts.commitment;
    require!(
        c.status == CommitmentStatus::ShortfallReported,
        CapacityError::NoShortfall
    );
    let lot = &ctx.accounts.lot;
    require!(
        !lot.shortfall_claimed && lot.rehomed_to.is_none(),
        CapacityError::LotAlreadyHandled
    );
    let refund = pro_rata(lot.price_paid, c.unserved_tokens, c.tokens).ok_or(CapacityError::Overflow)?;
    require!(refund > 0, CapacityError::NothingToClaim);
    let new_claimed = c.claimed_value.checked_add(refund).ok_or(CapacityError::Overflow)?;
    require!(new_claimed <= c.value, CapacityError::ClaimExceedsCommitment);

    let bump = ctx.bumps.bond_claimer;
    let seeds: &[&[u8]] = &[BOND_CLAIMER_SEED, &[bump]];
    trellis_bond::cpi::file_capacity_claim(
        CpiContext::new_with_signer(
            ctx.accounts.bond_program.key(),
            trellis_bond::cpi::accounts::FileCapacityClaim {
                capacity_claimer: ctx.accounts.bond_claimer.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                config: ctx.accounts.bond_config.to_account_info(),
                bond: ctx.accounts.host_bond.to_account_info(),
                proposal: ctx.accounts.proposal.to_account_info(),
                slash_ledger: ctx.accounts.slash_ledger.to_account_info(),
                bond_lock: ctx.accounts.bond_lock.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        proposal_id,
        evidence_hash,
        refund,
    )?;

    ctx.accounts.commitment.claimed_value = new_claimed;

    let lot = &mut ctx.accounts.lot;
    lot.shortfall_claimed = true;
    lot.refund_amount = refund;
    emit!(LotShortfallClaimed {
        lot: lot.key(),
        commitment: lot.commitment,
        host_bond: ctx.accounts.host_bond.key(),
        proposal: ctx.accounts.proposal.key(),
        key_hash: lot.key_hash,
        refund_amount: refund,
    });
    Ok(())
}
