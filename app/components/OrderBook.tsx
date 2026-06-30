"use client";

import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize } from "@/lib/format";
import type { BookLevel, Side } from "@/lib/types";

const ROWS = 11;

function BookRow({
  level,
  side,
  maxTotal,
  onClick,
}: {
  level: BookLevel;
  side: Side;
  maxTotal: number;
  onClick: () => void;
}) {
  const depthPct = Math.min(100, (level.total / maxTotal) * 100);
  const barColor = side === "buy" ? "rgba(38,166,154,0.10)" : "rgba(239,83,80,0.10)";
  return (
    <button
      onClick={onClick}
      className="relative grid w-full grid-cols-3 px-3 py-[3px] text-right hover:bg-panel2"
      title={`Set limit price ${fmtPrice(level.price)}`}
    >
      <span
        className="absolute inset-y-0 right-0"
        style={{ width: `${depthPct}%`, background: barColor }}
      />
      <span className={`num relative z-10 text-left text-xs ${side === "buy" ? "text-up" : "text-down"}`}>
        {fmtPrice(level.price)}
      </span>
      <span className="num relative z-10 text-xs text-ink">{fmtSize(level.size)}</span>
      <span className="num relative z-10 text-xs text-muted">{fmtSize(level.total)}</span>
    </button>
  );
}

export default function OrderBook() {
  const bids = useTerminal((s) => s.bids);
  const asks = useTerminal((s) => s.asks);
  const lastPrice = useTerminal((s) => s.lastPrice);
  const lastSide = useTerminal((s) => s.lastSide);
  const market = useTerminal((s) => s.market);
  const quotePrice = useTerminal((s) => s.quotePrice);

  const askRows = asks.slice(0, ROWS);
  const bidRows = bids.slice(0, ROWS);
  const maxTotal = Math.max(
    askRows[askRows.length - 1]?.total ?? 0,
    bidRows[bidRows.length - 1]?.total ?? 0,
    1,
  );

  const bestBid = bidRows[0]?.price ?? 0;
  const bestAsk = askRows[0]?.price ?? 0;
  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const spreadPct = bestAsk ? (spread / bestAsk) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <span className="text-xs font-semibold text-ink">Order Book</span>
        <span className="num ml-auto text-[10px] text-faint">
          spread {fmtPrice(spread)} ({spreadPct.toFixed(3)}%)
        </span>
      </div>

      <div className="grid grid-cols-3 px-3 py-1.5 text-right text-[10px] uppercase tracking-wider text-faint">
        <span className="text-left">Price ({market.quote})</span>
        <span>Size ({market.base})</span>
        <span>Total</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        {[...askRows].reverse().map((l) => (
          <BookRow key={`a-${l.price}`} level={l} side="sell" maxTotal={maxTotal} onClick={() => quotePrice(l.price)} />
        ))}
      </div>

      <div className="flex items-center justify-between border-y border-line bg-panel2/60 px-3 py-1.5">
        <span className={`num text-sm font-semibold ${lastSide === "buy" ? "text-up" : "text-down"}`}>
          {lastPrice ? fmtPrice(lastPrice) : "—"}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-faint">last</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-1">
        {bidRows.map((l) => (
          <BookRow key={`b-${l.price}`} level={l} side="buy" maxTotal={maxTotal} onClick={() => quotePrice(l.price)} />
        ))}
      </div>
    </div>
  );
}
