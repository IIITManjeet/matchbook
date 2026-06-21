import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

// Read from cwd (the repo root) so the test works both from ts-node and
// as tsc-compiled output.
const idl = JSON.parse(fs.readFileSync("target/idl/clob.json", "utf-8"));

// Market units for this test:
//   tick  = 100 quote atoms per (lot × tick)
//   lot   = 1_000_000 base atoms
//   fee   = 10 bps of quote notional, taker pays / receives net
const TICK = 100n;
const LOT = 1_000_000n;
const FEE_BPS = 10;

const RPC = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";

const Bid = { bid: {} };
const Ask = { ask: {} };
const Limit = { limit: {} };
const PostOnly = { postOnly: {} };
const IOC = { immediateOrCancel: {} };

describe("clob M2 — matching engine", () => {
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  let program: Program;
  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let market: PublicKey;
  let baseVault: PublicKey;
  let quoteVault: PublicKey;
  let bids: PublicKey;
  let asks: PublicKey;
  let eventQueue: PublicKey;
  let makerOO: PublicKey;
  let takerOO: PublicKey;
  let makerQuoteAta: PublicKey;

  const n = (x: bigint) => new BN(x.toString());

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  function placeOrder(
    user: Keypair,
    oo: PublicKey,
    side: object,
    price: bigint,
    qty: bigint,
    type: object,
  ) {
    return program.methods
      .placeOrder(side, n(price), n(qty), type)
      .accountsPartial({
        owner: user.publicKey,
        market,
        openOrders: oo,
        bids,
        asks,
        eventQueue,
      })
      .signers([user])
      .rpc();
  }

  function crank(makerAccounts: PublicKey[], limit = 16) {
    return program.methods
      .consumeEvents(limit)
      .accountsPartial({ cranker: payer.publicKey, market, eventQueue })
      .remainingAccounts(
        makerAccounts.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })),
      )
      .signers([payer])
      .rpc();
  }

  async function expectAnchorError(p: Promise<unknown>, code: string) {
    try {
      await p;
      assert.fail(`expected ${code}, but the instruction succeeded`);
    } catch (err: any) {
      const got = err?.error?.errorCode?.code ?? String(err);
      assert.strictEqual(got, code, `expected ${code}, got ${got}`);
    }
  }

  before(async function () {
    this.timeout(120_000);
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    program = new Program(idl as anchor.Idl, provider);

    await airdrop(payer.publicKey, 100);
    await airdrop(maker.publicKey, 10);
    await airdrop(taker.publicKey, 10);

    baseMint = await createMint(connection, payer, payer.publicKey, null, 9);
    quoteMint = await createMint(connection, payer, payer.publicKey, null, 6);

    [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId,
    );
    [baseVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), market.toBuffer()],
      program.programId,
    );
    [quoteVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("quote_vault"), market.toBuffer()],
      program.programId,
    );
    [bids] = PublicKey.findProgramAddressSync(
      [Buffer.from("bids"), market.toBuffer()],
      program.programId,
    );
    [asks] = PublicKey.findProgramAddressSync(
      [Buffer.from("asks"), market.toBuffer()],
      program.programId,
    );
    [eventQueue] = PublicKey.findProgramAddressSync(
      [Buffer.from("events"), market.toBuffer()],
      program.programId,
    );
    [makerOO] = PublicKey.findProgramAddressSync(
      [Buffer.from("open_orders"), market.toBuffer(), maker.publicKey.toBuffer()],
      program.programId,
    );
    [takerOO] = PublicKey.findProgramAddressSync(
      [Buffer.from("open_orders"), market.toBuffer(), taker.publicKey.toBuffer()],
      program.programId,
    );

    // token accounts + funding: maker holds base, taker holds quote
    const makerBase = await getOrCreateAssociatedTokenAccount(connection, payer, baseMint, maker.publicKey);
    const takerQuote = await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, taker.publicKey);
    makerQuoteAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, maker.publicKey)
    ).address;
    await mintTo(connection, payer, baseMint, makerBase.address, payer, 100n * LOT);
    await mintTo(connection, payer, quoteMint, takerQuote.address, payer, 10_000_000n);

    await program.methods
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
      .rpc();

    for (const [user, oo] of [
      [maker, makerOO],
      [taker, takerOO],
    ] as const) {
      await program.methods
        .createOpenOrders()
        .accountsPartial({
          owner: user.publicKey,
          market,
          openOrders: oo,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    }

    await program.methods
      .deposit(n(100n * LOT))
      .accountsPartial({
        owner: maker.publicKey,
        market,
        openOrders: makerOO,
        vault: baseVault,
        userToken: makerBase.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();
    await program.methods
      .deposit(n(10_000_000n))
      .accountsPartial({
        owner: taker.publicKey,
        market,
        openOrders: takerOO,
        vault: quoteVault,
        userToken: takerQuote.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();
  });

  it("market init wires the event queue", async () => {
    const m = await (program.account as any).market.fetch(market);
    assert.strictEqual(m.eventQueue.toBase58(), eventQueue.toBase58());
    assert.strictEqual(m.feesAccrued.toNumber(), 0);
  });

  it("post-only ask rests and locks maker base", async () => {
    await placeOrder(maker, makerOO, Ask, 500n, 10n, PostOnly);
    const book = await (program.account as any).orderBookSide.fetch(asks);
    assert.strictEqual(book.numOrders, 1);
    assert.strictEqual(book.orders[0].price.toNumber(), 500);
    assert.strictEqual(book.orders[0].qty.toNumber(), 10);

    const oo = await (program.account as any).openOrders.fetch(makerOO);
    assert.strictEqual(oo.baseLocked.toString(), (10n * LOT).toString());
    assert.strictEqual(oo.baseFree.toString(), (90n * LOT).toString());
  });

  it("limit bid matches: taker settles instantly, fill event queued", async () => {
    await placeOrder(taker, takerOO, Bid, 500n, 4n, Limit);

    // taker paid 4 lots × 500 ticks × 100 = 200_000 quote + 200 fee,
    // received 4 lots of base — all synchronously
    const oo = await (program.account as any).openOrders.fetch(takerOO);
    assert.strictEqual(oo.quoteFree.toString(), String(10_000_000 - 200_000 - 200));
    assert.strictEqual(oo.baseFree.toString(), (4n * LOT).toString());
    assert.strictEqual(oo.quoteLocked.toNumber(), 0);

    // maker's order shrank on the book; maker balances untouched so far
    const book = await (program.account as any).orderBookSide.fetch(asks);
    assert.strictEqual(book.orders[0].qty.toNumber(), 6);
    const makerAcc = await (program.account as any).openOrders.fetch(makerOO);
    assert.strictEqual(makerAcc.quoteFree.toNumber(), 0);
    assert.strictEqual(makerAcc.baseLocked.toString(), (10n * LOT).toString());

    // the fill sits in the queue; the taker fee accrued to the market
    const q = await (program.account as any).eventQueue.fetch(eventQueue);
    assert.strictEqual(q.count.toNumber(), 1);
    const m = await (program.account as any).market.fetch(market);
    assert.strictEqual(m.feesAccrued.toNumber(), 200);
  });

  it("crank without the maker account consumes nothing", async () => {
    await crank([]);
    const q = await (program.account as any).eventQueue.fetch(eventQueue);
    assert.strictEqual(q.count.toNumber(), 1);
  });

  it("consume_events credits the maker", async () => {
    await crank([makerOO]);
    const q = await (program.account as any).eventQueue.fetch(eventQueue);
    assert.strictEqual(q.count.toNumber(), 0);

    const oo = await (program.account as any).openOrders.fetch(makerOO);
    assert.strictEqual(oo.baseLocked.toString(), (6n * LOT).toString());
    assert.strictEqual(oo.quoteFree.toNumber(), 200_000); // makers pay no fee
  });

  it("IOC that doesn't cross fills nothing and rests nothing", async () => {
    await placeOrder(taker, takerOO, Bid, 499n, 5n, IOC);
    const book = await (program.account as any).orderBookSide.fetch(bids);
    assert.strictEqual(book.numOrders, 0);
    const oo = await (program.account as any).openOrders.fetch(takerOO);
    assert.strictEqual(oo.quoteFree.toString(), String(9_799_800));
  });

  it("limit bid sweeps the ask at price improvement, remainder rests", async () => {
    // bid 501 × 10: fills the remaining 6 at the *maker's* 500, rests 4 at 501
    await placeOrder(taker, takerOO, Bid, 501n, 10n, Limit);

    const askBook = await (program.account as any).orderBookSide.fetch(asks);
    assert.strictEqual(askBook.numOrders, 0);
    const bidBook = await (program.account as any).orderBookSide.fetch(bids);
    assert.strictEqual(bidBook.numOrders, 1);
    assert.strictEqual(bidBook.orders[0].price.toNumber(), 501);
    assert.strictEqual(bidBook.orders[0].qty.toNumber(), 4);

    // filled 6 at 500 → 300_000 + 300 fee; resting 4 at 501 locks 200_400
    const oo = await (program.account as any).openOrders.fetch(takerOO);
    assert.strictEqual(oo.quoteFree.toString(), String(9_799_800 - 300_300 - 200_400));
    assert.strictEqual(oo.quoteLocked.toNumber(), 200_400);
    assert.strictEqual(oo.baseFree.toString(), (10n * LOT).toString());

    await crank([makerOO]);
    const makerAcc = await (program.account as any).openOrders.fetch(makerOO);
    assert.strictEqual(makerAcc.baseLocked.toNumber(), 0);
    assert.strictEqual(makerAcc.quoteFree.toNumber(), 500_000);

    const m = await (program.account as any).market.fetch(market);
    assert.strictEqual(m.feesAccrued.toNumber(), 500);
  });

  it("rejects self-trades", async () => {
    await expectAnchorError(placeOrder(taker, takerOO, Ask, 501n, 1n, Limit), "SelfTrade");
  });

  it("rejects a crossing post-only order", async () => {
    await expectAnchorError(placeOrder(maker, makerOO, Ask, 500n, 1n, PostOnly), "WouldCross");
  });

  it("cancel releases the resting remainder's lock", async () => {
    const bidBook = await (program.account as any).orderBookSide.fetch(bids);
    const orderId = bidBook.orders[0].orderId;
    await program.methods
      .cancelOrder(Bid, orderId)
      .accountsPartial({
        owner: taker.publicKey,
        market,
        openOrders: takerOO,
        bids,
        asks,
      })
      .signers([taker])
      .rpc();

    const oo = await (program.account as any).openOrders.fetch(takerOO);
    assert.strictEqual(oo.quoteLocked.toNumber(), 0);
    // conservation: taker's total quote spend = maker proceeds + fees
    assert.strictEqual(oo.quoteFree.toString(), String(10_000_000 - 500_000 - 500));
  });

  it("maker withdraws real tokens for the proceeds", async () => {
    await program.methods
      .withdraw(n(500_000n))
      .accountsPartial({
        owner: maker.publicKey,
        market,
        openOrders: makerOO,
        vault: quoteVault,
        userToken: makerQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const ata = await getAccount(connection, makerQuoteAta);
    assert.strictEqual(ata.amount.toString(), "500000");
  });
});
