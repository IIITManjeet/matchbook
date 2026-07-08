//! Deposit and withdraw perp collateral. Deposits are unconditional;
//! withdrawals must leave the account above *initial* margin (not just
//! maintenance) so a withdrawal can never push a position straight to
//! the edge of liquidation.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ClobError;
use crate::events::{CollateralDeposited, CollateralWithdrawn};
use crate::state::{MarginAccount, PerpMarket};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    pub owner: Signer<'info>,

    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        mut,
        seeds = [MarginAccount::SEED_PREFIX, perp_market.key().as_ref(), owner.key().as_ref()],
        bump = margin_account.bump,
        has_one = owner,
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(mut, address = perp_market.collateral_vault @ ClobError::InvalidVault)]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn deposit_handler(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ClobError::InvalidOrderParams);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let ma = &mut ctx.accounts.margin_account;
    ma.collateral = ma.collateral.checked_add(amount).ok_or(ClobError::MathOverflow)?;

    emit!(CollateralDeposited {
        market: ctx.accounts.perp_market.key(),
        owner: ma.owner,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,

    #[account(mut)]
    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        mut,
        seeds = [MarginAccount::SEED_PREFIX, perp_market.key().as_ref(), owner.key().as_ref()],
        bump = margin_account.bump,
        has_one = owner,
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(mut, address = perp_market.collateral_vault @ ClobError::InvalidVault)]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn withdraw_handler(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ClobError::InvalidOrderParams);

    let market = &ctx.accounts.perp_market;
    let ma = &mut ctx.accounts.margin_account;

    // Settle funding first so the check below sees true collateral.
    ma.settle_funding(market);
    require!(ma.collateral >= amount, ClobError::InsufficientFunds);

    // With a live position, equity after the withdrawal must still
    // clear initial margin at the current oracle price.
    if ma.base_position != 0 {
        let now = Clock::get()?.unix_timestamp;
        let price = market.require_fresh_oracle(now)?;
        let required =
            MarginAccount::margin_required(ma.base_position, price, market.init_margin_bps)?;
        let equity_after = ma.equity(market, price) - amount as i128;
        require!(equity_after >= required as i128, ClobError::BelowInitialMargin);
    }

    ma.collateral -= amount;

    let mint_key = market.collateral_mint;
    let seeds: &[&[u8]] = &[PerpMarket::SEED_PREFIX, mint_key.as_ref(), &[market.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.collateral_vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.perp_market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    emit!(CollateralWithdrawn {
        market: ctx.accounts.perp_market.key(),
        owner: ctx.accounts.margin_account.owner,
        amount,
    });
    Ok(())
}
