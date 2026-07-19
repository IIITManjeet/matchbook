"use client";

import { useTerminal } from "@/lib/store";

const FEATURES = [
  {
    title: "On-chain orderbook",
    body: "A real central limit order book on Solana — bids and asks rest on-chain, fills settle through a permissionless crank.",
    icon: "≡",
    tint: "text-accent bg-accent/15",
  },
  {
    title: "Perpetual futures",
    body: "SOL-PERP margined in USDC: oracle-priced fills, skew-driven funding, and on-chain liquidations at 10x max leverage.",
    icon: "∞",
    tint: "text-accent2 bg-accent2/15",
  },
  {
    title: "Live indexed data",
    body: "Charts, trades and the book stream from an indexer that watches program events — what you see is what the chain did.",
    icon: "◉",
    tint: "text-up bg-up/15",
  },
];

export default function ConnectScreen() {
  const feedLive = useTerminal((s) => s.feedLive);
  const feedSource = useTerminal((s) => s.feedSource);
  const connectWallet = useTerminal((s) => s.connectWallet);
  const enterAsGuest = useTerminal((s) => s.enterAsGuest);
  // Store-tracked so the button recovers if the connection fails.
  const connecting = useTerminal((s) => s.walletConnecting);

  return (
    <div className="flex min-h-screen items-center justify-center overflow-y-auto p-4 sm:p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-line bg-panel p-6 shadow-card sm:p-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-grad text-2xl font-black text-white shadow-glow">
            M
          </div>
          <h1 className="text-brand text-2xl font-bold tracking-wide">MATCHBOOK</h1>
          <p className="max-w-md text-sm leading-relaxed text-muted">
            A spot exchange and perpetuals venue built end-to-end on Solana —
            program, indexer and terminal. Connect to trade, or look around
            first.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="flex flex-col gap-2 rounded-xl border border-line bg-panel2/60 p-4"
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-base font-bold ${f.tint}`}
              >
                {f.icon}
              </span>
              <span className="text-xs font-semibold text-ink">{f.title}</span>
              <span className="text-[11px] leading-relaxed text-muted">{f.body}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            data-testid="connect-wallet"
            onClick={connectWallet}
            disabled={connecting}
            className="w-full max-w-72 rounded-xl bg-brand-grad py-3 text-sm font-bold text-white transition-all hover:shadow-glow disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
          <button
            data-testid="enter-guest"
            onClick={enterAsGuest}
            className="w-full max-w-72 rounded-xl border border-line py-3 text-sm font-semibold text-muted transition-all hover:border-accent hover:text-ink"
          >
            Explore as guest
          </button>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                !feedLive ? "bg-faint" : feedSource === "indexer" ? "bg-up" : "bg-accent"
              }`}
            />
            {!feedLive
              ? "connecting to market data…"
              : feedSource === "indexer"
                ? "live on-chain data"
                : "simulator mode (indexer offline)"}
            {" · localnet burner wallet, no funds at risk"}
          </p>
        </div>
      </div>
    </div>
  );
}
