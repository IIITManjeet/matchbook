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

const card =
  "min-h-0 overflow-hidden rounded-xl border border-line bg-panel shadow-card";

export default function Terminal() {
  const startFeed = useTerminal((s) => s.startFeed);
  const connected = useTerminal((s) => s.wallet.connected);
  const guest = useTerminal((s) => s.guest);

  useEffect(() => {
    startFeed();
  }, [startFeed]);

  // Login gate: wallet or explicit guest entry. Market data starts
  // loading behind the screen either way.
  if (!connected && !guest) return <ConnectScreen />;

  return (
    <div className="h-screen overflow-x-auto bg-transparent text-ink">
      <div className="flex h-full min-w-[1180px] flex-col gap-2 p-2">
        <TopBar />
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px_300px] grid-rows-[minmax(0,1fr)_280px] gap-2">
          <section className={card}>
            <PriceChart />
          </section>
          <section className={card}>
            <OrderBook />
          </section>
          <section className={`${card} row-span-2`}>
            <OrderForm />
          </section>
          <section className={card}>
            <BottomPanel />
          </section>
          <section className={card}>
            <TradesFeed />
          </section>
        </main>
      </div>
    </div>
  );
}
