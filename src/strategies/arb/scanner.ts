/**
 * Scanner orchestration: quote round-trip passes (arb-scan) and pool-feed
 * treasure passes (treasure-scan).
 */

import { fetchQuote, fetchSolPriceUsdc, usdToBaseUnits } from "./quotes.js";
import { buildRoundTrip, rankByProfit } from "./spread.js";
import { MINTS, MINT_DECIMALS, type ArbScanEvent, type ArbScanOptions, type RoundTripResult } from "./types.js";
import { type RpcClient } from "./pools.js";
import { PoolFeed } from "./pools.js";
import { fetchVaultBalances, type VaultBalances } from "./pools.js";
import { decodePoolAccount, venueByName, type DecodedPool, type Venue } from "./venues.js";
import { LST_REGISTRY, computeLstSpread, probeLstPrice, isLstProbeDeep, kaminoReserveSymbolForLst, type LstEntry, type LstEvent, type LstSpreadResult } from "./lst.js";
import bs58 from "bs58";

const bs58Encode = (bytes: Uint8Array): string => bs58.encode(bytes);
import {
  DEFAULT_TREASURE_OPTIONS,
  checkReferenceDepth,
  hydratePoolState,
  isRealLiquidity,
  toOpportunity,
  fetchReferencePriceInSol,
  WSOL_MINT,
  type TreasureEvent,
  type TreasureOpportunity,
  type TreasureScanOptions,
} from "./treasure.js";

export interface ScannerDeps {
  fetchImpl?: typeof fetch;
  onEvent?: (event: ArbScanEvent) => void;
}

export interface ScanOutcome {
  at: string;
  pairsScanned: number;
  opportunities: RoundTripResult[];
}

/**
 * Runs one full pass: for every (base, intermediate) pair in the options,
 * quotes base→intermediate→base and evaluates the round-trip spread.
 */
export async function scanArbPass(
  options: ArbScanOptions,
  deps: ScannerDeps = {},
): Promise<ScanOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const at = new Date().toISOString();

  const solPriceUsd = await fetchSolPriceUsdc(fetchImpl).catch(() => 0);

  const opportunities: RoundTripResult[] = [];
  let pairsScanned = 0;

  for (const base of options.bases) {
    const baseMint = MINTS[base];
    const baseDecimals = MINT_DECIMALS[base];
    const sizeBaseUnits = usdToBaseUnits(options.sizeUsd, baseDecimals);

    for (const intermediate of options.intermediates) {
      if (intermediate === base) continue;
      const intermediateMint = MINTS[intermediate];

      const legOut = await fetchQuote(
        { inputMint: baseMint, outputMint: intermediateMint, amount: sizeBaseUnits, slippageBps: options.slippageBps },
        fetchImpl,
      );
      if (!legOut || legOut.outAmount <= 0n) {
        pairsScanned += 1;
        continue;
      }
      const legBack = await fetchQuote(
        { inputMint: intermediateMint, outputMint: baseMint, amount: legOut.outAmount.toString(), slippageBps: options.slippageBps },
        fetchImpl,
      );
      pairsScanned += 1;
      if (!legBack) continue;

      const result = buildRoundTrip(base, intermediate, options.sizeUsd, legOut, legBack, solPriceUsd);
      if (!result) continue;
      if (result.spreadBps >= options.minSpreadBps && result.priceImpactMaxPct <= options.maxPriceImpactPct) {
        opportunities.push(result);
        deps.onEvent?.({ type: "opportunity", at: result.fetchedAt, result });
      }
    }
  }

  deps.onEvent?.({ type: "scan", at, pairsScanned, opportunities: opportunities.length });
  return { at, pairsScanned, opportunities: rankByProfit(opportunities, 0) };
}

export interface TreasureScanOutcome {
  at: string;
  poolsSeen: number;
  poolsReal: number;
  opportunities: TreasureOpportunity[];
  errors: number;
}

export interface TreasureScannerDeps {
  fetchImpl?: typeof fetch;
  onEvent?: (event: TreasureEvent) => void;
  /** Injected in tests; defaults to real time. */
  now?: () => string;
}

/**
 * One treasure pass over the pool feed: diff-scan venues, hydrate new pools,
 * ghost-filter, honeypot-guard, price, and compare with Jupiter reference.
 */
export async function scanTreasurePass(
  feed: PoolFeed,
  rpc: RpcClient,
  options: TreasureScanOptions = DEFAULT_TREASURE_OPTIONS,
  deps: TreasureScannerDeps = {},
): Promise<TreasureScanOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const at = (deps.now ?? (() => new Date().toISOString()))();

  let poolsSeen = 0;
  let poolsReal = 0;
  let poolsDiscounted = 0;
  let errors = 0;
  const opportunities: TreasureOpportunity[] = [];

  const solPriceUsd = await fetchSolPriceUsdc(fetchImpl).catch(() => 0);

  const deltas = await feed.scan();
  for (const delta of deltas) {
    if (!delta.newPools.length) continue;
    const decoded = await feed.decodePools(delta.venue, delta.newPools).catch(() => {
      errors += delta.newPools.length;
      return [];
    });
    for (const pool of decoded) {
      poolsSeen += 1;
      try {
        const state = await hydratePoolState(rpc, pool);
        deps.onEvent?.({ type: "pool", at, state });
        if (options.requireSafeMint && !state.mintSafe) continue;
        if (!isRealLiquidity(state, options.minVaultUsd, solPriceUsd)) continue;
        poolsReal += 1;
        if (state.basePriceInSol === null) continue; // pair must be SOL-based for v1
        const baseMint = pool.mintA === WSOL_MINT ? pool.mintB : pool.mintA;
        const baseInfo = pool.mintA === WSOL_MINT ? state.mintBInfo : state.mintAInfo;
        const reference = await fetchReferencePriceInSol(baseMint, baseInfo?.decimals ?? 0, fetchImpl).catch(() => null);
        const discounted = toOpportunity(state, reference, options.minPriceRatio, at);
        if (!discounted) continue;
        poolsDiscounted += 1;
        // Depth gate: only report pools whose reference market can absorb a
        // probe sell (46/46 first-night events were dust-reference mirages).
        const depth = options.requireReferenceDepth
          ? await checkReferenceDepth(
              baseMint,
              baseInfo?.decimals ?? 0,
              state.basePriceInSol,
              { probeUsd: options.depthProbeUsd, minOutputFraction: 0.8, solPriceUsd },
              fetchImpl,
            ).catch(() => null)
          : null;
        if (options.requireReferenceDepth && !(depth?.ok ?? false)) continue;
        const opportunity = toOpportunity(state, reference, options.minPriceRatio, at, depth);
        if (opportunity) {
          opportunities.push(opportunity);
          deps.onEvent?.({ type: "opportunity", at, opportunity });
        }
      } catch {
        errors += 1;
      }
    }
  }

  const outcome: TreasureScanOutcome = { at, poolsSeen, poolsReal, opportunities, errors };
  deps.onEvent?.({ type: "scan", at, poolsSeen, poolsReal, opportunities: opportunities.length, errors });
  return outcome;
}

export interface LstScanOptions {
  /** USD size of the executable probe per LST. */
  probeUsd: number;
  /** Minimum |spread| in bps to report. */
  minSpreadBps: number;
  /** LSTs to scan (defaults to the registry). */
  lsts: LstEntry[];
}

export const DEFAULT_LST_OPTIONS: LstScanOptions = {
  probeUsd: 1_000,
  minSpreadBps: 20,
  lsts: LST_REGISTRY,
};

export interface LstScanOutcome {
  at: string;
  lstsChecked: number;
  spreads: LstSpreadResult[];
  errors: number;
}

export interface LstScannerDeps {
  fetchImpl?: typeof fetch;
  onEvent?: (event: LstEvent) => void;
  now?: () => string;
  /** Kamino-oracle reference rates (wired by the CLI; null disables spread checks). */
  reference?: LstReferenceProvider;
}

/** One LST market observation from a single pool. */
interface LstPoolView {
  pool: DecodedPool;
  lst: LstEntry;
  vaultLst: VaultBalances;
  vaultSol: VaultBalances;
  priceSolPerLst: number;
  /** Depth proxy: SOL side value in SOL units. */
  solDepth: number;
}

/**
 * Sol-per-LST reference rates sourced from Kamino Main-market reserves (Pyth
 * oracle). The repo already loads the market for the liquidation watcher; the
 * same LST reserves (JitoSOL/JupSOL/dSOL) have 0% flash-loan fees — the
 * eventual execution play borrows the LST itself from Kamino, so this is the
 * reference the P&L model must use, not any single DEX pool.
 */
export type LstReferenceProvider = (lstSymbol: string) => { solPerLst: number | null; label: string } | null;

/**
 * Builds the reference-rate provider from a loaded Kamino market. Each LST maps
 * to its reserve symbol; oracle price is USD → SOL-per-LST via WSOL oracle.
 */
export function kaminoLstReference(market: { getReserves: () => Array<{ getTokenSymbol: () => string; getLiquidityMint: () => { toString(): string }; getOracleMarketPrice: () => { toString(): string }; hasValidOraclePrice: () => boolean }> }): LstReferenceProvider {
  const byMint = new Map<string, { priceUsd: number; symbol: string }>();
  for (const reserve of market.getReserves()) {
    if (!reserve.hasValidOraclePrice()) continue;
    byMint.set(reserve.getLiquidityMint().toString(), { priceUsd: Number(reserve.getOracleMarketPrice().toString()), symbol: reserve.getTokenSymbol() });
  }
  return (lstSymbol: string) => {
    const reserveSymbol = kaminoReserveSymbolForLst(lstSymbol);
    if (!reserveSymbol) return null;
    const lst = [...byMint.entries()].find(([, v]) => v.symbol === reserveSymbol);
    const sol = [...byMint.entries()].find(([mint]) => mint === WSOL_MINT);
    if (!lst || !sol) return null;
    const solUsd = sol[1].priceUsd;
    const lstUsd = lst[1].priceUsd;
    if (!(solUsd > 0) || !(lstUsd > 0)) return null;
    return { solPerLst: lstUsd / solUsd, label: `Kamino oracle (${reserveSymbol})` };
  };
}

/**
 * One LST depeg pass: compare the executable market rate (Jupiter probe,
 * depth-verified) against the Kamino oracle reference. Pools are scanned for
 * optional per-venue context; the SPREAD itself is market-vs-oracle — the only
 * comparison that matters for the borrow-LST-→sell→repay play.
 */
export async function scanLstPass(
  rpc: RpcClient,
  options: LstScanOptions = DEFAULT_LST_OPTIONS,
  deps: LstScannerDeps = {},
): Promise<LstScanOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const solPriceUsd = await fetchSolPriceUsdc(fetchImpl).catch(() => 0);
  const reference = deps.reference ?? null;

  const spreads: LstSpreadResult[] = [];
  let lstsChecked = 0;
  let errors = 0;

  for (const lst of options.lsts) {
    try {
      lstsChecked += 1;
      const ref = reference?.(lst.symbol) ?? null;
      // Executable market probe through Jupiter. First probe uses the oracle
      // rate as the sizing hint (falls back to 1 when unavailable).
      const probe = await probeLstPrice(lst, options.probeUsd, solPriceUsd, fetchImpl, ref?.solPerLst ?? undefined);
      if (!probe || solPriceUsd <= 0) continue;
      if (!isLstProbeDeep(probe.probeOutUsd, probe.probeUsd)) continue;
      if (!ref || ref.solPerLst === null) continue;
      const result = computeLstSpread(
        lst.symbol,
        lst.mint,
        probe.executablePriceSolPerLst,
        ref.solPerLst,
        { probeUsd: probe.probeUsd, receivedUsd: probe.probeOutUsd, executablePriceSolPerLst: probe.executablePriceSolPerLst },
        ref.label,
        at,
      );
      if (result.spreadBps >= options.minSpreadBps) {
        spreads.push(result);
        deps.onEvent?.({ type: "spread", at, result });
      }
    } catch {
      errors += 1;
    }
  }

  const outcome: LstScanOutcome = { at, lstsChecked, spreads, errors };
  deps.onEvent?.({ type: "scan", at, lstsChecked, spreads: spreads.length, errors });
  return outcome;
}
