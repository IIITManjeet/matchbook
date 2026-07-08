"use client";

import { useTerminal } from "@/lib/store";
import { fmtCompact, fmtPct, fmtPrice, shortAddress } from "@/lib/format";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hidden flex-col gap-0.5 lg:flex">
      <span className="text-[11px] leading-none text-faint">{label}</span>
      <span className="num text-xs leading-none text-ink">{children}</span>
    </div>
  );
}

export default function TopBar() {
  const market = useTerminal((s) => s.market);
  const lastPrice = useTerminal((s) => s.lastPrice);
  const lastSide = useTerminal((s) => s.lastSide);
  const stats = useTerminal((s) => s.stats);
  const feedLive = useTerminal((s) => s.feedLive);
  const feedSource = useTerminal((s) => s.feedSource);
  const wallet = useTerminal((s) => s.wallet);
  const connectWallet = useTerminal((s) => s.connectWallet);
  const disconnectWallet = useTerminal((s) => s.disconnectWallet);

  const changeColor = stats.change24h >= 0 ? "text-up" : "text-down";

  return (
    <header className="flex h-14 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-accent/15 text-xs font-bold text-accent">
          M
        </div>
        <span className="text-sm font-semibold tracking-wide">MATCHBOOK</span>
        <span className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
          devnet
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-md bg-panel2 px-3 py-1.5">
        <span className="text-sm font-semibold">{market.symbol}</span>
        <span className="text-[10px] uppercase tracking-wider text-faint">spot</span>
      </div>

      <div className={`num text-lg font-semibold leading-none ${lastSide === "buy" ? "text-up" : "text-down"}`}>
        {lastPrice ? fmtPrice(lastPrice) : "—"}
      </div>

      <div className="flex items-center gap-6">
        <Stat label="24h Change">
          <span className={changeColor}>{fmtPct(stats.change24h)}</span>
        </Stat>
        <Stat label="24h High">{fmtPrice(stats.high24h)}</Stat>
        <Stat label="24h Low">{fmtPrice(stats.low24h)}</Stat>
        <Stat label={`24h Volume (${market.base})`}>{fmtCompact(stats.volumeBase)}</Stat>
        <Stat label={`24h Volume (${market.quote})`}>{fmtCompact(stats.volumeQuote)}</Stat>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !feedLive ? "bg-faint" : feedSource === "indexer" ? "bg-up" : "bg-accent"
            }`}
          />
          {!feedLive ? "connecting" : feedSource === "indexer" ? "live" : "mock feed"}
        </span>
        {wallet.connected && wallet.address ? (
          <button
            data-testid="wallet-address"
            onClick={disconnectWallet}
            className="num rounded-md border border-line bg-panel2 px-3 py-1.5 text-xs text-ink transition-colors hover:border-down/60 hover:text-down"
            title="Disconnect"
          >
            {shortAddress(wallet.address)}
          </button>
        ) : (
          <button
            data-testid="connect-wallet"
            onClick={connectWallet}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </header>
  );
}
