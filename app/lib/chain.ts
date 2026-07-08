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
import type { Side } from "./types";

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
