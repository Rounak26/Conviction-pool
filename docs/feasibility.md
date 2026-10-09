# Conviction Pools — Technical Feasibility Report

Status: **Stage A passed on devnet (2026-10-09).** The fill/cancel mechanics work on-chain between wallets we control. **Nothing has been demonstrated on mainnet.** Stage B, the test of whether anyone other than us bridges the price, has not been run. Product demand is untested.
Date of research: 2026-10-09.

Evidence labels used below: **mainnet** (live mainnet query), **devnet** (a transaction we sent on devnet, finalized), **localnet** (local validator with cloned program binaries; not evidence), **docs/SDK** (documentation or package source).

## 1. Verified facts

"Verified" means checked against official Meteora docs, the published npm packages, or a live mainnet query, as noted.

### DLMM limit orders

| # | Fact | Source |
|---|------|--------|
| V1 | Limit orders are part of `lb_clmm` 0.12.0. Program ID (mainnet and devnet): `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`. | DLMM changelog |
| V2 | Limit orders are live on mainnet. A `getProgramAccounts` query filtered on the `LimitOrder` discriminator returned existing accounts. | Mainnet RPC, 2026-10-09 |
| V3 | Current SDK is `@meteora-ag/dlmm@1.9.14`. It pins `@coral-xyz/anchor@0.31.0` and requires `@solana/web3.js ^1.91.6`, which is **web3.js v1, not `@solana/kit`**. | npm |
| V4 | SDK methods: `placeLimitOrder`, `cancelLimitOrder`, `closeLimitOrderIfEmpty`, `getLimitOrder`, `getLimitOrderByUserAndLbPair`, and static `getLimitOrdersByUserAndTokenAddress`. | SDK `index.d.ts` |
| V5 | A pool is either `LimitOrder` or `LiquidityMining` (`ConcreteFunctionType`), never both. Existing pools without liquidity-mining rewards became LimitOrder pools, and this cannot be reverted. | Changelog |
| V6 | Pools can be created permissionlessly with `createCustomizablePermissionlessLbPair2(..., concreteFunctionType, collectFeeMode)`. `getPairPubkeyIfExists` takes function type and fee mode, so a token pair can have more than one DLMM pool. | SDK `index.d.ts` |
| V7 | An order is an on-chain account that holds one or more bins. The docs say up to 50 bins per account. Bids hold token Y at or below the active bin. Asks hold token X at or above it. Orders can be placed by absolute bin ID or relative to the active bin, with a slippage check. | Limit-order docs, SDK |
| V8 | An order fills only when swaps move through its bin. It can partially fill. Execution is not guaranteed. | Limit-order docs |
| V9 | **No expiry, deadline, or lock exists on-chain.** The `LimitOrder` account holds only `lb_pair`, `owner`, `bin_count`, and per-bin data. `PlaceLimitOrderParams` holds only `is_ask_side`, `relative_bin`, and `bins`. The owner can cancel at any time. | SDK IDL |
| V10 | There is no separate "claim" step. `cancelLimitOrder(binIds)` withdraws both the unfilled amount and the filled proceeds. Per-bin parsed data exposes deposit, unfilled, filled, swapped, and fee amounts, plus status (`NotFilled`, `PartialFilled`, `Fulfilled`). | SDK `index.d.ts` |
| V11 | Limit-order participants receive 50% of the limit-order portion of swap fees. The Data API reports this as a `bonus`. **This is an existing, protocol-native reward for resting orders.** | Limit-order docs, Data API schema |
| V12 | The Data API (`https://dlmm.datapi.meteora.ag`) has `GET /wallets/{wallet}/limit_orders/open/pools`, which lists open orders per wallet. | API reference, live call |
| V13 | Order account rent is refundable when the account closes. One observed account held 1,773,240 lamports (about 0.0018 SOL). | Mainnet RPC |

### DAMM v2 and graduation

| # | Fact | Source |
|---|------|--------|
| V14 | New DBC tokens graduate only to DAMM v2. DBC creates position NFTs, applies locks (at least 10% locked at day 1), and transfers the positions to the partner or creator. | DBC migration docs |
| V15 | DAMM v2 price is readable through `@meteora-ag/cp-amm-sdk@1.5.1`: `fetchPoolState(pool)`, then `getPriceFromSqrtPrice(sqrtPrice, decA, decB)`. It also provides `getQuote2` and `swap2`. Same web3.js v1 and Anchor 0.31 stack as the DLMM SDK. | SDK reference, npm |
| V16 | DAMM v2 trading fees go to the owners of the position NFTs, meaning the creator or partner. Meteora's "Dynamic Fee Sharing" product can split claimable fees, but only if the fee owner opts in. | DBC and fee-sharing docs |

### Verified on devnet by Stage A (not mainnet)

Run: `runs/stage-a-devnet-2026-10-09T12-02-13-406Z.json` (git-ignored, kept locally). All 11 signatures below were re-queried read-only with `getSignatureStatuses` and are `finalized` with `err = null`. Program binaries are the devnet deployments, which may differ from mainnet's.

| # | Fact | Evidence (devnet) |
|---|------|--------|
| V18 | One atomic legacy transaction (1,056 bytes, 65,874 CU), consisting of a DAMM v2 exact-out buy of X and a DLMM sell of X, filled a resting DLMM bid. The bid went `NotFilled` → `PartialFilled`: 89.594998 Y consumed, 91.402655 X received, 10.405002 Y unfilled. | arb tx `3pqrZMKJAy72SP3Co7phyLidnRMsow5BGYuZm8es1SxKXdw3P7AK7CpCnygsZBusepnJ4teZCrE5SXEk9h9tmscA` |
| V19 | The arbitrage was profitable: the trader made +2.143506 Y on about 87.45 Y in, and the on-chain balance change exactly matched the SDK quote edge. | same tx; trader balances |
| V20 | Inside the band (reference 0.978 against a bid at 0.980223), the SDK quotes gave a −0.434130 Y edge. The atomic arbitrage **simulation** failed with DLMM error 6003 `ExceededAmountSlippageTolerance` from its min-out guard. The order stayed untouched. This rejection is simulation evidence: nothing was sent. | in-band push tx `2THqT5oa…`; simulation log in the run file |
| V21 | **Effective DLMM fee on the arbitrage leg was 45.0 bps against a 25 bps base.** 413,173 of 91,815,828 X sold did not convert at the bin price. The variable fee came from crossing 8 bins (active bin 0 → −8). | arb tx; `dlmmEffectiveFeeBpsOnArbLeg` |
| V22 | The order's fee share was 0.499999 of the fee charged on its liquidity (206,586 of 413,173 X raw units), paid in the input token X. The maker's effective buy price was 0.978013 Y/X, better than the 0.980223 bin price. | arb tx; parsed order |
| V23 | Cancelling an unfilled bid refunded exactly 50 Y. Cancelling the partly filled bid returned exactly the SDK's `transferFeeExcludedWithdrawable` amounts (91.609241 X + 10.405002 Y). Both order accounts (`4crM9Yo3MpFh4Qu3dEpvYuj8j6fthcG2MhSJHQVvAMQX` = A, `HGwejcsa3933uMj5CoEUV7Pao9SLAEDE6Yoi5xfJqR4m` = B) went from 1,422,400 lamports to 0 **inside their cancel transactions**. Each cancel transaction logs `Instruction: CloseLimitOrderIfEmpty`, because the SDK appends it. Both accounts were still `null` on a later read-only check at slots 509177193 and 509177201. | cancel txs `Fwq2bSpG…`, `4vTatEu1…`; read-only `getTransaction`/`getAccountInfo` |
| V25 | **Fill X versus withdrawn X.** The order's `swappedAmountX` (91,402,655) is the filled Y (89,594,998) converted at the bin price (0.980223), rounded down. The cancel withdrew 91,609,241 X, which is **swappedAmountX + feeAmountX** (91,402,655 + 206,586). The SDK computes withdrawable X as `fee + swapped + unfilled` (`LimitOrder.parseInfo`), and the transfer-fee exclusion does nothing for plain SPL tokens. On-chain, the maker's X token account received +91,609,241 and the pool's X reserve paid −91,609,241 in the same cancel transaction. | cancel tx `4vTatEu1…` token balances; SDK `dist/index.js` `parseInfo`, `getUpdatedLimitOrderAmount` |
| V26 | **Where the fee went.** The arb sent 91,815,828 X into the DLMM reserve, and 413,173 of it was fee. The order got 206,586. The pool's `protocolFee.amountX` is 206,586. The reserve still holds 206,587 X after both cancels, which is the protocol fee plus 1 raw unit of rounding dust. In this pool, which held **only** limit-order liquidity, the non-order half of the fee went to the protocol. Whether that split holds when market-maker liquidity shares the bin is untested. | arb tx token balances; read-only `lbPair.protocolFee` and reserve balance |
| V24 | Full Stage A cost to the operator wallet was **0.10512 SOL net**: 0.205 SOL spent, less 0.09999 SOL swept back from the role wallets. Non-refundable items: one DLMM bin array 0.05214 (10,136 bytes), DLMM pool + reserves + oracle 0.0253, DAMM v2 pool + position 0.0165, 6 token accounts 0.0089, 2 mints 0.0021. Transaction fees totalled 0.000115 SOL (no priority fees). Rent is **5,080 lamports per byte (+128-byte overhead)** on devnet, and mainnet returned the same `getMinimumBalanceForRentExemption(10136)` = 52,141,120. The SDK constant `BIN_ARRAY_FEE` = 0.07143744 SOL assumes 6,960 per byte, so it **overstates** bin-array rent on today's devnet and mainnet. | per-tx `getTransaction` balance deltas; read-only rent queries on devnet and mainnet |

### Routing

| # | Fact | Source |
|---|------|--------|
| V17 | Jupiter lists new DLMM pools instantly, with no liquidity minimum, for a 14-day grace period. After that, a pool must pass a liquidity test (about 30% max impact on a $500 round trip), which is rechecked roughly every 30 minutes. | Jupiter forum, Meteora FAQ |

## 2. Unresolved assumptions

| # | Assumption | Why it matters | How to resolve |
|---|-----------|----------------|----------------|
| U1 | Jupiter will actually route volume through our DLMM pool when it gives a better price than DAMM v2. | If it does, orders fill without our keeper. Listing a pool does not mean volume reaches it. | Kill test, stage B. |
| U2 | Third-party arbitrage bots watch small DLMM limit-order pools. | If none do, the pool depends on our keeper alone. | Kill test, stage B. |
| U3 | The cost of creating a pool and bin arrays (non-refundable bin-array rent, pool account rent) fits the budget. | Bin arrays are large accounts. | **Measured on devnet → V24.** Creating a DLMM pool costs ≈0.025 SOL and each new bin array ≈0.052 SOL. Mainnet currently has the same rent rate as devnet (one read-only query), but a local validator does not (see §6). Mainnet priority fees are **not** measured. Whether the cost "fits the budget" is a decision for the team, not a measurement. |
| U4 | The DAMM v2 fee level after graduation is low enough to keep the arbitrage band narrow. | DBC configs can set high or scheduled fees. The arbitrage band is at least the DAMM fee plus the DLMM fee plus transaction costs. | Read `poolState` fee params for candidate tokens. |
| U5 | The DAMM v2 program and the DBC → DAMM v2 flow are deployed on devnet. | This is needed for a fully controlled devnet test. | **Resolved:** DLMM, DAMM v2 and DBC are all executable on devnet, and devnet already has 65 `LimitOrder` accounts (`npm run inspect`, 2026-10-09). Stage A creates its own DAMM v2 pool and does not go through DBC graduation. |
| U6 | The exact semantics of the 50% limit-order fee share and the "bonus" field. | This could be the funding source for rewards. | **Fee share resolved on devnet → V22.** The share is 50%, paid in the input token and withdrawn on cancel. Still open: whether the Data API's `bonus` field equals this on-chain share. That has not been checked. |
| U7 | `go_to_a_bin` can move an empty pool's active bin without permission. | This would let a keeper re-centre a pool with no liquidity cheaply. | Read the IDL and its signer constraints, then test on devnet. |
| U8 | Creators will opt in to routing fees through Dynamic Fee Sharing. | Rewards would be funded this way. Nothing makes it automatic. | Out of scope for the MVP. Treat it as a business question. |

## 3. Can a permissionless price bridge work?

**Mechanism.** A DLMM pool does not read any external price. Its active bin moves only when swaps cross bins. The only thing that ties it to the DAMM v2 reference price is **arbitrage**. If the DAMM price falls below a resting DLMM bid by more than the round-trip cost, someone can buy X on DAMM v2 and sell X into the bid in one atomic transaction. That trade fills the order. Asks fill the same way in reverse.

So the bridge is not a separate system. **Filling Conviction orders is itself the arbitrage.** Anyone can do it without permission. Both SDKs return transactions that can be merged into one atomic transaction, and no custom program is required.

**Consequences.**
- **The no-fill band.** No rational arbitrage happens while `|ref − order_price| < fee_DAMM + fee_DLMM + tx/priority costs` (in relative terms). An order inside that band will not fill even after the reference price crosses it. The UI has to show the band honestly. `fee_DLMM` is base + **variable** fee, and the variable part depends on the bins a swap crosses (V21: 45 bps effective against a 25 bps base). A closed-form band is therefore only an **estimate whose width is a lower bound**: it over-predicts fills. `src/pricing.ts` labels it so, and fill decisions use live SDK quotes (`quotedBidArbEdgeY`).
- **Capital.** An atomic round trip needs only the trade size in one token, because the second leg is funded by the first leg's output. A keeper can therefore run on small working capital. Bin-array rent and transaction fees are the other costs. U3 still needs to be measured.
- **Drift.** With no market-maker liquidity, the DLMM active bin can sit far from the reference price. That is harmless for limit orders but confusing for display. The Conviction Book should therefore show order prices relative to the DAMM reference price, not relative to the DLMM active bin.
- **Who runs the keeper.** If no third party arbitrages (U2) and Jupiter sends no flow (U1), we must run a keeper ourselves. Profit at small size may not cover priority fees. That would make the bridge a cost centre, not a self-sustaining mechanism.

**"Commitment" cannot be enforced without a program (V9).** For the MVP, commitment means **observed duration**: time an order has been open, taken from its creation transaction and current state. It is not a promise. A reward score can use only observed data: amount × time open × proximity to the reference price. An enforced lock would need a custom escrow program to own the order, and that is explicitly out of scope until it is proven necessary.

**Simplification.** A graduated token may already have a DLMM pool. Any pool without liquidity-mining rewards is now a LimitOrder pool (V5). We should look for an existing pool before creating one.

## 4. Kill test

The smallest experiment that can prove or falsify the mechanism has two stages.

**Stage A: devnet, fully controlled. It proves the mechanics.**
1. Mint test tokens X and Y. Create a DAMM v2 pool, or a stand-in if U5 fails, and a DLMM LimitOrder pool for the same pair.
2. Place one bid and one ask on DLMM about 2–3 bins away from the reference price.
3. Push the DAMM price past the bid with a swap from a second test wallet.
4. Run a one-shot arbitrage script: quote both pools, compute the net edge after fees, and, if positive, send one atomic transaction (DAMM swap followed by a DLMM swap).
5. Assert that the bid status is `PartialFilled` or `Fulfilled`, record `feeAmount`, then `cancelLimitOrder` and check the withdrawn amounts.
6. Record every lamport spent: pool creation, bin arrays, order rent, and transaction fees.

**Stage B: mainnet. Tiny, authorized wallet only, under $20 at risk. It tests whether anyone besides us bridges the price.**
1. Pick one graduated token whose DAMM v2 fee is low (U4) and that has an existing DLMM LimitOrder pool, or create one.
2. Place a small bid and a small ask just outside the no-fill band.
3. **Do not run our keeper** for N = 72 hours. Log the DAMM price, the DLMM active bin, and order status every minute.
4. Then run our keeper for another 72 hours and compare.

**Kill criteria.**
- Stage A cannot fill an order through atomic arbitrage. **The mechanism is dead.**
- Stage B, passive window: no fill even though the reference price crossed the order by more than the band for longer than 1 hour. **There is no third-party bridge.** The product then depends on our keeper.
- Stage B, keeper window: average arbitrage profit is below transaction and priority cost at order sizes under $50. **The keeper is a subsidy.** The "self-sustaining market" claim must be dropped.

Passing stage A and the keeper window, but failing the passive window, still leaves a viable but subsidised MVP. We would need to decide explicitly whether to continue.

## 5. Proposed architecture

This architecture is provisional and applies only after stage A passes.

```
packages/core     TypeScript library (no UI)
  reference.ts    read DAMM v2 price            (cp-amm-sdk)
  orders.ts       place / cancel / read orders  (dlmm SDK)
  book.ts         build the Conviction Book from on-chain orders + Data API
  score.ts        pure function: observed amount × duration × proximity
scripts/          devnet kill-test scripts (stage A), one file per step
keeper/           one-shot then looping arb: quote both pools → atomic tx if net edge > 0
web/              later; read-only Conviction Book first, then wallet actions
```

- No custom Solana program.
- No database at first: the book is derived from chain state and the Data API.
- `score.ts` is pure and unit-tested. It reports a score but makes no reward promise.

## 6. Stage A result (2026-10-09)

**Gate status: Stage A PASS on devnet, 26/26 assertions.** Verdict, assertions and signatures come from `runs/stage-a-devnet-2026-10-09T12-02-13-406Z.json`. An earlier devnet attempt (`…11-53-59-553Z`) was BLOCKED with an unfunded wallet and sent no transactions.

Of the 26 assertions, 19 rest on on-chain state, 6 on SDK quotes and 1 on a simulation. The quote and simulation checks support the analysis but are not on-chain evidence. The two "account closed" checks did call `getAccountInfo` on-chain, but this run's log records their `actual` only as "see steps". They have since been verified read-only (V23). The script now records the order pubkeys, the slot of the read, the closing signature and whether `CloseLimitOrderIfEmpty` ran. It also confirms and logs the role-wallet sweeps, which this run printed to the terminal only. That logging change has **not** been run on-chain yet.

| Step | Signature (devnet) | Fee (lamports) | CU |
|---|---|---|---|
| Create mints, fund roles | `4XJNzRuA8iezWWMQdtoJGXzjAP3m6o5E8mAHRmWsjmZyaKEhibUEmXHaAJWiBs8ybukRqwzmr9KatYp96KMJbKxc` | 15,000 | 1,004 |
| Token accounts + mint | `2q6Lx6tDbWuwV1fTeboXmhskN4bkpPYrzhyoR89oVLZLxrnhw9XV1BxZKEsQBbTw6KWoE6skqfcaFN6Bo5CgePSj` | 5,000 | 91,988 |
| DAMM v2 pool (25 bps, price 1.0) | `5UUWpZtcQFiCagACPJNWyysDFxPNRwibX9uKXR95EgBBNb2TZpSCAEpPx6Vei2CkxiJUkJreXvsroTXJo1LZh1JM` | 10,000 | 101,196 |
| DLMM LimitOrder pool (bin step 25, 25 bps) | `ZzxvhhbkN3pWZUEUFnEFZKZgmSqPXxQFZECxsMjLmY23bRZDR74VYEKPsonfQby6WNscoPbcfkJqJcyiqh8w3ZV` | 5,000 | 57,289 |
| Bid A, 100 Y @ bin −8 (0.980223) | `4PYKW4rfJFZgf426uwVC1GgjrryPjEirGau87XGBZfCtBuRjfg34smjgBaqi15espsgzVyJX1ZFC4EbaCoj3bDHB` | 15,000 | 232,703 |
| Bid B, 50 Y @ bin −40 (0.904950) | `5QQnZ7B93ShuYYa2r9bQHvrkjz3bp44gRXQtZCqjL8SV4DPh28NYoRA44WAexh4bEy7W3DNKr2b6bEcy2P6P1EMd` | 15,000 | 20,208 |
| Push reference to 0.978 (in band) | `2THqT5oazP3LS5nszitFXkujAvb8rpCnMKPMgPguWs4sHDpHKVY59QwWxyv18bLCPs1E3hjocNTwkjg5hPUZkek3` | 10,000 | 29,602 |
| In-band arb, simulation only, error 6003 | — | — | 67,318 |
| Push reference to 0.95 (past band) | `3pKJ1Fkn2HCPHQZkaSySXgjaSxmb75AFUyYjgQ1gXJaEsp54FCyW9FK5GA5a39nQ7g887J4Ewt3dRnwbBbdtotLs` | 10,000 | 29,609 |
| **Atomic arb (fills bid A)** | `3pqrZMKJAy72SP3Co7phyLidnRMsow5BGYuZm8es1SxKXdw3P7AK7CpCnygsZBusepnJ4teZCrE5SXEk9h9tmscA` | 10,000 | 65,874 |
| Cancel bid B (unfilled) | `Fwq2bSpG52iHwuba1tkKkwPo2ZjMVgSRGbCJ329cN4HBmaLUfHNw7R1Hdwe5MUyNyCv8h9pDh6HzbUppaBSyFtn` | 10,000 | 33,777 |
| Cancel bid A (proceeds + remainder) | `4vTatEu1C9AB7Y1ZbgqCLox4YquvjWVKs5ivPNqcmw2vG2TWaGtsyinixfQRsaunLAUNHmr6XK61iS1GiXCnWfwz` | 10,000 | 38,187 |

Accounts: operator `Ct68zVKq…ZoEJ6`, DAMM v2 pool `35nkDsWrZn6YEiRtaPTc3x7EcPW2SX2xurt7VMBddXEA`, DLMM pool `6f561F4k77S7NJrdoYpmB9kCDLnABSpsuLZNqeGAXPFZ`, mints X `29XHTPPs…`, Y `2Bsn8Kni…`. The SOL sweeps from the role wallets back to the operator were printed to the terminal but not recorded in the run file.

**Band estimate against quotes.** The base-fee estimate puts bid A's fill threshold at a reference of 0.975328. With the measured 45 bps effective fee it is 0.973373. The run's two reference points (0.978 and 0.95) fall outside that window, so **this run does not show which model is right in between**. The unit tests show that the base-fee estimate over-predicts a fill at 0.974. The run made its decisions from SDK quotes, so this did not affect the verdict.

**What Stage A does not show (remaining limitations):**
- **No mainnet evidence.** All transactions were on devnet, between wallets we controlled, on pools we created, with no other traders or bots. Devnet program builds may differ from mainnet.
- **No third-party bridge.** We ran the arbitrage ourselves. U1 (Jupiter routing) and U2 (third-party arbitrageurs) are untouched, and both belong to Stage B.
- **Bid side only.** No ask was placed, although §4 step 2 calls for one. Ask fills are expected to be symmetric but have not been demonstrated. A plan is below; it has not been implemented in the script or run.
- **No priority fees and no competition**, so the keeper economics (Stage B keeper window) are unmeasured.
- **Ideal setup.** Both pools are 6-decimal SPL tokens at price 1.0, the DAMM v2 pool has a static 25 bps fee, and the DLMM pool was empty apart from our orders. There were no Token-2022 tokens, no scheduled or dynamic DAMM fees (U4), no DBC-graduated token and no existing third-party DLMM pool.
- **One variable-fee sample.** The 45 bps figure comes from one 8-bin crossing. Variable fees depend on the volatility accumulator and the bins crossed, so they will differ elsewhere.
- **U7 and U8 are untouched.**
- **Stage B and product-market fit are not proven.** Nothing here shows that users want committed liquidity or that orders fill without our keeper.

**Why localnet cost 0.244 SOL and devnet 0.105 SOL.** Two causes, which together account for the whole gap within rounding:
1. **A logging race, worth 0.09999 SOL.** The script sent the role-wallet sweeps without confirming them, then read the end balance. On localnet the read ran before the sweeps landed. Evidence: the consecutive PASS rehearsals' **start** balances fall by exactly 0.14397428 SOL per run (9,632,573,920 → 9,488,599,640 → 9,344,625,360), and the last run's recorded 0.24396428 is 0.14397428 + 0.09999000. 0.09999 SOL is exactly two sweeps of 0.05 SOL less the 5,000-lamport fee each. Fixed in the script by confirming sweeps.
2. **A different rent rate.** The true localnet cost (0.14397428), minus fees of 0.000125, is 0.14384928 SOL of rent. Scaling that by 5,080/6,960 gives 0.104993 SOL, and devnet's rent figure is 0.10511844 − 0.000125 = 0.104993 SOL. This implies the local validator charged the classic 6,960 lamports per byte, which also matches the SDK's 0.0714 bin-array constant that README quoted.

**Limit of this evidence:** the local validator and its ledger are gone, so neither its rent rate nor its sweep timing can be queried directly. Both causes are inferred from the run files' balances, though the arithmetic matches to the lamport scale.

**Ask side: planned, not implemented or run.** Placing an ask requires on-chain transactions, so this is a design only.
- *Setup:* after the bid section, mint the trader about 150k extra Y. Place ask C: 100 X at bin +8 (1.020176), above the DLMM active bin, which sits at −8 after the bid fill. Place ask D: 50 X at bin +40 as the cancel-unfilled control.
- *Steps:*
  1. Buy X on DAMM v2 to push the reference to about 1.022. That is above the ask but inside the band: the base-fee threshold is 1.025296 and the measured-fee threshold 1.027356.
  2. Assert that the quotes give a negative `quotedAskArbEdgeY` and that a simulated atomic arb fails with 6003.
  3. Push the reference to about 1.05, then send one atomic transaction: a DLMM buy of X with Y (`swapForY = false`, exact-out of the X amount) followed by a DAMM v2 exact-in sale of that X, with min-out ≥ the DLMM max-in + 1.
  4. Cancel D and then C.
- *Assertions:*
  - The ask goes `PartialFilled`, with **`filledAmountX` > 0 (X consumed), `swappedAmountY` > 0 (Y received) and `feeAmountY` ≈ 50% of the fee**. This field mapping is predicted from the SDK code, not observed.
  - The cancel returns `swappedAmountY + feeAmountY` in Y plus the unfilled X.
  - Both order accounts read as `null`.
  - The effective DLMM fee on the leg is recorded.
- *Caveat:* moving from active bin −8 up through bin +8 crosses about 16 bins, so the variable fee should be higher than on the bid leg. Size the in-band step from quotes, not from the base-fee estimate.
- *Validation path:* first a localnet rehearsal (not evidence), then one devnet run once you authorize it.

**Localnet rehearsal** (PASS, 26/26, earlier the same day) exercised the same code against cloned binaries. Devnet results supersede it. It found two facts that devnet then confirmed: creating a customizable permissionless DLMM pool requires the creator to hold a non-zero balance of **both** tokens (error 6060, `MissingTokenAmountAsTokenLaunchProof`; one such pool per (X, Y) pair), and the variable fee widens the band (V21).

## Sources
- [DLMM limit orders](https://docs.meteora.ag/core-products/dlmm/limit-order)
- [DLMM changelog](https://docs.meteora.ag/developer-guides/dlmm/changelog)
- [DLMM TS SDK examples](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/examples)
- [DLMM open limit orders API](https://docs.meteora.ag/api-reference/dlmm/limit-orders/get-open-limit-order-pools)
- [DBC migration & liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity)
- [DAMM v2 TS SDK reference](https://docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference)
- [Dynamic Fee Sharing](https://docs.meteora.ag/helper-products/dynamic-fee-sharing/what-is-dynamic-fee-sharing)
- [Jupiter instant routing](https://discuss.jup.ag/t/jupiter-s-instant-routing-supporting-tokens-immediately/22317)
- [Meteora FAQ: token not on Jupiter](https://docs.meteora.ag/user-faq/why-is-the-token-sometimes-not-picked-up-and-tradable-on-jupiter)
- npm: `@meteora-ag/dlmm@1.9.14`, `@meteora-ag/cp-amm-sdk@1.5.1`
