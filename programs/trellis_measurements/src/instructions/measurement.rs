use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::MeasurementError,
    events::{
        MeasurementProposalCancelled, MeasurementProposed, MeasurementRegistered, MeasurementReinstated,
        MeasurementRevoked,
    },
    state::{Measurement, PendingMeasurement, Registry},
};

// The allow-list changes in two ways.
//
// Adding to it is loosening: a registered digest is something a Graft host may run, and a reinstated one is something
// that was withdrawn for a reason. Both go through a proposal: `propose_measurement` / `propose_reinstate` -> wait
// `CONFIG_TIMELOCK` (24h) -> `register` / `reinstate`. A proposal expires `PROPOSAL_TTL` (7 days) after it became
// applicable and only the authority cancels it. Proposals are per entry, so the digests of one release wait side by
// side. Both steps emit an event, so a digest nobody expected shows up a day before any host can run it.
//
// Taking an entry off is tightening and immediate (`revoke`): a bad digest is withdrawn in one transaction.
// Before round 3, `register` and `reinstate` were immediate as well (re-review RR-09, reversed in round 3).

fn propose(
    pending: &mut PendingMeasurement,
    kind: u8,
    digest: [u8; 32],
    label: String,
    policy_version: u32,
    reinstate: bool,
    bump: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    pending.kind = kind;
    pending.digest = digest;
    pending.label = label.clone();
    pending.policy_version = policy_version;
    pending.reinstate = reinstate;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(MeasurementError::Overflow)?;
    pending.bump = bump;
    emit!(MeasurementProposed {
        kind,
        digest,
        label,
        policy_version,
        reinstate,
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
    });
    Ok(())
}

/// The proposal can be applied now: the timelock has elapsed and it has not expired.
fn require_applicable(pending: &PendingMeasurement, reinstate: bool) -> Result<i64> {
    require!(pending.reinstate == reinstate, MeasurementError::WrongProposalKind);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= pending.effective_at, MeasurementError::TimelockNotElapsed);
    require!(
        now <= pending.effective_at.saturating_add(PROPOSAL_TTL),
        MeasurementError::ProposalExpired
    );
    Ok(now)
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct ProposeMeasurement<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    /// CHECK: the entry's address; it must not exist yet (an existing entry, live or revoked, is never registered
    /// again: see `propose_reinstate`).
    #[account(seeds = [MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()], bump)]
    pub measurement: UncheckedAccount<'info>,
    /// One proposal per kind and digest: a second one fails at `init` while the first is pending.
    #[account(
        init,
        payer = authority,
        space = 8 + PendingMeasurement::INIT_SPACE,
        seeds = [PENDING_MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump
    )]
    pub pending_measurement: Account<'info, PendingMeasurement>,
    pub system_program: Program<'info, System>,
}

/// Step 1 of a registration: announce `(kind, digest)` with its label and policy version. The allow-list does not
/// change: there is no `Measurement` account until `register` creates it after the timelock.
pub fn handle_propose_measurement(
    ctx: Context<ProposeMeasurement>,
    kind: u8,
    digest: [u8; 32],
    label: String,
    policy_version: u32,
) -> Result<()> {
    require!(kind < KIND_COUNT, MeasurementError::InvalidKind);
    require!(digest != [0u8; 32], MeasurementError::InvalidDigest);
    require!(label.len() <= MAX_LABEL_LEN as usize, MeasurementError::LabelTooLong);
    let entry = &ctx.accounts.measurement;
    require!(
        entry.data_is_empty() && entry.owner == &anchor_lang::system_program::ID,
        MeasurementError::AlreadyRegistered
    );
    propose(
        &mut ctx.accounts.pending_measurement,
        kind,
        digest,
        label,
        policy_version,
        false,
        ctx.bumps.pending_measurement,
    )
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct Register<'info> {
    /// Pays the entry's rent and gets the proposal's rent back.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        close = authority,
        seeds = [PENDING_MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = pending_measurement.bump,
    )]
    pub pending_measurement: Account<'info, PendingMeasurement>,
    /// One account per kind and digest. A second `register` for the same pair fails at `init`
    /// (account already in use), also when the entry is revoked: see `reinstate`.
    #[account(
        init,
        payer = authority,
        space = 8 + Measurement::INIT_SPACE,
        seeds = [MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump
    )]
    pub measurement: Account<'info, Measurement>,
    pub system_program: Program<'info, System>,
}

/// Step 2 of a registration: once `CONFIG_TIMELOCK` has elapsed (and before the proposal expires) the authority puts
/// the proposed entry on the allow-list, with the label and policy version that were announced.
pub fn handle_register(ctx: Context<Register>, kind: u8, digest: [u8; 32]) -> Result<()> {
    let pending = &ctx.accounts.pending_measurement;
    let now = require_applicable(pending, false)?;
    let m = &mut ctx.accounts.measurement;
    m.kind = kind;
    m.digest = digest;
    m.label = pending.label.clone();
    m.policy_version = pending.policy_version;
    m.registered_at = now;
    m.revoked_at = None;
    m.bump = ctx.bumps.measurement;
    let registry = &mut ctx.accounts.registry;
    registry.registered = registry.registered.checked_add(1).ok_or(MeasurementError::Overflow)?;
    emit!(MeasurementRegistered {
        kind,
        digest,
        label: pending.label.clone(),
        policy_version: pending.policy_version,
        registered_at: now,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct Revoke<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = measurement.bump,
    )]
    pub measurement: Account<'info, Measurement>,
}

/// Immediate. `reason_code` is carried in the event only: 0 unspecified, 1 superseded, 2 vulnerable,
/// 3 key or build compromise, 4 policy change; other values are the authority's own.
pub fn handle_revoke(ctx: Context<Revoke>, kind: u8, digest: [u8; 32], reason_code: u8) -> Result<()> {
    let m = &mut ctx.accounts.measurement;
    require!(m.revoked_at.is_none(), MeasurementError::AlreadyRevoked);
    let now = Clock::get()?.unix_timestamp;
    m.revoked_at = Some(now);
    let registry = &mut ctx.accounts.registry;
    registry.revoked = registry.revoked.checked_add(1).ok_or(MeasurementError::Overflow)?;
    emit!(MeasurementRevoked { kind, digest, reason_code, revoked_at: now });
    Ok(())
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct ProposeReinstate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        seeds = [MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = measurement.bump,
    )]
    pub measurement: Account<'info, Measurement>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingMeasurement::INIT_SPACE,
        seeds = [PENDING_MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump
    )]
    pub pending_measurement: Account<'info, PendingMeasurement>,
    pub system_program: Program<'info, System>,
}

/// Step 1 of a reinstatement: announce that the revocation of an entry is to be cleared. The entry stays revoked.
pub fn handle_propose_reinstate(ctx: Context<ProposeReinstate>, kind: u8, digest: [u8; 32]) -> Result<()> {
    let m = &ctx.accounts.measurement;
    require!(m.revoked_at.is_some(), MeasurementError::NotRevoked);
    let policy_version = m.policy_version;
    propose(
        &mut ctx.accounts.pending_measurement,
        kind,
        digest,
        String::new(),
        policy_version,
        true,
        ctx.bumps.pending_measurement,
    )
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct Reinstate<'info> {
    /// Gets the proposal's rent back.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        close = authority,
        seeds = [PENDING_MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = pending_measurement.bump,
    )]
    pub pending_measurement: Account<'info, PendingMeasurement>,
    #[account(
        mut,
        seeds = [MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = measurement.bump,
    )]
    pub measurement: Account<'info, Measurement>,
}

/// Step 2 of a reinstatement, after the timelock: clears `revoked_at`. `label`, `policy_version` and `registered_at`
/// stay as registered.
pub fn handle_reinstate(ctx: Context<Reinstate>, kind: u8, digest: [u8; 32]) -> Result<()> {
    let now = require_applicable(&ctx.accounts.pending_measurement, true)?;
    let m = &mut ctx.accounts.measurement;
    require!(m.revoked_at.is_some(), MeasurementError::NotRevoked);
    m.revoked_at = None;
    let registry = &mut ctx.accounts.registry;
    registry.revoked = registry.revoked.checked_sub(1).ok_or(MeasurementError::Overflow)?;
    emit!(MeasurementReinstated { kind, digest, reinstated_at: now });
    Ok(())
}

#[derive(Accounts)]
#[instruction(kind: u8, digest: [u8; 32])]
pub struct CancelMeasurementProposal<'info> {
    /// The authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    /// CHECK: the registry authority, who paid the proposal's rent and gets it back.
    #[account(mut, address = registry.authority @ MeasurementError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [PENDING_MEASUREMENT_SEED, kind.to_le_bytes().as_ref(), digest.as_ref()],
        bump = pending_measurement.bump,
    )]
    pub pending_measurement: Account<'info, PendingMeasurement>,
}

/// Drop a pending registration or reinstatement. This program has no guardian: only the authority cancels, and anyone
/// may clear a proposal once it has expired.
pub fn handle_cancel_measurement_proposal(
    ctx: Context<CancelMeasurementProposal>,
    kind: u8,
    digest: [u8; 32],
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let pending = &ctx.accounts.pending_measurement;
    let now = Clock::get()?.unix_timestamp;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    require!(
        signer == ctx.accounts.registry.authority || expired,
        MeasurementError::Unauthorized
    );
    emit!(MeasurementProposalCancelled { kind, digest, reinstate: pending.reinstate, by: signer });
    Ok(())
}
