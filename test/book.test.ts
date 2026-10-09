import { describe, expect, it } from "vitest";
import { bandInputs, buildBook, convictionScore, daysBetween, edgePrice, median, orderStatus, previewOrder, type PoolSnapshot } from "../src/book.js";
import { noFillBandWidth } from "../src/pricing.js";

const pool = (orders: PoolSnapshot["orders"]): PoolSnapshot => ({
  id: "p",
  source: "demo",
  name: "TEST/USDC",
  tokenX: "TEST",
  tokenY: "USDC",
  refPrice: 1,
  refFeeBps: 25,
  dlmmBaseFeeBps: 25,
  binStep: 25,
  dlmmActivePrice: 1,
  asOf: 86_400 * 10,
  dbcOrigin: "demo",
  coverage: "test",
  orders,
});

const order = (over: Partial<PoolSnapshot["orders"][number]>) => ({
  id: "o",
  owner: "w",
  side: "bid" as const,
  priceLow: 0.9,
  priceHigh: 0.95,
  sizeInput: 100,
  inputToken: "USDC",
  sizeUsd: 100,
  filledPct: 0,
  openedAt: 0,
  ...over,
});

describe("Conviction Book", () => {
  const band = bandInputs(25, 25);
  const width = noFillBandWidth(band).toNumber(); // ≈ 0.0049938

  it("uses the price nearest the market as the edge", () => {
    expect(edgePrice({ side: "bid", priceLow: 0.9, priceHigh: 0.95 })).toBe(0.95);
    expect(edgePrice({ side: "ask", priceLow: 1.05, priceHigh: 1.1 })).toBe(1.05);
  });

  it("classifies bids against the reference and the base-fee band", () => {
    expect(orderStatus("bid", 0.98, 0, 1, band)).toBe("resting");
    expect(orderStatus("bid", 0.98, 0, 0.978, band)).toBe("crossed-in-band"); // Stage A in-band point
    expect(orderStatus("bid", 0.98, 0, 0.95, band)).toBe("arb-fillable"); // Stage A fill point
    expect(orderStatus("bid", 0.98, 100, 0.95, band)).toBe("filled");
  });

  it("classifies asks symmetrically", () => {
    expect(orderStatus("ask", 1.02, 0, 1, band)).toBe("resting");
    expect(orderStatus("ask", 1.02, 0, 1.022, band)).toBe("crossed-in-band");
    expect(orderStatus("ask", 1.02, 0, 1.05, band)).toBe("arb-fillable");
  });

  it("scores unfilled USD × capped days × proximity, and nothing for zero size", () => {
    expect(convictionScore(100, 10, 0)).toBe(1000);
    expect(convictionScore(100, 10, -0.05)).toBeCloseTo(500);
    expect(convictionScore(100, 500, 0)).toBe(100 * 90);
    expect(convictionScore(0, 10, 0)).toBe(0);
  });

  it("builds a sorted book with totals and band edges", () => {
    const b = buildBook(
      pool([
        order({ id: "b1", priceHigh: 0.95, openedAt: 0 }),
        order({ id: "b2", priceHigh: 0.99, openedAt: 86_400 * 8, filledPct: 50 }),
        order({ id: "a1", side: "ask", priceLow: 1.1, priceHigh: 1.2, inputToken: "TEST", openedAt: 86_400 * 4 }),
        order({ id: "b3", priceHigh: 0.97, filledPct: 100 }),
      ]),
    );
    expect(b.bids.map((r) => r.id)).toEqual(["b2", "b3", "b1"]);
    expect(b.asks.map((r) => r.id)).toEqual(["a1"]);
    expect(b.totals.bidUsd).toBe(100 + 50 + 0);
    expect([b.totals.openBids, b.totals.openAsks, b.totals.unpricedBids, b.totals.unpricedAsks]).toEqual([2, 1, 0, 0]);
    expect(b.totals.byStatus).toEqual({ filled: 1, resting: 3, "crossed-in-band": 0, "arb-fillable": 0 });
    expect(b.totals.medianDaysOpen).toBe(6); // b1 10d, b2 2d, a1 6d; filled b3 excluded
    expect(b.bandWidth).toBeCloseTo(width);
    expect(b.bandLow).toBeLessThan(1);
    expect(b.bandHigh).toBeGreaterThan(1);
    const b2 = b.bids[0];
    expect(b2.daysOpen).toBe(2);
    expect(b2.unfilledUsd).toBe(50);
    expect(b2.distance).toBeCloseTo(-0.01);
  });

  it("leaves score and USD totals null-safe when the source has no USD price", () => {
    const b = buildBook(pool([order({ sizeUsd: null })]));
    expect(b.bids[0].score).toBeNull();
    expect(b.totals.bidUsd).toBe(0);
    expect(b.totals.unpricedBids).toBe(1); // shown as "unpriced", never as $0
  });

  it("excludes filled orders from open and unpriced counts", () => {
    const b = buildBook(pool([order({ id: "f", sizeUsd: null, filledPct: 100 }), order({ id: "a", side: "ask", priceLow: 1.1, priceHigh: 1.2, sizeUsd: null })]));
    expect([b.totals.openBids, b.totals.unpricedBids, b.totals.openAsks, b.totals.unpricedAsks]).toEqual([0, 0, 1, 1]);
    expect(b.totals.orders).toBe(2);
  });

  it("previews orders without sending anything, with the arb trigger and warnings", () => {
    const p = previewOrder({ refPrice: 1, refFeeBps: 25, dlmmBaseFeeBps: 25 }, "bid", 0.98, 100, 30);
    expect(p.status).toBe("resting");
    expect(p.arbTriggerRefPrice).toBeCloseTo(0.98 * (1 - width));
    expect(p.warnings).toEqual([]);
    const wrong = previewOrder({ refPrice: 1, refFeeBps: 25, dlmmBaseFeeBps: 25 }, "bid", 1.02, 100, 30);
    expect(wrong.status).toBe("wrong-side");
    expect(wrong.warnings[0]).toMatch(/above the reference/);
    expect(previewOrder({ refPrice: 1, refFeeBps: 25, dlmmBaseFeeBps: 25 }, "bid", 0.998, 100, 30).warnings.some((w) => /no-fill band/.test(w))).toBe(true);
    expect(() => previewOrder({ refPrice: 1, refFeeBps: 25, dlmmBaseFeeBps: 25 }, "ask", 0, 1, 1)).toThrow();
  });

  it("helpers", () => {
    expect(daysBetween(0, 86_400 * 3)).toBe(3);
    expect(daysBetween(10, 0)).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
