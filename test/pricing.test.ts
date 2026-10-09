import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import { getPriceFromSqrtPrice, getSqrtPriceFromPrice } from "@meteora-ag/cp-amm-sdk";
import {
  bidArbProfitY,
  dammPriceFromSqrtPriceQ64,
  dlmmBinIdForPrice,
  dlmmBinPrice,
  effectiveFeeBps,
  isAskArbFillable,
  isBidArbFillable,
  noFillBandMultiplier,
  noFillBandWidth,
  quotedAskArbEdgeY,
  quotedBidArbEdgeY,
  relativeDistance,
  type BandInputs,
} from "../src/pricing.js";

const close = (a: Decimal.Value, b: Decimal.Value, tol = 1e-12) =>
  expect(new Decimal(a).minus(b).abs().lte(tol)).toBe(true);

describe("DLMM bin pricing", () => {
  it("bin 0 is price 1 with equal decimals", () => {
    close(dlmmBinPrice(0, 25, 6, 6), 1);
  });

  it("matches the official SDK's getPriceOfBinByBinId (lamport price)", () => {
    for (const [binId, binStep] of [[-8, 25], [37, 10], [-1234, 1], [500, 100]] as const) {
      close(dlmmBinPrice(binId, binStep, 6, 6), getPriceOfBinByBinId(binId, binStep).toString(), 1e-9);
    }
  });

  it("applies the decimal adjustment 10^(decX - decY)", () => {
    // e.g. X has 9 decimals, Y has 6: one bin-0 lamport ratio of 1 means 1000 Y per X.
    close(dlmmBinPrice(0, 25, 9, 6), 1000);
    close(dlmmBinPrice(0, 25, 6, 9), 0.001);
  });

  it("round-trips bin id -> price -> bin id", () => {
    for (const binId of [-500, -8, 0, 1, 77, 3000]) {
      const p = dlmmBinPrice(binId, 25, 6, 9);
      expect(dlmmBinIdForPrice(p, 25, 6, 9, true)).toBe(binId);
      expect(dlmmBinIdForPrice(p, 25, 6, 9, false)).toBe(binId);
    }
  });

  it("rounds an in-between price down or up", () => {
    const mid = dlmmBinPrice(-8, 25, 6, 6).plus(dlmmBinPrice(-7, 25, 6, 6)).div(2);
    expect(dlmmBinIdForPrice(mid, 25, 6, 6, true)).toBe(-8);
    expect(dlmmBinIdForPrice(mid, 25, 6, 6, false)).toBe(-7);
  });
});

describe("DAMM v2 sqrt price", () => {
  it("agrees with the official SDK in both directions", () => {
    for (const [price, decA, decB] of [["1", 6, 6], ["0.95", 6, 6], ["123.456", 9, 6], ["0.0001", 6, 9]] as const) {
      const sqrt = getSqrtPriceFromPrice(price, decA, decB);
      close(dammPriceFromSqrtPriceQ64(sqrt.toString(), decA, decB), getPriceFromSqrtPrice(sqrt, decA, decB).toString(), 1e-9);
      close(dammPriceFromSqrtPriceQ64(sqrt.toString(), decA, decB), price, new Decimal(price).mul(1e-9).toNumber());
    }
  });
});

describe("no-fill band", () => {
  const base: BandInputs = { refFeeBps: 25, dlmmFeeBps: 25, txCostY: 0, tradeSizeY: 100 };

  it("is (1 - fRef)(1 - fDlmm) with no tx cost", () => {
    close(noFillBandMultiplier(base), 0.9975 * 0.9975);
    close(noFillBandWidth(base), 1 - 0.9975 * 0.9975);
  });

  it("is zero with zero fees and zero cost", () => {
    close(noFillBandWidth({ refFeeBps: 0, dlmmFeeBps: 0, txCostY: 0, tradeSizeY: 1 }), 0);
  });

  it("widens with tx cost, and the widening shrinks with trade size", () => {
    const small = noFillBandWidth({ ...base, txCostY: 1, tradeSizeY: 10 });
    const large = noFillBandWidth({ ...base, txCostY: 1, tradeSizeY: 10_000 });
    expect(small.gt(large)).toBe(true);
    expect(large.gt(noFillBandWidth(base))).toBe(true);
  });

  it("widens with higher fees (a post-graduation DAMM fee of 1% vs 0.25%)", () => {
    expect(noFillBandWidth({ ...base, refFeeBps: 100 }).gt(noFillBandWidth(base))).toBe(true);
  });

  it("does not fill a bid when the reference only touches the bid price", () => {
    expect(isBidArbFillable(0.98, 0.98, base)).toBe(false);
  });

  it("does not fill a bid when the reference is past it but inside the band", () => {
    // bid 0.98, band ~0.4994% -> threshold ~0.975106
    expect(isBidArbFillable(0.9752, 0.98, base)).toBe(false);
  });

  it("fills a bid once the reference is past the band", () => {
    expect(isBidArbFillable(0.975, 0.98, base)).toBe(true);
    expect(isBidArbFillable(0.95, 0.98, base)).toBe(true);
  });

  it("is symmetric for asks", () => {
    expect(isAskArbFillable(1.02, 1.02, base)).toBe(false);
    expect(isAskArbFillable(1.024, 1.02, base)).toBe(false);
    expect(isAskArbFillable(1.03, 1.02, base)).toBe(true);
  });

  it("profit sign agrees with the fillability predicate", () => {
    for (const ref of [0.9, 0.95, 0.97, 0.975, 0.9751, 0.976, 0.98, 1]) {
      for (const txCostY of [0, 0.01, 0.5]) {
        const inputs = { ...base, txCostY };
        expect(bidArbProfitY(ref, 0.98, inputs).gt(0)).toBe(isBidArbFillable(ref, 0.98, inputs));
      }
    }
  });
});

// Figures from the devnet Stage A run (runs/stage-a-devnet-2026-10-09T12-02-13-406Z.json,
// arb tx 3pqrZMKJ…). Bid A at bin -8 (bin step 25); the arb sold 91815828 X into it.
describe("effective DLMM fee (devnet Stage A: 45 bps effective vs 25 bps base)", () => {
  const xSold = 91_815_828n;
  const xConvertedAtBinPrice = 91_402_655n; // bid A swappedAmountX
  const bid = dlmmBinPrice(-8, 25, 6, 6);
  const baseFee: BandInputs = { refFeeBps: 25, dlmmFeeBps: 25, txCostY: 0, tradeSizeY: 100 };
  const effFee: BandInputs = { ...baseFee, dlmmFeeBps: 45 };

  it("measures 45 bps from the on-chain fill", () => {
    close(effectiveFeeBps(xSold, xConvertedAtBinPrice), 45, 0.001);
  });

  it("rejects impossible fill amounts", () => {
    expect(() => effectiveFeeBps(0n, 0n)).toThrow();
    expect(() => effectiveFeeBps(10n, 11n)).toThrow();
  });

  it("widens the band from ~0.50% to ~0.70%", () => {
    close(noFillBandWidth(baseFee), 1 - 0.9975 * 0.9975);
    close(noFillBandWidth(effFee), 1 - 0.9975 * 0.9955);
    expect(noFillBandWidth(effFee).gt(noFillBandWidth(baseFee))).toBe(true);
  });

  it("moves the bid fill threshold from 0.975328 to 0.973373", () => {
    close(bid.mul(noFillBandMultiplier(baseFee)), 0.975328, 1e-6);
    close(bid.mul(noFillBandMultiplier(effFee)), 0.973373, 1e-6);
  });

  it("separates the two models at a reference between the thresholds (bid)", () => {
    const baseThreshold = bid.mul(noFillBandMultiplier(baseFee)); // 0.975328
    const measuredThreshold = bid.mul(noFillBandMultiplier(effFee)); // 0.973373
    expect(measuredThreshold.lt(baseThreshold)).toBe(true);
    const ref = baseThreshold.plus(measuredThreshold).div(2); // ≈ 0.974351
    expect(ref.lt(baseThreshold) && ref.gt(measuredThreshold)).toBe(true);
    // Base-fee estimate: fill, positive edge. Measured fee: no fill, negative edge.
    expect(isBidArbFillable(ref, bid, baseFee)).toBe(true);
    expect(bidArbProfitY(ref, bid, baseFee).gt(0)).toBe(true);
    expect(isBidArbFillable(ref, bid, effFee)).toBe(false);
    expect(bidArbProfitY(ref, bid, effFee).lt(0)).toBe(true);
    // Fixed point too, so a regression in the threshold math cannot move both together.
    expect(isBidArbFillable(0.974, bid, baseFee)).toBe(true);
    expect(isBidArbFillable(0.974, bid, effFee)).toBe(false);
  });

  it("separates the two models at a reference between the thresholds (ask mirror)", () => {
    const ask = dlmmBinPrice(8, 25, 6, 6);
    const ref = ask.div(noFillBandMultiplier(baseFee)).plus(ask.div(noFillBandMultiplier(effFee))).div(2);
    expect(isAskArbFillable(ref, ask, baseFee)).toBe(true);
    expect(isAskArbFillable(ref, ask, effFee)).toBe(false);
  });

  it("both models agree at the two reference prices the devnet run actually used", () => {
    for (const inputs of [baseFee, effFee]) {
      expect(isBidArbFillable(0.978, bid, inputs)).toBe(false);
      expect(isBidArbFillable(0.95, bid, inputs)).toBe(true);
    }
  });
});

describe("bid fill accounting (devnet Stage A, bid A)", () => {
  it("swappedAmountX is the filled Y converted at the bin price, rounded down", () => {
    const filledY = new Decimal(89_594_998);
    expect(filledY.div(dlmmBinPrice(-8, 25, 6, 6)).floor().toNumber()).toBe(91_402_655);
  });

  it("cancel returns swapped X + the order's fee share, not swapped X alone", () => {
    const swappedX = 91_402_655n;
    const feeShareX = 206_586n;
    const withdrawnX = 91_609_241n; // maker ATA delta in cancel tx 4vTatEu1…
    expect(withdrawnX - swappedX).toBe(feeShareX);
  });

  it("the swap fee splits order share / protocol fee / 1 unit of rounding dust", () => {
    const totalFeeX = 91_815_828n - 91_402_655n; // X sold minus X converted
    const protocolFeeX = 206_586n; // lbPair.protocolFee.amountX after the run
    expect(totalFeeX).toBe(413_173n);
    expect(totalFeeX - 206_586n - protocolFeeX).toBe(1n);
  });
});

describe("quotedBidArbEdgeY (live-quote fill decision)", () => {
  // Quotes recorded in the devnet run for selling 91815828 X into bid A.
  it("matches the recorded edges", () => {
    expect(quotedBidArbEdgeY({ dammYIn: 92_054_417n, dlmmYOut: 89_594_998n })).toBe(-2_459_419n); // ref 1.0
    expect(quotedBidArbEdgeY({ dammYIn: 90_029_128n, dlmmYOut: 89_594_998n })).toBe(-434_130n); // ref 0.978
    expect(quotedBidArbEdgeY({ dammYIn: 87_451_492n, dlmmYOut: 89_594_998n })).toBe(2_143_506n); // ref 0.95
  });

  it("subtracts tx cost, which can flip a thin edge", () => {
    expect(quotedBidArbEdgeY({ dammYIn: 100n, dlmmYOut: 105n, txCostY: 4n })).toBe(1n);
    expect(quotedBidArbEdgeY({ dammYIn: 100n, dlmmYOut: 105n, txCostY: 6n }) > 0n).toBe(false);
  });
});

describe("quotedAskArbEdgeY (ask mirror; not yet exercised on-chain)", () => {
  it("is DAMM Y out minus DLMM Y in minus tx cost", () => {
    expect(quotedAskArbEdgeY({ dlmmYIn: 100n, dammYOut: 103n })).toBe(3n);
    expect(quotedAskArbEdgeY({ dlmmYIn: 100n, dammYOut: 103n, txCostY: 3n })).toBe(0n);
    expect(quotedAskArbEdgeY({ dlmmYIn: 100n, dammYOut: 99n }) < 0n).toBe(true);
  });
});

describe("relativeDistance", () => {
  it("is signed and relative to the reference", () => {
    close(relativeDistance(0.98, 1), -0.02);
    close(relativeDistance(1.05, 1), 0.05);
  });
});
