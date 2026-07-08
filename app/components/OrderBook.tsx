"use client";

import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize, shortAddress } from "@/lib/format";
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
  const barColor = side === "buy" ? "rgba(46,189,133,0.14)" : "rgba(246,70,93,0.14)";
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
  const fundingBps = useTerminal((s) => s.fundingBps);
  const position = useTerminal((s) => s.position);
  const perpAdmin = useTerminal((s) => s.perpAdmin);
  const role = useTerminal((s) => s.role);

  // Perps have no resting book — fills execute against the oracle.
  if (market.symbol.endsWith("PERP")) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
          <span className="text-xs font-semibold text-ink">Oracle Market</span>
          <span className="ml-auto rounded bg-accent2/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent2">
            perp
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-faint">Mark price</span>
            <span
              className={`num text-3xl font-bold ${lastSide === "buy" ? "text-up" : "text-down"}`}
            >
              {lastPrice ? fmtPrice(lastPrice) : "—"}
            </span>
          </div>
          <div className="grid w-full grid-cols-2 gap-2">
            <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-panel2/60 p-3">
              <span className="text-[10px] uppercase tracking-wider text-faint">Funding / day</span>
              <span
                className={`num text-sm font-semibold ${
                  (fundingBps ?? 0) >= 0 ? "text-up" : "text-down"
                }`}
              >
                {fundingBps !== null ? `${(fundingBps / 100).toFixed(2)}%` : "—"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-panel2/60 p-3">
              <span className="text-[10px] uppercase tracking-wider text-faint">Max leverage</span>
              <span className="num text-sm font-semibold text-ink">10x</span>
            </div>
          </div>
          {position && position.size !== 0 && (
            <div className="w-full rounded-xl border border-line bg-panel2/60 p-3 text-center">
              <span className="text-[10px] uppercase tracking-wider text-faint">Your exposure</span>
              <p
                className={`num mt-1 text-sm font-semibold ${
                  position.size > 0 ? "text-up" : "text-down"
                }`}
              >
                {position.size > 0 ? "+" : ""}
                {fmtSize(position.size)} SOL
              </p>
            </div>
          )}
          {perpAdmin && (
            <div className="flex w-full items-center justify-between rounded-xl border border-line bg-panel2/60 px-3 py-2">
              <span className="text-[10px] uppercase tracking-wider text-faint">Operator</span>
              <span className="num text-[11px] text-muted">
                {shortAddress(perpAdmin)}
                {role === "operator" && (
                  <span className="ml-1.5 rounded bg-accent2/20 px-1 text-[9px] font-bold uppercase text-accent2">
                    you
                  </span>
                )}
              </span>
            </div>
          )}
          <p className="text-center text-[10px] leading-relaxed text-faint">
            Orders fill at the keeper-pushed oracle price.
            <br />
            Skew between longs and shorts sets the funding rate.
          </p>
        </div>
      </div>
    );
  }

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
      <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
        <span className="text-xs font-semibold text-ink">Order Book</span>
        <span className="num ml-auto rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
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
