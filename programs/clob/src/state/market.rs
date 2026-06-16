use anchor_lang::prelude::*;

/// One market per (base, quote) mint pair.
///
/// PDA: `["market", base_mint, quote_mint]` — deriving the address from
/// the mint pair is what makes markets unique and permissionless: nobody
/// has to maintain a registry, and the same pair can never be created
/// twice.
///
/// Units convention (same scheme Serum/OpenBook use):
/// - a *lot* is the smallest tradeable base quantity: `base_lot_size`
///   base atoms.
/// - a *tick* is the smallest price increment: `tick_size` quote atoms
///   paid per base lot.
/// - so an order of `qty` lots at `price` ticks moves
///   `qty * base_lot_size` base atoms against `qty * price * tick_size`
///   quote atoms — all integer math, no floats on-chain.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Token vault holding all deposited base tokens. Its authority is
    /// this market PDA, so only the program can move funds out.
    pub base_vault: Pubkey,
    /// Token vault holding all deposited quote tokens.
    pub quote_vault: Pubkey,
    /// Zero-copy orderbook side accounts.
    pub bids: Pubkey,
    pub asks: Pubkey,
    /// Zero-copy fill-event ring buffer, drained by the consume_events
    /// crank (see `state/event_queue.rs` for why it exists).
    pub event_queue: Pubkey,
    /// Quote atoms per (base lot × tick).
    pub tick_size: u64,
    /// Base atoms per lot.
    pub base_lot_size: u64,
    /// Taker fee in basis points, charged on quote notional per fill.
    pub taker_fee_bps: u16,
    /// Quote atoms collected from taker fees. Sits in the quote vault;
    /// a fee-withdrawal authority is deliberately out of scope until M3.
    pub fees_accrued: u64,
    /// Monotonic order id counter, unique within this market.
    pub next_order_id: u64,
    pub bump: u8,
}

impl Market {
    pub const SEED_PREFIX: &'static [u8] = b"market";
}
