use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{OrderType, Side};

declare_id!("9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2");

/// A central limit orderbook (CLOB) spot exchange.
///
/// Milestone 1: markets, vaults, balances, post-only orders, cancels.
/// Milestone 2 (this code): taker matching, taker fees, fill-event queue
/// and the permissionless consume_events settlement crank.
/// Milestone 3: indexer, trading UI.
/// Milestone 4: perps (oracle, margin, funding, liquidation).
#[program]
pub mod clob {
    use super::*;

    /// Create a market for a base/quote mint pair, its two token vaults
    /// and its two orderbook sides. Permissionless: anyone can create a
    /// market for any mint pair (one market per pair, enforced by PDA).
    pub fn init_market(
        ctx: Context<InitMarket>,
        tick_size: u64,
        base_lot_size: u64,
        taker_fee_bps: u16,
    ) -> Result<()> {
        instructions::init_market::handler(ctx, tick_size, base_lot_size, taker_fee_bps)
    }

    /// Create the caller's per-market balance account. Required once per
    /// (wallet, market) before depositing or trading.
    pub fn create_open_orders(ctx: Context<CreateOpenOrders>) -> Result<()> {
        instructions::create_open_orders::handler(ctx)
    }

    /// Move tokens from the caller's wallet into a market vault and credit
    /// their free balance. `amount` is in raw token atoms.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Debit the caller's free balance and move tokens from the market
    /// vault back to their wallet. The vault is owned by the market PDA,
    /// so the program signs the transfer with the market's seeds.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Place an order. `price` is in ticks, `qty` in base lots.
    ///
    /// The order first matches against the opposite side as far as its
    /// limit price allows (unless PostOnly). The taker's balance changes
    /// settle immediately; every maker fill is pushed onto the event
    /// queue for the consume_events crank. Any remainder rests on the
    /// book (Limit/PostOnly) or is dropped (ImmediateOrCancel).
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        price: u64,
        qty: u64,
        order_type: OrderType,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, side, price, qty, order_type)
    }

    /// Settle up to `limit` fill events against the maker OpenOrders
    /// accounts supplied as remaining accounts. Permissionless — this is
    /// the crank any liquid market needs someone (M3: our indexer) to
    /// turn.
    pub fn consume_events<'info>(
        ctx: Context<'_, '_, 'info, 'info, ConsumeEvents<'info>>,
        limit: u16,
    ) -> Result<()> {
        instructions::consume_events::handler(ctx, limit)
    }

    /// Remove one of the caller's resting orders and unlock its funds.
    pub fn cancel_order(ctx: Context<CancelOrder>, side: Side, order_id: u64) -> Result<()> {
        instructions::cancel_order::handler(ctx, side, order_id)
    }

    /// Remove up to `limit` of the caller's resting orders across both
    /// sides in one transaction, unlocking as it goes.
    pub fn cancel_all(ctx: Context<CancelAll>, limit: u16) -> Result<()> {
        instructions::cancel_all::handler(ctx, limit)
    }

    // ── M4: perpetual futures ──────────────────────────────────────────

    /// Create a perp market margined in `collateral_mint`, its vault,
    /// and register the payer as admin / oracle keeper.
    #[allow(clippy::too_many_arguments)]
    pub fn init_perp_market(
        ctx: Context<InitPerpMarket>,
        oracle_price: u64,
        funding_interval: i64,
        max_funding_bps: u16,
        taker_fee_bps: u16,
        init_margin_bps: u16,
        maint_margin_bps: u16,
        liq_fee_bps: u16,
    ) -> Result<()> {
        instructions::init_perp_market::handler(
            ctx,
            oracle_price,
            funding_interval,
            max_funding_bps,
            taker_fee_bps,
            init_margin_bps,
            maint_margin_bps,
            liq_fee_bps,
        )
    }

    /// Keeper-pushed oracle price (admin only). Pyth replaces this on
    /// devnet — same freshness rule, different account to read.
    pub fn set_oracle_price(ctx: Context<SetOraclePrice>, price: u64) -> Result<()> {
        instructions::set_oracle_price::handler(ctx, price)
    }

    /// Create the caller's margin account for a perp market.
    pub fn create_margin_account(ctx: Context<CreateMarginAccount>) -> Result<()> {
        instructions::create_margin_account::handler(ctx)
    }

    /// Move collateral tokens into the perp vault.
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::collateral::deposit_handler(ctx, amount)
    }

    /// Withdraw free collateral; the remaining position must still
    /// clear initial margin at the current oracle price.
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        instructions::collateral::withdraw_handler(ctx, amount)
    }

    /// Trade `delta` base atoms (+ long, − short) against the oracle
    /// price, netting into the caller's existing position.
    pub fn open_position(ctx: Context<OpenPosition>, delta: i64, price_limit: u64) -> Result<()> {
        instructions::open_position::handler(ctx, delta, price_limit)
    }

    /// Permissionless funding crank: accrue the skew-derived premium
    /// into the market's cumulative funding index.
    pub fn update_funding(ctx: Context<UpdateFunding>) -> Result<()> {
        instructions::update_funding::handler(ctx)
    }

    /// Permissionless liquidation of any account below maintenance
    /// margin; the liquidator earns half the penalty.
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::handler(ctx)
    }
}
