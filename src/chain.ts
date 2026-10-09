// Thin chain I/O: devnet-only connection, local test keypair loading, and a
// simulate-then-send recorder that logs every transaction to a JSON run file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_KEYPAIR_PATH = ".keys/stage-a.json";
/** Stage A budget: pools, bin arrays, order rent, role wallets, fees (see README). */
export const MIN_BALANCE_SOL = 0.6;

export const PROGRAMS = {
  dlmm: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  dammV2: new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
  dbc: new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
} as const;

export type ClusterKind = "devnet" | "localnet-rehearsal";

/**
 * Connects to RPC_URL and refuses to continue unless it is Solana devnet.
 * LOCALNET=1 additionally allows a localhost validator (programs cloned from devnet);
 * results from it are a rehearsal, never Stage A evidence.
 */
export async function connectDevnet(): Promise<Connection & { kind: ClusterKind }> {
  const url = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const connection = new Connection(url, "confirmed") as Connection & { kind: ClusterKind };
  const genesis = await connection.getGenesisHash();
  const host = new URL(url).hostname;
  if (genesis === DEVNET_GENESIS_HASH) {
    connection.kind = "devnet";
  } else if (process.env.LOCALNET === "1" && (host === "127.0.0.1" || host === "localhost")) {
    connection.kind = "localnet-rehearsal";
  } else {
    throw new Error(`Refusing to run: RPC genesis hash ${genesis} is not devnet. This harness is devnet-only.`);
  }
  return connection;
}

/**
 * Loads the dedicated devnet test keypair. Refuses the Solana CLI default wallet,
 * which may be a real mainnet wallet. Never prints secret material.
 */
export function loadTestKeypair(): Keypair {
  const p = path.resolve(process.env.KEYPAIR_PATH ?? DEFAULT_KEYPAIR_PATH);
  const cliDefault = path.join(os.homedir(), ".config", "solana", "id.json");
  if (p === cliDefault) {
    throw new Error("Refusing to use the Solana CLI default wallet. Run `npm run wallet:new` for a dedicated devnet keypair.");
  }
  if (!fs.existsSync(p)) {
    throw new Error(`No test keypair at ${p}. Run \`npm run wallet:new\` first.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export interface StepRecord {
  name: string;
  status: "confirmed" | "simulated-only" | "simulation-failed" | "send-failed" | "skipped";
  signature?: string;
  feeLamports?: number;
  computeUnits?: number;
  note?: string;
  error?: string;
  logs?: string[];
}

export interface Assertion {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** "on-chain" = checked against confirmed state; "quote" = SDK quote / simulation only. */
  evidence: "on-chain" | "quote" | "simulation";
}

export class StepFailed extends Error {
  constructor(public readonly record: StepRecord) {
    super(`${record.name}: ${record.status}: ${record.error ?? ""}`);
  }
}

const isComputeBudgetIx = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);

/** Merges SDK-built transactions into one, replacing their compute-budget instructions with a single limit. */
export function mergeTransactions(txs: Transaction[], computeUnitLimit: number): Transaction {
  const merged = new Transaction();
  merged.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  for (const tx of txs) merged.add(...tx.instructions.filter((ix) => !isComputeBudgetIx(ix)));
  return merged;
}

export class Recorder {
  readonly steps: StepRecord[] = [];
  readonly assertions: Assertion[] = [];
  readonly data: Record<string, unknown> = {};
  readonly startedAt = new Date().toISOString();

  constructor(
    readonly connection: Connection,
    readonly feePayer: Keypair,
    readonly runFile: string,
  ) {}

  /**
   * Simulates `tx`, and only if simulation succeeds sends and confirms it.
   * Signs with whichever of `signers` the message requires; the fee payer always signs.
   */
  async send(name: string, tx: Transaction, signers: Keypair[] = [], opts: { simulateOnly?: boolean } = {}): Promise<StepRecord> {
    const record: StepRecord = { name, status: "skipped" };
    this.steps.push(record);
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
      tx.feePayer = this.feePayer.publicKey;
      tx.recentBlockhash = blockhash;
      tx.signatures = [];
      const required = requiredSigners(tx);
      const pool = dedupeKeypairs([this.feePayer, ...signers]);
      const missing = required.filter((k) => !pool.some((kp) => kp.publicKey.equals(k)));
      if (missing.length) throw new Error(`missing required signer(s): ${missing.map(String).join(", ")}`);
      tx.sign(...pool.filter((kp) => required.some((k) => k.equals(kp.publicKey))));

      const sim = await this.connection.simulateTransaction(tx);
      record.computeUnits = sim.value.unitsConsumed;
      if (sim.value.err) {
        record.status = "simulation-failed";
        record.error = JSON.stringify(sim.value.err);
        record.logs = (sim.value.logs ?? []).slice(-25);
        throw new StepFailed(record);
      }
      if (opts.simulateOnly) {
        record.status = "simulated-only";
        return record;
      }

      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      record.signature = signature;
      const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      const info = await fetchTransactionWithRetry(this.connection, signature);
      record.feeLamports = info?.meta?.fee;
      record.computeUnits = info?.meta?.computeUnitsConsumed ?? record.computeUnits;
      if (conf.value.err || info?.meta?.err) {
        record.status = "send-failed";
        record.error = JSON.stringify(conf.value.err ?? info?.meta?.err);
        record.logs = (info?.meta?.logMessages ?? []).slice(-25);
        throw new StepFailed(record);
      }
      record.status = "confirmed";
      return record;
    } catch (e) {
      if (e instanceof StepFailed) throw e;
      record.status = record.signature ? "send-failed" : "simulation-failed";
      record.error = e instanceof Error ? e.message : String(e);
      throw new StepFailed(record);
    } finally {
      this.log(record);
      this.save();
    }
  }

  skip(name: string, note: string): void {
    const record: StepRecord = { name, status: "skipped", note };
    this.steps.push(record);
    this.log(record);
    this.save();
  }

  check(a: Assertion): boolean {
    this.assertions.push(a);
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] (${a.evidence}) ${a.name} — expected ${a.expected}, actual ${a.actual}`);
    this.save();
    return a.pass;
  }

  save(extra: Record<string, unknown> = {}): void {
    Object.assign(this.data, extra);
    fs.mkdirSync(path.dirname(this.runFile), { recursive: true });
    fs.writeFileSync(
      this.runFile,
      JSON.stringify({ startedAt: this.startedAt, ...this.data, steps: this.steps, assertions: this.assertions }, null, 2),
    );
  }

  private log(r: StepRecord): void {
    const bits = [r.status, r.signature && `sig=${r.signature}`, r.feeLamports != null && `fee=${r.feeLamports}`, r.computeUnits != null && `cu=${r.computeUnits}`, r.note, r.error && `error=${r.error}`];
    console.log(`- ${r.name}: ${bits.filter(Boolean).join(" ")}`);
    if (r.logs?.length) console.log(r.logs.map((l) => `    ${l}`).join("\n"));
  }
}

function requiredSigners(tx: Transaction): PublicKey[] {
  const msg = tx.compileMessage();
  return msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
}

function dedupeKeypairs(kps: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return kps.filter((kp) => {
    const k = kp.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchTransactionWithRetry(connection: Connection, signature: string) {
  for (let i = 0; i < 10; i++) {
    const info = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (info) return info;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export async function tokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  return BigInt((await connection.getTokenAccountBalance(ata, "confirmed")).value.amount);
}
