import { withTimeout } from "../../timeout.js";
import { withDeadline, validateRoutes } from "./pipeline.js";
import { isHealthyLiquidationVeto, isClmmRouteFailure } from "./simulation-error.js";
/**
 * Kamino liquidation executor — builds the atomic flash-borrow liquidation
 * sandwich for one DUE obligation, replicating the exact on-chain shape the
 * incumbent bot (LionX) uses:
 *
 *   refreshReserve(repay) + refreshReserve(withdraw) [+ any other obligation
 *     reserves] → refreshObligation → flashBorrow(debt asset) →
 *     LiquidateObligationAndRedeemReserveCollateralV2 (repays debt, redeems
 *     collateral to us) → local CLMM swap (collateral → debt asset) → flashRepay.
 *
 * Verdict chain (hard gates, same vocabulary as the LST executor):
 *   1. plan      — obligation must be DUE; repay amount sized to close factor;
 *                  flash borrow + swap must both be feasible
 *   2. assemble  — refresh + liquidate + local CLMM swap instructions embedded in
 *                  the flash-loan sandwich
 *   3. simulate  — full mainnet simulation; flashRepay must succeed
 *   4. guards    — worst-case net profit (min-out floors) ≥ profit floor
 *
 * Nothing here broadcasts — the caller decides, after its own operational
 * guards (budget caps, cooldown, kill switch), mirroring lst-autofire.
 */

import BN from "bn.js";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Decimal } from "decimal.js";
import {
  KaminoObligation,
  getCurrentLedgerInstant,
  getTokenIdsForScopeRefresh,
  liquidateObligationAndRedeemReserveCollateralV2,
  obligationFarmStatePda,
  refreshObligation,
  refreshReserve,
  type KaminoMarket,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { Scope } from "@kamino-finance/scope-sdk";
import {
  AccountRole,
  address,
  getBase64EncodedWireTransaction,
  none,
  some,
  type AccountMeta,
  type Address,
  type Instruction,
  type Option,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@solana/sysvars";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
  buildFlashLoan,
  createAtaInstruction,
  deriveAssociatedTokenAccount,
  fetchTokenAccount,
  type TokenAccountInfo,
} from "../../kamino.js";
import { externalInstructionsToStrategy, upsertComputeBudget, type ExternalInstruction } from "../../strategy.js";
import { simulate } from "../../transaction.js";
import { createSignedTransactionWithAltCached, getCachedScopeConfigurations, getCachedWalletSigner, ataStateKnown, setCachedAtaExists } from "./hotcache.js";
import { getClmmQuoter, web3InstructionToExternal } from "./clmm.js";
import { PublicKey } from "@solana/web3.js";
import BNImport from "bn.js";
import { safeJsonStringify } from "../../ui.js";
import { buildMarketReserveMap, dynamicLiquidationBonus, effectiveCloseFactorPct, healthFactor, obligationToCandidate, readMarketLevelInfo } from "./filters.js";
import { hydrateShortlist, withBackoff } from "./screener.js";
import { buildSenderTipInstruction, chooseSenderLane, FALLBACK_SOL_USD, priorityMicrolamports, type SenderConfig, type SenderLane, type SenderTier } from "./sender.js";

const ATA_PROGRAM = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";
const DEFAULT_CLOSE_FACTOR = 0.5;
const PRECISION_MARGIN_BPS = 20; // safety haircut on the collateral estimate
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const EXECUTOR_CU_LIMIT = 1_400_000;

/** SOL/USD from the market's own WSOL oracle — no extra RPC, no hardcoded price. */
function solUsdFromMarket(market: KaminoMarket): number {
  try {
    const reserve = market.getReservesByMint(address(WSOL_MINT))[0];
    const price = reserve?.getOracleMarketPrice()?.toNumber?.();
    if (typeof price === "number" && Number.isFinite(price) && price > 0) return price;
  } catch {
    // fall through to the conservative constant
  }
  return FALLBACK_SOL_USD;
}

type FarmAccounts = {
  obligationFarmUserState: Option<Address>;
  reserveFarmState: Option<Address>;
};

/**
 * Resolve the farm accounts the liquidation V2 ix must carry — ZERO added fire
 * latency because it joins the existing paralel Promise.all (collateralForFarm
 * derivation is local math; only ONE batched getMultipleAccounts, kicked at the
 * same instant as the CLMM quote).
 *
 * 6120/FarmAccountsMissing happens when an obligation JOINED a Kamino lending
 * farm for the repay/withdraw reserve (obligation-farm-user-state PDA exists
 * on-chain) but the tx passes none() — the program refuses to refresh
 * farm-backed positions without those accounts. The reserve stores its farm
 * address directly (getDebtFarmAddress / getCollateralFarmAddress — set on ALL
 * 58 main market reserves), and the obligation side is the farms-program PDA
 * reconciling that farm with the obligation. If the PDA doesn't exist the
 * obligation never joined → none() is correct and unchanged.
 */
async function resolveFarmAccounts(
  rpc: Rpc<SolanaRpcApi>,
  repayReserve: KaminoReserve,
  withdrawReserve: KaminoReserve,
  obligationAddress: Address,
): Promise<{ collateralFarmsAccounts: FarmAccounts; debtFarmsAccounts: FarmAccounts }> {
  const noneFarms = (): FarmAccounts => ({ obligationFarmUserState: none<Address>(), reserveFarmState: none<Address>() });
  const debtFarmOption = repayReserve.getDebtFarmAddress();
  const collFarmOption = withdrawReserve.getCollateralFarmAddress();
  if (debtFarmOption.__option !== "Some" && collFarmOption.__option !== "Some") {
    return { collateralFarmsAccounts: noneFarms(), debtFarmsAccounts: noneFarms() };
  }

  const probes: Array<{ farm: Address; key: "debtFarmsAccounts" | "collateralFarmsAccounts" }> = [];
  if (debtFarmOption.__option === "Some") probes.push({ farm: debtFarmOption.value, key: "debtFarmsAccounts" });
  if (collFarmOption.__option === "Some") probes.push({ farm: collFarmOption.value, key: "collateralFarmsAccounts" });

  const withPda = await Promise.all(
    probes.map(async (side) => ({ ...side, pda: await obligationFarmStatePda(side.farm, obligationAddress) })),
  );
  const existence = await rpc
    .getMultipleAccounts(withPda.map((side) => side.pda), { encoding: "base64" })
    .send()
    .then((r) => (r.value ?? []).map(Boolean))
    .catch(() => withPda.map(() => false));

  const out: { collateralFarmsAccounts: FarmAccounts; debtFarmsAccounts: FarmAccounts } = {
    collateralFarmsAccounts: noneFarms(),
    debtFarmsAccounts: noneFarms(),
  };
  for (let i = 0; i < withPda.length; i += 1) {
    const side = withPda[i]!;
    if (existence[i]) {
      out[side.key] = { obligationFarmUserState: some(side.pda), reserveFarmState: some(side.farm) };
    }
  }
  return out;
}

export interface LiquidationInput {
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl: string;
  market: KaminoMarket;
  /** The DUE obligation to liquidate. */
  obligationAddress: Address;
  /** Slippage tolerance on the collateral→debt swap leg, bps. */
  slippageBps: number;
  /** Minimum worst-case net profit in USD to clear. */
  minProfitUsd: number;
  /** Skip the client-side health gate (mechanics/E2E test only — the program still
   *  reverts in simulation if the obligation is genuinely healthy). */
  bypassHealth?: boolean;
  /** Health-gate tolerance: when live health is within this band ABOVE 1.0, keep
   *  going and let SIMULATION arbitrate (the tx's own RefreshObligation is the
   *  same check the program runs — the winner of the 2026-09-09 races all fired
   *  on positions our 2s-stale hydration read as 1.003–1.007). Default 0:
   *  strict gate. Race post-mortem: LionX took E5ANmg7d 3s after our veto at
   *  health 1.0069. */
  healthGateTolerance?: number;
  /** Extra lookup tables (our persistent klend-side ALT) to compress the tx. */
  lookupTableAddresses?: Address[];
  /** FAST mode: skip the second (CU-pinned re-sim) roundtrip to save ~1-2s in the
   *  hot path. The first simulation still gates the send; the CU limit falls back
   *  to the maximum compute budget instead of sim-measured units. */
  fast?: boolean;
  /** BLIND-FIRE mode (learning tuition, LionX same-slot shape): skip the
   *  simulation round-trip and return the assembled tx ready-to-broadcast.
   *  The on-chain program is the arbiter; a wrong guess burns only the
   *  ~$0.001 fee. Race post-mortem 2026-09-10 12:47: LionX won same-slot
   *  (0.0s) while our sim gate added ~300-500ms during which marginal
   *  positions flipped back above 1.0. */
  skipSimulate?: boolean;
  /** Priority-fee lane for the race (FASTLANE). "auto" scales the tip with the
   *  prize (capped at 2% of worst-case profit), "fixed" uses microlamportsPerCu
   *  verbatim, "off" sends at base fee. */
  priorityMode?: "off" | "fixed" | "auto";
  /** Used when priorityMode="fixed" (micro-lamports per compute unit). */
  microlamportsPerCu?: number;
  /** Prize for auto-scaling (worst-case profit USD); ~$1 = ~0.005 SOL at current prices. */
  prizeUsd?: number;
  /** Pre-hydrated obligation (e.g. executeDue already hydrated for its live-gate
   *  check) — skips the duplicate hydrate RPC inside the executor. Staleness is
   *  bounded by the caller (seconds, not minutes); the tx itself refreshes
   *  on-chain anyway. */
  prehydratedObligation?: KaminoObligation;
  /** Helius Sender execution lane (tip + tier + cost gate). When omitted the
   *  executor builds a plain transaction and the caller broadcasts it directly. */
  sender?: SenderConfig;
  /** Test seam: inject the transaction builder / simulator. Defaults to the real
   *  implementations; lets an offline E2E exercise the full verdict chain without
   *  an on-chain ALT or a live RPC. */
  deps?: {
    createSignedTransaction?: typeof createSignedTransactionWithAltCached;
    simulate?: typeof simulate;
  };
}

type LiquidationOutcomeBody =
  | { stage: "plan"; passed: false; reason: string; timings?: Record<string, number> }
  | { stage: "assemble"; passed: false; reason: string; logs?: string[]; timings?: Record<string, number> }
  | { stage: "simulate"; passed: false; reason: string; logs: string[]; timings?: Record<string, number> }
  | {
      stage: "ready";
      passed: true;
      plan: {
        obligation: Address;
        healthFactor: number;
        repayReserveSymbol: string;
        withdrawReserveSymbol: string;
        repayAmountBaseUnits: bigint;
        repayUsd: number;
        estCollateralBaseUnits: bigint;
        estCollateralUsd: number;
        quotedProfitUsd: number;
        worstCaseProfitUsd: number;
        /** Helius Sender lane cost (tip + priority + base) in USD, when enabled. */
        senderCostUsd?: number;
        /** worstCaseProfitUsd − senderCostUsd — the number the fire gate uses. */
        netWorstCaseProfitUsd?: number;
        /** Which swap backend produced the plan: clmm-local. */
        swapSource?: string;
      };
      transaction: Awaited<ReturnType<typeof createSignedTransactionWithAltCached>>;
      signer: TransactionSigner;
      computeUnitsConsumed: bigint;
      instructions: number;
      /** Per-stage wall-clock ms — the race-loss forensics (hydrate/quote/assemble/simulate). */
      timings: Record<string, number>;
      /** FASTLANE lane chosen for this attempt. */
      priorityLane: string;
      /** FASTLANE tip in USD (0 when off). */
      tipUsd: number;
      /** Helius Sender lane built into this transaction (when enabled). */
      sender?: {
        tier: SenderTier;
        /** Max-tier fires are submitted as an atomic Jito-routed bundle. */
        bundle: boolean;
        tipLamports: bigint;
        tipUsd: number;
        priorityFeeUsd: number;
        estimatedCostUsd: number;
      };
    };

export type LiquidationOutcome = LiquidationOutcomeBody & { simulationSlot?: number; routeDiagnostics?: string[] };

/** Convert signed token base units using a price that already includes mint decimals. */
export function profitBaseUnitsToUsd(amount: bigint, pricePerBaseUnit: Decimal): number {
  return new Decimal(amount.toString()).mul(pricePerBaseUnit).toNumber();
}

/** Flash-borrow price for sizing (USD per base unit of the reserve mint). */
function usdPerBaseUnit(reserve: KaminoReserve): Decimal {
  return reserve.getOracleMarketPrice().div(10 ** reserve.getMintDecimals());
}

function optionalOracleAccount(value: string | null): Option<Address> {
  // Unset oracles decode as the null pubkey (1111…), not null — mirror the SDK's
  // KaminoAction.optionalAccount: wrap in some() only when it's a real account.
  return value && value !== "11111111111111111111111111111111" ? some(address(value)) : none<Address>();
}

/** Converts a kit Instruction into the external-instruction shape strategy.ts expects. */
export function instructionToExternal(instruction: Instruction): ExternalInstruction {
  return {
    programId: instruction.programAddress.toString(),
    data: Buffer.from(instruction.data ?? new Uint8Array()).toString("base64"),
    accounts: (instruction.accounts ?? []).map((account) => {
      const meta = account as AccountMeta;
      const writable = meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER;
      const signer = meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER;
      return { pubkey: meta.address.toString(), isSigner: signer, isWritable: writable };
    }),
  };
}

function buildRefreshReserveIx(market: KaminoMarket, reserve: KaminoReserve): Instruction {
  const state = reserve.state;
  return refreshReserve(
    {
      reserve: reserve.address,
      lendingMarket: state.lendingMarket,
      pythOracle: optionalOracleAccount(state.config.tokenInfo.pythConfiguration?.price ?? null),
      switchboardPriceOracle: optionalOracleAccount(state.config.tokenInfo.switchboardConfiguration?.priceAggregator ?? null),
      switchboardTwapOracle: optionalOracleAccount(state.config.tokenInfo.switchboardConfiguration?.twapAggregator ?? null),
      scopePrices: optionalOracleAccount(state.config.tokenInfo.scopeConfiguration?.priceFeed ?? null),
    },
    undefined,
    market.programId,
  );
}

/**
 * Runs the full verdict chain for one liquidation. Returns a typed outcome;
 * never throws for market-condition failures (only infrastructure errors).
 */
export function estimateCollateralForRepay(input: {
  repayAmountBaseUnits: bigint;
  debtPriceBase: Decimal;
  collPriceBase: Decimal;
  liquidationBonus: number;
  /** Kamino's protocolLiquidationFeePct (percent of the bonus the protocol takes). */
  protocolLiquidationFeePct?: number;
  precisionMarginBps?: number;
}): bigint {
  const margin = input.precisionMarginBps ?? PRECISION_MARGIN_BPS;
  const protocolFeePct = input.protocolLiquidationFeePct ?? 0;
  // The protocol takes a share of the bonus; principal remains redeemable.
  const netBonus = new Decimal(input.liquidationBonus)
    .mul(new Decimal(1).sub(new Decimal(protocolFeePct).div(100)));
  const collateralEstimate = new Decimal(input.repayAmountBaseUnits.toString())
    .mul(input.debtPriceBase)
    .div(input.collPriceBase)
    .mul(new Decimal(1).add(netBonus))
    .mul(new Decimal(1 - margin / 10_000))
    .floor();
  return BigInt(collateralEstimate.toFixed(0));
}

export function chooseRepayUsd(totalDebtUsd: number, largestDebtUsd: number, closeFactor = DEFAULT_CLOSE_FACTOR): number {
  return Math.min(totalDebtUsd * closeFactor, largestDebtUsd);
}

/**
 * Repay sizing for the atomic liquidate instruction.
 *
 * Kamino's `calculate_liquidation` (state/liquidation_operations.rs) BYPASSES the
 * close factor while the borrow's market value sits below the market's
 * `min_full_liquidation_value_threshold` (raw USD; $2 by default): it takes the
 * whole `borrowed_amount` and reverts with `RepayTooSmallForFullLiquidation` if
 * the liquidator asked for less. So in that band the only safe move is to request
 * 100% — and if a vault/collateral cap would force us below it, we must refuse
 * rather than quietly under-request (which is a guaranteed revert, not a saving).
 *
 * Above the threshold the program takes `min(close-factor share, our request)`,
 * so capping at the close factor and the reserve/collateral limits is correct.
 *
 * The close factor share itself is `min(total_obligation_debt × cf, this_borrow)`,
 * NOT `this_borrow × cf`: `max_liquidatable_borrowed_amount` charges the close
 * factor to the obligation's whole debt. On a one-borrow position the two agree;
 * on a multi-borrow position the former lets us repay up to `total × cf` of any
 * single borrow, and sizing the latter quietly forfeits quota the program already
 * granted. `totalBorrowValueUsd` omitted → falls back to `this_borrow × cf`
 * (callers without the total, unit tests).
 */
export function chooseRepayBaseUnits(input: {
  /** Full borrow, base units. */
  borrowAmount: Decimal;
  /** Full borrow, USD. */
  borrowValueUsd: Decimal;
  /** Sum of ALL the obligation's borrows, USD. */
  totalBorrowValueUsd?: Decimal;
  closeFactorPct: number;
  fullLiquidationThresholdUsd: Decimal;
  debtReserveAvailable: Decimal;
  maxRepayFromCollateral: Decimal;
  maxRepayFromMarketCap: Decimal;
}): { amount: bigint; fullLiquidation: boolean; infeasibleReason?: string } {
  const dustFullLiquidation = input.fullLiquidationThresholdUsd.gt(0)
    && input.borrowValueUsd.gt(0)
    && input.borrowValueUsd.lt(input.fullLiquidationThresholdUsd);
  if (dustFullLiquidation) {
    if (input.borrowAmount.gt(input.debtReserveAvailable)) {
      return { amount: 0n, fullLiquidation: true, infeasibleReason: `dust borrow of $${input.borrowValueUsd.toFixed(4)} must be liquidated in full but the repay reserve only holds ${input.debtReserveAvailable.toFixed(4)} units` };
    }
    if (input.maxRepayFromCollateral.lt(input.borrowAmount)) {
      return { amount: 0n, fullLiquidation: true, infeasibleReason: `dust borrow of $${input.borrowValueUsd.toFixed(4)} must be liquidated in full but seizable collateral only covers ${input.maxRepayFromCollateral.toFixed(4)} debt units` };
    }
    return { amount: BigInt(input.borrowAmount.floor().toFixed(0)), fullLiquidation: true };
  }
  // Close-factor share of the borrow, expressed as a ratio so it can be applied in
  // base units without a price: min(total × cf, this borrow) / this borrow. With no
  // usable borrow value (zero-price input) fall back to the plain `borrow × cf`,
  // which is also exactly what the ratio reduces to when the total equals the borrow.
  const closeFactorRatio = (() => {
    if (!input.borrowValueUsd.gt(0)) return new Decimal(input.closeFactorPct).div(100);
    const totalUsd = Decimal.max(input.totalBorrowValueUsd ?? input.borrowValueUsd, input.borrowValueUsd);
    const allowedUsd = Decimal.min(totalUsd.mul(input.closeFactorPct).div(100), input.borrowValueUsd);
    return Decimal.min(new Decimal(1), allowedUsd.div(input.borrowValueUsd));
  })();
  const amount = BigInt(Decimal.min(
    input.borrowAmount.mul(closeFactorRatio),
    input.debtReserveAvailable,
    input.maxRepayFromMarketCap,
    input.maxRepayFromCollateral,
  ).floor().toFixed(0));
  return { amount, fullLiquidation: false };
}

/**
 * FASTLANE priority-fee sizing — race economics in one place.
 *
 * - "off": base fee (current behavior; lands whenever the block has room).
 * - "fixed": a flat micro-lamports/CU the operator trusts.
 * - "auto": tip scales with the PRIZE — the worst-case profit on the table.
 *   A $50 kill deserves a bigger bid than a $0.50 one. The tip is capped at
 *   MAX_TIP_FRACTION_OF_PRIZE of the prize so we never burn the reward, and
 *   floored at a small minimum so tiny plays still outbid base-fee spam.
 *
 * Everything is pre-send: the fee lands in the tx's compute-budget ix, and a
 * failed preflight burns nothing.
 */
export const MAX_TIP_FRACTION_OF_PRIZE = 0.02; // never bid more than 2% of the prize
export const MIN_TIP_USD = 0.01; // floor: still beat base-fee spam
const SOL_USD_ESTIMATE = 150; // conservative constant — only drives the bid ladder, not P&L

/** The bid ladder: prize bucket → target tip USD (before the 2% cap).
 *  Race-tuned 2026-09-10: the old $0.75 ceiling on a ~$832 prize (5xRRAGUe,
 *  lost at 0.09% of prize) was the blockspace-auction loss — competitors bid
 *  $1-5 on prizes like that. Buckets now scale to a meaningful fraction of
 *  the prize while the MAX_TIP_FRACTION_OF_PRIZE cap still bounds the burn. */
const PRIZE_BID_LADDER: Array<{ minPrizeUsd: number; bidUsd: number; label: string }> = [
  { minPrizeUsd: 500, bidUsd: 6.0, label: "lane-4 kill-shot" },
  { minPrizeUsd: 100, bidUsd: 1.8, label: "lane-3 hot" },
  { minPrizeUsd: 25, bidUsd: 0.6, label: "lane-2 fast" },
  { minPrizeUsd: 5, bidUsd: 0.2, label: "lane-1 quick" },
  { minPrizeUsd: 0, bidUsd: 0.05, label: "lane-0 base" },
];

export function choosePriorityFee(params: {
  priorityMode: "off" | "fixed" | "auto";
  prizeUsd?: number;
  microlamportsPerCu?: number;
  computeUnitLimit?: number;
}): { microlamportsPerCu: number; tipUsd: number; lane: string } {
  const { priorityMode } = params;
  if (priorityMode === "off") return { microlamportsPerCu: 0, tipUsd: 0, lane: "base-fee" };
  if (priorityMode === "fixed") {
    const micro = Math.max(0, Math.round(params.microlamportsPerCu ?? 0));
    return { microlamportsPerCu: micro, tipUsd: 0, lane: `fixed ${micro}µL/CU` };
  }
  const prize = Math.max(0, params.prizeUsd ?? 0);
  const bucket = PRIZE_BID_LADDER.find((b) => prize >= b.minPrizeUsd) ?? PRIZE_BID_LADDER[PRIZE_BID_LADDER.length - 1]!;
  const cappedBid = Math.max(MIN_TIP_USD, Math.min(bucket.bidUsd, prize * MAX_TIP_FRACTION_OF_PRIZE));
  // Priority fees are charged on the requested CU limit, not consumed units.
  const tipSol = cappedBid / SOL_USD_ESTIMATE;
  const micro = Math.max(1, Math.round((tipSol * 1e9 * 1e6) / (params.computeUnitLimit ?? 350_000)));
  return { microlamportsPerCu: micro, tipUsd: cappedBid, lane: `${bucket.label} (~$${cappedBid.toFixed(2)})` };
}

export function executeLiquidationOnce(input: LiquidationInput): Promise<LiquidationOutcome> {
  // Planning never submits transactions. Late read/sign work cannot broadcast,
  // and a hung provider must release the caller's execution slot.
  return withTimeout(() => executeLiquidationAttempt(input), 12_000, "liquidation planning");
}

async function executeLiquidationAttempt(input: LiquidationInput): Promise<LiquidationOutcome> {
  const { rpc, market, obligationAddress } = input;
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000)
    return { stage: "plan", passed: false, reason: "slippage must be an integer from 0 to 9999 bps" };
  const buildTransaction = input.deps?.createSignedTransaction ?? createSignedTransactionWithAltCached;
  const simulateTransaction = input.deps?.simulate ?? simulate;
  const timings: Record<string, number> = {};
  const mark = (label: string): (() => void) => {
    const start = Date.now();
    return () => {
      timings[label] = Date.now() - start;
    };
  };

  // 1. Hydrate the obligation fresh (oracles + account state) — or reuse the
  //    caller's seconds-old hydration (the tx refreshes on-chain regardless).
  let done = mark("hydrate");
  let obligation = input.prehydratedObligation;
  if (!obligation) {
    const ledgerInstant = await getCurrentLedgerInstant(rpc);
    const hydrated = await hydrateShortlist({
      rpc,
      market,
      ledgerInstant,
      pubkeys: [obligationAddress],
      onProgress: () => {},
    });
    obligation = hydrated[0];
  }
  done();
  if (!obligation) return { stage: "plan", passed: false, reason: "obligation account not found", timings };
  if (obligation.obligationTag !== 0) return { stage: "plan", passed: false, reason: "non-vanilla obligation (skip)" , timings };
  const health = healthFactor(obligation);
  const healthTolerance = input.healthGateTolerance ?? 0;
  if (health >= 1 + healthTolerance && !input.bypassHealth) {
    return { stage: "plan", passed: false, reason: `health ${health.toFixed(4)} — not liquidatable right now` , timings };
  }

  const marketReserves = buildMarketReserveMap(market, readMarketLevelInfo(market));

  // ── Pair selection (Kamino docs best practice) ──
  // The program ENFORCES priority rules: the target pair must be the
  // lowest-liquidation-threshold collateral and the highest-borrow-factor debt,
  // otherwise the liquidation instruction fails with IllegalLiquidation.
  const deposits = obligation.getDeposits().map((d) => ({ deposit: d, reserve: market.getReserveByAddress(d.reserveAddress) }));
  const borrows = obligation.getBorrows().map((b) => ({ borrow: b, reserve: market.getReserveByAddress(b.reserveAddress) }));

  const sortedDeposits = deposits
    .filter((d): d is { deposit: (typeof deposits)[number]["deposit"]; reserve: KaminoReserve } => d.reserve !== undefined && d.reserve.getLiquidityAvailableAmount().gt(0))
    .sort((a, b) => a.reserve.state.config.liquidationThresholdPct - b.reserve.state.config.liquidationThresholdPct);
  // Collateral must be seizable: loanToValuePct > 0 (deposit-only reserves cannot be seized).
  const withdrawPick = sortedDeposits.find((d) => d.reserve.state.config.loanToValuePct > 0);
  const withdrawReserve = withdrawPick?.reserve;
  if (!withdrawPick || !withdrawReserve) return { stage: "plan", passed: false, reason: "no collateral reserve candidate (none seizable)", timings };

  const sortedBorrows = borrows
    .filter((b): b is { borrow: (typeof borrows)[number]["borrow"]; reserve: KaminoReserve } => b.reserve !== undefined && b.borrow.marketValueRefreshed.gt(0))
    .sort((a, b) => Number(b.reserve.state.config.borrowFactorPct) - Number(a.reserve.state.config.borrowFactorPct));
  const repayPick = sortedBorrows[0];
  if (!repayPick) return { stage: "plan", passed: false, reason: "no debt candidate", timings };
  const repayReserveAddr = repayPick.reserve.address.toString();
  const repayReserve = repayPick.reserve;
  const repayInfo = marketReserves.get(repayReserveAddr);
  if (!repayInfo?.flashLoanEnabled) {
    return { stage: "plan", passed: false, reason: "debt reserve has flash loans disabled", timings };
  }

  const closeFactorPct = Number(market.state.liquidationMaxDebtCloseFactorPct);
  if (!Number.isFinite(closeFactorPct) || closeFactorPct <= 0 || closeFactorPct > 100)
    return { stage: "plan", passed: false, reason: "invalid market close factor", timings };
  const debtPriceBase = usdPerBaseUnit(repayReserve);
  if (!debtPriceBase.isFinite() || debtPriceBase.lte(0)) return { stage: "plan", passed: false, reason: "repay reserve price invalid", timings };

  // 3. Estimate the collateral the program will redeem for us — the LIQUIDATION
  //    BONUS is paid in extra COLLATERAL, and `calculate_liquidation_bonus` derives
  //    its bounds from BOTH the withdraw (collateral) and the repay (debt) reserve:
  //    max/max for the regular min-max collar, min for the bad-debt bonus. Reading
  //    only the collateral side under-quotes the prize whenever the debt reserve
  //    carries the wider band. Model Kamino's dynamic bonus from the live health
  //    factor; the program still applies its solvency/emode caps on-chain, and the
  //    transaction is simulation-gated.
  const collPriceBase = usdPerBaseUnit(withdrawReserve);
  if (!collPriceBase.isFinite() || collPriceBase.lte(0)) return { stage: "plan", passed: false, reason: "collateral reserve price invalid", timings };
  const withdrawCfg = withdrawReserve.state.config;
  const repayCfg = repayReserve.state.config;
  const badDebtWithdrawBps = withdrawCfg.badDebtLiquidationBonusBps;
  const badDebtRepayBps = repayCfg.badDebtLiquidationBonusBps;
  const badDebtBonusBps = badDebtWithdrawBps !== undefined && badDebtRepayBps !== undefined
    ? Math.min(badDebtWithdrawBps, badDebtRepayBps)
    : badDebtWithdrawBps ?? badDebtRepayBps;
  const bonus = dynamicLiquidationBonus({
    healthFactor: health,
    liquidationThresholdPct: withdrawCfg.liquidationThresholdPct,
    minBonus: Math.max(Number(withdrawCfg.minLiquidationBonusBps), Number(repayCfg.minLiquidationBonusBps)) / 10_000,
    maxBonus: Math.max(Number(withdrawCfg.maxLiquidationBonusBps), Number(repayCfg.maxLiquidationBonusBps)) / 10_000,
    ...(badDebtBonusBps !== undefined ? { badDebtBonus: badDebtBonusBps / 10_000 } : {}),
  });
  // Borrow only what this collateral position and both reserve vaults can
  // support. Over-borrowing can leave flash principal unpaid after a partial
  // liquidation, even if a quote for the assumed collateral looked profitable.
  const collateralUsd = Decimal.min(withdrawPick.deposit.marketValueRefreshed,
    withdrawReserve.getLiquidityAvailableAmount().mul(collPriceBase));
  const maxBonus = Math.max(bonus,
    Number(withdrawCfg.maxLiquidationBonusBps) / 10_000,
    Number(repayCfg.maxLiquidationBonusBps) / 10_000);
  const maxRepayFromCollateralUnits = collateralUsd.div(new Decimal(1).add(maxBonus)).div(debtPriceBase);
  // `calculate_liquidation` raises the close factor to 100% while the obligation's
  // LTV is past the market's insolvency line (live: 95%). Sizing with the nominal
  // market close factor there under-repays a deeply-underwater position by up to 10×.
  const sizedCloseFactorPct = effectiveCloseFactorPct(obligation, marketReserves);
  const sized = chooseRepayBaseUnits({
    borrowAmount: repayPick.borrow.amount,
    borrowValueUsd: repayPick.borrow.marketValueRefreshed,
    totalBorrowValueUsd: obligation.refreshedStats.userTotalBorrow,
    closeFactorPct: sizedCloseFactorPct,
    fullLiquidationThresholdUsd: new Decimal(market.state.minFullLiquidationValueThreshold?.toString() ?? 0),
    debtReserveAvailable: repayReserve.getLiquidityAvailableAmount(),
    maxRepayFromCollateral: maxRepayFromCollateralUnits,
    maxRepayFromMarketCap: new Decimal(market.state.maxLiquidatableDebtMarketValueAtOnce?.toString() ?? Infinity).div(debtPriceBase),
  });
  if (sized.infeasibleReason) return { stage: "plan", passed: false, reason: sized.infeasibleReason, timings };
  const repayAmountBaseUnits = sized.amount;
  if (repayAmountBaseUnits <= 0n) return { stage: "plan", passed: false, reason: "repay amount rounds to zero or collateral liquidity unavailable", timings };
  const repayUsd = Number(new Decimal(repayAmountBaseUnits.toString()).mul(debtPriceBase).toFixed(4));

  const protocolFeePct = Number(withdrawReserve.state.config.protocolLiquidationFeePct ?? 0);
  const estCollateralBaseUnits = estimateCollateralForRepay({
    repayAmountBaseUnits,
    debtPriceBase,
    collPriceBase,
    liquidationBonus: bonus,
    protocolLiquidationFeePct: protocolFeePct,
  });
  if (estCollateralBaseUnits <= 0n) return { stage: "plan", passed: false, reason: "collateral estimate rounds to zero" , timings };

  // 4+5. Quote the collateral→debt swap AND derive/fetch the ATAs in PARALLEL —
  //      Local CLMM quoting overlaps the independent ATA state fetches.
  done = mark("quote");
  // Fire-path trim: the signer (private-key decode + ed25519 derive) is
  // process-immutable — the shared hot cache serves it with zero work.
  const signer = await getCachedWalletSigner();

  // ── Helius Sender execution lane (execution-only; data RPC untouched) ──
  // The tip must live INSIDE the transaction, so the tier is chosen before the
  // sandwich is assembled. Small prizes take SWQOS-only (min 0.000005 SOL),
  // high prizes take Sender Max (min 0.001 SOL, multi-path + tip buffer).
  // Both require a CU-price instruction; the bid moves into the tip.
  const solUsd = input.sender?.enabled ? solUsdFromMarket(market) : FALLBACK_SOL_USD;
  const prizeGuessUsd = input.prizeUsd
    ?? (input.sender?.enabled ? (obligationToCandidate(obligation, marketReserves).estimatedProfitUsd ?? 0) : 0);
  const senderLane: SenderLane | null = input.sender?.enabled
    ? chooseSenderLane({ prizeUsd: prizeGuessUsd, solUsd, computeUnitLimit: EXECUTOR_CU_LIMIT, config: input.sender })
    : null;
  if (input.sender?.enabled && !senderLane) {
    return {
      stage: "plan",
      passed: false,
      reason: `sender cost gate: prize $${prizeGuessUsd.toFixed(4)} does not cover tip+priority+base (min-profit $${input.sender.minProfitUsd})`,
      timings,
    };
  }

  // ATAs: debt-liquidity (userSourceLiquidity + flash ATA), collateral-liquidity
  // (userDestinationLiquidity + swap input), collateral cToken (userDestinationCollateral).
  const debtAta = address(
    await deriveAssociatedTokenAccount({
      mint: repayReserve.getLiquidityMint(),
      owner: signer.address,
      tokenProgram: repayReserve.getLiquidityTokenProgram(),
    }),
  );
  const collAta = address(
    await deriveAssociatedTokenAccount({
      mint: withdrawReserve.getLiquidityMint(),
      owner: signer.address,
      tokenProgram: withdrawReserve.getLiquidityTokenProgram(),
    }),
  );
  const cTokenAta = address(
    await deriveAssociatedTokenAccount({
      mint: withdrawReserve.getCTokenMint(),
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  );

  const quoteDiagnostics: string[] = [];
  interface SwapPlan {
    swapInstructions: ExternalInstruction[];
    lookupTables: Address[];
    swapOut: bigint;
    swapOutMin: bigint;
    source: string;
  }
  // One local CLMM engine: no HTTP aggregator races or multi-hop fallback.
  const buildLocalClmmPlan = async (): Promise<SwapPlan | null> => {
    try {
      // Static imports (top of file) — no dynamic import latency on the fire path.
      const quoter = getClmmQuoter(input.rpcUrl);
      const tokenIn = new PublicKey(withdrawReserve.getLiquidityMint().toString());
      const tokenOut = new PublicKey(repayReserve.getLiquidityMint().toString());
      const amountIn = new BNImport(estCollateralBaseUnits.toString());
      const quote = await quoter.quoteExactIn({ tokenIn, tokenOut, amountIn, slippageBps: input.slippageBps });
      if (!quote || !quote.allTradeConfirmed()) return null;
      const swap = await quoter.buildSwapInstruction({
        tokenIn,
        tokenOut,
        ownerTokenIn: new PublicKey(collAta.toString()),
        ownerTokenOut: new PublicKey(debtAta.toString()),
        amountIn,
        amountOutMin: new BNImport(quote.amountOutMinBigInt().toString()),
        payer: new PublicKey(signer.address.toString()),
        quote,
      });
      if (!swap) return null;
      // Raydium's mainnet CLMM lookup table (pool/vault/tick-array accounts) —
      // the CLMM swap ix is account-heavy; without ALT compression the tx busts
      // the 1232-byte packet. The table is public and near-static.
      const RAYDIUM_CLMM_ALT = "AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU";
      return {
        swapInstructions: [web3InstructionToExternal(swap.instruction)],
        lookupTables: [address(RAYDIUM_CLMM_ALT)],
        swapOut: quote.amountOutBigInt(),
        swapOutMin: quote.amountOutMinBigInt(),
        source: `clmm-local/${swap.poolId.toBase58().slice(0, 6)}`,
      };
    } catch (error) {
      quoteDiagnostics.push(`clmm: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  done();
  done = mark("quoteWait");
  const sameMint = withdrawReserve.getLiquidityMint() === repayReserve.getLiquidityMint();
  const localPlan: Promise<SwapPlan | null> = sameMint
    ? Promise.resolve({ swapInstructions: [], lookupTables: [], swapOut: estCollateralBaseUnits, swapOutMin: estCollateralBaseUnits, source: "same-mint" })
    : withDeadline(buildLocalClmmPlan(), 2_000);
  // Fire-path trim: ATA existence (OUR hot ATAs — created once by liq-setup)
  // is cached process-lifetime once seen; a known-existing ATA needs NO
  // getAccountInfo round-trip. Only genuinely unknown states hit the RPC.
  const ataFetchIfUnknown = (ata: Address, mint: Address, decimals: number): Promise<TokenAccountInfo | null> | null => {
    const known = ataStateKnown(ata.toString());
    if (!known) return null;
    return Promise.resolve(
      known.exists
        ? { address: ata, mint, owner: signer.address, amount: 0n, decimals }
        : null,
    );
  };
  const fetchAtaWithCache = (ata: Address, mint: Address, decimals: number, label: string): Promise<TokenAccountInfo | null> => {
    const cached = ataFetchIfUnknown(ata, mint, decimals);
    if (cached) return cached;
    return withBackoff(() => fetchTokenAccount(rpc, ata.toString()), label).then((fetched) => {
      setCachedAtaExists(ata.toString(), Boolean(fetched));
      return fetched;
    });
  };
  const [firstPlan, debtAtaState, collAtaState, cTokenAtaState, farmAccounts] = await Promise.all([
    localPlan,
    fetchAtaWithCache(debtAta, repayReserve.getLiquidityMint(), repayReserve.getMintDecimals(), "ata fetch"),
    fetchAtaWithCache(collAta, withdrawReserve.getLiquidityMint(), withdrawReserve.getMintDecimals(), "ata fetch"),
    fetchAtaWithCache(cTokenAta, withdrawReserve.getCTokenMint(), withdrawReserve.getMintDecimals(), "ata fetch"),
    // Farm account resolution rides the SAME parallel batch (CPUs/IO overlap) —
    // a DNS/RPC slow-down here costs the fire nothing: fifty reservations already
    // share this window. On 6120 obligations this is the difference between a
    // fireable tx and a guaranteed program-reject.
    resolveFarmAccounts(rpc, repayReserve, withdrawReserve, obligationAddress),
  ]);
  done();
  const swapPlan = firstPlan;
  if (!swapPlan) return { stage: "plan", passed: false, reason: `route unavailable: ${withdrawReserve.getLiquidityMint()}→${repayReserve.getLiquidityMint()} amount=${estCollateralBaseUnits}; ${quoteDiagnostics.join("; ") || "backends returned no route or exceeded deadline"}` , timings };
  const activeSwapPlan: SwapPlan = swapPlan;
  const swapOut = activeSwapPlan.swapOut;
  const swapOutMin = activeSwapPlan.swapOutMin;

  const setupInstructions: Instruction[] = [];
  if (!debtAtaState) {
    setupInstructions.push(
      await createAtaInstruction({
        payer: signer,
        mint: repayReserve.getLiquidityMint(),
        owner: signer.address,
        tokenProgram: repayReserve.getLiquidityTokenProgram(),
        ata: debtAta,
      }),
    );
  }
  if (!collAtaState && collAta !== debtAta) {
    setupInstructions.push(
      await createAtaInstruction({
        payer: signer,
        mint: withdrawReserve.getLiquidityMint(),
        owner: signer.address,
        tokenProgram: withdrawReserve.getLiquidityTokenProgram(),
        ata: collAta,
      }),
    );
  }
  if (!cTokenAtaState) {
    setupInstructions.push(
      await createAtaInstruction({
        payer: signer,
        mint: withdrawReserve.getCTokenMint(),
        owner: signer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        ata: cTokenAta,
      }),
    );
  }
  const tokenAccount = debtAtaState ?? {
    address: debtAta,
    mint: repayReserve.getLiquidityMint(),
    owner: signer.address,
    amount: 0n,
    decimals: repayReserve.getMintDecimals(),
  };

  // Strategy pre-instructions: refresh the involved reserves + obligation so the
  // liquidate instruction sees live prices. Remaining accounts for the obligation
  // refresh = all deposit + borrow reserves (mirrors SDK addRefreshObligation).
  const refreshAccounts = [] as { address: Address; writable: boolean }[];
  for (const deposit of obligation.getDeposits()) refreshAccounts.push({ address: deposit.reserveAddress, writable: true });
  for (const borrow of obligation.getBorrows()) refreshAccounts.push({ address: borrow.reserveAddress, writable: true });
  const uniqueReserveAddresses = [...new Set(refreshAccounts.map((meta) => meta.address.toString()))];
  const preInstructions: Instruction[] = [];
  // Keep oracle refreshes in the SAME transaction as liquidation. A standalone
  // simulateTransaction cannot see a preceding bundle member's state changes.
  // Sender tip transfer rides the same sandwich (atomic with borrow/liquidate/
  // repay): it is rolled back if the liquidation reverts, so a rejected tx only
  // burns base + priority fee, not the tip.
  if (senderLane) preInstructions.push(buildSenderTipInstruction({ signer, lamports: senderLane.tipLamports }));

  // Scope-priced reserves read a price feed that must itself be refreshed earlier
  // in the SAME transaction — otherwise refreshObligation fails with ReserveStale
  // (price_status 63). Mirror the SDK/refresh-keeper pattern: RefreshPriceList
  // first, covering every chain id the touched reserves reference.
  try {
    // scope-sdk v13 bundles its own kit v7 types; our kit 2.3 RPC is runtime-compatible
    // (verified on mainnet) — the cast bridges the brand-type gap.
    // getAllConfigurations is served from the hot cache (governance-static map) —
    // saves a sequential RPC round-trip on every fire.
    const scopeConfigurations = await getCachedScopeConfigurations(rpc);
    const feedsInPlay = new Set(
      uniqueReserveAddresses
        .map((addr) => market.getReserveByAddress(address(addr))?.state.config.tokenInfo.scopeConfiguration.priceFeed)
        .filter((feed): feed is Address => Boolean(feed) && feed !== "11111111111111111111111111111111")
        .map((feed) => feed.toString()),
    );
    for (const [configPubkey, config] of scopeConfigurations) {
      if (!feedsInPlay.has(String(config.oraclePrices))) continue;
      const { Scope } = await import("@kamino-finance/scope-sdk");
      const scope = new Scope("mainnet-beta", rpc as never);
      const tokenIds = [...new Set(getTokenIdsForScopeRefresh(market, uniqueReserveAddresses.map((a) => address(a))).get(address(String(config.oraclePrices))) ?? [])];
      if (!tokenIds.length) continue;
      const refreshIx = await scope.refreshPriceListIx({ config: configPubkey as never }, tokenIds);
      if (refreshIx) {
        preInstructions.push(refreshIx as Instruction);
      }
    }
  } catch {
    // Scope refresh is best-effort: pyth/switchboard-priced paths don't need it.
  }

  for (const reserveAddress of uniqueReserveAddresses) {
    const reserve = market.getReserveByAddress(address(reserveAddress));
    if (reserve) preInstructions.push(buildRefreshReserveIx(market, reserve));
  }
  const refreshObligationIx = refreshObligation(
    { lendingMarket: market.getAddress(), obligation: obligationAddress },
    refreshAccounts.map((meta) => ({ address: meta.address, role: AccountRole.WRITABLE })),
    market.programId,
  );

  // Strategy instructions: liquidate V2 (redeems collateral) then swap to debt.
  const liquidationIx = liquidateObligationAndRedeemReserveCollateralV2(
    {
      liquidityAmount: new BN(repayAmountBaseUnits.toString()),
      minAcceptableReceivedLiquidityAmount: new BN(estCollateralBaseUnits.toString()),
      maxAllowedLtvOverridePercent: new BN(0),
    },
    {
      liquidationAccounts: {
        liquidator: signer,
        obligation: obligationAddress,
        lendingMarket: market.getAddress(),
        lendingMarketAuthority: await market.getLendingMarketAuthority(),
        repayReserve: repayReserve.address,
        repayReserveLiquidityMint: repayReserve.getLiquidityMint(),
        repayReserveLiquiditySupply: repayReserve.state.liquidity.supplyVault,
        withdrawReserve: withdrawReserve.address,
        withdrawReserveLiquidityMint: withdrawReserve.getLiquidityMint(),
        withdrawReserveCollateralMint: withdrawReserve.getCTokenMint(),
        withdrawReserveCollateralSupply: withdrawReserve.state.collateral.supplyVault,
        withdrawReserveLiquiditySupply: withdrawReserve.state.liquidity.supplyVault,
        withdrawReserveLiquidityFeeReceiver: withdrawReserve.state.liquidity.feeVault,
        userSourceLiquidity: debtAta,
        userDestinationCollateral: cTokenAta,
        userDestinationLiquidity: collAta,
        collateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
        repayLiquidityTokenProgram: repayReserve.getLiquidityTokenProgram(),
        withdrawLiquidityTokenProgram: withdrawReserve.getLiquidityTokenProgram(),
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_ADDRESS,
      },
      collateralFarmsAccounts: farmAccounts.collateralFarmsAccounts,
      debtFarmsAccounts: farmAccounts.debtFarmsAccounts,
      farmsProgram: market.farmsProgramId,
    },
    [],
    market.programId,
  );

  const budgetMerged: ExternalInstruction[] = [];

  // CU LIMIT: the swap backend must always pin a compute-unit limit. Our chain is
  // refresh×N + flash + liquidate + swap + repay (~15-25 ixs) — the node default
  // (200k × ix-count, capped 1.4M) is unreliable; the docs' own builder pins
  // extraComputeBudget=1_400_000. The re-sim pass below tightens this to the
  // measured consumption +25%.
  const cuLimitIx = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
  budgetMerged.unshift(instructionToExternal(cuLimitIx));

  // FASTLANE: bid the block space. Replaces/sets the CU price ix so the tx
  // outbids base-fee traffic in the race for the next block. Replace any
  // existing price instruction with the same discriminator to avoid duplicates.
  // When Sender is enabled the Sender lane owns the prize-scaled bid (the SOL
  // tip) and the CU price is pinned to the tier minimum — paying two competing
  // bids would double-burn the reward.
  const priority = senderLane
    ? { microlamportsPerCu: senderLane.microlamportsPerCu, tipUsd: senderLane.priorityFeeUsd, lane: `sender-${senderLane.tier}${senderLane.bundle ? "-bundle" : ""} (tip $${senderLane.tipUsd.toFixed(4)})` }
    : choosePriorityFee({
      computeUnitLimit: EXECUTOR_CU_LIMIT,
      priorityMode: input.priorityMode ?? "off",
      ...(input.prizeUsd !== undefined ? { prizeUsd: input.prizeUsd } : {}),
      ...(input.microlamportsPerCu !== undefined ? { microlamportsPerCu: input.microlamportsPerCu } : {}),
    });
  if (priority.microlamportsPerCu > 0) {
    const cuPriceIx = getSetComputeUnitPriceInstruction({
      microLamports: BigInt(priority.microlamportsPerCu),
    });
    const cuPriceExternal = instructionToExternal(cuPriceIx);
    const cuPriceIndex = budgetMerged.findIndex(
      (existing) => existing.programId === cuPriceExternal.programId && existing.data.slice(0, 8) === cuPriceExternal.data.slice(0, 8),
    );
    if (cuPriceIndex >= 0) budgetMerged.splice(cuPriceIndex, 1); // replace existing price
    budgetMerged.unshift(cuPriceExternal);
  }
  // CRITICAL ORDERING (learned the hard way — see klend source):
  // flash_borrow_reserve_liquidity ends with reserve.last_update.mark_stale(), so
  // any instruction needing a fresh repay reserve must run AFTER a refreshReserve
  // that FOLLOWS the flash borrow. Final order that passes on-chain:
  //   RefreshPriceList → RefreshReserve(debt) → RefreshReserve(coll) → RefreshObligation
  //   → FlashBorrow(debt) → RefreshReserve(debt AGAIN — clears flash's mark_stale)
  //   → Liquidate → Swap → FlashRepay
  // (the chain is assembled per-swap-plan inside buildSwapChain below)

  done = mark("assemble");
  const buildSwapChain = (plan: SwapPlan) =>
    buildFlashLoan({
      market,
      reserve: repayReserve,
      signer,
      tokenAccount,
      amountBaseUnits: repayAmountBaseUnits,
      strategy: externalInstructionsToStrategy(
        [instructionToExternal(buildRefreshReserveIx(market, repayReserve)), instructionToExternal(liquidationIx), ...plan.swapInstructions],
        budgetMerged,
        signer,
        [...preInstructions, refreshObligationIx],
      ),
      setupInstructions,
    });

  const packetSizes: string[] = [];
  const routeFailures: string[] = [];
  let lastLogs: string[] = [];
  let simulationSlot: number | undefined;
  let lastReason = "route validation deadline exceeded";
  let lastStage: "assemble" | "simulate" = "assemble";
  let clmmRetried = false;
  const selected = await validateRoutes({
    first: activeSwapPlan,
    budgetMs: 3_000,
    alternatives: () => [],
    validate: async (initialPlan) => {
      try {
        let plan = initialPlan;
        for (;;) {
          const built = await buildSwapChain(plan);
          let uncovered: string[] = [];
          const tx = await buildTransaction(rpc, input.rpcUrl, signer,
            built.instructions, [...(input.lookupTableAddresses ?? []), ...plan.lookupTables], (keys) => { uncovered = keys; });
          const wire = Buffer.from(getBase64EncodedWireTransaction(tx), "base64").length;
          packetSizes.push(`${plan.source}=${wire} bytes`);
          if (wire > 1232) {
            lastStage = "assemble";
            lastReason = `tx exceeds 1232-byte packet with resolved LUTs (${packetSizes.join(", ")}); uncovered=${uncovered.join(",")}`;
            return {};
          }
          const worst = profitBaseUnitsToUsd(plan.swapOutMin - repayAmountBaseUnits - built.feeBaseUnits, debtPriceBase);
          if (worst < input.minProfitUsd) {
            lastReason = `worst-case $${worst.toFixed(4)} < floor $${input.minProfitUsd}`;
            routeFailures.push(`${plan.source}: ${lastReason}`);
            return {};
          }
          if (input.skipSimulate) return { value: { plan, built, tx, consumedUnits: 0n, logs: [] as string[] } };
          lastStage = "simulate";
          const started = Date.now();
          const simulation = await simulateTransaction(rpc, tx);
          timings.simulate = (timings.simulate ?? 0) + Date.now() - started;
          simulationSlot = Number(simulation.context.slot);
          const logs = simulation.value.logs ?? [];
          const error = simulation.value.err;
          lastLogs = logs;
          if (!error) return { value: { plan, built, tx, consumedUnits: simulation.value.unitsConsumed ?? 0n, logs } };
          if (isHealthyLiquidationVeto(error, logs)) {
            lastReason = "ObligationHealthy (6016): Kamino refreshed the position and found it not liquidatable";
            return { terminal: true };
          }
          lastReason = `simulation failed: ${safeJsonStringify(error)}`;
          routeFailures.push(`${plan.source}: ${lastReason}`);
          if (!isClmmRouteFailure(error, logs, built.instructions)) return { terminal: true };
          // Route construction/state failure belongs to the pool, not the obligation.
          getClmmQuoter(input.rpcUrl).invalidate(
            new PublicKey(withdrawReserve.getLiquidityMint().toString()),
            new PublicKey(repayReserve.getLiquidityMint().toString()),
          );
          if (clmmRetried || !plan.source.startsWith("clmm-local/")) return {};
          clmmRetried = true;
          const refreshed = await withDeadline(buildLocalClmmPlan(), 350);
          if (!refreshed) return {};
          plan = refreshed;
        }
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        routeFailures.push(`${initialPlan.source}: ${lastReason}`);
        return {};
      }
    },
  });
  done();
  if (!selected) return {
    stage: lastStage, passed: false,
    reason: lastReason.startsWith("ObligationHealthy") ? lastReason
      : `${lastReason}; routes: ${routeFailures.join("; ")}; sizes: ${packetSizes.join(", ")}`,
    routeDiagnostics: [...quoteDiagnostics, ...routeFailures, ...packetSizes],
    logs: lastLogs, timings, ...(simulationSlot !== undefined ? { simulationSlot } : {}),
  };
  const { plan: activePlan, built: buildFinal, tx: transaction, consumedUnits, logs } = selected;
  const activeSwapOut = activePlan.swapOut;
  const activeSwapOutMin = activePlan.swapOutMin;

  // Gas guard: pin the CU limit to consumption + 25% headroom, then RE-SIMULATE
  // the pinned tx. If the pin (or anything race-y) broke it, we never send.
  // This is what keeps the on-chain failure rate at zero — sim must pass twice.
  // FAST mode keeps the simulated 1.4M CU limit and skips the second simulation.
  let finalTransaction = transaction;
  if (consumedUnits > 0n && !input.fast) {
    const cuLimit = BigInt(Math.min(1_400_000, Math.ceil(Number(consumedUnits) * 1.25)));
    const cuLimitIx = getSetComputeUnitLimitInstruction({ units: Number(cuLimit) });
    // Priority fees are charged on the requested CU limit: when we tighten the
    // limit we must raise the CU price to keep the Sender tier's lamport floor.
    const pinnedBudgetBase = upsertComputeBudget(budgetMerged, instructionToExternal(cuLimitIx));
    const pinnedBudget = senderLane
      ? upsertComputeBudget(pinnedBudgetBase, instructionToExternal(getSetComputeUnitPriceInstruction({
        microLamports: BigInt(priorityMicrolamports(senderLane.priorityFeeLamports, Number(cuLimit))),
      })))
      : pinnedBudgetBase;
    const pinnedBuild = await buildFlashLoan({
      market,
      reserve: repayReserve,
      signer,
      tokenAccount,
      amountBaseUnits: repayAmountBaseUnits,
      strategy: externalInstructionsToStrategy(
        [instructionToExternal(buildRefreshReserveIx(market, repayReserve)), instructionToExternal(liquidationIx), ...activePlan.swapInstructions],
        pinnedBudget,
        signer,
        [...preInstructions, refreshObligationIx],
      ),
      setupInstructions,
    }).catch(() => null);
    if (pinnedBuild) {
      const pinnedTx = await buildTransaction(
        rpc,
        input.rpcUrl,
        signer,
        pinnedBuild.instructions,
        [
          ...activePlan.lookupTables,
          ...(input.lookupTableAddresses ?? []),
        ],
      );
      done = mark("resim");
      const recheck = await simulateTransaction(rpc, pinnedTx);
      done();
      if (recheck.value?.err) {
        return {
          stage: "simulate",
          passed: false,
          reason: `re-sim (CU pin ${cuLimit}) failed: ${safeJsonStringify(recheck.value.err)}`,
          logs: (recheck.value?.logs ?? []).slice(-10),
          timings,
        };
      }
      finalTransaction = pinnedTx;
    }
  }

  // Guards: worst-case net profit (swap min-out − repay − flash fee) ≥ floor.
  const feeBaseUnits = buildFinal.feeBaseUnits;
  const netBaseUnits = activeSwapOutMin - repayAmountBaseUnits - feeBaseUnits;
  const quotedNetBaseUnits = activeSwapOut - repayAmountBaseUnits - feeBaseUnits;
  const worstCaseProfitUsd = profitBaseUnitsToUsd(netBaseUnits, debtPriceBase);
  const quotedProfitUsd = profitBaseUnitsToUsd(quotedNetBaseUnits, debtPriceBase);
  if (worstCaseProfitUsd < input.minProfitUsd) {
    return {
      stage: "simulate",
      passed: false,
      reason: `worst-case $${worstCaseProfitUsd.toFixed(4)} < floor $${input.minProfitUsd}`,
      logs,
      timings,
    };
  }

  // Sender cost gate (final, on the SIMULATED worst-case profit): the tip is
  // already baked into the transaction, so if the measured prize no longer
  // covers tip + priority + base + floor we must NOT broadcast. This is the
  // "prize tidak menutup biaya" refusal the operator asked for.
  if (senderLane) {
    const netAfterCostUsd = worstCaseProfitUsd - senderLane.estimatedCostUsd;
    const senderFloor = input.sender?.minProfitUsd ?? input.minProfitUsd;
    if (netAfterCostUsd < senderFloor) {
      return {
        stage: "simulate",
        passed: false,
        reason: `sender-${senderLane.tier} cost $${senderLane.estimatedCostUsd.toFixed(4)} (tip $${senderLane.tipUsd.toFixed(4)} + priority $${senderLane.priorityFeeUsd.toFixed(4)} + base) leaves $${netAfterCostUsd.toFixed(4)} of worst-case $${worstCaseProfitUsd.toFixed(4)} < floor $${senderFloor}`,
        logs,
        timings,
      };
    }
  }

  return {
    stage: "ready",
    passed: true,
    plan: {
      obligation: obligationAddress,
      healthFactor: health,
      repayReserveSymbol: repayInfo.symbol,
      withdrawReserveSymbol: withdrawReserve.getTokenSymbol(),
      repayAmountBaseUnits,
      repayUsd,
      estCollateralBaseUnits,
      estCollateralUsd: Number(new Decimal(estCollateralBaseUnits.toString()).mul(collPriceBase).toFixed(4)),
      quotedProfitUsd,
      worstCaseProfitUsd,
      ...(senderLane ? {
        senderCostUsd: senderLane.estimatedCostUsd,
        netWorstCaseProfitUsd: worstCaseProfitUsd - senderLane.estimatedCostUsd,
      } : {}),
      ...(activePlan.source ? { swapSource: activePlan.source } : {}),
    },
    transaction: finalTransaction,
    signer,
    computeUnitsConsumed: consumedUnits,
    routeDiagnostics: [...quoteDiagnostics, ...routeFailures, ...packetSizes],
    ...(simulationSlot !== undefined ? { simulationSlot } : {}),
    instructions: buildFinal.instructions.length,
    timings,
    priorityLane: priority.lane,
    tipUsd: priority.tipUsd,
    ...(senderLane ? {
      sender: {
        tier: senderLane.tier,
        bundle: senderLane.bundle,
        tipLamports: senderLane.tipLamports,
        tipUsd: senderLane.tipUsd,
        priorityFeeUsd: senderLane.priorityFeeUsd,
        estimatedCostUsd: senderLane.estimatedCostUsd,
      },
    } : {}),
  };
}
