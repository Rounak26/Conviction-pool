// Stage B0.3 (+ B0.5 and B0.7 inputs): read-only fill forensics (docs/stage-b-plan.md §2).
// For DLMM pools from the latest census that have both resting limit orders and a DAMM v2
// pool for the same pair, fetch recent transactions, decode DLMM swap events, and classify
// who swapped and whether the swap consumed limit-order liquidity (Swap2Evt.limit_order_fee).
// Signs and sends nothing.
//
//   MAINNET_READONLY=1 [MAINNET_RPC_URL=…] [RPC_RPS=2] [B0_CENSUS=runs/…json]
//   [FORENSICS_POOLS=12] [FORENSICS_SIGS=100] [FORENSICS_FAILED_SAMPLE=10] npm run b0:forensics

import fs from "node:fs";
import path from "node:path";
import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { createProgram } from "@meteora-ag/dlmm";
import { cpAmmCoder } from "@meteora-ag/cp-amm-sdk";
import { KNOWN_PROGRAMS, classifySwapTx, cpiEventPayload, ownerTokenDeltas, percentile, priorityFeeLamports, routerCandidates, type SwapClass } from "../src/b0.js";
import { connectMainnetReadOnly, writeRun } from "../src/readonly.js";

const POOLS = Number(process.env.FORENSICS_POOLS ?? 12);
const SIGS = Number(process.env.FORENSICS_SIGS ?? 100);
const FAILED_SAMPLE = Number(process.env.FORENSICS_FAILED_SAMPLE ?? 10);

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
console.log(`Census ${censusFile}: ${candidates.length} candidate pools (orders + DAMM v2 pair)`);

const ro = await connectMainnetReadOnly();
const { connection } = ro;
const dlmmCoder = createProgram(connection).coder;

interface DecodedEvent {
  program: "dlmm" | "dammV2";
  name: string;
  data: any;
}

function accountKeys(tx: VersionedTransactionResponse): string[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  return keys.keySegments().flat().map((k) => k.toBase58());
}

let eventDecodeErrors = 0;
/** Event decode that never throws: a foreign payload can match a discriminator and overrun. */
function safeDecode(coder: { decode: (b64: string) => any }, b64: string) {
  try {
    return coder.decode(b64);
  } catch {
    eventDecodeErrors++;
    return null;
  }
}

function decodeEvents(tx: VersionedTransactionResponse, keys: string[]): { programs: Set<string>; events: DecodedEvent[] } {
  const programs = new Set<string>();
  const events: DecodedEvent[] = [];
  for (const ix of tx.transaction.message.compiledInstructions) programs.add(keys[ix.programIdIndex]);
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex];
      programs.add(program);
      const payload = cpiEventPayload(ix.data);
      if (!payload) continue;
      if (program === KNOWN_PROGRAMS.dlmm) {
        const ev = safeDecode(dlmmCoder.events, payload);
        if (ev) events.push({ program: "dlmm", name: ev.name, data: ev.data });
      } else if (program === KNOWN_PROGRAMS.dammV2) {
        const ev = safeDecode(cpAmmCoder.events, payload);
        if (ev) events.push({ program: "dammV2", name: ev.name, data: ev.data });
      }
    }
  }
  // Older instructions emit through logs ("Program data: <base64>") instead of self-CPI.
  for (const line of tx.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length);
    const dl = safeDecode(dlmmCoder.events, b64);
    if (dl) events.push({ program: "dlmm", name: dl.name, data: dl.data });
  }
  return { programs, events };
}

const str = (v: any) => (v == null ? v : v.toString());
const isDlmmSwap = (e: DecodedEvent) => e.program === "dlmm" && (e.name === "swap" || e.name === "swap2Evt" || e.name === "Swap" || e.name === "Swap2Evt");
const isDammSwap = (e: DecodedEvent) => e.program === "dammV2" && /swap/i.test(e.name);

const poolReports: any[] = [];
let runFile: string | undefined;
for (const c of candidates) {
  const lbPair = new PublicKey(c.lbPair);
  const owners = new Set<string>(c.orderOwners);
  const sigs = await connection.getSignaturesForAddress(lbPair, { limit: SIGS });
  const ok = sigs.filter((s) => !s.err);
  const failed = sigs.filter((s) => s.err);
  const toFetch = [...ok, ...failed.slice(0, FAILED_SAMPLE)];

  const swaps = [];
  const failedSamples = [];
  const otherTxKinds: Record<string, number> = {};
  // web3.js 1.x parses legacy and v0 messages only; mainnet also carries v1 transactions.
  // Those (and any other fetch error) are counted, not decoded, so the run continues.
  const fetchErrors: Record<string, number> = {};
  for (const s of toFetch) {
    let tx: VersionedTransactionResponse | null;
    try {
      tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      const msg = (e as Error).message;
      const k = /version \(1\) is not supported/.test(msg) ? "unsupported-tx-version-1" : msg.slice(0, 80);
      fetchErrors[k] = (fetchErrors[k] ?? 0) + 1;
      continue;
    }
    if (!tx?.meta) {
      fetchErrors["not-found"] = (fetchErrors["not-found"] ?? 0) + 1;
      continue;
    }
    const keys = accountKeys(tx);
    const signer = keys[0];
    const { programs, events } = decodeEvents(tx, keys);
    const dlmmSwaps = events.filter((e) => isDlmmSwap(e) && e.data.lbPair?.toBase58() === c.lbPair);
    const dammSwaps = events.filter(isDammSwap);
    if (s.err) {
      failedSamples.push({
        signature: s.signature,
        blockTime: tx.blockTime,
        signer,
        signerIsOrderOwner: owners.has(signer),
        routerCandidates: routerCandidates(programs),
        dammV2Invoked: programs.has(KNOWN_PROGRAMS.dammV2),
        jupiterInvoked: programs.has(KNOWN_PROGRAMS.jupiterV6),
        err: JSON.stringify(s.err),
      });
      continue;
    }
    if (!dlmmSwaps.length) {
      const names = events.filter((e) => e.program === "dlmm").map((e) => e.name);
      const k = names.length ? [...new Set(names)].sort().join("+") : "no-dlmm-event";
      otherTxKinds[k] = (otherTxKinds[k] ?? 0) + 1;
      continue;
    }
    const cls: SwapClass = classifySwapTx({ signer, programs, dlmmSwapCount: dlmmSwaps.length, dammSwapCount: dammSwaps.length }, owners);
    const limitOrderFee = dlmmSwaps.reduce((sum, e) => sum + BigInt(str(e.data.limitOrderFee) ?? 0), 0n);
    const hasSwap2 = dlmmSwaps.some((e) => e.data.limitOrderFee != null);
    const signerIdx = 0;
    swaps.push({
      signature: s.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      signer,
      class: cls,
      routerCandidates: routerCandidates(programs),
      consumedLimitOrderLiquidity: hasSwap2 ? limitOrderFee > 0n : null,
      limitOrderFee: hasSwap2 ? limitOrderFee : null,
      dlmmSwaps: dlmmSwaps.map((e) => ({
        event: e.name,
        swapForY: e.data.swapForY,
        startBinId: e.data.startBinId,
        endBinId: e.data.endBinId,
        amountIn: str(e.data.amountIn),
        amountOut: str(e.data.amountOut),
        feeBps: str(e.data.feeBps),
        mmFee: str(e.data.mmFee ?? e.data.fee),
        protocolFee: str(e.data.protocolFee),
        limitOrderFee: str(e.data.limitOrderFee),
      })),
      dammV2SwapCount: dammSwaps.length,
      feeLamports: tx.meta.fee,
      priorityFeeLamports: priorityFeeLamports(tx.meta.fee, tx.transaction.signatures.length),
      computeUnits: tx.meta.computeUnitsConsumed,
      signerTokenDeltas: ownerTokenDeltas(signer, tx.meta.preTokenBalances as any, tx.meta.postTokenBalances as any),
      signerLamportDeltaExFee: tx.meta.postBalances[signerIdx] - tx.meta.preBalances[signerIdx] + tx.meta.fee,
    });
  }

  // B0.7: recent per-slot minimum priority fees for transactions writing these accounts.
  const prio = await connection.getRecentPrioritizationFees({
    lockedWritableAccounts: [lbPair, new PublicKey((c.dammV2Pools.find((d: any) => d.creatorIsDbcPoolAuthority) ?? c.dammV2Pools[0]).pool)],
  });
  const prioValues = prio.map((p) => p.prioritizationFee);

  const byClass: Record<string, { swaps: number; fills: number }> = {};
  for (const s of swaps) {
    byClass[s.class] ??= { swaps: 0, fills: 0 };
    byClass[s.class].swaps++;
    if (s.consumedLimitOrderLiquidity) byClass[s.class].fills++;
  }
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => t != null);
  const report = {
    lbPair: c.lbPair,
    segment: c.segment,
    tokenX: c.tokenX,
    tokenY: c.tokenY,
    functionType: c.functionType,
    orderCount: c.orderCount,
    orderOwners: c.orderOwners.length,
    dammV2Pools: c.dammV2Pools.map((d: any) => ({ pool: d.pool, creatorIsDbcPoolAuthority: d.creatorIsDbcPoolAuthority, totalFeeBpsNow: d.totalFeeBpsNow, dlmmVsDammRel: d.dlmmVsDammRel })),
    window: {
      signatures: sigs.length,
      oldest: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null,
      newest: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
      reachedLimit: sigs.length === SIGS,
    },
    failedTxs: failed.length,
    swapTxs: swaps.length,
    byClass,
    otherTxKinds,
    fetchErrors,
    recentPriorityFeeMicroLamportsPerCu: {
      slots: prioValues.length,
      p50: percentile(prioValues, 50),
      p90: percentile(prioValues, 90),
      max: prioValues.length ? Math.max(...prioValues) : null,
    },
    swaps,
    failedSamples,
  };
  poolReports.push(report);
  runFile = writeRun("stage-b0-forensics", { kind: "mainnet-observational", complete: false, rpc: ro.url, censusFile, params: { POOLS, SIGS, FAILED_SAMPLE }, poolsPlanned: candidates.length, eventDecodeErrors, pools: poolReports, rpcStats: ro.stats }, runFile);
  console.log(
    `${c.lbPair.slice(0, 8)}… orders=${c.orderCount} window=${report.window.oldest?.slice(0, 16)}→${report.window.newest?.slice(0, 16)} ` +
      `sigs=${sigs.length} failed=${failed.length} swaps=${swaps.length} ${JSON.stringify(byClass)}`,
  );
}

const totals: Record<string, { swaps: number; fills: number }> = {};
for (const r of poolReports)
  for (const [k, v] of Object.entries(r.byClass as Record<string, { swaps: number; fills: number }>)) {
    totals[k] ??= { swaps: 0, fills: 0 };
    totals[k].swaps += v.swaps;
    totals[k].fills += v.fills;
  }
const thirdPartyArbFills = poolReports.flatMap((r) => r.swaps.filter((s: any) => s.class === "damm-dlmm-arb" && s.consumedLimitOrderLiquidity));
const summary = {
  censusFile,
  poolsExamined: poolReports.length,
  bySegment: Object.fromEntries(
    ["top-by-orders", "dbc-authority"].map((seg) => {
      const rs = poolReports.filter((r) => r.segment === seg);
      const sw = rs.flatMap((r) => r.swaps);
      return [seg, { pools: rs.length, swapTxs: sw.length, fills: sw.filter((x) => x.consumedLimitOrderLiquidity).length, thirdPartyArbFills: sw.filter((x) => x.class === "damm-dlmm-arb" && x.consumedLimitOrderLiquidity).length, poolsWithAnySwap: rs.filter((r) => r.swapTxs > 0).length }];
    }),
  ),
  totalsByClass: totals,
  thirdPartyArbFills: thirdPartyArbFills.length,
  thirdPartyArbFillSigners: [...new Set(thirdPartyArbFills.map((s) => s.signer))].length,
  failedTxsSeen: poolReports.reduce((n, r) => n + r.failedTxs, 0),
  eventDecodeErrors,
  txsNotDecoded: poolReports.reduce<Record<string, number>>((m, r) => {
    for (const [k, v] of Object.entries(r.fetchErrors as Record<string, number>)) m[k] = (m[k] ?? 0) + v;
    return m;
  }, {}),
};
console.log("\nSummary:", JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("RPC usage:", ro.stats);
const file = writeRun(
  "stage-b0-forensics",
  { kind: "mainnet-observational", complete: true, rpc: ro.url, generatedAt: new Date().toISOString(), params: { POOLS, SIGS, FAILED_SAMPLE }, summary, pools: poolReports, rpcStats: ro.stats },
  runFile,
);
console.log(`\nWrote ${file}`);
