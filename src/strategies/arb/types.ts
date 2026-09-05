/** Mints whitelisted for arb research (no memecoins). */
export const MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  FDUSD: "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u",
  USDG: "7kYCUoNmdyT9KPzEZnL2wDdDUG2LZ9vUzCw8xGE2uMtN",
  PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjL2lkBq5VddFpGkQm",
  WSOL: "So11111111111111111111111111111111111111112",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe",
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpF3fZ4NZxXvdLHvGkd87",
} as const;

export type MintSymbol = keyof typeof MINTS;

/** Base-10 decimals for each mint (needed for USD sizing of quote amounts). */
export const MINT_DECIMALS: Record<MintSymbol, number> = {
  USDC: 6,
  USDT: 6,
  USDS: 6,
  FDUSD: 6,
  USDG: 6,
  PYUSD: 6,
  WSOL: 9,
  JitoSOL: 9,
  JupSOL: 9,
};

export interface QuoteInput {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

/** Minimal normalized quote shape used by the scanner. */
export interface NormalizedQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  routeLabels: string[];
  fetchedAt: string;
}

export interface RoundTripResult {
  base: MintSymbol;
  intermediate: MintSymbol;
  sizeUsd: number;
  /** out/in for the full base→intermediate→base round trip, in bps. */
  spreadBps: number;
  /** Absolute profit in base-mint base units (out − in), stringified for JSON safety. */
  profitBaseUnits: string;
  /** Profit in USD (approx, using 1:1 for stables; SOL priced via leg quotes when base is WSOL). */
  profitUsdApprox: number;
  priceImpactMaxPct: number;
  routeLabels: string[];
  fetchedAt: string;
}

export interface ArbScanOptions {
  /** Trade size per leg in USD. */
  sizeUsd: number;
  /** Minimum spread in bps to report. */
  minSpreadBps: number;
  /** Slippage buffer requested on quotes (bps). */
  slippageBps: number;
  /** Skip pairs whose max price impact exceeds this percentage. */
  maxPriceImpactPct: number;
  /** Mint symbols to scan as the base of each round trip. */
  bases: MintSymbol[];
  /** Mint symbols used as intermediates. */
  intermediates: MintSymbol[];
}

export const DEFAULT_ARB_SCAN_OPTIONS: ArbScanOptions = {
  sizeUsd: 100,
  minSpreadBps: 5,
  slippageBps: 50,
  maxPriceImpactPct: 1,
  bases: ["USDC"],
  intermediates: ["WSOL", "JitoSOL", "JupSOL", "USDT", "USDS", "FDUSD", "USDG", "PYUSD"],
};

export type ArbScanEvent =
  | { type: "scan"; at: string; pairsScanned: number; opportunities: number }
  | { type: "opportunity"; at: string; result: RoundTripResult };
