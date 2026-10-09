// Conviction Book: pure functions that turn a pool snapshot (resting DLMM limit orders plus
// the DAMM v2 reference price) into the book the UI shows. No network or chain I/O here.
//
// Honesty rules from CLAUDE.md that this module encodes:
//  - "Commitment" is OBSERVED time open, never a promise: orders can be cancelled any time.
//  - The no-fill band uses base fees, so its width is a LOWER BOUND (the real DLMM fee
//    includes a variable part). Statuses derived from it are estimates, labelled as such.
//  - The conviction score is observational. It is not a reward and implies no payout.

import Decimal from "decimal.js";
import { isAskArbFillable, isBidArbFillable, noFillBandWidth, relativeDistance, type BandInputs } from "./pricing.js";

export type Side = "bid" | "ask";
export type DataSource = "mainnet-snapshot" | "demo";
export type DbcOrigin = "confirmed" | "unverified-history-limit" | "dbc-authority-unchecked" | "none" | "demo";

export interface BookOrder {
  /** Limit-order account address (public on-chain) or a demo id. */
  id: string;
  /** Owner wallet, shortened for display. */
  owner: string;
  side: Side;
  /** Lowest and highest bin price the order covers, in Y per X. */
  priceLow: number;
  priceHigh: number;
  /** Order size in the input token (Y for bids, X for asks), UI units. */
  sizeInput: number;
  inputToken: string;
  /** Size in USD as priced by the data source; null when unknown. */
  sizeUsd: number | null;
  /** 0–100. */
  filledPct: number;
  /** Unix seconds of the order's creation. */
  openedAt: number;
  openedSignature?: string;
}

export interface PoolActivity {
  /** Swaps seen in the sampled window that consumed limit-order liquidity, by route class. */
  orderFillsByClass: Record<string, number>;
  /** The same fills, newest first, with their mainnet transaction signatures. */
  fills?: { signature: string; class: string; blockTime: number | null }[];
  swapTxs: number;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface PoolSnapshot {
  id: string;
  source: DataSource;
  name: string;
  tokenX: string;
  tokenY: string;
  tokenXMint?: string;
  tokenYMint?: string;
  lbPair?: string;
  dammPool?: string;
  /** DAMM v2 reference price, Y per X. */
  refPrice: number;
  refFeeBps: number;
  dlmmBaseFeeBps: number;
  binStep: number;
  /** DLMM active-bin price, Y per X (may drift far from the reference). */
  dlmmActivePrice: number | null;
  /** Unix seconds when the snapshot was taken. */
  asOf: number;
  dbcOrigin: DbcOrigin;
  /** Human-readable note on how complete this pool's order list is. */
  coverage: string;
  activity?: PoolActivity;
  orders: BookOrder[];
}

export type OrderStatus =
  | "filled" // filledPct ≥ 100
  | "resting" // reference has not reached the order
  | "crossed-in-band" // reference passed the order but not by more than the (estimated) no-fill band
  | "arb-fillable"; // reference is past the order by more than the estimated band

export interface BookRow extends BookOrder {
  /** Price closest to the market: the top of a bid, the bottom of an ask. */
  edgePrice: number;
  /** (edgePrice - ref) / ref. Negative for bids below the reference. */
  distance: number;
  status: OrderStatus;
  daysOpen: number;
  unfilledUsd: number | null;
  score: number | null;
}

export interface Book {
  pool: Omit<PoolSnapshot, "orders">;
  /** Estimated no-fill band half-width as a fraction (lower bound). */
  bandWidth: number;
  /** Reference price at which the band edges sit. */
  bandLow: number;
  bandHigh: number;
  bids: BookRow[];
  asks: BookRow[];
  totals: {
    orders: number;
    /** Unfilled USD of orders the data source could price. Unpriced orders add nothing. */
    bidUsd: number;
    askUsd: number;
    /** Orders not fully filled, per side. */
    openBids: number;
    openAsks: number;
    /** Open orders whose USD size is unknown, per side: their USD is not in bidUsd/askUsd. */
    unpricedBids: number;
    unpricedAsks: number;
    medianDaysOpen: number | null;
    byStatus: Record<OrderStatus, number>;
  };
}

export const SCORE_DAY_CAP = 90;
/** Distance at which proximity weight halves (5%). */
export const SCORE_PROXIMITY_SCALE = 0.05;

export function bandInputs(refFeeBps: number, dlmmFeeBps: number): BandInputs {
  return { refFeeBps, dlmmFeeBps, txCostY: 0, tradeSizeY: 1 };
}

export function edgePrice(o: Pick<BookOrder, "side" | "priceLow" | "priceHigh">): number {
  return o.side === "bid" ? o.priceHigh : o.priceLow;
}

export function daysBetween(fromUnix: number, toUnix: number): number {
  return Math.max(0, (toUnix - fromUnix) / 86_400);
}

/** Status of an order against the reference price, using the base-fee band estimate. */
export function orderStatus(side: Side, price: number, filledPct: number, refPrice: number, band: BandInputs): OrderStatus {
  if (filledPct >= 100) return "filled";
  const crossed = side === "bid" ? refPrice < price : refPrice > price;
  if (!crossed) return "resting";
  const fillable = side === "bid" ? isBidArbFillable(refPrice, price, band) : isAskArbFillable(refPrice, price, band);
  return fillable ? "arb-fillable" : "crossed-in-band";
}

/**
 * Observational conviction score: unfilled USD × days open (capped) × proximity weight,
 * where proximity = 1 / (1 + |distance| / 5%). An order 5% from the reference counts half
 * as much as one at the reference. NOT a reward and not a commitment: the order can be
 * cancelled at any time, which resets nothing on-chain and simply removes it from the book.
 */
export function convictionScore(unfilledUsd: number, daysOpen: number, distance: number): number {
  const proximity = 1 / (1 + Math.abs(distance) / SCORE_PROXIMITY_SCALE);
  return unfilledUsd * Math.min(daysOpen, SCORE_DAY_CAP) * proximity;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildRow(o: BookOrder, pool: Pick<PoolSnapshot, "refPrice" | "refFeeBps" | "dlmmBaseFeeBps" | "asOf">): BookRow {
  const band = bandInputs(pool.refFeeBps, pool.dlmmBaseFeeBps);
  const edge = edgePrice(o);
  const distance = relativeDistance(edge, pool.refPrice).toNumber();
  const daysOpen = daysBetween(o.openedAt, pool.asOf);
  const unfilledUsd = o.sizeUsd == null ? null : o.sizeUsd * (1 - Math.min(100, Math.max(0, o.filledPct)) / 100);
  return {
    ...o,
    edgePrice: edge,
    distance,
    status: orderStatus(o.side, edge, o.filledPct, pool.refPrice, band),
    daysOpen,
    unfilledUsd,
    score: unfilledUsd == null ? null : convictionScore(unfilledUsd, daysOpen, distance),
  };
}

export function buildBook(pool: PoolSnapshot): Book {
  const { orders, ...meta } = pool;
  const width = noFillBandWidth(bandInputs(pool.refFeeBps, pool.dlmmBaseFeeBps));
  const rows = orders.map((o) => buildRow(o, pool));
  const bids = rows.filter((r) => r.side === "bid").sort((a, b) => b.edgePrice - a.edgePrice);
  const asks = rows.filter((r) => r.side === "ask").sort((a, b) => a.edgePrice - b.edgePrice);
  const byStatus: Record<OrderStatus, number> = { filled: 0, resting: 0, "crossed-in-band": 0, "arb-fillable": 0 };
  for (const r of rows) byStatus[r.status]++;
  const sumUsd = (rs: BookRow[]) => rs.reduce((s, r) => s + (r.unfilledUsd ?? 0), 0);
  const open = (rs: BookRow[]) => rs.filter((r) => r.status !== "filled");
  const unpriced = (rs: BookRow[]) => open(rs).filter((r) => r.unfilledUsd == null).length;
  const ref = new Decimal(pool.refPrice);
  return {
    pool: meta,
    bandWidth: width.toNumber(),
    bandLow: ref.mul(new Decimal(1).minus(width)).toNumber(),
    bandHigh: ref.div(new Decimal(1).minus(width)).toNumber(),
    bids,
    asks,
    totals: {
      orders: rows.length,
      bidUsd: sumUsd(bids),
      askUsd: sumUsd(asks),
      openBids: open(bids).length,
      openAsks: open(asks).length,
      unpricedBids: unpriced(bids),
      unpricedAsks: unpriced(asks),
      medianDaysOpen: median(rows.filter((r) => r.status !== "filled").map((r) => r.daysOpen)),
      byStatus,
    },
  };
}

export interface OrderPreview {
  side: Side;
  price: number;
  distance: number;
  /** "wrong-side": a bid above or an ask below the reference, which DLMM would not rest as intended. */
  status: OrderStatus | "wrong-side";
  /** Reference price beyond which an atomic arb could fill the order (base-fee estimate). */
  arbTriggerRefPrice: number;
  /** Estimated band width (lower bound). */
  bandWidth: number;
  /** Observational score if the order stayed open, unfilled, for `horizonDays`. */
  scoreAtHorizon: number;
  horizonDays: number;
  warnings: string[];
}

/**
 * Preview of a hypothetical order. Purely local arithmetic: it does not build, sign or
 * send anything. Warnings flag orders on the "wrong" side of the reference or inside the band.
 */
export function previewOrder(
  pool: Pick<PoolSnapshot, "refPrice" | "refFeeBps" | "dlmmBaseFeeBps">,
  side: Side,
  price: number,
  sizeUsd: number,
  horizonDays: number,
): OrderPreview {
  if (!(price > 0)) throw new Error("price must be positive");
  if (!(sizeUsd >= 0)) throw new Error("size must be non-negative");
  const band = bandInputs(pool.refFeeBps, pool.dlmmBaseFeeBps);
  const width = noFillBandWidth(band);
  const k = new Decimal(1).minus(width);
  const distance = relativeDistance(price, pool.refPrice).toNumber();
  const crossedStatus = orderStatus(side, price, 0, pool.refPrice, band);
  const status = crossedStatus === "resting" ? "resting" : "wrong-side";
  const warnings: string[] = [];
  if (status === "wrong-side") {
    warnings.push(
      side === "bid"
        ? "This bid is above the reference price. On DLMM a bid must sit at or below the active bin, and it would not wait for the reference to come down."
        : "This ask is below the reference price. On DLMM an ask must sit at or above the active bin, and it would not wait for the reference to rise.",
    );
  }
  if (Math.abs(distance) < width.toNumber()) {
    warnings.push("The order is within the estimated no-fill band of the reference. Even after the reference crosses it, arbitrage may not be profitable enough to fill it.");
  }
  return {
    side,
    price,
    distance,
    status,
    arbTriggerRefPrice: (side === "bid" ? new Decimal(price).mul(k) : new Decimal(price).div(k)).toNumber(),
    bandWidth: width.toNumber(),
    scoreAtHorizon: convictionScore(sizeUsd, horizonDays, distance),
    horizonDays,
    warnings,
  };
}
