/**
 * Cross-venue vault-truth scanner — detects same-(token,quote) pairs living in
 * two constant-product venues and evaluates the executable two-hop arbitrage.
 *
 * Detection source: OUR OWN on-chain vault balances (not Jupiter) → compares
 * vault mid-prices across venues → the planner (crossvenue-plan.ts) computes the
 * best swap size + net P&L with full AMM swap math.
 *
 * The scan is cheap: only the pools that pair our tracked quote assets are
 * decoded, and only the vaults of same-pair pools are re-fetched each pass.
 */

import type { RpcClient } from "./pools.js";
import { fetchVaultBalances, type VaultBalances } from "./pools.js";
import { decodePoolAccount, type DecodedPool } from "./venues.js";
import { constantsProductVenues } from "./crossvenue-venues.js";
import { DEFAULT_CP_FEE_BPS, planCrossVenue, type CrossVenuePlan } from "./crossvenue-plan.js";
import { orientPool, type CrossVenuePair, type PoolOrientation, vaultMidPrice } from "./crossvenue.js";
import { WSOL_MINT, SOL_DECIMALS } from "./crossvenue-venues.js";
import { fetchSolPriceUsdc } from "./quotes.js";

/** A (token, quote) market, each side mapping one venue to the pool holding it. */
export interface CvMarket {
  tokenMint: string;
  quoteMint: string;
  tokenDecimals: number;
  quoteDecimals: number;
  pools: Array<{ venue: string; pool: DecodedPool }>;
}

export interface CvScanOutcome {
  at: string;
  markets: number;
  pairsSeen: number;
  opportunities: CrossVenuePlan[];
  errors: number;
}

export interface CvScanOptions {
  /** Quote assets to track (v1: SOL). */
  quotes?: Array<{ mint: string; decimals: number; label: string }>;
  /** Minimum edge (after fees) in USD to report. */
  minNetUsd: number;
  /** Skip pairs where either quote vault holds < this SOL-equivalent. */
  minVaultUsd: number;
  /** Sol price in USD (0 → fetch). */
  solPriceUsd?: number;
}

const DEFAULT_QUOTES: Array<{ mint: string; decimals: number; label: string }> = [
  { mint: WSOL_MINT, decimals: SOL_DECIMALS, label: "SOL" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the cross-venue index for tracked quote assets: every constant-product
 * pool pairing the quote with any token, decoded once per pass.
 */
export async function buildCvIndex(
  rpc: RpcClient,
  options: CvScanOptions,
): Promise<CvMarket[]> {
  const quotes = options.quotes ?? DEFAULT_QUOTES;
  const markets = new Map<string, CvMarket>();
  for (const venue of constantsProductVenues()) {
    const addresses = await rpc.listProgramAccounts(venue.programId, [{ dataSize: venue.layout.poolAccountSize }]);
    const accounts = await rpc.getMultipleAccounts(addresses);
    for (let i = 0; i < addresses.length; i += 1) {
      const account = accounts[i];
      const base64 = account?.data?.[0];
      if (!base64) continue;
      const pool = decodePoolAccount(venue, addresses[i]!, Buffer.from(base64, "base64"));
      if (!pool) continue;
      // Keep only pools pairing a tracked quote asset with some other token.
      const quote = quotes.find((q) => pool.mintA === q.mint || pool.mintB === q.mint);
      if (!quote) continue;
      const tokenMint = pool.mintA === quote.mint ? pool.mintB : pool.mintA;
      const key = `${tokenMint}|${quote.mint}`;
      const market = markets.get(key) ?? { tokenMint, quoteMint: quote.mint, tokenDecimals: 0, quoteDecimals: quote.decimals, pools: [] };
      market.pools.push({ venue: venue.name, pool });
      // token decimals decoded lazily; fill when a vault mint is available later
      markets.set(key, market);
    }
  }
  return [...markets.values()];
}

/**
 * One scan pass. Builds the index once per call (RPC-heavy: full venue listings,
 * ~20-85s on the heavy damm-v2 venue). For production the caller should cache
 * the index and only re-fetch the pair VAULTS on subsequent passes (see the
 * CLI hot-watch mode).
 */
export async function scanCvPass(
  rpc: RpcClient,
  options: CvScanOptions,
): Promise<CvScanOutcome> {
  const at = new Date().toISOString();
  const solPriceUsd = options.solPriceUsd ?? (await fetchSolPriceUsdc().catch(() => 0));
  if (solPriceUsd <= 0) return { at, markets: 0, pairsSeen: 0, opportunities: [], errors: 0 };

  const markets = await buildCvIndex(rpc, options).catch(() => []);
  const opportunities: CrossVenuePlan[] = [];
  let pairsSeen = 0;
  let errors = 0;

  for (const market of markets) {
    if (market.pools.length < 2) continue;
    // refine decimals from a live vault (any pool's token side)
    try {
      const sample = market.pools[0]!;
      const vaults = await fetchVaultBalances(rpc, sample.pool);
      const tokenDecimals = market.tokenMint === sample.pool.mintA ? vaults[1]?.decimals ?? market.tokenDecimals : vaults[0]?.decimals ?? market.tokenDecimals;
      market.tokenDecimals = tokenDecimals;
    } catch {
      market.tokenDecimals = market.tokenDecimals;
    }

    // Compare every (A, B) venue pair for this market.
    for (let a = 0; a < market.pools.length; a += 1) {
      for (let b = a + 1; b < market.pools.length; b += 1) {
        const pa = market.pools[a]!;
        const pb = market.pools[b]!;
        if (pa.venue === pb.venue) continue;
        pairsSeen += 1;
        try {
          const [vaA, vaB] = await fetchVaultBalances(rpc, pa.pool);
          const [vbA, vbB] = await fetchVaultBalances(rpc, pb.pool);
          const orientA = vaultPair(pa.pool, vaA, vaB, market);
          const orientB = vaultPair(pb.pool, vbA, vbB, market);
          if (!orientA || !orientB) continue;
          if (!quotableDepth(orientA, solPriceUsd, options.minVaultUsd) || !quotableDepth(orientB, solPriceUsd, options.minVaultUsd)) continue;
          const plan = planCrossVenue(
            { tokenReserve: orientA.tokenAmount, quoteReserve: orientA.quoteAmount, tokenDecimals: market.tokenDecimals, quoteDecimals: market.quoteDecimals, venue: pa.venue },
            { tokenReserve: orientB.tokenAmount, quoteReserve: orientB.quoteAmount, tokenDecimals: market.tokenDecimals, quoteDecimals: market.quoteDecimals, venue: pb.venue },
            { solPriceUsd, feeBpsA: DEFAULT_CP_FEE_BPS, feeBpsB: DEFAULT_CP_FEE_BPS },
          );
          if (plan && plan.netUsd >= options.minNetUsd) {
            plan.tokenLabel = `${market.tokenMint.slice(0, 6)}`;
            opportunities.push(plan);
          }
        } catch {
          errors += 1;
        }
      }
    }
  }

  return { at, markets: markets.length, pairsSeen, opportunities, errors };
}

/** Picks the token/quote orientation of a pool's two live vault balances. */
function vaultPair(
  pool: DecodedPool,
  vaultABal: VaultBalances | null,
  vaultBBal: VaultBalances | null,
  market: CvMarket,
): { tokenAmount: bigint; tokenDecimals: number; quoteAmount: bigint; quoteDecimals: number } | null {
  if (!vaultABal || !vaultBBal) return null;
  const tokenSide = pool.mintA === market.tokenMint ? vaultABal : vaultBBal;
  const quoteSide = pool.mintA === market.tokenMint ? vaultBBal : vaultABal;
  if (!tokenSide || !quoteSide || tokenSide.amount <= 0n || quoteSide.amount <= 0n) return null;
  return {
    tokenAmount: tokenSide.amount,
    tokenDecimals: tokenSide.decimals,
    quoteAmount: quoteSide.amount,
    quoteDecimals: quoteSide.decimals,
  };
}

/** Depth gate: the quote side of each pool must hold at least minVaultUsd. */
function quotableDepth(o: { quoteAmount: bigint; quoteDecimals: number }, solPriceUsd: number, minVaultUsd: number): boolean {
  if (!(solPriceUsd > 0)) return false;
  const quoteUi = Number(o.quoteAmount) / 10 ** o.quoteDecimals;
  return quoteUi * solPriceUsd >= minVaultUsd;
}

export interface CvHotEntry {
  market: CvMarket;
  /** Last known vault amounts per pool address (refreshed each hot pass). */
  pools: Array<{ venue: string; pool: DecodedPool; tokenAmount: bigint; quoteAmount: bigint }>;
}