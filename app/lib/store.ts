import { create } from "zustand";
import { ChainClient } from "./chain";
import { INDEXER_HTTP, IndexerFeed } from "./indexer";
import { MockFeed } from "./mock";
import type {
  Balance,
  BookLevel,
  Candle,
  FeedSnapshot,
  Fill,
  MarketInfo,
  MarketStats,
  OpenOrder,
  OrderType,
  Side,
  Trade,
} from "./types";

const MARKET: MarketInfo = {
  symbol: "SOL/USDC",
  base: "SOL",
  quote: "USDC",
  tickSize: 0.01,
  minSize: 0.01,
  priceDecimals: 2,
  sizeDecimals: 2,
};

const TAKER_FEE = 0.0004;

let feed: MockFeed | IndexerFeed | null = null;
let feedStarting = false; // guards the async probe against double-invoked effects
let orderSeq = 0;

/** Non-null while the wallet trades on-chain (indexer feed + validator up). */
let chain: ChainClient | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export type FeedSource = "indexer" | "mock";

const SIM_ADDRESS = "9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2";
const SIM_BALANCES: Record<string, Balance> = {
  SOL: { total: 84.6, locked: 0 },
  USDC: { total: 12_450.0, locked: 0 },
};

interface TerminalState {
  market: MarketInfo;
  bids: BookLevel[];
  asks: BookLevel[];
  trades: Trade[];
  candles: Candle[];
  lastPrice: number;
  lastSide: Side;
  stats: MarketStats;
  feedLive: boolean;
  feedSource: FeedSource | null;

  wallet: { connected: boolean; address: string | null };
  /** true when orders are real signed transactions (burner wallet + validator) */
  tradingLive: boolean;
  balances: Record<string, Balance>;
  openOrders: OpenOrder[];
  fills: Fill[];

  /** set when the user clicks a book/trade price; consumed by the order form */
  quotedPrice: number | null;

  startFeed: () => void;
  connectWallet: () => void;
  disconnectWallet: () => void;
  quotePrice: (price: number) => void;
  clearQuotedPrice: () => void;
  placeOrder: (side: Side, type: OrderType, price: number, size: number) => void;
  cancelOrder: (id: string) => void;
}

function lockFor(side: Side, price: number, size: number) {
  return side === "buy"
    ? { asset: MARKET.quote, amount: price * size }
    : { asset: MARKET.base, amount: size };
}

export const useTerminal = create<TerminalState>((set, get) => ({
  market: MARKET,
  bids: [],
  asks: [],
  trades: [],
  candles: [],
  lastPrice: 0,
  lastSide: "buy",
  stats: { change24h: 0, high24h: 0, low24h: 0, volumeBase: 0, volumeQuote: 0 },
  feedLive: false,
  feedSource: null,

  wallet: { connected: false, address: null },
  tradingLive: false,
  balances: { ...SIM_BALANCES },
  openOrders: [],
  fills: [],
  quotedPrice: null,

  startFeed: () => {
    if (feed || feedStarting) return;
    feedStarting = true;

    const attach = (f: MockFeed | IndexerFeed, source: FeedSource) => {
      feed = f;
      f.start((snap: FeedSnapshot) => {
        set({
          bids: snap.bids,
          asks: snap.asks,
          trades: snap.trades,
          candles: snap.candles,
          lastPrice: snap.lastPrice,
          lastSide: snap.lastSide,
          stats: snap.stats,
          feedLive: true,
          feedSource: source,
        });
        // The simulated fill engine only runs for the simulated wallet;
        // on-chain orders settle on-chain.
        if (!chain) settleCrossedOrders(set, get, snap.lastPrice);
      });
    };

    // Prefer the real indexer; fall back to the simulator when it's not up.
    IndexerFeed.connect()
      .then((f) => attach(f, "indexer"))
      .catch(() => attach(new MockFeed(), "mock"));
  },

  connectWallet: () => {
    // Real wallet when a live cluster is behind the feed; simulated otherwise.
    if (feed instanceof IndexerFeed) {
      const f = feed;
      ChainClient.connect(f.meta)
        .then((c) => {
          chain = c;
          set({
            wallet: { connected: true, address: c.address },
            tradingLive: true,
            openOrders: [],
            fills: [],
          });
          startChainPolling(set, get);
        })
        .catch((err) => {
          console.error("on-chain wallet unavailable, using simulator:", err);
          set({ wallet: { connected: true, address: SIM_ADDRESS } });
        });
    } else {
      set({ wallet: { connected: true, address: SIM_ADDRESS } });
    }
  },
  disconnectWallet: () => {
    stopChainPolling();
    chain = null;
    set({
      wallet: { connected: false, address: null },
      tradingLive: false,
      openOrders: [],
      fills: [],
      balances: { ...SIM_BALANCES },
    });
  },

  quotePrice: (price) => set({ quotedPrice: price }),
  clearQuotedPrice: () => set({ quotedPrice: null }),

  placeOrder: (side, type, price, size) => {
    // ── Real path: sign and send place_order, then re-sync from chain ──
    if (chain) {
      const c = chain;
      const { lastPrice } = get();
      const id = `pending-${++orderSeq}`;
      const order: OpenOrder = {
        id,
        market: MARKET.symbol,
        side,
        type,
        price: type === "market" ? lastPrice : price,
        size,
        filled: 0,
        status: "pending",
        ts: Date.now(),
      };
      set((s) => ({ openOrders: [order, ...s.openOrders] }));
      c.placeOrder(side, type, price, size, lastPrice)
        .then(() => refreshChainState(set))
        .catch((err) => console.error("place_order failed:", err))
        .finally(() => {
          // Drop the optimistic row; the poll shows the real one (if it rested).
          set((s) => ({ openOrders: s.openOrders.filter((o) => o.id !== id) }));
        });
      return;
    }

    // ── Simulated path ──────────────────────────────────────────────
    const { lastPrice, balances } = get();
    const execPrice = type === "market" ? lastPrice : price;
    const lock = lockFor(side, execPrice, size);
    const bal = balances[lock.asset];
    if (!bal || bal.total - bal.locked < lock.amount) return;

    const id = `ord-${++orderSeq}`;
    const order: OpenOrder = {
      id,
      market: MARKET.symbol,
      side,
      type,
      price: execPrice,
      size,
      filled: 0,
      status: "pending",
      ts: Date.now(),
    };
    set((s) => ({
      openOrders: [order, ...s.openOrders],
      balances: {
        ...s.balances,
        [lock.asset]: { ...bal, locked: bal.locked + lock.amount },
      },
    }));

    // simulate on-chain ack; market orders fill against the book immediately after
    setTimeout(() => {
      const cur = get().openOrders.find((o) => o.id === id);
      if (!cur || cur.status !== "pending") return;
      if (type === "market") {
        fillOrder(set, get, id, get().lastPrice);
      } else {
        set((s) => ({
          openOrders: s.openOrders.map((o) => (o.id === id ? { ...o, status: "open" } : o)),
        }));
      }
    }, 500);
  },

  cancelOrder: (id) => {
    const order = get().openOrders.find((o) => o.id === id);
    if (!order || order.status === "filled" || order.status === "canceled") return;

    // ── Real path: cancel on-chain; the poll restores it if that fails ──
    if (chain) {
      if (order.status === "pending") return; // not on the book yet
      set((s) => ({ openOrders: s.openOrders.filter((o) => o.id !== id) }));
      chain
        .cancelOrder(order.side, Number(order.id))
        .then(() => refreshChainState(set))
        .catch((err) => console.error("cancel_order failed:", err));
      return;
    }
    const lock = lockFor(order.side, order.price, order.size);
    set((s) => {
      const bal = s.balances[lock.asset];
      return {
        openOrders: s.openOrders.filter((o) => o.id !== id),
        balances: {
          ...s.balances,
          [lock.asset]: { ...bal, locked: Math.max(0, bal.locked - lock.amount) },
        },
      };
    });
  },
}));

type Set = (fn: (s: TerminalState) => Partial<TerminalState>) => void;
type Get = () => TerminalState;

// ── On-chain state sync (real wallet only) ─────────────────────────────
//
// Balances come straight from the OpenOrders account; open orders and
// fill history come from the indexer, which watches the same events the
// book is built from. Poll-based: plenty at this project's scale.

function startChainPolling(set: Set, get: Get) {
  void get; // parity with the simulated engine's signature
  stopChainPolling();
  void refreshChainState(set);
  pollTimer = setInterval(() => void refreshChainState(set), 2_000);
}

function stopChainPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshChainState(set: Set) {
  if (!chain || !(feed instanceof IndexerFeed)) return;
  const f = feed;
  const conv = f.converter;
  const addr = chain.address;
  try {
    const [bal, orderRows, tradeRows] = await Promise.all([
      chain.balances(),
      fetch(`${INDEXER_HTTP}/markets/${f.marketPubkey}/orders?owner=${addr}&status=open`).then(
        (r) => r.json() as Promise<{ order_id: number; side: number; price: number; orig_qty: number; remaining: number; placed_at: string }[]>,
      ),
      fetch(`${INDEXER_HTTP}/markets/${f.marketPubkey}/trades?limit=100`).then(
        (r) => r.json() as Promise<{ id: number; maker: string; taker: string; taker_side: number; price: number; qty: number; taker_fee: number; ts: string }[]>,
      ),
    ]);

    const openOrders: OpenOrder[] = orderRows.map((o) => ({
      id: String(o.order_id),
      market: MARKET.symbol,
      side: o.side === 0 ? "buy" : "sell",
      type: "limit",
      price: conv.priceToUi(o.price),
      size: conv.sizeToUi(o.orig_qty),
      filled: conv.sizeToUi(o.orig_qty - o.remaining),
      status: "open",
      ts: Date.parse(o.placed_at),
    }));

    const fills: Fill[] = tradeRows
      .filter((t) => t.maker === addr || t.taker === addr)
      .map((t) => {
        const isTaker = t.taker === addr;
        const takerSide: Side = t.taker_side === 0 ? "buy" : "sell";
        return {
          id: `trade-${t.id}`,
          market: MARKET.symbol,
          side: isTaker ? takerSide : takerSide === "buy" ? "sell" : "buy",
          price: conv.priceToUi(t.price),
          size: conv.sizeToUi(t.qty),
          fee: isTaker ? t.taker_fee / 10 ** f.meta.quoteDecimals : 0, // makers pay no fee
          ts: Date.parse(t.ts),
        };
      });

    set((s) => ({
      balances: {
        [MARKET.base]: bal.base,
        [MARKET.quote]: bal.quote,
      },
      // keep optimistic pending rows on top of the indexer's view
      openOrders: [...s.openOrders.filter((o) => o.status === "pending"), ...openOrders],
      fills,
    }));
  } catch (err) {
    console.error("chain state refresh failed:", err);
  }
}

function fillOrder(set: Set, get: Get, id: string, execPrice: number) {
  const order = get().openOrders.find((o) => o.id === id);
  if (!order) return;
  const lock = lockFor(order.side, order.price, order.size);
  const fee = execPrice * order.size * TAKER_FEE;
  const fill: Fill = {
    id: `fill-${order.id}`,
    market: order.market,
    side: order.side,
    price: execPrice,
    size: order.size,
    fee,
    ts: Date.now(),
  };
  set((s) => {
    const balances = { ...s.balances };
    const locked = balances[lock.asset];
    balances[lock.asset] = {
      ...locked,
      total: locked.total - (order.side === "buy" ? execPrice * order.size + fee : order.size),
      locked: Math.max(0, locked.locked - lock.amount),
    };
    const recvAsset = order.side === "buy" ? MARKET.base : MARKET.quote;
    const recvAmount = order.side === "buy" ? order.size : execPrice * order.size - fee;
    balances[recvAsset] = {
      ...balances[recvAsset],
      total: balances[recvAsset].total + recvAmount,
    };
    return {
      openOrders: s.openOrders.filter((o) => o.id !== id),
      fills: [fill, ...s.fills].slice(0, 100),
      balances,
    };
  });
}

/** test hook: run the same settlement pass the feed runs on every tick */
export function settleAtPrice(lastPrice: number) {
  useTerminal.setState({ lastPrice });
  settleCrossedOrders(useTerminal.setState, useTerminal.getState, lastPrice);
}

/** fill resting limit orders once the tape trades through their price */
function settleCrossedOrders(set: Set, get: Get, lastPrice: number) {
  for (const o of get().openOrders) {
    if (o.status !== "open") continue;
    const crossed =
      (o.side === "buy" && lastPrice <= o.price) ||
      (o.side === "sell" && lastPrice >= o.price);
    if (crossed) fillOrder(set, get, o.id, o.price);
  }
}
