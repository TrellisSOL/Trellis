use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::MeasurementError,
    events::{AuthorityTransferProposed, AuthorityTransferred, RegistryInitialized},
    state::{PendingAuthority, Registry},
};

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    /// Pays the registry's rent. Must be the program's upgrade authority (the deployer, right after the deploy), so
    /// nobody else can initialise the registry and name its authority first.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, Registry>,
    /// CHECK: this program's ProgramData account; `require_upgrade_authority` checks its address, owner and authority.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// `authority` is the key that will register and revoke entries (Squads 2-of-3 in production);
/// it need not be the payer.
pub fn handle_init_registry(ctx: Context<InitRegistry>, authority: Pubkey) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.payer.key())?;
    require!(authority != Pubkey::default(), MeasurementError::InvalidAuthority);
    let registry = &mut ctx.accounts.registry;
    registry.authority = authority;
    registry.registered = 0;
    registry.revoked = 0;
    registry.bump = ctx.bumps.registry;
    emit!(RegistryInitialized { authority });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ MeasurementError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
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
    require!(new_authority != Pubkey::default(), MeasurementError::InvalidAuthority);
    let now = Clock::get()?.unix_timestamp;
    let pending = &mut ctx.accounts.pending_authority;
    pending.new_authority = new_authority;
    pending.proposed_at = now;
    pending.effective_at = now.checked_add(CONFIG_TIMELOCK).ok_or(MeasurementError::Overflow)?;
    pending.bump = ctx.bumps.pending_authority;
    emit!(AuthorityTransferProposed { new_authority, effective_at: pending.effective_at });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveAuthorityTransfer<'info> {
    /// Accepting: the new authority. Cancelling: the current authority.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    /// CHECK: the current authority, who paid the pending account's rent and gets it back.
    #[account(mut, address = registry.authority @ MeasurementError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [PENDING_AUTHORITY_SEED], bump = pending_authority.bump)]
    pub pending_authority: Account<'info, PendingAuthority>,
}

/// Step 2. `accept = true`: the new authority proves it controls its key, after the timelock and before the hand-over
/// expires (`PROPOSAL_TTL` later), and takes over. `accept = false`: the current authority withdraws the hand-over;
/// once it has expired anyone may clear it. This program has no guardian.
pub fn handle_resolve_authority_transfer(ctx: Context<ResolveAuthorityTransfer>, accept: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let c = &mut ctx.accounts.registry;
    let pending = &ctx.accounts.pending_authority;
    let now = Clock::get()?.unix_timestamp;
    let expired = now > pending.effective_at.saturating_add(PROPOSAL_TTL);
    if !accept {
        require!(signer == c.authority || expired, MeasurementError::Unauthorized);
        return Ok(());
    }
    require_keys_eq!(signer, pending.new_authority, MeasurementError::Unauthorized);
    require!(now >= pending.effective_at, MeasurementError::TimelockNotElapsed);
    require!(!expired, MeasurementError::ProposalExpired);
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
        proposal_ttl: PROPOSAL_TTL,
    })
}

/// Requires `signer` to be this program's upgrade authority, read from the program's ProgramData account (the PDA of
/// the program id under the upgradeable loader). Closes the window between deploy and init: nobody but the deployer
/// (later the multisig) can create the config. An immutable program (no upgrade authority) can no longer be initialised.
pub fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, MeasurementError::NotUpgradeAuthority);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, MeasurementError::NotUpgradeAuthority);
    let data = program_data.try_borrow_data()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }, bincode:
    // u32 tag (3), u64 slot, then the option as one byte and the 32 key bytes.
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        MeasurementError::NotUpgradeAuthority
    );
    Ok(())
}
