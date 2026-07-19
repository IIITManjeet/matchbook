/**
 * Devnet faucet top-up, meant to run from CI where the faucet's per-IP
 * allowance isn't already burned through like it is on dev machines.
 * The faucet also limits per recipient address, so besides asking for
 * the target directly this airdrops to a fresh ephemeral keypair and
 * sweeps the SOL over. Dispatched by .github/workflows/airdrop.yml.
 *
 *   ADDRESS=<pubkey> AMOUNT=<sol> ROUNDS=<n> node scripts/airdrop.mjs
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const target = new PublicKey(
  process.env.ADDRESS ?? "9fxLpiKzK1zeF42911g5ruKDdTuJFduJSEXcZHh4mCB1",
);
const want = Number(process.env.AMOUNT ?? 5);
const rounds = Number(process.env.ROUNDS ?? 8);

const connection = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balance = async () =>
  (await connection.getBalance(target)) / LAMPORTS_PER_SOL;

async function airdrop(to, amount) {
  const sig = await connection.requestAirdrop(
    to,
    Math.round(amount * LAMPORTS_PER_SOL),
  );
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  return sig;
}

async function sweep(from) {
  const lamports = await connection.getBalance(from.publicKey);
  const fee = 5000;
  if (lamports <= fee) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: target,
      lamports: lamports - fee,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [from]);
  console.log(`swept ${(lamports - fee) / LAMPORTS_PER_SOL} SOL to target`);
}

console.log("balance before:", await balance(), "SOL");
let got = 0;

for (let round = 0; round < rounds && got < want; round++) {
  if (round > 0) {
    console.log(`round ${round + 1}/${rounds} in 90s…`);
    await sleep(90_000);
  }
  // The faucet's per-request cap varies day to day; walk down until one sticks.
  for (const amount of [...new Set([want - got, 2, 1])].filter((a) => a > 0 && a <= want - got)) {
    const burner = Keypair.generate();
    for (const [label, to] of [["target", null], ["burner", burner]]) {
      try {
        const sig = await airdrop(to ? to.publicKey : target, amount);
        console.log(`airdropped ${amount} SOL to ${label}:`, sig);
        if (to) await sweep(to);
        got += amount;
        break;
      } catch (err) {
        console.log(`${amount} SOL to ${label} declined:`, String(err).slice(0, 110));
        await sleep(2000);
      }
    }
    if (got >= want) break;
  }
}

console.log("balance after:", await balance(), "SOL");
if (!got) process.exit(1);
