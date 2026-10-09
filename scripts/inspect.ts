// Read-only preflight. Sends no transactions and signs nothing.
// Checks: devnet genesis, program deployments, limit-order support on devnet,
// SDK versions, rent constants, and the test wallet's balance.

import fs from "node:fs";
import path from "node:path";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BIN_ARRAY_BITMAP_FEE, BIN_ARRAY_FEE, POOL_FEE, getAccountDiscriminator } from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { MIN_BALANCE_SOL, PROGRAMS, connectDevnet, loadTestKeypair } from "../src/chain.js";

const version = (pkg: string) =>
  JSON.parse(fs.readFileSync(path.join("node_modules", pkg, "package.json"), "utf8")).version;

const connection = await connectDevnet();
console.log(`RPC: ${connection.kind} (genesis verified)`);

console.log("\nSDK versions:");
for (const pkg of ["@meteora-ag/dlmm", "@meteora-ag/cp-amm-sdk", "@solana/web3.js", "@solana/spl-token"]) {
  console.log(`  ${pkg}@${version(pkg)}`);
}

let ok = true;
console.log("\nPrograms on devnet:");
for (const [name, id] of Object.entries(PROGRAMS)) {
  const info = await connection.getAccountInfo(id);
  const live = !!info?.executable;
  ok &&= live || name === "dbc";
  console.log(`  ${name.padEnd(7)} ${id.toBase58()} ${live ? "deployed" : "MISSING"}`);
}

const orders = await connection.getProgramAccounts(PROGRAMS.dlmm, {
  dataSlice: { offset: 0, length: 0 },
  filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(getAccountDiscriminator("limitOrder"))) } }],
});
console.log(`\nExisting DLMM LimitOrder accounts on devnet: ${orders.length} ${orders.length ? "(limit orders are live)" : "(none found)"}`);
ok &&= orders.length > 0;

console.log("\nSDK rent constants (SOL):");
console.log(`  DLMM pool ${POOL_FEE}, bin array ${BIN_ARRAY_FEE} each, bitmap extension ${BIN_ARRAY_BITMAP_FEE}`);

console.log("\nTest wallet:");
try {
  const kp = loadTestKeypair();
  const bal = (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
  const funded = bal >= MIN_BALANCE_SOL;
  ok &&= funded;
  console.log(`  ${kp.publicKey.toBase58()} balance ${bal} SOL ${funded ? "(sufficient)" : `(need >= ${MIN_BALANCE_SOL}; use https://faucet.solana.com)`}`);
} catch (e) {
  ok = false;
  console.log(`  ${(e as Error).message}`);
}

console.log(`\nEnvironment ${ok ? "VIABLE" : "NOT READY"} for Stage A.`);
process.exit(ok ? 0 : 1);
