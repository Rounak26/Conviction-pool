# Conviction Pools

> Launches graduate. Conviction begins.

A post-graduation market for committed liquidity on Meteora: DLMM limit orders shown against the DAMM v2 reference price of a token that graduated from DBC.

**Status: hackathon MVP (read-only).** Stage A passed on devnet, and Stage B0 observed mainnet read-only (see [`docs/feasibility.md`](docs/feasibility.md) §6–§7). The MVP is a local **Conviction Book**: resting DLMM limit orders shown against the DAMM v2 reference price, from a labelled mainnet snapshot or from labelled demo data. It has no wallet and sends no transactions. Nothing here shows product demand, and no rewards exist.

## Run the demo

```sh
npm ci
npm run demo          # rebuild web/data/ from runs/ (if present), then serve http://127.0.0.1:5173
```

`npm run app` serves without rebuilding, and `npm run data` only rebuilds. The server binds to 127.0.0.1, answers GET only, makes no RPC calls and holds no keys.

| View | What it shows |
|---|---|
| **Mainnet snapshot** | 42 real pools and 320 open orders from the 2026-10-09 B0 runs. Orders come from the Meteora Data API (up to 5 owners per pool, first page). The reference price and fee come from the deepest DAMM v2 pool at the census slot. Badges show DBC origin as confirmed or unverified. Order fills come from each pool's sampled window in forensics (windows differ by pool; some are months old). Owner wallets are shortened. |
| **Demo data** | 3 synthetic pools, labelled DEMO. `FERN/SOL` simulates a 6% reference drop, so it shows `crossed, in band` and `arb-fillable` orders. |
| **Evidence** | Stage A devnet signatures (explorer links), B0 headline numbers, the 4 third-party DAMM v2 → DLMM arbitrage fills seen on mainnet (Solscan links), and a list of what has **not** been shown. |

Deep links: `?source=demo&pool=demo-fern`, `?tab=evidence`. The address bar follows the selected source, pool and tab, so any view can be shared.

Each order gets a status against the reference and the estimated no-fill band (base fees, so a lower bound): `resting`, `crossed, in band`, `arb-fillable` or `filled`. It also gets an observed time open and an **observational score** (unfilled USD × days open, capped at 90, × proximity). The score is not a reward. The order preview is local arithmetic and cannot place an order. Pools where the DLMM price differs from the reference by more than 20% get a warning.

## Demo walkthrough

1. **Open the Conviction Book** (`npm run demo`, then <http://127.0.0.1:5173>). The banner states the dataset, when its orders and reference prices were taken, and its caveats.
2. **Mainnet snapshot, `SV151-USDC`.** Real resting orders from 2026-10-09: about $48k of bids and $53k of asks around a DAMM v2 reference of 0.3117 USDC. The depth chart shows unfilled USD by distance from the reference, and the shaded strip is the estimated no-fill band (≥ ±1.48%, a lower bound). Each row's `open tx ↗` opens the transaction that created the order on Solscan.
3. **Pool list.** Badges show DBC origin (`Graduated (DBC) ✓` only where the DAMM v2 creation transaction invoked the DBC program). The second line (bin step, DAMM fee, pool address) separates pools with the same pair name. `Graduated (DBC) only` filters to DBC-linked pools.
4. **Observed fills.** Open `AAI-USDC`, `EITHER-SOL` or `OP-SOL`: each lists swaps from the sampled window that consumed limit-order liquidity, with route and Solscan link. `OP-SOL`'s two fills are third-party DAMM v2 → DLMM arbitrage.
5. **Drift warning.** Pools where the DLMM active price is more than 20% from the reference (for example `AAI-USDC`, 34×) are flagged, because only arbitrage links the two pools.
6. **Demo data, `FERN/SOL`.** Synthetic, labelled DEMO in the banner, badges and coverage line. The reference has just fallen 6%, so bids show all three unfilled statuses: `resting`, `crossed, in band` (arbitrage would lose money) and `arb-fillable`.
7. **Order preview.** Pick a side, distance and size. The panel shows the reference price at which an atomic arbitrage could fill the order and the observational score after N days. It is local arithmetic and cannot place an order.
8. **Evidence tab.** Stage A devnet transactions and the B0 mainnet numbers behind every claim above, plus the open questions.

## Architecture

```
runs/*.json  ──►  scripts/build-data.ts  ──►  web/data/*.json  ──►  scripts/serve.ts  ──►  web/app.js
(local, git-       (no network)                (committed;            /api/pools, /api/book,   (static page,
 ignored run                                    snapshot, demo,        /api/preview, /api/      no framework,
 logs from                                      evidence)              evidence via src/book.ts no wallet)
 Stage A / B0)
```

- **Experiments** (`scripts/stage-a.ts`, `scripts/b0-*.ts`) are the only code that touches a chain. Stage A signs on devnet only (genesis guard). B0 reads mainnet through `src/readonly.ts` (method allowlist, no keys).
- **`scripts/build-data.ts`** turns the run logs into three static JSON files. If `runs/` is missing, it keeps the committed snapshot and evidence, so a fresh clone still runs the demo.
- **`src/book.ts`** holds the pure Conviction Book logic (status against the reference and band, time open, score, preview), unit-tested.
- **`scripts/serve.ts`** is a GET-only server on 127.0.0.1. It re-reads `web/data/` on each request and makes no RPC calls.
- **`web/`** is plain HTML, CSS and an ES module. All data is inserted as text, never as HTML.

## Data provenance

| Shown in the app | Source | Evidence class |
|---|---|---|
| Open orders (price range, size, USD, filled %, opened at, opening tx) | Meteora DLMM Data API, per owner wallet, 2026-10-09 17:45 UTC (`b0:offchain`) | mainnet, observational |
| Order-account count per pool, pool type, bin step, DLMM base fee | On-chain `getProgramAccounts` at slot 454,936,133 (`b0:census`) | mainnet, on-chain |
| DAMM v2 reference price and fee | Deepest DAMM v2 pool for the pair, same census slot | mainnet, on-chain |
| DBC origin badge | DAMM v2 creator is DBC's pool authority (census), plus a scan of the pool's creation tx (`b0:verify-dbc`) | mainnet, on-chain |
| Observed fills and their routes | Sampled swap transactions per pool, `Swap2Evt.limit_order_fee > 0` (`b0:forensics`, partial run of 31 pools) | mainnet, on-chain |
| USD sizes | The Data API's own pricing. $0 for a non-zero order is treated as **unpriced** (12 of 320 orders), never as $0 | third-party API |
| Status, no-fill band, score, preview | Computed locally by `src/book.ts` from the above | derived estimate |
| Stage A transactions | Our own devnet run, 2026-10-09 | devnet, on-chain |
| Demo pools | Deterministic generator in `scripts/build-data.ts` | **synthetic** |

Owner wallets are shortened in the snapshot. Nothing in the app is live: it is a snapshot from 2026-10-09.

## Known limitations

- **Snapshot, not live.** No indexer or RPC polling. Orders shown may have been cancelled or filled since.
- **Incomplete order lists.** The Data API lists orders per wallet, so the snapshot covers up to 5 owners per pool, first page each. The coverage line under each book gives the on-chain order count for comparison.
- **The band is a lower bound.** It uses base fees. The real DLMM fee has a variable part (45 bps measured against a 25 bps base on devnet), so statuses near the band edge are optimistic.
- **Commitment is observed, not enforced.** DLMM limit orders have no lock or expiry. "Open for" is time since creation.
- **The score is observational.** It pays nothing, and no funding or distribution mechanism exists.
- **Mainnet mechanism unproven for our pools.** Stage A ran on devnet between our own wallets. Stage B (a new pool of ours on mainnet, third-party fills) has not run. B0 saw third-party arbitrage fill orders only in existing pools.
- **Thin or drifted references.** Some DAMM v2 references are thin, so distances can be extreme (shown as multiples, for example `2185× ref`) and the pool is flagged.
- **No wallet, no order placement.** This is deliberate for the MVP.

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

### Stage B0: read-only mainnet observation

B0 ([`docs/stage-b-plan.md`](docs/stage-b-plan.md) §2) reads mainnet state and public APIs. It loads no keypair and signs nothing. The RPC wrapper in `src/readonly.ts` rejects every JSON-RPC method that is not on a read-only allowlist, so `sendTransaction` and `simulateTransaction` cannot leave the process. It also rate-limits requests and checks that the genesis hash is mainnet-beta. The devnet guard in `src/chain.ts` is unchanged.

```sh
export MAINNET_READONLY=1                 # explicit opt-in
export MAINNET_RPC_URL=https://api.mainnet-beta.solana.com   # default; any mainnet RPC
export RPC_RPS=2                          # default request rate, max 10

npm run b0:census      # B0.1/B0.2: LimitOrder accounts by pool, pool types, DAMM v2 pairs and fees
npm run b0:forensics   # B0.3/B0.7: recent swaps on candidate pools, who filled orders, priority fees
npm run b0:offchain    # B0.5/B0.6: Meteora Data API order stats, Jupiter quote routing
npm run b0:verify-dbc  # checks DBC origin of flagged DAMM v2 pools (stops after 10,000 signatures per pool)
npm run b0:check-txs -- <sig> …   # which DLMM and DAMM v2 pools given transactions swapped on
```

Each script writes `runs/stage-b0-*.json` (git-ignored). This is observational evidence about other people's pools, labelled `mainnet-observational`.

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
| Unit tests | 56/56 pass (29 pricing, 18 Stage B0 helpers and read-only guard, 9 Conviction Book) | `npm test` |
| Localnet rehearsal (devnet program binaries) | PASS, 26/26 assertions | `runs/stage-a-localnet-rehearsal-*.json` (local only) |
| **Devnet** | **PASS, 26/26 assertions (2026-10-09)** | `runs/stage-a-devnet-2026-10-09T12-02-13-406Z.json` (local only); signatures in `docs/feasibility.md` §6 |

The feasibility gate is decided only by a devnet run. A devnet PASS shows the mechanics work between our own wallets. It says nothing about third-party arbitrage, Jupiter routing or mainnet economics; that is Stage B, which has not been run.

## Layout

```
src/pricing.ts     pure price / fee / no-fill-band math (unit-tested)
src/chain.ts       devnet guard, keypair loading, simulate-then-send recorder
src/readonly.ts    read-only mainnet RPC: opt-in, genesis check, method allowlist, rate limit
src/b0.ts          pure helpers for B0 (event payloads, swap classification, fee math)
src/book.ts        pure Conviction Book logic: status vs band, time open, score, order preview (unit-tested)
scripts/           inspect, wallet:new, stage-a, b0-*, build-data (web/data from runs/), serve (local app server)
web/               static frontend (index.html, app.js, styles.css) and web/data/*.json
test/              vitest unit tests
docs/feasibility.md  research, verified facts vs assumptions, kill test
docs/stage-b-plan.md Stage B market validation plan
docs/submission.md   hackathon submission draft and 2-minute demo script
```
