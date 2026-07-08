use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::PerpPositionChanged;
use crate::state::{MarginAccount, PerpMarket, BASE_UNIT, BPS};

/// Trade against the oracle price: `delta` base atoms (+ long, − short).
///
/// One instruction covers open, add, reduce, close and flip — the
/// netting rules are where perp accounting actually lives:
/// - extending a position moves the volume-weighted entry price;
/// - reducing realizes PnL on the closed portion at the fill price;
/// - flipping realizes the whole old position and opens the remainder
///   fresh at the fill price.
///
/// Invariants: funding is settled before anything moves, and the
/// resulting position must clear *initial* margin at the fill price.
#[derive(Accounts)]
pub struct OpenPosition<'info> {
    pub owner: Signer<'info>,

    #[account(mut)]
    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        mut,
        seeds = [MarginAccount::SEED_PREFIX, perp_market.key().as_ref(), owner.key().as_ref()],
        bump = margin_account.bump,
        has_one = owner,
    )]
    pub margin_account: Account<'info, MarginAccount>,
}

pub fn handler(ctx: Context<OpenPosition>, delta: i64, price_limit: u64) -> Result<()> {
    require!(delta != 0, ClobError::InvalidOrderParams);

    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.perp_market;
    let ma = &mut ctx.accounts.margin_account;

    let price = market.require_fresh_oracle(now)?;
    // The oracle can move between signing and execution; the limit is
    // the user's slippage guard (max price for longs, min for shorts).
    if delta > 0 {
        require!(price <= price_limit, ClobError::PriceSlippage);
    } else {
        require!(price >= price_limit, ClobError::PriceSlippage);
    }

    ma.settle_funding(market);

    // Taker fee on the traded notional, rounded up (dust favors the
    // exchange, same rule as the spot book).
    let trade_size = delta.unsigned_abs();
    let notional = PerpMarket::notional(trade_size, price)?;
    let fee_wide = (notional as u128)
        .checked_mul(market.taker_fee_bps as u128)
        .ok_or(ClobError::MathOverflow)?
        .div_ceil(BPS);
    let fee = u64::try_from(fee_wide).map_err(|_| ClobError::MathOverflow)?;
    require!(ma.collateral >= fee, ClobError::InsufficientFunds);
    ma.collateral -= fee;
    market.fees_accrued = market
        .fees_accrued
        .checked_add(fee)
        .ok_or(ClobError::MathOverflow)?;

    let old = ma.base_position;
    let new = old.checked_add(delta).ok_or(ClobError::MathOverflow)?;
    let mut realized: i128 = 0;

    if old == 0 || (old > 0) == (delta > 0) {
        // Extend: new volume-weighted entry. u128 is safe — both terms
        // are ≤ 2^63 × 2^64.
        let old_abs = old.unsigned_abs() as u128;
        let add_abs = trade_size as u128;
        let vwap = (old_abs * ma.avg_entry_price as u128 + add_abs * price as u128)
            / (old_abs + add_abs);
        ma.avg_entry_price = u64::try_from(vwap).map_err(|_| ClobError::MathOverflow)?;
    } else {
        // Reduce (and possibly flip): realize the closed portion.
        let close = trade_size.min(old.unsigned_abs());
        let direction: i128 = if old > 0 { 1 } else { -1 };
        realized = direction * (price as i128 - ma.avg_entry_price as i128) * close as i128
            / BASE_UNIT as i128;
        ma.apply_realized(realized);

        if new == 0 {
            ma.avg_entry_price = 0;
        } else if (new > 0) != (old > 0) {
            ma.avg_entry_price = price; // flipped: remainder is a fresh position
        }
    }

    // Open-interest bookkeeping: retire the old contribution, add the new.
    if old > 0 {
        market.long_oi = market
            .long_oi
            .checked_sub(old as u64)
            .ok_or(ClobError::MathOverflow)?;
    } else if old < 0 {
        market.short_oi = market
            .short_oi
            .checked_sub(old.unsigned_abs())
            .ok_or(ClobError::MathOverflow)?;
    }
    if new > 0 {
        market.long_oi = market
            .long_oi
            .checked_add(new as u64)
            .ok_or(ClobError::MathOverflow)?;
    } else if new < 0 {
        market.short_oi = market
            .short_oi
            .checked_add(new.unsigned_abs())
            .ok_or(ClobError::MathOverflow)?;
    }

    ma.base_position = new;

    if new != 0 {
        let required = MarginAccount::margin_required(new, price, market.init_margin_bps)?;
        require!(
            ma.equity(market, price) >= required as i128,
            ClobError::BelowInitialMargin
        );
    }

    emit!(PerpPositionChanged {
        market: market.key(),
        owner: ma.owner,
        delta,
        price,
        fee,
        realized_pnl: i64::try_from(realized).unwrap_or(i64::MAX),
        base_position_after: new,
        collateral_after: ma.collateral,
    });
    Ok(())
}
