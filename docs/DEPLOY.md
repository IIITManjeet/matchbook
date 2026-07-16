# Deploying the live terminal (devnet + hosted indexer)

The GitHub Pages site is static. Its market data comes from the **indexer**
(`app/lib/indexer.ts` → `NEXT_PUBLIC_INDEXER_URL`), not from RPC. To show live
data on the public site you need three things reachable over HTTPS/WSS:

1. The CLOB program deployed to a public cluster (devnet).
2. The indexer + Postgres hosted at a public HTTPS URL.
3. The Pages build pointed at both via repo variables.

The repo already contains the container/config for step 2 and the workflow
wiring for step 3. The commands below are the parts only you can run (they need
your Solana keypair and a Fly.io account).

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

## 3. Host the indexer on Fly.io

From `indexer/` (config lives in `indexer/fly.toml`, `indexer/Dockerfile`):

```bash
cd indexer
fly launch --no-deploy                 # creates the app; keep the generated name
fly postgres create --name matchbook-db --region iad
fly postgres attach matchbook-db       # injects DATABASE_URL as a secret
fly deploy
```

`fly.toml` already sets `RPC_HTTP`/`RPC_WS` to devnet, the `PROGRAM_ID`, and
`LISTEN_ADDR=0.0.0.0:8080`, and keeps one machine always running (the indexer
must tail logs continuously — `auto_stop_machines = "off"`). Migrations apply
themselves on boot via `sqlx::migrate!`.

Verify:

```bash
curl https://<your-app>.fly.dev/health      # {"ok":true}
curl https://<your-app>.fly.dev/markets      # the market you seeded
```

If `/markets` is empty, the indexer hasn't caught up — check `fly logs`.
The RPC/program id can be changed without a rebuild: `fly secrets set RPC_HTTP=…`.

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

- **Mixed content**: Pages is HTTPS, so both URLs must be HTTPS/WSS. Fly
  terminates TLS at the edge and proxies to the container's plain `:8080`.
- **Trading vs viewing**: viewer/guest mode only needs the indexer. On-chain
  trading through the committed `app/lib/dev-wallet.json` burner also requires
  that wallet to be funded + deposited on devnet — the seeder does this for the
  market it creates. Real users would connect their own wallet instead.
- **Cost**: a Fly Postgres + one always-on shared-cpu machine is the ongoing
  cost. Scale to zero is not an option here because indexing must run
  continuously.
- **Keeping data fresh**: devnet has no organic flow on this market, so re-run
  the seeder (step 2) whenever you want new trades/candles.
