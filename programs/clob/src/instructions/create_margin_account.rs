use anchor_lang::prelude::*;

use crate::state::{MarginAccount, PerpMarket};

#[derive(Accounts)]
pub struct CreateMarginAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub perp_market: Account<'info, PerpMarket>,

    #[account(
        init,
        payer = owner,
        space = 8 + MarginAccount::INIT_SPACE,
        seeds = [MarginAccount::SEED_PREFIX, perp_market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub margin_account: Account<'info, MarginAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateMarginAccount>) -> Result<()> {
    let ma = &mut ctx.accounts.margin_account;
    ma.market = ctx.accounts.perp_market.key();
    ma.owner = ctx.accounts.owner.key();
    ma.collateral = 0;
    ma.base_position = 0;
    ma.avg_entry_price = 0;
    // Start the funding clock at the market's current accumulator so a
    // fresh account doesn't owe (or collect) history it never held a
    // position through.
    ma.last_cum_funding = ctx.accounts.perp_market.cum_funding;
    ma.bump = ctx.bumps.margin_account;
    Ok(())
}
