use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    errors::CreditsError,
    events::{CloseCancelled, CloseRequested, CloseRequester, RefundDestinationSet},
    instructions::deposit::key_hash_of,
    state::{CloseGuard, CreditAccount, CreditsConfig, DepositorShare, RefundRequest},
};

// Who decides what about a closure (security re-review RR-05, security review round 3 R3-06).
//
// - The key (the ed25519 keypair derived from the API key) can ask for its account to be closed. It names no
//   destination. Whoever holds a leaked API key can therefore close the account at worst, and the money then goes back
//   to the wallets it came from.
// - The key's registered owner wallet (`CreditAccount::authority`, registered with the key's and the wallet's
//   signatures) can ask for the same closure without the key.
// - A closure can be taken back, while nothing has been paid, by whoever asked for it or by the owner, and by nobody
//   else. A closure the owner asked for cannot be cancelled with the key. The key itself may cancel one closure per
//   `KEY_CANCEL_COOLDOWN` (longer than any refund delay): two holders of one key cannot keep each other's closure from
//   ever becoming payable. The owner is not bound by the cooldown.
// - A depositor has no say over a closure, however much it deposited (the round-2 rule let the wallet that funded more
//   than half cancel: a stranger could buy that with one unit more than the owner). Each depositor decides only where
//   ITS OWN deposits are refunded to (`set_refund_destination`, signed by that wallet); the default is the token
//   account the wallet first deposited from.
// - The settlement authority pays (`pay_refund`), after the delay, to a depositor's destination, at most what that
//   depositor put in and at most the request in total.
//
// None of these instructions can be paused.

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct CloseAccount<'info> {
    /// The API key's own ed25519 keypair (derived from the secret). Its public key must hash to `key_hash`.
    #[account(constraint = key_hash_of(&key.key()) == key_hash @ CreditsError::NotTheKey)]
    pub key: Signer<'info>,
    /// Pays the RefundRequest rent and the fee (the key's keypair holds no SOL). Any wallet.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, key_hash.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, CreditAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + RefundRequest::INIT_SPACE,
        seeds = [REFUND_SEED, key_hash.as_ref()],
        bump
    )]
    pub refund_request: Account<'info, RefundRequest>,
    pub system_program: Program<'info, System>,
}

/// Closes the key and queues a refund of the unspent on-chain balance. The key does not say where the refund goes: it
/// returns to the wallets that deposited to the key (`DepositorShare`). This is not an on-demand withdrawal: the
/// settlement service pays it with `pay_refund` after the dispute check, sanctions screening and the refund delay, and
/// may pay less than requested when off-chain spend has not yet been committed.
pub fn handle_close_account(ctx: Context<CloseAccount>, key_hash: [u8; 32]) -> Result<()> {
    queue_closure(
        &mut ctx.accounts.credit,
        &mut ctx.accounts.refund_request,
        ctx.accounts.config.refund_delay,
        key_hash,
        ctx.accounts.key.key(),
        ctx.accounts.payer.key(),
        ctx.bumps.refund_request,
    )
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct CloseAccountByOwner<'info> {
    /// The key's registered owner wallet.
    pub owner: Signer<'info>,
    /// Pays the RefundRequest rent and the fee. Any wallet (usually the owner itself).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, key_hash.as_ref()],
        bump = credit.bump,
        constraint = credit.authority != Pubkey::default() @ CreditsError::NoOwner,
        constraint = credit.authority == owner.key() @ CreditsError::Unauthorized,
    )]
    pub credit: Account<'info, CreditAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + RefundRequest::INIT_SPACE,
        seeds = [REFUND_SEED, key_hash.as_ref()],
        bump
    )]
    pub refund_request: Account<'info, RefundRequest>,
    pub system_program: Program<'info, System>,
}

/// The same closure as `close_account`, asked for by the key's registered owner wallet instead of the key. This is how
/// an owner whose API key has leaked gets the balance back: a closure asked for this way can be cancelled by the owner
/// only, not with the key.
pub fn handle_close_account_by_owner(ctx: Context<CloseAccountByOwner>, key_hash: [u8; 32]) -> Result<()> {
    queue_closure(
        &mut ctx.accounts.credit,
        &mut ctx.accounts.refund_request,
        ctx.accounts.config.refund_delay,
        key_hash,
        ctx.accounts.owner.key(),
        ctx.accounts.payer.key(),
        ctx.bumps.refund_request,
    )
}

fn queue_closure(
    credit: &mut Account<CreditAccount>,
    request: &mut Account<RefundRequest>,
    refund_delay: i64,
    key_hash: [u8; 32],
    requested_by: Pubkey,
    rent_payer: Pubkey,
    bump: u8,
) -> Result<()> {
    require!(!credit.closed, CreditsError::AccountClosed);
    require!(credit.balance > 0, CreditsError::EmptyBalance);

    let now = Clock::get()?.unix_timestamp;
    let amount = credit.balance;
    credit.balance = 0;
    credit.closed = true;

    let payable_at = now.checked_add(refund_delay).ok_or(CreditsError::Overflow)?;
    request.key_hash = key_hash;
    request.amount = amount;
    request.requested_at = now;
    request.payable_at = payable_at;
    request.paid_amount = 0;
    request.paid = false;
    request.rent_payer = rent_payer;
    request.bump = bump;
    request.requested_by = requested_by;

    emit!(CloseRequested { key_hash, amount, requested_at: now, payable_at });
    emit!(CloseRequester { key_hash, requested_by });
    Ok(())
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct CancelClose<'info> {
    /// Whoever asked for the closure (the key itself, or the owner wallet), or the key's registered owner wallet.
    pub signer: Signer<'info>,
    /// Pays the fee and, the first time the key cancels, the small rent of its `CloseGuard`. Any wallet.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, key_hash.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, CreditAccount>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [REFUND_SEED, key_hash.as_ref()],
        bump = refund_request.bump,
    )]
    pub refund_request: Account<'info, RefundRequest>,
    /// CHECK: the wallet that paid the request's rent; it gets it back.
    #[account(mut, address = refund_request.rent_payer @ CreditsError::Unauthorized)]
    pub rent_payer: UncheckedAccount<'info>,
    /// When the key may next cancel. `init_if_needed`: created by the first cancel and never closed, so it cannot be
    /// re-initialised to forget a cooldown.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + CloseGuard::INIT_SPACE,
        seeds = [CLOSE_GUARD_SEED, key_hash.as_ref()],
        bump
    )]
    pub guard: Account<'info, CloseGuard>,
    pub system_program: Program<'info, System>,
}

/// Takes a queued closure back while nothing has been paid: the key is open again with the balance it had, and can be
/// closed again later. Signed by whoever asked for the closure or by the key's registered owner wallet. When it is the
/// key that cancels, it cannot cancel again for `KEY_CANCEL_COOLDOWN`. Once `pay_refund` has paid any part, the closure
/// runs to its end.
pub fn handle_cancel_close(ctx: Context<CancelClose>, key_hash: [u8; 32]) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let credit = &mut ctx.accounts.credit;
    let request = &ctx.accounts.refund_request;
    let guard = &mut ctx.accounts.guard;
    if guard.key_hash == [0u8; 32] {
        guard.key_hash = key_hash;
        guard.key_cancel_blocked_until = 0;
        guard.bump = ctx.bumps.guard;
    }
    let is_owner = credit.authority != Pubkey::default() && signer == credit.authority;
    if !is_owner {
        // Not the owner: only the key, and only for a closure the key itself asked for. (A wallet that asked as owner
        // and has since handed the ownership on has no say either.)
        require!(
            signer == request.requested_by && key_hash_of(&signer) == key_hash,
            CreditsError::NotRequesterOrOwner
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now >= guard.key_cancel_blocked_until, CreditsError::KeyCancelCooldown);
        guard.key_cancel_blocked_until = now.checked_add(KEY_CANCEL_COOLDOWN).ok_or(CreditsError::Overflow)?;
    }
    require!(!request.paid && request.paid_amount == 0, CreditsError::RefundInProgress);
    credit.closed = false;
    credit.balance = request.amount;
    emit!(CloseCancelled { key_hash, amount: request.amount, by: signer });
    Ok(())
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct SetRefundDestination<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditsConfig>,
    #[account(
        mut,
        seeds = [SHARE_SEED, key_hash.as_ref(), depositor.key().as_ref()],
        bump = share.bump,
        has_one = depositor @ CreditsError::Unauthorized,
    )]
    pub share: Account<'info, DepositorShare>,
    /// The USDC token account the depositor wants its refunds from this key paid to.
    #[account(constraint = refund_to.mint == config.usdc_mint @ CreditsError::MintMismatch)]
    pub refund_to: InterfaceAccount<'info, TokenAccount>,
}

/// A depositor names another token account for its refunds from one key (the first one was closed, frozen or is no
/// longer wanted). Only that wallet's signature does this; the key cannot. Allowed at any time, also while a closure
/// is queued or partly paid: what has not been paid yet goes to the new account.
pub fn handle_set_refund_destination(ctx: Context<SetRefundDestination>, key_hash: [u8; 32]) -> Result<()> {
    let share = &mut ctx.accounts.share;
    share.refund_to = ctx.accounts.refund_to.key();
    emit!(RefundDestinationSet { key_hash, depositor: share.depositor, refund_to: share.refund_to });
    Ok(())
}
