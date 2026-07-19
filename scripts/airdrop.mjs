/**
 * One-shot devnet faucet request, meant to run from CI where the
 * faucet's per-IP allowance isn't already burned through like it is
 * on dev machines. Dispatched by .github/workflows/airdrop.yml.
 *
 *   ADDRESS=<pubkey> AMOUNT=<sol> node scripts/airdrop.mjs
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const address = new PublicKey(
  process.env.ADDRESS ?? "9fxLpiKzK1zeF42911g5ruKDdTuJFduJSEXcZHh4mCB1",
);
const want = Number(process.env.AMOUNT ?? 5);

const connection = new Connection(RPC, "confirmed");
const balance = async () =>
  (await connection.getBalance(address)) / LAMPORTS_PER_SOL;
console.log("balance before:", await balance(), "SOL");

// The faucet's per-request cap varies day to day; walk down until one sticks.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let got = 0;
for (const amount of [...new Set([want, 2, 1, 0.5])].filter((a) => a <= want)) {
  try {
    const sig = await connection.requestAirdrop(
      address,
      Math.round(amount * LAMPORTS_PER_SOL),
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    console.log(`airdropped ${amount} SOL:`, sig);
    got = amount;
    break;
  } catch (err) {
    console.log(`${amount} SOL declined:`, String(err).slice(0, 120));
    await sleep(2000);
  }
}

console.log("balance after:", await balance(), "SOL");
if (!got) process.exit(1);
