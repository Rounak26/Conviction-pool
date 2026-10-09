// Pure price and arbitrage-band math. No chain I/O here, so everything is unit-testable.
// Prices are always "token Y (quote) per 1 token X (base)" in UI units.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 40 });

const BPS = 10_000;
const Q64 = new Decimal(2).pow(64);

/** DLMM bin price in UI units: (1 + binStep/10^4)^binId * 10^(decX - decY). */
export function dlmmBinPrice(binId: number, binStep: number, decX: number, decY: number): Decimal {
  return new Decimal(1)
    .plus(new Decimal(binStep).div(BPS))
    .pow(binId)
    .mul(new Decimal(10).pow(decX - decY));
}

/**
 * Bin id for a UI price. `roundDown` picks the highest bin whose price is <= target,
 * otherwise the lowest bin whose price is >= target.
 */
export function dlmmBinIdForPrice(
  price: Decimal.Value,
  binStep: number,
  decX: number,
  decY: number,
  roundDown: boolean,
): number {
  const lamportPrice = new Decimal(price).div(new Decimal(10).pow(decX - decY));
  const raw = lamportPrice.ln().div(new Decimal(1).plus(new Decimal(binStep).div(BPS)).ln());
  // Guard against 1e-30 float noise flipping a bin.
  const snapped = raw.toDecimalPlaces(12);
  return (roundDown ? snapped.floor() : snapped.ceil()).toNumber();
}

/** DAMM v2 UI price of token A in token B from its Q64.64 sqrt price. */
export function dammPriceFromSqrtPriceQ64(sqrtPriceQ64: string | bigint, decA: number, decB: number): Decimal {
  return new Decimal(sqrtPriceQ64.toString())
    .div(Q64)
    .pow(2)
    .mul(new Decimal(10).pow(decA - decB));
}

export interface BandInputs {
  /** Reference (DAMM v2) fee, in bps, applied once on the reference leg. */
  refFeeBps: number;
  /**
   * DLMM fee, in bps, applied once on the order leg. The real fee is base + variable,
   * and the variable part grows with the bins a swap crosses (devnet Stage A: 25 bps
   * base, 45 bps effective). Passing the base fee gives a band that is too NARROW: it
   * is optimistic and predicts fills that SDK quotes reject.
   */
  dlmmFeeBps: number;
  /** Fixed cost of the arb transaction, denominated in token Y. */
  txCostY: Decimal.Value;
  /** Arb trade size, denominated in token Y. Only matters when txCostY > 0. */
  tradeSizeY: Decimal.Value;
}

/**
 * Multiplier k < 1 such that a resting order is arbitrage-fillable only once the
 * reference price has moved past it by more than (1 - k), i.e.
 *   bid fillable  <=> ref <= bid * k
 *   ask fillable  <=> ref >= ask / k
 *
 * Derivation (bid side; ask is symmetric), with an atomic round trip of `a` token Y:
 *   buy X on reference:  x = a * (1 - fRef) / ref
 *   sell X into the bid:  y = x * (1 - fDlmm) * bid
 *   profit = y - a - c  > 0   <=>   ref < bid * (1 - fRef)(1 - fDlmm) / (1 + c/a)
 *
 * ESTIMATE ONLY. It ignores price impact, bin rounding and the DLMM variable fee
 * unless that is folded into `dlmmFeeBps`, so its width is a lower bound on the real
 * band. Use it for display ("at least this far"), never to decide whether to send an
 * arb. Decide with live SDK quotes via `quotedBidArbEdgeY`.
 */
export function noFillBandMultiplier(i: BandInputs): Decimal {
  const fRef = new Decimal(i.refFeeBps).div(BPS);
  const fDlmm = new Decimal(i.dlmmFeeBps).div(BPS);
  const size = new Decimal(i.tradeSizeY);
  const costRatio = new Decimal(i.txCostY).isZero() ? new Decimal(0) : new Decimal(i.txCostY).div(size);
  return new Decimal(1).minus(fRef).mul(new Decimal(1).minus(fDlmm)).div(new Decimal(1).plus(costRatio));
}

/** Half-width of the no-fill band as a fraction (e.g. 0.005 = 0.5%). */
export function noFillBandWidth(i: BandInputs): Decimal {
  return new Decimal(1).minus(noFillBandMultiplier(i));
}

export function isBidArbFillable(refPrice: Decimal.Value, bidPrice: Decimal.Value, i: BandInputs): boolean {
  return new Decimal(refPrice).lt(new Decimal(bidPrice).mul(noFillBandMultiplier(i)));
}

export function isAskArbFillable(refPrice: Decimal.Value, askPrice: Decimal.Value, i: BandInputs): boolean {
  return new Decimal(refPrice).gt(new Decimal(askPrice).div(noFillBandMultiplier(i)));
}

/**
 * Expected profit in token Y of the bid-side round trip for `a` token Y in, ignoring
 * price impact. Positive iff isBidArbFillable (for the same inputs and a = tradeSizeY).
 */
export function bidArbProfitY(refPrice: Decimal.Value, bidPrice: Decimal.Value, i: BandInputs): Decimal {
  const a = new Decimal(i.tradeSizeY);
  const fRef = new Decimal(i.refFeeBps).div(BPS);
  const fDlmm = new Decimal(i.dlmmFeeBps).div(BPS);
  const x = a.mul(new Decimal(1).minus(fRef)).div(refPrice);
  const y = x.mul(new Decimal(1).minus(fDlmm)).mul(bidPrice);
  return y.minus(a).minus(i.txCostY);
}

/**
 * Effective fee rate, in bps, actually charged on a swap leg: the share of `amountIn`
 * that did not convert at the bin price. For a DLMM bid fill, amountIn is the X sold
 * and amountConverted is the order's `swappedAmountX`.
 */
export function effectiveFeeBps(amountIn: bigint, amountConverted: bigint): Decimal {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (amountConverted < 0n || amountConverted > amountIn) throw new Error("amountConverted must be in [0, amountIn]");
  return new Decimal((amountIn - amountConverted).toString()).div(amountIn.toString()).mul(BPS);
}

export interface QuotedBidArb {
  /** Y the DAMM v2 exact-out quote charges for the X (fee included). */
  dammYIn: bigint;
  /** Y the DLMM swap quote returns for that X (base + variable fee included). */
  dlmmYOut: bigint;
  /** Transaction and priority cost, in Y base units. */
  txCostY?: bigint;
}

/**
 * Net edge, in Y base units, of an atomic bid-side round trip priced from live SDK
 * quotes (cp-amm `getQuote2` and dlmm `swapQuote`). This is the fill decision: the
 * quotes include price impact and the DLMM variable fee, which the band estimate omits.
 */
export function quotedBidArbEdgeY(q: QuotedBidArb): bigint {
  return q.dlmmYOut - q.dammYIn - (q.txCostY ?? 0n);
}

export interface QuotedAskArb {
  /** Y the DLMM quote charges to buy the X out of the ask (base + variable fee included). */
  dlmmYIn: bigint;
  /** Y the DAMM v2 exact-in quote returns for selling that X (fee included). */
  dammYOut: bigint;
  /** Transaction and priority cost, in Y base units. */
  txCostY?: bigint;
}

/**
 * Net edge, in Y base units, of the ask-side round trip (buy X from the DLMM ask, sell it
 * on DAMM v2), priced from live SDK quotes. Mirror of `quotedBidArbEdgeY`. Not yet
 * exercised on-chain: Stage A placed bids only.
 */
export function quotedAskArbEdgeY(q: QuotedAskArb): bigint {
  return q.dammYOut - q.dlmmYIn - (q.txCostY ?? 0n);
}

/** Signed relative distance of an order price from the reference: (order - ref) / ref. */
export function relativeDistance(orderPrice: Decimal.Value, refPrice: Decimal.Value): Decimal {
  return new Decimal(orderPrice).minus(refPrice).div(refPrice);
}
