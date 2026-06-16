use anchor_lang::prelude::*;

/// A user's balance sheet for one market.
///
/// PDA: `["open_orders", market, owner]` — one per (wallet, market).
///
/// Funds move through three stages:
///   wallet ──deposit──▶ free ──place order──▶ locked ──cancel──▶ free
/// and `free ──withdraw──▶ wallet`. The tokens themselves always sit in
/// the market vaults; these fields are the program's ledger over them.
/// Locked balances back resting orders, so they can never be withdrawn
/// out from under the book.
#[account]
#[derive(InitSpace)]
pub struct OpenOrders {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Base atoms available to withdraw or place asks with.
    pub base_free: u64,
    /// Base atoms backing resting ask orders.
    pub base_locked: u64,
    /// Quote atoms available to withdraw or place bids with.
    pub quote_free: u64,
    /// Quote atoms backing resting bid orders.
    pub quote_locked: u64,
    pub bump: u8,
}

impl OpenOrders {
    pub const SEED_PREFIX: &'static [u8] = b"open_orders";
}
