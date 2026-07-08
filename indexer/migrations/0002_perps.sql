-- M4: perpetual futures.
--
-- Perp markets reuse the spot tables — on ingest their native units
-- (quote atoms per whole base unit; base atoms) are normalized to the
-- same tick/lot scheme as spot markets (tick_size=100, lot=1e6 with
-- SOL/USDC decimals), so /trades, /candles and the terminal's unit
-- conversion work unchanged. `kind` tells the UI which ticket to show.

ALTER TABLE markets ADD COLUMN kind TEXT NOT NULL DEFAULT 'spot';

-- Funding crank history; cum_funding is i128 on-chain, stored as text.
CREATE TABLE funding (
    id          BIGSERIAL PRIMARY KEY,
    market      TEXT NOT NULL,
    premium_bps BIGINT NOT NULL,          -- bps per day, signed
    cum_funding TEXT NOT NULL,
    ts          TIMESTAMPTZ NOT NULL
);
CREATE INDEX funding_market_ts ON funding (market, ts DESC);

CREATE TABLE liquidations (
    id          BIGSERIAL PRIMARY KEY,
    market      TEXT NOT NULL,
    owner       TEXT NOT NULL,
    liquidator  TEXT NOT NULL,
    size_closed BIGINT NOT NULL,          -- base atoms, signed
    price       BIGINT NOT NULL,          -- quote atoms per whole base unit
    penalty     BIGINT NOT NULL,
    signature   TEXT NOT NULL,
    ts          TIMESTAMPTZ NOT NULL
);
CREATE INDEX liquidations_market_ts ON liquidations (market, ts DESC);
