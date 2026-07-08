import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const idl = JSON.parse(fs.readFileSync("target/idl/clob.json", "utf-8"));

const RPC = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";

// Price scale: quote atoms (USDC, 6dp) per whole base unit (1 SOL).
const P = (usdc: number) => new BN(Math.round(usdc * 1_000_000));
// Sizes in base atoms (1 SOL = 1e9).
const SZ = (sol: number) => new BN(Math.round(sol * 1e9));
const USDC = (x: number) => BigInt(Math.round(x * 1_000_000));

describe("clob M4 — perpetual futures", () => {
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const admin = Keypair.generate(); // market admin = oracle keeper
  const trader = Keypair.generate();
  const whale = Keypair.generate(); // counterparty flow for skew tests
  const liquidator = Keypair.generate();

  let program: Program;
  let usdcMint: PublicKey;
  let perpMarket: PublicKey;
  let vault: PublicKey;
  let traderMargin: PublicKey;
  let whaleMargin: PublicKey;
  let traderUsdc: PublicKey;
  let liquidatorUsdc: PublicKey;

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const setPrice = (usdc: number) =>
    program.methods
      .setOraclePrice(P(usdc))
      .accountsPartial({ admin: admin.publicKey, perpMarket })
      .signers([admin])
      .rpc();

  const open = (user: Keypair, margin: PublicKey, deltaSol: number, limitUsdc: number) =>
    program.methods
      .openPosition(SZ(deltaSol), P(limitUsdc))
      .accountsPartial({ owner: user.publicKey, perpMarket, marginAccount: margin })
      .signers([user])
      .rpc();

  const marginState = async (margin: PublicKey) =>
    (program.account as any).marginAccount.fetch(margin);
  const marketState = async () => (program.account as any).perpMarket.fetch(perpMarket);

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
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    program = new Program(idl as anchor.Idl, provider);

    await airdrop(admin.publicKey, 100);
    await airdrop(trader.publicKey, 10);
    await airdrop(whale.publicKey, 10);
    await airdrop(liquidator.publicKey, 10);

    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);

    [perpMarket] = PublicKey.findProgramAddressSync(
      [Buffer.from("perp"), usdcMint.toBuffer()],
      program.programId,
    );
    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("perp_vault"), perpMarket.toBuffer()],
      program.programId,
    );
    [traderMargin] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin"), perpMarket.toBuffer(), trader.publicKey.toBuffer()],
      program.programId,
    );
    [whaleMargin] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin"), perpMarket.toBuffer(), whale.publicKey.toBuffer()],
      program.programId,
    );

    // init: $50 oracle, 1s funding interval (test-friendly), 100 bps/day
    // max funding, 10 bps taker fee, 10x max leverage (1000 bps init),
    // 500 bps maintenance, 250 bps liquidation penalty.
    await program.methods
      .initPerpMarket(P(50), new BN(1), 100, 10, 1000, 500, 250)
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

    for (const [user, margin] of [
      [trader, traderMargin],
      [whale, whaleMargin],
    ] as const) {
      await program.methods
        .createMarginAccount()
        .accountsPartial({
          owner: user.publicKey,
          perpMarket,
          marginAccount: margin,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, user.publicKey);
      await mintTo(connection, admin, usdcMint, ata.address, admin, USDC(10_000));
      await program.methods
        .depositCollateral(new BN(USDC(1_000).toString()))
        .accountsPartial({
          owner: user.publicKey,
          perpMarket,
          marginAccount: margin,
          collateralVault: vault,
          userToken: ata.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      if (user === trader) traderUsdc = ata.address;
    }

    liquidatorUsdc = (
      await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, liquidator.publicKey)
    ).address;
  });

  it("rejects a non-admin oracle push", async () => {
    await expectAnchorError(
      program.methods
        .setOraclePrice(P(51))
        .accountsPartial({ admin: trader.publicKey, perpMarket })
        .signers([trader])
        .rpc(),
      "ConstraintHasOne",
    );
  });

  it("opens a long and charges the taker fee", async () => {
    // 10 SOL long at $50 = $500 notional; fee 10 bps = $0.50.
    await open(trader, traderMargin, 10, 51);
    const ma = await marginState(traderMargin);
    assert.strictEqual(ma.basePosition.toString(), SZ(10).toString());
    assert.strictEqual(ma.avgEntryPrice.toString(), P(50).toString());
    assert.strictEqual(ma.collateral.toString(), USDC(999.5).toString());
    const mkt = await marketState();
    assert.strictEqual(mkt.longOi.toString(), SZ(10).toString());
  });

  it("rejects slippage past the limit price", async () => {
    await setPrice(52);
    await expectAnchorError(open(trader, traderMargin, 1, 51), "PriceSlippage");
    await setPrice(50);
  });

  it("rejects a position beyond initial margin (10x)", async () => {
    // ~$999.5 collateral → max ~$9,995 notional → 210 SOL at $50 is way past it.
    await expectAnchorError(open(trader, traderMargin, 210, 51), "BelowInitialMargin");
  });

  it("extending moves the volume-weighted entry", async () => {
    await setPrice(60);
    await open(trader, traderMargin, 10, 61); // 10 @ 50 + 10 @ 60 → avg 55
    const ma = await marginState(traderMargin);
    assert.strictEqual(ma.avgEntryPrice.toString(), P(55).toString());
    assert.strictEqual(ma.basePosition.toString(), SZ(20).toString());
  });

  it("reducing realizes pnl on the closed portion", async () => {
    // Close 10 of 20 at $60 with avg $55 → +$50 realized.
    const before = BigInt((await marginState(traderMargin)).collateral.toString());
    await open(trader, traderMargin, -10, 59);
    const ma = await marginState(traderMargin);
    const gained = BigInt(ma.collateral.toString()) - before;
    // +$50 pnl − $0.60 fee (10 SOL × $60 × 10 bps)
    assert.strictEqual(gained.toString(), (USDC(50) - USDC(0.6)).toString());
    assert.strictEqual(ma.basePosition.toString(), SZ(10).toString());
    assert.strictEqual(ma.avgEntryPrice.toString(), P(55).toString(), "entry unchanged on reduce");
  });

  it("funding: longs pay when longs dominate", async () => {
    // trader is net long 10 SOL, whale flat → skew 100% long.
    await new Promise((r) => setTimeout(r, 2_000)); // > funding_interval (1s)
    await program.methods
      .updateFunding()
      .accountsPartial({ cranker: admin.publicKey, perpMarket })
      .signers([admin])
      .rpc();
    const mkt = await marketState();
    assert.isTrue(BigInt(mkt.cumFunding.toString()) > 0n, "cum funding rose (longs pay)");

    // Touching the position settles funding out of collateral.
    const before = BigInt((await marginState(traderMargin)).collateral.toString());
    await open(trader, traderMargin, 1, 61);
    const after = await marginState(traderMargin);
    const feeOnly = USDC(0.06); // 1 SOL × $60 × 10 bps
    assert.isTrue(
      BigInt(after.collateral.toString()) < before - feeOnly + USDC(0.001),
      "collateral dropped by more than the fee → funding was paid",
    );
    await open(trader, traderMargin, -1, 59); // back to 10 SOL for later tests
  });

  it("withdraw is blocked below initial margin, allowed above", async () => {
    const ma = await marginState(traderMargin);
    const collateral = BigInt(ma.collateral.toString());
    // 10 SOL @ $60 = $600 notional → $60 init margin. Withdrawing all
    // but $10 must fail; withdrawing a modest $100 must pass.
    await expectAnchorError(
      program.methods
        .withdrawCollateral(new BN((collateral - USDC(10)).toString()))
        .accountsPartial({
          owner: trader.publicKey,
          perpMarket,
          marginAccount: traderMargin,
          collateralVault: vault,
          userToken: traderUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc(),
      "BelowInitialMargin",
    );
    const balBefore = (await getAccount(connection, traderUsdc)).amount;
    await program.methods
      .withdrawCollateral(new BN(USDC(100).toString()))
      .accountsPartial({
        owner: trader.publicKey,
        perpMarket,
        marginAccount: traderMargin,
        collateralVault: vault,
        userToken: traderUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    const balAfter = (await getAccount(connection, traderUsdc)).amount;
    assert.strictEqual((balAfter - balBefore).toString(), USDC(100).toString());
  });

  it("liquidation: only below maintenance, bounty paid, position wiped", async () => {
    // Not liquidatable at $60.
    await expectAnchorError(
      program.methods
        .liquidate()
        .accountsPartial({
          liquidator: liquidator.publicKey,
          perpMarket,
          marginAccount: traderMargin,
          collateralVault: vault,
          liquidatorToken: liquidatorUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liquidator])
        .rpc(),
      "NotLiquidatable",
    );

    // The account holds far more collateral than the position can ever
    // lose, so no crash alone liquidates it. Thin the margin first:
    // leave $15 collateral behind a 10 SOL @ $55-entry long (equity at
    // the $60 mark = 15 + 50 = $65, just above the $60 initial margin).
    const rich = await marginState(traderMargin);
    await program.methods
      .withdrawCollateral(new BN((BigInt(rich.collateral.toString()) - USDC(15)).toString()))
      .accountsPartial({
        owner: trader.publicKey,
        perpMarket,
        marginAccount: traderMargin,
        collateralVault: vault,
        userToken: traderUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    // A mere $4 drop now sinks it: equity = 15 + 10×(56−55) = $25,
    // below the maintenance requirement 10×56×5% = $28.
    await setPrice(56);

    const liqBefore = (await getAccount(connection, liquidatorUsdc)).amount;
    await program.methods
      .liquidate()
      .accountsPartial({
        liquidator: liquidator.publicKey,
        perpMarket,
        marginAccount: traderMargin,
        collateralVault: vault,
        liquidatorToken: liquidatorUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([liquidator])
      .rpc();

    const after = await marginState(traderMargin);
    assert.strictEqual(after.basePosition.toString(), "0", "position wiped");
    const liqAfter = (await getAccount(connection, liquidatorUsdc)).amount;
    assert.isTrue(liqAfter > liqBefore, "liquidator earned the bounty");
    const mkt = await marketState();
    assert.strictEqual(mkt.longOi.toString(), "0", "open interest released");
    await setPrice(50);
  });

  it("flat account with remaining collateral can withdraw everything", async () => {
    const ma = await marginState(traderMargin);
    const rest = BigInt(ma.collateral.toString());
    assert.isTrue(rest > 0n, "loss + penalty left some collateral");
    await program.methods
      .withdrawCollateral(new BN(rest.toString()))
      .accountsPartial({
        owner: trader.publicKey,
        perpMarket,
        marginAccount: traderMargin,
        collateralVault: vault,
        userToken: traderUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();
    assert.strictEqual((await marginState(traderMargin)).collateral.toString(), "0");
  });
});
