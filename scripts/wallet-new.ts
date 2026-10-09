// Creates a dedicated devnet test keypair at KEYPAIR_PATH (default .keys/stage-a.json,
// git-ignored). Prints only the public key. Refuses to overwrite.

import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_KEYPAIR_PATH } from "../src/chain.js";

const p = path.resolve(process.env.KEYPAIR_PATH ?? DEFAULT_KEYPAIR_PATH);
if (fs.existsSync(p)) {
  console.error(`Keypair already exists at ${p}; not overwriting.`);
  process.exit(1);
}
const kp = Keypair.generate();
fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log(`Created devnet test keypair at ${p}`);
console.log(`Public key: ${kp.publicKey.toBase58()}`);
console.log("Fund it with ~1 devnet SOL: https://faucet.solana.com (choose Devnet), then run `npm run inspect`.");
