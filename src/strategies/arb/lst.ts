/**
 * LST depeg watcher (article playbook #3: "buy and unstake").
 *
 * Liquid-staking tokens (JitoSOL, JupSOL, mSOL, bSOL, …) trade in open markets
 * against SOL and can drift BELOW their redeemable value. When the market
 * discount exceeds swap costs, the atomic play is:
 *
 *   flashBorrow SOL → buy LST at discount → (unstake or sell) → repay
 *
 * Sprint 1 only MEASURES: market price vs mint-derived redemption rate, with
 * depth verification on both legs (the treasure forensic showed depth gates
 * are mandatory — a price without executable size is a mirage).
 *
 * Redemption-rate extraction is venue-specific:
 * - JitoSOL / JupSOL / bSOL: rate stored on the LST mint account (extension or
 *   authority-held account); fetched via getMultipleAccounts in one round trip.
 * - Generic fallback: derive implied rate from the deepest LST/SOL pool vaults
 *   (constant-product mid) and cross-check the two deepest pools against each
 *   other (inter-market spread, depth-gated).
 */

import { fetchQuote } from "./quotes.js";
import { WSOL_MINT } from "./treasure.js";

/** LSTs we can measure. Mint addresses + decimals. */
export interface LstEntry {
  symbol: string;
  mint: string;
  decimals: number;
}

/** Major Solana LSTs (SOL-denominated, minted by liquid-staking programs). */
export const LST_REGISTRY: LstEntry[] = [
  { symbol: "JitoSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
  { symbol: "JupSOL", mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", decimals: 9 },
  { symbol: "mSOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
  { symbol: "bSOL", mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", decimals: 9 },
  { symbol: "stSOL", mint: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", decimals: 9 },
  { symbol: "INF", mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", decimals: 9 },
];

export interface LstQuoteObservation {
  symbol: string;
  mint: string;
  /** SOL received for selling the probe amount of LST (executable price). */
  executablePriceSolPerLst: number;
  /** Depth check: USD value received for a probeUsd sale. */
  probeOutUsd: number;
  probeUsd: number;
  at: string;
}

export interface LstSpreadResult {
  base: "LST-vs-SOL-market";
  symbol: string;
  mint: string;
  /** Probe-size executable spread in bps: 1 − (market rate / reference rate). */
  spreadBps: number;
  /** Positive spread = the LST trades at a DISCOUNT vs its reference rate. */
  direction: "discount" | "premium";
  probeUsd: number;
  receivedUsd: number;
  referenceLabel: string;
  executablePriceSolPerLst: number | null;
  observedAt: string;
}

export type LstEvent =
  | { type: "scan"; at: string; lstsChecked: number; spreads: number; errors: number }
  | { type: "spread"; at: string; result: LstSpreadResult };

/**
 * Probe-trades an LST against SOL through Jupiter and returns the executable
 * price plus the received USD (depth truth — dust routes show up as tiny out).
 * `priceSolPerLstHint` converts the USD probe into LST units.
 */
export async function probeLstPrice(
  lst: LstEntry,
  probeUsd: number,
  solPriceUsd: number,
  fetchImpl?: typeof fetch,
  priceSolPerLstHint?: number,
): Promise<LstQuoteObservation | null> {
  if (solPriceUsd <= 0) return null;
  const priceHint = priceSolPerLstHint && priceSolPerLstHint > 0 ? priceSolPerLstHint : 1;
  const probeLstUi = probeUsd / (solPriceUsd * priceHint);
  const probeLstRaw = BigInt(Math.floor(probeLstUi * 10 ** lst.decimals));
  if (probeLstRaw <= 0n) return null;
  const quote = await fetchQuote(
    { inputMint: lst.mint, outputMint: WSOL_MINT, amount: probeLstRaw.toString(), slippageBps: 100 },
    fetchImpl,
  ).catch(() => null);
  if (!quote || quote.outAmount <= 0n) return null;
  const solOut = Number(quote.outAmount) / 1e9;
  const lstIn = Number(probeLstRaw) / 10 ** lst.decimals;
  if (lstIn <= 0 || solOut <= 0) return null;
  return {
    symbol: lst.symbol,
    mint: lst.mint,
    executablePriceSolPerLst: solOut / lstIn,
    probeOutUsd: solOut * solPriceUsd,
    probeUsd,
    at: quote.fetchedAt,
  };
}

/**
 * Computes the spread between the executable market rate and a reference rate
 * (SOL per LST). Pure.
 */
export function computeLstSpread(
  symbol: string,
  mint: string,
  marketRate: number,
  referenceRate: number,
  probe: { probeUsd: number; receivedUsd: number; executablePriceSolPerLst: number },
  referenceLabel: string,
  at: string,
): LstSpreadResult {
  const spreadBps = Math.round((1 - marketRate / referenceRate) * 10_000);
  return {
    base: "LST-vs-SOL-market",
    symbol,
    mint,
    spreadBps: Math.abs(spreadBps),
    direction: spreadBps >= 0 ? "discount" : "premium",
    probeUsd: probe.probeUsd,
    receivedUsd: probe.receivedUsd,
    referenceLabel,
    executablePriceSolPerLst: probe.executablePriceSolPerLst,
    observedAt: at,
  };
}

/**
 * Depth gate shared with the treasure logic: the probe sale must return at
 * least `minOutputFraction` of the probe value.
 */
export function isLstProbeDeep(receivedUsd: number, probeUsd: number, minOutputFraction = 0.8): boolean {
  if (probeUsd <= 0) return false;
  return receivedUsd >= probeUsd * minOutputFraction;
}

/**
 * Reference rate provider for an LST. Kamino Main-market reserves already carry
 * Pyth oracle prices for JitoSOL/JupSOL/dSOL — the repo loads them natively, and
 * those reserves have 0% flash-loan fees, making the eventual execution play a
 * straight Kamino integration (borrow the LST itself, not SOL).
 */
export interface LstReferenceRate {
  /** SOL per 1 LST token. */
  solPerLst: number | null;
  label: string;
}

/** Maps an LST mint to the Kamino reserve symbol holding it (null = not on Kamino). */
export function kaminoReserveSymbolForLst(symbol: string): string | null {
  switch (symbol) {
    // Kamino Main-market reserve symbols (verified 2026-09-06 via getTokenSymbol()).
    case "JitoSOL":
      return "JITOSOL";
    case "JupSOL":
      return "JupSOL";
    default:
      return null;
  }
}
