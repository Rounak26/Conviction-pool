import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_EVENT_IX_TAG,
  KNOWN_PROGRAMS,
  camelizeKeys,
  classifySwapTx,
  cpiEventPayload,
  dlmmBaseFeeBps,
  ownerTokenDeltas,
  percentile,
  priorityFeeLamports,
  routerCandidates,
} from "../src/b0.js";
import { assertReadOnly, createLimiter, redactUrl, rpcMethods } from "../src/readonly.js";

describe("read-only guard", () => {
  it("allows read methods, single and batch", () => {
    expect(() => assertReadOnly(JSON.stringify({ method: "getProgramAccounts" }))).not.toThrow();
    expect(() => assertReadOnly(JSON.stringify([{ method: "getTransaction" }, { method: "getSlot" }]))).not.toThrow();
  });

  it.each(["sendTransaction", "simulateTransaction", "requestAirdrop", "getLatestBlockhash"])("refuses %s", (m) => {
    expect(() => assertReadOnly(JSON.stringify({ method: m }))).toThrow(/Read-only guard/);
  });

  it("refuses a batch that hides one write among reads", () => {
    expect(() => assertReadOnly(JSON.stringify([{ method: "getSlot" }, { method: "sendTransaction" }]))).toThrow();
  });

  it("fails closed on a missing or non-JSON body", () => {
    expect(() => assertReadOnly(undefined)).toThrow();
    expect(() => assertReadOnly("not json")).toThrow();
  });

  it("refuses a body with no method", () => {
    expect(rpcMethods("{}")).toEqual(["undefined"]);
    expect(() => assertReadOnly("{}")).toThrow();
  });

  it("B0 sources never import keypair, signing or send code", () => {
    const files = ["src/readonly.ts", "src/b0.ts", ...fs.readdirSync("scripts").filter((f) => f.startsWith("b0-")).map((f) => path.join("scripts", f))];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/Keypair|loadTestKeypair|sendRawTransaction|sendTransaction\(|\.sign\(|src\/chain/);
    }
  });

  it("redacts RPC URLs that may carry API keys", () => {
    expect(redactUrl("https://api.mainnet-beta.solana.com")).toBe("https://api.mainnet-beta.solana.com");
    expect(redactUrl("https://rpc.example.com/v1/SECRET")).toBe("https://rpc.example.com/…");
    expect(redactUrl("https://rpc.example.com/?api-key=SECRET")).toBe("https://rpc.example.com?…");
  });

  it("limiter serializes calls and spaces their starts", async () => {
    const limit = createLimiter(30);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => limit(async () => starts.push(Date.now()))));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(28);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(28);
  });
});

describe("B0 pure helpers", () => {
  it("DLMM base fee matches the Stage A pool (base factor 10000, bin step 25 → 25 bps)", () => {
    expect(dlmmBaseFeeBps(10000, 25, 0).toNumber()).toBe(25);
    expect(dlmmBaseFeeBps(8000, 100, 1).toNumber()).toBe(800);
  });

  it("extracts Anchor CPI event payloads and ignores other instruction data", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ix = bs58.encode(Buffer.concat([ANCHOR_EVENT_IX_TAG, payload]));
    expect(cpiEventPayload(ix)).toBe(payload.toString("base64"));
    expect(cpiEventPayload(bs58.encode(Buffer.alloc(20, 7)))).toBeNull();
    expect(cpiEventPayload("0OIl")).toBeNull(); // not base58
  });

  const shape = (signer: string, programs: string[], dlmm = 1, damm = 0) => ({
    signer,
    programs: new Set(programs),
    dlmmSwapCount: dlmm,
    dammSwapCount: damm,
  });

  it("classifies swaps per stage-b-plan B0.3", () => {
    const owners = new Set(["OWNER"]);
    expect(classifySwapTx(shape("OWNER", [KNOWN_PROGRAMS.jupiterV6]), owners)).toBe("order-owner");
    expect(classifySwapTx(shape("T", [KNOWN_PROGRAMS.jupiterV6, KNOWN_PROGRAMS.dammV2], 1, 1), owners)).toBe("jupiter");
    expect(classifySwapTx(shape("T", [KNOWN_PROGRAMS.dlmm, KNOWN_PROGRAMS.dammV2], 1, 1), owners)).toBe("damm-dlmm-arb");
    expect(classifySwapTx(shape("T", [KNOWN_PROGRAMS.dlmm]), owners)).toBe("direct-or-other");
  });

  it("lists non-infra programs as router candidates", () => {
    expect(routerCandidates(["ComputeBudget111111111111111111111111111111", KNOWN_PROGRAMS.dlmm, "Router1"])).toEqual(["Router1"]);
  });

  it("computes priority fee and percentiles", () => {
    expect(priorityFeeLamports(15000, 1)).toBe(10000);
    expect(priorityFeeLamports(5000, 2)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });

  it("camelizes decoded IDL fields without touching class instances", () => {
    class Big {
      constructor(readonly v: number) {}
    }
    const b = new Big(1);
    const out = camelizeKeys<any>({ pool_fees: { base_fee: { base_fee_info: [1] }, dynamic_fee: { initialized: 0 } }, sqrt_price: b, reward_infos: [{ reward_per_token_stored: 2 }] });
    expect(out.poolFees.baseFee.baseFeeInfo).toEqual([1]);
    expect(out.poolFees.dynamicFee.initialized).toBe(0);
    expect(out.sqrtPrice).toBe(b);
    expect(out.rewardInfos[0].rewardPerTokenStored).toBe(2);
  });

  it("nets token balance changes for one owner", () => {
    const row = (owner: string, mint: string, amount: string) => ({ owner, mint, uiTokenAmount: { amount } });
    const d = ownerTokenDeltas("S", [row("S", "X", "100"), row("S", "Y", "50"), row("P", "X", "9")], [row("S", "X", "40"), row("S", "Y", "50"), row("S", "Z", "7")]);
    expect(d).toEqual({ X: -60n, Z: 7n });
  });
});
