use anchor_lang::prelude::*;
use bytemuck::Zeroable;

use crate::errors::ClobError;

/// Which side of the book an order rests on / an instruction targets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid,
    Ask,
}

/// How an incoming order interacts with the opposite side of the book.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrderType {
    /// Match as far as the limit price allows, rest the remainder.
    Limit,
    /// Maker-only: reject instead of matching if the price would cross.
    PostOnly,
    /// Match as far as the limit price allows, drop the remainder.
    /// A "market order" is an IOC at the worst price you'll accept.
    ImmediateOrCancel,
}

pub const MAX_ORDERS_PER_SIDE: usize = 128;

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

/// One resting order. 56 bytes, `Pod` so it can live in a zero-copy array.
#[zero_copy]
#[derive(Debug)]
pub struct Order {
    pub order_id: u64,
    pub owner: Pubkey,
    /// In ticks (quote atoms per base lot = price × tick_size).
    pub price: u64,
    /// Remaining quantity in base lots.
    pub qty: u64,
}

/// One side of the book, kept sorted best-first with time priority
/// within a price level.
///
/// This is a *zero-copy* account: at ~7.2 KB it is too large to borsh
/// round-trip on every instruction within Solana's compute/stack budget,
/// so Anchor `bytemuck`-casts the raw account bytes in place instead
/// (that's also why every field must be `Pod`: fixed layout, no enums,
/// no Options, explicit padding).
///
/// A sorted array with linear shifts is O(n) per insert — fine for 128
/// orders and easy to reason about. Replacing it with a crit-bit tree /
/// slab like Serum's (thousands of orders, O(log n)) is a planned
/// milestone-2 exercise; the instruction interface won't change.
#[account(zero_copy)]
pub struct OrderBookSide {
    pub market: Pubkey,
    /// `SIDE_BID` or `SIDE_ASK`.
    pub side: u8,
    pub _padding: [u8; 5],
    pub num_orders: u16,
    pub orders: [Order; MAX_ORDERS_PER_SIDE],
}

impl OrderBookSide {
    pub const LEN: usize = 8 + std::mem::size_of::<OrderBookSide>();

    pub fn is_full(&self) -> bool {
        self.num_orders as usize >= MAX_ORDERS_PER_SIDE
    }

    /// Best order = index 0 (highest bid / lowest ask).
    pub fn best(&self) -> Option<&Order> {
        if self.num_orders == 0 {
            None
        } else {
            Some(&self.orders[0])
        }
    }

    /// Is price `a` strictly better than `b` on this side?
    fn is_better(&self, a: u64, b: u64) -> bool {
        if self.side == SIDE_BID {
            a > b
        } else {
            a < b
        }
    }

    /// Insert keeping best-first order. Scanning for the first strictly
    /// worse slot (not `>=`) puts the new order *after* existing orders
    /// at the same price — that is the time-priority guarantee.
    pub fn insert(&mut self, order: Order) -> Result<()> {
        require!(!self.is_full(), ClobError::OrderBookFull);
        let n = self.num_orders as usize;

        let mut idx = n;
        for i in 0..n {
            if self.is_better(order.price, self.orders[i].price) {
                idx = i;
                break;
            }
        }
        for j in (idx..n).rev() {
            self.orders[j + 1] = self.orders[j];
        }
        self.orders[idx] = order;
        self.num_orders = self.num_orders.checked_add(1).unwrap();
        Ok(())
    }

    /// Consume `qty` lots from the best order (the taker just traded
    /// against it). Removes the order if fully filled. Returns whether it
    /// was removed. `qty` must not exceed the best order's remaining
    /// quantity — the matching loop guarantees this.
    pub fn fill_best(&mut self, qty: u64) -> Result<bool> {
        require!(self.num_orders > 0, ClobError::OrderNotFound);
        let best = &mut self.orders[0];
        best.qty = best.qty.checked_sub(qty).ok_or(ClobError::MathOverflow)?;
        if best.qty > 0 {
            return Ok(false);
        }
        let n = self.num_orders as usize;
        for j in 0..n - 1 {
            self.orders[j] = self.orders[j + 1];
        }
        self.orders[n - 1] = Order::zeroed();
        self.num_orders -= 1;
        Ok(true)
    }

    /// Remove `order_id`, verifying `owner` actually owns it, and return
    /// the removed order so the caller can unlock the funds backing it.
    pub fn remove(&mut self, order_id: u64, owner: &Pubkey) -> Result<Order> {
        let n = self.num_orders as usize;
        let idx = self.orders[..n]
            .iter()
            .position(|o| o.order_id == order_id)
            .ok_or(ClobError::OrderNotFound)?;
        require_keys_eq!(self.orders[idx].owner, *owner, ClobError::NotOrderOwner);

        let removed = self.orders[idx];
        for j in idx..n - 1 {
            self.orders[j] = self.orders[j + 1];
        }
        self.orders[n - 1] = Order::zeroed();
        self.num_orders -= 1;
        Ok(removed)
    }
}
