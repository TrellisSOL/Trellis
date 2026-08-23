use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{self, Burn, Mint, TokenAccount},
};

use crate::{constants::*, errors::FeeRouterError, events::InferencePaymentBurned, state::FeeConfig};

#[derive(Accounts)]
pub struct BurnInferencePayment<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ FeeRouterError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(mut, address = fee_config.trls_mint @ FeeRouterError::MintMismatch)]
    pub trls_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = fee_config.trls_vault)]
    pub trls_vault: InterfaceAccount<'info, TokenAccount>,
    /// Must be the Token-2022 program ($TRLS is a Token-2022 mint).
    pub token_2022_program: Program<'info, Token2022>,
}

/// Burns $TRLS received as payment for inference, at settlement. This is the only burn path;
/// protocol fees (USDC) are never burned and nothing here pays token holders or stakers.
pub fn handle_burn_inference_payment(ctx: Context<BurnInferencePayment>, amount: u64) -> Result<()> {
    require!(amount > 0, FeeRouterError::ZeroAmount);
    let c = &mut ctx.accounts.fee_config;
    c.burned_total = c.burned_total.checked_add(amount).ok_or(FeeRouterError::Overflow)?;

    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CONFIG_SEED, &[c.bump]]];
    token_interface::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            Burn {
                mint: ctx.accounts.trls_mint.to_account_info(),
                from: ctx.accounts.trls_vault.to_account_info(),
                authority: c.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(InferencePaymentBurned { amount, burned_total: c.burned_total });
    Ok(())
}
