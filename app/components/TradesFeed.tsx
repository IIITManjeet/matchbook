"use client";

import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize, fmtTime } from "@/lib/format";

const ROWS = 30;

export default function TradesFeed() {
  const trades = useTerminal((s) => s.trades);
  const market = useTerminal((s) => s.market);
  const quotePrice = useTerminal((s) => s.quotePrice);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <span className="text-xs font-semibold text-ink">Recent Trades</span>
      </div>

      <div className="grid grid-cols-3 px-3 py-1.5 text-right text-[10px] uppercase tracking-wider text-faint">
        <span className="text-left">Price ({market.quote})</span>
        <span>Size ({market.base})</span>
        <span>Time</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {trades.slice(0, ROWS).map((t) => (
          <button
            key={t.id}
            onClick={() => quotePrice(t.price)}
            className={`grid w-full grid-cols-3 px-3 py-[3px] text-right hover:bg-panel2 ${
              t.side === "buy" ? "flash-up" : "flash-down"
            }`}
          >
            <span className={`num text-left text-xs ${t.side === "buy" ? "text-up" : "text-down"}`}>
              {fmtPrice(t.price)}
            </span>
            <span className="num text-xs text-ink">{fmtSize(t.size)}</span>
            <span className="num text-xs text-muted">{fmtTime(t.ts)}</span>
          </button>
        ))}
        {trades.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-faint">Waiting for trades…</p>
        )}
      </div>
    </div>
  );
}
