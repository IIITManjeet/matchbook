/**
 * One-time (re-runnable) setup for the tape keeper on an existing devnet
 * market: creates the committed tape-maker burner, its OpenOrders and
 * token accounts, mints fresh base/quote (the payer is the mint
 * authority) and deposits for BOTH the tape-maker and the terminal's
 * dev wallet, so `tape-run.mjs` can trade indefinitely with no secrets.
 *
 *   PAYER_KEYPAIR=/path/to/id.json node scripts/tape-setup.mjs
 *
 * The payer only signs mints — the dev wallet fee-pays everything, so
 * the payer needs no SOL. Safe to re-run: it skips what already exists
 * and simply tops the deposits up.
 */
import anchorNs from "@coral-xyz/anchor";
const anchor = anchorNs.default ?? anchorNs;
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import fs from "node:fs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const MARKET = new PublicKey(process.env.MARKET ?? "Hjk9AaSAs9oGaLA4h62rYi5ppEpYioGANydy7ZosU3vN");
const MAKER_PATH = "scripts/tape-maker.json";

const BASE_AMOUNT = 100_000_000_000n; // 100 base units (9 dec)
const QUOTE_AMOUNT = 5_000_000_000n; // 5,000 quote units (6 dec)

const idl = JSON.parse(fs.readFileSync("app/lib/idl/clob.json", "utf-8"));
const n = (x) => new anchor.BN(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.PAYER_KEYPAIR) throw new Error("set PAYER_KEYPAIR (mint authority)");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PAYER_KEYPAIR, "utf-8"))),
);
const dev = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("app/lib/dev-wallet.json", "utf-8"))),
);

// The tape-maker is a devnet-only burner committed to the repo, exactly
// like app/lib/dev-wallet.json — never reuse it anywhere real.
if (!fs.existsSync(MAKER_PATH)) {
  fs.writeFileSync(MAKER_PATH, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  console.log("generated", MAKER_PATH);
}
const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(MAKER_PATH, "utf-8"))));
console.log("tape maker:", maker.publicKey.toBase58());

const connection = new anchor.web3.Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(dev), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

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
const pace = () => sleep(600);

// The owner pays OpenOrders rent, so the fresh maker needs a pinch of
// SOL — moved from the dev wallet, not the faucet.
{
  const makerBal = await connection.getBalance(maker.publicKey);
  if (makerBal < 5_000_000) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: dev.publicKey,
        toPubkey: maker.publicKey,
        lamports: 10_000_000, // 0.01 SOL
      }),
    );
    await withRetry(() => anchor.web3.sendAndConfirmTransaction(connection, tx, [dev]), "seed maker sol");
    console.log("moved 0.01 SOL dev → maker");
  }
}

const marketAcc = await program.account.market.fetch(MARKET);
const baseMint = marketAcc.baseMint;
const quoteMint = marketAcc.quoteMint;
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const baseVault = pda(Buffer.from("base_vault"), MARKET.toBuffer());
const quoteVault = pda(Buffer.from("quote_vault"), MARKET.toBuffer());

for (const user of [maker, dev]) {
  const oo = pda(Buffer.from("open_orders"), MARKET.toBuffer(), user.publicKey.toBuffer());
  if (!(await connection.getAccountInfo(oo))) {
    await withRetry(
      () =>
        program.methods
          .createOpenOrders()
          .accountsPartial({
            owner: user.publicKey,
            market: MARKET,
            openOrders: oo,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc(),
      "create open orders",
    );
    console.log("open orders created for", user.publicKey.toBase58());
  }
  await pace();

  for (const [mint, vault, amount] of [
    [baseMint, baseVault, BASE_AMOUNT],
    [quoteMint, quoteVault, QUOTE_AMOUNT],
  ]) {
    const ata = await withRetry(
      () => getOrCreateAssociatedTokenAccount(connection, dev, mint, user.publicKey),
      "ata",
    );
    await pace();
    await withRetry(() => mintTo(connection, dev, mint, ata.address, payer, amount), "mint");
    await pace();
    await withRetry(
      () =>
        program.methods
          .deposit(n(amount))
          .accountsPartial({
            owner: user.publicKey,
            market: MARKET,
            openOrders: oo,
            vault,
            userToken: ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc(),
      "deposit",
    );
    await pace();
  }
  console.log("funded + deposited for", user.publicKey.toBase58());
}
console.log("setup complete");
