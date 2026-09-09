import { createSolanaRpc, createSolanaRpcSubscriptions, type Address, type Instruction, type Rpc, type SolanaRpcApi, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import BN from "bn.js";

/**
 * KSwap swap backend — Kamino's official router (api.kamino.finance/kswap).
 *
 * Why: the docs-blessed path (kamino.com liquidation-bot + repay-with-collateral
 * tutorials) routes swaps through KSwap. One getAllRoutes call returns, per route:
 * the guaranteed out-amount AND fully embeddable swap instructions + lookup tables
 * — replacing our old Jupiter pair (quote + swap-instructions = 2 sequential HTTP
 * round-trips, ~190ms) with a single HTTP call. Multiple routers (okx, dflow,
 * jupiter variants) compete on price in the same response.
 *
 * LionX parity note: Apex (LionX's backend) is a closed program with zero HTTP,
 * but KSwap gets us to one round-trip on the official rails — the swap quote is
 * derived fresh per fire, instructions embed identically to Jupiter's.
 */

// The router set blessed by Kamino's own repay-with-collateral tutorial.
const ALLOWED_ROUTERS = ["dflow", "jupiter", "jupiterU", "okx", "jupiterLite"] as const;

export const KSWAP_API_BASE = "https://api.kamino.finance/kswap";

// One SDK instance per (rpc, ws) pair — the SDK holds axios + router caches.
const sdkCache = new Map<string, Promise<import("@kamino-finance/kswap-sdk").KswapSdk>>();

async function getKswapSdk(rpcUrl: string, wsUrl: string): Promise<import("@kamino-finance/kswap-sdk").KswapSdk> {
  const key = `${rpcUrl}|${wsUrl}`;
  const cached = sdkCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const { KswapSdk } = await import("@kamino-finance/kswap-sdk");
    const rpc = createSolanaRpc(rpcUrl);
    const subs = createSolanaRpcSubscriptions(wsUrl);
    return new KswapSdk(KSWAP_API_BASE, rpc, subs);
  })();
  sdkCache.set(key, promise);
  return promise;
}

// RouterContext (mint infos) per token pair — cached. loadRouterContext costs one
// RPC round-trip per pair the first time; mint info (program owner, decimals) is
// static, so we cache forever. Hot-path pairs (SOL↔USDC etc.) resolve from the
// SDK's own SOL_MINT_INFO shortcut with zero RPC.
const routerContextCache = new Map<string, Promise<import("@kamino-finance/kswap-sdk/dist/swap_api_utils/RouterContext.js").IRouterContext>>();

async function getRouterContext(
  rpcUrl: string,
  tokenIn: Address,
  tokenOut: Address,
): Promise<import("@kamino-finance/kswap-sdk/dist/swap_api_utils/RouterContext.js").IRouterContext> {
  const key = `${rpcUrl}|${tokenIn}|${tokenOut}`;
  const cached = routerContextCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const { loadRouterContext } = await import("@kamino-finance/kswap-sdk/dist/swap_api_utils/RouterContext.js");
    const rpc = createSolanaRpc(rpcUrl);
    return loadRouterContext(rpc, tokenIn, tokenOut);
  })();
  routerContextCache.set(key, promise);
  return promise;
}

export interface KswapRoute {
  routerType: string;
  /** Exact input amount, base units. */
  amountIn: bigint;
  /** Guaranteed minimum output, base units (slippage-protected). */
  amountOutGuaranteed: bigint;
  /** Quoted (expected) output, base units. */
  amountOut: bigint;
  /** Embeddable swap instructions (ATA/wrap/swap/unwrap already ordered). */
  swapInstructions: Instruction[];
  /** Lookup table account addresses the route requires. */
  lookupTableAddresses: Address[];
}

export interface KswapQuoteResult {
  routes: KswapRoute[];
  best: KswapRoute | null;
}

/**
 * Quote AND fetch swap instructions in one call. Mirrors the shape of our
 * Jupiter fetchRawQuote+fetchSwapInstructions pair but single-round-trip and
 * multi-router. Returns null when no router can serve the pair.
 */
export async function fetchKswapRoutes(input: {
  rpcUrl: string;
  wsUrl: string;
  tokenIn: Address;
  tokenOut: Address;
  amountBaseUnits: bigint;
  slippageBps: number;
  executor: Address;
}): Promise<KswapQuoteResult | null> {
  const sdk = await getKswapSdk(input.rpcUrl, input.wsUrl);
  let response;
  try {
    const ctx = await getRouterContext(input.rpcUrl, input.tokenIn, input.tokenOut);
    response = await sdk.getAllRoutes({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amount: new BN(input.amountBaseUnits.toString()),
      swapType: "exactIn",
      maxSlippageBps: input.slippageBps,
      executor: input.executor,
      routerTypes: [...ALLOWED_ROUTERS],
      includeRfq: false,
      includeLimoLogs: false,
      wrapAndUnwrapSol: false,
    }, ctx);
  } catch {
    return null;
  }
  const routes: KswapRoute[] = [];
  for (const route of response.routes ?? []) {
    const ixs = route.instructions;
    if (!ixs) continue;
    const guaranteed = route.amountsExactIn.amountOutGuaranteed;
    if (guaranteed.lten(0)) continue;
    routes.push({
      routerType: String(route.routerType),
      amountIn: BigInt(route.amountsExactIn.amountIn.toString()),
      amountOutGuaranteed: BigInt(guaranteed.toString()),
      amountOut: BigInt(route.amountsExactIn.amountOut.toString()),
      swapInstructions: [
        ...(ixs.createInAtaIxs ?? []),
        ...(ixs.wrapSolIxs ?? []),
        ...(ixs.swapIxs ?? []),
        ...(ixs.unwrapSolIxs ?? []),
        ...(ixs.createOutAtaIxs ?? []),
      ],
      lookupTableAddresses: (route.lookupTableAccounts ?? []).map((a) => a.address as Address),
    });
  }
  // Best = highest guaranteed out (conservative: what we can actually enforce on-chain).
  routes.sort((a, b) => (b.amountOutGuaranteed > a.amountOutGuaranteed ? 1 : -1));
  return { routes, best: routes[0] ?? null };
}
