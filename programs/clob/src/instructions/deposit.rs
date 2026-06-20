use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ClobError;
use crate::events::Deposited;
use crate::state::{Market, OpenOrders};

/// One instruction handles both base and quote deposits: which balance
/// gets credited is decided by which market vault the caller passed,
/// and the `constraint` below guarantees it is one of the two.
#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [OpenOrders::SEED_PREFIX, market.key().as_ref(), owner.key().as_ref()],
        bump = open_orders.bump,
        has_one = market,
        has_one = owner,
    )]
    pub open_orders: Account<'info, OpenOrders>,

    #[account(
        mut,
        constraint = vault.key() == market.base_vault || vault.key() == market.quote_vault
            @ ClobError::InvalidVault
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The caller's token account for the same mint as the vault; the
    /// token program itself rejects a mint mismatch on transfer.
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ClobError::InvalidOrderParams);

    // The owner signed this transaction, so the program can CPI a
    // transfer out of the owner's own token account directly.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let market = &ctx.accounts.market;
    let oo = &mut ctx.accounts.open_orders;
    let is_base = ctx.accounts.vault.key() == market.base_vault;
    if is_base {
        oo.base_free = oo.base_free.checked_add(amount).ok_or(ClobError::MathOverflow)?;
    } else {
        oo.quote_free = oo.quote_free.checked_add(amount).ok_or(ClobError::MathOverflow)?;
    }

    emit!(Deposited {
        market: market.key(),
        owner: oo.owner,
        mint: if is_base { market.base_mint } else { market.quote_mint },
        amount,
    });
    Ok(())
}
