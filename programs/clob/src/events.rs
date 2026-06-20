//! Anchor events are borsh-serialized into program logs. Off-chain
//! indexers (milestone 3) subscribe to these via websocket instead of
//! polling account state.

use anchor_lang::prelude::*;

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub tick_size: u64,
    pub base_lot_size: u64,
}

#[event]
pub struct Deposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
    /// 0 = bid, 1 = ask
    pub side: u8,
    /// In ticks.
    pub price: u64,
    /// In base lots.
    pub qty: u64,
}

#[event]
pub struct OrderCanceled {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
}

#[event]
pub struct OrderFilled {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    /// 0 = bid, 1 = ask — the side of the *taker*.
    pub taker_side: u8,
    /// Fill price in ticks (the maker's price).
    pub price: u64,
    /// Fill quantity in base lots.
    pub qty: u64,
    /// Taker fee for this fill, in quote atoms.
    pub taker_fee: u64,
}

#[event]
pub struct EventsConsumed {
    pub market: Pubkey,
    /// Number of fill events settled by this crank turn.
    pub count: u64,
}
