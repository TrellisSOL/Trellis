//! Voucher verification through the Ed25519 precompile and instruction introspection.
//!
//! The payee's transaction must contain, immediately before the `close` / `post_voucher`
//! instruction, an Ed25519 program instruction carrying exactly one signature whose public key,
//! message and signature live inside that same instruction (instruction index `u16::MAX`, or
//! the Ed25519 instruction's own index). The runtime has already verified the signature by the
//! time our instruction runs, so here we only need to check that *what* was verified is the
//! voucher we expect: pubkey == tab.session_key and message == the domain-separated voucher bytes
//! of this program, this tab and this opening of the tab (`voucher_message`).

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    errors::TabError,
    state::{VOUCHER_DOMAIN, VOUCHER_MSG_LEN},
};

/// Ed25519 precompile program id (`Ed25519SigVerify111111111111111111111111111`).
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const SIGNATURE_OFFSETS_START: usize = 2;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
const PUBKEY_SERIALIZED_SIZE: usize = 32;
const SIGNATURE_SERIALIZED_SIZE: usize = 64;

/// Builds the canonical voucher message (security review TR-19):
///
/// ```text
/// "trellis:tab:voucher:v1" || program_id || tab || created_at LE || cumulative_used LE || seq LE
/// ```
///
/// The domain string keeps a voucher from being any other message a session key might sign. The program id binds it to
/// this deployment (each cluster has its own program id, so a devnet voucher is nothing on mainnet). `created_at` binds it
/// to this opening of the tab: a tab address can be opened again after `close` or `reclaim` with the same payer, payee
/// and `tab_id`, and a voucher signed for the earlier opening must not be worth anything against the new escrow.
pub fn voucher_message(
    program_id: &Pubkey,
    tab: &Pubkey,
    created_at: i64,
    cumulative_used: u64,
    seq: u64,
) -> [u8; VOUCHER_MSG_LEN] {
    let d = VOUCHER_DOMAIN.len();
    let mut msg = [0u8; VOUCHER_MSG_LEN];
    msg[..d].copy_from_slice(VOUCHER_DOMAIN);
    msg[d..d + 32].copy_from_slice(program_id.as_ref());
    msg[d + 32..d + 64].copy_from_slice(tab.as_ref());
    msg[d + 64..d + 72].copy_from_slice(&created_at.to_le_bytes());
    msg[d + 72..d + 80].copy_from_slice(&cumulative_used.to_le_bytes());
    msg[d + 80..d + 88].copy_from_slice(&seq.to_le_bytes());
    msg
}

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(TabError::MalformedEd25519Instruction)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// Verifies that the instruction preceding the current one is an Ed25519 program instruction
/// attesting `session_key` signed `voucher_message(program, tab, created_at, cumulative_used, seq)`.
pub fn verify_voucher(
    instructions_sysvar: &AccountInfo,
    session_key: &Pubkey,
    tab: &Pubkey,
    created_at: i64,
    cumulative_used: u64,
    seq: u64,
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| TabError::BadInstructionsSysvar)?;
    require!(current_index > 0, TabError::MissingEd25519Instruction);
    let ed_index = current_index - 1;
    let ed_ix = load_instruction_at_checked(ed_index as usize, instructions_sysvar)
        .map_err(|_| TabError::BadInstructionsSysvar)?;
    require_keys_eq!(
        ed_ix.program_id,
        ED25519_PROGRAM_ID,
        TabError::MissingEd25519Instruction
    );
    require!(ed_ix.accounts.is_empty(), TabError::MalformedEd25519Instruction);

    let data = &ed_ix.data;
    require!(
        data.len() >= SIGNATURE_OFFSETS_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE,
        TabError::MalformedEd25519Instruction
    );
    require!(data[0] == 1, TabError::Ed25519SignatureCount);

    let o = SIGNATURE_OFFSETS_START;
    let signature_offset = read_u16(data, o)? as usize;
    let signature_ix_index = read_u16(data, o + 2)?;
    let pubkey_offset = read_u16(data, o + 4)? as usize;
    let pubkey_ix_index = read_u16(data, o + 6)?;
    let message_offset = read_u16(data, o + 8)? as usize;
    let message_size = read_u16(data, o + 10)? as usize;
    let message_ix_index = read_u16(data, o + 12)?;

    // Every referenced byte range must live in the Ed25519 instruction itself.
    let same_ix = |idx: u16| idx == u16::MAX || idx == ed_index;
    require!(
        same_ix(signature_ix_index) && same_ix(pubkey_ix_index) && same_ix(message_ix_index),
        TabError::Ed25519ForeignReference
    );

    let pubkey_bytes = data
        .get(pubkey_offset..pubkey_offset + PUBKEY_SERIALIZED_SIZE)
        .ok_or(TabError::MalformedEd25519Instruction)?;
    require!(
        pubkey_bytes == session_key.as_ref(),
        TabError::Ed25519PubkeyMismatch
    );

    data.get(signature_offset..signature_offset + SIGNATURE_SERIALIZED_SIZE)
        .ok_or(TabError::MalformedEd25519Instruction)?;

    require!(message_size == VOUCHER_MSG_LEN, TabError::Ed25519MessageMismatch);
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(TabError::MalformedEd25519Instruction)?;
    let expected = voucher_message(&crate::ID, tab, created_at, cumulative_used, seq);
    require!(message == expected, TabError::Ed25519MessageMismatch);
    Ok(())
}
