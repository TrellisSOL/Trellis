use anchor_lang::prelude::*;

use crate::{errors::CapacityError, events::*, state::*};

const SECONDS_PER_HOUR: i64 = 3600;

#[derive(Accounts)]
#[instruction(grade: u8)]
pub struct PublishHvx<'info> {
    #[account(mut)]
    pub hvx_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = hvx_authority @ CapacityError::NotHvxAuthority,
    )]
    pub config: Account<'info, CapacityConfig>,
    #[account(
        init_if_needed,
        payer = hvx_authority,
        space = 8 + HvxFeed::INIT_SPACE,
        seeds = [HVX_SEED, &[grade]],
        bump
    )]
    pub feed: Account<'info, HvxFeed>,
    pub system_program: Program<'info, System>,
}

/// Publish the hourly HVX value for a grade. `hour` is the unix hour (unix seconds / 3600): not below the hour the feed
/// holds, and not ahead of the chain clock's current hour.
///
/// HVX is a public statistic built off-chain from wash-filtered receipts. NOTHING SETTLES
/// AGAINST IT: no instruction in this program or in `trellis_bond` reads `HvxFeed`; Bushel
/// prices come from `CapacityConfig.grade_prices` and refunds from `BushelLot.price_paid`.
pub fn handle_publish_hvx(
    ctx: Context<PublishHvx>,
    grade: u8,
    hour: i64,
    usd_per_mtoken: u64,
    thin: bool,
) -> Result<()> {
    require!((grade as usize) < GRADE_COUNT, CapacityError::InvalidGrade);
    // Hours never go back, so an hour ahead of the clock would shut out every honest publication until the clock
    // caught up with it: one bad publish (or one use of a stolen HVX key) froze the grade's feed, for good if the hour
    // was far enough away (security review round 3, R3-27). The hour in progress is the latest accepted, as for
    // receipt roots.
    let now = Clock::get()?.unix_timestamp;
    require!(hour <= now.div_euclid(SECONDS_PER_HOUR), CapacityError::HvxHourInFuture);
    let feed = &mut ctx.accounts.feed;
    if feed.updated_at != 0 {
        require!(hour >= feed.hour, CapacityError::HvxHourNotMonotonic);
    }
    feed.grade = grade;
    feed.hour = hour;
    feed.usd_per_mtoken = usd_per_mtoken;
    feed.thin = thin;
    feed.updated_at = now;
    feed.bump = ctx.bumps.feed;
    emit!(HvxPublished {
        grade,
        hour,
        usd_per_mtoken,
        thin,
    });
    Ok(())
}
