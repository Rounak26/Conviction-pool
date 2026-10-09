// Stage B0 helper: for given transaction signatures, lists which DLMM pools and which DAMM v2
// pools each one swapped on (from Anchor self-CPI events), plus limit_order_fee on DLMM swaps.
// Used to check that a "damm-dlmm-arb" fill swapped the *paired* DAMM v2 pool, which
// b0-forensics does not record. Read-only; signs and sends nothing.
//
//   MAINNET_READONLY=1 npm run b0:check-txs -- <signature> [<signature> …]

import { createProgram } from "@meteora-ag/dlmm";
import { cpAmmCoder } from "@meteora-ag/cp-amm-sdk";
import { KNOWN_PROGRAMS, cpiEventPayload } from "../src/b0.js";
import { connectMainnetReadOnly, writeRun } from "../src/readonly.js";

const sigs = process.argv.slice(2);
if (!sigs.length) throw new Error("Pass one or more transaction signatures.");

const ro = await connectMainnetReadOnly();
const dlmmEvents = createProgram(ro.connection).coder.events;
const decode = (coder: { decode: (b: string) => any }, b64: string) => {
  try {
    return coder.decode(b64);
  } catch {
    return null;
  }
};

const results = [];
for (const signature of sigs) {
  const tx = await ro.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) {
    results.push({ signature, error: "not found" });
    continue;
  }
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined }).keySegments().flat().map((k) => k.toBase58());
  const dlmmSwaps: { lbPair: string; limitOrderFee: string | null }[] = [];
  const dammSwaps: string[] = [];
  for (const g of tx.meta.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const program = keys[ix.programIdIndex];
      const payload = cpiEventPayload(ix.data);
      if (!payload) continue;
      if (program === KNOWN_PROGRAMS.dlmm) {
        const ev = decode(dlmmEvents, payload);
        if (ev && /swap/i.test(ev.name)) dlmmSwaps.push({ lbPair: ev.data.lbPair.toBase58(), limitOrderFee: ev.data.limitOrderFee?.toString() ?? null });
      } else if (program === KNOWN_PROGRAMS.dammV2) {
        const ev = decode(cpAmmCoder.events, payload);
        if (ev && /swap/i.test(ev.name)) dammSwaps.push(ev.data.pool.toBase58());
      }
    }
  }
  const r = { signature, slot: tx.slot, blockTime: tx.blockTime, signer: keys[0], dlmmSwaps, dammSwaps };
  results.push(r);
  console.log(JSON.stringify(r));
}
console.log(`Wrote ${writeRun("stage-b0-check-txs", { kind: "mainnet-observational", rpc: ro.url, results, rpcStats: ro.stats })}`);
