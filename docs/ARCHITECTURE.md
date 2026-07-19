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
└─ event_q        PDA ["events", market]       zero-copy ring buffer

OpenOrders        PDA ["open_orders", market, owner]   one per user per market
```

Design decisions and the reasoning behind them:

- **Vault authority is the market PDA.** Users' tokens are pooled in two
  vaults; `OpenOrders` is the ledger over them. Only the program can sign
  vault transfers (`invoke_signed` with the market seeds), and it only
  does so in `withdraw` against a sufficient *free* balance.
- **Free vs locked balances.** Placing an order moves `free → locked`;
  cancelling moves it back; fills move locked funds between the two
  currencies. Locked funds can't be withdrawn, so every resting order is
  always fully collateralized — no failed settlements by construction.
- **Zero-copy orderbook.** The book is ~7.2 KB; borsh-deserializing it on
  every instruction would blow the compute budget, so Anchor casts the
  raw bytes in place (`AccountLoader`, `load`/`load_mut`/`load_init`).
  The book is a sorted array (O(n) insert, 128 orders/side, dead simple
  to verify); a crit-bit slab like Serum's could be swapped in without
  changing any instruction interface.
- **Integer-only math.** Prices are in *ticks*, quantities in *lots*
  (see `state/market.rs`). All conversions are `checked_*`; overflow is
  a clean error, never a wrap.

## Why matching needs an event queue

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

## Off-chain stack

- **Indexer (Rust, tokio + Axum):** subscribes to program logs over
  websocket, decodes Anchor events, writes fills/orders/balances to
  Postgres, maintains candles. Serves REST (history, markets) and fans
  out websocket streams (book deltas, trades) to the frontend.
- **Frontend (Next.js 14 + Tailwind + shadcn/ui):** wallet adapter for
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

## Perpetual futures

Perps live in the same program as the spot CLOB but trade differently:
positions fill against an **oracle price**, not an orderbook. That keeps
the interesting problems — margin, funding, liquidation — front and
center instead of duplicating the matching engine.

- **Oracle.** A keeper-pushed price on the `PerpMarket` account, gated
  to the market admin, with a 60-second freshness rule enforced on every
  trade. The field layout (price + publish time) deliberately mirrors a
  Pyth price account so devnet integration is a account-read swap, not a
  redesign.
- **Margin accounts.** One `MarginAccount` PDA per (wallet, market):
  collateral, one net position, volume-weighted entry. Unrealized PnL
  and unsettled funding are always *derived* — every mutating
  instruction starts by settling funding into collateral, which makes
  the margin checks single-source-of-truth.
- **Netting.** `open_position(delta)` covers open/add/reduce/close/flip.
  Extending moves the VWAP entry; reducing realizes PnL on the closed
  portion; flipping realizes everything and opens the remainder fresh.
  The result must clear *initial* margin (10x default); withdrawals must
  too, so no instruction can leave an account at the edge.
- **Funding from skew.** A permissionless crank accrues a premium
  (bps/day, capped) proportional to open-interest imbalance into a
  lifetime accumulator; positions settle `pos × Δaccumulator`. Crowded
  longs pay shorts, pushing the book back toward balance. Accrual is
  pro-rata in elapsed time, so cranker reliability changes granularity,
  never totals.
- **Liquidation.** Anyone may close an account below maintenance margin
  (5% default) at the oracle price. The penalty (2.5% of closed
  notional, capped by remaining collateral) splits half to the
  liquidator, half to the protocol. Losses beyond collateral are
  clamped — a real venue socializes bad debt via an insurance fund;
  here the clamp is documented and deliberate.
- **Off-chain.** `scripts/perp-keeper.mjs` is oracle pusher, funding
  cranker and liquidator bot in one loop, doing the same equity math as
  the on-chain check. The indexer normalizes perp events into the spot
  tick/lot scheme on ingest, so candles, trades and the terminal's unit
  conversion work unchanged; oracle ticks drive zero-volume candles so
  the chart moves even when nobody trades.
