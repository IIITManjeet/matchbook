//! In-memory orderbook mirrors, rebuilt purely from the event stream.
//!
//! This works because of an on-chain guarantee: `OrderPlaced` is emitted
//! only when a remainder actually *rests* (with the resting qty), while
//! taker flow shows up exclusively as `OrderFilled` against a resting
//! maker order. So placed − filled − canceled = the live book.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

pub const SIDE_BID: u8 = 0;

#[derive(Debug, Clone, Copy)]
struct RestingOrder {
    side: u8,
    price: u64,
    qty: u64,
}

/// One market's book: order-level state plus aggregated price levels.
#[derive(Default)]
pub struct Book {
    orders: HashMap<u64, RestingOrder>,
    bids: BTreeMap<u64, u64>, // price -> total qty
    asks: BTreeMap<u64, u64>,
}

/// A change to a single price level; `qty` is the new total (0 = gone).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LevelDelta {
    pub side: u8,
    pub price: u64,
    pub qty: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookSnapshot {
    /// [price, qty] best-first.
    pub bids: Vec<[u64; 2]>,
    pub asks: Vec<[u64; 2]>,
}

impl Book {
    fn levels_mut(&mut self, side: u8) -> &mut BTreeMap<u64, u64> {
        if side == SIDE_BID {
            &mut self.bids
        } else {
            &mut self.asks
        }
    }

    fn adjust_level(&mut self, side: u8, price: u64, delta_qty: i128) -> LevelDelta {
        let levels = self.levels_mut(side);
        let current = *levels.get(&price).unwrap_or(&0) as i128;
        let next = (current + delta_qty).max(0) as u64;
        if next == 0 {
            levels.remove(&price);
        } else {
            levels.insert(price, next);
        }
        LevelDelta { side, price, qty: next }
    }

    pub fn place(&mut self, order_id: u64, side: u8, price: u64, qty: u64) -> LevelDelta {
        self.orders.insert(order_id, RestingOrder { side, price, qty });
        self.adjust_level(side, price, qty as i128)
    }

    /// Apply a fill against a resting maker order. Unknown ids (e.g. the
    /// indexer started mid-stream without backfill) are ignored.
    pub fn fill(&mut self, maker_order_id: u64, qty: u64) -> Option<LevelDelta> {
        let order = self.orders.get_mut(&maker_order_id)?;
        let take = qty.min(order.qty);
        order.qty -= take;
        let (side, price) = (order.side, order.price);
        if order.qty == 0 {
            self.orders.remove(&maker_order_id);
        }
        Some(self.adjust_level(side, price, -(take as i128)))
    }

    pub fn cancel(&mut self, order_id: u64) -> Option<LevelDelta> {
        let order = self.orders.remove(&order_id)?;
        Some(self.adjust_level(order.side, order.price, -(order.qty as i128)))
    }

    pub fn snapshot(&self, depth: usize) -> BookSnapshot {
        BookSnapshot {
            bids: self
                .bids
                .iter()
                .rev() // best bid = highest price
                .take(depth)
                .map(|(&p, &q)| [p, q])
                .collect(),
            asks: self
                .asks
                .iter() // best ask = lowest price
                .take(depth)
                .map(|(&p, &q)| [p, q])
                .collect(),
        }
    }
}

/// All markets' books.
#[derive(Default)]
pub struct Books {
    inner: HashMap<String, Book>,
}

impl Books {
    pub fn market_mut(&mut self, market: &str) -> &mut Book {
        self.inner.entry(market.to_string()).or_default()
    }

    pub fn market(&self, market: &str) -> Option<&Book> {
        self.inner.get(market)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASK: u8 = 1;

    #[test]
    fn place_fill_cancel_lifecycle() {
        let mut book = Book::default();

        book.place(1, SIDE_BID, 100, 10);
        book.place(2, SIDE_BID, 100, 5); // same level aggregates
        book.place(3, SIDE_BID, 99, 7);
        book.place(4, ASK, 101, 3);

        let snap = book.snapshot(10);
        assert_eq!(snap.bids, vec![[100, 15], [99, 7]]); // best-first
        assert_eq!(snap.asks, vec![[101, 3]]);

        // Partial fill of order 1.
        let d = book.fill(1, 4).unwrap();
        assert_eq!(d, LevelDelta { side: SIDE_BID, price: 100, qty: 11 });

        // Fill the rest of order 1; level keeps order 2's qty.
        let d = book.fill(1, 6).unwrap();
        assert_eq!(d.qty, 5);
        assert!(book.fill(1, 1).is_none()); // fully consumed → gone

        // Cancel order 2 → level disappears.
        let d = book.cancel(2).unwrap();
        assert_eq!(d.qty, 0);
        assert_eq!(book.snapshot(10).bids, vec![[99, 7]]);
    }

    #[test]
    fn unknown_ids_are_ignored() {
        let mut book = Book::default();
        assert!(book.fill(99, 1).is_none());
        assert!(book.cancel(99).is_none());
    }

    #[test]
    fn snapshot_depth_limits() {
        let mut book = Book::default();
        for i in 0..50u64 {
            book.place(i, ASK, 200 + i, 1);
        }
        let snap = book.snapshot(5);
        assert_eq!(snap.asks.len(), 5);
        assert_eq!(snap.asks[0], [200, 1]); // lowest ask first
    }
}
