import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleAtPrice, useTerminal } from "@/lib/store";

const TAKER_FEE = 0.0004;

function resetStore() {
  useTerminal.setState({
    openOrders: [],
    fills: [],
    lastPrice: 150,
    balances: {
      SOL: { total: 100, locked: 0 },
      USDC: { total: 10_000, locked: 0 },
    },
    wallet: { connected: true, address: "test" },
  });
}

function state() {
  return useTerminal.getState();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("placeOrder", () => {
  it("locks quote balance for a limit buy and acks pending → open", () => {
    state().placeOrder("buy", "limit", 140, 2);

    let order = state().openOrders[0];
    expect(order.status).toBe("pending");
    expect(state().balances.USDC.locked).toBeCloseTo(280);

    vi.advanceTimersByTime(600);
    order = state().openOrders[0];
    expect(order.status).toBe("open");
    expect(state().balances.USDC.locked).toBeCloseTo(280);
  });

  it("locks base balance for a limit sell", () => {
    state().placeOrder("sell", "limit", 160, 5);
    expect(state().balances.SOL.locked).toBeCloseTo(5);
    expect(state().balances.USDC.locked).toBe(0);
  });

  it("rejects an order the free balance cannot cover", () => {
    state().placeOrder("buy", "limit", 140, 1000); // needs 140k USDC, has 10k
    expect(state().openOrders.length).toBe(0);
    expect(state().balances.USDC.locked).toBe(0);
  });

  it("counts locked funds against available balance for subsequent orders", () => {
    state().placeOrder("buy", "limit", 100, 90); // locks 9000 of 10000
    state().placeOrder("buy", "limit", 100, 20); // needs 2000, only 1000 free
    expect(state().openOrders.length).toBe(1);
  });

  it("fills a market buy at the last price, charging the taker fee", () => {
    state().placeOrder("buy", "market", 0, 2); // execPrice = lastPrice = 150
    vi.advanceTimersByTime(600);

    expect(state().openOrders.length).toBe(0);
    expect(state().fills.length).toBe(1);

    const fill = state().fills[0];
    expect(fill.price).toBe(150);
    expect(fill.size).toBe(2);
    expect(fill.fee).toBeCloseTo(300 * TAKER_FEE);

    const { SOL, USDC } = state().balances;
    expect(SOL.total).toBeCloseTo(102);
    expect(USDC.total).toBeCloseTo(10_000 - 300 - 300 * TAKER_FEE);
    expect(USDC.locked).toBeCloseTo(0);
  });

  it("fills a market sell and credits quote minus fee", () => {
    state().placeOrder("sell", "market", 0, 4);
    vi.advanceTimersByTime(600);

    const { SOL, USDC } = state().balances;
    expect(SOL.total).toBeCloseTo(96);
    expect(USDC.total).toBeCloseTo(10_000 + 600 - 600 * TAKER_FEE);
    expect(SOL.locked).toBeCloseTo(0);
  });
});

describe("limit order settlement", () => {
  it("fills an open limit buy when the tape trades at or below its price", () => {
    state().placeOrder("buy", "limit", 140, 2);
    vi.advanceTimersByTime(600); // ack → open

    settleAtPrice(141); // not crossed
    expect(state().openOrders.length).toBe(1);

    settleAtPrice(139.5); // crossed
    expect(state().openOrders.length).toBe(0);
    expect(state().fills[0].price).toBe(140); // fills at the limit price

    const { SOL, USDC } = state().balances;
    expect(SOL.total).toBeCloseTo(102);
    expect(USDC.total).toBeCloseTo(10_000 - 280 - 280 * TAKER_FEE);
    expect(USDC.locked).toBeCloseTo(0);
  });

  it("fills an open limit sell when the tape trades at or above its price", () => {
    state().placeOrder("sell", "limit", 160, 3);
    vi.advanceTimersByTime(600);

    settleAtPrice(159.99);
    expect(state().openOrders.length).toBe(1);

    settleAtPrice(160);
    expect(state().openOrders.length).toBe(0);

    const { SOL, USDC } = state().balances;
    expect(SOL.total).toBeCloseTo(97);
    expect(USDC.total).toBeCloseTo(10_000 + 480 - 480 * TAKER_FEE);
    expect(SOL.locked).toBeCloseTo(0);
  });

  it("does not settle orders still pending ack", () => {
    state().placeOrder("buy", "limit", 140, 2);
    settleAtPrice(120); // crossed, but order not acked yet
    expect(state().openOrders.length).toBe(1);
    expect(state().openOrders[0].status).toBe("pending");
  });
});

describe("cancelOrder", () => {
  it("removes the order and releases locked funds", () => {
    state().placeOrder("buy", "limit", 140, 2);
    vi.advanceTimersByTime(600);
    const id = state().openOrders[0].id;

    state().cancelOrder(id);
    expect(state().openOrders.length).toBe(0);
    expect(state().balances.USDC.locked).toBeCloseTo(0);
    expect(state().balances.USDC.total).toBeCloseTo(10_000); // nothing spent
  });

  it("a canceled order never fills, even if the price later crosses", () => {
    state().placeOrder("buy", "limit", 140, 2);
    vi.advanceTimersByTime(600);
    state().cancelOrder(state().openOrders[0].id);

    settleAtPrice(120);
    expect(state().fills.length).toBe(0);
    expect(state().balances.SOL.total).toBeCloseTo(100);
  });
});

describe("invariants", () => {
  it("never lets locked exceed total across a burst of mixed activity", () => {
    for (let i = 0; i < 5; i++) {
      state().placeOrder("buy", "limit", 100 + i, 5);
      state().placeOrder("sell", "limit", 200 - i, 5);
    }
    vi.advanceTimersByTime(600);
    settleAtPrice(99); // fills all buys
    settleAtPrice(200); // fills all sells

    for (const [asset, b] of Object.entries(state().balances)) {
      expect(b.locked, `${asset} locked`).toBeGreaterThanOrEqual(0);
      expect(b.locked, `${asset} locked <= total`).toBeLessThanOrEqual(b.total + 1e-9);
    }
    expect(state().openOrders.length).toBe(0);
    expect(state().fills.length).toBe(10);
  });
});
