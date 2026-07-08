use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ClobError;
use crate::events::{PerpPositionChanged, PositionLiquidated};
use crate::state::{MarginAccount, PerpMarket, BASE_UNIT, BPS};

/// Permissionless liquidation: anyone may close a position whose equity
/// has fallen below maintenance margin, earning half the liquidation
/// penalty. The other half accrues to the protocol.
///
/// The margin account is addressed by its stored owner (via PDA seeds),
/// not by a signer — the whole point is that the owner is *not* around.
#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,

    #[account(mut)]
    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        mut,
        seeds = [
            MarginAccount::SEED_PREFIX,
            perp_market.key().as_ref(),
            margin_account.owner.as_ref(),
        ],
        bump = margin_account.bump,
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(mut, address = perp_market.collateral_vault @ ClobError::InvalidVault)]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// Liquidator's collateral-mint token account for the bounty.
    #[account(mut)]
    pub liquidator_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Liquidate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.perp_market;
    let ma = &mut ctx.accounts.margin_account;

    let price = market.require_fresh_oracle(now)?;
    ma.settle_funding(market);

    let pos = ma.base_position;
    require!(pos != 0, ClobError::NoPosition);

    let required = MarginAccount::margin_required(pos, price, market.maint_margin_bps)?;
    require!(
        ma.equity(market, price) < required as i128,
        ClobError::NotLiquidatable
    );

    // Close the entire position at the oracle price.
    let close = pos.unsigned_abs();
    let direction: i128 = if pos > 0 { 1 } else { -1 };
    let realized = direction * (price as i128 - ma.avg_entry_price as i128) * close as i128
        / BASE_UNIT as i128;
    ma.apply_realized(realized);
    ma.base_position = 0;
    ma.avg_entry_price = 0;

    if pos > 0 {
        market.long_oi = market
            .long_oi
            .checked_sub(close)
            .ok_or(ClobError::MathOverflow)?;
    } else {
        market.short_oi = market
            .short_oi
            .checked_sub(close)
            .ok_or(ClobError::MathOverflow)?;
    }

    // Penalty on the closed notional, capped at whatever collateral is
    // left (a deeply underwater account can't pay a full penalty).
    let notional = PerpMarket::notional(close, price)?;
    let penalty_wide = (notional as u128)
        .checked_mul(market.liq_fee_bps as u128)
        .ok_or(ClobError::MathOverflow)?
        / BPS;
    let penalty = u64::try_from(penalty_wide)
        .map_err(|_| ClobError::MathOverflow)?
        .min(ma.collateral);
    ma.collateral -= penalty;
    let bounty = penalty / 2;
    market.fees_accrued = market
        .fees_accrued
        .checked_add(penalty - bounty)
        .ok_or(ClobError::MathOverflow)?;

    let owner = ma.owner;
    let collateral_after = ma.collateral;
    let mint_key = market.collateral_mint;
    let market_key = market.key();
    let bump = market.bump;

    if bounty > 0 {
        let seeds: &[&[u8]] = &[PerpMarket::SEED_PREFIX, mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.liquidator_token.to_account_info(),
                    authority: ctx.accounts.perp_market.to_account_info(),
                },
                &[seeds],
            ),
            bounty,
        )?;
    }

    // The forced close also prints on the tape.
    emit!(PerpPositionChanged {
        market: market_key,
        owner,
        delta: -pos,
        price,
        fee: 0,
        realized_pnl: i64::try_from(realized).unwrap_or(i64::MAX),
        base_position_after: 0,
        collateral_after,
    });
    emit!(PositionLiquidated {
        market: market_key,
        owner,
        liquidator: ctx.accounts.liquidator.key(),
        size_closed: pos,
        price,
        penalty,
    });
    Ok(())
}
