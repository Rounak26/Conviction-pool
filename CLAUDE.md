# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Conviction Pools ("Launches graduate. Conviction begins.") is a hackathon project (Meteora ecosystem, Colosseum). It is a market for committed liquidity on tokens after they graduate from Meteora DBC to DAMM v2. Users rest DLMM limit orders. A public **Conviction Book** shows those orders against the DAMM v2 reference price. A transparent score may later reward patient capital.

**Current phase: feasibility.** `docs/feasibility.md` is the source of truth. It lists verified facts, unresolved assumptions, the price-bridge analysis, and the kill test. Read it before writing code. Do not build product features until stage A of the kill test passes, and do not claim the mechanism works until it has been demonstrated on-chain.

## Stack

- TypeScript and Node.js.
- `@meteora-ag/dlmm` for DLMM pools and limit orders.
- `@meteora-ag/cp-amm-sdk` for DAMM v2 reference price and swaps.
- Both SDKs use **`@solana/web3.js` v1 and `@coral-xyz/anchor@0.31`**. Do not introduce `@solana/kit` (web3.js v2).
- Check current versions with `npm view <pkg>` before upgrading, because DLMM 0.12.0 introduced breaking changes to quote math and swap accounts.
- When docs are unclear, the installed SDK's `dist/index.d.ts` and the embedded IDL are authoritative. The `lb_clmm` program source is not public.

## Facts that shape the design

- A DLMM pool is either `LimitOrder` or `LiquidityMining`. Limit orders work only on `LimitOrder` pools.
- Limit orders have **no on-chain expiry or lock**, and the owner can cancel at any time. "Commitment" means *observed* time open, never a promise. Enforcing a lock would need a custom program.
- `cancelLimitOrder` withdraws both unfilled liquidity and filled proceeds. There is no separate claim step.
- The DLMM pool does not track DAMM v2 by itself. Only arbitrage links the two pools, and an order inside the fee band (DAMM fee + DLMM fee + tx cost) will not fill. The DLMM fee includes a **variable fee** that grows with the number of bins a swap crosses: in the rehearsal, base 25 bps became 45 bps. `src/pricing.ts` uses base fees, so its band is a lower bound. Decide using real SDK quotes.
- `createCustomizablePermissionlessLbPair2` requires the creator to hold a non-zero balance of **both** pool tokens. Without it the program returns error 6060, `MissingTokenAmountAsTokenLaunchProof`. There is one customizable pool per (X, Y) pair.
- The DLMM SDK's parsed limit-order amounts (`getLimitOrder`) are **UI-decimal strings**, not base units. For a bid, `filledAmountY` is the Y consumed, `swappedAmountX` is the X received, and `feeAmountX` is the order's fee share (about 50% of the fee on its liquidity). `filledAmountX` stays 0.
- `dlmm.swap()` simulates internally to estimate compute units and logs a noisy error when that simulation fails, for example when a profit guard trips. Strip its ComputeBudget instructions when merging transactions (`mergeTransactions` in `src/chain.ts`).

## Safety rules

- Use devnet and generated test keypairs by default. Keep keypair files outside the repo or in git-ignored paths, and never commit them.
- Use mainnet only for experiments the user has explicitly authorized, with tiny amounts (under $20 at risk) and a dedicated wallet.
- Do not assume Jupiter routes through our pool, that third-party arbitrageurs exist, that orders fill when the reference price moves, or that creator fees can be redirected. Each of these is an open item in `docs/feasibility.md`.
- Do not deploy a custom Solana program unless the user agrees it is required.
- Do not promise rewards in UI or copy until a funding and distribution mechanism has been validated.

## Workflow

- Keep `docs/feasibility.md` current. When an experiment resolves an assumption (U1–U8), move it to the verified facts with evidence such as a tx signature or log.
- Keep pricing and scoring logic in pure functions with unit tests. Keep chain I/O in thin wrappers.
- Write experiment scripts as small, single-purpose, re-runnable files that print transaction signatures.

## Commands

```sh
npm test                      # vitest unit tests (pure math only, no network)
npx vitest run -t "no-fill"   # single test / describe block by name
npm run typecheck             # tsc, no emit
npm run inspect               # read-only devnet preflight (no signing)
npm run stage-a               # devnet kill test; writes runs/stage-a-devnet-*.json
LOCALNET=1 RPC_URL=http://127.0.0.1:8899 npm run stage-a   # rehearsal on a local validator (see README)
```

Scripts run with `tsx`. The TypeScript config uses `moduleResolution: Bundler`, because with NodeNext the DLMM package's default export types as the module namespace. Vitest aliases `@meteora-ag/dlmm` to its CJS build (`vitest.config.ts`), because the package's ESM build uses a directory import that Node's strict ESM loader rejects.

## Code layout

- `src/pricing.ts`: pure functions for bin and sqrt prices and the no-fill band. They are cross-checked against the SDK helpers in `test/pricing.test.ts`.
- `src/chain.ts`: the devnet genesis guard, test-keypair loading (refuses `~/.config/solana/id.json`), and `Recorder`. `Recorder.send` simulates, then sends, then confirms, and logs the signature, fee, compute units and logs to `runs/*.json`. `Recorder.check` records assertions tagged `on-chain`, `quote` or `simulation`. Only `on-chain` evidence from a `devnet` run counts toward the feasibility gate.
- `scripts/stage-a.ts`: the kill test. It exits with 0 for PASS, 1 for FAIL and 2 for BLOCKED.
