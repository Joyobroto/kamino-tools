import type { NormalizedQuote, QuoteInput } from "./types.js";

const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

interface RawQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string | number;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate.?limit|too many requests/i.test(message)) return true;
  const context = (error as { context?: { statusCode?: unknown } } | null)?.context;
  const statusCode = context?.statusCode;
  if (typeof statusCode === "number" && statusCode === 429) return true;
  if (typeof statusCode === "string" && statusCode === "429") return true;
  return false;
}

async function withBackoff<T>(operation: () => Promise<T>, label: string, maxBackoffMs = 20_000): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || delay > maxBackoffMs) throw error;
      console.warn(`${label} hit rate limit (attempt ${attempt}); retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, maxBackoffMs);
    }
  }
}

/** Fetches a Jupiter lite quote and normalizes it. Returns null when the pair is unquotable. */
export async function fetchQuote(input: QuoteInput, fetchImpl: typeof fetch = fetch): Promise<NormalizedQuote | null> {
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount,
    slippageBps: String(input.slippageBps ?? 50),
  });
  const raw = await withBackoff(async () => {
    const response = await fetchImpl(`${QUOTE_URL}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (response.status === 400) return null; // unquotable pair/token
    if (!response.ok) {
      throw new Error(`jupiter quote failed: HTTP ${response.status}`);
    }
    return (await response.json()) as RawQuoteResponse;
  }, "jupiter quote");
  if (!raw) return null;
  return {
    inputMint: raw.inputMint,
    outputMint: raw.outputMint,
    inAmount: BigInt(raw.inAmount),
    outAmount: BigInt(raw.outAmount),
    priceImpactPct: Number(raw.priceImpactPct ?? 0),
    routeLabels: (raw.routePlan ?? []).map((step) => step.swapInfo?.label ?? "?"),
    fetchedAt: new Date().toISOString(),
  };
}

/** USD size → base units for a mint with the given decimals. */
export function usdToBaseUnits(sizeUsd: number, decimals: number): string {
  return String(Math.floor(sizeUsd * 10 ** decimals));
}

/**
 * SOL price in USDC derived from a fresh quote (used to price SOL-denominated
 * profits without an extra oracle).
 */
export async function fetchSolPriceUsdc(fetchImpl: typeof fetch = fetch): Promise<number> {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const WSOL = "So11111111111111111111111111111111111111112";
  const quote = await fetchQuote({ inputMint: WSOL, outputMint: USDC, amount: String(1 * 10 ** 9), slippageBps: 50 }, fetchImpl);
  if (!quote) return 0;
  return Number(quote.outAmount) / 10 ** 6;
}
