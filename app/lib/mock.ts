import type {
  BookLevel,
  Candle,
  FeedSnapshot,
  MarketStats,
  Side,
  Trade,
} from "./types";

const CANDLE_SECS = 60;
const SEED_CANDLES = 240;
const BOOK_DEPTH = 18;
const TICK = 0.01;
const START_PRICE = 145.2;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** rough lognormal-ish size so the book has a few whales among small orders */
function orderSize(): number {
  const r = Math.random();
  if (r > 0.97) return rand(300, 1200);
  if (r > 0.8) return rand(50, 300);
  return rand(1, 50);
}

function roundTick(p: number): number {
  return Math.round(p / TICK) * TICK;
}

/**
 * Simulated market data feed for one market. Emits an immutable snapshot on
 * every tick; the real implementation is replaced by the indexer websocket in M3.
 */
export class MockFeed {
  private mid = START_PRICE;
  private momentum = 0;
  private candles: Candle[] = [];
  private trades: Trade[] = [];
  private tradeSeq = 0;
  private lastSide: Side = "buy";
  private day = { open: START_PRICE, high: 0, low: Infinity, volBase: 0, volQuote: 0 };
  /** persistent per-price order sizes so book levels don't flicker every tick */
  private levelSizes = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.seedHistory();
  }

  private seedHistory() {
    const nowSec = Math.floor(Date.now() / 1000);
    const firstBucket = Math.floor(nowSec / CANDLE_SECS) * CANDLE_SECS - (SEED_CANDLES - 1) * CANDLE_SECS;
    let price = START_PRICE * rand(0.97, 1.03);
    for (let i = 0; i < SEED_CANDLES; i++) {
      const open = price;
      let high = open;
      let low = open;
      for (let s = 0; s < 6; s++) {
        price += price * rand(-0.0012, 0.0012);
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      const volume = rand(200, 4000);
      this.candles.push({
        time: firstBucket + i * CANDLE_SECS,
        open: roundTick(open),
        high: roundTick(high),
        low: roundTick(low),
        close: roundTick(price),
        volume,
      });
      this.day.high = Math.max(this.day.high, high);
      this.day.low = Math.min(this.day.low, low);
      this.day.volBase += volume;
      this.day.volQuote += volume * price;
    }
    this.day.open = this.candles[0].open;
    this.mid = this.candles[this.candles.length - 1].close;
  }

  start(onTick: (snap: FeedSnapshot) => void, intervalMs = 400) {
    if (this.timer) return;
    onTick(this.snapshot());
    this.timer = setInterval(() => {
      this.step();
      onTick(this.snapshot());
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private step() {
    // mean-reverting momentum keeps the walk from running away
    this.momentum = this.momentum * 0.92 + rand(-1, 1) * 0.35;
    this.mid = Math.max(1, this.mid + this.mid * this.momentum * 0.00035);

    const nTrades = Math.random() < 0.75 ? Math.floor(rand(1, 4)) : 0;
    for (let i = 0; i < nTrades; i++) this.emitTrade();
    this.mutateBook();
  }

  private emitTrade() {
    const buyBias = 0.5 + Math.max(-0.35, Math.min(0.35, this.momentum * 0.4));
    const side: Side = Math.random() < buyBias ? "buy" : "sell";
    const halfSpread = TICK * rand(1, 4);
    const price = roundTick(side === "buy" ? this.mid + halfSpread : this.mid - halfSpread);
    const size = Math.round(orderSize() * 100) / 100;
    const ts = Date.now();

    this.trades.unshift({ id: ++this.tradeSeq, price, size, side, ts });
    if (this.trades.length > 60) this.trades.pop();
    this.lastSide = side;
    this.updateCandle(price, size, ts);

    this.day.high = Math.max(this.day.high, price);
    this.day.low = Math.min(this.day.low, price);
    this.day.volBase += size;
    this.day.volQuote += size * price;
  }

  private updateCandle(price: number, size: number, ts: number) {
    const bucket = Math.floor(ts / 1000 / CANDLE_SECS) * CANDLE_SECS;
    const last = this.candles[this.candles.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += size;
    } else {
      this.candles.push({ time: bucket, open: price, high: price, low: price, close: price, volume: size });
      if (this.candles.length > 1500) this.candles.shift();
    }
  }

  private sideLevels(side: Side): BookLevel[] {
    const dir = side === "buy" ? -1 : 1;
    const start = roundTick(this.mid) + dir * TICK * Math.floor(rand(1, 3));
    const levels: BookLevel[] = [];
    let price = start;
    let total = 0;
    for (let i = 0; i < BOOK_DEPTH; i++) {
      const key = Math.round(price * 100) * (side === "buy" ? 1 : -1);
      let size = this.levelSizes.get(key);
      if (size === undefined || Math.random() < 0.18) {
        size = Math.round(orderSize() * 100) / 100;
        this.levelSizes.set(key, size);
      }
      total += size;
      levels.push({ price: roundTick(price), size, total: Math.round(total * 100) / 100 });
      price += dir * TICK * Math.floor(rand(1, 4));
    }
    if (this.levelSizes.size > 4000) this.levelSizes.clear();
    return levels;
  }

  private mutateBook() {
    // nudge a handful of resting sizes so the book breathes between price moves
    const keys = Array.from(this.levelSizes.keys());
    for (let i = 0; i < 3 && keys.length > 0; i++) {
      const key = keys[Math.floor(Math.random() * keys.length)];
      this.levelSizes.set(key, Math.round(orderSize() * 100) / 100);
    }
  }

  private stats(): MarketStats {
    const last = this.candles[this.candles.length - 1]?.close ?? this.mid;
    return {
      change24h: ((last - this.day.open) / this.day.open) * 100,
      high24h: roundTick(this.day.high),
      low24h: roundTick(this.day.low),
      volumeBase: this.day.volBase,
      volumeQuote: this.day.volQuote,
    };
  }

  private snapshot(): FeedSnapshot {
    return {
      bids: this.sideLevels("buy"),
      asks: this.sideLevels("sell"),
      trades: [...this.trades],
      candles: this.candles.map((c) => ({ ...c })),
      lastPrice: this.candles[this.candles.length - 1]?.close ?? this.mid,
      lastSide: this.lastSide,
      stats: this.stats(),
    };
  }
}
