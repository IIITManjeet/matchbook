use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::{OrderFilled, OrderPlaced};
use crate::state::{
    EventQueue, FillEvent, Market, OpenOrders, Order, OrderBookSide, OrderType, Side, SIDE_ASK,
    SIDE_BID,
};

/// Cap on fills per instruction so matching stays inside the compute
/// budget regardless of how fragmented the opposite side is. If a taker
/// is still crossing after this many fills, the remainder is dropped
/// (treated as IOC) — it can never rest, because resting a crossing
/// order would leave the book crossed.
pub const MAX_FILLS_PER_IX: usize = 16;

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,

    // `mut`: bumps `next_order_id` and accrues taker fees. The `has_one`
    // constraints pin the books and event queue to *this* market.
    #[account(mut, has_one = bids, has_one = asks, has_one = event_queue)]
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

    #[account(mut)]
    pub event_queue: AccountLoader<'info, EventQueue>,

    // Still no token accounts: matching moves ledger entries, not tokens.
    // The taker's side of every fill settles synchronously against
    // `open_orders`; the makers' sides go through the event queue.
}

fn crosses(side: Side, taker_price: u64, maker_price: u64) -> bool {
    match side {
        Side::Bid => taker_price >= maker_price,
        Side::Ask => taker_price <= maker_price,
    }
}

/// Taker fee in quote atoms, rounded *up* so fee dust always favors the
/// exchange rather than being farmable one atom at a time.
fn taker_fee(notional: u64, fee_bps: u16) -> Result<u64> {
    let numer = notional
        .checked_mul(fee_bps as u64)
        .ok_or(ClobError::MathOverflow)?;
    Ok(numer.div_ceil(10_000))
}

pub fn handler(
    ctx: Context<PlaceOrder>,
    side: Side,
    price: u64,
    qty: u64,
    order_type: OrderType,
) -> Result<()> {
    require!(price > 0 && qty > 0, ClobError::InvalidOrderParams);

    let market = &mut ctx.accounts.market;
    let market_key = market.key();
    let oo = &mut ctx.accounts.open_orders;

    let taker_order_id = market.next_order_id;
    market.next_order_id = market
        .next_order_id
        .checked_add(1)
        .ok_or(ClobError::MathOverflow)?;

    let mut remaining = qty;

    // ── Match against the opposite side ────────────────────────────────
    {
        let mut opposite = match side {
            Side::Bid => ctx.accounts.asks.load_mut()?,
            Side::Ask => ctx.accounts.bids.load_mut()?,
        };

        if order_type == OrderType::PostOnly {
            // Maker-only orders never match; reject if they would.
            if let Some(best) = opposite.best() {
                require!(!crosses(side, price, best.price), ClobError::WouldCross);
            }
        } else {
            let mut queue = ctx.accounts.event_queue.load_mut()?;
            let mut fills = 0usize;

            while remaining > 0 && fills < MAX_FILLS_PER_IX {
                let Some(best) = opposite.best() else { break };
                if !crosses(side, price, best.price) {
                    break;
                }
                // Matching your own resting order is rejected outright:
                // wash trades would pay fees for nothing and complicate
                // settlement (maker == taker). Cancel it first.
                require_keys_neq!(best.owner, oo.owner, ClobError::SelfTrade);

                let fill_qty = remaining.min(best.qty);
                let fill_price = best.price; // maker's price: price improvement goes to the taker
                let maker = best.owner;
                let maker_order_id = best.order_id;

                let notional = fill_price
                    .checked_mul(fill_qty)
                    .and_then(|x| x.checked_mul(market.tick_size))
                    .ok_or(ClobError::MathOverflow)?;
                let base_atoms = fill_qty
                    .checked_mul(market.base_lot_size)
                    .ok_or(ClobError::MathOverflow)?;
                let fee = taker_fee(notional, market.taker_fee_bps)?;

                // Taker settles synchronously — their OpenOrders is here.
                // Bid takers pay the fee on top; ask takers receive
                // proceeds net of fee. Any failure reverts the whole tx.
                match side {
                    Side::Bid => {
                        let debit = notional.checked_add(fee).ok_or(ClobError::MathOverflow)?;
                        require!(oo.quote_free >= debit, ClobError::InsufficientFunds);
                        oo.quote_free -= debit;
                        oo.base_free = oo
                            .base_free
                            .checked_add(base_atoms)
                            .ok_or(ClobError::MathOverflow)?;
                    }
                    Side::Ask => {
                        require!(oo.base_free >= base_atoms, ClobError::InsufficientFunds);
                        oo.base_free -= base_atoms;
                        let credit = notional.checked_sub(fee).ok_or(ClobError::MathOverflow)?;
                        oo.quote_free = oo
                            .quote_free
                            .checked_add(credit)
                            .ok_or(ClobError::MathOverflow)?;
                    }
                }
                market.fees_accrued = market
                    .fees_accrued
                    .checked_add(fee)
                    .ok_or(ClobError::MathOverflow)?;

                // Maker settles later: record the fill for the crank.
                opposite.fill_best(fill_qty)?;
                queue.push(FillEvent {
                    maker,
                    taker: oo.owner,
                    maker_order_id,
                    taker_order_id,
                    price: fill_price,
                    qty: fill_qty,
                    seq: 0, // assigned by push
                    taker_side: if side == Side::Bid { SIDE_BID } else { SIDE_ASK },
                    _padding: [0; 7],
                })?;

                emit!(OrderFilled {
                    market: market_key,
                    maker,
                    taker: oo.owner,
                    maker_order_id,
                    taker_order_id,
                    taker_side: if side == Side::Bid { SIDE_BID } else { SIDE_ASK },
                    price: fill_price,
                    qty: fill_qty,
                    taker_fee: fee,
                });

                remaining -= fill_qty;
                fills += 1;
            }
        }
    }

    // ── Rest the remainder (Limit / PostOnly only) ─────────────────────
    if remaining == 0 || order_type == OrderType::ImmediateOrCancel {
        return Ok(());
    }

    // If the fill cap was hit while still crossing, the remainder must
    // not rest (the book would be crossed) — drop it like an IOC.
    let still_crossing = {
        let opposite = match side {
            Side::Bid => ctx.accounts.asks.load()?,
            Side::Ask => ctx.accounts.bids.load()?,
        };
        opposite
            .best()
            .is_some_and(|best| crosses(side, price, best.price))
    };
    if still_crossing {
        return Ok(());
    }

    // Lock the funds that back the resting remainder (mirror of cancel).
    match side {
        Side::Bid => {
            let quote_needed = price
                .checked_mul(remaining)
                .and_then(|x| x.checked_mul(market.tick_size))
                .ok_or(ClobError::MathOverflow)?;
            require!(oo.quote_free >= quote_needed, ClobError::InsufficientFunds);
            oo.quote_free -= quote_needed;
            oo.quote_locked = oo
                .quote_locked
                .checked_add(quote_needed)
                .ok_or(ClobError::MathOverflow)?;
        }
        Side::Ask => {
            let base_needed = remaining
                .checked_mul(market.base_lot_size)
                .ok_or(ClobError::MathOverflow)?;
            require!(oo.base_free >= base_needed, ClobError::InsufficientFunds);
            oo.base_free -= base_needed;
            oo.base_locked = oo
                .base_locked
                .checked_add(base_needed)
                .ok_or(ClobError::MathOverflow)?;
        }
    }

    let order = Order {
        order_id: taker_order_id,
        owner: oo.owner,
        price,
        qty: remaining,
    };
    match side {
        Side::Bid => ctx.accounts.bids.load_mut()?.insert(order)?,
        Side::Ask => ctx.accounts.asks.load_mut()?.insert(order)?,
    }

    emit!(OrderPlaced {
        market: market_key,
        order_id: taker_order_id,
        owner: oo.owner,
        side: if side == Side::Bid { SIDE_BID } else { SIDE_ASK },
        price,
        qty: remaining,
    });
    Ok(())
}
