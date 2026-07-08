use anchor_lang::prelude::*;

#[error_code]
pub enum ClobError {
    #[msg("Tick size, lot size and fee must be valid")]
    InvalidMarketParams,
    #[msg("Price and quantity must be greater than zero")]
    InvalidOrderParams,
    #[msg("Order book side is full")]
    OrderBookFull,
    #[msg("Order not found on the book")]
    OrderNotFound,
    #[msg("Order belongs to another wallet")]
    NotOrderOwner,
    #[msg("Insufficient free balance")]
    InsufficientFunds,
    #[msg("Post-only order would cross the book")]
    WouldCross,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Vault does not belong to this market")]
    InvalidVault,
    #[msg("Order would match against the caller's own resting order")]
    SelfTrade,
    #[msg("Event queue is full — run the consume_events crank")]
    EventQueueFull,
    #[msg("Perp market parameters are invalid")]
    InvalidPerpParams,
    #[msg("Oracle price is stale — the keeper must push a fresh price")]
    OracleStale,
    #[msg("Oracle price moved beyond the order's slippage limit")]
    PriceSlippage,
    #[msg("Position would fall below initial margin")]
    BelowInitialMargin,
    #[msg("Account is above maintenance margin — not liquidatable")]
    NotLiquidatable,
    #[msg("No position to act on")]
    NoPosition,
    #[msg("Funding was updated too recently")]
    FundingTooSoon,
}
