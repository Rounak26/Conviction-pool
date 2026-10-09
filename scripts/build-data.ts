// Builds the frontend's data files from local evidence. No network, no chain I/O.
//
//   npm run data
//
//  web/data/mainnet-snapshot.json  Real mainnet data from the Stage B0 read-only runs (runs/*.json):
//                                  open limit orders (Meteora Data API), DAMM v2 reference price and
//                                  fee (census), DBC origin (verify-dbc), recent fills (forensics).
//                                  Owner wallets are shortened. Skipped if the B0 runs are missing.
//  web/data/demo.json              Synthetic pools and orders, deterministic, labelled DEMO.
//  web/data/evidence.json          Stage A devnet signatures and B0 headline numbers.

import fs from "node:fs";
import path from "node:path";
import type { BookOrder, DbcOrigin, PoolActivity, PoolSnapshot } from "../src/book.js";

const OUT = path.join("web", "data");
fs.mkdirSync(OUT, { recursive: true });

const latest = (prefix: string, exclude: string[] = []) =>
  fs.existsSync("runs")
    ? fs
        .readdirSync("runs")
        .filter((f) => f.startsWith(prefix) && !exclude.includes(f))
        .sort()
        .map((f) => path.join("runs", f))
        .at(-1)
    : undefined;
const readJson = (f: string | undefined) => (f ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined);
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const write = (name: string, data: unknown) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  console.log(`wrote ${file}`);
};

// ---------------------------------------------------------------- mainnet snapshot
// Superseded census runs (debug, decode bug, smoke test) are never used.
const SUPERSEDED = ["stage-b0-census-2026-10-09T13-10-34-947Z.json", "stage-b0-census-2026-10-09T16-57-35-430Z.json", "stage-b0-census-2026-10-09T17-06-45-696Z.json"];
const censusFile = latest("stage-b0-census-", SUPERSEDED);
const offchainFile = latest("stage-b0-offchain-");
const verifyFile = latest("stage-b0-verify-dbc-");
const forensicsFile = latest("stage-b0-forensics-");

if (!censusFile || !offchainFile) {
  console.log("B0 census/offchain runs not found under runs/; keeping the existing web/data/mainnet-snapshot.json.");
} else {
  const census = readJson(censusFile);
  const offchain = readJson(offchainFile);
  const verify = readJson(verifyFile);
  const forensics = readJson(forensicsFile);
  const censusByPair = new Map<string, any>(census.rows.map((r: any) => [r.lbPair, r]));
  const verifyByPool = new Map<string, string>((verify?.results ?? []).map((r: any) => [r.pool, r.reachedStart ? (r.invokedDbc ? "confirmed" : "none") : "unverified-history-limit"]));
  const forensicsByPair = new Map<string, any>((forensics?.pools ?? []).map((p: any) => [p.lbPair, p]));
  const asOf = Math.floor(Date.parse(offchain.generatedAt) / 1000);

  const pools: PoolSnapshot[] = [];
  for (const row of offchain.rows) {
    const c = censusByPair.get(row.lbPair);
    if (!c || !c.dammV2Pools.length) continue;
    const ref = c.dammV2Pools[0]; // deepest DAMM v2 pool by liquidity for this pair
    const dbcPool = c.dammV2Pools.find((d: any) => d.creatorIsDbcPoolAuthority);
    const dbcOrigin: DbcOrigin = dbcPool ? ((verifyByPool.get(dbcPool.pool) as DbcOrigin) ?? "dbc-authority-unchecked") : "none";

    const orders: BookOrder[] = [];
    let meta: any;
    let truncated = 0;
    for (const o of row.owners) {
      const body = o.open;
      if (!body || typeof body !== "object" || !Array.isArray(body.data)) continue;
      meta ??= body;
      if ((body.total ?? 0) > body.data.length) truncated++;
      for (const d of body.data) {
        const lo = Number(d.lower_pool_price);
        const hi = Number(d.upper_pool_price);
        if (!(lo > 0 && hi > 0)) continue;
        orders.push({
          id: d.limit_order_address,
          owner: short(d.user_address),
          side: d.is_ask_side ? "ask" : "bid",
          priceLow: Math.min(lo, hi),
          priceHigh: Math.max(lo, hi),
          sizeInput: Number(d.input_amount),
          inputToken: d.input_token || short(d.input_token_mint ?? ""),
          // The Data API reports 0 USD for tokens it cannot price: treat that as unknown, not zero.
          sizeUsd: Number(d.input_amount_usd) > 0 ? Number(d.input_amount_usd) : null,
          filledPct: Number(d.filled_pct ?? 0),
          openedAt: Number(d.opened_at),
          openedSignature: d.opened_at_signature,
        });
      }
    }
    if (!orders.length || !meta) continue;

    const f = forensicsByPair.get(row.lbPair);
    let activity: PoolActivity | undefined;
    if (f) {
      const fills: Record<string, number> = {};
      const fillTxs = f.swaps.filter((s: any) => s.consumedLimitOrderLiquidity);
      for (const s of fillTxs) fills[s.class] = (fills[s.class] ?? 0) + 1;
      activity = {
        orderFillsByClass: fills,
        fills: fillTxs.map((s: any) => ({ signature: s.signature, class: s.class, blockTime: s.blockTime ?? null })).sort((a: any, b: any) => (b.blockTime ?? 0) - (a.blockTime ?? 0)),
        swapTxs: f.swapTxs,
        windowStart: f.window.oldest,
        windowEnd: f.window.newest,
      };
    }
    const ownersQueried = row.owners.length;
    const ownersTotal = c.orderOwners.length;
    pools.push({
      id: row.lbPair,
      source: "mainnet-snapshot",
      name: meta.pool?.pair_name || `${meta.pool?.token_x || short(c.tokenX)}-${meta.pool?.token_y || short(c.tokenY)}`,
      tokenX: meta.pool?.token_x || short(c.tokenX),
      tokenY: meta.pool?.token_y || short(c.tokenY),
      tokenXMint: c.tokenX,
      tokenYMint: c.tokenY,
      lbPair: row.lbPair,
      dammPool: ref.pool,
      refPrice: Number(ref.priceXinY),
      refFeeBps: ref.totalFeeBpsNow ?? 0,
      dlmmBaseFeeBps: c.dlmmBaseFeeBps,
      binStep: c.binStep,
      dlmmActivePrice: meta.current_pool_price == null ? null : Number(meta.current_pool_price),
      asOf,
      dbcOrigin,
      coverage:
        `Open orders from the Meteora Data API for ${ownersQueried} of ${ownersTotal} order owners` +
        (truncated ? `; ${truncated} owner(s) had more than one page and only the first 20 orders were read` : "") +
        `. On-chain census count: ${c.orderCount} order accounts.`,
      activity,
      orders,
    });
  }
  // Order: pools with a readable book first (≥ 2 priced orders, DLMM within 20% of the reference),
  // then DBC-confirmed, DBC-unverified, the rest; drifted pools last; then by priced USD.
  const rank = (p: PoolSnapshot) => ({ confirmed: 0, "unverified-history-limit": 1, "dbc-authority-unchecked": 1 } as Record<string, number>)[p.dbcOrigin] ?? 2;
  const drifted = (p: PoolSnapshot) => (p.dlmmActivePrice == null ? 0 : Math.abs(Math.log(p.dlmmActivePrice / p.refPrice)) > Math.log(1.2) ? 1 : 0);
  const pricedUsd = (p: PoolSnapshot) => p.orders.reduce((t, o) => t + (o.sizeUsd ?? 0), 0);
  const showcase = (p: PoolSnapshot) => (p.orders.filter((o) => o.sizeUsd != null).length >= 2 && !drifted(p) ? 0 : 1);
  pools.sort((a, b) => showcase(a) - showcase(b) || rank(a) - rank(b) || drifted(a) - drifted(b) || pricedUsd(b) - pricedUsd(a));
  write("mainnet-snapshot.json", {
    source: "mainnet-snapshot",
    label: "Mainnet snapshot, 2026-10-09 (read-only, not live)",
    takenAt: offchain.generatedAt,
    referencePriceAt: census.startedAt,
    caveats: [
      "Read-only snapshot, not live. Prices and orders have changed since.",
      "Order lists come from the Meteora Data API, which only lists orders per wallet: up to 5 owners per pool, first page each. Pools can hold more orders than shown.",
      "USD sizes are the Data API's own pricing. Where it reports $0 for a non-zero order (an unpriced token), the size is shown as unknown.",
      "The reference is the deepest DAMM v2 pool for the pair at the census slot. Its fee is a snapshot (scheduled and dynamic fees change).",
      "The no-fill band uses base fees only, so it is a lower bound.",
    ],
    evidence: { census: censusFile, offchain: offchainFile, verifyDbc: verifyFile ?? null, forensics: forensicsFile ?? null },
    pools,
  });
}

// ---------------------------------------------------------------- demo data
// Deterministic PRNG so the demo looks the same on every run.
let seed = 0x5eed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
// A fixed synthetic clock, deliberately a round date before any real observation, so it cannot be read as one.
const DEMO_AS_OF = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);

function demoPool(id: string, name: string, x: string, y: string, ref: number, refFeeBps: number, dlmmFeeBps: number, usdPerY: number, n: number, crossed?: { side: "bid" | "ask"; moveTo: number }): PoolSnapshot {
  const orders: BookOrder[] = [];
  for (let i = 0; i < n; i++) {
    const side = rand() < 0.62 ? "bid" : "ask";
    const dist = 0.01 + rand() ** 1.6 * 0.4; // most orders near the reference, a tail far away
    const edge = side === "bid" ? ref * (1 - dist) : ref * (1 + dist);
    const spread = 0.005 + rand() * 0.06;
    const lo = side === "bid" ? edge * (1 - spread) : edge;
    const hi = side === "bid" ? edge : edge * (1 + spread);
    const usd = Math.round(20 + rand() ** 2.2 * 6000);
    const ageDays = rand() ** 1.5 * 120;
    const filled = rand() < 0.15 ? Math.round(rand() * 100) : 0;
    orders.push({
      id: `${id}-order-${i + 1}`,
      owner: `demo…${(1000 + Math.floor(rand() * 9000)).toString()}`,
      side,
      priceLow: lo,
      priceHigh: hi,
      sizeInput: side === "bid" ? usd / usdPerY : usd / (edge * usdPerY),
      inputToken: side === "bid" ? y : x,
      sizeUsd: usd,
      filledPct: filled,
      openedAt: Math.floor(DEMO_AS_OF - ageDays * 86_400),
    });
  }
  return {
    id,
    source: "demo",
    name,
    tokenX: x,
    tokenY: y,
    refPrice: crossed ? crossed.moveTo : ref,
    refFeeBps,
    dlmmBaseFeeBps: dlmmFeeBps,
    binStep: pick([20, 25, 50, 80]),
    dlmmActivePrice: ref,
    asOf: DEMO_AS_OF,
    dbcOrigin: "demo",
    coverage: "Synthetic orders generated by scripts/build-data.ts. Not real.",
    activity: undefined,
    orders,
  };
}

function withOrders(p: PoolSnapshot, extra: BookOrder[]): PoolSnapshot {
  return { ...p, orders: [...p.orders, ...extra] };
}

write("demo.json", {
  source: "demo",
  label: "DEMO: synthetic data",
  takenAt: new Date(DEMO_AS_OF * 1000).toISOString(),
  referencePriceAt: new Date(DEMO_AS_OF * 1000).toISOString(),
  caveats: [
    "Every pool, order, wallet and price in this dataset is synthetic. It exists to demonstrate the interface.",
    "Its timestamps use a fixed synthetic clock (2026-01-01 00:00 UTC). They are not observation times.",
  ],
  evidence: {},
  pools: [
    demoPool("demo-moth", "MOTH/SOL (demo)", "MOTH", "SOL", 0.000042, 100, 25, 150, 28),
    demoPool("demo-kite", "KITE/USDC (demo)", "KITE", "USDC", 0.0185, 30, 20, 1, 22),
    // The reference has just dropped 6%: shows crossed-in-band and arb-fillable bids.
    withOrders(demoPool("demo-fern", "FERN/SOL (demo, reference just fell 6%)", "FERN", "SOL", 0.0009, 50, 25, 150, 18, { side: "bid", moveTo: 0.0009 * 0.94 }), [
      // Two bids the reference has crossed by less than the 0.75% band: arbitrage would lose money filling them.
      { id: "demo-fern-in-band-1", owner: "demo…2718", side: "bid", priceLow: 0.0009 * 0.94 * 1.0005, priceHigh: 0.0009 * 0.94 * 1.004, sizeInput: 1200 / 150, inputToken: "SOL", sizeUsd: 1200, filledPct: 0, openedAt: DEMO_AS_OF - 41 * 86_400 },
      { id: "demo-fern-in-band-2", owner: "demo…3141", side: "bid", priceLow: 0.0009 * 0.94 * 1.001, priceHigh: 0.0009 * 0.94 * 1.006, sizeInput: 640 / 150, inputToken: "SOL", sizeUsd: 640, filledPct: 0, openedAt: DEMO_AS_OF - 12 * 86_400 },
    ]),
  ],
});

// ---------------------------------------------------------------- evidence
const stageAFile = latest("stage-a-devnet-");
const stageA = readJson(stageAFile);
const prevEvidence = readJson(fs.existsSync(path.join(OUT, "evidence.json")) ? path.join(OUT, "evidence.json") : undefined);
const forensicsSummary = readJson(forensicsFile)?.pools;
// Count fills by distinct transaction: one tx that consumed orders in two sampled pools is one fill event.
const distinctSigs = (pred: (s: any) => boolean) => new Set((forensicsSummary ?? []).flatMap((p: any) => p.swaps.filter(pred).map((s: any) => s.signature))).size;
// Third-party DAMM v2 -> DLMM arbitrage transactions that consumed limit-order liquidity (B0-6/B0-7).
const arbFills = (forensicsSummary ?? []).flatMap((p: any) =>
  p.swaps
    .filter((s: any) => s.class === "damm-dlmm-arb" && s.consumedLimitOrderLiquidity)
    .map((s: any) => ({ lbPair: p.lbPair, signature: s.signature, blockTime: s.blockTime ?? null, signer: s.signer ?? null })),
);
write("evidence.json", {
  stageA:
    stageA && stageA.verdict
      ? {
          cluster: "devnet",
          verdict: stageA.verdict,
          assertions: `${stageA.assertions.filter((a: any) => a.pass).length}/${stageA.assertions.length}`,
          solSpent: stageA.solSpent,
          runFile: stageAFile,
          steps: stageA.steps.map((s: any) => ({ name: s.name, status: s.status, signature: s.signature ?? null })),
        }
      : (prevEvidence?.stageA ?? null),
  b0: censusFile
    ? {
        takenAt: readJson(offchainFile)?.generatedAt,
        census: readJson(censusFile).summary,
        forensics: forensicsSummary
          ? {
              poolsExamined: forensicsSummary.length,
              complete: readJson(forensicsFile).complete === true,
              thirdPartyArbOrderFills: distinctSigs((s) => s.class === "damm-dlmm-arb" && s.consumedLimitOrderLiquidity),
              orderFills: distinctSigs((s) => s.consumedLimitOrderLiquidity),
              arbFills,
            }
          : null,
        files: { census: censusFile, offchain: offchainFile, verifyDbc: verifyFile, forensics: forensicsFile },
        report: "docs/feasibility.md §7",
      }
    : (prevEvidence?.b0 ?? null),
});
