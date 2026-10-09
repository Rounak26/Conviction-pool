// Stage B0 helper: tests the census hypothesis that a DAMM v2 pool whose `creator` is DBC's
// pool_authority PDA was created by a DBC graduation (migration). For each flagged pool,
// pages its signatures back to the oldest one and checks whether that transaction invoked
// the DBC program. Read-only; signs and sends nothing.
//
//   MAINNET_READONLY=1 [B0_CENSUS=runs/…json] [VERIFY_POOLS=10] [VERIFY_MAX_PAGES=10] npm run b0:verify-dbc

import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { KNOWN_PROGRAMS } from "../src/b0.js";
import { connectMainnetReadOnly, writeRun } from "../src/readonly.js";

const POOLS = Number(process.env.VERIFY_POOLS ?? 10);
const MAX_PAGES = Number(process.env.VERIFY_MAX_PAGES ?? 10);

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
const flagged: { lbPair: string; pool: string }[] = (census.rows as any[])
  .flatMap((r) => r.dammV2Pools.filter((d: any) => d.creatorIsDbcPoolAuthority).map((d: any) => ({ lbPair: r.lbPair, pool: d.pool })))
  .slice(0, POOLS);

const ro = await connectMainnetReadOnly();
const { connection } = ro;
const results = [];
for (const f of flagged) {
  let before: string | undefined;
  let oldest: { signature: string; blockTime?: number | null } | undefined;
  let pages = 0;
  let reachedStart = false;
  while (pages < MAX_PAGES) {
    const page = await connection.getSignaturesForAddress(new PublicKey(f.pool), { before, limit: 1000 });
    pages++;
    if (!page.length) {
      reachedStart = true;
      break;
    }
    oldest = page.at(-1);
    before = oldest!.signature;
    if (page.length < 1000) {
      reachedStart = true;
      break;
    }
  }
  let invokedDbc: boolean | null = null;
  let invokedDammV2: boolean | null = null;
  if (oldest && reachedStart) {
    const tx = await connection.getTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 });
    if (tx) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined }).keySegments().flat().map((k) => k.toBase58());
      const programs = new Set<string>();
      for (const ix of tx.transaction.message.compiledInstructions) programs.add(keys[ix.programIdIndex]);
      for (const g of tx.meta?.innerInstructions ?? []) for (const ix of g.instructions) programs.add(keys[ix.programIdIndex]);
      invokedDbc = programs.has(KNOWN_PROGRAMS.dbc);
      invokedDammV2 = programs.has(KNOWN_PROGRAMS.dammV2);
    }
  }
  const status = !reachedStart
    ? "unverified-history-limit" // more than VERIFY_MAX_PAGES × 1000 signatures; not paged further
    : invokedDbc
      ? "confirmed-dbc-creation"
      : invokedDbc === false
        ? "creation-without-dbc"
        : "creation-tx-unreadable";
  const r = { ...f, status, pages, reachedStart, creationSignature: reachedStart ? oldest?.signature : undefined, creationTime: oldest?.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null, invokedDbc, invokedDammV2 };
  results.push(r);
  console.log(`${f.pool.slice(0, 8)}… reachedStart=${reachedStart} pages=${pages} invokedDbc=${invokedDbc} created=${r.creationTime}`);
}
const summary = {
  censusFile,
  checked: results.length,
  reachedCreation: results.filter((r) => r.reachedStart).length,
  creationInvokedDbc: results.filter((r) => r.invokedDbc).length,
  byStatus: results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}),
  distinctPools: new Set(results.map((r) => r.pool)).size,
};
console.log("\nSummary:", summary);
console.log(`Wrote ${writeRun("stage-b0-verify-dbc", { kind: "mainnet-observational", rpc: ro.url, summary, results, rpcStats: ro.stats })}`);
