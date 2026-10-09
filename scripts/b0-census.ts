// Stage B0.1 + B0.2: read-only mainnet census (docs/stage-b-plan.md §2).
// Lists DLMM LimitOrder accounts, groups them by pool, decodes the pools, and looks up
// DAMM v2 pools for the same token pair with their current fee. Signs and sends nothing.
//
//   MAINNET_READONLY=1 [MAINNET_RPC_URL=…] [RPC_RPS=2] [CENSUS_MAX_PAIRS=0 (all)] npm run b0:census

import { PublicKey } from "@solana/web3.js";
import { createProgram, limitOrderFilter } from "@meteora-ag/dlmm";
import {
  BaseFeeMode,
  POOL_TOKEN_A_MINT_OFFSET,
  POOL_TOKEN_B_MINT_OFFSET,
  TradeDirection,
  cpAmmCoder,
  feeNumeratorToBps,
  getBaseFeeModeFromPodAlignedData,
  getMaxFeeNumerator,
  getPriceFromSqrtPrice,
  getTotalTradingFeeFromIncludedFeeAmount,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";
import { DLMM_FUNCTION_TYPE, KNOWN_PROGRAMS, camelizeKeys, dlmmBaseFeeBps } from "../src/b0.js";
import { dlmmBinPrice } from "../src/pricing.js";
import { connectMainnetReadOnly, writeRun } from "../src/readonly.js";

/** 0 = every pool that has orders. */
const MAX_PAIRS = Number(process.env.CENSUS_MAX_PAIRS ?? 0);
const DLMM = new PublicKey(KNOWN_PROGRAMS.dlmm);
const DAMM = new PublicKey(KNOWN_PROGRAMS.dammV2);
/** Hypothesis, not verified: DBC-migrated DAMM v2 pools record DBC's pool_authority PDA as creator. */
const DBC_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey(KNOWN_PROGRAMS.dbc))[0].toBase58();
/** DAMM v2 pools kept per pair in the run file (deepest by liquidity); the total is always recorded. */
const KEEP_DAMM = 5;

const ro = await connectMainnetReadOnly();
const { connection } = ro;
const slot = await connection.getSlot();
const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
console.log(`RPC ${ro.url} (mainnet-beta, read-only), slot ${slot}`);

// --- B0.1: all LimitOrder accounts, only lb_pair (32) + owner (32) + bin_count (2) ---
const orderAccounts = await connection.getProgramAccounts(DLMM, {
  filters: [limitOrderFilter()],
  dataSlice: { offset: 8, length: 66 },
});
interface Order {
  pubkey: string;
  lbPair: string;
  owner: string;
  binCount: number;
}
const orders: Order[] = orderAccounts.map(({ pubkey, account: { data } }) => ({
  pubkey: pubkey.toBase58(),
  lbPair: new PublicKey(data.subarray(0, 32)).toBase58(),
  owner: new PublicKey(data.subarray(32, 64)).toBase58(),
  binCount: data.readUInt16LE(64),
}));
const byPair = new Map<string, Order[]>();
for (const o of orders) byPair.set(o.lbPair, [...(byPair.get(o.lbPair) ?? []), o]);
console.log(`LimitOrder accounts: ${orders.length} across ${byPair.size} pools, ${new Set(orders.map((o) => o.owner)).size} owners`);

const pairKeys = [...byPair.keys()].map((k) => new PublicKey(k));
const dlmmCoder = createProgram(connection).coder;
const lbPairs = new Map<string, any>();
for (let i = 0; i < pairKeys.length; i += 100) {
  const infos = await connection.getMultipleAccountsInfo(pairKeys.slice(i, i + 100));
  infos.forEach((info, j) => {
    if (info) lbPairs.set(pairKeys[i + j].toBase58(), dlmmCoder.accounts.decode("lbPair", info.data));
  });
}

// Mint decimals (byte 44 of an SPL / Token-2022 mint) and owning token program.
const mintSet = new Set<string>();
for (const p of lbPairs.values()) mintSet.add(p.tokenXMint.toBase58()).add(p.tokenYMint.toBase58());
const mints = new Map<string, { decimals: number; program: string }>();
const mintKeys = [...mintSet].map((m) => new PublicKey(m));
for (let i = 0; i < mintKeys.length; i += 100) {
  const infos = await connection.getMultipleAccountsInfo(mintKeys.slice(i, i + 100));
  infos.forEach((info, j) => {
    if (info) mints.set(mintKeys[i + j].toBase58(), { decimals: info.data[44], program: info.owner.toBase58() });
  });
}

// Mint pair frequency across all order-bearing pools.
const quoteMintCounts: Record<string, number> = {};
for (const p of lbPairs.values()) quoteMintCounts[p.tokenYMint.toBase58()] = (quoteMintCounts[p.tokenYMint.toBase58()] ?? 0) + 1;

const functionTypeCounts: Record<string, number> = {};
for (const p of lbPairs.values()) {
  const t = DLMM_FUNCTION_TYPE[p.parameters.functionType] ?? `unknown(${p.parameters.functionType})`;
  functionTypeCounts[t] = (functionTypeCounts[t] ?? 0) + 1;
}
console.log("Function types of order-bearing DLMM pools:", functionTypeCounts);

// --- B0.2: DAMM v2 pools for the top pairs by order count ---
const ranked = [...byPair.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_PAIRS || undefined);
// cp-amm-sdk exports a raw BorshCoder keyed by the IDL's PascalCase names ("Pool"), unlike
// the DLMM Program coder ("lbPair"). Match the discriminator first so only real decode
// failures are reported, never silently skipped.
const POOL_DISCRIMINATOR = cpAmmCoder.accounts.accountDiscriminator("Pool");
const decodePool = (data: Buffer) => camelizeKeys(cpAmmCoder.accounts.decode("Pool", data));
const dammDecodeErrors: { pool: string; error: string }[] = [];

async function dammPoolsFor(a: PublicKey, b: PublicKey) {
  const out: { pubkey: PublicKey; state: any }[] = [];
  for (const [ma, mb] of [
    [a, b],
    [b, a],
  ]) {
    const res = await connection.getProgramAccounts(DAMM, {
      filters: [
        { memcmp: { offset: POOL_TOKEN_A_MINT_OFFSET, bytes: ma.toBase58() } },
        { memcmp: { offset: POOL_TOKEN_B_MINT_OFFSET, bytes: mb.toBase58() } },
      ],
    });
    for (const r of res) {
      if (!r.account.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) continue; // other account type
      try {
        out.push({ pubkey: r.pubkey, state: decodePool(r.account.data) });
      } catch (e) {
        dammDecodeErrors.push({ pool: r.pubkey.toBase58(), error: (e as Error).message });
      }
    }
  }
  return out;
}

const rows: any[] = [];
const lookupErrors: { lbPair: string; error: string }[] = [];
let runFile: string | undefined;
const t0 = Date.now();
const checkpoint = (complete: boolean, summary?: unknown) =>
  (runFile = writeRun(
    "stage-b0-census",
    {
      kind: "mainnet-observational",
      complete,
      rpc: ro.url,
      startedAt: new Date(blockTime * 1000).toISOString(),
      params: { MAX_PAIRS, dammFeeProbeAmountRaw: 1_000_000 },
      limitOrderAccounts: orders.length,
      poolsWithOrders: byPair.size,
      functionTypeCounts,
      pairsPlanned: ranked.length,
      summary,
      lookupErrors,
      dammDecodeErrors,
      rows,
      rpcStats: ro.stats,
    },
    runFile,
  ));
for (const [pair, pairOrders] of ranked) {
  const p = lbPairs.get(pair);
  if (!p) continue;
  const x = p.tokenXMint.toBase58();
  const y = p.tokenYMint.toBase58();
  const decX = mints.get(x)?.decimals ?? 0;
  const decY = mints.get(y)?.decimals ?? 0;
  const dlmmActivePrice = dlmmBinPrice(p.activeId, p.binStep, decX, decY);
  let damm: Awaited<ReturnType<typeof dammPoolsFor>> = [];
  try {
    damm = await dammPoolsFor(p.tokenXMint, p.tokenYMint);
  } catch (e) {
    lookupErrors.push({ lbPair: pair, error: (e as Error).message });
    console.log(`  ! DAMM v2 lookup failed for ${pair}: ${(e as Error).message}`);
  }
  const dammRows = damm.map(({ pubkey, state: s }) => {
    const aIsX = s.tokenAMint.toBase58() === x;
    const priceAinB = getPriceFromSqrtPrice(s.sqrtPrice, aIsX ? decX : decY, aIsX ? decY : decX);
    const priceXinY = aIsX ? new Decimal(priceAinB.toString()) : new Decimal(1).div(priceAinB.toString());
    const currentPoint = new BN(s.activationType === 0 ? slot : blockTime);
    let totalFeeBps: number | null = null;
    let feeError: string | undefined;
    try {
      const num = getTotalTradingFeeFromIncludedFeeAmount(
        s.poolFees,
        currentPoint,
        s.activationPoint,
        new BN(1_000_000),
        TradeDirection.AtoB,
        getMaxFeeNumerator(s.feeVersion),
        s.poolFees.initSqrtPrice,
        s.sqrtPrice,
      );
      totalFeeBps = feeNumeratorToBps(num);
    } catch (e) {
      feeError = (e as Error).message;
    }
    return {
      pool: pubkey.toBase58(),
      creator: s.creator.toBase58(),
      creatorIsDbcPoolAuthority: s.creator.toBase58() === DBC_POOL_AUTHORITY,
      priceXinY: priceXinY.toSignificantDigits(8).toString(),
      dlmmVsDammRel: dlmmActivePrice.div(priceXinY).minus(1).toSignificantDigits(4).toNumber(),
      totalFeeBpsNow: totalFeeBps,
      baseFeeMode: BaseFeeMode[getBaseFeeModeFromPodAlignedData(Buffer.from(s.poolFees.baseFee.baseFeeInfo.data))],
      dynamicFee: s.poolFees.dynamicFee.initialized !== 0,
      collectFeeMode: s.collectFeeMode,
      liquidity: s.liquidity.toString(),
      poolStatus: s.poolStatus,
      feeError,
    };
  });
  rows.push({
    lbPair: pair,
    functionType: DLMM_FUNCTION_TYPE[p.parameters.functionType] ?? p.parameters.functionType,
    tokenX: x,
    tokenY: y,
    tokenXProgram: mints.get(x)?.program,
    binStep: p.binStep,
    dlmmBaseFeeBps: dlmmBaseFeeBps(p.parameters.baseFactor, p.binStep, p.parameters.baseFeePowerFactor).toNumber(),
    activeId: p.activeId,
    dlmmActivePriceXinY: dlmmActivePrice.toSignificantDigits(8).toString(),
    orderCount: pairOrders.length,
    orderOwners: [...new Set(pairOrders.map((o) => o.owner))],
    orderAccounts: pairOrders.map((o) => o.pubkey),
    dammV2PoolCount: dammRows.length,
    dammV2PoolsFromDbcAuthority: dammRows.filter((d) => d.creatorIsDbcPoolAuthority).length,
    dammV2Pools: [...dammRows].sort((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : -1)).slice(0, KEEP_DAMM),
  });
  const best = dammRows.sort((a, b) => (a.totalFeeBpsNow ?? 1e9) - (b.totalFeeBpsNow ?? 1e9))[0];
  if (rows.length % 50 === 0) {
    checkpoint(false);
    console.log(`  … ${rows.length}/${ranked.length} pools checked (${Math.round((Date.now() - t0) / 1000)} s, ${ro.stats.requests} requests, checkpoint ${runFile})`);
  }
  if (best) console.log(
    `${pair.slice(0, 8)}… ${String(rows.at(-1)!.functionType).padEnd(15)} orders=${String(pairOrders.length).padStart(3)} owners=${rows.at(-1)!.orderOwners.length} ` +
      `binStep=${p.binStep} dlmmFee=${rows.at(-1)!.dlmmBaseFeeBps}bps dammV2=${dammRows.length}` +
      (best ? ` minDammFee=${best.totalFeeBpsNow}bps gap=${(best.dlmmVsDammRel * 100).toFixed(2)}%` : ""),
  );
}

const withDamm = rows.filter((r) => r.dammV2Pools.length > 0);
const summary = {
  slot,
  blockTime,
  limitOrderAccounts: orders.length,
  poolsWithOrders: byPair.size,
  distinctOwners: new Set(orders.map((o) => o.owner)).size,
  functionTypeCounts,
  topQuoteMints: Object.entries(quoteMintCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
  pairsExamined: rows.length,
  pairsWithDammV2: withDamm.length,
  pairsWithDbcAuthorityDammV2: rows.filter((r) => r.dammV2PoolsFromDbcAuthority > 0).length,
  dbcPoolAuthority: DBC_POOL_AUTHORITY,
  dammCreators: Object.entries(
    withDamm.flatMap((r) => r.dammV2Pools.map((d: { creator: string }) => d.creator)).reduce<Record<string, number>>((m: Record<string, number>, c: string) => ((m[c] = (m[c] ?? 0) + 1), m), {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10),
};
console.log("\nSummary:", JSON.stringify(summary, null, 2));
console.log("RPC usage:", ro.stats);
const file = checkpoint(true, { ...summary, lookupErrors: lookupErrors.length, dammDecodeErrors: dammDecodeErrors.length });
console.log(`\nWrote ${file}`);
