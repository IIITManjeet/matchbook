//! CLOB indexer: Solana program logs → Postgres → REST/WS.
//!
//! Config is environment-only (see `.env.example`):
//!   DATABASE_URL   postgres://clob:clob@localhost:5433/clob
//!   RPC_HTTP       http://127.0.0.1:8899
//!   RPC_WS         ws://127.0.0.1:8900
//!   PROGRAM_ID     9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2
//!   LISTEN_ADDR    127.0.0.1:8081

mod api;
mod book;
mod events;
mod ingest;
mod rpc;
mod store;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::{broadcast, RwLock};
use tracing_subscriber::EnvFilter;

use crate::book::Books;
use crate::ingest::Shared;
use crate::rpc::RpcClient;
use crate::store::Store;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let database_url = env_or("DATABASE_URL", "postgres://clob:clob@localhost:5433/clob");
    let rpc_http = env_or("RPC_HTTP", "http://127.0.0.1:8899");
    let rpc_ws = env_or("RPC_WS", "ws://127.0.0.1:8900");
    let program_id = env_or("PROGRAM_ID", "9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2");
    let listen_addr = env_or("LISTEN_ADDR", "127.0.0.1:8081");

    let store = Store::connect(&database_url)
        .await
        .context("connecting to postgres (is `docker compose up -d` running?)")?;
    tracing::info!("postgres connected, migrations applied");

    // Rebuild the in-memory books from persisted open orders so restarts
    // don't blank the book endpoint while backfill catches up.
    let mut books = Books::default();
    for o in store.open_orders_all().await? {
        books
            .market_mut(&o.market)
            .place(o.order_id as u64, o.side as u8, o.price as u64, o.remaining as u64);
    }

    let (ws_tx, _) = broadcast::channel(4096);
    let shared = Arc::new(Shared {
        store,
        books: RwLock::new(books),
        ws_tx,
        rpc: RpcClient::new(rpc_http),
        program_id,
    });

    // Ingestion: replay history, then tail live logs. Runs alongside the
    // API server; the dedupe table makes any overlap idempotent.
    {
        let shared = shared.clone();
        tokio::spawn(async move {
            if let Err(err) = ingest::backfill(&shared).await {
                tracing::error!(?err, "backfill failed (continuing with live tail)");
            }
            ingest::run_live(shared, rpc_ws).await;
        });
    }

    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .with_context(|| format!("binding {listen_addr}"))?;
    tracing::info!("API listening on http://{listen_addr}");
    axum::serve(listener, api::router(shared)).await?;
    Ok(())
}
