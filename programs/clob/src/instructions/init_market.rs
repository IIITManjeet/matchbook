use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::ClobError;
use crate::events::MarketInitialized;
use crate::state::{EventQueue, Market, OrderBookSide, SIDE_ASK, SIDE_BID};

const MAX_TAKER_FEE_BPS: u16 = 500; // 5%

/// Five accounts are created in one instruction — this is the densest
/// Anchor lesson in the codebase:
/// - `market` is a PDA keyed by the mint pair (uniqueness for free);
/// - the vaults are token accounts whose *authority is the market PDA*,
///   i.e. only this program can sign transfers out of them;
/// - `bids`/`asks` are zero-copy accounts, so Anchor gives us an
///   `AccountLoader` and we must call `load_init` exactly once here.
#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [Market::SEED_PREFIX, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = payer,
        seeds = [b"base_vault", market.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = market,
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [b"quote_vault", market.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = market,
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = OrderBookSide::LEN,
        seeds = [b"bids", market.key().as_ref()],
        bump
    )]
    pub bids: AccountLoader<'info, OrderBookSide>,

    #[account(
        init,
        payer = payer,
        space = OrderBookSide::LEN,
        seeds = [b"asks", market.key().as_ref()],
        bump
    )]
    pub asks: AccountLoader<'info, OrderBookSide>,

    #[account(
        init,
        payer = payer,
        space = EventQueue::LEN,
        seeds = [EventQueue::SEED_PREFIX, market.key().as_ref()],
        bump
    )]
    pub event_queue: AccountLoader<'info, EventQueue>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitMarket>,
    tick_size: u64,
    base_lot_size: u64,
    taker_fee_bps: u16,
) -> Result<()> {
    require!(tick_size > 0, ClobError::InvalidMarketParams);
    require!(base_lot_size > 0, ClobError::InvalidMarketParams);
    require!(taker_fee_bps <= MAX_TAKER_FEE_BPS, ClobError::InvalidMarketParams);
    require_keys_neq!(
        ctx.accounts.base_mint.key(),
        ctx.accounts.quote_mint.key(),
        ClobError::InvalidMarketParams
    );

    let market = &mut ctx.accounts.market;
    market.base_mint = ctx.accounts.base_mint.key();
    market.quote_mint = ctx.accounts.quote_mint.key();
    market.base_vault = ctx.accounts.base_vault.key();
    market.quote_vault = ctx.accounts.quote_vault.key();
    market.bids = ctx.accounts.bids.key();
    market.asks = ctx.accounts.asks.key();
    market.event_queue = ctx.accounts.event_queue.key();
    market.tick_size = tick_size;
    market.base_lot_size = base_lot_size;
    market.taker_fee_bps = taker_fee_bps;
    market.next_order_id = 1;
    market.bump = ctx.bumps.market;

    let mut bids = ctx.accounts.bids.load_init()?;
    bids.market = market.key();
    bids.side = SIDE_BID;

    let mut asks = ctx.accounts.asks.load_init()?;
    asks.market = market.key();
    asks.side = SIDE_ASK;

    let mut event_queue = ctx.accounts.event_queue.load_init()?;
    event_queue.market = market.key();

    emit!(MarketInitialized {
        market: market.key(),
        base_mint: market.base_mint,
        quote_mint: market.quote_mint,
        tick_size,
        base_lot_size,
    });
    Ok(())
}
