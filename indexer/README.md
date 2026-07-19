# clob-indexer

The off-chain stack: subscribes to the CLOB program's logs, decodes
Anchor events, persists everything to Postgres, and serves the trading
terminal over REST + websocket. A standalone Rust service — it needs
only an RPC endpoint and a Postgres, and runs anywhere (including
natively on Windows).

```
validator logs ──ws──▶ ingest ──▶ Postgres (trades, orders, candles, transfers)
                         │
                         ├──▶ in-memory books (snapshot/delta)
                         └──▶ broadcast ──▶ /ws subscribers
```

## Running

```bash
docker compose up -d       # Postgres 16 on localhost:5433
cp .env.example .env       # defaults target a local test validator
cargo run
```

On startup it applies migrations, rebuilds the in-memory books from
persisted open orders, backfills any history the RPC node still has
(`getSignaturesForAddress` → `getTransaction`, restart-safe via the
`processed_txs` dedupe table), then tails `logsSubscribe` with
auto-reconnect. Both paths funnel into the same idempotent
`process_tx`, so overlap is harmless.

## API (default `127.0.0.1:8081`)

| Route | Returns |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /markets` | all markets |
| `GET /markets/:pk/trades?limit=` | recent fills, newest first |
| `GET /markets/:pk/candles?resolution=60&limit=` | OHLCV, oldest first (resolution = seconds, multiple of 60) |
| `GET /markets/:pk/book?depth=` | live book snapshot (in-memory) |
| `GET /markets/:pk/orders?owner=&status=` | order history |

Websocket at `/ws`:

```jsonc
// client
{"op":"subscribe","channel":"trades","market":"<pubkey>"}
{"op":"subscribe","channel":"book","market":"<pubkey>"}   // replies with a snapshot first
// server
{"channel":"trades","market":"...","data":{"price":500,"qty":4,"taker_side":0,"ts":"...","signature":"..."}}
{"channel":"book","market":"...","data":{"type":"delta","levels":[{"side":1,"price":500,"qty":6}]}}
```

Prices are in ticks, quantities in base lots, fees in quote atoms —
exactly as on-chain. Humanizing them requires the market's `tick_size` /
`base_lot_size` (in `/markets`).

## Design notes

- **Book reconstruction from events alone** works because of an on-chain
  guarantee: `OrderPlaced` is emitted only when a remainder actually
  rests, so placed − filled − canceled = the live book (`src/book.rs`).
- **Hand-rolled JSON-RPC** (`src/rpc.rs`): the indexer needs four calls
  and one subscription; speaking the wire protocol directly avoids the
  entire `solana-sdk` dependency tree and is the instructive path.
- **Event decoding** (`src/events.rs`): `Program data:` log lines,
  base64 → 8-byte `sha256("event:<Name>")` discriminator → borsh. A log
  stack tracker ignores `Program data:` emitted by CPI'd programs; unit
  tests pin the discriminators against the generated IDL.
- **Candles**: fills upsert 1-minute buckets; higher resolutions are
  aggregated at query time, which beats maintaining rollup tables at
  this scale.

`cargo test` covers decoding and book reconstruction; the end-to-end
check is running `npm test` (repo root) against a local validator with
the indexer up, then watching `/markets/:pk/trades` and `/ws` populate.
