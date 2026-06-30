# Solana CLOB DEX

A central limit orderbook exchange on Solana, built as a deep-dive into
Anchor and on-chain systems design. Spot markets first, perpetual futures
later.

**Program ID (devnet/localnet):** `9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2`

## Layout

```
programs/clob/    Anchor program (Rust) — markets, vaults, orderbook
indexer/          (M3) Rust service: event ingestion, Postgres, websockets
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

## Trading terminal

The `app/` terminal runs on the Windows side (Node 18.17 → Next.js 14):

```bash
cd app
npm run dev       # http://localhost:3000
npm test          # vitest unit tests: mock feed + order/balance logic
npm run test:e2e  # puppeteer smoke test (needs `npm start` running first)
```

It is fully wired to a simulated feed (`app/lib/mock.ts`): random-walk
price, persistent orderbook levels, trade tape, candles, mock wallet,
balances, and a simulated order lifecycle (place → pending → open →
filled when the tape crosses). Swapping `MockFeed` for the M3 indexer
websocket is the only integration point.

## Roadmap

- [x] **M1 — Book-keeping core**: markets, PDA vaults, deposits and
      withdrawals, post-only limit orders, cancels, events.
- [x] **M2 — Matching**: `place_order` (limit / post-only / IOC) matches
      takers against the book with price improvement, taker fees accrue
      to the market, fills flow through an on-chain event queue and the
      permissionless `consume_events` crank settles maker proceeds.
      Stretch (open): replace the sorted-array book with a crit-bit slab.
- [ ] **M3 — Off-chain stack**: Rust indexer (Helius/RPC websocket →
      Postgres), REST + websocket API, Next.js trading terminal.
- [ ] **M4 — Perps**: Pyth oracle integration, margin accounts, funding
      rate, liquidation instruction + liquidator bot.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.
