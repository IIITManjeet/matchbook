use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::FundingUpdated;
use crate::state::{PerpMarket, BPS, SECONDS_PER_DAY};

/// Permissionless funding crank — the perp twin of `consume_events`.
///
/// The premium comes from open-interest skew: if longs outweigh shorts
/// the accumulator rises and longs pay shorts, pushing the imbalance
/// back. Accrual is pro-rata for elapsed time against a bps/day rate,
/// so an unreliable cranker changes the *granularity* of funding, never
/// the total owed.
#[derive(Accounts)]
pub struct UpdateFunding<'info> {
    pub cranker: Signer<'info>,

    #[account(mut)]
    pub perp_market: Account<'info, PerpMarket>,
}

pub fn handler(ctx: Context<UpdateFunding>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.perp_market;

    let elapsed = now - market.last_funding_ts;
    require!(elapsed >= market.funding_interval, ClobError::FundingTooSoon);

    let price = market.require_fresh_oracle(now)?;
    let premium_bps = market.funding_premium_bps();

    let delta = price as i128 * premium_bps as i128 * elapsed as i128
        / (BPS as i128 * SECONDS_PER_DAY);
    market.cum_funding = market
        .cum_funding
        .checked_add(delta)
        .ok_or(ClobError::MathOverflow)?;
    market.last_funding_ts = now;

    emit!(FundingUpdated {
        market: market.key(),
        premium_bps,
        cum_funding: market.cum_funding,
        ts: now,
    });
    Ok(())
}
