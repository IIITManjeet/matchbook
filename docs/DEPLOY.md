# Deployment — the live stack

The public terminal is a static export on GitHub Pages. Its market data
comes from the **indexer** (`app/lib/indexer.ts` →
`NEXT_PUBLIC_INDEXER_URL`), not from RPC, so the live stack is four
pieces:

| Piece | Where | Notes |
| --- | --- | --- |
| CLOB program | Solana devnet | `9bezj1VA…Wtr2`, pinned in `Anchor.toml` |
| Indexer | Render (free tier, Docker) | `render.yaml` blueprint at the repo root |
| Postgres | Neon (free tier) | TLS; the indexer uses rustls throughout |
| Terminal | GitHub Pages | built by `.github/workflows/pages.yml` |

## 1. Deploy the program to devnet

Anchor builds need Linux (WSL works). From the repo root:

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 5                 # deployer funds; faucet.solana.com if throttled
anchor build
anchor deploy --provider.cluster devnet
```

`Anchor.toml` pins the program id under `[programs.devnet]`, so the
deploy lands at that address (the deployer must hold
`target/deploy/clob-keypair.json`).

## 2. Seed a market

The seeder takes a pre-funded payer (devnet can't airdrop 100 SOL) and
funds the maker/taker/burner actors by transfer:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
PAYER_KEYPAIR=path/to/funded-keypair.json \
node scripts/seed-market.mjs 5                 # 5 minutes of crossing orders
```

Devnet knobs (all optional):

- `FUND_SOL=0.05` — SOL transferred to each actor (default 2). Actors
  only pay open-orders rent, so this can be tiny when the faucet is
  throttling.
- `BASE_MINT=… QUOTE_MINT=…` — resume a run that died mid-way. The
  seeder skips `initMarket`/`createOpenOrders` for accounts that already
  exist, so rent a dead run paid isn't wasted.
- `SKIP_PREFLIGHT=1` — halves the RPC load by skipping simulation, but
  the public devnet endpoint rejects such sends (`Unknown action
  'undefined'`) — leave it unset there.

The seeder retries 429s with backoff and paces setup transactions on
public clusters. Re-run it (or a fees-only variant that crosses the
existing grid) whenever the tape should show fresh activity.

## 3. Host the indexer

`render.yaml` is a Render Blueprint: Docker build of `indexer/`, free
plan, `/health` check, devnet RPC and program id preset. Create a
Postgres first — [Neon](https://neon.tech)'s free tier is permanent
(Render's own free Postgres deletes itself after 30 days) — then create
the Blueprint and paste the connection string when prompted for
`DATABASE_URL`. Migrations apply themselves on boot via
`sqlx::migrate!`.

Verify:

```bash
curl https://<service>.onrender.com/health       # {"ok":true}
curl https://<service>.onrender.com/markets      # the market you seeded
```

**Spin-down**: Render free instances stop after ~15 idle minutes, which
would halt log ingestion. An external uptime monitor (e.g. UptimeRobot,
free) hitting `/health` every 5 minutes keeps the service warm and
doubles as downtime alerting. `.github/workflows/keepalive.yml` does
the same from GitHub Actions as a backup, but scheduled workflows get
throttled to roughly hourly, so don't rely on it alone.

## 4. Point the Pages site at the indexer

Repo → **Settings → Secrets and variables → Actions → Variables**:

| Name                      | Value                          |
| ------------------------- | ------------------------------ |
| `NEXT_PUBLIC_INDEXER_URL` | `https://<service>.onrender.com` |

Re-run the Pages workflow (or push). The static bundle inlines the URL
at build time and derives `wss://…/ws` from it automatically. When the
variable is unset the terminal falls back to its built-in simulator
feed.

## Notes

- **Mixed content**: Pages is HTTPS, so the indexer URL must be
  HTTPS/WSS. Render terminates TLS at the edge and proxies to the
  container's plain `:8080`.
- **Trading vs viewing**: viewer/guest mode only needs the indexer.
  Trading through the committed burner wallet also requires that wallet
  funded + deposited on devnet — the seeder does this. Real users would
  connect their own wallet.
- **Cost**: the whole stack runs on free tiers — Pages, Render (750
  instance-hours/month covers one always-warm service), Neon, and the
  uptime monitor.
- **Data freshness**: devnet has no organic flow, so re-run the seeder
  (step 2) whenever you want new trades and candles.
