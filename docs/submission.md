# Hackathon submission draft

Status: draft, 2026-10-10. Every number below comes from `docs/feasibility.md` §6–§7 or `web/data/*.json`. Check figures again if the data is rebuilt.

## One-liner

**Conviction Pools: launches graduate, conviction begins.** A public book of patient capital for tokens that graduated from Meteora DBC: resting DLMM limit orders, shown against the DAMM v2 reference price, with how far away they wait and how long they have waited.

## Problem

When a token graduates from Meteora's Dynamic Bonding Curve, its price moves to a DAMM v2 pool. After that there is no public place to see who is willing to buy lower or sell higher, how much, and how long they have been waiting. DLMM limit orders can already express that intent, but nobody shows them against the price that matters, and a resting order fills only if someone bridges the two pools.

## What we built

A read-only **Conviction Book** (local web app):

- Lists resting DLMM limit orders per pair, priced against the **DAMM v2 reference**, with a depth chart by distance.
- Classifies each order as `resting`, `crossed, in band`, `arb-fillable` or `filled`, using an explicit **no-fill band** (DAMM fee + DLMM fee). The band is labelled a lower bound.
- Shows **observed** time open (no fake lock) and a transparent, **observational** score: unfilled USD × days open (capped at 90) × proximity. It pays nothing.
- Order preview: the reference price at which an atomic arbitrage could fill a hypothetical order.
- Clearly separated data: a **real mainnet snapshot** (42 pools, 320 orders, 2026-10-09), **labelled synthetic demo data**, and an **Evidence** tab with transaction links.

## What we proved

- **Devnet (Stage A, PASS 26/26 assertions, 0.105 SOL).** A DAMM v2 pool and a DLMM `LimitOrder` pool on the same pair: inside the fee band, an atomic arbitrage is rejected and the order is untouched. Past the band, **one atomic DAMM v2 → DLMM transaction fills the resting bid at a profit** (`3pqrZMKJ…`), and cancel returns proceeds and remainder exactly. No custom program.
- **Mainnet, read-only (Stage B0).** 1,490 limit-order accounts in 544 DLMM pools; 452 pairs also have a DAMM v2 pool. In a 31-pool sample, 17 swaps consumed limit-order liquidity, and **4 were third-party DAMM v2 → DLMM arbitrage** filling other people's orders (`5CifJnLD…`, `3Ld9jk4H…`, `2L4iFDeX…`, `2iXZX4hY…`).
- Measured, not assumed: the effective DLMM fee on the arbitrage leg was 45 bps against a 25 bps base, so the band is wider than the base-fee estimate. The UI says so.

## What we have not proved (stated in the app)

- No order or pool of ours has run on mainnet (Stage B not run).
- Third-party bots filling a **new, small** pool; fill latency; keeper economics at small sizes.
- Any reward funding. The score is observational only.

## How it works (technical)

TypeScript, `@meteora-ag/dlmm` 1.9.14, `@meteora-ag/cp-amm-sdk` 1.5.1, `@solana/web3.js` v1. Pure, unit-tested pricing and book logic (`src/pricing.ts`, `src/book.ts`, 56 tests). Experiments are single-purpose scripts that print signatures. The mainnet observer uses an RPC wrapper with a read-only method allowlist and no key loading, enforced by a unit test. The app server is GET-only on localhost and makes no RPC calls.

## What's next

1. Stage B: one small mainnet pool of our own (under $20 at risk, dedicated wallet), to measure whether anyone else fills it and how fast.
2. Live indexing of limit orders instead of a snapshot.
3. Wallet-connected order placement, only after Stage B.
4. A reward mechanism only after a funding source is validated.

---

# 2-minute demo script

Target 1:55. Screen: the app at `http://127.0.0.1:5173`, browser zoom 110%.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Title bar, banner | "Conviction Pools. When a token graduates from Meteora's bonding curve, its price moves to DAMM v2. We built the Conviction Book: who is waiting to buy lower or sell higher, against that price, and for how long." |
| 0:15–0:40 | Mainnet snapshot, `SV151-USDC` | "This is real mainnet data from October 9th, read-only. About forty-eight thousand dollars of bids and fifty-three thousand of asks, plotted by distance from the DAMM v2 price. The shaded strip is the no-fill band: fees an arbitrageur has to beat. We label it a lower bound, because we measured the real DLMM fee higher on devnet. Every row links to the transaction that opened it." |
| 0:40–0:55 | Pool list → `OP-SOL`, scroll to fills | "Do these orders actually fill? Here, two fills by third-party bots that bought on DAMM v2 and sold into resting DLMM orders in one transaction, signed by wallets that are not order owners in this pool." |
| 0:55–1:20 | Toggle **Demo data** → `FERN/SOL` | "This is labelled synthetic data, to show every state. The reference just fell 6 percent. These bids are crossed but still inside the band, so arbitrage would lose money. These are past it, so an atomic arbitrage can fill them. Time open is observed, not locked: orders can be cancelled any time, and we say so." |
| 1:20–1:35 | Order preview | "The preview tells a maker at which reference price their order becomes fillable. It is local math. There is no wallet in this build on purpose." |
| 1:35–1:55 | Evidence tab | "On devnet we proved the core loop: one atomic transaction fills a resting order profitably, with no custom program. On mainnet we observed it happening in other people's pools. What we haven't shown yet is a pool of our own on mainnet. That is our next step." |

Fallback if something breaks live: `?source=demo&pool=demo-fern` and `?tab=evidence` open the key views directly.

---

# Submission checklist

Requirements below are typical for Colosseum and Meteora-track submissions. **Confirm each against the official hackathon page.** They were not verified from it.

| Item | Status |
|---|---|
| Project name, one-liner, description | Drafted above |
| Public GitHub repository | **Partial.** <https://github.com/Rounak26/Conviction-pool> is public (checked 2026-10-10), but its `main` holds only the Stage A commit (`cd4de2e`). The read-only MVP (app, B0 scripts, these docs) is not pushed yet. |
| Demo video (usually ≤ 3 min) | **Missing.** Script above. |
| Pitch / team video, if required | **Missing.** |
| Live URL | **Missing.** The app is local-only by design. A static host would need the API computed at build time (the server only reads `web/data`), which is not done. |
| Team members, contact, wallet for prizes | **Missing.** Not in repo. |
| LICENSE file | MIT, `LICENSE` (not committed yet). |
| Screenshots / logo | **Missing.** None committed. |
| Track / sponsor selection (Meteora) | To fill in on the form. |
| Technical docs | `README.md`, `docs/feasibility.md`, `docs/stage-b-plan.md` |
| Verifiable on-chain evidence | Devnet and mainnet signatures in `docs/feasibility.md` §6–§7 and the Evidence tab |
