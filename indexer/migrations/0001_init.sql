-- Core schema for the CLOB indexer.
--
-- Prices are in ticks, quantities in base lots, fees in quote atoms —
-- exactly as emitted on-chain. Conversion to human units is the API
-- consumer's job (it needs the market's tick_size / base_lot_size).
-- u64 on-chain values are stored as BIGINT; this project never comes
-- close to i64::MAX.

CREATE TABLE markets (
    pubkey        TEXT PRIMARY KEY,
    base_mint     TEXT NOT NULL,
    quote_mint    TEXT NOT NULL,
    tick_size     BIGINT NOT NULL,
    base_lot_size BIGINT NOT NULL,
    created_slot  BIGINT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL
);

-- Every processed transaction, for restart-safe dedupe and backfill cursor.
CREATE TABLE processed_txs (
    signature    TEXT PRIMARY KEY,
    slot         BIGINT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processed_txs_slot ON processed_txs (slot DESC);

CREATE TABLE trades (
    id             BIGSERIAL PRIMARY KEY,
    market         TEXT NOT NULL,
    maker          TEXT NOT NULL,
    taker          TEXT NOT NULL,
    maker_order_id BIGINT NOT NULL,
    taker_order_id BIGINT NOT NULL,
    -- 0 = bid, 1 = ask; side of the taker.
    taker_side     SMALLINT NOT NULL,
    price          BIGINT NOT NULL,
    qty            BIGINT NOT NULL,
    taker_fee      BIGINT NOT NULL,
    slot           BIGINT NOT NULL,
    signature      TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL
);
CREATE INDEX trades_market_ts ON trades (market, ts DESC);
CREATE INDEX trades_market_id ON trades (market, id DESC);

-- Resting orders (only orders that actually rested emit OrderPlaced).
CREATE TABLE orders (
    market    TEXT NOT NULL,
    order_id  BIGINT NOT NULL,
    owner     TEXT NOT NULL,
    side      SMALLINT NOT NULL,          -- 0 = bid, 1 = ask
    price     BIGINT NOT NULL,
    orig_qty  BIGINT NOT NULL,
    remaining BIGINT NOT NULL,
    status    TEXT NOT NULL,              -- open | filled | canceled
    placed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (market, order_id)
);
CREATE INDEX orders_market_owner ON orders (market, owner);
CREATE INDEX orders_open ON orders (market) WHERE status = 'open';

-- Deposits (+) and withdrawals (-), a plain ledger.
CREATE TABLE transfers (
    id        BIGSERIAL PRIMARY KEY,
    market    TEXT NOT NULL,
    owner     TEXT NOT NULL,
    mint      TEXT NOT NULL,
    amount    BIGINT NOT NULL,            -- negative = withdrawal
    slot      BIGINT NOT NULL,
    signature TEXT NOT NULL,
    ts        TIMESTAMPTZ NOT NULL
);
CREATE INDEX transfers_market_owner ON transfers (market, owner);

-- 1-minute candles, upserted per fill. Higher resolutions are aggregated
-- at query time — at this project's volume that is far simpler than
-- maintaining N rollup tables.
CREATE TABLE candles_1m (
    market TEXT NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,          -- start of the minute
    open   BIGINT NOT NULL,
    high   BIGINT NOT NULL,
    low    BIGINT NOT NULL,
    close  BIGINT NOT NULL,
    volume BIGINT NOT NULL,               -- base lots
    PRIMARY KEY (market, bucket)
);
