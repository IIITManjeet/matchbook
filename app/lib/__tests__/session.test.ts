import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { useTerminal } from "@/lib/store";

/**
 * Session persistence: only the user's own choices survive a reload —
 * market data and chain-derived account state must always be re-streamed.
 */

const DEFAULTS = {
  hydrated: false,
  guest: false,
  walletAutoConnect: false,
  walletConnecting: false,
  selectedMarket: null,
  wallet: { connected: false, address: null },
  toasts: [],
  prefs: { side: "buy" as const, orderType: "limit" as const },
  lastPrice: 0,
  openOrders: [],
  fills: [],
};

function state() {
  return useTerminal.getState();
}

/** Minimal in-memory localStorage stand-in for round-trip tests. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

beforeEach(() => {
  useTerminal.setState({ ...DEFAULTS });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("persistence boundary", () => {
  it("persists exactly the session slice — nothing market- or chain-derived", () => {
    const opts = useTerminal.persist.getOptions();
    const persisted = opts.partialize!(useTerminal.getState()) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([
      "chartInterval",
      "guest",
      "prefs",
      "selectedMarket",
      "walletAutoConnect",
    ]);
  });

  it("round-trips the session through storage and drops everything else", async () => {
    const storage = memoryStorage();
    useTerminal.persist.setOptions({
      storage: createJSONStorage(() => storage),
    });

    useTerminal.setState({
      guest: true,
      walletAutoConnect: true,
      selectedMarket: "MKT111",
      prefs: { side: "sell", orderType: "market" },
      lastPrice: 999, // market data — must not survive
    });

    // Simulate a fresh tab: snapshot what hit disk, reset the store
    // (which also writes through), put the old snapshot back, rehydrate.
    const saved = storage.data.get("matchbook.session")!;
    useTerminal.setState({ ...DEFAULTS });
    storage.data.set("matchbook.session", saved);
    await useTerminal.persist.rehydrate();

    expect(state().guest).toBe(true);
    expect(state().walletAutoConnect).toBe(true);
    expect(state().selectedMarket).toBe("MKT111");
    expect(state().prefs).toEqual({ side: "sell", orderType: "market" });
    expect(state().lastPrice).toBe(0);
    expect(state().wallet.connected).toBe(false);
  });

  it("rehydrating empty storage still marks the store hydrated (boot gate opens)", async () => {
    useTerminal.persist.setOptions({
      storage: createJSONStorage(() => memoryStorage()),
    });
    await useTerminal.persist.rehydrate();
    expect(state().hydrated).toBe(true);
  });
});

describe("session actions", () => {
  it("connectWallet in simulator mode records the auto-connect intent", () => {
    state().connectWallet(); // no feed in tests → simulator path
    expect(state().wallet.connected).toBe(true);
    expect(state().walletAutoConnect).toBe(true);
  });

  it("disconnectWallet forgets the session", () => {
    state().connectWallet();
    state().disconnectWallet();
    expect(state().wallet.connected).toBe(false);
    expect(state().walletAutoConnect).toBe(false);
    expect(state().guest).toBe(false);
  });

  it("setPrefs merges partial updates", () => {
    state().setPrefs({ side: "sell" });
    expect(state().prefs).toEqual({ side: "sell", orderType: "limit" });
    state().setPrefs({ orderType: "market" });
    expect(state().prefs).toEqual({ side: "sell", orderType: "market" });
  });
});

describe("toasts", () => {
  it("pushes, auto-dismisses after 6s, and caps the stack at 4", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 6; i++) state().pushToast("error", `boom ${i}`);
    expect(state().toasts.length).toBe(4);
    expect(state().toasts[3].text).toBe("boom 5");

    vi.advanceTimersByTime(6_100);
    expect(state().toasts.length).toBe(0);
  });

  it("dismisses a toast by id on click", () => {
    vi.useFakeTimers();
    state().pushToast("success", "filled");
    const id = state().toasts[0].id;
    state().dismissToast(id);
    expect(state().toasts.length).toBe(0);
  });
});
