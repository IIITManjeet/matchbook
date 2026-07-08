use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::ClobError;
use crate::events::PerpMarketInitialized;
use crate::state::PerpMarket;

const MAX_FEE_BPS: u16 = 500;

#[derive(Accounts)]
pub struct InitPerpMarket<'info> {
    /// Becomes the market admin — i.e. the oracle keeper.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub collateral_mint: Account<'info, Mint>,

    // One perp market per collateral mint (this project only lists
    // SOL-PERP margined in USDC; a real venue adds a symbol seed).
    #[account(
        init,
        payer = payer,
        space = 8 + PerpMarket::INIT_SPACE,
        seeds = [PerpMarket::SEED_PREFIX, collateral_mint.key().as_ref()],
        bump
    )]
    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        init,
        payer = payer,
        seeds = [b"perp_vault", perp_market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = perp_market,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<InitPerpMarket>,
    oracle_price: u64,
    funding_interval: i64,
    max_funding_bps: u16,
    taker_fee_bps: u16,
    init_margin_bps: u16,
    maint_margin_bps: u16,
    liq_fee_bps: u16,
) -> Result<()> {
    require!(oracle_price > 0, ClobError::InvalidPerpParams);
    require!(funding_interval > 0, ClobError::InvalidPerpParams);
    require!(taker_fee_bps <= MAX_FEE_BPS, ClobError::InvalidPerpParams);
    require!(liq_fee_bps <= MAX_FEE_BPS, ClobError::InvalidPerpParams);
    // Maintenance must sit strictly below initial or every freshly
    // opened max-leverage position would be instantly liquidatable.
    require!(
        maint_margin_bps > 0 && maint_margin_bps < init_margin_bps,
        ClobError::InvalidPerpParams
    );

    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.perp_market;
    market.admin = ctx.accounts.payer.key();
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.collateral_vault = ctx.accounts.collateral_vault.key();
    market.oracle_price = oracle_price;
    market.oracle_ts = now;
    market.cum_funding = 0;
    market.last_funding_ts = now;
    market.funding_interval = funding_interval;
    market.max_funding_bps = max_funding_bps;
    market.taker_fee_bps = taker_fee_bps;
    market.init_margin_bps = init_margin_bps;
    market.maint_margin_bps = maint_margin_bps;
    market.liq_fee_bps = liq_fee_bps;
    market.long_oi = 0;
    market.short_oi = 0;
    market.fees_accrued = 0;
    market.bump = ctx.bumps.perp_market;

    emit!(PerpMarketInitialized {
        market: market.key(),
        collateral_mint: market.collateral_mint,
        oracle_price,
        taker_fee_bps,
        init_margin_bps,
        maint_margin_bps,
        max_funding_bps,
    });
    Ok(())
}
