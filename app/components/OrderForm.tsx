"use client";

import { useEffect, useState } from "react";
import { useTerminal } from "@/lib/store";
import { fmtPrice, fmtSize } from "@/lib/format";
import type { OrderType, Side } from "@/lib/types";

const PCTS = [25, 50, 75, 100];

const inputCls =
  "num w-full rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none transition-all placeholder:text-faint focus:border-accent focus:shadow-glow disabled:opacity-60";

function InfoRow({
  label,
  children,
  muted = false,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={`num ${muted ? "text-muted" : "text-ink"}`}>{children}</span>
    </div>
  );
}

export default function OrderForm() {
  const market = useTerminal((s) => s.market);
  const lastPrice = useTerminal((s) => s.lastPrice);
  const balances = useTerminal((s) => s.balances);
  const wallet = useTerminal((s) => s.wallet);
  const tradingLive = useTerminal((s) => s.tradingLive);
  const connectWallet = useTerminal((s) => s.connectWallet);
  const placeOrder = useTerminal((s) => s.placeOrder);
  const openPerpPosition = useTerminal((s) => s.openPerpPosition);
  const position = useTerminal((s) => s.position);
  const quotedPrice = useTerminal((s) => s.quotedPrice);
  const clearQuotedPrice = useTerminal((s) => s.clearQuotedPrice);

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");

  const isPerp = market.symbol.endsWith("PERP");

  // clicking a price in the book or tape loads it into the form
  useEffect(() => {
    if (quotedPrice !== null) {
      setType("limit");
      setPrice(quotedPrice.toFixed(market.priceDecimals));
      clearQuotedPrice();
    }
  }, [quotedPrice, market.priceDecimals, clearQuotedPrice]);

  const priceNum = type === "market" || isPerp ? lastPrice : parseFloat(price) || 0;
  const sizeNum = parseFloat(size) || 0;
  const total = priceNum * sizeNum;

  // ── validity ─────────────────────────────────────────────────────────
  const quoteBal = balances[market.quote] ?? { total: 0, locked: 0 };
  const baseBal = balances[market.base] ?? { total: 0, locked: 0 };

  // perp: margin math (10x max leverage on-chain)
  const marginRequired = total * 0.1;
  const freeCollateral = position ? position.freeCollateral : 0;

  const available = isPerp
    ? freeCollateral
    : side === "buy"
      ? quoteBal.total - quoteBal.locked
      : baseBal.total - baseBal.locked;
  const availableAsset = isPerp ? market.quote : side === "buy" ? market.quote : market.base;

  const overBalance = isPerp
    ? marginRequired > freeCollateral + 1e-9
    : side === "buy"
      ? total > available + 1e-9
      : sizeNum > available + 1e-9;
  const valid =
    sizeNum >= market.minSize && priceNum > 0 && !overBalance && (!isPerp || tradingLive);

  const applyPct = (pct: number) => {
    if (!priceNum) return;
    const max = isPerp
      ? (freeCollateral * 10) / priceNum // full 10x
      : side === "buy"
        ? available / priceNum
        : available;
    setSize(((max * pct) / 100).toFixed(market.sizeDecimals));
  };

  const submit = () => {
    if (!valid) return;
    if (isPerp) openPerpPosition(side, sizeNum);
    else placeOrder(side, type, priceNum, sizeNum);
    setSize("");
  };

  const sideBtn = (s: Side, label: string) => (
    <button
      key={s}
      data-testid={`side-${s}`}
      onClick={() => setSide(s)}
      className={`flex-1 rounded-lg py-2 text-xs font-bold uppercase tracking-wide transition-all ${
        side === s
          ? s === "buy"
            ? "bg-up-grad text-white shadow-glow-up"
            : "bg-down-grad text-white shadow-glow-down"
          : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-3.5">
      <div className="flex gap-1 rounded-xl border border-line bg-panel2 p-1">
        {sideBtn("buy", isPerp ? "Long" : "Buy")}
        {sideBtn("sell", isPerp ? "Short" : "Sell")}
      </div>

      {isPerp ? (
        <div className="flex items-center justify-between rounded-lg border border-line bg-panel2/60 px-3 py-2 text-xs">
          <span className="text-muted">Fills at oracle price</span>
          <span className="num text-ink">{fmtPrice(lastPrice)}</span>
        </div>
      ) : (
        <div className="flex gap-4 text-xs">
          {(["limit", "market"] as OrderType[]).map((t) => (
            <button
              key={t}
              data-testid={`type-${t}`}
              onClick={() => setType(t)}
              className={`border-b-2 pb-1 capitalize transition-colors ${
                type === t
                  ? "border-accent font-semibold text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {!isPerp && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Price ({market.quote})</span>
          <input
            data-testid="input-price"
            type="number"
            inputMode="decimal"
            step={market.tickSize}
            min={0}
            value={type === "market" ? "" : price}
            placeholder={
              type === "market" ? `≈ ${fmtPrice(lastPrice)} (market)` : fmtPrice(lastPrice)
            }
            disabled={type === "market"}
            onChange={(e) => setPrice(e.target.value)}
            className={inputCls}
          />
        </label>
      )}

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
          className={inputCls}
        />
      </label>

      <div className="flex gap-1">
        {PCTS.map((p) => (
          <button
            key={p}
            onClick={() => applyPct(p)}
            className="flex-1 rounded-lg border border-line py-1 text-[11px] text-muted transition-all hover:border-accent hover:text-ink"
          >
            {p}%
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel2/60 p-3 text-[11px]">
        {isPerp ? (
          <>
            <InfoRow label="Notional">{fmtPrice(total)} {market.quote}</InfoRow>
            <InfoRow label="Margin required (10x)">{fmtPrice(marginRequired)} {market.quote}</InfoRow>
            <InfoRow label="Free collateral">{fmtPrice(freeCollateral)} {market.quote}</InfoRow>
            <InfoRow label="Slippage guard" muted>1%</InfoRow>
            <InfoRow label="Taker fee (10 bps)" muted>{fmtPrice(total * 0.001)} {market.quote}</InfoRow>
          </>
        ) : (
          <>
            <InfoRow label="Available">{fmtSize(available)} {availableAsset}</InfoRow>
            <InfoRow label="Order total">{fmtPrice(total)} {market.quote}</InfoRow>
            <InfoRow label="Taker fee (4 bps)" muted>{fmtPrice(total * 0.0004)} {market.quote}</InfoRow>
          </>
        )}
      </div>

      {overBalance && sizeNum > 0 && (
        <p className="text-[11px] text-down">
          {isPerp ? "Not enough free collateral." : `Insufficient ${availableAsset} balance.`}
        </p>
      )}
      {isPerp && wallet.connected && !tradingLive && (
        <p className="text-[11px] text-down">Perps need the validator + keeper running.</p>
      )}

      {wallet.connected ? (
        <button
          data-testid="submit-order"
          onClick={submit}
          disabled={!valid}
          className={`rounded-xl py-2.5 text-sm font-bold text-white transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            side === "buy"
              ? "bg-up-grad hover:shadow-glow-up"
              : "bg-down-grad hover:shadow-glow-down"
          }`}
        >
          {isPerp
            ? `${side === "buy" ? "Long" : "Short"} ${market.base}`
            : `${side === "buy" ? "Buy" : "Sell"} ${market.base}`}
        </button>
      ) : (
        <button
          onClick={connectWallet}
          className="rounded-xl bg-brand-grad py-2.5 text-sm font-bold text-white transition-all hover:shadow-glow"
        >
          Connect Wallet to Trade
        </button>
      )}

      <p className="mt-auto text-center text-[10px] leading-relaxed text-faint">
        {tradingLive ? (
          <>
            Orders are signed and placed on-chain.
            <br />
            Localnet burner wallet — funded by the seeders.
          </>
        ) : (
          <>
            Orders are simulated locally against the feed.
            <br />
            Connect with the indexer up for on-chain placement.
          </>
        )}
      </p>
    </div>
  );
}
