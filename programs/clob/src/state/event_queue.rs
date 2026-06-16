use anchor_lang::prelude::*;

use crate::errors::ClobError;

/// Sized so the whole account stays under 10,240 bytes: accounts created
/// through a CPI (which is what Anchor `init` does from inside
/// init_market) cannot exceed that. 90 events × 112 B + 64 B header +
/// 8 B discriminator = 10,152 B. Going bigger means creating the account
/// in its own top-level instruction, Serum-style — planned alongside the
/// crit-bit slab.
pub const MAX_EVENTS: usize = 90;

/// One fill, as recorded by the matching engine for later settlement.
///
/// Field order is chosen so the struct packs with no implicit padding
/// (Pod requires a fixed, fully-specified layout): pubkeys first, then
/// u64s, then the flag byte plus explicit padding. 112 bytes.
#[zero_copy]
#[derive(Debug)]
pub struct FillEvent {
    /// Wallet that owned the resting (maker) order.
    pub maker: Pubkey,
    /// Wallet whose taker order caused the fill.
    pub taker: Pubkey,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    /// Fill price in ticks — always the *maker's* price.
    pub price: u64,
    /// Fill quantity in base lots.
    pub qty: u64,
    /// Monotonic sequence number, unique within the market.
    pub seq: u64,
    /// Side of the *taker* (`SIDE_BID`/`SIDE_ASK`). The maker is by
    /// definition on the opposite side; consume_events uses this to know
    /// which balance to unlock and which to credit.
    pub taker_side: u8,
    pub _padding: [u8; 7],
}

/// Ring buffer of fills awaiting settlement by the crank.
///
/// Why this exists: when a taker matches a resting order, the maker's
/// proceeds must be credited to the maker's OpenOrders — but that account
/// was not (and cannot be) passed in the taker's transaction. Matching
/// therefore records the fill here, and anyone may later call
/// `consume_events` with a batch of maker OpenOrders accounts to apply
/// the credits. Same design as Serum/OpenBook.
///
/// If the queue fills up, matching aborts (`EventQueueFull`) until a
/// crank drains it — maker funds are never silently dropped.
#[account(zero_copy)]
pub struct EventQueue {
    pub market: Pubkey,
    /// Index of the oldest unconsumed event.
    pub head: u64,
    /// Number of unconsumed events.
    pub count: u64,
    /// Total events ever pushed (next event's `seq`).
    pub seq: u64,
    pub events: [FillEvent; MAX_EVENTS],
}

impl EventQueue {
    pub const SEED_PREFIX: &'static [u8] = b"events";
    pub const LEN: usize = 8 + std::mem::size_of::<EventQueue>();

    pub fn push(&mut self, mut event: FillEvent) -> Result<()> {
        require!(
            (self.count as usize) < MAX_EVENTS,
            ClobError::EventQueueFull
        );
        event.seq = self.seq;
        let idx = (self.head + self.count) % MAX_EVENTS as u64;
        self.events[idx as usize] = event;
        self.count += 1;
        self.seq = self.seq.checked_add(1).ok_or(ClobError::MathOverflow)?;
        Ok(())
    }

    pub fn peek(&self) -> Option<&FillEvent> {
        if self.count == 0 {
            None
        } else {
            Some(&self.events[self.head as usize])
        }
    }

    pub fn pop(&mut self) {
        if self.count > 0 {
            self.head = (self.head + 1) % MAX_EVENTS as u64;
            self.count -= 1;
        }
    }
}
