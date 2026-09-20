import { createFailoverRpc } from "../../rpc-failover.js";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

/** Cached Raydium pool snapshots. Quotes and builders share one immutable snapshot;
 * simulation remains mandatory because prices can move after any read. */
const CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const MAX_AMM_CONFIG_INDEX = 7;
export const CLMM_STATE_TTL_MS = 1_000;
const REGISTRY_TTL_MS = 60_000;

// ─── singleton per RPC endpoint (the executor and the scan-cycle warmer share state) ───
const quoterSingletons = new Map<string, ClmmLocalQuoter>();
export function getClmmQuoter(rpcUrl: string): ClmmLocalQuoter {
  const cached = quoterSingletons.get(rpcUrl);
  if (cached) return cached;
  const quoter = new ClmmLocalQuoter(rpcUrl);
  quoterSingletons.set(rpcUrl, quoter);
  return quoter;
}

/** Convert a web3.js TransactionInstruction to the repo's ExternalInstruction
 *  shape (programId base58, data base64, accounts) so it embeds into the
 *  kit-based flash-loan strategy pipeline. */
export function web3InstructionToExternal(instruction: TransactionInstruction): {
  programId: string;
  data: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
} {
  return {
    programId: instruction.programId.toBase58(),
    data: Buffer.from(instruction.data).toString("base64"),
    accounts: instruction.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  };
}

/** Static + active-range accounts for a CLMM pair, for OUR persistent ALT:
 *  program, pool, ammConfig, vaults, mints, observation, ex-bitmap, and the
 *  tick-array PDAs around the current tick. The executor measures packet size
 *  and can try other routes when coverage no longer fits. */
export async function clmmAltKeys(
  rpcUrl: string,
  pairs: Array<{ mintA: string; mintB: string }>,
): Promise<string[]> {
  const quoter = getClmmQuoter(rpcUrl);
  const keys = new Set<string>();
  keys.add(CLMM_PROGRAM_ID.toBase58());
  for (const pair of pairs) {
    const state = await quoter.loadPairState(new PublicKey(pair.mintA), new PublicKey(pair.mintB));
    if (!state) continue;
    const poolInfo = state.poolInfo as Record<string, unknown>;
    keys.add(String((poolInfo.id as PublicKey).toBase58()));
    keys.add(String((poolInfo.ammConfig as { id: string }).id));
    keys.add(String(state.vaultA.toBase58()));
    keys.add(String(state.vaultB.toBase58()));
    keys.add(String(state.mintA.toBase58()));
    keys.add(String(state.mintB.toBase58()));
    keys.add(String((poolInfo.observationId as PublicKey).toBase58()));
    if (state.bitmapAddress) keys.add(state.bitmapAddress.toBase58());
    keys.add("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    for (const entry of Object.values(state.tickArrayCache as Record<string, { address?: PublicKey }>)) {
      if (entry?.address) keys.add(entry.address.toBase58());
    }
  }
  return [...keys];
}

/** Live pool + tick-array state for one mint pair. */
interface PairState {
  poolInfo: Record<string, unknown>; // ComputeClmmPoolInfo shape
  tickArrayCache: Record<string, unknown>;
  fetchedAt: number;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  bitmapAddress?: PublicKey;

}

export interface LocalClmmQuote {
  snapshot: PairState;
  tokenIn: PublicKey;
  tokenOut: PublicKey;
  amountIn: BN;
  amountOut: BN; // expected out, raw units
  amountOutMin: BN; // slippage-protected minimum
  tickArrayAccounts: PublicKey[];
  poolId: PublicKey;
  /** True when the full input traded within cached liquidity (no partial fill). */
  allTradeConfirmed(): boolean;
  amountOutBigInt(): bigint;
  amountOutMinBigInt(): bigint;
}

export interface LocalClmmSwap {
  quote: LocalClmmQuote;
  instruction: TransactionInstruction;
}

interface PairCacheEntry {
  inFlight?: Promise<PairState | null>;
  ready: PairState | null;
  /** When discovery last concluded NO pool exists for this pair (negative cache). */
  noPoolAt?: number;
}

const NO_POOL_TTL_MS = 10 * 60_000; // pairs with no CLMM pool re-probe every 10 min

export class ClmmLocalQuoter {
  private readonly connection: Connection;
  private readonly pairs = new Map<string, PairCacheEntry>();
  private readonly registry = new Map<string, { poolId: PublicKey; at: number }>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  private readonly warmPairs = new Map<string, [PublicKey, PublicKey]>();
  private warming: Promise<number> | undefined;
  private activeLoads = 0;
  private retryAfter = 0;

  invalidate(mintA: PublicKey, mintB: PublicKey): void {
    this.pairs.delete(this.pairKey(mintA, mintB));
  }

  constructor(rpcUrl: string) {
    const fallback = process.env.SOLANA_RPC_FALLBACK;
    const transport = fallback && fallback !== rpcUrl
      ? createFailoverRpc({ primaryUrl: rpcUrl, fallbackUrl: fallback }).transport : undefined;
    this.connection = new Connection(rpcUrl, {
      commitment: "processed", disableRetryOnRateLimit: true,
      fetch: async (url, init) => {
        const signal = AbortSignal.timeout(1_500);
        // Raydium expects web3.js accounts, but its requests must share the
        // scanner's provider failover and cooldown state.
        if (transport) {
          const result = await transport({ payload: JSON.parse(String(init?.body)), signal });
          return new Response(JSON.stringify(result, (_, value) => typeof value === "bigint" ? Number(value) : value),
            { headers: { "Content-Type": "application/json" } });
        }
        const response = await fetch(url, { ...init, signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`CLMM RPC HTTP ${response.status}`);
        }
        return response;
      },
    });
  }

  private pairKey(mintA: PublicKey, mintB: PublicKey): string {
    const [lo, hi] = mintA.toBuffer().compare(mintB.toBuffer()) < 0 ? [mintA, mintB] : [mintB, mintA];
    return `${lo.toBase58()}|${hi.toBase58()}`;
  }

  /** Load (or reuse) the cached pool state for a pair. Cold load = a few RPC calls. */
  async loadPairState(mintA: PublicKey, mintB: PublicKey): Promise<PairState | null> {
    const key = this.pairKey(mintA, mintB);
    const cached = this.pairs.get(key);
    if (cached?.ready && Date.now() - cached.ready.fetchedAt < CLMM_STATE_TTL_MS) return cached.ready;
    if (cached?.noPoolAt && Date.now() - cached.noPoolAt < NO_POOL_TTL_MS) return null;
    if (cached?.inFlight) return cached.inFlight;
    if (Date.now() < this.retryAfter || this.activeLoads >= 2) return null;
    this.activeLoads++;
    const entry: PairCacheEntry = { ready: null };
    this.pairs.set(key, entry);
    entry.inFlight = this.discoverAndHydrate(mintA, mintB)
      .then((state) => {
        entry.ready = state;
        if (!state) entry.noPoolAt = Date.now();
        return state;
      })
      .catch((error: unknown) => {
        this.retryAfter = Math.max(this.retryAfter, Date.now() + 30_000);
        throw error;
      })
      .finally(() => { this.activeLoads--; delete entry.inFlight; });
    return entry.inFlight;
  }

  keepWarm(mintA: PublicKey, mintB: PublicKey): void {
    this.warmPairs.set(this.pairKey(mintA, mintB), [mintA, mintB]);
    if (this.warmPairs.size > 64) this.warmPairs.delete(this.warmPairs.keys().next().value!);
  }

  async loadAllWarm(): Promise<number> {
    if (this.warming) return this.warming;
    this.warming = (async () => {
      let ok = 0;
      const pairs = [...this.warmPairs.entries()].slice(0, 2);
      for (let i = 0; i < pairs.length; i++) {
        if (Date.now() < this.retryAfter) break;
        const [key, [a, b]] = pairs[i]!;
        this.warmPairs.delete(key);
        if (i) await new Promise((resolve) => setTimeout(resolve, 250));
        if (await this.loadPairState(a, b).catch(() => null)) ok++;
      }
      return ok;
    })().finally(() => { this.warming = undefined; });
    return this.warming;
  }

  private async discoverAndHydrate(mintA: PublicKey, mintB: PublicKey): Promise<PairState | null> {
    const [{ getPdaAmmConfigId, getPdaPoolId, getPdaExBitmapAccount }, { PoolInfoLayout, ClmmConfigLayout }] = await Promise.all([
      import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/utils/pda.js"),
      import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js"),
    ]);
    // PDA mint order must be canonical, independently of swap direction.
    if (mintA.toBuffer().compare(mintB.toBuffer()) > 0) [mintA, mintB] = [mintB, mintA];
    const key = this.pairKey(mintA, mintB);
    const registered = this.registry.get(key);
    // ONE getMultipleAccounts for all 8 config-probe pool PDAs — not 8 round-trips.
    const probeKeys: PublicKey[] = [];
    for (let configIndex = 0; configIndex <= MAX_AMM_CONFIG_INDEX; configIndex++) {
      const { publicKey: ammConfigId } = getPdaAmmConfigId(CLMM_PROGRAM_ID, configIndex);
      const { publicKey: poolId } = getPdaPoolId(CLMM_PROGRAM_ID, ammConfigId, mintA, mintB);
      probeKeys.push(poolId);
    }
    if (registered && Date.now() - registered.at < REGISTRY_TTL_MS) probeKeys.splice(0, probeKeys.length, registered.poolId);
    const accounts = await this.connection.getMultipleAccountsInfo(probeKeys);
    let best: { poolId: PublicKey; raw: Buffer; liquidity: BN } | null = null;
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account?.data) continue;
      const decoded = PoolInfoLayout.decode(account.data) as Record<string, unknown>;
      const liquidity = decoded.liquidity as BN;
      if (liquidity.isZero()) continue;
      if (!best || liquidity.gt(best.liquidity)) best = { poolId: probeKeys[i]!, raw: Buffer.from(account.data), liquidity };
    }
    if (!best) { this.registry.delete(key); return null; }
    if (!registered || probeKeys.length > 1) this.registry.set(key, { poolId: best.poolId, at: Date.now() });

    const state = PoolInfoLayout.decode(best.raw) as Record<string, unknown>;
    const configKey = (state.ammConfig as PublicKey).toBase58();
    let config = this.configs.get(configKey);
    if (!config || probeKeys.length > 1) {
      const account = await this.connection.getAccountInfo(state.ammConfig as PublicKey);
      if (!account?.data) throw new Error("CLMM config unavailable");
      config = ClmmConfigLayout.decode(account.data) as Record<string, unknown>;
      this.configs.set(configKey, config);
    }

    // Ex bitmap (pools whose ticks extend past the default bitmap range)
    const exBitmapInfo: { poolId: PublicKey; positiveTickArrayBitmap: unknown[]; negativeTickArrayBitmap: unknown[] } = { poolId: best.poolId, positiveTickArrayBitmap: [], negativeTickArrayBitmap: [] };
    const { publicKey: exBitmapAddr } = getPdaExBitmapAccount(CLMM_PROGRAM_ID, best.poolId);
    const exAcc = await this.connection.getAccountInfo(exBitmapAddr);
    if (exAcc?.data) {
      const { TickArrayBitmapExtensionLayout } = await import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js");
      const exDecoded = TickArrayBitmapExtensionLayout.decode(exAcc.data) as Record<string, unknown>;
      exBitmapInfo.positiveTickArrayBitmap = (exDecoded.positiveTickArrayBitmap ?? []) as unknown[];
      exBitmapInfo.negativeTickArrayBitmap = (exDecoded.negativeTickArrayBitmap ?? []) as unknown[];
    }

    const poolMintA = state.mintA as PublicKey;
    const poolMintB = state.mintB as PublicKey;
    const poolInfo = {
      id: best.poolId,
      version: 6,
      mintA: { chainId: 101, address: poolMintA.toBase58(), programId: "", logoURI: "", symbol: "", name: "", decimals: state.mintDecimalsA, tags: [], extensions: {} },
      mintB: { chainId: 101, address: poolMintB.toBase58(), programId: "", logoURI: "", symbol: "", name: "", decimals: state.mintDecimalsB, tags: [], extensions: {} },
      ammConfig: {
        id: (state.ammConfig as PublicKey).toBase58(),
        index: Number(config.index),
        protocolFeeRate: Number(config.protocolFeeRate),
        tradeFeeRate: Number(config.tradeFeeRate),
        tickSpacing: Number(config.tickSpacing),
        fundFeeRate: 0,
        description: "",
        defaultRange: 0,
        defaultRangePoint: [],
      },
      observationId: state.observationId,
      creator: state.poolCreator,
      programId: CLMM_PROGRAM_ID,
      tickSpacing: Number(state.tickSpacing),
      liquidity: state.liquidity,
      sqrtPriceX64: state.sqrtPriceX64,
      currentPrice: 0,
      tickCurrent: Number(state.tickCurrent),
      feeGrowthGlobalX64A: state.feeGrowthGlobalX64A,
      feeGrowthGlobalX64B: state.feeGrowthGlobalX64B,
      protocolFeesTokenA: state.protocolFeesTokenA,
      protocolFeesTokenB: state.protocolFeesTokenB,
      swapInAmountTokenA: state.swapInAmountTokenA,
      swapOutAmountTokenB: state.swapOutAmountTokenB,
      swapInAmountTokenB: state.swapInAmountTokenB,
      swapOutAmountTokenA: state.swapOutAmountTokenA,
      tickArrayBitmap: state.tickArrayBitmap,
      startTime: Number(state.startTime),
      exBitmapInfo,
      rewardInfos: [],
    };

    // Tick arrays (bitmap walk + fetch + decode, the shape PoolUtils expects)
    const { TickQuery } = await import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/utils/tickQuery.js");
    const tickArrayCache = await TickQuery.getTickArrays(
      this.connection,
      CLMM_PROGRAM_ID,
      best.poolId,
      Number(state.tickCurrent),
      Number(state.tickSpacing),
      state.tickArrayBitmap as BN[],
      exBitmapInfo as never,
    );

    return {
      // Timestamp AFTER all RPC/decode work: the state's freshness must be
      // measured from when it became usable, otherwise a cold discovery slower
      // than CLMM_STATE_TTL_MS would be rejected by every quote even though it
      // is the freshest data available.
      poolInfo, tickArrayCache, fetchedAt: Date.now(),
      mintA: poolMintA, mintB: poolMintB,
      vaultA: state.vaultA as PublicKey, vaultB: state.vaultB as PublicKey,
      ...(exAcc?.data ? { bitmapAddress: exBitmapAddr } : {}),
    };
  }

  /** LOCAL quote: ~5ms, zero HTTP. Returns null when the pair has no pool/state. */
  async quoteExactIn(input: {
    tokenIn: PublicKey;
    tokenOut: PublicKey;
    amountIn: BN;
    slippageBps: number;
  }): Promise<LocalClmmQuote | null> {
    const state = await this.loadPairState(input.tokenIn, input.tokenOut);
    if (!state || Date.now() - state.fetchedAt >= CLMM_STATE_TTL_MS) return null;
    const { PoolUtils } = await import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/utils/pool.js");
    const poolInfo = state.poolInfo as never;
    let result: { expectedAmountOut: BN; remainingAccounts: PublicKey[]; allTrade: boolean };
    try {
      result = PoolUtils.getOutputAmountAndRemainAccounts(poolInfo, state.tickArrayCache as never, input.tokenIn, input.amountIn) as {
        expectedAmountOut: BN;
        remainingAccounts: PublicKey[];
        allTrade: boolean;
      };
    } catch {
      return null;
    }
    if (!result.allTrade) return null; // pool liquidity can't absorb the full input
    if (result.expectedAmountOut.lten(0)) return null;
    const bps = new BN(10_000 - Math.max(0, Math.min(10_000, input.slippageBps)));
    const amountOutMin = result.expectedAmountOut.mul(bps).div(new BN(10_000));
    const amountOut = result.expectedAmountOut;
    const allTrade = result.allTrade;
    return {
      snapshot: state, tokenIn: input.tokenIn, tokenOut: input.tokenOut,
      amountIn: input.amountIn.clone(),
      amountOut,
      amountOutMin,
      tickArrayAccounts: result.remainingAccounts,
      poolId: (poolInfo as { id: PublicKey }).id,
      allTradeConfirmed: () => allTrade,
      amountOutBigInt: () => BigInt(amountOut.toString()),
      amountOutMinBigInt: () => BigInt(amountOutMin.toString()),
    };
  }

  /** Build the swap instruction from cached state — zero HTTP. The amountOutMin
   *  passed by the caller is what the on-chain program enforces. */
  async buildSwapInstruction(input: {
    tokenIn: PublicKey;
    tokenOut: PublicKey;
    ownerTokenIn: PublicKey; // user's token account for input
    ownerTokenOut: PublicKey; // user's token account for output
    amountIn: BN;
    amountOutMin: BN;
    payer: PublicKey;
    /** Reuse the quote already calculated by the route selector. */
    quote?: LocalClmmQuote;
  }): Promise<{ instruction: TransactionInstruction; tickArrays: PublicKey[]; poolId: PublicKey } | null> {
    const quote = input.quote ?? await this.quoteExactIn({ tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amountIn, slippageBps: 0 });
    if (!quote) return null;
    const state = quote.snapshot;
    if (Date.now() - state.fetchedAt >= CLMM_STATE_TTL_MS
      || !quote.tokenIn.equals(input.tokenIn) || !quote.tokenOut.equals(input.tokenOut)
      || !quote.amountIn.eq(input.amountIn) || !quote.poolId.equals(state.poolInfo.id as PublicKey)
      || input.amountOutMin.lt(quote.amountOutMin)) return null;
    const { ClmmInstrument } = await import("@raydium-io/raydium-sdk-v2/lib/raydium/clmm/instrument.js");
    const poolInfo = state.poolInfo as Record<string, unknown>;
    const inputIsA = (poolInfo.mintA as { address: string }).address === input.tokenIn.toBase58();
    const instruction = ClmmInstrument.swapInstruction(
      CLMM_PROGRAM_ID,
      input.payer,
      quote.poolId,
      new PublicKey(String((poolInfo.ammConfig as { id: string }).id)),
      input.ownerTokenIn,
      input.ownerTokenOut,
      inputIsA ? state.vaultA : state.vaultB,
      inputIsA ? state.vaultB : state.vaultA,
      input.tokenIn,
      input.tokenOut,
      quote.tickArrayAccounts,
      state.poolInfo.observationId as PublicKey,
      input.amountIn,
      input.amountOutMin,
      new BN(0),
      true, // exact-input for both A→B and B→A
      state.bitmapAddress,
    );
    return { instruction, tickArrays: quote.tickArrayAccounts, poolId: quote.poolId };
  }
}
