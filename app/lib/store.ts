import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
// Type-only: the real module (and its heavy anchor/web3 deps) loads
// lazily on wallet connect, keeping it out of the initial bundle.
import type { ChainClient, PerpClient } from "./chain";
import type { Role } from "./roles";
import { INDEXER_HTTP, IndexerFeed } from "./indexer";
import { MockFeed } from "./mock";
import type {
  Balance,
  BookLevel,
  Candle,
  FeedSnapshot,
  Fill,
  MarketInfo,
  MarketListing,
  MarketStats,
  OpenOrder,
  OrderType,
  PerpPosition,
  Side,
  Trade,
} from "./types";

const SPOT_MARKET: MarketInfo = {
  symbol: "SOL/USDC",
  base: "SOL",
  quote: "USDC",
  tickSize: 0.01,
  minSize: 0.01,
  priceDecimals: 2,
  sizeDecimals: 2,
};

const PERP_MARKET: MarketInfo = {
  symbol: "SOL-PERP",
  base: "SOL",
  quote: "USDC",
  tickSize: 0.1,
  minSize: 0.001,
  priceDecimals: 2,
  sizeDecimals: 3,
};

const TAKER_FEE = 0.0004;

let feed: MockFeed | IndexerFeed | null = null;
let feedStarting = false; // guards the async probe against double-invoked effects
let orderSeq = 0;

/** Non-null while the wallet trades on-chain (indexer feed + validator up). */
let chain: ChainClient | null = null;
let perp: PerpClient | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export type FeedSource = "indexer" | "mock";

export type ToastKind = "error" | "success" | "info";
export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}
let toastSeq = 0;

/** Order-ticket defaults remembered across visits. */
export interface TicketPrefs {
  side: Side;
  orderType: OrderType;
}

const SIM_ADDRESS = "9bezj1VAw4gTMKonswkKioRdsttD4UowXh87Fcw9Wtr2";
const SIM_BALANCES: Record<string, Balance> = {
  SOL: { total: 84.6, locked: 0 },
  USDC: { total: 12_450.0, locked: 0 },
};

interface TerminalState {
  /** true once the persisted session has been read back from localStorage */
  hydrated: boolean;
  market: MarketInfo;
  markets: MarketListing[];
  selectedMarket: string | null; // indexer pubkey, null in sim mode
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
  /** persisted intent: reconnect the wallet automatically on the next visit */
  walletAutoConnect: boolean;
  /** true while a wallet connection is in flight (incl. session restore) */
  walletConnecting: boolean;
  /** true when orders are real signed transactions (burner wallet + validator) */
  tradingLive: boolean;
  /** guest browsing: past the login screen without a wallet, read-only */
  guest: boolean;
  /** on-chain derived role — see lib/roles.ts */
  role: Role;
  /** the perp market operator's address (oracle keeper), for display */
  perpAdmin: string | null;
  balances: Record<string, Balance>;
  openOrders: OpenOrder[];
  fills: Fill[];
  position: PerpPosition | null;
  /** latest funding premium (bps/day) for the selected perp market */
  fundingBps: number | null;

  /** set when the user clicks a book/trade price; consumed by the order form */
  quotedPrice: number | null;

  /** transient notifications (tx failures/acks); rendered by <Toasts /> */
  toasts: Toast[];
  /** last-used order ticket side/type, persisted across visits */
  prefs: TicketPrefs;

  startFeed: () => void;
  switchMarket: (pubkey: string) => void;
  enterAsGuest: () => void;
  connectWallet: () => void;
  disconnectWallet: () => void;
  quotePrice: (price: number) => void;
  clearQuotedPrice: () => void;
  pushToast: (kind: ToastKind, text: string) => void;
  dismissToast: (id: string) => void;
  setPrefs: (prefs: Partial<TicketPrefs>) => void;
  placeOrder: (side: Side, type: OrderType, price: number, size: number) => void;
  cancelOrder: (id: string) => void;
  openPerpPosition: (side: Side, size: number) => void;
  closePerpPosition: () => void;
  depositCollateral: (amount: number) => void;
  withdrawCollateral: (amount: number) => void;
}

function lockFor(market: MarketInfo, side: Side, price: number, size: number) {
  return side === "buy"
    ? { asset: market.quote, amount: price * size }
    : { asset: market.base, amount: size };
}

function listingSymbol(kind: "spot" | "perp") {
  return kind === "perp" ? PERP_MARKET.symbol : SPOT_MARKET.symbol;
}

/**
 * Persistence boundary. Three kinds of state live in this store and only
 * one of them is worth writing to disk:
 *
 *  - market data (book, tape, candles, stats) — the indexer's, re-streamed
 *    on every load; persisting it would only show stale prices.
 *  - account state (balances, orders, fills, position, role) — the chain's,
 *    re-derived on connect; persisting it would let it drift from truth.
 *  - session state (how the user entered, which market they were on, how
 *    their ticket was configured) — the user's. This is all we persist.
 */
const PERSISTED = (s: TerminalState) => ({
  guest: s.guest,
  walletAutoConnect: s.walletAutoConnect,
  selectedMarket: s.selectedMarket,
  prefs: s.prefs,
});

/** SSR / node tests: no localStorage, persist becomes a no-op. */
const noopStorage: Storage = {
  length: 0,
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {},
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
  hydrated: false,
  market: SPOT_MARKET,
  markets: [],
  selectedMarket: null,
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
  walletAutoConnect: false,
  walletConnecting: false,
  tradingLive: false,
  guest: false,
  role: "viewer",
  perpAdmin: null,
  balances: { ...SIM_BALANCES },
  openOrders: [],
  fills: [],
  position: null,
  fundingBps: null,
  quotedPrice: null,
  toasts: [],
  prefs: { side: "buy", orderType: "limit" },

  startFeed: () => {
    if (feed || feedStarting) return;
    feedStarting = true;

    // Prefer the real indexer; fall back to the simulator when it's not up.
    // A restored session carries the last market and reconnects the wallet.
    const restore = get().walletAutoConnect;
    if (restore) set({ walletConnecting: true });
    IndexerFeed.connect(get().selectedMarket ?? undefined)
      .then((f) => {
        attachFeed(set, get, f, "indexer");
        void refreshMarketList(set);
        if (restore) connectChain(set, get);
      })
      .catch(() => {
        attachFeed(set, get, new MockFeed(), "mock");
        if (restore)
          set({
            wallet: { connected: true, address: SIM_ADDRESS },
            role: "trader",
            walletConnecting: false,
          });
      });
  },

  switchMarket: (pubkey) => {
    const { selectedMarket, wallet } = get();
    if (pubkey === selectedMarket || !(feed instanceof IndexerFeed)) return;

    feed.stop();
    feed = null;
    stopChainPolling();
    chain = null;
    perp = null;

    set({
      selectedMarket: pubkey,
      bids: [],
      asks: [],
      trades: [],
      candles: [],
      lastPrice: 0,
      openOrders: [],
      fills: [],
      position: null,
      fundingBps: null,
      feedLive: false,
      tradingLive: false,
      walletConnecting: wallet.connected,
    });

    IndexerFeed.connect(pubkey)
      .then((f) => {
        attachFeed(set, get, f, "indexer");
        if (wallet.connected) connectChain(set, get);
      })
      .catch((err) => {
        console.error("market switch failed:", err);
        get().pushToast("error", `Market switch failed: ${errText(err)}`);
      });
  },

  enterAsGuest: () => set({ guest: true, role: "viewer" }),

  connectWallet: () => {
    // The click itself is the durable intent — record it even if the
    // chain connect ends up falling back to the simulator (e.g. devnet
    // RPC limits), so the next visit retries the real connection.
    if (feed instanceof IndexerFeed) {
      set({ walletConnecting: true, walletAutoConnect: true });
      connectChain(set, get);
    } else {
      set({
        wallet: { connected: true, address: SIM_ADDRESS },
        role: "trader",
        walletAutoConnect: true,
      });
    }
  },

  disconnectWallet: () => {
    stopChainPolling();
    chain = null;
    perp = null;
    set({
      wallet: { connected: false, address: null },
      walletAutoConnect: false,
      walletConnecting: false,
      tradingLive: false,
      guest: false,
      role: "viewer",
      perpAdmin: null,
      openOrders: [],
      fills: [],
      position: null,
      balances: { ...SIM_BALANCES },
    });
  },

  quotePrice: (price) => set({ quotedPrice: price }),
  clearQuotedPrice: () => set({ quotedPrice: null }),

  pushToast: (kind, text) => {
    const id = `toast-${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 6_000);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setPrefs: (prefs) => set((s) => ({ prefs: { ...s.prefs, ...prefs } })),

  placeOrder: (side, type, price, size) => {
    const market = get().market;

    // ── Real path: sign and send place_order, then re-sync from chain ──
    if (chain) {
      const c = chain;
      const { lastPrice } = get();
      const id = `pending-${++orderSeq}`;
      const order: OpenOrder = {
        id,
        market: market.symbol,
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
        .then(() => {
          get().pushToast("success", `${side === "buy" ? "Buy" : "Sell"} ${size} ${market.base} placed on-chain`);
          return refreshChainState(set);
        })
        .catch((err) => {
          console.error("place_order failed:", err);
          get().pushToast("error", `Order failed: ${errText(err)}`);
        })
        .finally(() => {
          // Drop the optimistic row; the poll shows the real one (if it rested).
          set((s) => ({ openOrders: s.openOrders.filter((o) => o.id !== id) }));
        });
      return;
    }

    // ── Simulated path ──────────────────────────────────────────────
    const { lastPrice, balances } = get();
    const execPrice = type === "market" ? lastPrice : price;
    const lock = lockFor(market, side, execPrice, size);
    const bal = balances[lock.asset];
    if (!bal || bal.total - bal.locked < lock.amount) return;

    const id = `ord-${++orderSeq}`;
    const order: OpenOrder = {
      id,
      market: market.symbol,
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
        .catch((err) => {
          console.error("cancel_order failed:", err);
          get().pushToast("error", `Cancel failed: ${errText(err)}`);
        });
      return;
    }

    const market = get().market;
    const lock = lockFor(market, order.side, order.price, order.size);
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

  // ── Perp actions (real chain only — no simulated perp engine) ──────

  openPerpPosition: (side, size) => {
    if (!perp) return;
    const delta = side === "buy" ? size : -size;
    perp
      .openPosition(delta)
      .then(() => {
        get().pushToast("success", `${side === "buy" ? "Long" : "Short"} ${size} opened`);
        return refreshChainState(set);
      })
      .catch((err) => {
        console.error("open_position failed:", err);
        get().pushToast("error", `Position failed: ${errText(err)}`);
      });
  },

  closePerpPosition: () => {
    if (!perp) return;
    perp
      .closePosition()
      .then(() => {
        get().pushToast("success", "Position closed");
        return refreshChainState(set);
      })
      .catch((err) => {
        console.error("close position failed:", err);
        get().pushToast("error", `Close failed: ${errText(err)}`);
      });
  },

  depositCollateral: (amount) => {
    if (!perp || amount <= 0) return;
    perp
      .depositCollateral(amount)
      .then(() => refreshChainState(set))
      .catch((err) => {
        console.error("deposit_collateral failed:", err);
        get().pushToast("error", `Deposit failed: ${errText(err)}`);
      });
  },

  withdrawCollateral: (amount) => {
    if (!perp || amount <= 0) return;
    perp
      .withdrawCollateral(amount)
      .then(() => refreshChainState(set))
      .catch((err) => {
        console.error("withdraw_collateral failed:", err);
        get().pushToast("error", `Withdraw failed: ${errText(err)}`);
      });
  },
    }),
    {
      name: "matchbook.session",
      version: 1,
      storage: createJSONStorage(() =>
        typeof window === "undefined" ? noopStorage : window.localStorage,
      ),
      partialize: PERSISTED,
      // Next.js prerenders this page; hydrating from localStorage during
      // render would mismatch the server HTML. The page calls
      // `useTerminal.persist.rehydrate()` in an effect instead.
      skipHydration: true,
      onRehydrateStorage: () => () => {
        useTerminal.setState({ hydrated: true });
      },
    },
  ),
);

/** Shorten an error for a toast; full detail stays in the console. */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
}

type Set = (fn: (s: TerminalState) => Partial<TerminalState>) => void;
type Get = () => TerminalState;

// ── Feed wiring ────────────────────────────────────────────────────────

function attachFeed(set: Set, get: Get, f: MockFeed | IndexerFeed, source: FeedSource) {
  feed = f;
  const isPerp = f instanceof IndexerFeed && f.kind === "perp";
  set(() => ({
    market: isPerp ? PERP_MARKET : SPOT_MARKET,
    selectedMarket: f instanceof IndexerFeed ? f.marketPubkey : null,
  }));
  f.start((snap: FeedSnapshot) => {
    set(() => ({
      bids: snap.bids,
      asks: snap.asks,
      trades: snap.trades,
      candles: snap.candles,
      lastPrice: snap.lastPrice,
      lastSide: snap.lastSide,
      stats: snap.stats,
      feedLive: true,
      feedSource: source,
    }));
    // The simulated fill engine only runs for the simulated wallet;
    // on-chain orders settle on-chain.
    if (!chain && !perp) settleCrossedOrders(set, get, snap.lastPrice);
  });
}

async function refreshMarketList(set: Set) {
  try {
    const rows = await IndexerFeed.listMarkets();
    const listings: MarketListing[] = rows.map((m) => ({
      pubkey: m.pubkey,
      kind: m.kind,
      symbol: listingSymbol(m.kind),
    }));
    // newest spot + the perp market — one listing per kind
    const bySymbol = new Map<string, MarketListing>();
    for (const l of listings) bySymbol.set(l.symbol, l);
    set(() => ({ markets: Array.from(bySymbol.values()) }));
  } catch (err) {
    console.error("market list failed:", err);
  }
}

// ── On-chain wallet + state sync ───────────────────────────────────────

function connectChain(set: Set, get: Get) {
  if (!(feed instanceof IndexerFeed)) return;
  const f = feed;
  const isPerp = f.kind === "perp";
  const connect = import("./chain").then(({ ChainClient, PerpClient }) =>
    isPerp
      ? PerpClient.connect(f.marketPubkey).then((c) => {
          perp = c;
          return c.address;
        })
      : ChainClient.connect(f.meta).then((c) => {
          chain = c;
          return c.address;
        }),
  );

  connect
    .then((address) => {
      set(() => ({
        wallet: { connected: true, address },
        walletConnecting: false,
        tradingLive: true,
        role: "trader", // optimistic; refined by the on-chain resolution below
        openOrders: [],
        fills: [],
      }));
      startChainPolling(set, get);
      resolveRoleInBackground(set, get, address);
    })
    .catch((err) => {
      console.error("on-chain wallet unavailable, using simulator:", err);
      get().pushToast("info", "On-chain wallet unavailable — trading in simulator");
      set(() => ({
        wallet: { connected: true, address: SIM_ADDRESS },
        walletConnecting: false,
        role: "trader",
      }));
    });
}

/** RBAC: derive the wallet's role from on-chain state, off the hot path. */
function resolveRoleInBackground(set: Set, get: Get, address: string) {
  const markets = get().markets;
  const perpPk = markets.find((m) => m.kind === "perp")?.pubkey;
  const spotPk = markets.find((m) => m.kind === "spot")?.pubkey;
  import("./roles")
    .then(({ resolveRole }) => resolveRole(address, { perp: perpPk, spot: spotPk }))
    .then((info) => set(() => ({ role: info.role, perpAdmin: info.perpAdmin })))
    .catch((err) => console.error("role resolution failed:", err));
}

function startChainPolling(set: Set, get: Get) {
  void get;
  stopChainPolling();
  void refreshChainState(set);
  pollTimer = setInterval(() => void refreshChainState(set), 2_000);
}

function stopChainPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshChainState(set: Set) {
  if (!(feed instanceof IndexerFeed)) return;
  const f = feed;
  const conv = f.converter;

  try {
    if (perp) {
      // Perp: position + collateral from chain, fills + funding from the indexer.
      const addr = perp.address;
      const [pos, tradeRows, fundingRes] = await Promise.all([
        perp.state(),
        fetch(`${INDEXER_HTTP}/markets/${f.marketPubkey}/trades?limit=100`).then(
          (r) => r.json() as Promise<{ id: number; taker: string; taker_side: number; price: number; qty: number; taker_fee: number; ts: string }[]>,
        ),
        fetch(`${INDEXER_HTTP}/markets/${f.marketPubkey}/funding`).then(
          (r) => r.json() as Promise<{ latest: { premium_bps: number } | null }>,
        ),
      ]);
      const fills: Fill[] = tradeRows
        .filter((t) => t.taker === addr)
        .map((t) => ({
          id: `trade-${t.id}`,
          market: PERP_MARKET.symbol,
          side: t.taker_side === 0 ? "buy" : "sell",
          price: conv.priceToUi(t.price),
          size: conv.sizeToUi(t.qty),
          fee: t.taker_fee / 10 ** f.meta.quoteDecimals,
          ts: Date.parse(t.ts),
        }));
      set(() => ({
        position: pos,
        fills,
        fundingBps: fundingRes.latest?.premium_bps ?? null,
        balances: {
          USDC: {
            total: pos.collateral,
            locked: Math.max(0, pos.equity - pos.freeCollateral),
          },
        },
      }));
      return;
    }

    if (!chain) return;
    const addr = chain.address;
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
      market: SPOT_MARKET.symbol,
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
          market: SPOT_MARKET.symbol,
          side: isTaker ? takerSide : takerSide === "buy" ? "sell" : "buy",
          price: conv.priceToUi(t.price),
          size: conv.sizeToUi(t.qty),
          fee: isTaker ? t.taker_fee / 10 ** f.meta.quoteDecimals : 0, // makers pay no fee
          ts: Date.parse(t.ts),
        };
      });

    set((s) => ({
      balances: {
        [SPOT_MARKET.base]: bal.base,
        [SPOT_MARKET.quote]: bal.quote,
      },
      // keep optimistic pending rows on top of the indexer's view
      openOrders: [...s.openOrders.filter((o) => o.status === "pending"), ...openOrders],
      fills,
    }));
  } catch (err) {
    console.error("chain state refresh failed:", err);
  }
}

// ── Simulated fill engine (mock wallet only) ───────────────────────────

function fillOrder(set: Set, get: Get, id: string, execPrice: number) {
  const order = get().openOrders.find((o) => o.id === id);
  if (!order) return;
  const market = get().market;
  const lock = lockFor(market, order.side, order.price, order.size);
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
    const recvAsset = order.side === "buy" ? market.base : market.quote;
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
