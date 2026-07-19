//! REST + websocket API served to the trading terminal.
//!
//! REST reads come from Postgres; the book snapshot comes from the
//! in-memory mirror; the websocket fans out the ingestion pipeline's
//! broadcast channel, filtered per client subscription.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;

use crate::ingest::Shared;

type App = Arc<Shared>;

pub fn router(shared: App) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/markets", get(markets))
        .route("/markets/:market/trades", get(trades))
        .route("/markets/:market/candles", get(candles))
        .route("/markets/:market/book", get(book))
        .route("/markets/:market/orders", get(orders))
        .route("/markets/:market/funding", get(funding))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive()) // dev tool; lock down if ever public
        .with_state(shared)
}

fn internal(err: anyhow::Error) -> (StatusCode, String) {
    tracing::error!(?err, "api error");
    (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn markets(State(app): State<App>) -> Result<impl IntoResponse, (StatusCode, String)> {
    Ok(Json(app.store.markets().await.map_err(internal)?))
}

#[derive(Deserialize)]
struct TradesQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}
fn default_limit() -> i64 {
    100
}

async fn trades(
    State(app): State<App>,
    Path(market): Path<String>,
    Query(q): Query<TradesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rows = app
        .store
        .trades(&market, q.limit.clamp(1, 1000))
        .await
        .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct CandlesQuery {
    /// Resolution in seconds; must be a multiple of 60.
    #[serde(default = "default_resolution")]
    resolution: i64,
    #[serde(default = "default_candle_limit")]
    limit: i64,
}
fn default_resolution() -> i64 {
    60
}
fn default_candle_limit() -> i64 {
    500
}

async fn candles(
    State(app): State<App>,
    Path(market): Path<String>,
    Query(q): Query<CandlesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if q.resolution < 60 || q.resolution % 60 != 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "resolution must be a multiple of 60 seconds".into(),
        ));
    }
    let rows = app
        .store
        .candles(&market, q.resolution, q.limit.clamp(1, 5000))
        .await
        .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct BookQuery {
    #[serde(default = "default_depth")]
    depth: usize,
}
fn default_depth() -> usize {
    20
}

async fn book(
    State(app): State<App>,
    Path(market): Path<String>,
    Query(q): Query<BookQuery>,
) -> impl IntoResponse {
    let books = app.books.read().await;
    match books.market(&market) {
        Some(b) => Json(json!({ "market": market, "book": b.snapshot(q.depth.min(200)) })),
        None => Json(json!({ "market": market, "book": { "bids": [], "asks": [] } })),
    }
}

#[derive(Deserialize)]
struct OrdersQuery {
    owner: Option<String>,
    status: Option<String>,
}

async fn orders(
    State(app): State<App>,
    Path(market): Path<String>,
    Query(q): Query<OrdersQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rows = app
        .store
        .orders(&market, q.owner.as_deref(), q.status.as_deref())
        .await
        .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct FundingQuery {
    /// When set, include up to this many historical rows (newest first).
    limit: Option<i64>,
}

async fn funding(
    State(app): State<App>,
    Path(market): Path<String>,
    Query(q): Query<FundingQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let latest = app.store.latest_funding(&market).await.map_err(internal)?;
    let history = match q.limit {
        Some(limit) => Some(
            app.store
                .funding_history(&market, limit.clamp(1, 1000))
                .await
                .map_err(internal)?,
        ),
        None => None,
    };
    Ok(Json(json!({ "market": market, "latest": latest, "history": history })))
}

// ── WebSocket ──────────────────────────────────────────────────────────
//
// Protocol (JSON text frames):
//   client → {"op":"subscribe","channel":"trades"|"book","market":"<pubkey>"}
//   client → {"op":"subscribe","channel":"account","market":...,"owner":"<pubkey>"}
//   client → {"op":"unsubscribe", ...same fields}
//   server → {"channel":"book","market":...,"data":{"type":"snapshot"|"delta",...}}
//   server → {"channel":"trades","market":...,"data":{price,qty,taker_side,ts,signature}}
//   server → {"channel":"account","market":...,"data":{"type":"order"|"fill",...}}
//
// "account" is owner-scoped: only the subscriber that named the owner
// receives its order/fill stream — the push path that replaces polling.

#[derive(Deserialize)]
struct ClientOp {
    op: String,
    channel: String,
    market: String,
    #[serde(default)]
    owner: Option<String>,
}

async fn ws_upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_client(app, socket))
}

async fn ws_client(app: App, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut feed = app.ws_tx.subscribe();
    // (channel, market, owner) — owner is "" for market-wide channels.
    let mut subs: HashSet<(String, String, String)> = HashSet::new();

    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                let Message::Text(text) = msg else { continue };
                let Ok(op) = serde_json::from_str::<ClientOp>(&text) else {
                    let _ = sink.send(Message::Text(
                        json!({"error": "bad message"}).to_string(),
                    )).await;
                    continue;
                };
                let key = (
                    op.channel.clone(),
                    op.market.clone(),
                    op.owner.clone().unwrap_or_default(),
                );
                match op.op.as_str() {
                    "subscribe" => {
                        // A book subscription starts with a full snapshot so
                        // the client has a base to apply deltas onto.
                        if op.channel == "book" {
                            let snapshot = {
                                let books = app.books.read().await;
                                books.market(&op.market).map(|b| b.snapshot(50))
                            };
                            if let Some(snap) = snapshot {
                                let msg = json!({
                                    "channel": "book",
                                    "market": op.market,
                                    "data": { "type": "snapshot", "book": snap },
                                });
                                if sink.send(Message::Text(msg.to_string())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        subs.insert(key);
                    }
                    "unsubscribe" => { subs.remove(&key); }
                    _ => {}
                }
            }
            broadcast = feed.recv() => {
                let msg = match broadcast {
                    Ok(m) => m,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(n, "ws client lagged; dropping messages");
                        continue;
                    }
                    Err(_) => break, // sender dropped: shutting down
                };
                let key = (
                    msg.channel.to_string(),
                    msg.market.clone(),
                    msg.owner.clone().unwrap_or_default(),
                );
                if !subs.contains(&key) {
                    continue;
                }
                let frame = json!({
                    "channel": msg.channel,
                    "market": msg.market,
                    "data": msg.payload,
                });
                if sink.send(Message::Text(frame.to_string())).await.is_err() {
                    break;
                }
            }
        }
    }
}
