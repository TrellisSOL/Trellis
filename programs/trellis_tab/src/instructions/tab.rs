use anchor_lang::{prelude::*, solana_program::program_pack::Pack};
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{errors::TabError, events::*, state::*};

/// Seed of the PDA that signs `record_commitment` CPIs into `trellis_rules`.
/// `trellis_rules`' `RulesConfig.enforcer` must be set to this PDA.
pub const ENFORCER_SEED: &[u8] = b"enforcer";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenTabArgs {
    pub tab_id: u64,
    pub cap: u64,
    pub expiry: i64,
    /// Ed25519 public key that will sign vouchers for this tab.
    pub session_key: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: OpenTabArgs)]
pub struct OpenTab<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: any pubkey; the payee is only ever paid to a token account it owns.
    pub payee: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TabConfig>,
    #[account(
        init,
        payer = payer,
        space = 8 + Tab::INIT_SPACE,
        seeds = [TAB_SEED, payer.key().as_ref(), payee.key().as_ref(), &args.tab_id.to_le_bytes()],
        bump
    )]
    pub tab: Account<'info, Tab>,
    #[account(address = config.usdc_mint @ TabError::MintMismatch)]
    pub mint: Account<'info, Mint>,
    /// Escrow for the tab's USDC; authority is the `Tab` PDA.
    #[account(
        init,
        payer = payer,
        seeds = [ESCROW_SEED, tab.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = tab,
    )]
    pub escrow: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = payer_token.mint == mint.key() @ TabError::MintMismatch,
        constraint = payer_token.owner == payer.key() @ TabError::TokenOwnerMismatch,
    )]
    pub payer_token: Account<'info, TokenAccount>,
    /// Optional `trellis_rules` Rulebook. It must be owned by the payer; the escrowed cap is recorded against its
    /// daily limit and a killed or expired rulebook refuses the tab. With it, the three accounts below are required.
    /// CHECK: owner program, layout and rulebook owner are checked in `commit_to_rulebook`.
    #[account(mut)]
    pub rulebook: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: `trellis_rules` config PDA, validated by `trellis_rules`.
    pub rules_config: Option<UncheckedAccount<'info>>,
    /// CHECK: must equal `config.rules_program`.
    pub rules_program: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA signer for `record_commitment`; `trellis_rules` checks it against its `enforcer`.
    #[account(seeds = [ENFORCER_SEED], bump)]
    pub enforcer: Option<UncheckedAccount<'info>>,
}

/// Record `amount` newly escrowed against the payer's rulebook (`trellis_rules::record_commitment`): reverts when the
/// rulebook is not the payer's, is killed or expired, or the day's commitments would pass `daily_max`.
///
/// This is the only place a tab touches its rulebook. Settlement (`close`, `reclaim`) never does, so nothing the
/// rulebook's owner does later can keep the payee from collecting what was vouched.
#[allow(clippy::too_many_arguments)]
pub fn commit_to_rulebook<'info>(
    config: &TabConfig,
    payer: &Pubkey,
    rulebook: &UncheckedAccount<'info>,
    rules_config: Option<&UncheckedAccount<'info>>,
    rules_program: Option<&UncheckedAccount<'info>>,
    enforcer: Option<&UncheckedAccount<'info>>,
    enforcer_bump: Option<u8>,
    amount: u64,
) -> Result<()> {
    let rules_config = rules_config.ok_or(TabError::RulebookRequired)?;
    let rules_program = rules_program.ok_or(TabError::RulebookRequired)?;
    let enforcer = enforcer.ok_or(TabError::RulebookRequired)?;
    let bump = enforcer_bump.ok_or(TabError::RulebookRequired)?;
    require_keys_eq!(rules_program.key(), config.rules_program, TabError::RulesProgramMismatch);
    require_keys_eq!(*rulebook.owner, config.rules_program, TabError::RulebookOwnerMismatch);
    {
        let data = rulebook.try_borrow_data()?;
        let rb = trellis_rules::Rulebook::try_deserialize(&mut &data[..])
            .map_err(|_| error!(TabError::RulebookMismatch))?;
        require_keys_eq!(rb.owner, *payer, TabError::RulebookNotOwnedByPayer);
    }
    let seeds: &[&[u8]] = &[ENFORCER_SEED, &[bump]];
    trellis_rules::cpi::record_commitment(
        CpiContext::new_with_signer(
            rules_program.key(),
            trellis_rules::cpi::accounts::RecordSpend {
                enforcer: enforcer.to_account_info(),
                config: rules_config.to_account_info(),
                rulebook: rulebook.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Open a tab: move `cap` USDC into escrow and register the session key.
pub fn handle_open_tab(ctx: Context<OpenTab>, args: OpenTabArgs) -> Result<()> {
    let config = &ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    require!(!config.pause_active(now), TabError::Paused);
    require!(args.cap > 0, TabError::ZeroAmount);
    // The configured cap, and never more than the compiled maximum.
    require!(args.cap <= config.max_cap.min(MAX_CAP_LIMIT), TabError::CapTooLarge);
    require!(args.session_key != Pubkey::default(), TabError::InvalidSessionKey);
    require_keys_neq!(ctx.accounts.payer.key(), ctx.accounts.payee.key(), TabError::PayerIsPayee);
    require!(args.expiry > now, TabError::ExpiryInPast);
    // Bounded lifetime: the escrow cannot be locked for an arbitrary time and `expiry + reclaim_grace` cannot overflow.
    let latest = now.checked_add(MAX_TAB_LIFETIME).ok_or(TabError::Overflow)?;
    require!(args.expiry <= latest, TabError::ExpiryTooFar);

    let rulebook = match &ctx.accounts.rulebook {
        Some(rb) => {
            commit_to_rulebook(
                config,
                &ctx.accounts.payer.key(),
                rb,
                ctx.accounts.rules_config.as_ref(),
                ctx.accounts.rules_program.as_ref(),
                ctx.accounts.enforcer.as_ref(),
                ctx.bumps.enforcer,
                args.cap,
            )?;
            Some(rb.key())
        }
        None => None,
    };

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.payer_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        args.cap,
        ctx.accounts.mint.decimals,
    )?;

    let tab = &mut ctx.accounts.tab;
    tab.payer = ctx.accounts.payer.key();
    tab.payee = ctx.accounts.payee.key();
    tab.session_key = args.session_key;
    tab.mint = ctx.accounts.mint.key();
    tab.tab_id = args.tab_id;
    tab.cap = args.cap;
    tab.posted_used = 0;
    tab.posted_seq = 0;
    tab.expiry = args.expiry;
    tab.created_at = now;
    tab.rulebook = rulebook;
    tab.bump = ctx.bumps.tab;
    tab.escrow_bump = ctx.bumps.escrow;

    emit!(TabOpened {
        tab: tab.key(),
        payer: tab.payer,
        payee: tab.payee,
        session_key: tab.session_key,
        mint: tab.mint,
        tab_id: tab.tab_id,
        cap: tab.cap,
        expiry: tab.expiry,
        rulebook,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TopUp<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TabConfig>,
    #[account(
        mut,
        seeds = [TAB_SEED, tab.payer.as_ref(), tab.payee.as_ref(), &tab.tab_id.to_le_bytes()],
        bump = tab.bump,
        has_one = payer @ TabError::Unauthorized,
        has_one = mint @ TabError::MintMismatch,
    )]
    pub tab: Account<'info, Tab>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, tab.key().as_ref()],
        bump = tab.escrow_bump,
        token::mint = mint,
        token::authority = tab,
    )]
    pub escrow: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = payer_token.mint == mint.key() @ TabError::MintMismatch,
        constraint = payer_token.owner == payer.key() @ TabError::TokenOwnerMismatch,
    )]
    pub payer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // --- Required only when the tab was opened with a rulebook: the top-up is a new commitment under it ---
    /// CHECK: must equal `tab.rulebook`; checked in `commit_to_rulebook`.
    #[account(mut)]
    pub rulebook: Option<UncheckedAccount<'info>>,
    /// CHECK: `trellis_rules` config PDA, validated by `trellis_rules`.
    pub rules_config: Option<UncheckedAccount<'info>>,
    /// CHECK: must equal `config.rules_program`.
    pub rules_program: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA signer for `record_commitment`.
    #[account(seeds = [ENFORCER_SEED], bump)]
    pub enforcer: Option<UncheckedAccount<'info>>,
}

pub fn handle_top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
    require!(amount > 0, TabError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    // Security review R4-30: a pause stops new commitments, and a top-up is one, as `open_tab` is.
    require!(!ctx.accounts.config.pause_active(now), TabError::Paused);
    let tab = &ctx.accounts.tab;
    require!(!tab.is_final(), TabError::TabFinal);
    require!(now < tab.expiry, TabError::TabExpired);
    let new_cap = tab.cap.checked_add(amount).ok_or(TabError::Overflow)?;
    require!(new_cap <= ctx.accounts.config.max_cap.min(MAX_CAP_LIMIT), TabError::CapTooLarge);

    if let Some(rulebook_key) = tab.rulebook {
        let rb = ctx.accounts.rulebook.as_ref().ok_or(TabError::RulebookRequired)?;
        require_keys_eq!(rb.key(), rulebook_key, TabError::RulebookMismatch);
        commit_to_rulebook(
            &ctx.accounts.config,
            &tab.payer,
            rb,
            ctx.accounts.rules_config.as_ref(),
            ctx.accounts.rules_program.as_ref(),
            ctx.accounts.enforcer.as_ref(),
            ctx.bumps.enforcer,
            amount,
        )?;
    }

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.payer_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let tab = &mut ctx.accounts.tab;
    tab.cap = new_cap;
    emit!(TabToppedUp {
        tab: tab.key(),
        amount,
        cap: new_cap,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    /// CHECK: the tab's payer wallet: receives the rent of the tab and its escrow when they close. It does not have to
    /// sign: after `expiry + reclaim_grace` (or once the payee has closed) anyone may deliver the escrow, and every
    /// transfer goes only to the stored payer and payee.
    #[account(mut, address = tab.payer @ TabError::Unauthorized)]
    pub payer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [TAB_SEED, tab.payer.as_ref(), tab.payee.as_ref(), &tab.tab_id.to_le_bytes()],
        bump = tab.bump,
        has_one = mint @ TabError::MintMismatch,
    )]
    pub tab: Account<'info, Tab>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TabConfig>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, tab.key().as_ref()],
        bump = tab.escrow_bump,
        token::mint = mint,
        token::authority = tab,
    )]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: the payer's USDC token account. Paid only if it is a live token account of the tab's mint owned by the
    /// payer (`can_receive`); otherwise the payer's share stays in escrow for a later `reclaim`.
    #[account(mut)]
    pub payer_token: UncheckedAccount<'info>,
    /// CHECK: the payee's USDC token account, under the same rule.
    #[account(mut)]
    pub payee_token: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Deliver a tab's escrow: the payee gets the highest voucher it posted, the payer gets everything else. Allowed for
/// anyone after `expiry + reclaim_grace`, and at any time once the payee has closed (`Tab::is_final`).
pub fn handle_reclaim(ctx: Context<Reclaim>) -> Result<()> {
    let tab = &ctx.accounts.tab;
    if !tab.is_final() {
        let now = Clock::get()?.unix_timestamp;
        let reclaim_at = tab
            .expiry
            .checked_add(ctx.accounts.config.reclaim_grace)
            .ok_or(TabError::Overflow)?;
        require!(now >= reclaim_at, TabError::ReclaimTooEarly);
    }
    let tab_key = tab.key();
    let (payer, payee) = (tab.payer, tab.payee);

    let s = settle(
        &mut ctx.accounts.tab,
        &ctx.accounts.escrow,
        &ctx.accounts.mint,
        &ctx.accounts.payee_token,
        &ctx.accounts.payer_token,
        &ctx.accounts.payer,
        &ctx.accounts.token_program,
    )?;
    require!(s.paid_payee > 0 || s.paid_payer > 0 || s.closed, TabError::NothingToSettle);

    emit!(TabReclaimed {
        tab: tab_key,
        payer,
        payee,
        paid_to_payee: s.paid_payee,
        refunded: s.paid_payer,
    });
    Ok(())
}

/// Whether `info` is a live SPL token account of `mint` owned by `owner`: a transfer to it will succeed.
pub fn can_receive(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> bool {
    if info.owner != &token::ID || !info.is_writable {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    match token::spl_token::state::Account::unpack(&data) {
        Ok(a) => a.mint == *mint && a.owner == *owner && !a.is_frozen(),
        Err(_) => false,
    }
}

pub struct Settled {
    pub paid_payee: u64,
    pub paid_payer: u64,
    /// What stays in escrow because its owner's token account could not receive it.
    pub owed_payee: u64,
    pub owed_payer: u64,
    /// Whether the escrow and the tab were closed (everything was delivered).
    pub closed: bool,
}

/// Shared settlement for `close` and `reclaim`. Works from the escrow's ACTUAL balance, never from `cap`:
///
/// - the payee is owed `min(posted_used, cap, balance)`;
/// - the payer is owed everything else, including anything a third party sent to the escrow (a stray deposit can
///   therefore never block the close: it is simply refunded to the payer);
/// - each side is paid only if its token account can receive (`can_receive`). A side that cannot is not allowed to
///   block the other: its share stays in escrow, the tab is marked final (`FINAL_SEQ`) with `cap` and `posted_used`
///   rewritten to what is still owed, and anyone can deliver the rest later with `reclaim`;
/// - when both sides are paid the escrow and the tab are closed and their rent returns to the payer.
pub fn settle<'info>(
    tab: &mut Account<'info, Tab>,
    escrow: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    payee_token: &UncheckedAccount<'info>,
    payer_token: &UncheckedAccount<'info>,
    rent_to: &UncheckedAccount<'info>,
    token_program: &Program<'info, Token>,
) -> Result<Settled> {
    let balance = escrow.amount;
    let payee_due = tab.posted_used.min(tab.cap).min(balance);
    let payer_due = balance.checked_sub(payee_due).ok_or(TabError::Overflow)?;

    let pay_payee = payee_due > 0 && can_receive(payee_token, &tab.mint, &tab.payee);
    let pay_payer = payer_due > 0 && can_receive(payer_token, &tab.mint, &tab.payer);

    let payer = tab.payer;
    let payee = tab.payee;
    let id_bytes = tab.tab_id.to_le_bytes();
    let seeds: &[&[u8]] = &[TAB_SEED, payer.as_ref(), payee.as_ref(), &id_bytes, &[tab.bump]];
    let signer = &[seeds];

    for (pay, to, amount) in [(pay_payee, payee_token, payee_due), (pay_payer, payer_token, payer_due)] {
        if !pay {
            continue;
        }
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: escrow.to_account_info(),
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: tab.to_account_info(),
                },
                signer,
            ),
            amount,
            mint.decimals,
        )?;
    }

    let owed_payee = if pay_payee { 0 } else { payee_due };
    let owed_payer = if pay_payer { 0 } else { payer_due };
    let closed = owed_payee == 0 && owed_payer == 0;
    if closed {
        // Security review R4-30: a voucher is bound to its tab's opening by `created_at`, which has one-second
        // granularity. Closing the Tab account in the second it was opened would let the payer reopen the same address
        // in that second with the same `created_at`, and the payee replay the first opening's voucher against the new
        // escrow. Every path that closes the account comes through here, so the account outlives its opening second
        // and a reopening of the address always carries a later `created_at`.
        require!(Clock::get()?.unix_timestamp > tab.created_at, TabError::CloseTooSoon);
        token::close_account(CpiContext::new_with_signer(
            token_program.key(),
            CloseAccount {
                account: escrow.to_account_info(),
                destination: rent_to.to_account_info(),
                authority: tab.to_account_info(),
            },
            signer,
        ))?;
        tab.close(rent_to.to_account_info())?;
    } else {
        // Settlement has started: no more vouchers or top-ups, and what is left can be delivered at any time.
        tab.posted_seq = Tab::FINAL_SEQ;
        tab.posted_used = owed_payee;
        tab.cap = owed_payee.checked_add(owed_payer).ok_or(TabError::Overflow)?;
        emit!(TabSettlementDeferred {
            tab: tab.key(),
            owed_to_payee: owed_payee,
            owed_to_payer: owed_payer,
        });
    }

    Ok(Settled {
        paid_payee: if pay_payee { payee_due } else { 0 },
        paid_payer: if pay_payer { payer_due } else { 0 },
        owed_payee,
        owed_payer,
        closed,
    })
}

/// The payer's canonical USDC account: the only address `close` accepts as "the payer has no account to refund to".
pub fn payer_ata(tab: &Tab) -> Pubkey {
    get_associated_token_address(&tab.payer, &tab.mint)
}
