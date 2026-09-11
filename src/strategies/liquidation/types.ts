export interface LiquidatableCandidate {
  obligation: string;
  tag: number;
  healthFactor: number;
  depositedValueUsd: number;
  borrowedValueUsd: number;
  largestDebt: {
    reserve: string;
    symbol: string;
    amountUsd: number;
  };
  /** Executor-priority debt; largestDebt remains portfolio display metadata. */
  repayDebt?: LiquidatableCandidate["largestDebt"];
  estimatedRepayUsd?: number;
  collateralSymbols: string[];
  /** Margin after protocol share and flash fee; excludes swap/network costs. */
  estimatedProfitUsd?: number;
}

export interface AdlCandidate extends LiquidatableCandidate {
  adlTargetLtvPct: number;
  currentLtvPct: number;
  marginCallAgeHours: number;
}

export interface ScanStats {
  nonVanilla: number;
  healthy: number;
  outOfBand: number;
  noFlashDebt: number;
  staleOracle: number;
  belowFloor: number;
}

export interface ScanResult {
  scannedAt: string;
  obligationsScanned: number;
  shortlistScanned: number;
  liquidatable: LiquidatableCandidate[];
  nearMiss: LiquidatableCandidate[];
  adlMarked: AdlCandidate[];
  stats: ScanStats;
  /** Health-watch band actually used for this scan (adaptive during surges). */
  effectiveHealthWatch?: number;
}

export interface ScanOptions {
  minDebtUsd: number;
  maxDebtUsd: number;
  profitFloorUsd: number;
  healthWatch: number;
  nearMissHealth: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  minDebtUsd: 100,
  maxDebtUsd: 5000,
  profitFloorUsd: 0.5,
  healthWatch: 1.1,
  nearMissHealth: 1.05,
};

export type ScanEvent =
  | { type: "snapshot"; at: string; result: ScanResult }
  | { type: "spotted"; at: string; candidate: LiquidatableCandidate }
  | { type: "promoted"; at: string; candidate: LiquidatableCandidate; fromHealth: number }
  | { type: "watching"; at: string; candidate: LiquidatableCandidate }
  | { type: "taken"; at: string; obligation: string; firstSpottedAt: string; satSeconds: number; wasDue: boolean }
  | { type: "healed"; at: string; obligation: string; lastHealth: number }
  | {
      type: "summary";
      at: string;
      obligationsScanned: number;
      shortlistScanned: number;
      liquidatable: number;
      nearMiss: number;
      hotTracked?: number;
      hotDue?: number;
      hotWatch?: number;
      adaptiveBand?: number;
    };
