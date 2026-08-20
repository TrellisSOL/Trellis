use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::AnchorError,
    events::{
        AuthorityTransferProposed, AuthorityTransferred, SignerProposalCancelled, SignerProposed, SignerRevoked,
        SignerRotated, SignerSetInitialized,
    },
    state::{PendingAuthority, PendingSigner, SignerSet},
};

#[derive(Accounts)]
pub struct InitSignerSet<'info> {
    /// Pays for the account. Must be the program's upgrade authority (the deployer, later the multisig), so nobody
    /// else can initialise the program between deploy and init.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + SignerSet::INIT_SPACE,
        seeds = [SIGNER_SET_SEED],
        bump
    )]
    pub signer_set: Account<'info, SignerSet>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// `authority` is the key that will post roots and rotate the signer (the anchorer service key); it need not be the
/// payer. The first signer is named here, by the program's upgrade authority; every later one waits the timelock.
pub fn handle_init_signer_set(ctx: Context<InitSignerSet>, authority: Pubkey, initial_signer: Pubkey) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.payer.key())?;
    require!(authority != Pubkey::default(), AnchorError::InvalidSigner);
    require!(initial_signer != Pubkey::default(), AnchorError::InvalidSigner);
    let set = &mut ctx.accounts.signer_set;
    set.authority = authority;
    set.current_signer = initial_signer;
    set.previous_signer = Pubkey::default();
    set.rotated_at = Clock::get()?.unix_timestamp;
    set.rotation_count = 0;
    set.bump = ctx.bumps.signer_set;
    emit!(SignerSetInitialized { authority: set.authority, signer: initial_signer });
    Ok(())
}

// The receipt signer changes in two ways.
//
// Adding a key is loosening: whoever holds it can sign receipts that the set vouches for. It goes through
// `propose_signer` -> wait `CONFIG_TIMELOCK` (24h) -> `resolve_signer(true)`, expires `PROPOSAL_TTL` (7 days) after it
// became applicable, and only the authority cancels it. Both steps emit an event, so a signer nobody expected shows up
// a day before it can sign anything.
//
// Removing a key only tightens and is immediate (`revoke_signer`): a compromised signer is cut off in one transaction.
// Before round 3 a single `rotate_signer` did both at once, with no notice (re-review RR-09, reversed in round 3).

#[derive(Accounts)]
pub struct ProposeSigner<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingSigner::INIT_SPACE,
        seeds = [PENDING_SIGNER_SEED],
        bump
    )]
    pub pending_signer: Account<'info, PendingSigner>,
    pub system_program: Program<'info, System>,
}

/// Step 1 of a rotation: announce the next receipt signing key. Nothing changes in the signer set yet.
pub fn handle_propose_signer(ctx: Context<ProposeSigner>, new_signer: Pubkey) -> Result<()> {
    require!(new_signer != Pubkey::default(), AnchorError::InvalidSigner);
    require!(new_signer != ctx.accounts.signer_set.current_signer, AnchorError::SignerUnchanged);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_signer;
    pending.new_signer = new_signer;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(AnchorError::Overflow)?;
    pending.bump = ctx.bumps.pending_signer;
    emit!(SignerProposed {
        new_signer,
        effective_at: pending.effective_at,
        expires_at: pending.effective_at.saturating_add(PROPOSAL_TTL),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveSigner<'info> {
    /// Installing or cancelling: the authority. Anyone may clear a proposal that has expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [SIGNER_SET_SEED], bump = signer_set.bump)]
    pub signer_set: Account<'info, SignerSet>,
    /// CHECK: the current authority, who paid the pending account's rent and gets it back.
    #[account(mut, address = signer_set.authority @ AnchorError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_SIGNER_SEED], bump = pending_signer.bump)]
    pub pending_signer: Account<'info, PendingSigner>,
}

/// Step 2. `apply = true`: the authority installs the proposed signer once `CONFIG_TIMELOCK` has elapsed and before the
/// proposal expires (`PROPOSAL_TTL` later); the outgoing key is kept as `previous_signer` (the default key if the
/// current signer had been revoked, so a revoked key never comes back that way). `apply = false`: the authority drops
/// the proposal; once it has expired anyone may.
pub fn handle_resolve_signer(ctx: Context<ResolveSigner>, apply: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let set = &mut ctx.accounts.signer_set;
    let pending = &ctx.accounts.pending_signer;
    let now = Clock::get()?.unix_timestamp;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !apply {
        require!(signer == set.authority || expired, AnchorError::Unauthorized);
        emit!(SignerProposalCancelled { new_signer: pending.new_signer, by: signer });
        return Ok(());
    }
    require_keys_eq!(signer, set.authority, AnchorError::Unauthorized);
    require!(now >= pending.effective_at, AnchorError::TimelockNotElapsed);
    require!(!expired, AnchorError::ProposalExpired);
    require!(pending.new_signer != set.current_signer, AnchorError::SignerUnchanged);
    set.previous_signer = set.current_signer;
    set.current_signer = pending.new_signer;
    set.rotated_at = now;
    set.rotation_count = set.rotation_count.checked_add(1).ok_or(AnchorError::Overflow)?;
    emit!(SignerRotated {
        previous_signer: set.previous_signer,
        current_signer: set.current_signer,
        rotated_at: set.rotated_at,
        rotation_count: set.rotation_count,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSigner<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
}

/// Remove a key from the signer set, at once. A revoked current signer leaves the set with no current signer (the
/// default key) until a proposed one is installed; a revoked previous signer just leaves. Roots are posted by the
/// authority and keep being posted meanwhile; they record whatever `current_signer` holds.
pub fn handle_revoke_signer(ctx: Context<RevokeSigner>, signer: Pubkey) -> Result<()> {
    require!(signer != Pubkey::default(), AnchorError::InvalidSigner);
    let set = &mut ctx.accounts.signer_set;
    let was_current = set.current_signer == signer;
    let was_previous = set.previous_signer == signer;
    require!(was_current || was_previous, AnchorError::SignerNotInSet);
    if was_current {
        set.current_signer = Pubkey::default();
    }
    if was_previous {
        set.previous_signer = Pubkey::default();
    }
    emit!(SignerRevoked { signer, was_current, revoked_at: Clock::get()?.unix_timestamp });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SIGNER_SET_SEED],
        bump = signer_set.bump,
        has_one = authority @ AnchorError::Unauthorized,
    )]
    pub signer_set: Account<'info, SignerSet>,
    #[account(
        init,
        payer = authority,
        space = 8 + PendingAuthority::INIT_SPACE,
        seeds = [PENDING_AUTHORITY_SEED],
        bump
    )]
    pub pending_authority: Account<'info, PendingAuthority>,
    pub system_program: Program<'info, System>,
}

/// Step 1 of a hand-over: name the new authority. It takes over only by signing `resolve_authority_transfer` after
/// `CONFIG_TIMELOCK`, so a mistyped address cannot strand the program and a stolen key cannot hand it away at once.
pub fn handle_transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), AnchorError::InvalidSigner);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_authority;
    pending.new_authority = new_authority;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(AnchorError::Overflow)?;
    pending.bump = ctx.bumps.pending_authority;
    emit!(AuthorityTransferProposed { new_authority, effective_at: pending.effective_at });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveAuthorityTransfer<'info> {
    /// Accepting: the new authority. Cancelling: the current authority.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [SIGNER_SET_SEED], bump = signer_set.bump)]
    pub signer_set: Account<'info, SignerSet>,
    /// CHECK: the current authority, who paid the pending account's rent and gets it back.
    #[account(mut, address = signer_set.authority @ AnchorError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_AUTHORITY_SEED], bump = pending_authority.bump)]
    pub pending_authority: Account<'info, PendingAuthority>,
}

/// Step 2. `accept = true`: the new authority proves it controls its key, after the timelock and before the hand-over
/// expires (`PROPOSAL_TTL` later), and takes over. `accept = false`: the current authority withdraws the hand-over;
/// once it has expired anyone may clear it. This program has no guardian.
pub fn handle_resolve_authority_transfer(ctx: Context<ResolveAuthorityTransfer>, accept: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let c = &mut ctx.accounts.signer_set;
    let pending = &ctx.accounts.pending_authority;
    let now = Clock::get()?.unix_timestamp;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !accept {
        require!(signer == c.authority || expired, AnchorError::Unauthorized);
        return Ok(());
    }
    require_keys_eq!(signer, pending.new_authority, AnchorError::Unauthorized);
    require!(now >= pending.effective_at, AnchorError::TimelockNotElapsed);
    require!(!expired, AnchorError::ProposalExpired);
    let old = c.authority;
    c.authority = pending.new_authority;
    emit!(AuthorityTransferred { old_authority: old, new_authority: c.authority });
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
        root_retention: ROOT_RETENTION,
        proposal_ttl: PROPOSAL_TTL,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, AnchorError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, AnchorError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        AnchorError::NotUpgradeAuthority
    );
    Ok(())
}
