"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTerminal } from "@/lib/store";

interface Action {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

const INTERVAL_LABELS: Record<number, string> = {
  60: "1m",
  300: "5m",
  900: "15m",
  3600: "1h",
  14400: "4h",
  86400: "1d",
};

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * ⌘K / Ctrl+K command palette plus single-key ticket hotkeys (B/S side,
 * M order type — ignored while typing in an input). Keyboard-first, per
 * the terminal design spec.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const markets = useTerminal((s) => s.markets);
  const selectedMarket = useTerminal((s) => s.selectedMarket);
  const feedSource = useTerminal((s) => s.feedSource);
  const walletConnected = useTerminal((s) => s.wallet.connected);

  const actions = useMemo<Action[]>(() => {
    const st = useTerminal.getState;
    const list: Action[] = [];
    for (const m of markets) {
      if (m.pubkey === selectedMarket) continue;
      list.push({
        id: `market-${m.pubkey}`,
        label: `Switch market → ${m.symbol}`,
        hint: m.kind,
        run: () => st().switchMarket(m.pubkey),
      });
    }
    list.push(
      {
        id: "side-buy",
        label: "Ticket: buy / long",
        hint: "B",
        run: () => st().setPrefs({ side: "buy" }),
      },
      {
        id: "side-sell",
        label: "Ticket: sell / short",
        hint: "S",
        run: () => st().setPrefs({ side: "sell" }),
      },
      {
        id: "type-toggle",
        label: "Ticket: toggle limit / market",
        hint: "M",
        run: () =>
          st().setPrefs({ orderType: st().prefs.orderType === "limit" ? "market" : "limit" }),
      },
    );
    if (feedSource === "indexer") {
      for (const [secs, label] of Object.entries(INTERVAL_LABELS)) {
        list.push({
          id: `interval-${label}`,
          label: `Chart interval → ${label}`,
          hint: "chart",
          run: () => st().setChartInterval(Number(secs)),
        });
      }
    }
    list.push(
      walletConnected
        ? { id: "wallet", label: "Disconnect wallet", hint: "session", run: () => st().disconnectWallet() }
        : { id: "wallet", label: "Connect wallet", hint: "session", run: () => st().connectWallet() },
    );
    return list;
  }, [markets, selectedMarket, feedSource, walletConnected]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      // single-key ticket hotkeys
      const st = useTerminal.getState;
      if (e.key === "b" || e.key === "B") st().setPrefs({ side: "buy" });
      else if (e.key === "s" || e.key === "S") st().setPrefs({ side: "sell" });
      else if (e.key === "m" || e.key === "M")
        st().setPrefs({ orderType: st().prefs.orderType === "limit" ? "market" : "limit" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const pick = (a: Action) => {
    a.run();
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
      onClick={close}
      data-testid="command-palette"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-line bg-panel shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          value={query}
          placeholder="Type a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter" && matches[cursor]) pick(matches[cursor]);
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-faint"
        />
        <div className="max-h-72 overflow-y-auto py-1">
          {matches.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted">No matching commands.</p>
          )}
          {matches.map((a, i) => (
            <button
              key={a.id}
              onClick={() => pick(a)}
              onMouseEnter={() => setCursor(i)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-xs ${
                i === cursor ? "bg-panel2 text-ink" : "text-muted"
              }`}
            >
              <span>{a.label}</span>
              <span className="rounded bg-panel3 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-faint">
                {a.hint}
              </span>
            </button>
          ))}
        </div>
        <p className="border-t border-line px-4 py-2 text-[10px] text-faint">
          ↑↓ navigate · Enter run · Esc close — hotkeys: B buy · S sell · M limit/market
        </p>
      </div>
    </div>
  );
}
