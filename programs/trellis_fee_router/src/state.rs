use anchor_lang::prelude::*;

/// Fee router configuration. PDA `["fee_config"]`; also the authority of both vaults.
///
/// The split has exactly two possible recipients, workers and treasury, and the default is no
/// split at all: `workers_bps = 0`, `treasury_bps = 10_000`, every protocol fee to the treasury.
/// Hosts are paid their list price and relay operators / canary runners flat service fees, both
/// off-chain from the treasury; nothing pays token holders or stakers.
///
/// `authority` is a single pubkey for now; production authority is a Squads 2-of-3 multisig
///.
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    pub authority: Pubkey,
    /// Mint protocol fees are collected in (USDC).
    pub fee_mint: Pubkey,
    /// $TRLS mint (Token-2022, no extensions).
    pub trls_mint: Pubkey,
    /// Token account PDA `["fee_vault"]` that receives protocol fees.
    pub fee_vault: Pubkey,
    /// Token-2022 account PDA `["trls_vault"]` that receives $TRLS inference payments.
    pub trls_vault: Pubkey,
    pub workers_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub workers_bps: u16,
    pub treasury_bps: u16,
    /// Last distributed period index; periods must strictly increase.
    pub last_period: i64,
    pub distributed_total: u64,
    pub burned_total: u64,
    pub bump: u8,
    pub fee_vault_bump: u8,
    pub trls_vault_bump: u8,
}

/// Record of one distribution. PDA `["distribution", period.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct Distribution {
    pub period: i64,
    pub total: u64,
    pub workers_amount: u64,
    pub treasury_amount: u64,
    pub distributed_at: i64,
    pub bump: u8,
}

/// Replacement payout vaults and / or a new authority waiting out `CONFIG_TIMELOCK`. PDA `["pending_change"]`; one at
/// a time.
#[account]
#[derive(InitSpace)]
pub struct PendingChange {
    pub new_authority: Option<Pubkey>,
    pub workers_vault: Option<Pubkey>,
    pub treasury_vault: Option<Pubkey>,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub bump: u8,
}

/// What `build_profile` returns: the floors compiled into this binary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile {
    /// 0 = mainnet floors (the default build); 1 = the `devnet` cargo feature.
    pub profile: u8,
    pub config_timelock: i64,
    pub proposal_ttl: i64,
}
