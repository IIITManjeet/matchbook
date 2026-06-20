use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::OrderCanceled;
use crate::state::{Market, OpenOrders, OrderBookSide, Side};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,

    #[account(has_one = bids, has_one = asks)]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [OpenOrders::SEED_PREFIX, market.key().as_ref(), owner.key().as_ref()],
        bump = open_orders.bump,
        has_one = market,
        has_one = owner,
    )]
    pub open_orders: Account<'info, OpenOrders>,

    #[account(mut)]
    pub bids: AccountLoader<'info, OrderBookSide>,

    #[account(mut)]
    pub asks: AccountLoader<'info, OrderBookSide>,
}

pub fn handler(ctx: Context<CancelOrder>, side: Side, order_id: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    let oo = &mut ctx.accounts.open_orders;

    // `remove` verifies the order exists and that the signer owns it,
    // and hands the order back so we know how much to unlock.
    let removed = match side {
        Side::Bid => ctx.accounts.bids.load_mut()?.remove(order_id, &oo.owner)?,
        Side::Ask => ctx.accounts.asks.load_mut()?.remove(order_id, &oo.owner)?,
    };

    // Mirror image of the lock in place_limit_order.
    match side {
        Side::Bid => {
            let quote_locked = removed
                .price
                .checked_mul(removed.qty)
                .and_then(|x| x.checked_mul(market.tick_size))
                .ok_or(ClobError::MathOverflow)?;
            oo.quote_locked = oo
                .quote_locked
                .checked_sub(quote_locked)
                .ok_or(ClobError::MathOverflow)?;
            oo.quote_free = oo
                .quote_free
                .checked_add(quote_locked)
                .ok_or(ClobError::MathOverflow)?;
        }
        Side::Ask => {
            let base_locked = removed
                .qty
                .checked_mul(market.base_lot_size)
                .ok_or(ClobError::MathOverflow)?;
            oo.base_locked = oo
                .base_locked
                .checked_sub(base_locked)
                .ok_or(ClobError::MathOverflow)?;
            oo.base_free = oo
                .base_free
                .checked_add(base_locked)
                .ok_or(ClobError::MathOverflow)?;
        }
    }

    emit!(OrderCanceled {
        market: market.key(),
        order_id,
        owner: oo.owner,
    });
    Ok(())
}
