//! A deliberately minimal Solana JSON-RPC client.
//!
//! The full `solana-client` crate drags in the entire SDK; the indexer
//! needs exactly four calls and one subscription, so we speak the wire
//! protocol directly. This is also the best way to actually learn it.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub struct RpcClient {
    http: reqwest::Client,
    url: String,
}

#[derive(Debug, Deserialize)]
pub struct SignatureInfo {
    pub signature: String,
    #[allow(dead_code)] // backfill uses getTransaction's slot instead
    pub slot: u64,
    pub err: Option<Value>,
    #[serde(rename = "blockTime")]
    pub block_time: Option<i64>,
}

#[derive(Debug)]
pub struct TxLogs {
    pub slot: u64,
    pub block_time: Option<i64>,
    pub logs: Vec<String>,
    pub failed: bool,
}

impl RpcClient {
    pub fn new(url: String) -> Self {
        Self { http: reqwest::Client::new(), url }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let resp: Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("rpc {method}: request failed"))?
            .json()
            .await
            .with_context(|| format!("rpc {method}: bad json"))?;
        if let Some(err) = resp.get("error") {
            return Err(anyhow!("rpc {method}: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Newest-first signatures mentioning `address`.
    pub async fn signatures_for_address(
        &self,
        address: &str,
        before: Option<&str>,
        until: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SignatureInfo>> {
        let mut cfg = json!({ "limit": limit, "commitment": "confirmed" });
        if let Some(b) = before {
            cfg["before"] = json!(b);
        }
        if let Some(u) = until {
            cfg["until"] = json!(u);
        }
        let result = self
            .call("getSignaturesForAddress", json!([address, cfg]))
            .await?;
        Ok(serde_json::from_value(result)?)
    }

    /// A transaction's log messages (None if the node no longer has it).
    pub async fn transaction_logs(&self, signature: &str) -> Result<Option<TxLogs>> {
        let cfg = json!({
            "commitment": "confirmed",
            "maxSupportedTransactionVersion": 0,
            "encoding": "json",
        });
        let result = self.call("getTransaction", json!([signature, cfg])).await?;
        if result.is_null() {
            return Ok(None);
        }
        let meta = &result["meta"];
        Ok(Some(TxLogs {
            slot: result["slot"].as_u64().unwrap_or(0),
            block_time: result["blockTime"].as_i64(),
            logs: serde_json::from_value(meta["logMessages"].clone()).unwrap_or_default(),
            failed: !meta["err"].is_null(),
        }))
    }

    pub async fn block_time(&self, slot: u64) -> Result<Option<i64>> {
        // Returns an error for skipped/purged slots; treat as unknown.
        match self.call("getBlockTime", json!([slot])).await {
            Ok(v) => Ok(v.as_i64()),
            Err(_) => Ok(None),
        }
    }
}

/// One `logsNotification` from a `logsSubscribe` stream.
#[derive(Debug)]
pub struct LogsNotification {
    pub signature: String,
    pub slot: u64,
    pub logs: Vec<String>,
    pub failed: bool,
}

/// Subscribe to logs mentioning `program_id` and forward notifications
/// into `tx` until the socket dies. The caller owns the reconnect loop —
/// this function returning (Ok or Err) always means "resubscribe".
pub async fn run_logs_subscription(
    ws_url: &str,
    program_id: &str,
    tx: tokio::sync::mpsc::Sender<LogsNotification>,
) -> Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .with_context(|| format!("ws connect {ws_url}"))?;
    let (mut sink, mut stream) = ws.split();

    let sub = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "logsSubscribe",
        "params": [
            { "mentions": [program_id] },
            { "commitment": "confirmed" }
        ]
    });
    sink.send(Message::Text(sub.to_string())).await?;
    tracing::info!(ws_url, program_id, "logsSubscribe active");

    while let Some(msg) = stream.next().await {
        let msg = msg.context("ws read")?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(p) => {
                sink.send(Message::Pong(p)).await.ok();
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v["method"] != "logsNotification" {
            continue; // subscription ack or unrelated
        }
        let result = &v["params"]["result"];
        let value = &result["value"];
        let note = LogsNotification {
            signature: value["signature"].as_str().unwrap_or_default().to_string(),
            slot: result["context"]["slot"].as_u64().unwrap_or(0),
            logs: serde_json::from_value(value["logs"].clone()).unwrap_or_default(),
            failed: !value["err"].is_null(),
        };
        if tx.send(note).await.is_err() {
            break; // receiver gone: shutting down
        }
    }
    Ok(())
}
