"use client";

import { useTerminal } from "@/lib/store";
import { fmtCompact, fmtPct, fmtPrice, shortAddress } from "@/lib/format";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="num text-xs font-medium text-ink">{children}</span>
    </div>
  );
}

export default function TopBar() {
  const market = useTerminal((s) => s.market);
  const markets = useTerminal((s) => s.markets);
  const selectedMarket = useTerminal((s) => s.selectedMarket);
  const switchMarket = useTerminal((s) => s.switchMarket);
  const lastPrice = useTerminal((s) => s.lastPrice);
  const lastSide = useTerminal((s) => s.lastSide);
  const stats = useTerminal((s) => s.stats);
  const feedLive = useTerminal((s) => s.feedLive);
  const feedSource = useTerminal((s) => s.feedSource);
  const fundingBps = useTerminal((s) => s.fundingBps);
  const wallet = useTerminal((s) => s.wallet);
  const role = useTerminal((s) => s.role);
  const connectWallet = useTerminal((s) => s.connectWallet);
  const disconnectWallet = useTerminal((s) => s.disconnectWallet);

  const changeColor = stats.change24h >= 0 ? "text-up" : "text-down";
  const isPerp = market.symbol.endsWith("PERP");

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel px-4 py-2 shadow-card xl:h-14 xl:flex-nowrap xl:py-0">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-grad text-xs font-black text-white shadow-glow">
          M
        </div>
        <span className="text-brand text-sm font-bold tracking-wide">MATCHBOOK</span>
        <span className="hidden rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted sm:inline">
          devnet
        </span>
      </div>

      {/* market switcher */}
      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-line bg-panel2 p-1">
        {(markets.length > 0
          ? markets
          : [{ pubkey: "sim", kind: "spot" as const, symbol: market.symbol }]
        ).map((m) => {
          const active =
            m.pubkey === selectedMarket || (markets.length === 0 && m.pubkey === "sim");
          return (
            <button
              key={m.pubkey}
              data-testid={`market-${m.symbol}`}
              onClick={() => m.pubkey !== "sim" && switchMarket(m.pubkey)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${
                active ? "bg-panel3 text-ink shadow-card" : "text-muted hover:text-ink"
              }`}
            >
              {m.symbol}
              <span
                className={`rounded px-1 text-[9px] font-bold uppercase tracking-wider ${
                  m.kind === "perp" ? "bg-accent2/20 text-accent2" : "bg-accent/20 text-accent"
                }`}
              >
                {m.kind}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <span
          className={`num text-lg font-semibold leading-none ${
            lastSide === "buy" ? "text-up" : "text-down"
          }`}
        >
          {lastPrice ? fmtPrice(lastPrice) : "—"}
        </span>
        {/* compact 24h change for widths where the stat strip is hidden */}
        <span className={`num text-xs lg:hidden ${changeColor}`}>{fmtPct(stats.change24h)}</span>
      </div>

      <div className="hidden items-center gap-5 lg:flex">
        <Stat label="24h Change">
          <span className={changeColor}>{fmtPct(stats.change24h)}</span>
        </Stat>
        <Stat label="24h High">{fmtPrice(stats.high24h)}</Stat>
        <Stat label="24h Low">{fmtPrice(stats.low24h)}</Stat>
        <div className="hidden items-center gap-5 min-[1350px]:flex">
          <Stat label={`24h Vol (${market.base})`}>{fmtCompact(stats.volumeBase)}</Stat>
          <Stat label={`24h Vol (${market.quote})`}>{fmtCompact(stats.volumeQuote)}</Stat>
        </div>
        {isPerp && fundingBps !== null && (
          <Stat label="Funding / day">
            <span className={fundingBps >= 0 ? "text-up" : "text-down"}>
              {(fundingBps / 100).toFixed(2)}%
            </span>
          </Stat>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 rounded-full border border-line bg-panel2 px-2.5 py-1 text-[11px] text-muted sm:flex">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !feedLive ? "bg-faint" : feedSource === "indexer" ? "bg-up shadow-glow-up" : "bg-accent"
            }`}
          />
          {!feedLive ? "connecting" : feedSource === "indexer" ? "live" : "mock feed"}
        </span>
        {wallet.connected && wallet.address ? (
          <div className="flex items-center gap-2">
            <span
              data-testid="role-badge"
              title="Role derived from on-chain state: the perp market's admin is the operator"
              className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${
                role === "operator"
                  ? "bg-accent2/20 text-accent2"
                  : role === "trader"
                    ? "bg-accent/15 text-accent"
                    : "bg-panel2 text-muted"
              }`}
            >
              {role}
            </span>
            <button
              data-testid="wallet-address"
              onClick={disconnectWallet}
              className="num rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs text-ink transition-all hover:border-down/60 hover:text-down"
              title="Disconnect"
            >
              {shortAddress(wallet.address)}
            </button>
          </div>
        ) : (
          <button
            data-testid="connect-wallet"
            onClick={connectWallet}
            className="rounded-lg bg-brand-grad px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:shadow-glow"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </header>
  );
}
