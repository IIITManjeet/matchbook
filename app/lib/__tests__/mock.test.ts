import { describe, expect, it, vi } from "vitest";
import { MockFeed } from "@/lib/mock";
import type { FeedSnapshot } from "@/lib/types";

function firstSnapshot(): FeedSnapshot {
  const feed = new MockFeed();
  let snap: FeedSnapshot | null = null;
  feed.start((s) => {
    snap = s;
  });
  feed.stop();
  if (!snap) throw new Error("feed did not emit a snapshot synchronously");
  return snap;
}

describe("MockFeed seeding", () => {
  it("seeds 240 one-minute candles with strictly increasing aligned times", () => {
    const { candles } = firstSnapshot();
    expect(candles.length).toBe(240);
    for (let i = 0; i < candles.length; i++) {
      expect(candles[i].time % 60).toBe(0);
      if (i > 0) expect(candles[i].time - candles[i - 1].time).toBe(60);
    }
  });

  it("seeds internally consistent candles (low <= open/close <= high, volume > 0)", () => {
    const { candles } = firstSnapshot();
    for (const c of candles) {
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.volume).toBeGreaterThan(0);
    }
  });

  it("reports 24h stats that bound the seeded candles", () => {
    const { candles, stats } = firstSnapshot();
    const maxHigh = Math.max(...candles.map((c) => c.high));
    const minLow = Math.min(...candles.map((c) => c.low));
    expect(stats.high24h).toBeGreaterThanOrEqual(maxHigh - 0.011);
    expect(stats.low24h).toBeLessThanOrEqual(minLow + 0.011);
    expect(stats.volumeBase).toBeGreaterThan(0);
    expect(stats.volumeQuote).toBeGreaterThan(stats.volumeBase); // price >> 1
  });
});

describe("MockFeed orderbook", () => {
  it("emits bids descending and asks ascending with no crossed book", () => {
    const { bids, asks } = firstSnapshot();
    expect(bids.length).toBeGreaterThan(0);
    expect(asks.length).toBeGreaterThan(0);
    for (let i = 1; i < bids.length; i++) expect(bids[i].price).toBeLessThan(bids[i - 1].price);
    for (let i = 1; i < asks.length; i++) expect(asks[i].price).toBeGreaterThan(asks[i - 1].price);
    expect(asks[0].price).toBeGreaterThan(bids[0].price);
  });

  it("accumulates cumulative totals per side", () => {
    const { bids, asks } = firstSnapshot();
    for (const side of [bids, asks]) {
      let running = 0;
      for (const level of side) {
        running += level.size;
        expect(level.total).toBeCloseTo(running, 1);
        expect(level.size).toBeGreaterThan(0);
      }
    }
  });
});

describe("MockFeed live ticks", () => {
  it("prints trades, keeps the book uncrossed, and tracks candles over 100 ticks", () => {
    vi.useFakeTimers();
    try {
      const feed = new MockFeed();
      const snaps: FeedSnapshot[] = [];
      feed.start((s) => snaps.push(s));
      vi.advanceTimersByTime(400 * 100);
      feed.stop();

      expect(snaps.length).toBe(101);
      for (const s of snaps) {
        expect(s.asks[0].price).toBeGreaterThan(s.bids[0].price);
      }
      const last = snaps[snaps.length - 1];
      expect(last.trades.length).toBeGreaterThan(0);
      expect(last.lastPrice).toBeCloseTo(last.candles[last.candles.length - 1].close, 6);
      // trades arrive newest-first
      for (let i = 1; i < last.trades.length; i++) {
        expect(last.trades[i].ts).toBeLessThanOrEqual(last.trades[i - 1].ts);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops emitting after stop()", () => {
    vi.useFakeTimers();
    try {
      const feed = new MockFeed();
      let count = 0;
      feed.start(() => count++);
      vi.advanceTimersByTime(4000);
      feed.stop();
      const atStop = count;
      vi.advanceTimersByTime(4000);
      expect(count).toBe(atStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
