// Stage A kill test (devnet only). See docs/feasibility.md §4 and README.md.
//
// Builds an isolated two-pool market from fresh test mints:
//   - DAMM v2 pool X/Y at price 1.0 (the "reference" market, 25 bps static fee)
//   - DLMM LimitOrder pool X/Y at price 1.0 (bin step 25, 25 bps base fee)
// then: places DLMM bids, moves the reference price, checks that an atomic
// reference->DLMM arbitrage is unprofitable inside the no-fill band and
// profitable outside it, executes it, and verifies fill + cancellation from
// on-chain state. Every transaction is simulated before it is sent.
//
// Exit code: 0 PASS, 1 FAIL, 2 BLOCKED.

import path from "node:path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import BN from "bn.js";
import { Decimal } from "decimal.js";
import DLMM, {
  ActivationType as DlmmActivationType,
  CollectFeeMode as DlmmCollectFeeMode,
  ConcreteFunctionType,
  LimitOrderStatus,
  deriveCustomizablePermissionlessLbPair,
  isSupportLimitOrder,
} from "@meteora-ag/dlmm";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  SwapMode,
  getBaseFeeParams,
  getCurrentPoint,
  getSqrtPriceFromPrice,
  getTokenProgram,
  type PoolState,
} from "@meteora-ag/cp-amm-sdk";
import {
  MIN_BALANCE_SOL,
  PROGRAMS,
  Recorder,
  StepFailed,
  type StepRecord,
  connectDevnet,
  loadTestKeypair,
  mergeTransactions,
  tokenBalance,
} from "../src/chain.js";
import {
  dammPriceFromSqrtPriceQ64,
  dlmmBinPrice,
  effectiveFeeBps,
  isBidArbFillable,
  noFillBandMultiplier,
  quotedBidArbEdgeY,
  type BandInputs,
} from "../src/pricing.js";

// ---- Test parameters -------------------------------------------------------
const DEC = 6; // both test mints
const UNIT = 10n ** BigInt(DEC);
const REF_FEE_BPS = 25;
const DLMM_BIN_STEP = 25;
const DLMM_FEE_BPS = 25;
const DAMM_SEED = 1_000_000n * UNIT; // per side
const CREATOR_TOKEN_PROOF = 1_000n * UNIT;
const BID_FILL_BIN = -8; // ~0.980 Y per X
const BID_FILL_Y = 100n * UNIT;
const BID_CANCEL_BIN = -40; // ~0.905, never reached; tests cancel of an unfilled order
const BID_CANCEL_Y = 50n * UNIT;
const IN_BAND_TARGET = 0.978; // below the bid price but inside the band
const OUT_OF_BAND_TARGET = 0.95;
const FILL_FRACTION = 0.9; // arb sells ~90% of the bid's capacity -> expected PartialFilled
const SLIPPAGE_BPS = 50;
const ARB_CU_LIMIT = 800_000;

// Base-fee band: an optimistic ESTIMATE (too narrow; omits the DLMM variable fee and price
// impact). It is logged for comparison only. Fill decisions use live SDK quotes (quoteArb).
const band: BandInputs = { refFeeBps: REF_FEE_BPS, dlmmFeeBps: DLMM_FEE_BPS, txCostY: 0, tradeSizeY: 100 };

type Verdict = "PASS" | "FAIL" | "BLOCKED";
class Blocked extends Error {}

const connection = await connectDevnet();
const operator = loadTestKeypair();
const rehearsal = connection.kind !== "devnet";
const runFile = path.resolve("runs", `stage-a-${connection.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const rec = new Recorder(connection, operator, runFile);
rec.save({ cluster: connection.kind });
console.log(`Cluster: ${connection.kind}${rehearsal ? " (REHEARSAL — results are not Stage A evidence)" : ""}`);
console.log(`Run log: ${runFile}`);

let verdict: Verdict = "FAIL";
let reason = "";
try {
  ({ verdict, reason } = await run());
} catch (e) {
  verdict = e instanceof Blocked ? "BLOCKED" : "FAIL";
  reason = e instanceof StepFailed ? `step failed: ${e.message}` : (e as Error).message;
  console.error(e instanceof StepFailed ? e.message : e);
}
const endBalanceLamports = await connection.getBalance(operator.publicKey, "confirmed").catch(() => null);
const start = rec.data.startBalanceLamports as number | undefined;
const solSpent = start != null && endBalanceLamports != null ? (start - endBalanceLamports) / LAMPORTS_PER_SOL : null;
rec.save({ verdict, reason, endBalanceLamports, solSpent, finishedAt: new Date().toISOString() });
if (solSpent != null) console.log(`SOL spent by test wallet (net of refunds): ${solSpent}`);
console.log(`\n${rehearsal ? "LOCALNET REHEARSAL (not evidence)" : "STAGE A RESULT"}: ${verdict}${reason ? ` — ${reason}` : ""}`);
console.log(`Evidence: ${runFile}`);
process.exit(verdict === "PASS" ? 0 : verdict === "BLOCKED" ? 2 : 1);

// ---------------------------------------------------------------------------

async function run(): Promise<{ verdict: Verdict; reason: string }> {
  // ---- 0. Preflight (read-only) ----
  const balance = await connection.getBalance(operator.publicKey);
  for (const [name, id] of Object.entries(PROGRAMS)) {
    if (name !== "dbc" && !(await connection.getAccountInfo(id))?.executable) throw new Blocked(`${name} program not deployed on devnet`);
  }
  if (balance < MIN_BALANCE_SOL * LAMPORTS_PER_SOL) {
    throw new Blocked(`test wallet ${operator.publicKey.toBase58()} has ${balance / LAMPORTS_PER_SOL} SOL; need >= ${MIN_BALANCE_SOL}`);
  }
  rec.save({ operator: operator.publicKey.toBase58(), startBalanceLamports: balance, params: { DEC, REF_FEE_BPS, DLMM_BIN_STEP, DLMM_FEE_BPS, BID_FILL_BIN, BID_CANCEL_BIN, IN_BAND_TARGET, OUT_OF_BAND_TARGET } });

  // Ephemeral role keypairs (kept in memory only; their SOL is swept back at the end).
  const maker = Keypair.generate();
  const trader = Keypair.generate();
  rec.save({ maker: maker.publicKey.toBase58(), trader: trader.publicKey.toBase58() });

  try {
    return await runWithRoles(maker, trader);
  } finally {
    await sweep([maker, trader]);
  }
}

async function runWithRoles(maker: Keypair, trader: Keypair): Promise<{ verdict: Verdict; reason: string }> {
  // ---- 1. Mints, token accounts, SOL for roles ----
  // X is the lower pubkey so both pools store (X, Y) in the same order.
  const [mintX, mintY] = [Keypair.generate(), Keypair.generate()].sort((a, b) => a.publicKey.toBuffer().compare(b.publicKey.toBuffer()));
  const X = mintX.publicKey;
  const Y = mintY.publicKey;
  rec.save({ mintX: X.toBase58(), mintY: Y.toBase58() });

  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  const setup = new Transaction();
  for (const m of [mintX, mintY]) {
    setup.add(
      SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: m.publicKey, lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(m.publicKey, DEC, operator.publicKey, null),
    );
  }
  setup.add(
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: maker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: trader.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  );
  await rec.send("create test mints X, Y and fund role wallets", setup, [mintX, mintY]);

  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
  const fundTokens = new Transaction();
  const grants: [PublicKey, PublicKey, bigint][] = [
    // DLMM customizable-pool init requires the creator to hold a balance of the
    // pool tokens ("token launch owner proof", program error 6060); keep a remainder.
    [X, operator.publicKey, DAMM_SEED + CREATOR_TOKEN_PROOF],
    [Y, operator.publicKey, DAMM_SEED + CREATOR_TOKEN_PROOF],
    [Y, maker.publicKey, BID_FILL_Y + BID_CANCEL_Y],
    [X, trader.publicKey, 200_000n * UNIT],
    [Y, trader.publicKey, 10_000n * UNIT],
  ];
  for (const [mint, owner, amount] of grants) {
    fundTokens.add(
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(mint, owner), owner, mint),
      createMintToInstruction(mint, ata(mint, owner), operator.publicKey, amount),
    );
  }
  // Maker also needs an X account to receive fill proceeds.
  fundTokens.add(createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(X, maker.publicKey), maker.publicKey, X));
  await rec.send("create token accounts and mint test balances", fundTokens);

  // ---- 2. Reference market: DAMM v2 pool ----
  const cpAmm = new CpAmm(connection);
  const initSqrtPrice = getSqrtPriceFromPrice("1", DEC, DEC);
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: new BN(DAMM_SEED.toString()),
    maxAmountTokenB: new BN(DAMM_SEED.toString()),
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    collectFeeMode: CollectFeeMode.BothToken,
  });
  const positionNft = Keypair.generate();
  const { tx: dammTx, pool: dammPool } = await cpAmm.createCustomPool({
    payer: operator.publicKey,
    creator: operator.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: X,
    tokenBMint: Y,
    tokenAAmount: new BN(DAMM_SEED.toString()),
    tokenBAmount: new BN(DAMM_SEED.toString()),
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    liquidityDelta,
    initSqrtPrice,
    poolFees: {
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: { startingFeeBps: REF_FEE_BPS, endingFeeBps: REF_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
      }),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: null,
    },
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.BothToken,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });
  await rec.send("create DAMM v2 reference pool (25 bps static fee, price 1.0)", dammTx, [positionNft]);
  rec.save({ dammPool: dammPool.toBase58() });

  // ---- 3. Conviction market: DLMM LimitOrder pool ----
  const [lbPair] = deriveCustomizablePermissionlessLbPair(X, Y, PROGRAMS.dlmm);
  const dlmmTx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(DLMM_BIN_STEP),
    X,
    Y,
    new BN(0),
    new BN(DLMM_FEE_BPS),
    DlmmActivationType.Timestamp,
    false,
    operator.publicKey,
    undefined,
    false,
    ConcreteFunctionType.LimitOrder,
    DlmmCollectFeeMode.InputOnly,
    { cluster: "devnet" },
  );
  await rec.send("create DLMM LimitOrder pool (bin step 25, 25 bps, price 1.0)", dlmmTx);
  rec.save({ dlmmPool: lbPair.toBase58() });
  const dlmm = await DLMM.create(connection, lbPair, { cluster: "devnet" });

  // ---- 4. Read and validate both pool states ----
  let damm = await cpAmm.fetchPoolState(dammPool);
  const refPrice0 = dammPrice(damm);
  rec.check({ name: "DAMM pool stores X as token A", pass: damm.tokenAMint.equals(X) && damm.tokenBMint.equals(Y), expected: `A=${X}`, actual: `A=${damm.tokenAMint}`, evidence: "on-chain" });
  rec.check({ name: "DAMM initial price", pass: refPrice0.minus(1).abs().lt(1e-6), expected: "1.0", actual: refPrice0.toString(), evidence: "on-chain" });
  const refFeeBps = await measureDammFeeBps(cpAmm, damm, trader);
  rec.check({ name: "DAMM effective swap fee", pass: Math.abs(refFeeBps - REF_FEE_BPS) <= 1, expected: `${REF_FEE_BPS} bps`, actual: `${refFeeBps.toFixed(3)} bps`, evidence: "quote" });

  await dlmm.refetchStates();
  const fee = dlmm.getFeeInfo();
  rec.check({ name: "DLMM pool supports limit orders", pass: isSupportLimitOrder(dlmm.lbPair), expected: "true", actual: String(isSupportLimitOrder(dlmm.lbPair)), evidence: "on-chain" });
  rec.check({ name: "DLMM pool stores X as token X", pass: dlmm.lbPair.tokenXMint.equals(X), expected: X.toBase58(), actual: dlmm.lbPair.tokenXMint.toBase58(), evidence: "on-chain" });
  rec.check({ name: "DLMM active bin / bin step", pass: dlmm.lbPair.activeId === 0 && dlmm.lbPair.binStep === DLMM_BIN_STEP, expected: `0 / ${DLMM_BIN_STEP}`, actual: `${dlmm.lbPair.activeId} / ${dlmm.lbPair.binStep}`, evidence: "on-chain" });
  rec.check({ name: "DLMM base fee", pass: new Decimal(fee.baseFeeRatePercentage.toString()).minus(DLMM_FEE_BPS / 100).abs().lt(1e-9), expected: `${DLMM_FEE_BPS / 100}%`, actual: `${fee.baseFeeRatePercentage}%`, evidence: "on-chain" });
  rec.save({ dlmmFeeInfo: { base: fee.baseFeeRatePercentage.toString(), max: fee.maxFeeRatePercentage.toString(), protocol: fee.protocolFeePercentage.toString(), dynamicNow: dlmm.getDynamicFee().toString() } });

  // ---- 5. Place bids ----
  const makerXAta = ata(X, maker.publicKey);
  const makerYAta = ata(Y, maker.publicKey);
  const makerY0 = await tokenBalance(connection, makerYAta);
  const orderFill = await placeBid(dlmm, maker, BID_FILL_BIN, BID_FILL_Y, "place bid A (fill target)");
  const orderCancel = await placeBid(dlmm, maker, BID_CANCEL_BIN, BID_CANCEL_Y, "place bid B (cancel-unfilled target)");
  rec.save({ orderA: orderFill.toBase58(), orderB: orderCancel.toBase58() });
  const makerY1 = await tokenBalance(connection, makerYAta);
  rec.check({ name: "maker Y debited by both bids", pass: makerY0 - makerY1 === BID_FILL_Y + BID_CANCEL_Y, expected: String(BID_FILL_Y + BID_CANCEL_Y), actual: String(makerY0 - makerY1), evidence: "on-chain" });
  const a0 = (await dlmm.getLimitOrder(orderFill)).limitOrderData;
  rec.check({ name: "bid A deposit and status", pass: raw(a0.totalDepositAmountY) === BID_FILL_Y && a0.limitOrderBinData.every((b) => b.status === LimitOrderStatus.NotFilled), expected: `${BID_FILL_Y} Y, NotFilled`, actual: `${raw(a0.totalDepositAmountY)} Y, ${a0.limitOrderBinData.map((b) => LimitOrderStatus[b.status]).join(",")}`, evidence: "on-chain" });

  const bidPrice = dlmmBinPrice(BID_FILL_BIN, DLMM_BIN_STEP, DEC, DEC);
  const xToSell = BigInt(new Decimal(BID_FILL_Y.toString()).div(bidPrice).mul(FILL_FRACTION).floor().toFixed(0));
  rec.save({ bidPrice: bidPrice.toString(), bandMultiplier: noFillBandMultiplier(band).toString(), xToSell: xToSell.toString() });

  // ---- 6. No arbitrage at the initial reference price ----
  const traderXAta = ata(X, trader.publicKey);
  const traderYAta = ata(Y, trader.publicKey);
  let arb = await quoteArb(cpAmm, dlmm, dammPool, trader, xToSell);
  rec.check({ name: "no arb at ref 1.0 (above bid)", pass: !arb.profitable, expected: "unprofitable", actual: arb.summary, evidence: "quote" });

  // ---- 7. Move reference into the band (below bid, but not by enough) ----
  damm = await moveReferenceDown(cpAmm, dammPool, trader, IN_BAND_TARGET, "push reference into no-fill band");
  const refIn = dammPrice(damm);
  rec.check({ name: "reference below bid price", pass: refIn.lt(bidPrice), expected: `< ${bidPrice.toFixed(6)}`, actual: refIn.toFixed(6), evidence: "on-chain" });
  rec.check({ name: "base-fee band estimate predicts no fill", pass: !isBidArbFillable(refIn, bidPrice, band), expected: "false", actual: String(isBidArbFillable(refIn, bidPrice, band)), evidence: "quote" });
  arb = await quoteArb(cpAmm, dlmm, dammPool, trader, xToSell);
  rec.check({ name: "SDK quotes agree: arb unprofitable inside band", pass: !arb.profitable, expected: "unprofitable", actual: arb.summary, evidence: "quote" });
  // On-chain confirmation that the atomic profit guard rejects it (simulation only; nothing sent).
  try {
    await rec.send("simulate atomic arb inside band (expected to fail)", await buildArbTx(cpAmm, dlmm, dammPool, trader, xToSell, arb), [trader], { simulateOnly: true });
    rec.check({ name: "in-band atomic arb rejected by min-out guard", pass: false, expected: "simulation error", actual: "simulation succeeded", evidence: "simulation" });
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    rec.check({ name: "in-band atomic arb rejected by min-out guard", pass: true, expected: "simulation error", actual: e.record.error ?? "", evidence: "simulation" });
  }
  const aIn = (await dlmm.getLimitOrder(orderFill)).limitOrderData;
  rec.check({ name: "bid A still unfilled inside band", pass: raw(aIn.totalFilledAmountY) === 0n && raw(aIn.totalSwappedAmountX) === 0n, expected: "0 Y consumed, 0 X received", actual: `${raw(aIn.totalFilledAmountY)} Y consumed, ${raw(aIn.totalSwappedAmountX)} X received`, evidence: "on-chain" });

  // ---- 8. Move reference past the band and execute the atomic arb ----
  damm = await moveReferenceDown(cpAmm, dammPool, trader, OUT_OF_BAND_TARGET, "push reference past no-fill band");
  const refOut = dammPrice(damm);
  rec.check({ name: "base-fee band estimate predicts fill", pass: isBidArbFillable(refOut, bidPrice, band), expected: "true", actual: `ref ${refOut.toFixed(6)} vs threshold ${bidPrice.mul(noFillBandMultiplier(band)).toFixed(6)}`, evidence: "quote" });
  await dlmm.refetchStates();
  arb = await quoteArb(cpAmm, dlmm, dammPool, trader, xToSell);
  rec.check({ name: "SDK quotes agree: arb profitable outside band", pass: arb.profitable, expected: "profitable", actual: arb.summary, evidence: "quote" });
  if (!arb.profitable) return { verdict: "FAIL", reason: "arb not profitable after reference moved past the band" };

  const traderX0 = await tokenBalance(connection, traderXAta);
  const traderY0 = await tokenBalance(connection, traderYAta);
  const arbTx = await buildArbTx(cpAmm, dlmm, dammPool, trader, xToSell, arb);
  arbTx.feePayer = operator.publicKey;
  arbTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  rec.save({ arbTxBytes: arbTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length });
  const arbStep = await rec.send("ATOMIC ARB: buy X on DAMM v2 -> sell X into DLMM bid", arbTx, [trader]);
  const traderX1 = await tokenBalance(connection, traderXAta);
  const traderY1 = await tokenBalance(connection, traderYAta);
  rec.check({ name: "arb is profitable in Y (on-chain balances)", pass: traderY1 > traderY0, expected: "> 0", actual: `ΔY=${traderY1 - traderY0}, ΔX=${traderX1 - traderX0}`, evidence: "on-chain" });
  rec.check({ name: "arb was a single atomic transaction", pass: arbStep.status === "confirmed" && !!arbStep.signature, expected: "1 confirmed tx", actual: arbStep.signature ?? "none", evidence: "on-chain" });

  // ---- 9. Verify the order filled ----
  const a1 = (await dlmm.getLimitOrder(orderFill)).limitOrderData;
  const statuses = a1.limitOrderBinData.map((b) => LimitOrderStatus[b.status]).join(",");
  rec.save({ bidAAfterFill: a1 });
  // Bid semantics in the parsed order: filledAmountY = Y consumed, swappedAmountX = X received,
  // feeAmountX = the order's share of the swap fee (paid in the input token X).
  rec.check({ name: "bid A filled by the arb", pass: raw(a1.totalFilledAmountY) > 0n && raw(a1.totalSwappedAmountX) > 0n && a1.limitOrderBinData.some((b) => b.status !== LimitOrderStatus.NotFilled), expected: "Y consumed > 0, X received > 0, status Partial/Fulfilled", actual: `Y consumed=${raw(a1.totalFilledAmountY)}, X received=${raw(a1.totalSwappedAmountX)}, Y unfilled=${raw(a1.totalUnfilledAmountY)}, fee share X=${raw(a1.totalFeeAmountX)}, status=${statuses}`, evidence: "on-chain" });
  // The arb sold exactly xToSell X; everything not converted at the bin price was fee.
  const totalFeeX = xToSell - raw(a1.totalSwappedAmountX);
  const share = new Decimal(raw(a1.totalFeeAmountX).toString()).div(totalFeeX.toString());
  rec.check({ name: "limit order received ~50% of the swap fee", pass: share.minus(0.5).abs().lt(0.001), expected: "0.5", actual: share.toFixed(6), evidence: "on-chain" });
  const effFeeBps = effectiveFeeBps(xToSell, raw(a1.totalSwappedAmountX));
  const effBand: BandInputs = { ...band, dlmmFeeBps: effFeeBps.toNumber() };
  rec.save({
    dlmmEffectiveFeeBpsOnArbLeg: effFeeBps.toFixed(3),
    dlmmTotalFeeX: totalFeeX.toString(),
    bidFillThresholdBaseFee: bidPrice.mul(noFillBandMultiplier(band)).toFixed(6),
    bidFillThresholdEffectiveFee: bidPrice.mul(noFillBandMultiplier(effBand)).toFixed(6),
  });
  console.log(`    effective DLMM fee on arb leg: ${effFeeBps.toFixed(2)} bps (base ${DLMM_FEE_BPS}; excess = variable fee from bin crossings)`);
  await dlmm.refetchStates();
  rec.check({ name: "DLMM active bin moved down to the bid", pass: dlmm.lbPair.activeId <= BID_FILL_BIN, expected: `<= ${BID_FILL_BIN}`, actual: String(dlmm.lbPair.activeId), evidence: "on-chain" });

  // ---- 10. Cancel the untouched bid: exact refund ----
  const bX0 = await tokenBalance(connection, makerXAta);
  const bY0 = await tokenBalance(connection, makerYAta);
  const cancelB = await cancelOrder(dlmm, maker, orderCancel, "cancel bid B (unfilled)");
  const bX1 = await tokenBalance(connection, makerXAta);
  const bY1 = await tokenBalance(connection, makerYAta);
  rec.check({ name: "cancel unfilled bid returns exact deposit", pass: bY1 - bY0 === BID_CANCEL_Y && bX1 === bX0, expected: `ΔY=${BID_CANCEL_Y}, ΔX=0`, actual: `ΔY=${bY1 - bY0}, ΔX=${bX1 - bX0}`, evidence: "on-chain" });
  rec.check({ name: "bid B order account closed", ...(await verifyOrderClosed(dlmm, maker, orderCancel, cancelB)), expected: "getAccountInfo = null", evidence: "on-chain" });

  // ---- 11. Cancel the filled bid: proceeds + remainder ----
  const preCancel = (await dlmm.getLimitOrder(orderFill)).limitOrderData;
  const cancelA = await cancelOrder(dlmm, maker, orderFill, "cancel bid A (partially filled) — withdraw proceeds");
  const cX = await tokenBalance(connection, makerXAta);
  const cY = await tokenBalance(connection, makerYAta);
  const expX = raw(preCancel.transferFeeExcludedWithdrawableAmountX);
  const expY = raw(preCancel.transferFeeExcludedWithdrawableAmountY);
  // Withdrawable X for a bid = swappedAmountX (X converted at the bin price) + feeAmountX
  // (the order's fee share) + unfilledAmountX (0 for a bid). The SDK sums exactly these.
  const swappedX = raw(preCancel.totalSwappedAmountX);
  const feeShareX = raw(preCancel.totalFeeAmountX);
  rec.check({ name: "cancel filled bid returns X proceeds + Y remainder", pass: cX - bX1 === expX && cY - bY1 === expY && expX > 0n && expX === swappedX + feeShareX + raw(preCancel.totalUnfilledAmountX), expected: `ΔX=${expX} (= swapped ${swappedX} + fee share ${feeShareX}), ΔY=${expY} (SDK withdrawable)`, actual: `ΔX=${cX - bX1}, ΔY=${cY - bY1}`, evidence: "on-chain" });
  rec.check({ name: "bid A order account closed", ...(await verifyOrderClosed(dlmm, maker, orderFill, cancelA)), expected: "getAccountInfo = null", evidence: "on-chain" });

  // Effective price the maker bought X at (Y spent / X received).
  const ySpent = BID_FILL_Y - (cY - bY1);
  const xGot = cX - bX1;
  rec.save({ makerEffectiveBidPrice: new Decimal(ySpent.toString()).div(xGot.toString()).toString(), makerYSpent: ySpent.toString(), makerXReceived: xGot.toString() });

  const failed = rec.assertions.filter((a) => !a.pass);
  return failed.length
    ? { verdict: "FAIL", reason: `${failed.length} assertion(s) failed: ${failed.map((a) => a.name).join("; ")}` }
    : { verdict: "PASS", reason: "atomic DAMM v2 -> DLMM arbitrage filled a resting limit order; cancel/withdraw verified" };
}

// ---- helpers ----------------------------------------------------------------

/** The DLMM SDK's parsed limit-order amounts are UI-decimal strings; convert to base units. */
function raw(ui: string): bigint {
  return BigInt(new Decimal(ui).mul(UNIT.toString()).toFixed(0));
}

function dammPrice(p: PoolState): Decimal {
  return dammPriceFromSqrtPriceQ64(p.sqrtPrice.toString(), DEC, DEC);
}

async function dammQuote(cpAmm: CpAmm, pool: PoolState, input: PublicKey, amountIn: bigint) {
  return cpAmm.getQuote2({
    inputTokenMint: input,
    poolState: pool,
    currentPoint: await getCurrentPoint(connection, pool.activationType as ActivationType),
    amountIn: new BN(amountIn.toString()),
    slippage: SLIPPAGE_BPS / 100,
    swapMode: SwapMode.ExactIn,
    tokenADecimal: DEC,
    tokenBDecimal: DEC,
    hasReferral: false,
  });
}

/** Effective fee from a small quote: 1 - out / (in * price), in bps. */
async function measureDammFeeBps(cpAmm: CpAmm, pool: PoolState, _trader: Keypair): Promise<number> {
  const amountIn = 1_000n * UNIT;
  const q = await dammQuote(cpAmm, pool, pool.tokenAMint, amountIn);
  const ideal = new Decimal(amountIn.toString()).mul(dammPrice(pool));
  // Price impact on 1k of a 1M pool is ~0.1%; remove it using the constant-product formula.
  const impactFree = ideal.div(new Decimal(1).plus(new Decimal(amountIn.toString()).div(DAMM_SEED.toString())));
  return new Decimal(1).minus(new Decimal(q.outputAmount.toString()).div(impactFree)).mul(10_000).toNumber();
}

async function moveReferenceDown(cpAmm: CpAmm, pool: PublicKey, trader: Keypair, target: number, name: string): Promise<PoolState> {
  const state = await cpAmm.fetchPoolState(pool);
  // Binary-search the X amount that lands the post-swap price just below target.
  let lo = 0n;
  let hi = DAMM_SEED / 2n;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === lo) break;
    const q = await dammQuote(cpAmm, state, state.tokenAMint, mid);
    const after = dammPriceFromSqrtPriceQ64(q.nextSqrtPrice.toString(), DEC, DEC);
    if (after.gt(target)) lo = mid;
    else hi = mid;
  }
  const q = await dammQuote(cpAmm, state, state.tokenAMint, hi);
  const tx = await cpAmm.swap2({
    payer: trader.publicKey,
    pool,
    inputTokenMint: state.tokenAMint,
    outputTokenMint: state.tokenBMint,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
    referralTokenAccount: null,
    poolState: state,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(hi.toString()),
    minimumAmountOut: q.minimumAmountOut!,
  });
  await rec.send(`${name} (sell ${new Decimal(hi.toString()).div(UNIT.toString())} X on DAMM, target ${target})`, tx, [trader]);
  const after = await cpAmm.fetchPoolState(pool);
  console.log(`    reference price now ${dammPrice(after).toFixed(6)}`);
  return after;
}

interface ArbQuote {
  profitable: boolean;
  summary: string;
  dammMaxInY: BN;
  dlmmMinOutY: BN;
  binArraysPubkey: PublicKey[];
}

/**
 * Quotes the bid-side round trip: buy exactly `xAmount` X on DAMM (exact-out),
 * sell it into the DLMM pool. Profitable iff DLMM Y out > DAMM Y in.
 */
async function quoteArb(cpAmm: CpAmm, dlmm: DLMM, pool: PublicKey, _trader: Keypair, xAmount: bigint): Promise<ArbQuote> {
  const state = await cpAmm.fetchPoolState(pool);
  const dq = cpAmm.getQuote2({
    inputTokenMint: state.tokenBMint,
    poolState: state,
    currentPoint: await getCurrentPoint(connection, state.activationType as ActivationType),
    amountOut: new BN(xAmount.toString()),
    slippage: SLIPPAGE_BPS / 100,
    swapMode: SwapMode.ExactOut,
    tokenADecimal: DEC,
    tokenBDecimal: DEC,
    hasReferral: false,
  });
  const yIn = new BN(dq.includedFeeInputAmount.toString());
  const dammMaxInY = dq.maximumAmountIn ?? yIn;

  await dlmm.refetchStates();
  const binArrays = await dlmm.getBinArrayForSwap(true);
  let yOut: BN;
  let binArraysPubkey: PublicKey[] = [];
  try {
    const lq = dlmm.swapQuote(new BN(xAmount.toString()), true, new BN(SLIPPAGE_BPS), binArrays);
    yOut = lq.outAmount;
    binArraysPubkey = lq.binArraysPubkey;
  } catch (e) {
    return { profitable: false, summary: `DLMM quote failed: ${(e as Error).message}`, dammMaxInY, dlmmMinOutY: new BN(0), binArraysPubkey };
  }
  // Profit guard: the DLMM leg must return at least what the DAMM leg could cost.
  const dlmmMinOutY = BN.max(dammMaxInY.addn(1), new BN(0));
  const edge = quotedBidArbEdgeY({ dammYIn: BigInt(yIn.toString()), dlmmYOut: BigInt(yOut.toString()) });
  const profitable = edge > 0n;
  const summary = `buy ${xAmount} X for ${yIn} Y on DAMM, sell for ${yOut} Y on DLMM, edge ${edge} Y`;
  return { profitable, summary, dammMaxInY, dlmmMinOutY, binArraysPubkey };
}

async function buildArbTx(cpAmm: CpAmm, dlmm: DLMM, pool: PublicKey, trader: Keypair, xAmount: bigint, q: ArbQuote): Promise<Transaction> {
  const state = await cpAmm.fetchPoolState(pool);
  const leg1 = await cpAmm.swap2({
    payer: trader.publicKey,
    pool,
    inputTokenMint: state.tokenBMint,
    outputTokenMint: state.tokenAMint,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
    referralTokenAccount: null,
    poolState: state,
    swapMode: SwapMode.ExactOut,
    amountOut: new BN(xAmount.toString()),
    maximumAmountIn: q.dammMaxInY,
  });
  const binArraysPubkey = q.binArraysPubkey.length
    ? q.binArraysPubkey
    : (await dlmm.getBinArrayForSwap(true)).map((b) => b.publicKey);
  const leg2 = await dlmm.swap({
    inToken: dlmm.lbPair.tokenXMint,
    outToken: dlmm.lbPair.tokenYMint,
    inAmount: new BN(xAmount.toString()),
    minOutAmount: q.dlmmMinOutY,
    lbPair: dlmm.pubkey,
    user: trader.publicKey,
    binArraysPubkey,
  });
  return mergeTransactions([leg1, leg2], ARB_CU_LIMIT);
}

async function placeBid(dlmm: DLMM, maker: Keypair, binId: number, amountY: bigint, name: string): Promise<PublicKey> {
  await dlmm.refetchStates();
  const order = Keypair.generate();
  const tx = await dlmm.placeLimitOrder({
    owner: maker.publicKey,
    payer: operator.publicKey,
    sender: maker.publicKey,
    limitOrder: order.publicKey,
    params: { isAskSide: false, relativeBin: null, bins: [{ id: binId, amount: new BN(amountY.toString()) }] },
  });
  await rec.send(`${name}: ${amountY} Y at bin ${binId} (price ${dlmmBinPrice(binId, DLMM_BIN_STEP, DEC, DEC).toFixed(6)})`, tx, [maker, order]);
  return order.publicKey;
}

async function cancelOrder(dlmm: DLMM, maker: Keypair, order: PublicKey, name: string): Promise<StepRecord> {
  await dlmm.refetchStates();
  const parsed = await dlmm.getLimitOrder(order);
  const binIds = parsed.limitOrderData.limitOrderBinData.filter((b) => !b.empty).map((b) => b.binId);
  const tx = await dlmm.cancelLimitOrder({ limitOrderPubkey: order, owner: maker.publicKey, rentReceiver: operator.publicKey, binIds });
  return rec.send(`${name} (bins ${binIds.join(",")})`, tx, [maker]);
}

/**
 * Checks that the order account no longer exists and records how it was closed: by the
 * cancel transaction itself (the SDK appends CloseLimitOrderIfEmpty), or by a separate
 * close transaction sent here as a fallback. The `actual` string names the account, the
 * slot of the read and the closing signature, so it can be re-checked on an explorer.
 */
async function verifyOrderClosed(dlmm: DLMM, maker: Keypair, order: PublicKey, cancel: StepRecord): Promise<{ pass: boolean; actual: string }> {
  const cancelTx = cancel.signature
    ? await connection.getTransaction(cancel.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    : null;
  const closeIxInCancel = !!cancelTx?.meta?.logMessages?.some((l) => l.includes("Instruction: CloseLimitOrderIfEmpty"));
  let read = await connection.getAccountInfoAndContext(order, "confirmed");
  if (!read.value) {
    return { pass: true, actual: `${order} absent at slot ${read.context.slot}; closed by cancel tx ${cancel.signature} (CloseLimitOrderIfEmpty in its logs: ${closeIxInCancel})` };
  }
  const tx = await dlmm.closeLimitOrderIfEmpty({ limitOrder: order, owner: maker.publicKey, rentReceiver: operator.publicKey });
  const close = await rec.send(`close empty limit order ${order.toBase58().slice(0, 8)}…`, tx, [maker]);
  read = await connection.getAccountInfoAndContext(order, "confirmed");
  return read.value
    ? { pass: false, actual: `${order} still open at slot ${read.context.slot} after close tx ${close.signature}: ${read.value.lamports} lamports, owner ${read.value.owner}` }
    : { pass: true, actual: `${order} absent at slot ${read.context.slot}; cancel left it open, closed by separate tx ${close.signature}` };
}

/**
 * Returns role-wallet SOL to the operator and waits for confirmation, so the end balance
 * read afterwards includes it. (An unconfirmed sweep made the localnet rehearsal's
 * solSpent read 0.09999 SOL high.)
 */
async function sweep(roles: Keypair[]): Promise<void> {
  const sweeps: { from: string; lamports: number; signature?: string; status: string }[] = [];
  for (const kp of roles) {
    try {
      const bal = await connection.getBalance(kp.publicKey, "confirmed");
      const keep = 5_000; // fee for this transfer
      if (bal <= keep) continue;
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: operator.publicKey, lamports: bal - keep }));
      // The role pays its own fee here, so send outside the recorder's operator-fee-payer flow.
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.sign(kp);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const conf = await connection.confirmTransaction(sig, "confirmed");
      const status = conf.value.err ? `failed: ${JSON.stringify(conf.value.err)}` : "confirmed";
      sweeps.push({ from: kp.publicKey.toBase58(), lamports: bal - keep, signature: sig, status });
      console.log(`- sweep SOL from ${kp.publicKey.toBase58().slice(0, 8)}…: ${status} sig=${sig}`);
    } catch (e) {
      sweeps.push({ from: kp.publicKey.toBase58(), lamports: 0, status: `failed: ${(e as Error).message}` });
      console.log(`- sweep from ${kp.publicKey.toBase58().slice(0, 8)}… failed: ${(e as Error).message}`);
    }
  }
  rec.save({ sweeps });
}
