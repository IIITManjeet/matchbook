# Solana CLOB DEX

A central limit orderbook exchange on Solana, built as a deep-dive into
Anchor and on-chain systems design. Spot markets first, perpetual futures
later.

## Toolchain

Anchor has no native Windows support — all program work happens in WSL2
Ubuntu (`wsl -d Ubuntu`), which has Solana CLI 2.1 + Anchor 0.31.1
installed. Editing happens on the Windows side; the repo lives at
`D:\solana` = `/mnt/d/solana` in WSL.

```bash
# inside WSL
cd /mnt/d/solana
anchor build          # compile the program + generate the IDL
solana-test-validator # run a local cluster
anchor deploy         # deploy to it
```

## Roadmap

- [ ] **M1 — Book-keeping core**: markets, PDA vaults, deposits and
      withdrawals, post-only limit orders, cancels, events.
- [ ] **M2 — Matching**: taker matching, taker fees, event queue and a
      permissionless settlement crank.
- [ ] **M3 — Off-chain stack**: Rust indexer, REST + websocket API,
      Next.js trading terminal.
- [ ] **M4 — Perps**: Pyth oracle integration, margin accounts, funding
      rate, liquidation.
