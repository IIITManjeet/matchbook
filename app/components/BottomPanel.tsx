"use client";

import { useState } from "react";
import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize, fmtTime } from "@/lib/format";

type Tab = "orders" | "balances" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "orders", label: "Open Orders" },
  { id: "balances", label: "Balances" },
  { id: "history", label: "Trade History" },
];

function Th({ children, right = true }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-faint ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="px-3 py-6 text-center text-xs text-faint">{label}</p>;
}

export default function BottomPanel() {
  const [tab, setTab] = useState<Tab>("orders");
  const openOrders = useTerminal((s) => s.openOrders);
  const balances = useTerminal((s) => s.balances);
  const fills = useTerminal((s) => s.fills);
  const cancelOrder = useTerminal((s) => s.cancelOrder);
  const wallet = useTerminal((s) => s.wallet);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-line px-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`text-xs transition-colors ${
              tab === t.id ? "font-semibold text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.id === "orders" && openOrders.length > 0 && (
              <span className="num ml-1.5 rounded bg-panel2 px-1 text-[10px] text-accent">
                {openOrders.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!wallet.connected ? (
          <Empty label="Connect a wallet to see orders and balances." />
        ) : tab === "orders" ? (
          openOrders.length === 0 ? (
            <Empty label="No open orders." />
          ) : (
            <table className="w-full">
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
                  <tr key={o.id} data-testid="open-order-row" className="border-t border-line/60 hover:bg-panel2/50">
                    <td className="px-3 py-1.5 text-xs text-ink">{o.market}</td>
                    <td className={`px-3 py-1.5 text-xs font-medium capitalize ${o.side === "buy" ? "text-up" : "text-down"}`}>
                      {o.side}
                    </td>
                    <td className="px-3 py-1.5 text-xs capitalize text-muted">{o.type}</td>
                    <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtPrice(o.price)}</td>
                    <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtSize(o.size)}</td>
                    <td className="num px-3 py-1.5 text-right text-xs text-muted">{fmtSize(o.filled)}</td>
                    <td className="px-3 py-1.5 text-xs capitalize text-muted">
                      {o.status === "pending" ? (
                        <span className="text-accent">pending…</span>
                      ) : (
                        o.status
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        data-testid="cancel-order"
                        onClick={() => cancelOrder(o.id)}
                        className="rounded border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-down/60 hover:text-down"
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
          <table className="w-full">
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
                <tr key={asset} className="border-t border-line/60 hover:bg-panel2/50">
                  <td className="px-3 py-1.5 text-xs font-medium text-ink">{asset}</td>
                  <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtSize(b.total)}</td>
                  <td className="num px-3 py-1.5 text-right text-xs text-muted">{fmtSize(b.locked)}</td>
                  <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtSize(b.total - b.locked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : fills.length === 0 ? (
          <Empty label="No trades yet — fills will appear here." />
        ) : (
          <table className="w-full">
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
                <tr key={f.id} data-testid="fill-row" className="border-t border-line/60 hover:bg-panel2/50">
                  <td className="num px-3 py-1.5 text-xs text-muted">{fmtTime(f.ts)}</td>
                  <td className="px-3 py-1.5 text-xs text-ink">{f.market}</td>
                  <td className={`px-3 py-1.5 text-xs font-medium capitalize ${f.side === "buy" ? "text-up" : "text-down"}`}>
                    {f.side}
                  </td>
                  <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtPrice(f.price)}</td>
                  <td className="num px-3 py-1.5 text-right text-xs text-ink">{fmtSize(f.size)}</td>
                  <td className="num px-3 py-1.5 text-right text-xs text-muted">{fmtPrice(f.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
