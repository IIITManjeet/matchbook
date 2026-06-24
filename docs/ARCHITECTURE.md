# Architecture

A CLOB DEX in three layers: an on-chain Anchor program that is the source
of truth, an off-chain Rust indexer that makes it queryable in real time,
and a trading-terminal frontend.

```
 ┌────────────────────────────────────────────────────────────┐
 │  app/  — Next.js trading terminal                          │
 │  charts · orderbook ladder · trade ticket · positions      │
 └───────────────▲───────────────────────────▲────────────────┘
                 │ REST + WebSocket          │ wallet adapter (tx signing)
 ┌───────────────┴────────────────┐  ┌───────┴────────────────┐
 │  indexer/  — Rust (Axum)       │  │  Solana RPC            │
 │  event ingestion → Postgres    │  │                        │
 │  book snapshots, fills, klines │  │                        │
 └───────────────▲────────────────┘  └───────┬────────────────┘
                 │ logs/websocket            │
 ┌───────────────┴───────────────────────────▼────────────────┐
 │  programs/clob/  — Anchor program (source of truth)        │
 │  Market · OrderBookSide ×2 · OpenOrders · vaults           │
 └────────────────────────────────────────────────────────────┘
```

## On-chain account model

```
Market            PDA ["market", base_mint, quote_mint]
├─ base_vault     PDA ["base_vault", market]   token acct, authority = market
├─ quote_vault    PDA ["quote_vault", market]  token acct, authority = market
├─ bids           PDA ["bids", market]         zero-copy OrderBookSide
├─ asks           PDA ["asks", market]         zero-copy OrderBookSide
└─ (M2) event_q   PDA ["events", market]       zero-copy ring buffer

OpenOrders        PDA ["open_orders", market, owner]   one per user per market
```

Design decisions and the reasoning behind them:

- **Vault authority is the market PDA.** Users' tokens are pooled in two
  vaults; `OpenOrders` is the ledger over them. Only the program can sign
  vault transfers (`invoke_signed` with the market seeds), and it only
  does so in `withdraw` against a sufficient *free* balance.
- **Free vs locked balances.** Placing an order moves `free → locked`;
  cancelling moves it back; (M2) fills move locked funds between the two
  currencies. Locked funds can't be withdrawn, so every resting order is
  always fully collateralized — no failed settlements by construction.
- **Zero-copy orderbook.** The book is ~7.2 KB; borsh-deserializing it on
  every instruction would blow the compute budget, so Anchor casts the
  raw bytes in place (`AccountLoader`, `load`/`load_mut`/`load_init`).
  M1 uses a sorted array (O(n) insert, 128 orders/side, dead simple to
  verify); the M2 stretch goal swaps in a crit-bit slab like Serum's
  without changing any instruction interface.
- **Integer-only math.** Prices are in *ticks*, quantities in *lots*
  (see `state/market.rs`). All conversions are `checked_*`; overflow is
  a clean error, never a wrap.

## Why matching needs an event queue (M2 — implemented)

When a taker order fills against a resting maker order, the maker's
proceeds must be credited to the maker's `OpenOrders` — but that account
was not passed into the taker's transaction (the taker can't know every
maker they'll hit, and Solana requires all touched accounts up front).

The classic Serum answer: matching writes `Fill` events into an on-chain
ring buffer, and a permissionless **crank** later calls `consume_events`
with a batch of maker `OpenOrders` accounts (via `remaining_accounts`) to
apply the credits. This is the single most instructive piece of Solana
architecture in the project — it exists purely because of the account
model, and it's why every serious Solana protocol runs off-chain workers.

## Off-chain stack (M3)

- **Indexer (Rust, tokio + Axum):** subscribes to program logs over
  websocket, decodes Anchor events, writes fills/orders/balances to
  Postgres, maintains candles. Serves REST (history, markets) and fans
  out websocket streams (book deltas, trades) to the frontend.
- **Frontend (Next.js 15 + Tailwind + shadcn/ui):** wallet adapter for
  signing, TradingView `lightweight-charts` for candles, custom orderbook
  ladder component. All reads come from the indexer; only transactions
  touch RPC.

## Frontend design spec — "trading terminal"

The reference aesthetic is Hyperliquid/Drift: a dense, dark, professional
terminal where color is information.

- **Layout:** CSS grid, four regions — chart (top-left, dominant),
  orderbook ladder + recent trades (right column), trade ticket (far
  right), positions/orders/balances tabs (bottom strip). No page scroll;
  panels scroll internally.
- **Color:** near-black neutral background (`#0a0b0d` family), one brand
  accent used sparingly (links, active tab, primary button). Green/red
  are reserved exclusively for price semantics — buys/sells, P&L up/down.
  Everything else stays neutral so the money colors pop.
- **Type:** Inter (or Geist) for UI; all numerals in `font-variant-numeric:
  tabular-nums` (or a mono like JetBrains Mono) so columns of prices
  don't jitter as they tick.
- **Motion:** flash-fade on orderbook rows when a level changes (300 ms
  background pulse, green for size up, red for size down); count-up
  animation on balances; skeletons for every async region. Nothing
  bounces — micro-interactions only.
- **Depth visualization:** each ladder row gets a horizontal background
  bar proportional to cumulative size, mirrored bids vs asks.
- **Keyboard-first:** ⌘K command palette (switch market, place order),
  hotkeys on the ticket. It should feel like software for professionals.

## Milestones as a learning map

| Milestone | Anchor/Solana concepts it forces you to learn |
|---|---|
| M1 (done) | PDAs & seeds, account constraints (`has_one`, custom), CPIs to the token program, PDA signing, zero-copy accounts, events, rent/space |
| M2 (done) | event queues & cranks, `remaining_accounts`, the 10,240-byte CPI-init account cap, compute-budget guards (fill cap), fee accounting. Open stretch: crit-bit slab |
| M3 | log subscription & event decoding, IDL-driven clients, transaction building on the frontend, priority fees |
| M4 | oracle (Pyth) accounts, i80f48-style fixed point, cross-instruction invariants, liquidation game theory, security review |
