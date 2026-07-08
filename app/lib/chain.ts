/**
 * On-chain trading client: builds, signs and sends real transactions to
 * the CLOB program. Used when the terminal runs against the indexer
 * feed (i.e. a real cluster is up).
 *
 * Signing goes through the minimal `SignerWallet` interface, so a
 * browser-extension wallet (Phantom et al. via wallet-adapter) is a
 * drop-in replacement. On localnet we use a burner keypair committed to
 * the repo (`dev-wallet.json`) — the market seeder funds and deposits
 * for it, so the terminal can trade the moment it connects. That file
 * is a localnet convenience, nothing more; never reuse it anywhere real.
 */

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import idl from "./idl/clob.json";
import devWalletKey from "./dev-wallet.json";
import type { PerpPosition, Side } from "./types";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export interface MarketMeta {
  pubkey: string;
  tickSize: number; // quote atoms per (lot × tick)
  baseLotSize: number; // base atoms per lot
  baseDecimals: number;
  quoteDecimals: number;
}

/** What the client needs from a wallet — matches wallet-adapter's shape. */
export interface SignerWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

function burnerWallet(): SignerWallet {
  const kp = Keypair.fromSecretKey(Uint8Array.from(devWalletKey as number[]));
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof Transaction) tx.partialSign(kp);
    else tx.sign([kp]);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  };
}

const seed = (s: string) => new TextEncoder().encode(s);

export interface ChainBalances {
  base: { total: number; locked: number };
  quote: { total: number; locked: number };
}

export class ChainClient {
  private program: Program;
  private meta: MarketMeta;
  private market: PublicKey;
  private bids: PublicKey;
  private asks: PublicKey;
  private eventQueue: PublicKey;
  private openOrders: PublicKey;
  readonly address: string;

  private constructor(meta: MarketMeta, wallet: SignerWallet, connection: Connection) {
    this.meta = meta;
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    this.program = new Program(idl as Idl, provider);
    this.address = wallet.publicKey.toBase58();

    this.market = new PublicKey(meta.pubkey);
    const pid = this.program.programId;
    const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
    this.bids = pda(seed("bids"), this.market.toBytes());
    this.asks = pda(seed("asks"), this.market.toBytes());
    this.eventQueue = pda(seed("events"), this.market.toBytes());
    this.openOrders = pda(seed("open_orders"), this.market.toBytes(), wallet.publicKey.toBytes());
  }

  /** Connect the burner wallet and make sure it can pay fees + trade. */
  static async connect(meta: MarketMeta): Promise<ChainClient> {
    const connection = new Connection(RPC_URL, "confirmed");
    const client = new ChainClient(meta, burnerWallet(), connection);

    const lamports = await connection.getBalance(client.program.provider.publicKey!);
    if (lamports < 0.5e9) {
      const sig = await connection.requestAirdrop(client.program.provider.publicKey!, 2e9);
      await connection.confirmTransaction(sig, "confirmed");
    }
    await client.ensureOpenOrders();
    return client;
  }

  private async ensureOpenOrders() {
    const info = await this.program.provider.connection.getAccountInfo(this.openOrders);
    if (info) return;
    await this.program.methods
      .createOpenOrders()
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        market: this.market,
        openOrders: this.openOrders,
      })
      .rpc();
  }

  // UI units ⇄ on-chain units
  private get priceFactor() {
    return (
      (this.meta.tickSize * 10 ** (this.meta.baseDecimals - this.meta.quoteDecimals)) /
      this.meta.baseLotSize
    );
  }
  private get sizeFactor() {
    return this.meta.baseLotSize / 10 ** this.meta.baseDecimals;
  }

  async balances(): Promise<ChainBalances> {
    const accounts = this.program.account as unknown as {
      openOrders: {
        fetch(
          addr: PublicKey,
        ): Promise<{ baseFree: BN; baseLocked: BN; quoteFree: BN; quoteLocked: BN }>;
      };
    };
    const oo = await accounts.openOrders.fetch(this.openOrders);
    const b = (x: BN, dec: number) => x.toNumber() / 10 ** dec;
    const bd = this.meta.baseDecimals;
    const qd = this.meta.quoteDecimals;
    return {
      base: {
        total: b(oo.baseFree, bd) + b(oo.baseLocked, bd),
        locked: b(oo.baseLocked, bd),
      },
      quote: {
        total: b(oo.quoteFree, qd) + b(oo.quoteLocked, qd),
        locked: b(oo.quoteLocked, qd),
      },
    };
  }

  /**
   * Place an order. Market orders are IOC limits priced far through the
   * book — price improvement means they fill at maker prices anyway.
   */
  async placeOrder(
    side: Side,
    type: "limit" | "market",
    priceUi: number,
    sizeUi: number,
    lastPriceUi: number,
  ): Promise<string> {
    const effectiveUi =
      type === "market" ? (side === "buy" ? lastPriceUi * 1.1 : lastPriceUi * 0.9) : priceUi;
    const ticks = Math.max(1, Math.round(effectiveUi / this.priceFactor));
    const lots = Math.round(sizeUi / this.sizeFactor);
    if (lots <= 0) throw new Error("size below one lot");

    return this.program.methods
      .placeOrder(
        side === "buy" ? { bid: {} } : { ask: {} },
        new BN(ticks),
        new BN(lots),
        type === "market" ? { immediateOrCancel: {} } : { limit: {} },
      )
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        market: this.market,
        openOrders: this.openOrders,
        bids: this.bids,
        asks: this.asks,
        eventQueue: this.eventQueue,
      })
      .rpc();
  }

  async cancelOrder(side: Side, orderId: number): Promise<string> {
    return this.program.methods
      .cancelOrder(side === "buy" ? { bid: {} } : { ask: {} }, new BN(orderId))
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        market: this.market,
        openOrders: this.openOrders,
        bids: this.bids,
        asks: this.asks,
      })
      .rpc();
  }
}

// ── Perps ──────────────────────────────────────────────────────────────

interface PerpMarketAccount {
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  oraclePrice: BN;
  cumFunding: BN;
  maintMarginBps: number;
  initMarginBps: number;
  takerFeeBps: number;
}

interface MarginAccountData {
  collateral: BN;
  basePosition: BN;
  avgEntryPrice: BN;
  lastCumFunding: BN;
}

/**
 * On-chain client for the perp market: positions fill against the
 * oracle price, margin lives in a per-user MarginAccount. Same burner
 * wallet and signer interface as the spot client.
 */
export class PerpClient {
  private program: Program;
  private market: PublicKey;
  private marginAccount: PublicKey;
  private vault!: PublicKey;
  private collateralMint!: PublicKey;
  readonly address: string;

  private constructor(marketPubkey: string, wallet: SignerWallet, connection: Connection) {
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    this.program = new Program(idl as Idl, provider);
    this.address = wallet.publicKey.toBase58();
    this.market = new PublicKey(marketPubkey);
    this.marginAccount = PublicKey.findProgramAddressSync(
      [seed("margin"), this.market.toBytes(), wallet.publicKey.toBytes()],
      this.program.programId,
    )[0];
  }

  static async connect(marketPubkey: string): Promise<PerpClient> {
    const connection = new Connection(RPC_URL, "confirmed");
    const client = new PerpClient(marketPubkey, burnerWallet(), connection);

    const mkt = await client.perpMarket();
    client.vault = mkt.collateralVault;
    client.collateralMint = mkt.collateralMint;

    const me = client.program.provider.publicKey!;
    const lamports = await connection.getBalance(me);
    if (lamports < 0.5e9) {
      const sig = await connection.requestAirdrop(me, 2e9);
      await connection.confirmTransaction(sig, "confirmed");
    }
    const info = await connection.getAccountInfo(client.marginAccount);
    if (!info) {
      await client.program.methods
        .createMarginAccount()
        .accountsPartial({ owner: me, perpMarket: client.market, marginAccount: client.marginAccount })
        .rpc();
    }
    return client;
  }

  private accounts() {
    return this.program.account as unknown as {
      perpMarket: { fetch(a: PublicKey): Promise<PerpMarketAccount> };
      marginAccount: { fetch(a: PublicKey): Promise<MarginAccountData> };
    };
  }

  private perpMarket() {
    return this.accounts().perpMarket.fetch(this.market);
  }

  private myAta(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        this.program.provider.publicKey!.toBytes(),
        TOKEN_PROGRAM.toBytes(),
        this.collateralMint.toBytes(),
      ],
      ATA_PROGRAM,
    )[0];
  }

  /** Full mark-to-market view in UI units (SOL / USDC floats). */
  async state(): Promise<PerpPosition> {
    const [mkt, ma] = await Promise.all([
      this.perpMarket(),
      this.accounts().marginAccount.fetch(this.marginAccount),
    ]);
    const mark = Number(mkt.oraclePrice.toString()) / 1e6;
    const size = Number(ma.basePosition.toString()) / 1e9;
    const entry = Number(ma.avgEntryPrice.toString()) / 1e6;
    const collateral = Number(ma.collateral.toString()) / 1e6;
    // funding delta: quote atoms per whole base → USDC per SOL held
    const dF = (Number(mkt.cumFunding.toString()) - Number(ma.lastCumFunding.toString())) / 1e6;
    const pendingFunding = size * dF;

    const uPnl = size * (mark - entry);
    const notional = Math.abs(size) * mark;
    const equity = collateral + uPnl - pendingFunding;
    const initReq = (notional * mkt.initMarginBps) / 10_000;
    const mb = mkt.maintMarginBps / 10_000;

    // Solve equity(P) = maintenance(P) for the liquidation price:
    // c + s(P − e) = |s|·mb·P  →  P = (s·e − c) / (s − |s|·mb)
    let liqPrice: number | null = null;
    if (size !== 0) {
      const c = collateral - pendingFunding;
      const denom = size - Math.abs(size) * mb;
      const p = (size * entry - c) / denom;
      liqPrice = p > 0 ? p : null; // ≤0 → can't be liquidated at any price
    }

    const entryNotional = Math.abs(size) * entry;
    return {
      size,
      entryPrice: entry,
      markPrice: mark,
      notional,
      uPnl,
      uPnlPct: entryNotional > 0 ? (uPnl / entryNotional) * 100 : 0,
      liqPrice,
      pendingFunding,
      collateral,
      equity,
      freeCollateral: Math.max(0, equity - initReq),
      leverage: equity > 0 ? notional / equity : 0,
    };
  }

  /** Trade `deltaSol` (+ long, − short) with a 1% slippage guard. */
  async openPosition(deltaSol: number, slippagePct = 1): Promise<string> {
    const mkt = await this.perpMarket();
    const mark = Number(mkt.oraclePrice.toString());
    const limit =
      deltaSol > 0
        ? Math.ceil(mark * (1 + slippagePct / 100))
        : Math.floor(mark * (1 - slippagePct / 100));
    return this.program.methods
      .openPosition(new BN(Math.round(deltaSol * 1e9)), new BN(Math.max(1, limit)))
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        perpMarket: this.market,
        marginAccount: this.marginAccount,
      })
      .rpc();
  }

  /** Close the whole position at whatever the oracle says (wide limit). */
  async closePosition(): Promise<string | null> {
    const ma = await this.accounts().marginAccount.fetch(this.marginAccount);
    const pos = Number(ma.basePosition.toString());
    if (pos === 0) return null;
    const mkt = await this.perpMarket();
    const mark = Number(mkt.oraclePrice.toString());
    const limit = pos > 0 ? Math.max(1, Math.floor(mark * 0.9)) : Math.ceil(mark * 1.1);
    return this.program.methods
      .openPosition(new BN(-pos), new BN(limit))
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        perpMarket: this.market,
        marginAccount: this.marginAccount,
      })
      .rpc();
  }

  async depositCollateral(amountUsdc: number): Promise<string> {
    return this.program.methods
      .depositCollateral(new BN(Math.round(amountUsdc * 1e6)))
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        perpMarket: this.market,
        marginAccount: this.marginAccount,
        collateralVault: this.vault,
        userToken: this.myAta(),
      })
      .rpc();
  }

  async withdrawCollateral(amountUsdc: number): Promise<string> {
    return this.program.methods
      .withdrawCollateral(new BN(Math.round(amountUsdc * 1e6)))
      .accountsPartial({
        owner: this.program.provider.publicKey!,
        perpMarket: this.market,
        marginAccount: this.marginAccount,
        collateralVault: this.vault,
        userToken: this.myAta(),
      })
      .rpc();
  }
}
