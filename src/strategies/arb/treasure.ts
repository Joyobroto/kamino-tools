/**
 * Treasure screener: detects mispriced new pools (the viable playbook from
 * docs/ARB_TREASURE_RESEARCH.md).
 *
 * Pipeline per new pool:
 *   decode mints/vaults → fetch live vault balances (ghost filter)
 *   → honeypot guard (mint authority / freeze authority / decimals)
 *   → price from vault ratio → cross-venue compare (Jupiter) → event.
 *
 * Everything except the RPC fetches and the Jupiter quote is pure and
 * unit-tested; the module is wired together by scanTreasurePass().
 */

import type { DecodedPool } from "./venues.js";
import type { RpcClient, VaultBalances } from "./pools.js";
import { fetchVaultBalances } from "./pools.js";
import { fetchQuote } from "./quotes.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface TreasureScanOptions {
  /** Minimum USD value the SOL/quote vault side must hold to count as real. */
  minVaultUsd: number;
  /** Minimum price ratio (pool vs reference) to report, e.g. 1.05 = +5%. */
  minPriceRatio: number;
  /** Skip pools whose mints fail the honeypot guard. */
  requireSafeMint: boolean;
  /** Require the Jupiter reference market to absorb a probe sell (depth gate). */
  requireReferenceDepth: boolean;
  /** Probe size in USD for the reference depth gate. */
  depthProbeUsd: number;
}

export const DEFAULT_TREASURE_OPTIONS: TreasureScanOptions = {
  minVaultUsd: 1_000,
  minPriceRatio: 1.05,
  requireSafeMint: true,
  requireReferenceDepth: true,
  depthProbeUsd: 100,
};

/** Mint-layout flags (offsets verified on mainnet, see research doc). */
export interface MintInfo {
  mintAuthority: boolean;
  freezeAuthority: boolean;
  decimals: number;
}

/** SPL mint: option(4) authority(32) supply(8) decimals(1)@44 freezeOption(4)@46 freeze(32)@50. */
export function decodeMint(buf: Buffer): MintInfo | null {
  if (buf.length < 82) return null;
  return {
    mintAuthority: buf.readUInt32LE(0) === 1,
    freezeAuthority: buf.readUInt32LE(46) === 1,
    decimals: buf[44] ?? 0,
  };
}

export function isMintSafe(mint: MintInfo | null): boolean {
  if (!mint) return false;
  return !mint.mintAuthority && !mint.freezeAuthority;
}

/**
 * Human-readable SOL price: values >= 0.001 SOL print as plain decimals;
 * smaller values switch to sub-units so meme-coin prices never degrade into
 * scientific notation (9.423e-7 → "0.94 µSOL").
 */
export function formatSolPrice(sol: number): string {
  if (!Number.isFinite(sol) || sol <= 0) return "0 SOL";
  if (sol >= 0.001) {
    const digits = sol >= 100 ? 2 : sol >= 1 ? 4 : 6;
    return `${sol.toFixed(digits)} SOL`;
  }
  const units: Array<[number, string]> = [
    [1e-3, "mSOL"],
    [1e-6, "µSOL"],
    [1e-9, "nSOL"],
    [1e-12, "pSOL"],
  ];
  for (const [factor, label] of units) {
    if (sol >= factor) return `${(sol / factor).toFixed(2)} ${label}`;
  }
  return `${(sol / 1e-15).toFixed(2)} fSOL`;
}

/** Compact large amounts: 1.987e8 → "198.70M", 187.21 → "187.21", 0.94 → "0.94". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(4);
  if (abs === 0) return "0";
  return value.toExponential(2);
}

/** Everything we know about one pool after the on-chain fetch phase. */
export interface TreasurePoolState {
  pool: DecodedPool;
  vaultA: VaultBalances | null;
  vaultB: VaultBalances | null;
  mintAInfo: MintInfo | null;
  mintBInfo: MintInfo | null;
  mintSafe: boolean;
  /** UI units of each vault side (null when a vault is missing/empty). */
  vaultAUi: number | null;
  vaultBUi: number | null;
  /** Price of 1 tokenA in tokenB UI units; null when not computable. */
  priceAInB: number | null;
  /** Price of the non-SOL token in SOL UI units; null when pair is not SOL-based. */
  basePriceInSol: number | null;
}

export interface TreasureOpportunity {
  venue: string;
  poolAddress: string;
  baseMint: string;
  /** New-pool price of the base token in SOL (UI). */
  poolPriceInSol: number;
  /** Jupiter reference price of the base token in SOL (UI); null when unquotable. */
  referencePriceInSol: number | null;
  /** pool / reference. <1 means the pool sells the base CHEAPER than market. */
  ratio: number;
  vaultBaseUi: number;
  vaultSolUi: number;
  /** Reference-market depth verification (null when depth gate disabled). */
  referenceDepth: ReferenceDepth | null;
  detectedAt: string;
}

export type TreasureEvent =
  | { type: "scan"; at: string; poolsSeen: number; poolsReal: number; opportunities: number; errors: number }
  | { type: "pool"; at: string; state: TreasurePoolState }
  | { type: "opportunity"; at: string; opportunity: TreasureOpportunity };

/** Fills UI amounts and derived prices from vault balances. Pure. */
export function pricePool(state: Omit<TreasurePoolState, "vaultAUi" | "vaultBUi" | "priceAInB" | "basePriceInSol" | "mintSafe">): TreasurePoolState {
  const { vaultA, vaultB } = state;
  let vaultAUi: number | null = null;
  let vaultBUi: number | null = null;
  let priceAInB: number | null = null;
  let basePriceInSol: number | null = null;
  if (vaultA && vaultB && vaultA.amount > 0n && vaultB.amount > 0n) {
    vaultAUi = Number(vaultA.amount) / 10 ** vaultA.decimals;
    vaultBUi = Number(vaultB.amount) / 10 ** vaultB.decimals;
    priceAInB = vaultBUi / vaultAUi;
    if (state.pool.mintA === WSOL_MINT) basePriceInSol = 1 / priceAInB;
    else if (state.pool.mintB === WSOL_MINT) basePriceInSol = priceAInB;
  }
  return {
    ...state,
    vaultAUi,
    vaultBUi,
    priceAInB,
    basePriceInSol,
    mintSafe: isMintSafe(state.mintAInfo) && isMintSafe(state.mintBInfo),
  };
}

/**
 * Ghost-liquidity filter: the SOL side of the pool must hold real value.
 * (Empirically most "new pools" are one-sided graves — see ANB forensic.)
 */
export function isRealLiquidity(state: TreasurePoolState, minVaultUsd: number, solPriceUsd: number): boolean {
  const solUi = state.pool.mintA === WSOL_MINT ? state.vaultAUi : state.pool.mintB === WSOL_MINT ? state.vaultBUi : null;
  if (solUi === null || solPriceUsd <= 0) return false;
  return solUi * solPriceUsd >= minVaultUsd;
}

/**
 * Compares a pool state against a reference price (base-in-SOL) and returns
 * an opportunity when the pool price is at least `minPriceRatio` DISCOUNTED
 * vs the reference (buy cheap in the pool, sell at market). Pure.
 */
export function toOpportunity(
  state: TreasurePoolState,
  referencePriceInSol: number | null,
  minPriceRatio: number,
  at: string,
  referenceDepth: ReferenceDepth | null = null,
): TreasureOpportunity | null {
  if (state.basePriceInSol === null || state.basePriceInSol <= 0) return null;
  const baseMint = state.pool.mintA === WSOL_MINT ? state.pool.mintB : state.pool.mintA;
  const baseUi = state.pool.mintA === WSOL_MINT ? state.vaultBUi : state.vaultAUi;
  const solUi = state.pool.mintA === WSOL_MINT ? state.vaultAUi : state.vaultBUi;
  if (baseUi === null || solUi === null) return null;
  const discountThreshold = 1 / minPriceRatio;
  const quotable = referencePriceInSol !== null && referencePriceInSol > 0;
  const ratio = quotable ? state.basePriceInSol / referencePriceInSol! : Number.POSITIVE_INFINITY;
  // Buy-cheap direction: pool must sell the base meaningfully UNDER market.
  // Unquotable mints (no reference market anywhere) pass through with an
  // infinite ratio so a human can review them — they are never silently dropped.
  if (quotable && ratio > discountThreshold) return null;
  return {
    venue: state.pool.venue,
    poolAddress: state.pool.poolAddress,
    baseMint,
    poolPriceInSol: state.basePriceInSol,
    referencePriceInSol,
    ratio,
    vaultBaseUi: baseUi,
    vaultSolUi: solUi,
    referenceDepth,
    detectedAt: at,
  };
}

/**
 * Jupiter reference price: SOL per 1 base token (UI) — same unit direction as
 * TreasurePoolState.basePriceInSol so they divide directly. Returns null when
 * the mint is unquotable (unlisted).
 */
export async function fetchReferencePriceInSol(baseMint: string, baseDecimals: number, fetchImpl?: typeof fetch): Promise<number | null> {
  // base → SOL direction keeps both prices in "SOL per base" units.
  const quote = await fetchQuote(
    { inputMint: baseMint, outputMint: WSOL_MINT, amount: String(10 ** baseDecimals), slippageBps: 1_000 },
    fetchImpl,
  );
  if (!quote || quote.outAmount <= 0n) return null;
  const solOutUi = Number(quote.outAmount) / 1e9;
  return solOutUi > 0 ? solOutUi : null;
}

/**
 * REFERENCE DEPTH GATE (added 2026-09-06 after forensic showed 46/46 events
 * were mirages: Jupiter's "reference price" for fresh mints comes from
 * sniper-seeded dust pools holding < $1 — a price with zero executable size).
 *
 * Sells a probe amount of the base token through Jupiter and verifies the
 * reference market can actually absorb it: output value must be at least
 * `minOutputFraction` of the probe's market value.
 */
export interface ReferenceDepthOptions {
  /** Probe size in USD (at the pool's own price). */
  probeUsd: number;
  /** Minimum output value as a fraction of the probe value (e.g. 0.8 = 80%). */
  minOutputFraction: number;
  /** SOL price used to size the probe. */
  solPriceUsd: number;
}

export const DEFAULT_REFERENCE_DEPTH: ReferenceDepthOptions = {
  probeUsd: 100,
  minOutputFraction: 0.8,
  solPriceUsd: 0, // set by caller
};

export interface ReferenceDepth {
  ok: boolean;
  /** SOL actually receivable for the probe sell, null when unquotable. */
  probeSolOut: number | null;
  /** USD value of the probe output. */
  probeOutUsd: number | null;
}

export async function checkReferenceDepth(
  baseMint: string,
  baseDecimals: number,
  basePriceInSol: number,
  options: ReferenceDepthOptions,
  fetchImpl?: typeof fetch,
): Promise<ReferenceDepth> {
  if (basePriceInSol <= 0 || options.solPriceUsd <= 0) return { ok: false, probeSolOut: null, probeOutUsd: null };
  const basePerSol = 1 / basePriceInSol;
  const probeSol = options.probeUsd / options.solPriceUsd;
  const probeBaseUi = probeSol * basePerSol;
  const probeBaseRaw = BigInt(Math.floor(probeBaseUi * 10 ** baseDecimals));
  if (probeBaseRaw <= 0n) return { ok: false, probeSolOut: null, probeOutUsd: null };
  const quote = await fetchQuote(
    { inputMint: baseMint, outputMint: WSOL_MINT, amount: probeBaseRaw.toString(), slippageBps: 3_000 },
    fetchImpl,
  ).catch(() => null);
  if (!quote || quote.outAmount <= 0n) return { ok: false, probeSolOut: null, probeOutUsd: null };
  const probeSolOut = Number(quote.outAmount) / 1e9;
  const probeOutUsd = probeSolOut * options.solPriceUsd;
  return { ok: probeOutUsd >= options.probeUsd * options.minOutputFraction, probeSolOut, probeOutUsd };
}

/** Fetches + assembles the full on-chain state for one decoded pool. */
export async function hydratePoolState(rpc: RpcClient, pool: DecodedPool): Promise<TreasurePoolState> {
  const [vaultA, vaultB] = await fetchVaultBalances(rpc, pool);
  const mints = await rpc.getMultipleAccounts([pool.mintA, pool.mintB]);
  const mintAInfo = mints[0]?.data ? decodeMint(Buffer.from(mints[0].data[0], "base64")) : null;
  const mintBInfo = mints[1]?.data ? decodeMint(Buffer.from(mints[1].data[0], "base64")) : null;
  return pricePool({ pool, vaultA, vaultB, mintAInfo, mintBInfo });
}
