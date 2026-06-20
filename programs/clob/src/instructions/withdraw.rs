use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ClobError;
use crate::events::Withdrawn;
use crate::state::{Market, OpenOrders};

#[derive(Accounts)]
pub struct Withdraw<'info> {
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

    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, ClobError::InvalidOrderParams);

    let market = &ctx.accounts.market;
    let oo = &mut ctx.accounts.open_orders;

    // Only *free* balance can leave; locked funds back resting orders.
    let is_base = ctx.accounts.vault.key() == market.base_vault;
    if is_base {
        require!(oo.base_free >= amount, ClobError::InsufficientFunds);
        oo.base_free -= amount;
    } else {
        require!(oo.quote_free >= amount, ClobError::InsufficientFunds);
        oo.quote_free -= amount;
    }

    // The vault's authority is the market PDA. A PDA has no private key,
    // so the program "signs" for it by presenting the seeds that derive
    // the PDA's address — this is what `CpiContext::new_with_signer` and
    // the runtime's `invoke_signed` are about.
    let signer_seeds: &[&[u8]] = &[
        Market::SEED_PREFIX,
        market.base_mint.as_ref(),
        market.quote_mint.as_ref(),
        &[market.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: market.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    emit!(Withdrawn {
        market: market.key(),
        owner: oo.owner,
        mint: if is_base { market.base_mint } else { market.quote_mint },
        amount,
    });
    Ok(())
}
