"use client";

import { useState } from "react";
import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize, fmtTime } from "@/lib/format";

type Tab = "orders" | "balances" | "history";

function Th({ children, right = true }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-faint ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="px-4 py-8 text-center text-xs text-faint">{label}</p>;
}

const rowCls = "border-t border-line/60 transition-colors hover:bg-panel2/50";
const cellCls = "px-4 py-2 text-xs";

export default function BottomPanel() {
  const [tab, setTab] = useState<Tab>("orders");
  const market = useTerminal((s) => s.market);
  const openOrders = useTerminal((s) => s.openOrders);
  const balances = useTerminal((s) => s.balances);
  const fills = useTerminal((s) => s.fills);
  const cancelOrder = useTerminal((s) => s.cancelOrder);
  const wallet = useTerminal((s) => s.wallet);
  const position = useTerminal((s) => s.position);
  const closePerpPosition = useTerminal((s) => s.closePerpPosition);
  const depositCollateral = useTerminal((s) => s.depositCollateral);
  const withdrawCollateral = useTerminal((s) => s.withdrawCollateral);
  const [collateralAmt, setCollateralAmt] = useState("");

  const isPerp = market.symbol.endsWith("PERP");

  const TABS: { id: Tab; label: string; badge?: number }[] = isPerp
    ? [
        { id: "orders", label: "Position", badge: position && position.size !== 0 ? 1 : 0 },
        { id: "balances", label: "Collateral" },
        { id: "history", label: "Trade History" },
      ]
    : [
        { id: "orders", label: "Open Orders", badge: openOrders.length },
        { id: "balances", label: "Balances" },
        { id: "history", label: "Trade History" },
      ];

  const amt = parseFloat(collateralAmt) || 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
              tab === t.id
                ? "bg-panel2 font-semibold text-ink shadow-card"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {(t.badge ?? 0) > 0 && (
              <span className="num ml-1.5 rounded-md bg-accent/15 px-1.5 text-[10px] text-accent">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        {!wallet.connected ? (
          <Empty
            label={
              isPerp
                ? "Connect a wallet to trade perps."
                : "Connect a wallet to see orders and balances."
            }
          />
        ) : tab === "orders" ? (
          isPerp ? (
            !position || position.size === 0 ? (
              <Empty label="No open position." />
            ) : (
              <table className="w-full min-w-[560px]">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    <Th right={false}>Market</Th>
                    <Th right={false}>Side</Th>
                    <Th>Size (SOL)</Th>
                    <Th>Entry</Th>
                    <Th>Mark</Th>
                    <Th>Unrealized PnL</Th>
                    <Th>Liq. Price</Th>
                    <Th>Funding</Th>
                    <Th>{""}</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-testid="position-row" className={rowCls}>
                    <td className={`${cellCls} font-medium text-ink`}>{market.symbol}</td>
                    <td className={cellCls}>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          position.size > 0 ? "bg-up/15 text-up" : "bg-down/15 text-down"
                        }`}
                      >
                        {position.size > 0 ? "Long" : "Short"}
                      </span>
                      <span className="num ml-2 text-[10px] text-muted">
                        {position.leverage.toFixed(1)}x
                      </span>
                    </td>
                    <td className={`num ${cellCls} text-right text-ink`}>
                      {fmtSize(Math.abs(position.size))}
                    </td>
                    <td className={`num ${cellCls} text-right text-ink`}>
                      {fmtPrice(position.entryPrice)}
                    </td>
                    <td className={`num ${cellCls} text-right text-ink`}>
                      {fmtPrice(position.markPrice)}
                    </td>
                    <td
                      className={`num ${cellCls} text-right font-semibold ${
                        position.uPnl >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {position.uPnl >= 0 ? "+" : ""}
                      {fmtPrice(position.uPnl)} ({position.uPnlPct >= 0 ? "+" : ""}
                      {position.uPnlPct.toFixed(2)}%)
                    </td>
                    <td className={`num ${cellCls} text-right text-muted`}>
                      {position.liqPrice ? fmtPrice(position.liqPrice) : "—"}
                    </td>
                    <td className={`num ${cellCls} text-right text-muted`}>
                      {position.pendingFunding >= 0 ? "-" : "+"}
                      {fmtPrice(Math.abs(position.pendingFunding))}
                    </td>
                    <td className={`${cellCls} text-right`}>
                      <button
                        data-testid="close-position"
                        onClick={closePerpPosition}
                        className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition-all hover:border-down/60 hover:text-down"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            )
          ) : openOrders.length === 0 ? (
            <Empty label="No open orders." />
          ) : (
            <table className="w-full min-w-[560px]">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th right={false}>Market</Th>
                  <Th right={false}>Side</Th>
                  <Th right={false}>Type</Th>
                  <Th>Price</Th>
                  <Th>Size</Th>
                  <Th>Filled</Th>
                  <Th right={false}>Status</Th>
                  <Th>{""}</Th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o) => (
                  <tr key={o.id} data-testid="open-order-row" className={rowCls}>
                    <td className={`${cellCls} text-ink`}>{o.market}</td>
                    <td
                      className={`${cellCls} font-medium capitalize ${
                        o.side === "buy" ? "text-up" : "text-down"
                      }`}
                    >
                      {o.side}
                    </td>
                    <td className={`${cellCls} capitalize text-muted`}>{o.type}</td>
                    <td className={`num ${cellCls} text-right text-ink`}>{fmtPrice(o.price)}</td>
                    <td className={`num ${cellCls} text-right text-ink`}>{fmtSize(o.size)}</td>
                    <td className={`num ${cellCls} text-right text-muted`}>{fmtSize(o.filled)}</td>
                    <td className={`${cellCls} capitalize text-muted`}>
                      {o.status === "pending" ? (
                        <span className="text-accent">pending…</span>
                      ) : (
                        o.status
                      )}
                    </td>
                    <td className={`${cellCls} text-right`}>
                      <button
                        data-testid="cancel-order"
                        onClick={() => cancelOrder(o.id)}
                        className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition-all hover:border-down/60 hover:text-down"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === "balances" ? (
          isPerp ? (
            <div className="flex flex-col gap-4 p-4 md:flex-row md:gap-6">
              <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-3 rounded-xl border border-line bg-panel2/50 p-4 text-xs">
                {[
                  ["Collateral", position ? fmtPrice(position.collateral) : "0.00"],
                  ["Equity", position ? fmtPrice(position.equity) : "0.00"],
                  ["Free collateral", position ? fmtPrice(position.freeCollateral) : "0.00"],
                  ["Leverage", position ? `${position.leverage.toFixed(2)}x` : "0.00x"],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
                    <span className="num text-sm font-semibold text-ink">{value} {label === "Leverage" ? "" : "USDC"}</span>
                  </div>
                ))}
              </div>
              <div className="flex w-full flex-col justify-center gap-2 md:w-64">
                <input
                  data-testid="collateral-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={collateralAmt}
                  placeholder="Amount (USDC)"
                  onChange={(e) => setCollateralAmt(e.target.value)}
                  className="num rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none transition-all placeholder:text-faint focus:border-accent"
                />
                <div className="flex gap-2">
                  <button
                    data-testid="deposit-collateral"
                    onClick={() => {
                      depositCollateral(amt);
                      setCollateralAmt("");
                    }}
                    disabled={amt <= 0}
                    className="flex-1 rounded-lg bg-brand-grad py-2 text-xs font-semibold text-white transition-all hover:shadow-glow disabled:opacity-40"
                  >
                    Deposit
                  </button>
                  <button
                    data-testid="withdraw-collateral"
                    onClick={() => {
                      withdrawCollateral(amt);
                      setCollateralAmt("");
                    }}
                    disabled={amt <= 0}
                    className="flex-1 rounded-lg border border-line py-2 text-xs font-semibold text-muted transition-all hover:border-accent hover:text-ink disabled:opacity-40"
                  >
                    Withdraw
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <table className="w-full min-w-[560px]">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th right={false}>Asset</Th>
                  <Th>Total</Th>
                  <Th>Locked</Th>
                  <Th>Available</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(balances).map(([asset, b]) => (
                  <tr key={asset} className={rowCls}>
                    <td className={`${cellCls} font-medium text-ink`}>{asset}</td>
                    <td className={`num ${cellCls} text-right text-ink`}>{fmtSize(b.total)}</td>
                    <td className={`num ${cellCls} text-right text-muted`}>{fmtSize(b.locked)}</td>
                    <td className={`num ${cellCls} text-right text-ink`}>
                      {fmtSize(b.total - b.locked)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : fills.length === 0 ? (
          <Empty label="No trades yet — fills will appear here." />
        ) : (
          <table className="w-full min-w-[560px]">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <Th right={false}>Time</Th>
                <Th right={false}>Market</Th>
                <Th right={false}>Side</Th>
                <Th>Price</Th>
                <Th>Size</Th>
                <Th>Fee</Th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} data-testid="fill-row" className={rowCls}>
                  <td className={`num ${cellCls} text-muted`}>{fmtTime(f.ts)}</td>
                  <td className={`${cellCls} text-ink`}>{f.market}</td>
                  <td
                    className={`${cellCls} font-medium capitalize ${
                      f.side === "buy" ? "text-up" : "text-down"
                    }`}
                  >
                    {f.side}
                  </td>
                  <td className={`num ${cellCls} text-right text-ink`}>{fmtPrice(f.price)}</td>
                  <td className={`num ${cellCls} text-right text-ink`}>{fmtSize(f.size)}</td>
                  <td className={`num ${cellCls} text-right text-muted`}>{fmtPrice(f.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
