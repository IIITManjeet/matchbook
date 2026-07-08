//! Postgres persistence. Runtime-checked sqlx queries (no live DB needed
//! at compile time). All on-chain u64s are stored as BIGINT — see the
//! note at the top of migrations/0001_init.sql.

use anyhow::Result;
use chrono::{DateTime, Duration, DurationRound, Utc};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

pub struct Store {
    pub pool: PgPool,
}

// ── API row types ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MarketRow {
    pub pubkey: String,
    pub base_mint: String,
    pub quote_mint: String,
    pub tick_size: i64,
    pub base_lot_size: i64,
    pub kind: String, // "spot" | "perp"
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TradeRow {
    pub id: i64,
    pub market: String,
    pub maker: String,
    pub taker: String,
    pub taker_side: i16,
    pub price: i64,
    pub qty: i64,
    pub taker_fee: i64,
    pub signature: String,
    pub ts: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct OrderRow {
    pub market: String,
    pub order_id: i64,
    pub owner: String,
    pub side: i16,
    pub price: i64,
    pub orig_qty: i64,
    pub remaining: i64,
    pub status: String,
    pub placed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CandleRow {
    pub bucket: DateTime<Utc>,
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: i64,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(database_url)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    // ── Ingestion writes ───────────────────────────────────────────────

    pub async fn is_processed(&self, signature: &str) -> Result<bool> {
        let row = sqlx::query("SELECT 1 FROM processed_txs WHERE signature = $1")
            .bind(signature)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn mark_processed(&self, signature: &str, slot: u64) -> Result<()> {
        sqlx::query(
            "INSERT INTO processed_txs (signature, slot) VALUES ($1, $2)
             ON CONFLICT (signature) DO NOTHING",
        )
        .bind(signature)
        .bind(slot as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Most recently processed signature — the backfill `until` cursor.
    pub async fn latest_processed(&self) -> Result<Option<String>> {
        let row =
            sqlx::query("SELECT signature FROM processed_txs ORDER BY slot DESC LIMIT 1")
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get(0)))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_market(
        &self,
        pubkey: &str,
        base_mint: &str,
        quote_mint: &str,
        tick_size: u64,
        base_lot_size: u64,
        kind: &str,
        slot: u64,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO markets (pubkey, base_mint, quote_mint, tick_size, base_lot_size, kind, created_slot, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (pubkey) DO NOTHING",
        )
        .bind(pubkey)
        .bind(base_mint)
        .bind(quote_mint)
        .bind(tick_size as i64)
        .bind(base_lot_size as i64)
        .bind(kind)
        .bind(slot as i64)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_funding(
        &self,
        market: &str,
        premium_bps: i64,
        cum_funding: &str,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO funding (market, premium_bps, cum_funding, ts) VALUES ($1,$2,$3,$4)",
        )
        .bind(market)
        .bind(premium_bps)
        .bind(cum_funding)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_liquidation(
        &self,
        market: &str,
        owner: &str,
        liquidator: &str,
        size_closed: i64,
        price: u64,
        penalty: u64,
        signature: &str,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO liquidations (market, owner, liquidator, size_closed, price, penalty, signature, ts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(market)
        .bind(owner)
        .bind(liquidator)
        .bind(size_closed)
        .bind(price as i64)
        .bind(penalty as i64)
        .bind(signature)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_trade(
        &self,
        market: &str,
        maker: &str,
        taker: &str,
        maker_order_id: u64,
        taker_order_id: u64,
        taker_side: u8,
        price: u64,
        qty: u64,
        taker_fee: u64,
        slot: u64,
        signature: &str,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO trades (market, maker, taker, maker_order_id, taker_order_id,
                                 taker_side, price, qty, taker_fee, slot, signature, ts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        )
        .bind(market)
        .bind(maker)
        .bind(taker)
        .bind(maker_order_id as i64)
        .bind(taker_order_id as i64)
        .bind(taker_side as i16)
        .bind(price as i64)
        .bind(qty as i64)
        .bind(taker_fee as i64)
        .bind(slot as i64)
        .bind(signature)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fold a fill into its 1-minute candle.
    pub async fn upsert_candle(
        &self,
        market: &str,
        ts: DateTime<Utc>,
        price: u64,
        qty: u64,
    ) -> Result<()> {
        let bucket = ts.duration_trunc(Duration::minutes(1))?;
        sqlx::query(
            "INSERT INTO candles_1m (market, bucket, open, high, low, close, volume)
             VALUES ($1, $2, $3, $3, $3, $3, $4)
             ON CONFLICT (market, bucket) DO UPDATE SET
               high   = GREATEST(candles_1m.high, EXCLUDED.high),
               low    = LEAST(candles_1m.low, EXCLUDED.low),
               close  = EXCLUDED.close,
               volume = candles_1m.volume + EXCLUDED.volume",
        )
        .bind(market)
        .bind(bucket)
        .bind(price as i64)
        .bind(qty as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_order(
        &self,
        market: &str,
        order_id: u64,
        owner: &str,
        side: u8,
        price: u64,
        qty: u64,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO orders (market, order_id, owner, side, price, orig_qty, remaining, status, placed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$6,'open',$7)
             ON CONFLICT (market, order_id) DO NOTHING",
        )
        .bind(market)
        .bind(order_id as i64)
        .bind(owner)
        .bind(side as i16)
        .bind(price as i64)
        .bind(qty as i64)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Reduce a maker order's remaining qty; flips to 'filled' at zero.
    pub async fn apply_fill(&self, market: &str, order_id: u64, qty: u64) -> Result<()> {
        sqlx::query(
            "UPDATE orders SET
               remaining = GREATEST(remaining - $3, 0),
               status = CASE WHEN remaining - $3 <= 0 THEN 'filled' ELSE status END
             WHERE market = $1 AND order_id = $2 AND status = 'open'",
        )
        .bind(market)
        .bind(order_id as i64)
        .bind(qty as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn cancel_order(&self, market: &str, order_id: u64) -> Result<()> {
        sqlx::query(
            "UPDATE orders SET status = 'canceled'
             WHERE market = $1 AND order_id = $2 AND status = 'open'",
        )
        .bind(market)
        .bind(order_id as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_transfer(
        &self,
        market: &str,
        owner: &str,
        mint: &str,
        amount: i64, // negative = withdrawal
        slot: u64,
        signature: &str,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO transfers (market, owner, mint, amount, slot, signature, ts)
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(market)
        .bind(owner)
        .bind(mint)
        .bind(amount)
        .bind(slot as i64)
        .bind(signature)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ── API reads ──────────────────────────────────────────────────────

    pub async fn markets(&self) -> Result<Vec<MarketRow>> {
        Ok(sqlx::query_as::<_, MarketRow>(
            "SELECT pubkey, base_mint, quote_mint, tick_size, base_lot_size, kind, created_at
             FROM markets ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Most recent funding crank for a perp market.
    pub async fn latest_funding(&self, market: &str) -> Result<Option<serde_json::Value>> {
        let row = sqlx::query(
            "SELECT premium_bps, cum_funding, ts FROM funding
             WHERE market = $1 ORDER BY ts DESC LIMIT 1",
        )
        .bind(market)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| {
            serde_json::json!({
                "premium_bps": r.get::<i64, _>("premium_bps"),
                "cum_funding": r.get::<String, _>("cum_funding"),
                "ts": r.get::<DateTime<Utc>, _>("ts"),
            })
        }))
    }

    pub async fn trades(&self, market: &str, limit: i64) -> Result<Vec<TradeRow>> {
        Ok(sqlx::query_as::<_, TradeRow>(
            "SELECT id, market, maker, taker, taker_side, price, qty, taker_fee, signature, ts
             FROM trades WHERE market = $1 ORDER BY id DESC LIMIT $2",
        )
        .bind(market)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Candles at `resolution` seconds, aggregated from the 1m base table.
    pub async fn candles(
        &self,
        market: &str,
        resolution_secs: i64,
        limit: i64,
    ) -> Result<Vec<CandleRow>> {
        let rows = sqlx::query(
            "SELECT
               to_timestamp(floor(extract(epoch FROM bucket) / $2) * $2) AS b,
               (array_agg(open  ORDER BY bucket ASC ))[1] AS open,
               max(high)  AS high,
               min(low)   AS low,
               (array_agg(close ORDER BY bucket DESC))[1] AS close,
               sum(volume)::BIGINT AS volume
             FROM candles_1m
             WHERE market = $1
             GROUP BY b ORDER BY b DESC LIMIT $3",
        )
        .bind(market)
        .bind(resolution_secs)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out: Vec<CandleRow> = rows
            .into_iter()
            .map(|r| CandleRow {
                bucket: r.get("b"),
                open: r.get("open"),
                high: r.get("high"),
                low: r.get("low"),
                close: r.get("close"),
                volume: r.get("volume"),
            })
            .collect();
        out.reverse(); // oldest-first for charting libraries
        Ok(out)
    }

    pub async fn orders(
        &self,
        market: &str,
        owner: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<OrderRow>> {
        Ok(sqlx::query_as::<_, OrderRow>(
            "SELECT market, order_id, owner, side, price, orig_qty, remaining, status, placed_at
             FROM orders
             WHERE market = $1
               AND ($2::TEXT IS NULL OR owner = $2)
               AND ($3::TEXT IS NULL OR status = $3)
             ORDER BY placed_at DESC LIMIT 500",
        )
        .bind(market)
        .bind(owner)
        .bind(status)
        .fetch_all(&self.pool)
        .await?)
    }

    /// All open orders — used to rebuild the in-memory books on restart.
    pub async fn open_orders_all(&self) -> Result<Vec<OrderRow>> {
        Ok(sqlx::query_as::<_, OrderRow>(
            "SELECT market, order_id, owner, side, price, orig_qty, remaining, status, placed_at
             FROM orders WHERE status = 'open'",
        )
        .fetch_all(&self.pool)
        .await?)
    }
}
