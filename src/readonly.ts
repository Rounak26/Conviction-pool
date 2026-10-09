// Read-only mainnet access for Stage B0 observation (docs/stage-b-plan.md §2).
//
// This module deliberately does not import the devnet harness (chain.ts) or any key-loading
// code, and the devnet signing guard there (`connectDevnet`) is unchanged. Three layers keep B0 read-only:
//   1. Opt-in: MAINNET_READONLY=1 must be set, and the RPC genesis must be mainnet-beta.
//   2. Method allowlist: the custom fetch rejects any JSON-RPC method not in READ_METHODS,
//      so sendTransaction, simulateTransaction and requestAirdrop cannot leave this process.
//   3. Rate limiting: one request in flight, a minimum interval between requests, and
//      backoff on HTTP 429 (honouring Retry-After).

import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEFAULT_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
/** Public mainnet-beta allows 40 requests / 10 s per method per IP; 2 rps stays well under. */
export const DEFAULT_RPS = 2;
/** Per-request deadline (headers and body). Without it one stalled request hangs the whole run. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export const READ_METHODS: ReadonlySet<string> = new Set([
  "getGenesisHash",
  "getSlot",
  "getBlockTime",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getRecentPrioritizationFees",
  "getMinimumBalanceForRentExemption",
]);

/** Returns the JSON-RPC method names in a request body (single or batch). Pure. */
export function rpcMethods(body: unknown): string[] {
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  const reqs = Array.isArray(parsed) ? parsed : [parsed];
  return reqs.map((r) => String((r as { method?: unknown })?.method));
}

/** Throws unless every method in the request body is on the read-only allowlist. Pure. */
export function assertReadOnly(body: unknown): void {
  const bad = rpcMethods(body).filter((m) => !READ_METHODS.has(m));
  if (bad.length) throw new Error(`Read-only guard: refusing RPC method(s) ${bad.join(", ")}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serializes calls and spaces their starts at least `minIntervalMs` apart. */
export function createLimiter(minIntervalMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

export interface RpcStats {
  requests: number;
  byMethod: Record<string, number>;
  retries429: number;
  networkRetries: number;
  timeouts: number;
}

export interface ReadOnlyConnection {
  connection: Connection;
  url: string;
  stats: RpcStats;
  /** Serialized, rate-limited fetch for non-RPC HTTP sources (Data API, Jupiter quotes). GET only. */
  httpGetJson: (url: string) => Promise<{ status: number; body: unknown }>;
}

/**
 * Connects to a mainnet RPC for reads only. Requires MAINNET_READONLY=1 and verifies the
 * genesis hash. URL from MAINNET_RPC_URL (default: public mainnet-beta), rate from RPC_RPS.
 */
export async function connectMainnetReadOnly(): Promise<ReadOnlyConnection> {
  if (process.env.MAINNET_READONLY !== "1") {
    throw new Error("Refusing to run: set MAINNET_READONLY=1 to opt in to read-only mainnet observation.");
  }
  const url = process.env.MAINNET_RPC_URL ?? DEFAULT_MAINNET_RPC_URL;
  const rps = Number(process.env.RPC_RPS ?? DEFAULT_RPS);
  if (!(rps > 0 && rps <= 10)) throw new Error(`RPC_RPS must be in (0, 10], got ${process.env.RPC_RPS}`);
  const timeoutMs = Number(process.env.RPC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const limit = createLimiter(1000 / rps);
  const stats: RpcStats = { requests: 0, byMethod: {}, retries429: 0, networkRetries: 0, timeouts: 0 };
  const withDeadline = (init?: RequestInit): RequestInit => ({
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

  const guardedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assertReadOnly(init?.body);
    for (const m of rpcMethods(init?.body)) stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await limit(() => {
          stats.requests++;
          return fetch(input, withDeadline(init));
        });
      } catch (e) {
        // Timeouts and transient transport errors (connection reset, HTTP/2 GOAWAY): back off and retry.
        if (attempt >= 6) throw e;
        if (isTimeout(e)) stats.timeouts++;
        else stats.networkRetries++;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.status !== 429 || attempt >= 6) return res;
      stats.retries429++;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
    }
  };

  const connection = new Connection(url, {
    commitment: "confirmed",
    fetch: guardedFetch as typeof fetch,
    disableRetryOnRateLimit: true,
  });
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new Error(`Refusing to run: RPC genesis ${genesis} is not mainnet-beta.`);
  }

  const httpGetJson = async (u: string) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await limit(() => fetch(u, withDeadline({ method: "GET", headers: { accept: "application/json" } })));
      } catch (e) {
        if (attempt >= 4) return { status: 0, body: `network error: ${(e as Error).message}` };
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (attempt >= 4) return { status: 0, body: `body read failed: ${(e as Error).message}` };
        continue;
      }
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: res.status, body };
    }
  };

  return { connection, url: redactUrl(url), stats, httpGetJson };
}

/** Drops query strings and path segments that may carry API keys before a URL is logged. */
export function redactUrl(u: string): string {
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : "/…"}${parsed.search ? "?…" : ""}`;
}

/** Writes a run file. Pass `file` (from a previous call) to overwrite a checkpoint in place. */
export function writeRun(name: string, data: unknown, file?: string): string {
  file ??= path.join("runs", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync("runs", { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return file;
}
