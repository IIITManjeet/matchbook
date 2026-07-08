# Matchbook

A central limit orderbook DEX on Solana — a matching engine and an order
book in one word. Built as a deep-dive into Anchor and on-chain systems
design. Spot markets first, perpetual futures later.

**Program ID (devnet/localnet):** `9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2`

## Layout

```
programs/clob/    Anchor program (Rust) — markets, vaults, orderbook
indexer/          Rust service: event ingestion → Postgres → REST + websockets
app/              Next.js trading terminal (mock feed for now; real data in M3)
tests/            Anchor integration tests
docs/             Architecture and design notes
```

## Toolchain

Anchor has no native Windows support — all program work happens in WSL2
Ubuntu (`wsl -d Ubuntu`), which has Solana CLI 2.1 + Anchor 0.31.1
installed. Editing happens on the Windows side; the repo lives at
`D:\solana` = `/mnt/d/solana` in WSL.

```bash
# inside WSL
cd /mnt/d/solana
anchor build          # compile the program + generate the IDL
solana-test-validator # run a local cluster
anchor deploy         # deploy to it
```

Integration tests run from the **Windows** side (WSL has no native
node) against the WSL validator over localhost:

```powershell
cd D:\solana
npm test              # tsc + mocha, tests/clob.ts
```

## Indexer

The M3 indexer (`indexer/`) builds and runs natively on Windows — it
only talks to the validator over RPC. Rust ≥ 1.85 required.

```powershell
cd D:\solana\indexer
docker compose up -d  # Postgres 16 on localhost:5433
cargo run             # backfill + live tail, API on http://127.0.0.1:8081
cargo test            # event decoding + book reconstruction unit tests
```

See [indexer/README.md](indexer/README.md) for the API and design notes.

To generate localnet activity for the indexer and terminal to display:

```powershell
node scripts/seed-market.mjs 5   # spot: fresh market, resting grid, 5 min of trades
node scripts/perp-keeper.mjs 10  # perps: oracle pusher + funding crank + liquidator bot
```

The keeper creates the SOL-PERP market on first run, funds the
terminal's burner wallet with 10k USDC of margin, then streams oracle
prices, turns the funding crank and liquidates underwater accounts.

## Trading terminal

The `app/` terminal runs on the Windows side (Node 18.17 → Next.js 14):

```bash
cd app
npm run dev       # http://localhost:3000
npm test          # vitest unit tests: mock feed + order/balance logic
npm run test:e2e  # puppeteer smoke test (needs `npm start` running first)
```

On load it probes the indexer and streams real book deltas, trades and
candles from it (REST bootstrap + websocket), falling back to the
`app/lib/mock.ts` simulator when the indexer is down. With the indexer
up, **Connect Wallet** uses a localnet burner keypair
(`app/lib/dev-wallet.json`, funded by the market seeder) and the ticket
signs real `place_order` / `cancel_order` transactions: balances come
from the on-chain `OpenOrders` account, orders and fills from the
indexer. The signer sits behind a wallet-adapter-shaped interface, so a
browser-extension wallet is a drop-in for devnet later.

The terminal opens on a login screen: connect the wallet or explore as
a read-only guest. Roles are derived from on-chain state in one batched
`getMultipleAccounts` call (`app/lib/roles.ts`) — the perp market's
admin is the **operator**, a connected wallet is a **trader**, guests
are **viewers**; the top bar shows the resolved role and operator-only
surfaces render for the operator wallet alone.

The terminal lists both markets — the spot book and SOL-PERP — behind
a switcher in the top bar. In perp mode the ticket goes Long/Short with
margin math, the book panel becomes an oracle/funding readout, and the
bottom strip shows the live position (entry, mark, uPnL, liquidation
price, pending funding) plus collateral deposit/withdraw.

```bash
npm run test:e2e:sign   # e2e: connect → rest bid → verify lock → cancel → market buy
npm run test:e2e:perps  # e2e: switch to SOL-PERP → long → verify position → close
```

## Roadmap

- [x] **M1 — Book-keeping core**: markets, PDA vaults, deposits and
      withdrawals, post-only limit orders, cancels, events.
- [x] **M2 — Matching**: `place_order` (limit / post-only / IOC) matches
      takers against the book with price improvement, taker fees accrue
      to the market, fills flow through an on-chain event queue and the
      permissionless `consume_events` crank settles maker proceeds.
      Stretch (open): replace the sorted-array book with a crit-bit slab.
- [x] **M3 — Off-chain stack**: Rust indexer (log subscription →
      Postgres, restart-safe backfill, live book reconstruction, 1m
      candles) with REST + websocket API. Terminal runs on the live
      indexer feed (simulator fallback) and signs real orders with a
      localnet burner wallet — placement, cancels, locks and fills all
      verified end-to-end. Devnet polish left: browser-extension
      wallets via the adapter interface.
- [x] **M4 — Perps**: SOL-PERP margined in USDC. Positions fill against
      a keeper-pushed oracle (Pyth-shaped, freshness-enforced); margin
      accounts net one position with VWAP entry and settle-funding-first
      invariants; funding accrues from open-interest skew via a
      permissionless crank; anyone can liquidate below maintenance for
      half the penalty. Keeper + liquidator bot in `scripts/`, perp
      trading UI with positions, collateral management and a market
      switcher in the terminal. Devnet polish left: real Pyth account +
      extension wallets.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.
