//! trellis_anchor: hourly receipt roots, per-host receipt roots (§3) and the receipt-signer set
//! (Trellis Backend §5.4).
//!
//! Merkle roots are sha256 (never keccak): leaf = sha256(sha256(bytes)),
//! node = sha256(min(a,b) || max(a,b)). See `merkle.rs`, which also exposes a pure
//! `verify_inclusion` for the public verifier and CPI consumers.
//!
//! `authority` is a single pubkey: the anchorer service key, which posts a root every hour. A new receipt signer is
//! proposed and installed 24 hours later (`propose_signer`, `resolve_signer`); a signer is revoked at once
//! (`revoke_signer`).
//!
//! Rent: every root is its own small account. `close_root` / `close_host_root` return that rent once the hour is
//! older than `ROOT_RETENTION` (400 days), and an hour that old can no longer be posted, so an hour never gets a
//! second root. A closed root is verified from the transaction that posted it.
#![allow(unexpected_cfgs)]

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod merkle;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("GAzh2GTSDpqcNcMX1iiCq5Dezx85fQLNXA7M1tS5BMjn");

#[program]
pub mod trellis_anchor {
    use super::*;

    pub fn init_signer_set(ctx: Context<InitSignerSet>, authority: Pubkey, initial_signer: Pubkey) -> Result<()> {
        instructions::signer_set::handle_init_signer_set(ctx, authority, initial_signer)
    }

    /// Authority: announce the next receipt signing key. It can be installed after `CONFIG_TIMELOCK` (24h).
    pub fn propose_signer(ctx: Context<ProposeSigner>, new_signer: Pubkey) -> Result<()> {
        instructions::signer_set::handle_propose_signer(ctx, new_signer)
    }

    /// `apply = true`: the authority installs the proposed signer after the timelock (the outgoing one is kept as the
    /// previous signer). `apply = false`: the authority drops the proposal; anyone may clear an expired one.
    pub fn resolve_signer(ctx: Context<ResolveSigner>, apply: bool) -> Result<()> {
        instructions::signer_set::handle_resolve_signer(ctx, apply)
    }

    /// Authority: remove the current or the previous signer from the set, at once.
    pub fn revoke_signer(ctx: Context<RevokeSigner>, signer: Pubkey) -> Result<()> {
        instructions::signer_set::handle_revoke_signer(ctx, signer)
    }

    /// Authority: name a new authority. It takes over only by signing `resolve_authority_transfer`
    /// after `CONFIG_TIMELOCK`.
    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::signer_set::handle_transfer_authority(ctx, new_authority)
    }

    /// `accept = true`: the new authority takes over (after the timelock). `accept = false`: the authority cancels
    /// (anyone, once the hand-over has expired).
    pub fn resolve_authority_transfer(ctx: Context<ResolveAuthorityTransfer>, accept: bool) -> Result<()> {
        instructions::signer_set::handle_resolve_authority_transfer(ctx, accept)
    }


    /// Authority: post the hour's receipt root. Idempotent per hour (second post fails).
    pub fn post_root(ctx: Context<PostRoot>, hour: i64, root: [u8; 32], count: u64) -> Result<()> {
        instructions::post_root::handle_post_root(ctx, hour, root, count)
    }

    /// Authority: post one attested host's receipt root for the hour. Idempotent per
    /// (host, hour): a second post for the same pair fails.
    pub fn post_host_root(
        ctx: Context<PostHostRoot>,
        provider_id_hash: [u8; 32],
        hour: i64,
        root: [u8; 32],
        count: u64,
    ) -> Result<()> {
        instructions::post_host_root::handle_post_host_root(ctx, provider_id_hash, hour, root, count)
    }

    /// Anyone: the floors compiled into this binary (profile 0 = mainnet, 1 = devnet), as return data.
    pub fn build_profile(ctx: Context<ReadBuildProfile>) -> Result<BuildProfile> {
        instructions::signer_set::handle_build_profile(ctx)
    }

    /// Authority: close the root of an hour that ended at least `ROOT_RETENTION` ago; the rent returns to the authority.
    pub fn close_root(ctx: Context<CloseRoot>, hour: i64) -> Result<()> {
        instructions::post_root::handle_close_root(ctx, hour)
    }

    /// Authority: close one host's root of an hour that ended at least `ROOT_RETENTION` ago.
    pub fn close_host_root(ctx: Context<CloseHostRoot>, provider_id_hash: [u8; 32], hour: i64) -> Result<()> {
        instructions::post_host_root::handle_close_host_root(ctx, provider_id_hash, hour)
    }
}
