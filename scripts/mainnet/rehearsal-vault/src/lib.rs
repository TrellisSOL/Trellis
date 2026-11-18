//! REHEARSAL ONLY: a stand-in for the Squads v4 multisig program, loaded at the Squads program id on the throwaway
//! local validator of scripts/mainnet/rehearse.sh. It exists because the hand-over's last step needs the multisig
//! VAULT's signature, a vault is a program-derived address, and only the program that owns its seeds can sign for it.
//!
//! What it reproduces from Squads v4 `vault_transaction_execute` (programs/squads_multisig_program/src/utils/
//! executable_transaction_message.rs), and nothing more:
//!   - the vault is the PDA ["multisig", multisig, "vault", [index]] of this program id and signs the inner
//!     instructions through `invoke_signed`;
//!   - an account the message marks as a signer that is not the vault must have signed the OUTER transaction
//!     (Squads: `require!(account_info.is_signer, MultisigError::InvalidAccount)`), and is passed on as a signer.
//! What it leaves out, on purpose: members, votes, thresholds, time locks, proposals. ANYONE can make this program
//! sign as its vaults, which is why it must never exist on a public cluster. On a public cluster this program id is
//! the real Squads program, and at any other address it could only sign for addresses nobody uses.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

declare_id!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InnerAccount {
    /// Index into the transaction's remaining accounts.
    pub index: u8,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InnerInstruction {
    /// Index of the program in the remaining accounts.
    pub program_index: u8,
    pub accounts: Vec<InnerAccount>,
    pub data: Vec<u8>,
}

#[error_code]
pub enum RehearsalError {
    #[msg("An inner instruction names an account that was not passed")]
    MissingAccount,
    #[msg("A signer of the inner instruction that is not the vault did not sign the outer transaction")]
    InvalidAccount,
}

#[program]
pub mod rehearsal_vault {
    use super::*;

    /// Run `instructions` with the vault of `multisig` as a signer.
    pub fn execute<'info>(
        ctx: Context<'info, Execute<'info>>,
        vault_index: u8,
        instructions: Vec<InnerInstruction>,
    ) -> Result<()> {
        let multisig = ctx.accounts.multisig.key();
        let vault = ctx.accounts.vault.key();
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"multisig", multisig.as_ref(), b"vault", &[vault_index], &[bump]];
        let remaining = ctx.remaining_accounts;
        for ix in instructions.iter() {
            let program = remaining.get(ix.program_index as usize).ok_or(RehearsalError::MissingAccount)?;
            let mut metas = Vec::with_capacity(ix.accounts.len());
            let mut infos = Vec::with_capacity(ix.accounts.len() + 1);
            for a in ix.accounts.iter() {
                let info = remaining.get(a.index as usize).ok_or(RehearsalError::MissingAccount)?;
                // As Squads: a signer of the message that is not the vault must be a signer of the outer transaction.
                if a.is_signer && info.key() != vault {
                    require!(info.is_signer, RehearsalError::InvalidAccount);
                }
                metas.push(AccountMeta { pubkey: info.key(), is_signer: a.is_signer, is_writable: a.is_writable });
                infos.push(info.clone());
            }
            infos.push(program.clone());
            invoke_signed(&Instruction { program_id: program.key(), accounts: metas, data: ix.data.clone() }, &infos, &[seeds])?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(vault_index: u8)]
pub struct Execute<'info> {
    /// CHECK: only its address is used, as a seed of the vault. The rehearsal starts the validator with a hand-encoded
    /// Squads `Multisig` account at this address.
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: the vault PDA; it holds no data and signs through `invoke_signed`.
    #[account(seeds = [b"multisig", multisig.key().as_ref(), b"vault", &[vault_index]], bump)]
    pub vault: UncheckedAccount<'info>,
}
