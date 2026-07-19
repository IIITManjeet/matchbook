/**
 * Localnet market seeder: creates a fresh market, rests a bid/ask grid,
 * then streams small crossing orders so the indexer (and terminal) have
 * a live book, trade tape and candles to show.
 *
 *   node scripts/seed-market.mjs [minutes]     (default 3)
 *
 * Needs the WSL validator on :8899 and the program deployed.
 */
import anchorNs from "@coral-xyz/anchor";
// CJS/ESM interop: under node .mjs the real exports may sit on .default.
const anchor = anchorNs.default ?? anchorNs;
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "node:fs";

const RPC = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const MINUTES = Number(process.argv[2] ?? 3);

const TICK = 100n; // quote atoms per (lot × tick)
const LOT = 1_000_000n; // base atoms per lot
const FEE_BPS = 10;
const CENTER_START = 500n; // ticks → 50.00 USDC/SOL in the UI

const idl = JSON.parse(fs.readFileSync("target/idl/clob.json", "utf-8"));
const n = (x) => new anchor.BN(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const connection = new anchor.web3.Connection(RPC, "confirmed");
// On a public cluster the payer can't be airdropped 100 SOL, so load a
// pre-funded keypair from PAYER_KEYPAIR; localnet generates + airdrops.
const payer = process.env.PAYER_KEYPAIR
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PAYER_KEYPAIR, "utf-8"))))
  : Keypair.generate();
const maker = Keypair.generate();
const taker = Keypair.generate();
// The terminal's burner wallet: fund + deposit for it so the UI can
// trade this market straight away.
const dev = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("app/lib/dev-wallet.json", "utf-8"))),
);

const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");

const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
  commitment: "confirmed",
  // Preflight simulation doubles the RPC load, but the public devnet
  // endpoint rejects skipPreflight sends outright ("Unknown action
  // 'undefined'"), so it must stay opt-in for RPCs that allow it.
  skipPreflight: process.env.SKIP_PREFLIGHT === "1",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const Bid = { bid: {} };
const Ask = { ask: {} };
const PostOnly = { postOnly: {} };
const IOC = { immediateOrCancel: {} };

// The public devnet RPC 429s under bursts. Back off and retry instead of
// dying; anything that isn't a rate limit still throws immediately.
async function withRetry(fn, label, attempts = 6) {
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

// Gap between setup transactions on public clusters so we stay under the
// per-IP request budget; localnet doesn't need it.
const pace = () => (isLocal ? Promise.resolve() : sleep(600));

async function airdrop(to, sol) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// Fund a keypair with SOL. Localnet airdrops freely; on public clusters
// (devnet) airdrops are capped and rate-limited, so move SOL from the
// pre-funded payer instead.
async function fundSol(to, sol) {
  if (isLocal) return airdrop(to, sol);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports: sol * LAMPORTS_PER_SOL,
    }),
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
}

console.log("funding accounts…");
if (isLocal) {
  await airdrop(payer.publicKey, 100);
} else if (!process.env.PAYER_KEYPAIR) {
  throw new Error("public cluster: set PAYER_KEYPAIR to a funded keypair (airdrops can't cover the payer)");
}
// Actors only pay tx fees; rent comes out of the payer. FUND_SOL trims
// this when the payer itself is running low (devnet faucet throttling).
const FUND_SOL = Number(process.env.FUND_SOL ?? 2);
await withRetry(() => fundSol(maker.publicKey, FUND_SOL), "fund maker");
await pace();
await withRetry(() => fundSol(taker.publicKey, FUND_SOL), "fund taker");
await pace();
await withRetry(() => fundSol(dev.publicKey, FUND_SOL), "fund dev");
await pace();

// A prior run that died mid-way already paid for the mints and market;
// pass BASE_MINT/QUOTE_MINT to resume against them instead of re-paying.
const baseMint = process.env.BASE_MINT
  ? new PublicKey(process.env.BASE_MINT)
  : await withRetry(() => createMint(connection, payer, payer.publicKey, null, 9), "base mint");
await pace();
const quoteMint = process.env.QUOTE_MINT
  ? new PublicKey(process.env.QUOTE_MINT)
  : await withRetry(() => createMint(connection, payer, payer.publicKey, null, 6), "quote mint");
await pace();

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const market = pda(Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer());
const baseVault = pda(Buffer.from("base_vault"), market.toBuffer());
const quoteVault = pda(Buffer.from("quote_vault"), market.toBuffer());
const bids = pda(Buffer.from("bids"), market.toBuffer());
const asks = pda(Buffer.from("asks"), market.toBuffer());
const eventQueue = pda(Buffer.from("events"), market.toBuffer());
const makerOO = pda(Buffer.from("open_orders"), market.toBuffer(), maker.publicKey.toBuffer());
const takerOO = pda(Buffer.from("open_orders"), market.toBuffer(), taker.publicKey.toBuffer());
const devOO = pda(Buffer.from("open_orders"), market.toBuffer(), dev.publicKey.toBuffer());

console.log("market:", market.toBase58());

if (await connection.getAccountInfo(market)) {
  console.log("market already initialized, resuming");
} else {
  await withRetry(
    () =>
      program.methods
        .initMarket(n(TICK), n(LOT), FEE_BPS)
      .accountsPartial({
        payer: payer.publicKey,
        baseMint,
        quoteMint,
        market,
        baseVault,
        quoteVault,
        bids,
        asks,
        eventQueue,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
        .signers([payer])
        .rpc(),
    "init market",
  );
}
await pace();

for (const [user, oo] of [
  [maker, makerOO],
  [taker, takerOO],
  [dev, devOO],
]) {
  if (await connection.getAccountInfo(oo)) {
    console.log("open orders exists, skipping:", oo.toBase58());
  } else {
    await withRetry(
      () =>
        program.methods
          .createOpenOrders()
          .accountsPartial({
            owner: user.publicKey,
            market,
            openOrders: oo,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc(),
      "create open orders",
    );
  }
  await pace();
}

// Both parties get both currencies: the maker quotes two-sided, the
// taker crosses in both directions.
async function fund(user, oo) {
  const baseAta = await withRetry(
    () => getOrCreateAssociatedTokenAccount(connection, payer, baseMint, user.publicKey),
    "base ata",
  );
  await pace();
  const quoteAta = await withRetry(
    () => getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, user.publicKey),
    "quote ata",
  );
  await pace();
  await withRetry(() => mintTo(connection, payer, baseMint, baseAta.address, payer, 100_000n * LOT), "mint base"); // 100 SOL
  await pace();
  await withRetry(() => mintTo(connection, payer, quoteMint, quoteAta.address, payer, 5_000_000_000n), "mint quote"); // 5,000 USDC
  await pace();
  for (const [vault, ata, amount] of [
    [baseVault, baseAta.address, 100_000n * LOT],
    [quoteVault, quoteAta.address, 5_000_000_000n],
  ]) {
    await withRetry(
      () =>
        program.methods
          .deposit(n(amount))
          .accountsPartial({
            owner: user.publicKey,
            market,
            openOrders: oo,
            vault,
            userToken: ata,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc(),
      "deposit",
    );
    await pace();
  }
}
await fund(maker, makerOO);
await fund(taker, takerOO);
await fund(dev, devOO);
console.log("terminal wallet funded:", dev.publicKey.toBase58());

function place(user, oo, side, price, qty, type) {
  return program.methods
    .placeOrder(side, n(price), n(qty), type)
    .accountsPartial({ owner: user.publicKey, market, openOrders: oo, bids, asks, eventQueue })
    .signers([user])
    .rpc();
}

function crank() {
  return program.methods
    .consumeEvents(16)
    .accountsPartial({ cranker: payer.publicKey, market, eventQueue })
    .remainingAccounts([{ pubkey: makerOO, isWritable: true, isSigner: false }])
    .signers([payer])
    .rpc();
}

let center = CENTER_START;

console.log("resting the initial grid…");
for (let i = 1; i <= 10; i++) {
  await withRetry(() => place(maker, makerOO, Bid, center - BigInt(i), BigInt(rand(5, 80)), PostOnly), "grid bid");
  await pace();
  await withRetry(() => place(maker, makerOO, Ask, center + BigInt(i), BigInt(rand(5, 80)), PostOnly), "grid ask");
  await pace();
}

console.log(`trading for ${MINUTES} minute(s)…`);
const deadline = Date.now() + MINUTES * 60_000;
let trades = 0;
while (Date.now() < deadline) {
  const buy = Math.random() < 0.5 + Number(center - CENTER_START) * -0.01;
  try {
    // Cross the book with a small IOC; price improvement means it fills
    // at the maker's level regardless of the aggressive limit.
    await place(
      taker,
      takerOO,
      buy ? Bid : Ask,
      buy ? center + 20n : center - 20n,
      BigInt(rand(1, 12)),
      IOC,
    );
    trades++;
    center += buy ? 1n : -1n;
  } catch (err) {
    console.error("ioc failed:", String(err).slice(0, 120));
    if (String(err).includes("429")) await sleep(5000);
  }

  // Keep the grid stocked near the (drifting) center.
  if (trades % 3 === 0) {
    const side = Math.random() < 0.5 ? Bid : Ask;
    const off = BigInt(rand(1, 10));
    try {
      await place(
        maker,
        makerOO,
        side,
        side === Bid ? center - off : center + off,
        BigInt(rand(5, 60)),
        PostOnly,
      );
    } catch {
      /* WouldCross when the center drifted into the level — fine */
    }
  }

  if (trades % 8 === 0) await crank().catch(() => {});
  await sleep(rand(700, 1600));
}

await crank().catch(() => {});
console.log(`done: ${trades} taker orders sent. market ${market.toBase58()}`);
