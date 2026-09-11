import { firstUsable, withDeadline } from "./pipeline.js";
/**
 * Kamino liquidation executor — builds the atomic flash-borrow liquidation
 * sandwich for one DUE obligation, replicating the exact on-chain shape the
 * incumbent bot (LionX) uses:
 *
 *   refreshReserve(repay) + refreshReserve(withdraw) [+ any other obligation
 *     reserves] → refreshObligation → flashBorrow(debt asset) →
 *     LiquidateObligationAndRedeemReserveCollateralV2 (repays debt, redeems
 *     collateral to us) → Jupiter swap (collateral → debt asset) → flashRepay.
 *
 * Verdict chain (hard gates, same vocabulary as the LST executor):
 *   1. plan      — obligation must be DUE; repay amount sized to close factor;
 *                  flash borrow + swap must both be feasible
 *   2. assemble  — refresh + liquidate + Jupiter swap instructions embedded in
 *                  the flash-loan sandwich
 *   3. simulate  — full mainnet simulation; flashRepay must succeed
 *   4. guards    — worst-case net profit (min-out floors) ≥ profit floor
 *
 * Nothing here broadcasts — the caller decides, after its own operational
 * guards (budget caps, cooldown, kill switch), mirroring lst-autofire.
 */

import BN from "bn.js";
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
import { fetchKswapRoutes } from "./kswap.js";
import { safeJsonStringify } from "../../ui.js";
import { buildMarketReserveMap, healthFactor, obligationToCandidate } from "./filters.js";
import { hydrateShortlist, withBackoff } from "./screener.js";
import { applySlippage, fetchRawQuote, fetchSwapInstructions } from "../arb/lst-arb.js";

const ATA_PROGRAM = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";
const DEFAULT_CLOSE_FACTOR = 0.5;
const PRECISION_MARGIN_BPS = 20; // safety haircut on the collateral estimate

type FarmAccounts = {
  obligationFarmUserState: Option<Address>;
  reserveFarmState: Option<Address>;
};

/**
 * Resolve the farm accounts the liquidation V2 ix must carry — ZERO added fire
 * latency because it joins the existing paralel Promise.all (collateralForFarm
 * derivation is local math; only ONE batched getMultipleAccounts, kicked at the
 * same instant as the Jupiter quote).
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
   *  to Jupiter's budget estimate + generous margin instead of sim-measured units. */
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
}

export type LiquidationOutcome =
  | { stage: "plan"; passed: false; reason: string; timings?: Record<string, number> }
  | { stage: "assemble"; passed: false; reason: string; timings?: Record<string, number> }
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
        /** Which swap backend produced the plan: clmm-local | jupiter | kswap/<router>. */
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
    };

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

export async function executeLiquidationOnce(input: LiquidationInput): Promise<LiquidationOutcome> {
  const { rpc, market, obligationAddress } = input;
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

  const marketReserves = buildMarketReserveMap(market, Number(market.state.liquidationMaxDebtCloseFactorPct) || 100);

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
  if (!withdrawReserve) return { stage: "plan", passed: false, reason: "no collateral reserve candidate (none seizable)", timings };

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

  // 2. Repay amount: close factor from the MARKET STATE (docs best practice) × the
  // target borrow position, capped by flash availability.
  const closeFactorPct = Number(market.state.liquidationMaxDebtCloseFactorPct) || 100;
  const debtPriceBase = usdPerBaseUnit(repayReserve);
  if (debtPriceBase.lte(0)) return { stage: "plan", passed: false, reason: "repay reserve price invalid" , timings };
  // Docs best practice: repay = target borrow POSITION (lamports) × close factor —
  // avoids a USD round-trip that can drift against the program's own math.
  const repayAmountBaseUnits = BigInt(
    repayPick.borrow.amount.mul(new Decimal(closeFactorPct)).div(100).floor().toFixed(0),
  );
  if (repayAmountBaseUnits <= 0n) return { stage: "plan", passed: false, reason: "repay amount rounds to zero" , timings };

  const repayUsd = Number(new Decimal(repayAmountBaseUnits.toString()).mul(debtPriceBase).toFixed(4));

  const available = BigInt(repayReserve.getLiquidityAvailableAmount().floor().toFixed(0));
  if (repayAmountBaseUnits > available) {
    return { stage: "plan", passed: false, reason: `flash borrow ${repayAmountBaseUnits} > available ${available}` , timings };
  }

  // 3. Estimate the collateral the program will redeem for us — the LIQUIDATION
  //    BONUS comes from the WITHDRAW (collateral) reserve's config, not the debt
  //    side (docs: the bonus is paid in extra collateral, so the collateral
  //    reserve governs it; e.g. tBTC collateral = 5% min bonus vs 1% on majors).
  //    Conservative floor: minLiquidationBonusBps (just-past-threshold positions
  //    liquidate at the min — verified on-chain 2026-09-03).
  const collPriceBase = usdPerBaseUnit(withdrawReserve);
  const bonus = Number(withdrawReserve.state.config.minLiquidationBonusBps) / 10_000;
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
  //      KSwap (Kamino's official router, docs-blessed) serves quotes AND embeddable
  //      swap instructions in ONE call; the three ATA state fetches are independent.
  //      Jupiter quote+swap-instructions remains the fallback (2 sequential HTTP).
  done = mark("quote");
  // Fire-path trim: the signer (private-key decode + ed25519 derive) is
  // process-immutable — the shared hot cache serves it with zero work.
  const signer = await getCachedWalletSigner();

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
      tokenProgram: withdrawReserve.getLiquidityTokenProgram(),
    }),
  );

  interface SwapPlan {
    swapInstructions: ExternalInstruction[];
    lookupTables: Address[];
    swapOut: bigint;
    swapOutMin: bigint;
    source: string;
  }
  // Primary: the Jupiter pair (measured ~165ms, +0.5% better price than KSwap).
  // KSwap (Kamino's official router) is the FALLBACK — redundancy on the fire
  // path: if Jupiter is down/slow mid-race we still quote via api.kamino.finance.
  // A DIRECT-route variant is quoted in parallel: multi-hop routes stack 2+ swap
  // ix (~80 accounts) and can bust the 1232-byte packet; the direct variant is
  // the packet-safe fallback at a slightly worse price.
  const buildJupiterPlan = async (onlyDirectRoutes: boolean): Promise<SwapPlan | null> => {
    const quote = await fetchRawQuote({
      inputMint: withdrawReserve.getLiquidityMint().toString(),
      outputMint: repayReserve.getLiquidityMint().toString(),
      amount: estCollateralBaseUnits.toString(),
      slippageBps: input.slippageBps,
      onlyDirectRoutes,
    });
    if (!quote) return null;
    const plan = await fetchSwapInstructions(quote, signer.address.toString());
    if (!plan) return null;
    return {
      swapInstructions: plan.swapInstructions,
      lookupTables: plan.addressLookupTableAddresses.map((a: string) => address(a)),
      swapOut: BigInt(quote.outAmount),
      swapOutMin: applySlippage(BigInt(quote.outAmount), input.slippageBps),
      source: onlyDirectRoutes ? "jupiter-direct" : "jupiter",
    };
  };
  const buildKswapPlan = async (): Promise<SwapPlan | null> => {
    const kswap = await fetchKswapRoutes({
      rpcUrl: input.rpcUrl,
      wsUrl: input.rpcUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
      tokenIn: withdrawReserve.getLiquidityMint(),
      tokenOut: repayReserve.getLiquidityMint(),
      amountBaseUnits: estCollateralBaseUnits,
      slippageBps: input.slippageBps,
      executor: signer.address,
    });
    if (!kswap?.best) return null;
    return {
      swapInstructions: kswap.best.swapInstructions.map((ix) => instructionToExternal(ix)),
      lookupTables: kswap.best.lookupTableAddresses,
      swapOut: kswap.best.amountOut,
      swapOutMin: kswap.best.amountOutGuaranteed,
      source: `kswap/${kswap.best.routerType}`,
    };
  };
  // PRIMARY: the LOCAL Raydium CLMM quoter (phase 3) — zero HTTP on the fire path.
  // Warm quote ~3-5ms vs Jupiter ~80-150ms; validated within 0.017% of Jupiter live
  // and the instruction passes mainnet simulation. Falls back to Jupiter/KSwap when
  // the pair has no CLMM pool or the cache is cold mid-race.
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
    } catch {
      return null;
    }
  };
  done();
  // Start independent routes now; a warm local route never waits for Jupiter.
  done = mark("quoteWait");
  const routePromises = [
    withDeadline(buildLocalClmmPlan(), 350),
    withDeadline(buildJupiterPlan(false), 2_000),
    withDeadline(buildJupiterPlan(true), 2_000),
  ];
  let kswapPromise: Promise<SwapPlan | null> | undefined;
  const kswapPlan = () => kswapPromise ??= withDeadline(buildKswapPlan(), 2_000);
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
    firstUsable(routePromises),
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
  let swapPlan: SwapPlan | null = firstPlan;
  if (!swapPlan) {
    done = mark("kswapFallback");
    swapPlan = await kswapPlan();
    done();
  }
  if (!swapPlan) return { stage: "plan", passed: false, reason: "collateral→debt route unquotable (clmm+jupiter+kswap all failed)" , timings };
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
  if (!collAtaState) {
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
        tokenProgram: withdrawReserve.getLiquidityTokenProgram(),
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
      if (refreshIx) preInstructions.push(refreshIx as Instruction);
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
        collateralTokenProgram: withdrawReserve.getLiquidityTokenProgram(),
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
  // outbids base-fee traffic in the race for the next block. Jupiter's own
  // price ix (if present) is dropped for the same discriminator to avoid doubles.
  const priority = choosePriorityFee({
    computeUnitLimit: 1_400_000,
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
    if (cuPriceIndex >= 0) budgetMerged.splice(cuPriceIndex, 1); // drop Jupiter's
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

  // Size guard for EVERY swap backend, not just CLMM: the wire tx must fit
  // 1232 bytes or the RPC rejects it (-32602 / "too large" — the exact failure
  // mode that burned the 2026-09-08 ledger: KSwap multi-hop routes stack more
  // accounts than the ALTs cover). Measure the PRIMARY plan first; if it busts,
  // try every already-fetched fallback (jupiter → kswap) before giving up.
  const wireSizeOf = async (plan: SwapPlan): Promise<{ build: Awaited<ReturnType<typeof buildFlashLoan>>; tx: Awaited<ReturnType<typeof createSignedTransactionWithAltCached>> | null; tooLarge: boolean }> => {
    const built = await buildSwapChain(plan);
    const tx = await createSignedTransactionWithAltCached(rpc, input.rpcUrl, signer, built.instructions, [...plan.lookupTables, ...(input.lookupTableAddresses ?? [])]);
    const wire = tx ? Buffer.from(getBase64EncodedWireTransaction(tx), "base64").length : Number.POSITIVE_INFINITY;
    return { build: built, tx, tooLarge: wire > 1232 };
  };

  // Candidate order: the chosen plan first, then every other fetched plan as
  // fallback — including the packet-safe jupiter-direct variant. Unknown-null
  // (never quoted) plans are skipped.
  const fallbackPlans: SwapPlan[] = [];
  let chosenPlan = activeSwapPlan;
  const primary = await wireSizeOf(activeSwapPlan);
  let buildFinal = primary.build;
  let signedTx: Awaited<ReturnType<typeof createSignedTransactionWithAltCached>> | null = null;
  {
    if (primary.tooLarge) {
      // Only pay the fallback wait if the first usable route cannot fit.
      fallbackPlans.push(...(await Promise.all([...routePromises, kswapPlan()]))
        .filter((p): p is SwapPlan => p !== null && p !== activeSwapPlan));
      for (const fallback of fallbackPlans) {
        const attempt = await wireSizeOf(fallback);
        if (!attempt.tooLarge) {
          chosenPlan = fallback;
          buildFinal = attempt.build;
          signedTx = attempt.tx;
          break;
        }
      }
      if (!signedTx) {
        // Every backend busts the packet (account-heavy multi-hop market) —
        // fail the fire here rather than sending an RPC-rejected tx.
        return { stage: "assemble", passed: false, reason: `tx exceeds 1232-byte packet on every swap backend (${[activeSwapPlan, ...fallbackPlans].map((p) => p.source).join(", ")})`, timings };
      }
    } else {
      signedTx = primary.tx;
    }
  }
  const activePlan = chosenPlan;
  const activeSwapOut = activePlan === activeSwapPlan ? swapOut : activePlan.swapOut;
  const activeSwapOutMin = activePlan === activeSwapPlan ? swapOutMin : activePlan.swapOutMin;
  const transaction = signedTx
    ?? (await createSignedTransactionWithAltCached(
      rpc,
      input.rpcUrl,
      signer,
      buildFinal.instructions,
      [
        ...activePlan.lookupTables,
        ...(input.lookupTableAddresses ?? []),
      ],
    ));

  done();

  // BLIND-FIRE (skipSimulate): the on-chain program arbitrates; we return the
  // assembled tx immediately. Only viable for cheap tuition plays — a wrong
  // guess burns ~$0.001 of fee, but the same-slot speed is what wins marginal
  // dust positions (the 12:47 post-mortem: every sim'd dust attempt lost the
  // window to price oscillation, not to a competitor).
  if (input.skipSimulate) {
    done = mark("guards");
    const feeBaseUnitsBlind = buildFinal.feeBaseUnits;
    const netBaseUnitsBlind = activeSwapOutMin - repayAmountBaseUnits - feeBaseUnitsBlind;
    const quotedNetBaseUnitsBlind = activeSwapOut - repayAmountBaseUnits - feeBaseUnitsBlind;
    const worstCaseProfitUsdBlind = profitBaseUnitsToUsd(netBaseUnitsBlind, debtPriceBase);
    const quotedProfitUsdBlind = profitBaseUnitsToUsd(quotedNetBaseUnitsBlind, debtPriceBase);
    if (worstCaseProfitUsdBlind < input.minProfitUsd) {
      return { stage: "simulate", passed: false, reason: `worst-case $${worstCaseProfitUsdBlind.toFixed(4)} < floor $${input.minProfitUsd}`, logs: [], timings };
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
        quotedProfitUsd: quotedProfitUsdBlind,
        worstCaseProfitUsd: worstCaseProfitUsdBlind,
        ...(activePlan.source ? { swapSource: activePlan.source } : {}),
      },
      transaction,
      signer,
      computeUnitsConsumed: 0n,
      instructions: buildFinal.instructions.length,
      timings,
      priorityLane: priority.lane,
      tipUsd: priority.tipUsd,
    };
  }

  // Simulate.
  done = mark("simulate");
  const simulation = await withBackoff(() => simulate(rpc, transaction), "simulate");
  done();
  const logs = simulation.value?.logs ?? [];
  const simErr = simulation.value?.err;
  if (simErr) {
    return { stage: "simulate", passed: false, reason: `simulation failed: ${safeJsonStringify(simErr)}`, logs, timings };
  }
  // RPC reports total transaction consumption; the final program log is only
  // that program's invocation and can understate the whole chain drastically.
  const consumedUnits = simulation.value.unitsConsumed ?? 0n;

  // Gas guard: pin the CU limit to consumption + 25% headroom, then RE-SIMULATE
  // the pinned tx. If the pin (or anything race-y) broke it, we never send.
  // This is what keeps the on-chain failure rate at zero — sim must pass twice.
  // FAST mode keeps the simulated 1.4M CU limit and skips the second simulation.
  let finalTransaction = transaction;
  if (consumedUnits > 0n && !input.fast) {
    const cuLimit = BigInt(Math.min(1_400_000, Math.ceil(Number(consumedUnits) * 1.25)));
    const cuLimitIx = getSetComputeUnitLimitInstruction({ units: Number(cuLimit) });
    const pinnedBudget = upsertComputeBudget(budgetMerged, instructionToExternal(cuLimitIx));
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
      const pinnedTx = await createSignedTransactionWithAltCached(
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
      const recheck = await simulate(rpc, pinnedTx);
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
      ...(activePlan.source ? { swapSource: activePlan.source } : {}),
    },
    transaction: finalTransaction,
    signer,
    computeUnitsConsumed: consumedUnits,
    instructions: buildFinal.instructions.length,
    timings,
    priorityLane: priority.lane,
    tipUsd: priority.tipUsd,
  };
}