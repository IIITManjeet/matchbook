//! Decoding Anchor events out of transaction logs.
//!
//! Anchor `emit!` borsh-serializes the event, prefixes it with an 8-byte
//! discriminator (`sha256("event:<Name>")[..8]`), base64s the result and
//! writes it to the log as `Program data: <base64>`. Reversing that is
//! all an indexer fundamentally is.

use base64::Engine;
use borsh::BorshDeserialize;
use sha2::{Digest, Sha256};

/// A pubkey as raw bytes; rendered base58 at the edges.
#[derive(Clone, Copy, PartialEq, Eq, Hash, BorshDeserialize)]
pub struct Pubkey(pub [u8; 32]);

impl Pubkey {
    pub fn to_base58(&self) -> String {
        bs58::encode(self.0).into_string()
    }
}

impl std::fmt::Debug for Pubkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_base58())
    }
}

// ── Event structs: field-for-field mirrors of programs/clob/src/events.rs ──

#[derive(Debug, BorshDeserialize)]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub tick_size: u64,
    pub base_lot_size: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct Deposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct Withdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: u8, // 0 = bid, 1 = ask
    pub price: u64,
    pub qty: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct OrderCanceled {
    pub market: Pubkey,
    pub order_id: u64,
    // Unused today, but the struct must mirror the on-chain layout
    // field-for-field or borsh decoding breaks.
    #[allow(dead_code)]
    pub owner: Pubkey,
}

#[derive(Debug, BorshDeserialize)]
pub struct OrderFilled {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    pub taker_side: u8, // 0 = bid, 1 = ask
    pub price: u64,
    pub qty: u64,
    pub taker_fee: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct EventsConsumed {
    pub market: Pubkey,
    pub count: u64,
}

// ── M4: perps ──────────────────────────────────────────────────────────

#[derive(Debug, BorshDeserialize)]
pub struct PerpMarketInitialized {
    pub market: Pubkey,
    pub collateral_mint: Pubkey,
    pub oracle_price: u64,
    pub taker_fee_bps: u16,
    pub init_margin_bps: u16,
    pub maint_margin_bps: u16,
    pub max_funding_bps: u16,
}

#[derive(Debug, BorshDeserialize)]
pub struct OraclePriceSet {
    pub market: Pubkey,
    pub price: u64,
    pub ts: i64,
}

#[derive(Debug, BorshDeserialize)]
pub struct CollateralDeposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct CollateralWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct PerpPositionChanged {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub delta: i64,
    pub price: u64,
    pub fee: u64,
    pub realized_pnl: i64,
    pub base_position_after: i64,
    pub collateral_after: u64,
}

#[derive(Debug, BorshDeserialize)]
pub struct FundingUpdated {
    pub market: Pubkey,
    pub premium_bps: i64,
    pub cum_funding: i128,
    pub ts: i64,
}

#[derive(Debug, BorshDeserialize)]
pub struct PositionLiquidated {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub size_closed: i64,
    pub price: u64,
    pub penalty: u64,
}

#[derive(Debug)]
pub enum ClobEvent {
    MarketInitialized(MarketInitialized),
    Deposited(Deposited),
    Withdrawn(Withdrawn),
    OrderPlaced(OrderPlaced),
    OrderCanceled(OrderCanceled),
    OrderFilled(OrderFilled),
    EventsConsumed(EventsConsumed),
    PerpMarketInitialized(PerpMarketInitialized),
    OraclePriceSet(OraclePriceSet),
    CollateralDeposited(CollateralDeposited),
    CollateralWithdrawn(CollateralWithdrawn),
    PerpPositionChanged(PerpPositionChanged),
    FundingUpdated(FundingUpdated),
    PositionLiquidated(PositionLiquidated),
}

fn discriminator(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("event:{name}").as_bytes());
    hash[..8].try_into().unwrap()
}

/// Decode one `Program data:` payload (already base64-decoded).
pub fn decode_event(data: &[u8]) -> Option<ClobEvent> {
    if data.len() < 8 {
        return None;
    }
    let (disc, body) = data.split_at(8);
    // Discriminators are computed, not hard-coded; a unit test pins them
    // against the values in the generated IDL.
    macro_rules! try_decode {
        ($($name:ident),*) => {
            $(
                if disc == discriminator(stringify!($name)) {
                    return $name::try_from_slice(body).ok().map(ClobEvent::$name);
                }
            )*
        };
    }
    try_decode!(
        MarketInitialized,
        Deposited,
        Withdrawn,
        OrderPlaced,
        OrderCanceled,
        OrderFilled,
        EventsConsumed,
        PerpMarketInitialized,
        OraclePriceSet,
        CollateralDeposited,
        CollateralWithdrawn,
        PerpPositionChanged,
        FundingUpdated,
        PositionLiquidated
    );
    None
}

/// Walk a transaction's log messages and decode every event *our* program
/// emitted, ignoring `Program data:` lines from CPI'd programs.
///
/// Solana logs form a stack: `Program X invoke [n]` pushes, `Program X
/// success`/`failed` pops. A `Program data:` line belongs to whichever
/// program is on top of the stack.
pub fn events_from_logs(logs: &[String], program_id: &str) -> Vec<ClobEvent> {
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::new();

    for log in logs {
        if let Some(rest) = log.strip_prefix("Program ") {
            if let Some((pid, tail)) = rest.split_once(' ') {
                if tail.starts_with("invoke") {
                    stack.push(pid.to_string());
                    continue;
                }
                if tail == "success" || tail.starts_with("failed") {
                    // Pop the matching frame (the top, if logs are well formed).
                    if stack.last().map(|s| s.as_str()) == Some(pid) {
                        stack.pop();
                    }
                    continue;
                }
            }
        }
        if let Some(b64) = log.strip_prefix("Program data: ") {
            if stack.last().map(|s| s.as_str()) != Some(program_id) {
                continue;
            }
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                if let Some(ev) = decode_event(&bytes) {
                    out.push(ev);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Discriminators must match the generated IDL (target/idl/clob.json).
    #[test]
    fn discriminators_match_idl() {
        assert_eq!(discriminator("Deposited"), [111, 141, 26, 45, 161, 35, 100, 57]);
        assert_eq!(discriminator("EventsConsumed"), [215, 189, 44, 221, 117, 199, 17, 252]);
        assert_eq!(discriminator("MarketInitialized"), [134, 160, 122, 87, 50, 3, 255, 81]);
        assert_eq!(discriminator("OrderCanceled"), [210, 147, 48, 247, 204, 118, 255, 121]);
        assert_eq!(discriminator("OrderFilled"), [120, 124, 109, 66, 249, 116, 174, 30]);
        assert_eq!(discriminator("OrderPlaced"), [96, 130, 204, 234, 169, 219, 216, 227]);
        assert_eq!(discriminator("Withdrawn"), [20, 89, 223, 198, 194, 124, 219, 13]);
        // M4 perp events
        assert_eq!(discriminator("PerpMarketInitialized"), [211, 201, 85, 80, 15, 90, 233, 106]);
        assert_eq!(discriminator("OraclePriceSet"), [24, 244, 72, 175, 209, 136, 108, 67]);
        assert_eq!(discriminator("CollateralDeposited"), [244, 62, 77, 11, 135, 112, 61, 96]);
        assert_eq!(discriminator("CollateralWithdrawn"), [51, 224, 133, 106, 74, 173, 72, 82]);
        assert_eq!(discriminator("PerpPositionChanged"), [88, 216, 175, 234, 42, 90, 79, 103]);
        assert_eq!(discriminator("FundingUpdated"), [206, 76, 89, 81, 126, 37, 255, 224]);
        assert_eq!(discriminator("PositionLiquidated"), [40, 107, 90, 214, 96, 30, 61, 128]);
    }

    fn encode_order_placed() -> String {
        let mut buf = Vec::new();
        buf.extend_from_slice(&discriminator("OrderPlaced"));
        buf.extend_from_slice(&[7u8; 32]); // market
        buf.extend_from_slice(&42u64.to_le_bytes()); // order_id
        buf.extend_from_slice(&[9u8; 32]); // owner
        buf.push(0); // side = bid
        buf.extend_from_slice(&1000u64.to_le_bytes()); // price
        buf.extend_from_slice(&5u64.to_le_bytes()); // qty
        base64::engine::general_purpose::STANDARD.encode(buf)
    }

    #[test]
    fn decodes_order_placed_round_trip() {
        let logs = vec![
            "Program MyProgram1111 invoke [1]".to_string(),
            format!("Program data: {}", encode_order_placed()),
            "Program MyProgram1111 success".to_string(),
        ];
        let events = events_from_logs(&logs, "MyProgram1111");
        assert_eq!(events.len(), 1);
        match &events[0] {
            ClobEvent::OrderPlaced(e) => {
                assert_eq!(e.order_id, 42);
                assert_eq!(e.side, 0);
                assert_eq!(e.price, 1000);
                assert_eq!(e.qty, 5);
                assert_eq!(e.market.0, [7u8; 32]);
            }
            other => panic!("wrong event: {other:?}"),
        }
    }

    #[test]
    fn ignores_cpi_program_data() {
        let logs = vec![
            "Program MyProgram1111 invoke [1]".to_string(),
            "Program OtherProg2222 invoke [2]".to_string(),
            format!("Program data: {}", encode_order_placed()),
            "Program OtherProg2222 success".to_string(),
            "Program MyProgram1111 success".to_string(),
        ];
        // The data line was logged while the CPI'd program was on top.
        assert!(events_from_logs(&logs, "MyProgram1111").is_empty());
    }

    #[test]
    fn garbage_is_skipped() {
        let logs = vec![
            "Program MyProgram1111 invoke [1]".to_string(),
            "Program data: not-base64!!!".to_string(),
            "Program data: AAAA".to_string(), // too short for a discriminator
            "Program MyProgram1111 success".to_string(),
        ];
        assert!(events_from_logs(&logs, "MyProgram1111").is_empty());
    }
}
