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
    pub channel: &'static str, // "trades" | "book"
    pub market: String,
    pub payload: serde_json::Value,
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
        let _ = self.ws_tx.send(WsBroadcast { channel, market, payload });
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
                shared.broadcast("book", market, json!({ "type": "delta", "levels": [delta] }));
            }
            ClobEvent::OrderCanceled(e) => {
                let market = e.market.to_base58();
                shared.store.cancel_order(&market, e.order_id).await?;
                let delta = shared.books.write().await.market_mut(&market).cancel(e.order_id);
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
                if let Some(delta) = delta {
                    shared.broadcast("book", market, json!({ "type": "delta", "levels": [delta] }));
                }
            }
            ClobEvent::EventsConsumed(e) => {
                tracing::debug!(market = %e.market.to_base58(), count = e.count, "crank turn");
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
