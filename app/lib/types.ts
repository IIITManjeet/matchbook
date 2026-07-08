export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface BookLevel {
  price: number;
  size: number;
  /** cumulative size from the top of this side of the book */
  total: number;
}

export interface Trade {
  id: number;
  price: number;
  size: number;
  side: Side;
  ts: number;
}

export interface Candle {
  /** unix seconds, aligned to the candle interval */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketStats {
  change24h: number;
  high24h: number;
  low24h: number;
  volumeBase: number;
  volumeQuote: number;
}

export interface MarketInfo {
  symbol: string;
  base: string;
  quote: string;
  tickSize: number;
  minSize: number;
  priceDecimals: number;
  sizeDecimals: number;
}

export type OrderStatus = "pending" | "open" | "filled" | "canceled";

export interface OpenOrder {
  id: string;
  market: string;
  side: Side;
  type: OrderType;
  price: number;
  size: number;
  filled: number;
  status: OrderStatus;
  ts: number;
}

export interface Fill {
  id: string;
  market: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  ts: number;
}

export interface Balance {
  total: number;
  locked: number;
}

export interface MarketListing {
  pubkey: string;
  kind: "spot" | "perp";
  symbol: string;
}

/** Everything the positions panel shows, in UI units (SOL / USDC). */
export interface PerpPosition {
  /** signed; + long, − short */
  size: number;
  entryPrice: number;
  markPrice: number;
  notional: number;
  uPnl: number;
  uPnlPct: number;
  /** null when the position can't be liquidated at any price */
  liqPrice: number | null;
  /** unsettled funding; positive = this account pays */
  pendingFunding: number;
  collateral: number;
  equity: number;
  freeCollateral: number;
  leverage: number;
}

export interface FeedSnapshot {
  bids: BookLevel[];
  asks: BookLevel[];
  trades: Trade[];
  candles: Candle[];
  lastPrice: number;
  lastSide: Side;
  stats: MarketStats;
}
