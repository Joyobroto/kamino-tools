/**
 * LST depeg executor (research/simulate-only): proves whether a detected
 * market-vs-oracle spread survives ATOMIC EXECUTION before any capital is risked.
 *
 * Play (premium direction — LST trades ABOVE its Kamino oracle rate):
 *   flashBorrow LST from Kamino (0% fee reserves: JitoSOL/JupSOL/dSOL)
 *     → swap LST→SOL at the market (Jupiter route)
 *     → swap SOL→LST ... NO — a round trip in one Jupiter route is circular.
 *
 * The actual atomic shape (verified feasible via the article's own logic):
 *   borrow LST → SELL LST for SOL at the expensive market
 *   → BUY LST back with fewer SOL (oracle-priced reference venue / best route)
 *   → repay principal (+0% fee) → keep the SOL difference.
 * Both legs are Jupiter swap-instructions embedded as strategy instructions
 * inside the existing buildFlashLoan sandwich — zero inventory, gas-only cost.
 *
 * The verdict is taken from the SIMULATION: pre/post token balances in the sim
 * reports show the exact P&L. No broadcast happens in this module.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112"; // was arb/treasure.js
export interface LstEntry {
  symbol: string;
  mint: string;
  decimals: number;
}

const SWAP_INSTRUCTIONS_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches the RAW Jupiter quote (JSON as returned — bigint-free, reusable for /swap-instructions). */
export async function fetchRawQuote(
  input: { inputMint: string; outputMint: string; amount: string; slippageBps: number; onlyDirectRoutes?: boolean },
  fetchImpl?: typeof fetch,
): Promise<RawQuote | null> {
  const impl = fetchImpl ?? fetch;
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount,
    slippageBps: String(input.slippageBps),
  });
  if (input.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await impl(`${QUOTE_URL}?${params}`, { headers: { Accept: "application/json" } }).catch(() => null);
    if (!response) continue;
    if (response.status === 400) return null; // unquotable
    if (response.status === 429) {
      await sleep(1_500 * attempt);
      continue;
    }
    if (!response.ok) continue;
    return (await response.json().catch(() => null)) as RawQuote | null;
  }
  return null;
}

export interface JupSwapInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

export interface JupSwapPlan {
  /** Normalized instructions to embed (swap + cleanup, minus compute budget). */
  swapInstructions: JupSwapInstruction[];
  /** Compute-budget instructions (must run as preInstructions). */
  computeBudgetInstructions: JupSwapInstruction[];
  /** Address lookup tables the swap requires. */
  addressLookupTableAddresses: string[];
  /** In/out amounts of the quoted route. */
  inAmount: string;
  outAmount: string;
  routeLabels: string[];
}

/**
 * Fetches ready-to-embed swap instructions from Jupiter for a quote.
 * `userPublicKey` must be our flash-loan wallet (the ATA owner).
 */
export async function fetchSwapInstructions(
  quoteResponse: unknown,
  userPublicKey: string,
  fetchImpl?: typeof fetch,
): Promise<JupSwapPlan | null> {
  const impl = fetchImpl ?? fetch;
  const response = await impl(SWAP_INSTRUCTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: false, dynamicSlippage: false }),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    swapInstruction?: JupSwapInstruction;
    setupInstructions?: JupSwapInstruction[];
    cleanupInstruction?: JupSwapInstruction | null;
    otherInstructions?: JupSwapInstruction[];
    computeBudgetInstructions?: JupSwapInstruction[];
    addressLookupTableAddresses?: string[];
  } | null;
  if (!payload?.swapInstruction) return null;
  const swapInstructions: JupSwapInstruction[] = [];
  for (const instruction of payload.setupInstructions ?? []) {
    // Setup (destination-ATA creation for the swap output) is REQUIRED when our
    // wallet lacks that ATA; duplicates between legs are deduped at merge time.
    swapInstructions.push(instruction);
  }
  swapInstructions.push(payload.swapInstruction);
  if (payload.cleanupInstruction) swapInstructions.push(payload.cleanupInstruction);
  const fingerprint = (instruction: JupSwapInstruction): string =>
    `${instruction.programId}|${instruction.data}|${instruction.accounts.map((a) => `${a.pubkey}:${a.isWritable}`).join(",")}`;
  return {
    swapInstructions,
    computeBudgetInstructions: payload.computeBudgetInstructions ?? [],
    addressLookupTableAddresses: payload.addressLookupTableAddresses ?? [],
    inAmount: String((quoteResponse as { inAmount?: string }).inAmount ?? ""),
    outAmount: String((quoteResponse as { outAmount?: string }).outAmount ?? ""),
    routeLabels: ((quoteResponse as { routePlan?: Array<{ swapInfo?: { label?: string } }> }).routePlan ?? []).map(
      (step) => step.swapInfo?.label ?? "?",
    ),
  };
}

/**
 * Raw (JSON-serializable) quote kept alongside the normalized one — Jupiter's
 * /swap-instructions endpoint expects the raw quote response verbatim.
 */
export interface RawQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  routePlan?: Array<unknown>;
  [key: string]: unknown;
}

export interface LstArbPlan {
  lst: LstEntry;
  direction: "premium" | "discount";
  /** Kamino-oracle SOL-per-LST reference. */
  oracleSolPerLst: number;
  /** Executable market SOL-per-LST (probe-verified). */
  marketSolPerLst: number;
  spreadBps: number;
  /** Borrow amount in LST base units. */
  amountBaseUnits: bigint;
  /** Raw quote responses, JSON-safe, ready for /swap-instructions. */
  legOutQuote: RawQuote | null;
  /** Leg 1 minimum SOL out (slippage-guarded). */
  legOutMin: bigint;
  /** Raw SOL→LST buyback quote. */
  legBackQuote: RawQuote | null;
  /** Leg 2 minimum LST out — must cover principal (0% fee) or the plan is dead. */
  legBackMin: bigint;
  /** Human-readable route labels for display. */
  routeLabels: string[];
  at: string;
}

export interface LstArbPlanOptions {
  /** Borrow size in USD (at oracle rate). */
  sizeUsd: number;
  /** SOL price for sizing. */
  solPriceUsd: number;
  /** Slippage tolerance per leg, bps. */
  slippageBps: number;
  /**
   * Restrict Jupiter routes to direct (single-hop) swaps. Multi-hop routes
   * inflate the versioned transaction past Solana's 1232-byte limit inside
   * the flash-loan sandwich — measured 1688 bytes with 4 hops.
   */
  onlyDirectRoutes?: boolean;
}

/**
 * Builds the atomic two-leg plan:
 *   leg1: borrow LST → sell for SOL at market
 *   leg2: buy LST back with (part of) the SOL
 * Profitable iff leg2 min-out ≥ principal + fee. Pure once quotes are fetched.
 */
export async function planLstArb(
  lst: LstEntry,
  oracleSolPerLst: number,
  solPriceUsd: number,
  options: LstArbPlanOptions,
  fetchImpl?: typeof fetch,
): Promise<LstArbPlanResult> {
  const impl = fetchImpl ?? fetch;
  const sizeLstUi = options.sizeUsd / (solPriceUsd * oracleSolPerLst);
  if (!(sizeLstUi > 0)) return { ok: false, reason: "size" };
  const amountBaseUnits = BigInt(Math.floor(sizeLstUi * 10 ** lst.decimals));
  if (amountBaseUnits <= 0n) return { ok: false, reason: "size" };

  // Leg 1: LST → SOL at market (raw quotes — reusable for /swap-instructions).
  const legOutRaw = await fetchRawQuote(
    { inputMint: lst.mint, outputMint: WSOL_MINT, amount: amountBaseUnits.toString(), slippageBps: options.slippageBps, onlyDirectRoutes: options.onlyDirectRoutes ?? false },
    impl,
  );
  if (!legOutRaw) return { ok: false, reason: "leg1-unquotable" };
  const legOutAmount = BigInt(legOutRaw.outAmount);
  const legOutMin = applySlippage(legOutAmount, options.slippageBps);

  // Leg 2: SOL → LST buyback, sized on leg-1 quoted output.
  const legBackRaw = await fetchRawQuote(
    { inputMint: WSOL_MINT, outputMint: lst.mint, amount: legOutAmount.toString(), slippageBps: options.slippageBps, onlyDirectRoutes: options.onlyDirectRoutes ?? false },
    impl,
  );
  if (!legBackRaw) return { ok: false, reason: "leg2-unquotable" };
  const legBackAmount = BigInt(legBackRaw.outAmount);
  const legBackMin = applySlippage(legBackAmount, options.slippageBps);

  const direction = legBackAmount > amountBaseUnits ? "premium" : "discount";
  // profit in LST base units at quote prices (before fees/slippage):
  const profitBaseUnits = legBackAmount - amountBaseUnits;
  const profitLstUi = Number(profitBaseUnits) / 10 ** lst.decimals;
  const profitUsd = profitLstUi * oracleSolPerLst * solPriceUsd;
  const spreadBps = Number(((legBackAmount - amountBaseUnits) * 10_000n) / amountBaseUnits);
  const labels = (raw: RawQuote): string[] =>
    ((raw.routePlan as Array<{ swapInfo?: { label?: string } }> | undefined) ?? []).map((step) => step.swapInfo?.label ?? "?");

  // The two legs must leave the ATA holding at least principal + flash fee, or
  // FlashRepay fails with insufficient funds — the simulation proved this exact
  // failure on a 4bps spread. Fail fast at plan time instead.
  if (legBackAmount <= amountBaseUnits) {
    return { ok: false, reason: `round-trip returns ${legBackAmount} < borrow ${amountBaseUnits} (spread too thin; needs a real depeg)` };
  }
  return {
    ok: true,
    plan: {
      lst,
      direction,
      oracleSolPerLst,
      marketSolPerLst: Number(legOutAmount) / 10 ** lst.decimals / (Number(amountBaseUnits) / 10 ** lst.decimals),
      spreadBps,
      amountBaseUnits,
      legOutQuote: legOutRaw,
      legOutMin,
      legBackQuote: legBackRaw,
      legBackMin,
      routeLabels: [...labels(legOutRaw), ...labels(legBackRaw)],
      at: new Date().toISOString(),
    },
    profitLstUi,
    profitUsd,
    // min-out enforced version: does the WORST-case still repay?
    worstCaseProfitUsd: ((Number(legBackMin - amountBaseUnits)) / 10 ** lst.decimals) * oracleSolPerLst * solPriceUsd,
  };
}

export type LstArbPlanResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      plan: LstArbPlan;
      profitLstUi: number;
      profitUsd: number;
      worstCaseProfitUsd: number;
    };

/** Applies slippage tolerance to a quoted out-amount (floor). */
export function applySlippage(outAmount: bigint, slippageBps: number): bigint {
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}
