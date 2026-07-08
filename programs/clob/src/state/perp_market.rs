use anchor_lang::prelude::*;

use crate::errors::ClobError;

/// One whole base unit in base atoms (e.g. 1 SOL = 1e9 lamport-atoms).
/// Perp prices are quoted in quote atoms *per whole base unit*, so
/// notional = size_atoms × price / BASE_UNIT.
pub const BASE_UNIT: u128 = 1_000_000_000;

pub const BPS: u128 = 10_000;

/// Seconds per day — funding premiums are quoted per day and accrued
/// pro-rata for the elapsed time on every crank.
pub const SECONDS_PER_DAY: i128 = 86_400;

/// A perpetual futures market, margined and settled in the quote
/// (collateral) currency. Positions fill against the oracle price
/// rather than an orderbook: the CLOB is milestones 1–3's lesson,
/// margin/funding/liquidation is this one's.
///
/// The oracle is a keeper-pushed price on the market account itself,
/// gated to `admin`. On devnet this becomes a Pyth price account read —
/// the field layout (price + publish time) deliberately mirrors it.
#[account]
#[derive(InitSpace)]
pub struct PerpMarket {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,

    /// Quote atoms per whole base unit (e.g. 50 USDC = 50_000_000).
    pub oracle_price: u64,
    pub oracle_ts: i64,

    /// Lifetime funding accumulator: quote atoms per whole base unit.
    /// A position's unsettled funding is `pos × (cum_funding −
    /// last_cum_funding) / BASE_UNIT`; positive means longs pay.
    pub cum_funding: i128,
    pub last_funding_ts: i64,
    pub funding_interval: i64,
    /// Cap on the skew-derived funding premium, in bps per day.
    pub max_funding_bps: u16,

    pub taker_fee_bps: u16,
    /// Margin required to *open* (e.g. 1000 bps = 10x max leverage).
    pub init_margin_bps: u16,
    /// Margin below which anyone may liquidate.
    pub maint_margin_bps: u16,
    /// Liquidation penalty on closed notional; half to the liquidator,
    /// half to the protocol.
    pub liq_fee_bps: u16,

    /// Open interest per side, in base atoms. Their imbalance drives
    /// the funding premium: crowded longs pay shorts and vice versa.
    pub long_oi: u64,
    pub short_oi: u64,

    pub fees_accrued: u64,
    pub bump: u8,
}

impl PerpMarket {
    pub const SEED_PREFIX: &'static [u8] = b"perp";

    /// Oracle prices older than this cannot be traded against.
    pub const MAX_ORACLE_AGE_SECS: i64 = 60;

    pub fn require_fresh_oracle(&self, now: i64) -> Result<u64> {
        require!(
            now - self.oracle_ts <= Self::MAX_ORACLE_AGE_SECS,
            ClobError::OracleStale
        );
        Ok(self.oracle_price)
    }

    /// Notional value of `size` base atoms at `price`, in quote atoms.
    pub fn notional(size: u64, price: u64) -> Result<u64> {
        let n = (size as u128)
            .checked_mul(price as u128)
            .ok_or(ClobError::MathOverflow)?
            / BASE_UNIT;
        u64::try_from(n).map_err(|_| ClobError::MathOverflow.into())
    }

    /// The skew-derived funding premium in bps/day, positive when longs
    /// dominate: premium = (long_oi − short_oi) / total_oi × max_bps.
    pub fn funding_premium_bps(&self) -> i64 {
        let long = self.long_oi as i128;
        let short = self.short_oi as i128;
        let total = long + short;
        if total == 0 {
            return 0;
        }
        ((long - short) * self.max_funding_bps as i128 / total) as i64
    }
}
