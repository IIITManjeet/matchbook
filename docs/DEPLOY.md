# Deploying the live terminal (devnet + hosted indexer)

The GitHub Pages site is static. Its market data comes from the **indexer**
(`app/lib/indexer.ts` → `NEXT_PUBLIC_INDEXER_URL`), not from RPC. To show live
data on the public site you need three things reachable over HTTPS/WSS:

1. The CLOB program deployed to a public cluster (devnet).
2. The indexer + Postgres hosted at a public HTTPS URL.
3. The Pages build pointed at both via repo variables.

The repo already contains the container/config for step 2 and the workflow
wiring for step 3. The commands below are the parts only you can run (they need
your Solana keypair and a Render account).

---

## 1. Deploy the program to devnet

Anchor builds are WSL-only on this machine. In WSL, from the repo root:

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 5                 # deployer funds; repeat if rate-limited
anchor build
anchor deploy --provider.cluster devnet
```

`Anchor.toml` already pins the program id `9bezj1VA…Wtr2` under
`[programs.devnet]`, so it deploys to that address (the deployer must hold
`target/deploy/clob-keypair.json`). If `solana airdrop` is throttled, use
<https://faucet.solana.com>.

## 2. Seed a market on devnet

The seeder now takes a pre-funded payer (devnet can't airdrop 100 SOL) and
funds the maker/taker/burner by transfer. Fund a keypair first:

```bash
solana-keygen new -o seed-payer.json          # or reuse your deployer key
solana airdrop 5 $(solana address -k seed-payer.json) --url devnet

ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
PAYER_KEYPAIR=seed-payer.json \
node scripts/seed-market.mjs 5                 # 5 minutes of crossing orders
```

Note the printed `market:` pubkey — you can pin it later as
`NEXT_PUBLIC_MARKET`, otherwise the terminal auto-picks the newest spot market.
Devnet is slower than localnet; a short run still produces a book, tape, and
candles. Re-run to add activity.

Devnet knobs (all optional):

- `FUND_SOL=0.05` — SOL transferred to each actor (default 2). The actors
  only pay tx fees, so this can be tiny when the payer is low and the
  faucet (<https://faucet.solana.com>) is throttling.
- `BASE_MINT=… QUOTE_MINT=…` — resume a run that died mid-way (public RPC
  429s). The seeder skips `initMarket`/`createOpenOrders` for accounts
  that already exist, so the rent a dead run paid isn't wasted. The mint
  addresses live at bytes 8..72 of the market account if you lost them.

The seeder now retries 429s with backoff and paces setup transactions on
public clusters. `SKIP_PREFLIGHT=1` halves the RPC load by skipping
simulation, but the public devnet endpoint rejects such sends with
`Unknown action 'undefined'` — leave it unset there.

## 3. Host the indexer on Render (free tier)

`render.yaml` at the repo root is a Render Blueprint for the indexer
(Docker build of `indexer/`, devnet RPC, `PROGRAM_ID`, `/health` check).
In the [Render dashboard](https://dashboard.render.com):

1. **New → Postgres** — name it `matchbook-db`, region **Singapore**,
   plan **Free**. Copy its **Internal Database URL** once created.
   (Render's free Postgres is deleted after 30 days; use
   [Neon](https://neon.tech)'s free tier instead if the site should
   outlive that — the indexer speaks TLS, both work.)
2. **New → Blueprint** — connect the GitHub repo. Render reads
   `render.yaml` and prompts for `DATABASE_URL`; paste the URL from
   step 1. Deploy.

Migrations apply themselves on boot via `sqlx::migrate!`. Verify:

```bash
curl https://<your-service>.onrender.com/health       # {"ok":true}
curl https://<your-service>.onrender.com/markets      # the market you seeded
```

If `/markets` is empty, the indexer hasn't caught up — check the service
logs in the dashboard. Env vars (RPC, program id) can be changed there
without a rebuild.

**Spin-down**: free instances stop after ~15 min without inbound traffic,
which would halt log ingestion. `.github/workflows/keepalive.yml` pings
`/health` every 5 minutes to prevent this — it activates once the
`NEXT_PUBLIC_INDEXER_URL` repo variable (step 4) is set, and GitHub
disables it after 60 days without repo activity (any commit re-arms it).

(`indexer/fly.toml` remains for the paid Fly.io alternative — always-on
machine, no keep-alive needed.)

## 4. Point the Pages site at the live endpoints

Repo → **Settings → Secrets and variables → Actions → Variables** → New variable:

| Name                      | Value                                  |
| ------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_INDEXER_URL` | `https://<your-app>.fly.dev`           |
| `NEXT_PUBLIC_RPC_URL`     | `https://api.devnet.solana.com` (default; optional) |

Then re-run the **deploy terminal to github pages** workflow (Actions → Run
workflow, or push any commit). The static bundle inlines these at build time;
the app derives `wss://…/ws` from the HTTPS indexer URL automatically.

When `NEXT_PUBLIC_INDEXER_URL` is unset the terminal falls back to the mock
feed — which is the current state.

---

## Notes & caveats

- **Mixed content**: Pages is HTTPS, so both URLs must be HTTPS/WSS. Render
  terminates TLS at the edge and proxies to the container's plain `:8080`.
- **Trading vs viewing**: viewer/guest mode only needs the indexer. On-chain
  trading through the committed `app/lib/dev-wallet.json` burner also requires
  that wallet to be funded + deposited on devnet — the seeder does this for the
  market it creates. Real users would connect their own wallet instead.
- **Cost**: free on Render's free tier (750 instance-hours/month covers one
  always-up service) as long as the keep-alive ping keeps it from idling.
  The free Render Postgres expires after 30 days — swap `DATABASE_URL` to a
  free Neon database for something permanent.
- **Keeping data fresh**: devnet has no organic flow on this market, so re-run
  the seeder (step 2) whenever you want new trades/candles.
