"use client";

import { useEffect } from "react";
import { useTerminal } from "@/lib/store";
import TopBar from "@/components/TopBar";
import PriceChart from "@/components/PriceChart";
import OrderBook from "@/components/OrderBook";
import TradesFeed from "@/components/TradesFeed";
import OrderForm from "@/components/OrderForm";
import BottomPanel from "@/components/BottomPanel";
import ConnectScreen from "@/components/ConnectScreen";
import Toasts from "@/components/Toasts";
import CommandPalette from "@/components/CommandPalette";

const card =
  "min-h-0 overflow-hidden rounded-xl border border-line bg-panel shadow-card";

export default function Terminal() {
  const startFeed = useTerminal((s) => s.startFeed);
  const hydrated = useTerminal((s) => s.hydrated);
  const connected = useTerminal((s) => s.wallet.connected);
  const autoConnect = useTerminal((s) => s.walletAutoConnect);
  const guest = useTerminal((s) => s.guest);

  // Boot: restore the persisted session (guest/wallet entry, last market,
  // ticket prefs) first so the feed connects to the right market, then
  // start streaming. Rehydration is a deferred effect because this page
  // is prerendered — reading localStorage during render would mismatch.
  useEffect(() => {
    void Promise.resolve(useTerminal.persist.rehydrate()).then(startFeed);
  }, [startFeed]);

  // One blank-panel frame while localStorage is read back.
  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-brand-grad text-2xl font-black text-white shadow-glow">
          M
        </div>
      </div>
    );
  }

  // Login gate: wallet, explicit guest entry, or a restored session that
  // is reconnecting its wallet. Market data loads behind the screen.
  if (!connected && !guest && !autoConnect) return <ConnectScreen />;

  // Three layouts: single-column stack (mobile, page scrolls),
  // two-column (tablet, page scrolls), full app grid (xl+, no scroll).
  return (
    <div className="min-h-screen bg-transparent text-ink xl:h-screen xl:overflow-hidden">
      <div className="flex min-h-screen flex-col gap-2 p-2 xl:h-full xl:min-h-0">
        <TopBar />
        <main className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_300px_300px] xl:grid-rows-[minmax(0,1fr)_280px]">
          <section className={`${card} h-[340px] sm:h-[420px] md:col-span-2 xl:col-span-1 xl:h-auto`}>
            <PriceChart />
          </section>
          <section className={`${card} h-[460px] md:h-[540px] xl:h-auto`}>
            <OrderBook />
          </section>
          <section className={`${card} md:h-[540px] xl:row-span-2 xl:h-auto`}>
            <OrderForm />
          </section>
          <section className={`${card} h-[320px] md:col-span-2 xl:col-span-1 xl:h-auto`}>
            <BottomPanel />
          </section>
          <section className={`${card} h-[320px] md:col-span-2 xl:col-span-1 xl:h-auto`}>
            <TradesFeed />
          </section>
        </main>
      </div>
      <Toasts />
      <CommandPalette />
    </div>
  );
}
