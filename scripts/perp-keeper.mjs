/**
 * Perp market keeper: the off-chain half of M4.
 *
 *   node scripts/perp-keeper.mjs [minutes]      (default 10)
 *
 * On first run it creates the perp market (becoming its admin / oracle
 * keeper), funds the terminal's burner wallet with deposited collateral,
 * and persists its own state to scripts/.perp-state.json (gitignored)
 * so later runs keep pushing prices to the same market. Then it loops:
 *
 *   every ~2s   push a random-walk oracle price
 *   every ~20s  turn the funding crank (on-chain rate-limits to the
 *               market's funding interval)
 *   every ~10s  scan all margin accounts and liquidate any that sit
 *               below maintenance margin — the "liquidator bot" the
 *               M4 roadmap calls for, kept honest by doing the same
 *               equity math the program does.
 */
import anchorNs from "@coral-xyz/anchor";
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
const MINUTES = Number(process.argv[2] ?? 10);
const STATE_FILE = "scripts/.perp-state.json";

const P = (usdc) => Math.round(usdc * 1_000_000);
const BASE_UNIT = 1_000_000_000n;

const idl = JSON.parse(fs.readFileSync("target/idl/clob.json", "utf-8"));
const n = (x) => new anchor.BN(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connection = new anchor.web3.Connection(RPC, "confirmed");

// ── Load or create the keeper's world ──────────────────────────────────

let admin, usdcMint, perpMarket, vault, freshMarket;
if (fs.existsSync(STATE_FILE)) {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  admin = Keypair.fromSecretKey(Uint8Array.from(s.admin));
  usdcMint = new PublicKey(s.usdcMint);
  perpMarket = new PublicKey(s.perpMarket);
  vault = new PublicKey(s.vault);
  // A reset validator wipes the market; detect and recreate.
  freshMarket = (await connection.getAccountInfo(perpMarket)) === null;
} else {
  freshMarket = true;
}

const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(admin ?? (admin = Keypair.generate())),
  { commitment: "confirmed" },
);
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

async function airdrop(to, sol) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

if (freshMarket) {
  console.log("creating perp market…");
  await airdrop(admin.publicKey, 100);
  usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  [perpMarket] = PublicKey.findProgramAddressSync(
    [Buffer.from("perp"), usdcMint.toBuffer()],
    program.programId,
  );
  [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("perp_vault"), perpMarket.toBuffer()],
    program.programId,
  );

  // $50 start, 60s funding interval, 100 bps/day max funding premium,
  // 10 bps taker, 10x max leverage, 5% maintenance, 2.5% liq penalty.
  await program.methods
    .initPerpMarket(n(P(50)), n(60), 100, 10, 1000, 500, 250)
    .accountsPartial({
      payer: admin.publicKey,
      collateralMint: usdcMint,
      perpMarket,
      collateralVault: vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();

  // Fund the terminal's burner wallet: margin account + 10k USDC in.
  const dev = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("app/lib/dev-wallet.json", "utf-8"))),
  );
  await airdrop(dev.publicKey, 10);
  const [devMargin] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin"), perpMarket.toBuffer(), dev.publicKey.toBuffer()],
    program.programId,
  );
  await program.methods
    .createMarginAccount()
    .accountsPartial({
      owner: dev.publicKey,
      perpMarket,
      marginAccount: devMargin,
      systemProgram: SystemProgram.programId,
    })
    .signers([dev])
    .rpc();
  const devAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, dev.publicKey);
  await mintTo(connection, admin, usdcMint, devAta.address, admin, 100_000_000_000n); // 100k USDC
  await program.methods
    .depositCollateral(n(10_000_000_000n)) // 10k USDC
    .accountsPartial({
      owner: dev.publicKey,
      perpMarket,
      marginAccount: devMargin,
      collateralVault: vault,
      userToken: devAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([dev])
    .rpc();
  console.log("terminal wallet margin funded: 10,000 USDC");

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      admin: Array.from(admin.secretKey),
      usdcMint: usdcMint.toBase58(),
      perpMarket: perpMarket.toBase58(),
      vault: vault.toBase58(),
    }),
  );
}

console.log("perp market:", perpMarket.toBase58());

// Bounty receiver for liquidations.
const adminAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, admin.publicKey);

// ── The keeper loop ────────────────────────────────────────────────────

let price = Number((await program.account.perpMarket.fetch(perpMarket)).oraclePrice) / 1e6;
let momentum = 0;

async function pushPrice() {
  momentum = momentum * 0.9 + (Math.random() - 0.5) * 0.4;
  price = Math.max(1, price * (1 + momentum * 0.001));
  await program.methods
    .setOraclePrice(n(P(price)))
    .accountsPartial({ admin: admin.publicKey, perpMarket })
    .signers([admin])
    .rpc();
}

async function crankFunding() {
  try {
    await program.methods
      .updateFunding()
      .accountsPartial({ cranker: admin.publicKey, perpMarket })
      .signers([admin])
      .rpc();
    console.log("funding cranked");
  } catch (err) {
    if (!String(err).includes("FundingTooSoon")) console.error("funding:", String(err).slice(0, 120));
  }
}

/** The liquidator: same equity math as the on-chain check. */
async function scanAndLiquidate() {
  const mkt = await program.account.perpMarket.fetch(perpMarket);
  const oracle = BigInt(mkt.oraclePrice.toString());
  const cumF = BigInt(mkt.cumFunding.toString());
  const accounts = await program.account.marginAccount.all([
    { memcmp: { offset: 8, bytes: perpMarket.toBase58() } },
  ]);
  for (const { publicKey, account: ma } of accounts) {
    const pos = BigInt(ma.basePosition.toString());
    if (pos === 0n) continue;
    const coll = BigInt(ma.collateral.toString());
    const entry = BigInt(ma.avgEntryPrice.toString());
    const lastF = BigInt(ma.lastCumFunding.toString());
    const upnl = (pos * (oracle - entry)) / BASE_UNIT;
    const pending = (pos * (cumF - lastF)) / BASE_UNIT;
    const equity = coll + upnl - pending;
    const absPos = pos < 0n ? -pos : pos;
    const required = (absPos * oracle * BigInt(mkt.maintMarginBps)) / (BASE_UNIT * 10_000n);
    if (equity < required) {
      console.log(`liquidating ${ma.owner.toBase58()} (equity ${equity} < required ${required})`);
      try {
        await program.methods
          .liquidate()
          .accountsPartial({
            liquidator: admin.publicKey,
            perpMarket,
            marginAccount: publicKey,
            collateralVault: vault,
            liquidatorToken: adminAta.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([admin])
          .rpc();
        console.log("  liquidated ✓");
      } catch (err) {
        console.error("  liquidation failed:", String(err).slice(0, 140));
      }
    }
  }
}

console.log(`keeping for ${MINUTES} minute(s)…`);
const deadline = Date.now() + MINUTES * 60_000;
let tick = 0;
while (Date.now() < deadline) {
  try {
    await pushPrice();
    if (tick % 10 === 0) await crankFunding();
    if (tick % 5 === 0) await scanAndLiquidate();
  } catch (err) {
    console.error("keeper tick failed:", String(err).slice(0, 140));
  }
  tick++;
  await sleep(2_000);
}
console.log("keeper done. market:", perpMarket.toBase58());
