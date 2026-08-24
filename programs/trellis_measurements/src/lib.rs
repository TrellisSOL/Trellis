//! trellis_measurements: the measurement registry (Trellis Backend §3.2).
//!
//! An allow-list of 32-byte digests a Graft host may run, one account per `(kind, digest)`:
//! the model weights digest, the compose hash the platform measures into RTMR3, the OS image
//! and the sidecar source. A Graft container refuses to start unless its model digest and
//! compose hash are registered here and not revoked; the router reads the same accounts.
//! Every entry is first published as a signed measurement bundle in Sigstore Rekor and the
//! Trellis transparency log; `label` carries the reference to that record.
//!
//! An entry is never closed. `revoke` stamps `revoked_at`, `register` on an existing entry
//! fails at `init` (revoked or not), and only `reinstate` clears a revocation, so a digest
//! that was once withdrawn cannot come back without a deliberate authority action.
//!
//! Adding to the allow-list takes a day: `propose_measurement` (or `propose_reinstate`) announces the entry, and
//! `register` (or `reinstate`) applies it once `CONFIG_TIMELOCK` (24h) has elapsed. `revoke` is immediate.
//!
//! `authority` is a single pubkey for now; production authority is a Squads 2-of-3 multisig
//! (Trellis Backend §10). The program holds no funds: the only lamports are the rent of the
//! registry and entry accounts, paid by the authority.
#![allow(unexpected_cfgs)]

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4PzSbQpW3tGQJY676KNr6AwWY9WZ4feKZ1rx6JjtTgNY");

#[program]
pub mod trellis_measurements {
    use super::*;

    /// Create the registry and name its authority (the Squads 2-of-3 vault in production).
    pub fn init_registry(ctx: Context<InitRegistry>, authority: Pubkey) -> Result<()> {
        instructions::registry::handle_init_registry(ctx, authority)
    }

    /// Authority: name a new authority. It takes over only by signing `resolve_authority_transfer`
    /// after `CONFIG_TIMELOCK`.
    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::registry::handle_transfer_authority(ctx, new_authority)
    }

    /// `accept = true`: the new authority takes over (after the timelock). `accept = false`: the authority cancels
    /// (anyone, once the hand-over has expired).
    pub fn resolve_authority_transfer(ctx: Context<ResolveAuthorityTransfer>, accept: bool) -> Result<()> {
        instructions::registry::handle_resolve_authority_transfer(ctx, accept)
    }


    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::registry::handle_build_profile(ctx)
    }

    /// Authority: announce one `(kind, digest)` for the allow-list. It can be registered after `CONFIG_TIMELOCK`
    /// (24h). Fails when the entry exists, whether it is live or revoked.
    pub fn propose_measurement(
        ctx: Context<ProposeMeasurement>,
        kind: u8,
        digest: [u8; 32],
        label: String,
        policy_version: u32,
    ) -> Result<()> {
        instructions::measurement::handle_propose_measurement(ctx, kind, digest, label, policy_version)
    }

    /// Authority: add a proposed `(kind, digest)` to the allow-list, once its timelock has elapsed.
    pub fn register(ctx: Context<Register>, kind: u8, digest: [u8; 32]) -> Result<()> {
        instructions::measurement::handle_register(ctx, kind, digest)
    }

    /// Authority: withdraw an entry, at once. The account stays, stamped with the revocation time.
    pub fn revoke(ctx: Context<Revoke>, kind: u8, digest: [u8; 32], reason_code: u8) -> Result<()> {
        instructions::measurement::handle_revoke(ctx, kind, digest, reason_code)
    }

    /// Authority: announce that the revocation of an entry is to be cleared. Applicable after `CONFIG_TIMELOCK` (24h).
    pub fn propose_reinstate(ctx: Context<ProposeReinstate>, kind: u8, digest: [u8; 32]) -> Result<()> {
        instructions::measurement::handle_propose_reinstate(ctx, kind, digest)
    }

    /// Authority: clear the revocation of an entry, once the proposal's timelock has elapsed. The only way a revoked
    /// digest is accepted again.
    pub fn reinstate(ctx: Context<Reinstate>, kind: u8, digest: [u8; 32]) -> Result<()> {
        instructions::measurement::handle_reinstate(ctx, kind, digest)
    }

    /// Authority: drop a pending registration or reinstatement. Anyone may clear an expired one.
    pub fn cancel_measurement_proposal(
        ctx: Context<CancelMeasurementProposal>,
        kind: u8,
        digest: [u8; 32],
    ) -> Result<()> {
        instructions::measurement::handle_cancel_measurement_proposal(ctx, kind, digest)
    }
}
