import { describe, expect, it } from "vitest";
import { BookMirror, makeConverter, statsFromCandles, updateCandles } from "../indexer";
import type { Candle } from "../types";

// The localnet market: tick_size=100, base_lot_size=1e6, SOL(9)/USDC(6).
const conv = makeConverter(100, 1_000_000, 9, 6);

describe("unit conversion", () => {
  it("converts ticks to a UI price", () => {
    // 500 ticks * 100 quote-atoms/tick per lot of 0.001 SOL = 50 USDC/SOL
    expect(conv.priceToUi(500)).toBeCloseTo(50);
  });

  it("converts lots to a UI size", () => {
    expect(conv.sizeToUi(10)).toBeCloseTo(0.01); // 10 lots × 0.001 SOL
  });
});

describe("BookMirror", () => {
  it("applies snapshot then deltas, aggregating cumulative totals", () => {
    const book = new BookMirror();
    book.applySnapshot({ bids: [[500, 10], [499, 20]], asks: [[501, 5]] });

    let bids = book.levels("buy", conv);
    expect(bids.map((l) => l.price)).toEqual([50, expect.closeTo(49.9)]); // best bid first
    expect(bids[1].total).toBeCloseTo(0.03); // cumulative 10+20 lots

    // Level shrinks, then disappears.
    book.applyDelta([{ side: 0, price: 500, qty: 4 }]);
    bids = book.levels("buy", conv);
    expect(bids[0].size).toBeCloseTo(0.004);

    book.applyDelta([{ side: 0, price: 500, qty: 0 }]);
    bids = book.levels("buy", conv);
    expect(bids.map((l) => l.price)).toEqual([expect.closeTo(49.9)]);

    // Asks sort ascending.
    book.applyDelta([{ side: 1, price: 502, qty: 8 }]);
    expect(book.levels("sell", conv).map((l) => l.price)).toEqual([
      expect.closeTo(50.1),
      expect.closeTo(50.2),
    ]);
  });
});

describe("updateCandles", () => {
  it("folds trades into minute buckets", () => {
    const candles: Candle[] = [];
    const t0 = 1_700_000_040_000; // some ms timestamp
    updateCandles(candles, 50, 1, t0);
    updateCandles(candles, 52, 2, t0 + 10_000); // same minute
    updateCandles(candles, 49, 1, t0 + 70_000); // next minute

    expect(candles).toHaveLength(2);
    expect(candles[0].high).toBe(52);
    expect(candles[0].close).toBe(52);
    expect(candles[0].volume).toBe(3);
    expect(candles[1].open).toBe(49);
  });
});

describe("statsFromCandles", () => {
  it("computes 24h stats from the window only", () => {
    const now = 1_700_100_000;
    const candles: Candle[] = [
      // stale: outside the 24h window
      { time: now - 25 * 3600, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: now - 3600, open: 40, high: 60, low: 38, close: 55, volume: 5 },
      { time: now - 60, open: 55, high: 56, low: 50, close: 50, volume: 3 },
    ];
    const s = statsFromCandles(candles, now);
    expect(s.high24h).toBe(60);
    expect(s.low24h).toBe(38);
    expect(s.volumeBase).toBe(8);
    expect(s.change24h).toBeCloseTo(((50 - 40) / 40) * 100);
  });

  it("is zeroed with no candles", () => {
    expect(statsFromCandles([], 1_700_000_000).change24h).toBe(0);
  });
});
