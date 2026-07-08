/**
 * Real market-data feed backed by the M3 indexer: REST for the initial
 * state (candles, trades, book), websocket for live updates. Exposes the
 * same `start(onTick)` / `stop()` interface as MockFeed, so the store
 * can swap between them without the UI noticing.
 *
 * The indexer speaks on-chain units — prices in ticks, sizes in base
 * lots. Everything is converted to UI units (USDC per SOL, SOL) at this
 * boundary and nowhere else.
 */

import type { BookLevel, Candle, FeedSnapshot, MarketStats, Side, Trade } from "./types";

export const INDEXER_HTTP = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://127.0.0.1:8081";
const HTTP_URL = INDEXER_HTTP;
const BASE_DECIMALS = Number(process.env.NEXT_PUBLIC_BASE_DECIMALS ?? 9);
const QUOTE_DECIMALS = Number(process.env.NEXT_PUBLIC_QUOTE_DECIMALS ?? 6);
const EMIT_MS = 400;
const BOOK_DEPTH = 18;

interface IndexerMarket {
  pubkey: string;
  base_mint: string;
  quote_mint: string;
  tick_size: number;
  base_lot_size: number;
}

// ── Pure unit conversion (exported for tests) ──────────────────────────

export interface Converter {
  priceToUi: (ticks: number) => number;
  sizeToUi: (lots: number) => number;
}

export function makeConverter(
  tickSize: number,
  baseLotSize: number,
  baseDecimals = BASE_DECIMALS,
  quoteDecimals = QUOTE_DECIMALS,
): Converter {
  // price(ui) = quote per base = (ticks*tickSize / 10^qd) / (lotSize / 10^bd)
  const priceFactor = (tickSize * 10 ** (baseDecimals - quoteDecimals)) / baseLotSize;
  const sizeFactor = baseLotSize / 10 ** baseDecimals;
  return {
    priceToUi: (ticks) => ticks * priceFactor,
    sizeToUi: (lots) => lots * sizeFactor,
  };
}

// ── Pure book mirror (exported for tests) ──────────────────────────────

/** Price-level maps in on-chain units, mirroring the indexer's book. */
export class BookMirror {
  bids = new Map<number, number>(); // price ticks -> qty lots
  asks = new Map<number, number>();

  applySnapshot(snap: { bids: [number, number][]; asks: [number, number][] }) {
    this.bids = new Map(snap.bids);
    this.asks = new Map(snap.asks);
  }

  applyDelta(levels: { side: number; price: number; qty: number }[]) {
    for (const l of levels) {
      const side = l.side === 0 ? this.bids : this.asks;
      if (l.qty === 0) side.delete(l.price);
      else side.set(l.price, l.qty);
    }
  }

  levels(side: Side, conv: Converter, depth = BOOK_DEPTH): BookLevel[] {
    const map = side === "buy" ? this.bids : this.asks;
    const sorted = Array.from(map.entries()).sort((a, b) =>
      side === "buy" ? b[0] - a[0] : a[0] - b[0],
    );
    const out: BookLevel[] = [];
    let total = 0;
    for (const [price, qty] of sorted.slice(0, depth)) {
      total += conv.sizeToUi(qty);
      out.push({
        price: conv.priceToUi(price),
        size: conv.sizeToUi(qty),
        total: Math.round(total * 100) / 100,
      });
    }
    return out;
  }
}

/** Fold a trade into the 1m candle list (same rule as the mock feed). */
export function updateCandles(candles: Candle[], price: number, size: number, tsMs: number, cap = 1500) {
  const bucket = Math.floor(tsMs / 1000 / 60) * 60;
  const last = candles[candles.length - 1];
  if (last && last.time === bucket) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += size;
  } else {
    candles.push({ time: bucket, open: price, high: price, low: price, close: price, volume: size });
    if (candles.length > cap) candles.shift();
  }
}

export function statsFromCandles(candles: Candle[], nowSec: number): MarketStats {
  const dayAgo = nowSec - 24 * 3600;
  const window = candles.filter((c) => c.time >= dayAgo);
  if (window.length === 0) {
    return { change24h: 0, high24h: 0, low24h: 0, volumeBase: 0, volumeQuote: 0 };
  }
  const open = window[0].open;
  const last = window[window.length - 1].close;
  let high = -Infinity;
  let low = Infinity;
  let volBase = 0;
  let volQuote = 0;
  for (const c of window) {
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    volBase += c.volume;
    volQuote += c.volume * c.close;
  }
  return {
    change24h: open > 0 ? ((last - open) / open) * 100 : 0,
    high24h: high,
    low24h: low,
    volumeBase: volBase,
    volumeQuote: volQuote,
  };
}

// ── The feed ───────────────────────────────────────────────────────────

export class IndexerFeed {
  private market: IndexerMarket;
  private conv: Converter;
  private book = new BookMirror();
  private candles: Candle[] = [];
  private trades: Trade[] = [];
  private tradeSeq = 0;
  private lastPrice = 0;
  private lastSide: Side = "buy";
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private constructor(market: IndexerMarket) {
    this.market = market;
    this.conv = makeConverter(market.tick_size, market.base_lot_size);
  }

  /**
   * Probe the indexer and pick the most recently created market.
   * Throws when the indexer is down or empty — callers fall back to
   * the mock feed.
   */
  static async connect(): Promise<IndexerFeed> {
    const res = await fetch(`${HTTP_URL}/markets`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`indexer /markets: ${res.status}`);
    const markets: IndexerMarket[] = await res.json();
    const preferred = process.env.NEXT_PUBLIC_MARKET;
    const market = preferred
      ? markets.find((m) => m.pubkey === preferred)
      : markets[markets.length - 1]; // newest
    if (!market) throw new Error("indexer has no markets");
    return new IndexerFeed(market);
  }

  get marketPubkey() {
    return this.market.pubkey;
  }

  /** Everything the on-chain client needs to trade this market. */
  get meta() {
    return {
      pubkey: this.market.pubkey,
      tickSize: this.market.tick_size,
      baseLotSize: this.market.base_lot_size,
      baseDecimals: BASE_DECIMALS,
      quoteDecimals: QUOTE_DECIMALS,
    };
  }

  get converter(): Converter {
    return this.conv;
  }

  start(onTick: (snap: FeedSnapshot) => void, intervalMs = EMIT_MS) {
    if (this.timer) return;
    void this.bootstrap().then(() => {
      if (this.stopped) return;
      onTick(this.snapshot());
      this.openSocket();
      this.timer = setInterval(() => onTick(this.snapshot()), intervalMs);
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  private async bootstrap() {
    const pk = this.market.pubkey;
    const [candles, trades, book] = await Promise.all([
      fetch(`${HTTP_URL}/markets/${pk}/candles?resolution=60&limit=1500`).then((r) => r.json()),
      fetch(`${HTTP_URL}/markets/${pk}/trades?limit=60`).then((r) => r.json()),
      fetch(`${HTTP_URL}/markets/${pk}/book?depth=50`).then((r) => r.json()),
    ]);

    this.candles = (candles as { bucket: string; open: number; high: number; low: number; close: number; volume: number }[]).map(
      (c) => ({
        time: Math.floor(Date.parse(c.bucket) / 1000),
        open: this.conv.priceToUi(c.open),
        high: this.conv.priceToUi(c.high),
        low: this.conv.priceToUi(c.low),
        close: this.conv.priceToUi(c.close),
        volume: this.conv.sizeToUi(c.volume),
      }),
    );

    // REST trades come newest-first, which is also the tape's order.
    this.trades = (trades as { id: number; price: number; qty: number; taker_side: number; ts: string }[]).map((t) => ({
      id: t.id,
      price: this.conv.priceToUi(t.price),
      size: this.conv.sizeToUi(t.qty),
      side: t.taker_side === 0 ? ("buy" as Side) : ("sell" as Side),
      ts: Date.parse(t.ts),
    }));
    this.tradeSeq = this.trades[0]?.id ?? 0;
    if (this.trades[0]) {
      this.lastPrice = this.trades[0].price;
      this.lastSide = this.trades[0].side;
    } else if (this.candles.length > 0) {
      this.lastPrice = this.candles[this.candles.length - 1].close;
    }

    this.book.applySnapshot(book.book);
  }

  private openSocket() {
    if (this.stopped) return;
    const wsUrl = HTTP_URL.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      for (const channel of ["trades", "book"]) {
        ws.send(JSON.stringify({ op: "subscribe", channel, market: this.market.pubkey }));
      }
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped) setTimeout(() => this.openSocket(), 2000);
    };
  }

  private onMessage(msg: { channel: string; market: string; data: Record<string, unknown> }) {
    if (msg.market !== this.market.pubkey) return;
    if (msg.channel === "book") {
      if (msg.data.type === "snapshot") {
        this.book.applySnapshot(msg.data.book as { bids: [number, number][]; asks: [number, number][] });
      } else {
        this.book.applyDelta(msg.data.levels as { side: number; price: number; qty: number }[]);
      }
    } else if (msg.channel === "trades") {
      const d = msg.data as { price: number; qty: number; taker_side: number; ts: string };
      const trade: Trade = {
        id: ++this.tradeSeq,
        price: this.conv.priceToUi(d.price),
        size: this.conv.sizeToUi(d.qty),
        side: d.taker_side === 0 ? "buy" : "sell",
        ts: Date.parse(d.ts) || Date.now(),
      };
      this.trades.unshift(trade);
      if (this.trades.length > 60) this.trades.pop();
      this.lastPrice = trade.price;
      this.lastSide = trade.side;
      updateCandles(this.candles, trade.price, trade.size, trade.ts);
    }
  }

  private snapshot(): FeedSnapshot {
    return {
      bids: this.book.levels("buy", this.conv),
      asks: this.book.levels("sell", this.conv),
      trades: [...this.trades],
      candles: this.candles.map((c) => ({ ...c })),
      lastPrice: this.lastPrice,
      lastSide: this.lastSide,
      stats: statsFromCandles(this.candles, Date.now() / 1000),
    };
  }
}
