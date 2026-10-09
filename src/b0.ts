// Pure helpers for Stage B0 read-only observation (docs/stage-b-plan.md §2).
// No network or chain I/O here; scripts/b0-*.ts do the reads.

import bs58 from "bs58";
import Decimal from "decimal.js";

/** sha256("anchor:event")[0..8]: prefix of Anchor self-CPI event instructions (emit_cpi!). */
export const ANCHOR_EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

export const KNOWN_PROGRAMS = {
  dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  dammV2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

/** Programs that appear in most transactions and say nothing about who routed the swap. */
export const INFRA_PROGRAMS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

/**
 * DLMM base fee in bps. On-chain the rate is base_factor · bin_step · 10 · 10^power
 * in 1e-9 units (FEE_PRECISION), which is base_factor · bin_step · 10^power / 1e4 bps.
 */
export function dlmmBaseFeeBps(baseFactor: number, binStep: number, basePowerFactor: number): Decimal {
  return new Decimal(baseFactor).mul(binStep).mul(new Decimal(10).pow(basePowerFactor)).div(1e4);
}

export const DLMM_FUNCTION_TYPE: Record<number, string> = { 0: "Undetermined", 1: "LiquidityMining", 2: "LimitOrder" };

/**
 * Returns the base64 event payload (discriminator + data) of an Anchor self-CPI event
 * instruction, or null if `dataB58` is not one. The result feeds `coder.events.decode`.
 */
export function cpiEventPayload(dataB58: string): string | null {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(dataB58);
  } catch {
    return null;
  }
  if (raw.length < 16 || !Buffer.from(raw.subarray(0, 8)).equals(ANCHOR_EVENT_IX_TAG)) return null;
  return Buffer.from(raw.subarray(8)).toString("base64");
}

export type SwapClass =
  | "order-owner" // (a) signer owns an order in this pool
  | "jupiter" // (b) Jupiter v6 aggregator invoked
  | "damm-dlmm-arb" // (c) DAMM v2 and DLMM both swapped, no Jupiter, third-party signer
  | "direct-or-other"; // (d) anything else: direct DLMM swap or another router

export interface TxShape {
  signer: string;
  programs: ReadonlySet<string>;
  dlmmSwapCount: number;
  dammSwapCount: number;
}

/**
 * Classifies a transaction that swapped on a DLMM pool, following stage-b-plan.md B0.3.
 * Order matters: an owner filling their own order counts as (a) even through Jupiter.
 */
export function classifySwapTx(tx: TxShape, orderOwners: ReadonlySet<string>): SwapClass {
  if (orderOwners.has(tx.signer)) return "order-owner";
  if (tx.programs.has(KNOWN_PROGRAMS.jupiterV6)) return "jupiter";
  if (tx.dammSwapCount > 0 && tx.dlmmSwapCount > 0) return "damm-dlmm-arb";
  return "direct-or-other";
}

/** Programs in a transaction other than infra and the two pool programs: candidate routers. */
export function routerCandidates(programs: Iterable<string>): string[] {
  const skip = new Set<string>([...INFRA_PROGRAMS, KNOWN_PROGRAMS.dlmm, KNOWN_PROGRAMS.dammV2]);
  return [...programs].filter((p) => !skip.has(p)).sort();
}

/** Priority fee in lamports: total fee minus the 5,000-lamport base per signature. */
export function priorityFeeLamports(totalFee: number, signatureCount: number): number {
  return Math.max(0, totalFee - 5000 * signatureCount);
}

/** Nearest-rank percentile of a numeric sample; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export interface TokenBalanceRow {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

/** Net change per mint, in base units, of the token accounts owned by `owner` in one tx. */
export function ownerTokenDeltas(
  owner: string,
  pre: readonly TokenBalanceRow[] | null | undefined,
  post: readonly TokenBalanceRow[] | null | undefined,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [rows, sign] of [
    [pre ?? [], -1n],
    [post ?? [], 1n],
  ] as const) {
    for (const r of rows) {
      if (r.owner !== owner) continue;
      out[r.mint] = (out[r.mint] ?? 0n) + sign * BigInt(r.uiTokenAmount.amount);
    }
  }
  for (const k of Object.keys(out)) if (out[k] === 0n) delete out[k];
  return out;
}

/**
 * Converts snake_case keys of plain objects (recursively, including arrays) to camelCase.
 * Class instances such as BN and PublicKey are returned as-is. Used because cp-amm-sdk's
 * exported BorshCoder decodes with IDL (snake_case) field names, while its fee helpers
 * expect the camelCase shape that `program.account.pool.fetch` returns.
 */
export function camelizeKeys<T = any>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => camelizeKeys(x)) as T;
  if (v === null || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())] = camelizeKeys(x);
  return out as T;
}
