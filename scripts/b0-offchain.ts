// Stage B0.5 + B0.6: read-only off-chain probes (docs/stage-b-plan.md §2).
//  - Jupiter quote API (no wallet): does a quote for the pair route through the DLMM pool?
//  - Meteora DLMM Data API: per-wallet limit-order stats (fills, deposits, bonus) for the
//    owners of orders in candidate pools.
// Only HTTP GET requests; the RPC connection is used for the genesis check and nothing else.
//
//   MAINNET_READONLY=1 [RPC_RPS=2] [B0_CENSUS=runs/…json] [OFFCHAIN_POOLS=20]
//   [OFFCHAIN_OWNERS_PER_POOL=5] [JUP_API_URL=https://lite-api.jup.ag/swap/v1]
//   [DATA_API_URL=https://dlmm.datapi.meteora.ag] npm run b0:offchain

import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { KNOWN_PROGRAMS } from "../src/b0.js";
import { connectMainnetReadOnly, writeRun } from "../src/readonly.js";

const POOLS = Number(process.env.OFFCHAIN_POOLS ?? 20);
const OWNERS = Number(process.env.OFFCHAIN_OWNERS_PER_POOL ?? 5);
const JUP = process.env.JUP_API_URL ?? "https://lite-api.jup.ag/swap/v1";
const DATA_API = process.env.DATA_API_URL ?? "https://dlmm.datapi.meteora.ag";

/** Quote sizes for the Y side, in UI units. Other quote tokens are skipped (no price to size from). */
const Y_QUOTE_UI: Record<string, { ui: number; decimals: number; symbol: string }> = {
  So11111111111111111111111111111111111111112: { ui: 0.05, decimals: 9, symbol: "SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { ui: 5, decimals: 6, symbol: "USDC" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { ui: 5, decimals: 6, symbol: "USDT" },
};

const censusFile =
  process.env.B0_CENSUS ??
  fs
    .readdirSync("runs")
    .filter((f) => f.startsWith("stage-b0-census-"))
    .sort()
    .map((f) => path.join("runs", f))
    .at(-1);
if (!censusFile) throw new Error("No census run found. Run `npm run b0:census` first.");
const census = JSON.parse(fs.readFileSync(censusFile, "utf8"));
// Top pools by order count, plus every pair whose DAMM v2 pool has DBC's pool_authority as
// creator (the post-graduation segment; see scripts/b0-verify-dbc.ts for that hypothesis).
const eligible = (census.rows as any[]).filter((r) => r.dammV2Pools.length > 0 && r.functionType !== "LiquidityMining");
const topByOrders = [...eligible].sort((a, b) => b.orderCount - a.orderCount).slice(0, POOLS);
const dbcSegment = eligible.filter((r) => r.dammV2PoolsFromDbcAuthority > 0);
const candidates = [...new Map([...topByOrders, ...dbcSegment].map((r) => [r.lbPair, r])).values()].map((r) => ({
  ...r,
  segment: r.dammV2PoolsFromDbcAuthority > 0 ? "dbc-authority" : "top-by-orders",
}));

const ro = await connectMainnetReadOnly();
const get = ro.httpGetJson;

const labels = await get(`${JUP}/program-id-to-label`);
const dlmmLabel = (labels.body as Record<string, string>)?.[KNOWN_PROGRAMS.dlmm] ?? "Meteora DLMM";
console.log(`Jupiter ${JUP} (labels HTTP ${labels.status}); DLMM label "${dlmmLabel}". Census ${censusFile}: ${candidates.length} pools`);

function summarizeQuote(res: { status: number; body: any }, lbPair: string) {
  const plan = res.body?.routePlan as any[] | undefined;
  if (res.status !== 200 || !plan) return { status: res.status, error: res.body?.error ?? res.body?.errorCode ?? String(res.body).slice(0, 200) };
  return {
    status: res.status,
    outAmount: res.body.outAmount,
    priceImpactPct: res.body.priceImpactPct,
    hops: plan.map((h) => ({ ammKey: h.swapInfo?.ammKey, label: h.swapInfo?.label, percent: h.percent ?? h.bps })),
    usesOurDlmmPool: plan.some((h) => h.swapInfo?.ammKey === lbPair),
    usesAnyDammV2: plan.some((h) => h.swapInfo?.label === "Meteora DAMM v2"),
  };
}

const quote = (inputMint: string, outputMint: string, amount: string, extra = "") =>
  get(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100${extra}`);

const rows = [];
for (const c of candidates) {
  const y = Y_QUOTE_UI[c.tokenY];
  const row: any = { lbPair: c.lbPair, segment: c.segment, tokenX: c.tokenX, tokenY: c.tokenY, orderCount: c.orderCount };

  // --- B0.6 Jupiter ---
  if (!y) {
    row.jupiter = { skipped: "quote token not SOL/USDC/USDT" };
  } else {
    const yRaw = new Decimal(y.ui).mul(new Decimal(10).pow(y.decimals)).floor().toFixed();
    const restricted = `&dexes=${encodeURIComponent(dlmmLabel)}&onlyDirectRoutes=true`;
    row.jupiter = {
      sizeY: `${y.ui} ${y.symbol}`,
      buyX_default: summarizeQuote(await quote(c.tokenY, c.tokenX, yRaw), c.lbPair),
      buyX_dlmmOnly: summarizeQuote(await quote(c.tokenY, c.tokenX, yRaw, restricted), c.lbPair),
    };
    // Sell-side size: the X that buyX_default returned, so both directions are about the same value.
    const xOut = row.jupiter.buyX_default.outAmount;
    if (xOut) {
      row.jupiter.sellX_default = summarizeQuote(await quote(c.tokenX, c.tokenY, xOut), c.lbPair);
      row.jupiter.sellX_dlmmOnly = summarizeQuote(await quote(c.tokenX, c.tokenY, xOut, restricted), c.lbPair);
    }
  }

  // --- B0.5 Data API: per-owner stats for this pool (open and closed orders) ---
  row.owners = [];
  for (const w of (c.orderOwners as string[]).slice(0, OWNERS)) {
    const open = await get(`${DATA_API}/wallets/${w}/limit_orders/open/pools/${c.lbPair}`);
    const closed = await get(`${DATA_API}/wallets/${w}/limit_orders/closed/pools/${c.lbPair}`);
    row.owners.push({ wallet: w, open: open.body, openStatus: open.status, closed: closed.body, closedStatus: closed.status });
  }

  const j = row.jupiter;
  console.log(
    `${c.lbPair.slice(0, 8)}… orders=${c.orderCount} ` +
      (j.skipped
        ? `jupiter skipped (${j.skipped})`
        : `buyX: ours=${j.buyX_default.usesOurDlmmPool ?? j.buyX_default.status} dlmmOnly=${j.buyX_dlmmOnly.usesOurDlmmPool ?? j.buyX_dlmmOnly.status} ` +
          `sellX: ours=${j.sellX_default?.usesOurDlmmPool ?? "-"} dlmmOnly=${j.sellX_dlmmOnly?.usesOurDlmmPool ?? "-"}`),
  );
  rows.push(row);
}

const quoted = rows.filter((r) => !r.jupiter.skipped);
const summary = {
  censusFile,
  pools: rows.length,
  jupiterQuoted: quoted.length,
  defaultRouteUsesOurPool: {
    buyX: quoted.filter((r) => r.jupiter.buyX_default.usesOurDlmmPool).length,
    sellX: quoted.filter((r) => r.jupiter.sellX_default?.usesOurDlmmPool).length,
  },
  dlmmOnlyRouteFindsOurPool: {
    buyX: quoted.filter((r) => r.jupiter.buyX_dlmmOnly.usesOurDlmmPool).length,
    sellX: quoted.filter((r) => r.jupiter.sellX_dlmmOnly?.usesOurDlmmPool).length,
  },
};
console.log("\nSummary:", JSON.stringify(summary, null, 2));
const file = writeRun("stage-b0-offchain", {
  kind: "mainnet-observational (off-chain APIs)",
  sources: { jupiter: JUP, dataApi: DATA_API },
  generatedAt: new Date().toISOString(),
  params: { POOLS, OWNERS, Y_QUOTE_UI },
  summary,
  rows,
});
console.log(`\nWrote ${file}`);
