/**
 * Tape keeper: keeps the live devnet market looking alive. The committed
 * tape-maker burner replenishes a post-only grid around the current mid,
 * and the terminal's dev wallet IOC-crosses it, printing real on-chain
 * trades that flow through the indexer to the terminal. Cranks
 * consume_events as it goes.
 *
 *   node scripts/tape-run.mjs            (~90s of tape by default)
 *
 * No secrets: both keypairs are devnet-only burners committed to the
 * repo, fee-paid by the dev wallet (run tape-setup.mjs once to fund).
 * Runs on a schedule from .github/workflows/tape.yml.
 */
import anchorNs from "@coral-xyz/anchor";
const anchor = anchorNs.default ?? anchorNs;
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const MARKET = new PublicKey(process.env.MARKET ?? "Hjk9AaSAs9oGaLA4h62rYi5ppEpYioGANydy7ZosU3vN");
// `||` not `??`: the workflow may pass INDEXER="" when the repo var is unset.
const INDEXER = process.env.INDEXER || "https://matchbook-indexer.onrender.com";
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 90);
// Makers whose resting orders predate the tape keeper: their OpenOrders
// must ride along on the crank or the event queue halts at their fills.
const EXTRA_MAKERS = (process.env.EXTRA_MAKERS ?? "2xPsg1Cx6ufvmcwNohEhNJRKxKjQVyzMPMR7XjNxYVcj")
  .split(",")
  .filter(Boolean)
  .map((s) => new PublicKey(s));

const idl = JSON.parse(fs.readFileSync("app/lib/idl/clob.json", "utf-8"));
const n = (x) => new anchor.BN(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const dev = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("app/lib/dev-wallet.json", "utf-8"))),
);
const maker = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("scripts/tape-maker.json", "utf-8"))),
);

const connection = new anchor.web3.Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(dev), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const Bid = { bid: {} };
const Ask = { ask: {} };
const PostOnly = { postOnly: {} };
const IOC = { immediateOrCancel: {} };

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const bids = pda(Buffer.from("bids"), MARKET.toBuffer());
const asks = pda(Buffer.from("asks"), MARKET.toBuffer());
const eventQueue = pda(Buffer.from("events"), MARKET.toBuffer());
const oo = (owner) => pda(Buffer.from("open_orders"), MARKET.toBuffer(), owner.toBuffer());
const devOO = oo(dev.publicKey);
const makerOO = oo(maker.publicKey);
const crankOOs = [devOO, makerOO, ...EXTRA_MAKERS.map(oo)];

async function withRetry(fn, label, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !String(err).includes("429")) throw err;
      const wait = 4000 * (i + 1);
      console.log(`${label}: rate-limited, retrying in ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
}

// Top the dev wallet up from the faucet when it runs low. Best-effort:
// the faucet often rate-limits, and a run only costs ~0.001 SOL anyway.
const balance = await connection.getBalance(dev.publicKey);
console.log("dev wallet:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL");
if (balance < 0.02 * LAMPORTS_PER_SOL) {
  await connection
    .requestAirdrop(dev.publicKey, LAMPORTS_PER_SOL)
    .then(() => console.log("airdropped 1 SOL to dev wallet"))
    .catch((err) => console.log("airdrop declined (fine):", String(err).slice(0, 80)));
}

// Center the tape on the current mid so it continues where it left off.
let center = 500n;
try {
  const res = await fetch(`${INDEXER}/markets/${MARKET.toBase58()}/book`);
  const { book } = await res.json();
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  if (bestBid && bestAsk) center = BigInt(Math.round((bestBid + bestAsk) / 2));
  else if (bestBid) center = BigInt(bestBid + 1);
  else if (bestAsk) center = BigInt(bestAsk - 1);
} catch {
  console.log("indexer book unavailable, using default center");
}
const CENTER_START = center;
console.log(`tape for ${DURATION_SEC}s around center ${center}`);

function place(user, side, price, qty, type) {
  return program.methods
    .placeOrder(side, n(price), n(qty), type)
    .accountsPartial({ owner: user.publicKey, market: MARKET, openOrders: oo(user.publicKey), bids, asks, eventQueue })
    .signers([user])
    .rpc();
}

function crank() {
  return program.methods
    .consumeEvents(16)
    .accountsPartial({ cranker: dev.publicKey, market: MARKET, eventQueue })
    .remainingAccounts(crankOOs.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
    .signers([dev])
    .rpc();
}

// Hygiene: as the center drifts run to run, the maker's old quotes pile
// up far from the mid. Cancel anything stale so the book stays a tight,
// honest grid instead of an archaeological record.
const STALE_TICKS = 15n;
try {
  const rows = await fetch(
    `${INDEXER}/markets/${MARKET.toBase58()}/orders?owner=${maker.publicKey.toBase58()}&status=open`,
  ).then((r) => r.json());
  const stale = rows.filter((o) => {
    const dist = BigInt(o.price) > center ? BigInt(o.price) - center : center - BigInt(o.price);
    return dist > STALE_TICKS;
  });
  for (const o of stale.slice(0, 12)) {
    await program.methods
      .cancelOrder(o.side === 0 ? Bid : Ask, n(o.order_id))
      .accountsPartial({
        owner: maker.publicKey,
        market: MARKET,
        openOrders: makerOO,
        bids,
        asks,
      })
      .signers([maker])
      .rpc()
      .catch((err) => console.log("stale cancel skipped:", String(err).slice(0, 80)));
    await sleep(400);
  }
  if (stale.length) console.log(`canceled ${Math.min(stale.length, 12)} stale maker orders`);
} catch (err) {
  console.log("stale sweep skipped:", String(err).slice(0, 80));
}

// Stock the grid first so the taker always has something to cross.
for (let i = 1; i <= 4; i++) {
  await place(maker, Bid, center - BigInt(i), BigInt(rand(10, 60)), PostOnly).catch(() => {});
  await sleep(500);
  await place(maker, Ask, center + BigInt(i), BigInt(rand(10, 60)), PostOnly).catch(() => {});
  await sleep(500);
}

const deadline = Date.now() + DURATION_SEC * 1000;
let trades = 0;
while (Date.now() < deadline) {
  // Mean-reverting random walk, same shape as the seeder's.
  const buy = Math.random() < 0.5 + Number(center - CENTER_START) * -0.01;
  try {
    await place(dev, buy ? Bid : Ask, buy ? center + 20n : center - 20n, BigInt(rand(1, 12)), IOC);
    trades++;
    center += buy ? 1n : -1n;
  } catch (err) {
    console.error("ioc failed:", String(err).slice(0, 120));
    if (String(err).includes("429")) await sleep(5000);
  }

  if (trades % 3 === 0) {
    const side = Math.random() < 0.5 ? Bid : Ask;
    const off = BigInt(rand(1, 6));
    await place(
      maker,
      side,
      side === Bid ? center - off : center + off,
      BigInt(rand(10, 50)),
      PostOnly,
    ).catch(() => {}); // WouldCross after drift — fine
  }

  if (trades % 6 === 0) await withRetry(crank, "crank").catch((e) => console.error("crank:", String(e).slice(0, 120)));
  await sleep(rand(1000, 2200));
}

await withRetry(crank, "final crank").catch(() => {});
console.log(`done: ${trades} trades printed around center ${center}`);
