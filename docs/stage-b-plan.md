# Conviction Pools: Stage B Market Validation Plan

Status: **B0 run once (read-only, 2026-10-09); B1, B2 and B3 not started.** Date: 2026-10-09. B0 results and their limits are in [`feasibility.md`](feasibility.md) §7.
This document plans the work. It is not evidence. [`feasibility.md`](feasibility.md) is still the source of truth for what has been verified. When a Stage B step resolves an item, record the evidence there, not here.

**What we can claim today.** Stage A passed on devnet (26/26 assertions). An atomic DAMM v2 → DLMM arbitrage, run by our own wallet, filled our own bid in pools we created. **No third-party fill has been seen. Nothing has been shown on mainnet. No user has said they want this product.** None of the work below assumes product-market fit, and finishing it would not prove product-market fit either. At most it can show that the mechanism works without us and that a few real people describe the problem it solves.

---

## 1. Evidence ledger

Every claim in this plan falls into one of three groups. Section 1.1 references IDs from `feasibility.md`, and sections 1.2 and 1.3 add new Stage B IDs (H = hypothesis, Q = open question).

### 1.1 Verified facts this plan relies on

| ID | Fact | Evidence level |
|---|---|---|
| V2 | Limit-order accounts exist on mainnet. | mainnet read-only query |
| V5, V6 | A DLMM pool is either `LimitOrder` or `LiquidityMining`. A pair can have more than one DLMM pool. | docs/SDK |
| V9 | Orders have no on-chain lock or expiry. The owner can cancel at any time. | SDK IDL |
| V11, V22 | Resting orders get about 50% of the fee charged on their liquidity, paid in the input token. | docs; **devnet** |
| V12 | The Data API lists open orders **per wallet**. | API reference, live call |
| V14, V16 | DBC tokens graduate to DAMM v2. DAMM v2 fees go to the owners of the position NFTs, and redirecting them requires an opt-in. | docs |
| V17 | Jupiter lists new DLMM pools at once for 14 days. After that a pool must pass a liquidity test (about 30% max impact on a $500 round trip). | Jupiter forum, Meteora FAQ |
| V18–V20 | An atomic arbitrage fills a bid when the reference price is past the band, and a min-out guard rejects it inside the band. | **devnet** (simulation for V20) |
| V21 | The effective DLMM fee was 45 bps against a 25 bps base on an 8-bin crossing. | **devnet**, one sample |
| V24 | Creating a DLMM pool costs about 0.025 SOL, and each bin array costs about 0.052 SOL. Both are non-refundable. Mainnet rent per byte matched devnet in one query. | **devnet**; mainnet rent query |

### 1.2 Assumptions Stage B tests (hypotheses)

| ID | Hypothesis | Feasibility link | Falsified if |
|---|---|---|---|
| H1 | **Independent fills.** Third-party arbitrageurs fill small DLMM limit orders on graduated-token pools within 1 hour of the DAMM v2 reference moving past the no-fill band. | U2 | No third-party fill is observed while the reference stays past the band for more than 1 hour (§4 kill criterion). |
| H2 | **Routing.** Jupiter sends taker flow through a DLMM `LimitOrder` pool when the pool offers a better price than DAMM v2. | U1 | Jupiter quotes never include the pool, or the pool drops out after the 14-day grace period, even when its price is better. |
| H3 | **Discoverability.** A trader or creator who looks for post-graduation buy interest in a token can find its resting orders without our tooling. | new | People in the interviews cannot find, or do not look for, existing order data (V12 is per wallet, not per pool). |
| H4 | **Keeper economics.** If we must run a keeper, its arbitrage profit on orders under $50 covers transaction fees, priority fees and tips. | §4 kill criterion | Average profit per fill is below average cost per fill. |
| H5 | **Maker economics.** The 50% fee share (V11) is a measurable, non-trivial return for resting orders on graduated tokens. | U6 | Observed `feeAmount` on existing mainnet orders rounds to zero next to their size and price risk. |
| H6 | **Pool cost.** We can reuse existing `LimitOrder` pools instead of creating new ones, so rent does not dominate the cost. | U3 | Most candidate tokens have no `LimitOrder` pool, and creating one would need about 0.025 SOL plus 0.052 SOL per bin array, plus holding both tokens (error 6060). |
| H7 | **Creator demand.** Token creators see weak post-graduation liquidity or buy support as a real problem that they already spend time or money on. | U8 (partly) | Fewer than 2 of 5 creators describe it as a past, costly problem (§5). |
| H8 | **Trader demand.** Independent traders already rest limit orders on post-graduation tokens and would value seeing the orders of others. | new | Fewer than 2 of 5 traders currently use limit orders on such tokens (§5). |

Sustainable economics means H4, H5 and H6 together, plus the unresolved funding question (U8). If H1 and H2 both fail, the product depends on our keeper, and H4 then decides whether that keeper is a business or a subsidy.

### 1.3 Unanswered questions (no hypothesis yet)

| ID | Question | How we might answer it |
|---|---|---|
| Q1 | Does the Jupiter liquidity test count one-sided limit-order liquidity that sits far from the active bin? | Watch Jupiter quotes for a LimitOrder-only pool after its 14-day grace period (read-only). |
| Q2 | Do existing mainnet DLMM pools of graduated tokens tend to be `LimitOrder` or `LiquidityMining`? | Census (B0.1). |
| Q3 | What do DAMM v2 fees look like after graduation: static, scheduled or dynamic, and at what level? | Census (B0.2). This is U4. |
| Q4 | Does the Data API `bonus` field equal the on-chain fee share? | Compare both for the same orders (B0.5). This is the open part of U6. |
| Q5 | When both share a bin, how is the fee split between order liquidity and market-maker liquidity? | Read-only forensics on mainnet pools that have both (B0.3). V26 covered only an order-only pool. |
| Q6 | Is there a per-pool view of open orders in the Data API, or must the book be built from `getProgramAccounts`? | Check the API reference and test endpoints (read-only). |
| Q7 | Since orders can be cancelled at any time (V9), will people read a public book as a signal or as spoofing? | Interviews (§5). |
| Q8 | What do existing tools (for example Jupiter trigger orders or Meteora's own interface) already provide? | Desk research and interviews. **Not checked in this repo.** Treat it as unknown. |
| Q9 | Who would pay for rewards, if anyone? | Interviews with creators (U8). No promise is made (CLAUDE.md). |

---

## 2. Validation path, from cheapest to riskiest

Each phase must finish, or be explicitly waived by the user, before the next phase starts. Phases B0 and B2 need **no SOL and no signing**, and they can run in parallel.

### B0. Read-only mainnet observation (no funds, no transactions)

This is a natural experiment. Mainnet already has limit orders (V2), so we can see whether **other people's** orders are filled by third parties before we risk anything ourselves.

| Step | What | Output | Resolves |
|---|---|---|---|
| B0.1 | **Census.** List mainnet `LimitOrder` accounts and group them by `lb_pair`. For each pair, check whether one token has a DAMM v2 pool that came from DBC graduation. Record the pool function type, bin step, base fee and order count. | Candidate table: token, DLMM pool, DAMM v2 pool, order count and age | Q2, H6 |
| B0.2 | **DAMM v2 fee census.** For each candidate, read `poolState` fee parameters (base, scheduler, dynamic). | Fee distribution; shortlist with low fees | U4, Q3 |
| B0.3 | **Fill forensics.** For orders that went `PartialFilled` or `Fulfilled`, fetch the filling transactions. Classify each one: (a) the signer is the order owner, (b) the transaction calls the Jupiter aggregator, (c) the transaction swaps on both DAMM v2 and DLMM, signed by a third party (arbitrage), or (d) a direct DLMM swap by a third party. | Fill counts by class; signer list for (c) | H1, H2 indirectly; Q5 |
| B0.4 | **Lag measurement.** For fills of class (c), compare the fill slot with the DAMM v2 price history from the swaps just before it. Estimate how far past the band the price was and for how long. | Distribution of lag and edge at fill | H1, H4 |
| B0.5 | **Maker return.** For filled orders, compare `feeAmount` with order size, and with the Data API `bonus` for the same wallet. | Fee share in bps of notional | H5, Q4 |
| B0.6 | **Routing probe.** For shortlisted tokens, request Jupiter quotes (read-only, no wallet) at small sizes in both directions. Record whether the route plan includes the DLMM pool. Repeat on a schedule. | Inclusion rate over time | H2, Q1 |
| B0.7 | **Cost inputs.** Sample recent priority fees (`getRecentPrioritizationFees`) for the DLMM and DAMM v2 program accounts. | Cost per arbitrage transaction (range) | H4 |

**Rules for B0.** Use a new read-only script per step. Scripts must not load a keypair. They need an explicit mainnet opt-in flag, because the current genesis guard refuses mainnet on purpose and must stay strict for signing scripts. Each script writes `runs/stage-b0-*.json`. B0 evidence is labelled **mainnet (observational)**. It is about other people's pools, so it **cannot by itself** close U1 or U2 for our setup, but it can make the mainnet experiment unnecessary or show that it is unlikely to pass.

**Selection-bias caveat.** Pools that already have orders may also have market-maker liquidity or more volume than a typical graduated token. A third-party fill there does not prove a fill on a thin pool.

### B1. Devnet hardening (devnet SOL only)

Each run needs separate authorization, as in Stage A.

1. **Ask side.** Implement and run the ask plan in `feasibility.md` §6. Stage B places an ask, so ask fills must be shown first.
2. **Rerun with full logging.** The sweep and order-close logging change has not run on-chain yet. One devnet run confirms it.
3. **Observer.** Build a **read-only** logger that records the DAMM v2 price, the DLMM active bin and order status every minute. Test it on devnet, then run it against B0 candidate pools on mainnet (still read-only) for at least 24 hours with no gaps.
4. **Cancel drill.** Write a stand-alone script that cancels every order the experiment wallet holds, and test it on devnet. This is the mainnet kill switch.
5. **Keeper loop (optional).** Run a looping version of the Stage A arbitrage, with priority fees, on devnet. Devnet has no real competition or economics, so this is **only a correctness test**. It says nothing about H4.

Not planned: passive waiting for third-party fills on devnet. Devnet tokens have no value, so nobody has a reason to arbitrage them, and a null result would mean nothing.

### B2. Interviews (no funds; runs in parallel with B0 and B1)

See §3.

### B3. Mainnet experiment (only after §4's gate and written approval)

This is the design in `feasibility.md` §4, with these refinements:

- **Prefer an existing `LimitOrder` pool** from B0. It avoids about 0.025 SOL of pool rent and possibly bin-array rent (H6). Creating a pool also requires holding both tokens (error 6060).
- **We do not move the price ourselves.** On mainnet we wait for organic price moves. Pushing the reference price, as we did on devnet, would cost money and could look like manipulation.
- **Passive window (72 hours).** During this window the wallet sends only the place transactions and, if a stop condition triggers, cancels. The observer logs every minute. Each fill is classified as in B0.3.
- **Inconclusive outcome, defined in advance.** If the reference price never stays past the band for more than 1 hour, the window is **inconclusive**, not a pass. We may extend it once, for at most 72 hours, only with fresh approval.
- **Keeper window (72 hours).** This needs separate approval. It measures H4 only.

---

## 3. Interviews: 5 token creators and 5 independent traders

### 3.1 Approach

- **Ask about past behaviour, not opinions about our idea.** "Tell me about the last time…" counts as evidence. "Would you use…?" does not.
- **Do not pitch until the last 5 minutes.** Describe the concept in words or with a hand sketch. No frontend is built for this.
- **No promises.** Do not mention rewards, airdrops, points or tokens as features (CLAUDE.md). If someone asks, say that no reward exists or is planned yet.
- **Consent and privacy.** Ask for consent to take notes. Store notes without names, as C1–C5 and T1–T5. Do not record wallet addresses unless the person offers them for a stated purpose.
- **Recruiting.** Find creators who have had **at least one token graduate from DBC**, and traders who have traded post-graduation tokens in the last 30 days. Include at least one trader who runs bots or arbitrage, because they speak to H1 directly. Do not fill more than 2 of each group from the hackathon community, which is likely to be friendly to the idea.
- **Format.** 30 minutes each, one interviewer and one note-taker if possible. Write notes into a fixed template within 24 hours.

### 3.2 Creator questions

1. Walk me through your most recent token graduating from DBC to DAMM v2. What happened in the first 72 hours?
2. What, if anything, did you do about price or liquidity after graduation? What did that cost in time and money?
3. Have you ever paid for liquidity: a market maker, incentives or a liquidity-mining pool? What happened? Would you do it again?
4. How do you tell committed holders from short-term traders today? What data do you look at, and where?
5. Who receives the DAMM v2 trading fees for your token, and what happens to them? Have you looked at Dynamic Fee Sharing? (U8, V16)
6. Have you seen a DLMM pool for your token, or limit orders on it? Did you know they existed? (H3, Q2)
7. *(Concept, last 5 minutes.)* Imagine a public list of buy orders resting below the current price for your token, showing how long each has been open. Orders can be cancelled at any time. What would you conclude from it? Could it hurt you? (Q7)
8. What would you need to see before you pointed your community at something like this?
9. Who else should I talk to?

### 3.3 Trader questions

1. Walk me through the last time you traded a token soon after it graduated. How did you enter and exit?
2. Do you use limit orders on Solana? Which tool? Tell me about the last one: its size, how long it rested, and whether it filled when you expected. (H8, Q8)
3. What makes you cancel a resting order?
4. Have you ever placed an order that the price passed but did not fill? What did you do about it? (This tests whether the no-fill band matters to users.)
5. Before you trade, do you look at other traders' resting orders? Where? (H3)
6. *(Bot operators.)* Do you monitor DLMM pools against DAMM v2 or other venues? What minimum edge, pool size or volume makes a pool worth watching? What do priority fees and tips cost you per transaction? (H1, H4)
7. Did you know that DLMM limit orders earn a share of swap fees? Would that change how long you leave an order open? (H5)
8. *(Concept, last 5 minutes.)* Shown a public book of resting orders and how long each has been open, would you trust it, trade against it or add to it? What would make it misleading? (Q7)
9. Who else should I talk to?

### 3.4 Success criteria (fixed before the first interview)

Only **past behaviour** or a **concrete next step** counts. Compliments, "sounds cool" and hypothetical promises do not.

| Signal | Creators (n = 5) | Traders (n = 5) |
|---|---|---|
| **Problem is real**: they describe a specific past episode with time or money spent | ≥ 3 of 5 (H7) | ≥ 3 of 5 currently rest limit orders on post-graduation tokens (H8) |
| **Current tools fall short**: a specific failure (no fill, no visibility, cost) | ≥ 2 of 5 | ≥ 2 of 5 |
| **Concrete next step**: agrees to a follow-up, introduces a peer, or nominates their token for read-only monitoring | ≥ 2 of 5 | ≥ 2 of 5 |
| **Bot operator input on H1** | n/a | ≥ 1 operator gives a concrete minimum edge or pool-size threshold |

**How to read the result.**
- **Pass**: both groups meet the "problem is real" and "concrete next step" rows.
- **Weak**: only one group passes. Narrow to that segment and run 5 more interviews before building anything.
- **Fail**: neither group passes. Stop product work, whatever the B0 and B3 results.
- **Not PMF.** Even a pass shows only that 10 people have the problem. It does not show that they will use or pay for this product.

---

## 4. Minimum evidence before any mainnet experiment (B3 gate)

All items are required unless the user waives one in writing.

| # | Requirement | Phase |
|---|---|---|
| G1 | B0.1–B0.3 are done and summarized in `feasibility.md`, with at least one candidate token that has an existing `LimitOrder` DLMM pool and a known DAMM v2 fee schedule. | B0 |
| G2 | B0 did **not** already answer the question. If B0.3 found no third-party fills of class (c) or (d) over a representative sample, the passive window is expected to fail. Decide whether to skip B3 and go straight to the keeper question. | B0 |
| G3 | The no-fill band for the chosen orders is computed from **live SDK quotes** at the planned size, not from `noFillBandWidth` alone, which is a lower bound (V21). | B0, B1 |
| G4 | Devnet ask-side run passed, with on-chain evidence. | B1.1 |
| G5 | The observer ran read-only against the chosen mainnet pools for at least 24 hours with no gaps. | B1.3 |
| G6 | The cancel drill passed on devnet. The mainnet cancel transaction has been **simulated** against the real pool before any order is placed. | B1.4 |
| G7 | A new, dedicated mainnet keypair kept outside the repo, funded only up to the approved budget. The Solana CLI default wallet is not used. | setup |
| G8 | A written cost estimate in SOL **and** USD at the current price, listing non-refundable rent, refundable rent, order notional and fees (§5.2). | setup |
| G9 | Written approval from the user, in the form described in §5.2. | approval |
| G10 | Interviews have not hit the "Fail" outcome. This is a recommendation, not a technical requirement: there is little reason to spend even $20 testing a mechanism nobody wants. | B2 |

---

## 5. Risks, budget approval and stop conditions

### 5.1 Risks

| Risk | Effect | Mitigation |
|---|---|---|
| **Adverse selection.** Our bid fills because the token is crashing. | We lose up to the full notional of the filled order. | Count the whole order notional as at-risk money, not just fees. Keep orders small. |
| **Rent can exceed the cap.** A new pool (about 0.025 SOL) plus two bin arrays (about 0.104 SOL) is about 0.13 SOL of non-refundable rent before any order. | Depending on SOL price, this alone could exceed $20. | Reuse an existing pool (H6). Check that the bid and ask bins fall in already-initialized bin arrays. Convert to USD on the day of approval. |
| **Inconclusive window.** The price never crosses the order by more than the band. | We spend time and fees and learn nothing. | Define the inconclusive outcome in advance (§2 B3) and allow at most one extension. |
| **Selection bias in B0.** Busy pools are not like ours. | False confidence in H1. | Report pool liquidity and volume next to every fill statistic. |
| **Misclassified fills.** A Jupiter-routed fill is counted as arbitrage, or the reverse. | Wrong conclusion about H1 or H2. | Classify by programs invoked and by signer, and keep the raw transactions in the run file. |
| **Devnet and mainnet differ.** Program builds may not match. | Mainnet behaviour may differ from Stage A. | Simulate every mainnet transaction before sending it. Simulate the cancel first (G6). |
| **Keys.** A mainnet key leaks or is committed. | Loss of funds. | Use a dedicated wallet with only the approved budget, store it in a git-ignored path, never print the secret, and sweep the wallet back at the end. |
| **Optics and market conduct.** We push a real token's price, or interview copy implies rewards. | Reputational or legal exposure. | Never push mainnet prices. Make no reward promises. Explain in interviews that this is research. |
| **Interview bias.** Friendly or leading interviews. | False demand signal. | Fix the criteria in advance (§3.4), ask about past behaviour, and limit hackathon-community recruits. |

### 5.2 Budget approval requirements

No mainnet transaction is sent without a written approval (a message in this repo's session is enough) that states all of the following:

1. The wallet public key of the dedicated experiment wallet.
2. The maximum SOL to fund, and the USD value on the day of approval. The total at risk must be **under $20**: non-refundable rent + order notional + all fees.
3. The exact DLMM pool and DAMM v2 pool addresses, and whether we create a pool (needs a separate yes) or reuse one.
4. Order sides, sizes, bin IDs or prices, and the quoted band for each.
5. The window (passive, 72 hours) and whether one extension is pre-approved.
6. A cap on priority fees per transaction.

Approval covers only the passive window. **The keeper window needs a new approval**, because it sends repeated transactions and spends more on fees.

### 5.3 Stop conditions

**Stop the mainnet experiment immediately (run the cancel drill, then sweep the wallet) if:**
- cumulative spend plus unrealized loss on filled orders reaches the approved cap;
- any transaction behaves differently from its simulation, or fails in a way we cannot explain;
- the observer has a gap longer than 15 minutes, because the window is then no longer valid evidence;
- we suspect the key is exposed;
- the token's DAMM v2 pool changes fee mode or is drained, or the token shows signs of a rug pull;
- the user asks us to stop.

**Stop or redirect the Stage B plan if:**
- B0 shows no third-party fills of class (c) or (d) across the candidate pools. Do not run the passive window. Go straight to the keeper-economics question and decide whether a subsidized product is acceptable (`feasibility.md` §4);
- the B0.7 cost inputs make H4 impossible at under $50 per order (cost per arbitrage transaction above any plausible edge). Then the self-sustaining claim is dropped before any mainnet spend;
- the interviews hit "Fail" (§3.4). Stop product work;
- meeting the plan would require a custom program, an enforced lock or creator fee redirection. Each needs its own explicit decision (CLAUDE.md).

---

## 6. What this plan does not do

- It builds no frontend, changes no production code and deploys nothing.
- It sends no mainnet transaction before §4 is met and §5.2 is approved.
- It does not treat interview enthusiasm, a single fill or a passing B0 as product-market fit.
- It does not promise rewards or a score to anyone.
