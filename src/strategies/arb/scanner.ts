import { fetchQuote, fetchSolPriceUsdc, usdToBaseUnits } from "./quotes.js";
import { buildRoundTrip, rankByProfit } from "./spread.js";
import { MINTS, MINT_DECIMALS, type ArbScanEvent, type ArbScanOptions, type RoundTripResult } from "./types.js";

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
