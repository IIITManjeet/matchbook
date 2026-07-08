use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::state::perp_market::{PerpMarket, BASE_UNIT, BPS};

/// A user's cross-state for one perp market: collateral plus one net
/// position. PDA: `["margin", market, owner]`.
///
/// The account never stores unrealized PnL or unsettled funding — both
/// are derived from the market's current oracle price and funding
/// accumulator, and folded into `collateral` only when the position is
/// touched (trade, liquidation, withdraw). That makes "settle funding
/// first" the invariant every mutating instruction starts with.
#[account]
#[derive(InitSpace)]
pub struct MarginAccount {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Quote atoms backing the position (deposits ± realized PnL ±
    /// settled funding − fees − penalties).
    pub collateral: u64,
    /// Base atoms; positive = long, negative = short.
    pub base_position: i64,
    /// Volume-weighted entry, quote atoms per whole base unit.
    pub avg_entry_price: u64,
    /// `PerpMarket::cum_funding` as of the last settlement.
    pub last_cum_funding: i128,
    pub bump: u8,
}

impl MarginAccount {
    pub const SEED_PREFIX: &'static [u8] = b"margin";

    /// Funding owed since the last settlement (positive = this account
    /// pays), in quote atoms.
    pub fn pending_funding(&self, market: &PerpMarket) -> i128 {
        let delta = market.cum_funding - self.last_cum_funding;
        (self.base_position as i128) * delta / BASE_UNIT as i128
    }

    /// Mark-to-market PnL at `price`, in quote atoms (signed).
    pub fn unrealized_pnl(&self, price: u64) -> i128 {
        let pos = self.base_position as i128;
        pos * (price as i128 - self.avg_entry_price as i128) / BASE_UNIT as i128
    }

    /// Collateral + uPnL − pending funding: what the account is worth
    /// if closed at `price` right now.
    pub fn equity(&self, market: &PerpMarket, price: u64) -> i128 {
        self.collateral as i128 + self.unrealized_pnl(price) - self.pending_funding(market)
    }

    /// Fold pending funding into collateral. Losses beyond collateral
    /// are clamped to zero — bad debt is swallowed by the protocol (a
    /// real venue socializes it; see docs/ARCHITECTURE.md).
    pub fn settle_funding(&mut self, market: &PerpMarket) {
        let pending = self.pending_funding(market);
        let after = self.collateral as i128 - pending;
        self.collateral = after.clamp(0, u64::MAX as i128) as u64;
        self.last_cum_funding = market.cum_funding;
    }

    /// Apply realized PnL to collateral with the same bad-debt clamp.
    pub fn apply_realized(&mut self, pnl: i128) {
        let after = self.collateral as i128 + pnl;
        self.collateral = after.clamp(0, u64::MAX as i128) as u64;
    }

    /// Margin required to hold `size` base atoms at `price`.
    pub fn margin_required(size: i64, price: u64, bps: u16) -> Result<u64> {
        let notional = PerpMarket::notional(size.unsigned_abs(), price)?;
        let req = (notional as u128)
            .checked_mul(bps as u128)
            .ok_or(ClobError::MathOverflow)?
            / BPS;
        u64::try_from(req).map_err(|_| ClobError::MathOverflow.into())
    }
}
