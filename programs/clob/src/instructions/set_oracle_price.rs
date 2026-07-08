use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::OraclePriceSet;
use crate::state::PerpMarket;

/// Keeper-pushed oracle. Gated to the market admin; on devnet this
/// instruction disappears and `PerpMarket::oracle_price` is replaced by
/// a read of a Pyth price account with the same freshness rule.
#[derive(Accounts)]
pub struct SetOraclePrice<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub perp_market: Account<'info, PerpMarket>,
}

pub fn handler(ctx: Context<SetOraclePrice>, price: u64) -> Result<()> {
    require!(price > 0, ClobError::InvalidPerpParams);
    let market = &mut ctx.accounts.perp_market;
    market.oracle_price = price;
    market.oracle_ts = Clock::get()?.unix_timestamp;

    emit!(OraclePriceSet {
        market: market.key(),
        price,
        ts: market.oracle_ts,
    });
    Ok(())
}
