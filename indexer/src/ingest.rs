//! The ingestion pipeline: backfill history via `getSignaturesForAddress`,
//! then tail live logs via `logsSubscribe`. Both paths funnel into the
//! same `process_tx`, which is idempotent per signature (dedupe table),
//! so overlap between backfill and the live stream is harmless.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::json;
use tokio::sync::{broadcast, mpsc, RwLock};

use crate::book::Books;
use crate::events::{events_from_logs, ClobEvent};
use crate::rpc::RpcClient;
use crate::store::Store;

/// A message fanned out to websocket subscribers.
#[derive(Debug, Clone)]
pub struct WsBroadcast {
    pub channel: &'static str, // "trades" | "book" | "mark" | "funding" | "liquidations" | "account"
    pub market: String,
    /// Set on "account" messages: only the subscriber for this owner
    /// receives them. None = market-wide fan-out.
    pub owner: Option<String>,
    pub payload: serde_json::Value,
}

/// Perp events are normalized into the spot tick/lot scheme on ingest:
/// with SOL(9dp)/USDC(6dp), ui_price = ticks × 0.1 and 1 lot = 0.001
/// SOL, exactly like the spot market rows.
const PERP_TICK_SIZE: u64 = 100;
const PERP_LOT_SIZE: u64 = 1_000_000;

/// quote atoms per whole base unit → ticks (ui × 10).
fn perp_price_to_ticks(price: u64) -> u64 {
    price / 100_000
}

pub struct Shared {
    pub store: Store,
    pub books: RwLock<Books>,
    pub ws_tx: broadcast::Sender<WsBroadcast>,
    pub rpc: RpcClient,
    pub program_id: String,
}

impl Shared {
    fn broadcast(&self, channel: &'static str, market: String, payload: serde_json::Value) {
        // Send fails only when nobody is subscribed; that's fine.
        let _ = self.ws_tx.send(WsBroadcast { channel, market, owner: None, payload });
    }

    /// Push an owner-scoped update on the "account" channel — the push
    /// path that lets the terminal drop its 2s order/fill poll.
    fn broadcast_account(&self, market: String, owner: String, payload: serde_json::Value) {
        let _ = self.ws_tx.send(WsBroadcast { channel: "account", market, owner: Some(owner), payload });
    }
}

/// Apply one transaction's events. Idempotent: signatures already in
/// `processed_txs` are skipped.
pub async fn process_tx(
    shared: &Shared,
    signature: &str,
    slot: u64,
    logs: &[String],
    ts: DateTime<Utc>,
) -> Result<()> {
    if shared.store.is_processed(signature).await? {
        return Ok(());
    }
    let events = events_from_logs(logs, &shared.program_id);

    for ev in &events {
        match ev {
            ClobEvent::MarketInitialized(e) => {
                let market = e.market.to_base58();
                tracing::info!(market, "market initialized");
                shared
                    .store
                    .upsert_market(
                        &market,
                        &e.base_mint.to_base58(),
                        &e.quote_mint.to_base58(),
                        e.tick_size,
                        e.base_lot_size,
                        "spot",
                        slot,
                        ts,
                    )
                    .await?;
            }
            ClobEvent::Deposited(e) => {
                shared
                    .store
                    .insert_transfer(
                        &e.market.to_base58(),
                        &e.owner.to_base58(),
                        &e.mint.to_base58(),
                        e.amount as i64,
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
            }
            ClobEvent::Withdrawn(e) => {
                shared
                    .store
                    .insert_transfer(
                        &e.market.to_base58(),
                        &e.owner.to_base58(),
                        &e.mint.to_base58(),
                        -(e.amount as i64),
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
            }
            ClobEvent::OrderPlaced(e) => {
                let market = e.market.to_base58();
                shared
                    .store
                    .insert_order(
                        &market,
                        e.order_id,
                        &e.owner.to_base58(),
                        e.side,
                        e.price,
                        e.qty,
                        ts,
                    )
                    .await?;
                let delta = shared
                    .books
                    .write()
                    .await
                    .market_mut(&market)
                    .place(e.order_id, e.side, e.price, e.qty);
                shared.broadcast_account(
                    market.clone(),
                    e.owner.to_base58(),
                    json!({
                        "type": "order",
                        "order_id": e.order_id,
                        "status": "open",
                        "side": e.side,
                        "price": e.price,
                        "qty": e.qty,
                        "ts": ts,
                    }),
                );
                shared.broadcast("book", market, json!({ "type": "delta", "levels": [delta] }));
            }
            ClobEvent::OrderCanceled(e) => {
                let market = e.market.to_base58();
                shared.store.cancel_order(&market, e.order_id).await?;
                let delta = shared.books.write().await.market_mut(&market).cancel(e.order_id);
                shared.broadcast_account(
                    market.clone(),
                    e.owner.to_base58(),
                    json!({ "type": "order", "order_id": e.order_id, "status": "canceled", "ts": ts }),
                );
                if let Some(delta) = delta {
                    shared.broadcast("book", market, json!({ "type": "delta", "levels": [delta] }));
                }
            }
            ClobEvent::OrderFilled(e) => {
                let market = e.market.to_base58();
                shared
                    .store
                    .insert_trade(
                        &market,
                        &e.maker.to_base58(),
                        &e.taker.to_base58(),
                        e.maker_order_id,
                        e.taker_order_id,
                        e.taker_side,
                        e.price,
                        e.qty,
                        e.taker_fee,
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
                shared.store.upsert_candle(&market, ts, e.price, e.qty).await?;
                shared.store.apply_fill(&market, e.maker_order_id, e.qty).await?;
                let delta = shared
                    .books
                    .write()
                    .await
                    .market_mut(&market)
                    .fill(e.maker_order_id, e.qty);
                shared.broadcast(
                    "trades",
                    market.clone(),
                    json!({
                        "price": e.price,
                        "qty": e.qty,
                        "taker_side": e.taker_side,
                        "ts": ts,
                        "signature": signature,
                    }),
                );
                // Self-trades are rejected on-chain, so maker ≠ taker and
                // each fill notifies exactly two distinct accounts.
                for (who, role) in [(&e.maker, "maker"), (&e.taker, "taker")] {
                    shared.broadcast_account(
                        market.clone(),
                        who.to_base58(),
                        json!({
                            "type": "fill",
                            "role": role,
                            "maker_order_id": e.maker_order_id,
                            "taker_side": e.taker_side,
                            "price": e.price,
                            "qty": e.qty,
                            "taker_fee": e.taker_fee,
                            "ts": ts,
                            "signature": signature,
                        }),
                    );
                }
                if let Some(delta) = delta {
                    shared.broadcast("book", market, json!({ "type": "delta", "levels": [delta] }));
                }
            }
            ClobEvent::EventsConsumed(e) => {
                tracing::debug!(market = %e.market.to_base58(), count = e.count, "crank turn");
            }

            // ── M4: perps ─────────────────────────────────────────────
            //
            // Perp events carry native units (quote atoms per whole
            // base unit; base atoms). They are normalized here to the
            // same tick/lot scheme as spot markets so every downstream
            // table, endpoint and UI conversion works unchanged.
            ClobEvent::PerpMarketInitialized(e) => {
                let market = e.market.to_base58();
                tracing::info!(market, "perp market initialized");
                shared
                    .store
                    .upsert_market(
                        &market,
                        "SOL-PERP", // synthetic base: perps have no base mint
                        &e.collateral_mint.to_base58(),
                        PERP_TICK_SIZE,
                        PERP_LOT_SIZE,
                        "perp",
                        slot,
                        ts,
                    )
                    .await?;
            }
            ClobEvent::OraclePriceSet(e) => {
                let market = e.market.to_base58();
                let ticks = perp_price_to_ticks(e.price);
                // Zero-volume candle: the oracle drives the perp chart
                // even when nobody trades.
                shared.store.upsert_candle(&market, ts, ticks, 0).await?;
                shared.broadcast("mark", market, json!({ "price": ticks, "ts": ts }));
            }
            ClobEvent::PerpPositionChanged(e) => {
                let market = e.market.to_base58();
                let ticks = perp_price_to_ticks(e.price);
                let lots = e.delta.unsigned_abs() / PERP_LOT_SIZE;
                let side = if e.delta > 0 { 0u8 } else { 1u8 };
                shared
                    .store
                    .insert_trade(
                        &market,
                        &market, // counterparty is the market itself (oracle fill)
                        &e.owner.to_base58(),
                        0,
                        0,
                        side,
                        ticks,
                        lots,
                        e.fee,
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
                shared.store.upsert_candle(&market, ts, ticks, lots).await?;
                shared.broadcast(
                    "trades",
                    market,
                    json!({
                        "price": ticks,
                        "qty": lots,
                        "taker_side": side,
                        "ts": ts,
                        "signature": signature,
                    }),
                );
            }
            ClobEvent::FundingUpdated(e) => {
                let market = e.market.to_base58();
                shared
                    .store
                    .insert_funding(&market, e.premium_bps, &e.cum_funding.to_string(), ts)
                    .await?;
                shared.broadcast(
                    "funding",
                    market,
                    json!({ "premium_bps": e.premium_bps, "ts": ts }),
                );
            }
            ClobEvent::PositionLiquidated(e) => {
                let market = e.market.to_base58();
                tracing::info!(market, owner = %e.owner.to_base58(), "liquidation");
                shared
                    .store
                    .insert_liquidation(
                        &market,
                        &e.owner.to_base58(),
                        &e.liquidator.to_base58(),
                        e.size_closed,
                        e.price,
                        e.penalty,
                        signature,
                        ts,
                    )
                    .await?;
                shared.broadcast(
                    "liquidations",
                    market,
                    json!({
                        "owner": e.owner.to_base58(),
                        "size_closed": e.size_closed,
                        "price": perp_price_to_ticks(e.price),
                        "penalty": e.penalty,
                        "ts": ts,
                    }),
                );
            }
            ClobEvent::CollateralDeposited(e) => {
                shared
                    .store
                    .insert_transfer(
                        &e.market.to_base58(),
                        &e.owner.to_base58(),
                        "collateral",
                        e.amount as i64,
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
            }
            ClobEvent::CollateralWithdrawn(e) => {
                shared
                    .store
                    .insert_transfer(
                        &e.market.to_base58(),
                        &e.owner.to_base58(),
                        "collateral",
                        -(e.amount as i64),
                        slot,
                        signature,
                        ts,
                    )
                    .await?;
            }
        }
    }

    shared.store.mark_processed(signature, slot).await?;
    if !events.is_empty() {
        tracing::debug!(signature, n = events.len(), "processed");
    }
    Ok(())
}

fn ts_from_block_time(block_time: Option<i64>) -> DateTime<Utc> {
    block_time
        .and_then(|t| Utc.timestamp_opt(t, 0).single())
        .unwrap_or_else(Utc::now)
}

/// Replay everything the RPC node still has since the last processed
/// signature (or from genesis of the node's history on first run).
pub async fn backfill(shared: &Shared) -> Result<()> {
    let until = shared.store.latest_processed().await?;
    let mut before: Option<String> = None;
    let mut batch: Vec<crate::rpc::SignatureInfo> = Vec::new();

    loop {
        let page = shared
            .rpc
            .signatures_for_address(&shared.program_id, before.as_deref(), until.as_deref(), 1000)
            .await?;
        let done = page.len() < 1000;
        if let Some(last) = page.last() {
            before = Some(last.signature.clone());
        }
        batch.extend(page);
        if done {
            break;
        }
    }

    if batch.is_empty() {
        tracing::info!("backfill: nothing new");
        return Ok(());
    }
    tracing::info!(n = batch.len(), "backfill: replaying history oldest-first");

    for info in batch.iter().rev() {
        if info.err.is_some() {
            continue;
        }
        let Some(tx) = shared.rpc.transaction_logs(&info.signature).await? else {
            continue; // node purged it
        };
        if tx.failed {
            continue;
        }
        let ts = ts_from_block_time(tx.block_time.or(info.block_time));
        process_tx(shared, &info.signature, tx.slot, &tx.logs, ts).await?;
    }
    Ok(())
}

/// Live tail with reconnect. Runs forever.
pub async fn run_live(shared: Arc<Shared>, ws_url: String) {
    loop {
        let (tx, mut rx) = mpsc::channel(1024);
        let sub = {
            let ws_url = ws_url.clone();
            let program_id = shared.program_id.clone();
            tokio::spawn(async move {
                crate::rpc::run_logs_subscription(&ws_url, &program_id, tx).await
            })
        };

        while let Some(note) = rx.recv().await {
            if note.failed {
                continue;
            }
            // logsNotification has no blockTime; ask for it (cheap, and
            // fills are rare at this project's scale). Fall back to now.
            let block_time = shared.rpc.block_time(note.slot).await.unwrap_or(None);
            let ts = ts_from_block_time(block_time);
            if let Err(err) =
                process_tx(&shared, &note.signature, note.slot, &note.logs, ts).await
            {
                tracing::error!(?err, signature = %note.signature, "process_tx failed");
            }
        }

        match sub.await {
            Ok(Ok(())) => tracing::warn!("log subscription closed; reconnecting"),
            Ok(Err(err)) => tracing::warn!(?err, "log subscription error; reconnecting"),
            Err(err) => tracing::error!(?err, "subscription task panicked; reconnecting"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
