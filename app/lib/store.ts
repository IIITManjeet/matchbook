import { create } from "zustand";
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

let feed: MockFeed | null = null;
let orderSeq = 0;

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

  wallet: { connected: boolean; address: string | null };
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

  wallet: { connected: false, address: null },
  balances: {
    SOL: { total: 84.6, locked: 0 },
    USDC: { total: 12_450.0, locked: 0 },
  },
  openOrders: [],
  fills: [],
  quotedPrice: null,

  startFeed: () => {
    if (feed) return;
    feed = new MockFeed();
    feed.start((snap: FeedSnapshot) => {
      set({
        bids: snap.bids,
        asks: snap.asks,
        trades: snap.trades,
        candles: snap.candles,
        lastPrice: snap.lastPrice,
        lastSide: snap.lastSide,
        stats: snap.stats,
        feedLive: true,
      });
      settleCrossedOrders(set, get, snap.lastPrice);
    });
  },

  connectWallet: () =>
    set({ wallet: { connected: true, address: "9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2" } }),
  disconnectWallet: () => set({ wallet: { connected: false, address: null } }),

  quotePrice: (price) => set({ quotedPrice: price }),
  clearQuotedPrice: () => set({ quotedPrice: null }),

  placeOrder: (side, type, price, size) => {
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
