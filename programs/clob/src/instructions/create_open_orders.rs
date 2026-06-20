use anchor_lang::prelude::*;

use crate::state::{Market, OpenOrders};

#[derive(Accounts)]
pub struct CreateOpenOrders<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = owner,
        space = 8 + OpenOrders::INIT_SPACE,
        seeds = [OpenOrders::SEED_PREFIX, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub open_orders: Account<'info, OpenOrders>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateOpenOrders>) -> Result<()> {
    let oo = &mut ctx.accounts.open_orders;
    oo.market = ctx.accounts.market.key();
    oo.owner = ctx.accounts.owner.key();
    oo.bump = ctx.bumps.open_orders;
    Ok(())
}
