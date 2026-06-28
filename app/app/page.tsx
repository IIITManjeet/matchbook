"use client";

import { useEffect } from "react";
import { useTerminal } from "@/lib/store";
import TopBar from "@/components/TopBar";
import PriceChart from "@/components/PriceChart";
import OrderBook from "@/components/OrderBook";
import TradesFeed from "@/components/TradesFeed";
import OrderForm from "@/components/OrderForm";
import BottomPanel from "@/components/BottomPanel";

export default function Terminal() {
  const startFeed = useTerminal((s) => s.startFeed);

  useEffect(() => {
    startFeed();
  }, [startFeed]);

  return (
    <div className="h-screen overflow-x-auto bg-bg text-ink">
      <div className="flex h-full min-w-[1180px] flex-col">
        <TopBar />
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px_300px] grid-rows-[minmax(0,1fr)_280px] gap-px bg-line">
          <section className="min-h-0 bg-panel">
            <PriceChart />
          </section>
          <section className="min-h-0 bg-panel">
            <OrderBook />
          </section>
          <section className="row-span-2 min-h-0 bg-panel">
            <OrderForm />
          </section>
          <section className="min-h-0 bg-panel">
            <BottomPanel />
          </section>
          <section className="min-h-0 bg-panel">
            <TradesFeed />
          </section>
        </main>
      </div>
    </div>
  );
}
