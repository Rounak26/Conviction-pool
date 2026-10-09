# Conviction Pools

> Launches graduate. Conviction begins.

A post-graduation market for committed liquidity on Meteora: DLMM limit orders shown against the DAMM v2 reference price of a token that graduated from DBC.

**Status: feasibility.** No product code yet. This repo contains only the Stage A kill test from [`docs/feasibility.md`](docs/feasibility.md). The test checks whether an atomic arbitrage between a DAMM v2 pool and a DLMM limit-order pool can fill a resting order. See [Stage A status](#stage-a-status) for what has and has not been demonstrated.

## Requirements

- Node.js 20 or later. Tested on Node 26.3.
- For the optional localnet rehearsal: Solana CLI with `solana-test-validator`.

Dependencies are pinned exactly in `package.json`. The Meteora SDKs require `@solana/web3.js` v1 and Anchor 0.31.

| Package | Version |
|---|---|
| `@meteora-ag/dlmm` | 1.9.14 |
| `@meteora-ag/cp-amm-sdk` (DAMM v2) | 1.5.1 |
| `@solana/web3.js` | 1.99.0 |
| `@solana/spl-token` | 0.4.15 |

## Commands

```sh
npm ci                      # install the pinned dependency tree
npm test                    # unit tests: price math, fee assumptions, no-fill band
npx vitest run -t "no-fill" # run a single test or describe block by name
npm run typecheck

npm run wallet:new          # create .keys/stage-a.json (git-ignored); prints the public key only
npm run inspect             # read-only preflight: devnet genesis, programs, limit-order support, wallet balance
npm run stage-a             # Stage A on devnet. Every transaction is simulated before it is sent.
```

### Running Stage A on devnet

1. Run `npm run wallet:new`.
2. Fund the printed public key with about **0.6 devnet SOL** from <https://faucet.solana.com> (select Devnet). The RPC airdrop is often rate-limited.
3. Run `npm run inspect`. It must print `Environment VIABLE`.
4. Run `npm run stage-a`. The exit code is `0` for PASS, `1` for FAIL and `2` for BLOCKED. Transaction signatures, fees, compute units, errors and every assertion are written to `runs/stage-a-devnet-<timestamp>.json`.

A full devnet run cost **0.105 SOL** net (2026-10-09). Most of that is DLMM bin-array rent (0.052 SOL each at today's devnet rent rate) and pool rent. Limit-order account rent is refunded on cancel. A local validator uses a higher default rent rate, so rehearsals cost more (about 0.144 SOL).

### Localnet rehearsal (optional, not evidence)

You can debug the harness without devnet SOL. The rehearsal runs against a local validator loaded with the DLMM and DAMM v2 program binaries cloned from devnet:

```sh
solana-test-validator --reset --url https://api.devnet.solana.com \
  --clone-upgradeable-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
solana airdrop 10 <test pubkey> --url http://127.0.0.1:8899
LOCALNET=1 RPC_URL=http://127.0.0.1:8899 npm run stage-a
```

Rehearsal results are labelled `localnet-rehearsal` and **do not count toward the feasibility gate**.

## Safety

- The harness checks the RPC genesis hash and refuses any cluster other than devnet. Localhost is allowed only when you opt in with `LOCALNET=1`.
- It refuses to load the Solana CLI default wallet (`~/.config/solana/id.json`). It uses only `.keys/stage-a.json` or `KEYPAIR_PATH`.
- It never prints secret keys. `.keys/`, `runs/` and `.env*` are git-ignored.
- The maker and trader role wallets are generated in memory for each run, and their SOL is swept back at the end.

## What Stage A does

1. Creates two fresh 6-decimal test mints, X and Y.
2. Creates the reference pool: a **DAMM v2** pool at price 1.0 with a 25 bps static fee and full-range liquidity of 1M/1M.
3. Creates the Conviction pool: a **DLMM** `LimitOrder` pool at price 1.0, bin step 25, 25 bps base fee.
4. Reads and validates both pool states, including the token order, price, fees and limit-order support.
5. Places bid A (100 Y at bin −8, about 0.9802) and bid B (50 Y at bin −40, about 0.905).
6. Checks that the arbitrage is unprofitable at a reference price of 1.0.
7. Moves the reference price to 0.978, which is below the bid but inside the no-fill band. It then checks that the base-fee band estimate and the live SDK quotes both say "no arbitrage" (the quotes decide; the estimate is logged for comparison), that a simulated atomic arbitrage is rejected by its min-out guard, and that the order is untouched.
8. Moves the reference price to 0.95, past the band. It sends **one atomic transaction** containing a DAMM v2 exact-out buy of X and a DLMM sell of X into the bid. The DLMM leg's min-out is at least the DAMM leg's max-in, so the transaction reverts unless it is profitable.
9. Verifies on-chain that the trader's Y increased, that bid A is `PartialFilled` with X received, that the order's fee share is about 50%, and that the DLMM active bin moved.
10. Cancels bid B and checks the refund is exact. Cancels bid A and checks the X proceeds and Y remainder against the SDK's withdrawable amounts. Confirms that both order accounts are closed.

## Stage A status

| Environment | Result | Evidence |
|---|---|---|
| Unit tests | 24/24 pass | `npm test` |
| Localnet rehearsal (devnet program binaries) | PASS, 26/26 assertions | `runs/stage-a-localnet-rehearsal-*.json` (local only) |
| **Devnet** | **PASS, 26/26 assertions (2026-10-09)** | `runs/stage-a-devnet-2026-10-09T12-02-13-406Z.json` (local only); signatures in `docs/feasibility.md` §6 |

The feasibility gate is decided only by a devnet run. A devnet PASS shows the mechanics work between our own wallets. It says nothing about third-party arbitrage, Jupiter routing or mainnet economics; that is Stage B, which has not been run.

## Layout

```
src/pricing.ts     pure price / fee / no-fill-band math (unit-tested)
src/chain.ts       devnet guard, keypair loading, simulate-then-send recorder
scripts/           inspect, wallet:new, stage-a
test/              vitest unit tests
docs/feasibility.md  research, verified facts vs assumptions, kill test
```
# Conviction-pool
