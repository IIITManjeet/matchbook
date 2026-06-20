use anchor_lang::prelude::*;

use crate::errors::ClobError;
use crate::events::EventsConsumed;
use crate::state::{EventQueue, Market, OpenOrders, SIDE_BID};

/// The settlement crank. Permissionless: *anyone* can run it, because it
/// can only ever move funds in the direction the matching engine already
/// decided — maker locked funds become maker free funds in the other
/// currency. A malicious cranker can at worst settle people's trades for
/// them, paying the tx fee out of their own pocket.
///
/// The maker OpenOrders accounts are passed via `remaining_accounts`
/// (writable, any order, duplicates fine). Events are consumed strictly
/// in queue order; if the next event's maker account was not supplied,
/// consumption stops there — skipping events would let fills settle out
/// of order, and the sequence is the audit trail.
#[derive(Accounts)]
pub struct ConsumeEvents<'info> {
    pub cranker: Signer<'info>,

    #[account(has_one = event_queue)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub event_queue: AccountLoader<'info, EventQueue>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ConsumeEvents<'info>>,
    limit: u16,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let market_key = market.key();
    let mut queue = ctx.accounts.event_queue.load_mut()?;

    let mut consumed: u64 = 0;
    while consumed < limit as u64 {
        let Some(event) = queue.peek() else { break };
        let event = *event;

        let notional = event
            .price
            .checked_mul(event.qty)
            .and_then(|x| x.checked_mul(market.tick_size))
            .ok_or(ClobError::MathOverflow)?;
        let base_atoms = event
            .qty
            .checked_mul(market.base_lot_size)
            .ok_or(ClobError::MathOverflow)?;

        // Find the maker's OpenOrders among the supplied accounts.
        // `Account::try_from` verifies program ownership and the account
        // discriminator, so the `market`/`owner` fields can be trusted —
        // no PDA re-derivation needed (that check ran at creation).
        let mut applied = false;
        for account_info in ctx.remaining_accounts.iter() {
            if !account_info.is_writable {
                continue;
            }
            let mut oo: Account<OpenOrders> = match Account::try_from(account_info) {
                Ok(acc) => acc,
                Err(_) => continue,
            };
            if oo.owner != event.maker || oo.market != market_key {
                continue;
            }

            if event.taker_side == SIDE_BID {
                // Taker bought ⇒ maker's ask filled: locked base is gone,
                // quote proceeds arrive. Makers pay no fee.
                oo.base_locked = oo
                    .base_locked
                    .checked_sub(base_atoms)
                    .ok_or(ClobError::MathOverflow)?;
                oo.quote_free = oo
                    .quote_free
                    .checked_add(notional)
                    .ok_or(ClobError::MathOverflow)?;
            } else {
                // Taker sold ⇒ maker's bid filled: locked quote is gone,
                // base arrives.
                oo.quote_locked = oo
                    .quote_locked
                    .checked_sub(notional)
                    .ok_or(ClobError::MathOverflow)?;
                oo.base_free = oo
                    .base_free
                    .checked_add(base_atoms)
                    .ok_or(ClobError::MathOverflow)?;
            }

            // Write the mutated account back — remaining_accounts don't
            // get Anchor's automatic exit serialization.
            oo.exit(ctx.program_id)?;
            applied = true;
            break;
        }

        if !applied {
            break;
        }
        queue.pop();
        consumed += 1;
    }

    if consumed > 0 {
        emit!(EventsConsumed {
            market: market_key,
            count: consumed,
        });
    }
    Ok(())
}
