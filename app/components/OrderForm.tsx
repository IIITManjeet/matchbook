"use client";

import { useEffect, useState } from "react";
import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize } from "@/lib/format";
import type { OrderType, Side } from "@/lib/types";

const PCTS = [25, 50, 75, 100];

export default function OrderForm() {
  const market = useTerminal((s) => s.market);
  const lastPrice = useTerminal((s) => s.lastPrice);
  const balances = useTerminal((s) => s.balances);
  const wallet = useTerminal((s) => s.wallet);
  const connectWallet = useTerminal((s) => s.connectWallet);
  const placeOrder = useTerminal((s) => s.placeOrder);
  const quotedPrice = useTerminal((s) => s.quotedPrice);
  const clearQuotedPrice = useTerminal((s) => s.clearQuotedPrice);

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");

  // clicking a price in the book or tape loads it into the form
  useEffect(() => {
    if (quotedPrice !== null) {
      setType("limit");
      setPrice(quotedPrice.toFixed(market.priceDecimals));
      clearQuotedPrice();
    }
  }, [quotedPrice, market.priceDecimals, clearQuotedPrice]);

  const priceNum = type === "market" ? lastPrice : parseFloat(price) || 0;
  const sizeNum = parseFloat(size) || 0;
  const total = priceNum * sizeNum;

  const quoteBal = balances[market.quote];
  const baseBal = balances[market.base];
  const available =
    side === "buy" ? quoteBal.total - quoteBal.locked : baseBal.total - baseBal.locked;
  const availableAsset = side === "buy" ? market.quote : market.base;

  const overBalance =
    side === "buy" ? total > available + 1e-9 : sizeNum > available + 1e-9;
  const valid = sizeNum >= market.minSize && priceNum > 0 && !overBalance;

  const applyPct = (pct: number) => {
    if (!priceNum) return;
    const max = side === "buy" ? available / priceNum : available;
    setSize(((max * pct) / 100).toFixed(market.sizeDecimals));
  };

  const submit = () => {
    if (!valid) return;
    placeOrder(side, type, priceNum, sizeNum);
    setSize("");
  };

  const sideBtn = (s: Side, label: string) => (
    <button
      key={s}
      data-testid={`side-${s}`}
      onClick={() => setSide(s)}
      className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-colors ${
        side === s
          ? s === "buy"
            ? "bg-up text-white"
            : "bg-down text-white"
          : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex rounded-md bg-panel2 p-0.5">
        {sideBtn("buy", "Buy")}
        {sideBtn("sell", "Sell")}
      </div>

      <div className="flex gap-4 text-xs">
        {(["limit", "market"] as OrderType[]).map((t) => (
          <button
            key={t}
            data-testid={`type-${t}`}
            onClick={() => setType(t)}
            className={`border-b-2 pb-1 capitalize transition-colors ${
              type === t ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">Price ({market.quote})</span>
        <input
          data-testid="input-price"
          type="number"
          inputMode="decimal"
          step={market.tickSize}
          min={0}
          value={type === "market" ? "" : price}
          placeholder={type === "market" ? `≈ ${fmtPrice(lastPrice)} (market)` : fmtPrice(lastPrice)}
          disabled={type === "market"}
          onChange={(e) => setPrice(e.target.value)}
          className="num rounded-md border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent disabled:opacity-60"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">Size ({market.base})</span>
        <input
          data-testid="input-size"
          type="number"
          inputMode="decimal"
          step={market.minSize}
          min={0}
          value={size}
          placeholder="0.00"
          onChange={(e) => setSize(e.target.value)}
          className="num rounded-md border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
        />
      </label>

      <div className="flex gap-1">
        {PCTS.map((p) => (
          <button
            key={p}
            onClick={() => applyPct(p)}
            className="flex-1 rounded border border-line py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-ink"
          >
            {p}%
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-panel2/60 p-2.5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-muted">Available</span>
          <span className="num text-ink">
            {fmtSize(available)} {availableAsset}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Order total</span>
          <span className="num text-ink">
            {fmtPrice(total)} {market.quote}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Taker fee (4 bps)</span>
          <span className="num text-muted">{fmtPrice(total * 0.0004)} {market.quote}</span>
        </div>
      </div>

      {overBalance && sizeNum > 0 && (
        <p className="text-[11px] text-down">Insufficient {availableAsset} balance.</p>
      )}

      {wallet.connected ? (
        <button
          data-testid="submit-order"
          onClick={submit}
          disabled={!valid}
          className={`rounded-md py-2.5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
            side === "buy" ? "bg-up hover:opacity-90" : "bg-down hover:opacity-90"
          }`}
        >
          {side === "buy" ? "Buy" : "Sell"} {market.base}
        </button>
      ) : (
        <button
          onClick={connectWallet}
          className="rounded-md bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Connect Wallet to Trade
        </button>
      )}

      <p className="mt-auto text-center text-[10px] leading-relaxed text-faint">
        Orders are simulated locally against the feed.
        <br />
        On-chain placement lands with wallet signing.
      </p>
    </div>
  );
}
