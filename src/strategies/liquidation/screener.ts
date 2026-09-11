import { Buffer } from "node:buffer";
import {
  KaminoObligation,
  Obligation,
  PROGRAM_ID as KLEND_PROGRAM_ID,
  getCurrentLedgerInstant,
  type KaminoMarket,
  type LedgerInstant,
} from "@kamino-finance/klend-sdk";
import { address, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { buildMarketReserveMap, filterLiquidatable, healthFactorFromSf, obligationToCandidate, type MarketReserveMap } from "./filters.js";
import type { LiquidatableCandidate, ScanEvent, ScanOptions, ScanResult } from "./types.js";

const OBLIGATION_ACCOUNT_SIZE = 3344;
const DEBT_VALUE_SF_OFFSET = 2208;
const SLICE_LENGTH = 130;
const BORROWED_MARKET_VALUE_SLICE_OFFSET = 2216;
// Relative offsets inside the slice (absolute minus DEBT_VALUE_SF_OFFSET)
const SLICE_ADL_TARGET = 2321 - 2208;
const SLICE_ADL_MARGIN_CALL_TS = 2328 - 2208;
const HYDRATE_BATCH_SIZE = 100;
const HYDRATE_DELAY_MS = 500;
const HYDRATE_CONCURRENCY = 1;
const MAX_BACKOFF_MS = 20_000;
const MAIN_MARKET_DEFAULT = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

export interface ScreenerDeps {
  rpc: Rpc<SolanaRpcApi>;
  marketAddress: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate.?limit|too many requests/i.test(message)) return true;
  // @solana/kit wraps HTTP errors as SolanaError with the status code in context, not message
  const context = (error as { context?: { statusCode?: unknown } } | null)?.context;
  const statusCode = context?.statusCode;
  if (typeof statusCode === "number" && statusCode === 429) return true;
  if (typeof statusCode === "string" && statusCode === "429") return true;
  return false;
}

export async function withBackoff<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= 6) {
        throw error;
      }
      console.warn(`${label} hit rate limit (attempt ${attempt}); retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }
}

export interface ObligationSlice {
  debtSf: bigint;
  unhealthySf: bigint;
  adlTargetLtvPct: number;
  adlMarginCallTs: number;
}

export function parseObligationSlice(dataBase64: string): ObligationSlice {
  const raw = Buffer.from(dataBase64, "base64");
  if (raw.length !== SLICE_LENGTH) throw new Error(`Unexpected slice length ${raw.length}`);
  const debtSf = raw.readBigUInt64LE(0) + (raw.readBigUInt64LE(8) << 64n);
  const unhealthySf = raw.readBigUInt64LE(48) + (raw.readBigUInt64LE(56) << 64n);
  const adlTargetLtvPct = raw.readUInt8(SLICE_ADL_TARGET);
  const adlMarginCallTs = Number(raw.readBigUInt64LE(SLICE_ADL_MARGIN_CALL_TS));
  return { debtSf, unhealthySf, adlTargetLtvPct, adlMarginCallTs };
}

export async function fetchCachedSnapshot(params: {
  rpc: Rpc<SolanaRpcApi>;
  marketAddress: string;
  programId?: Address;
}): Promise<Array<ObligationSlice & { pubkey: Address }>> {
  const { rpc, marketAddress } = params;
  const programId = params.programId ?? address(KLEND_PROGRAM_ID.toString());
  const marketBytes = address(marketAddress).toString() as Parameters<typeof rpc.getProgramAccounts>[1] extends never ? never : import("@solana/kit").Base58EncodedBytes;
  const response = await withBackoff(() => rpc.getProgramAccounts(programId, {
    filters: [
      { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
      { memcmp: { offset: 32n, bytes: marketBytes, encoding: "base58" } },
    ],
    encoding: "base64",
    dataSlice: { offset: DEBT_VALUE_SF_OFFSET, length: SLICE_LENGTH },
  }).send(), "snapshot GPA");
  const snapshot = response.map((account) => {
    const parsed = parseObligationSlice(account.account.data[0] ?? "");
    return { pubkey: account.pubkey, ...parsed };
  });
  return snapshot;
}

function sliceNeedsHydration(entry: { debtSf: bigint; unhealthySf: bigint }, options: ScanOptions): boolean {
  const cachedDebtUsd = Number(entry.debtSf) / 1e18;
  // Cached values only underestimate live debt (interest accrues since last refresh),
  // so a cached debt already above the max band can never re-enter the band.
  if (options.maxDebtUsd > 0 && cachedDebtUsd > options.maxDebtUsd * 1.5) return false;
  // Dust below half the min band cannot plausibly accrue into the band between refreshes.
  // When the band is disabled (0), keep a tiny absolute floor so dust accounts don't flood hydration.
  const dustFloorUsd = options.minDebtUsd > 0 ? options.minDebtUsd * 0.5 : 5;
  if (cachedDebtUsd < dustFloorUsd) return false;
  const health = healthFactorFromSf(entry.debtSf, entry.unhealthySf);
  return health < options.healthWatch;
}

export async function hydrateShortlist(params: {
  rpc: Rpc<SolanaRpcApi>;
  market: KaminoMarket;
  ledgerInstant: LedgerInstant;
    pubkeys: Address[];
  onProgress: (done: number, total: number) => void;
}): Promise<KaminoObligation[]> {
  const { rpc, market, ledgerInstant, pubkeys } = params;
  if (!pubkeys.length) return [];
  const markets = new Map([[market.getAddress(), market]]);

  const batches: Address[][] = [];
  for (let index = 0; index < pubkeys.length; index += HYDRATE_BATCH_SIZE) {
    batches.push(pubkeys.slice(index, index + HYDRATE_BATCH_SIZE));
  }

  const obligations: KaminoObligation[] = [];
  let done = 0;
  const runBatch = async (batch: Address[]) => {
    const accounts = await withBackoff(() => rpc.getMultipleAccounts(batch, { encoding: "base64" }).send(), "hydrate batch");
    for (let i = 0; i < accounts.value.length; i++) {
      const account = accounts.value[i];
      if (!account) continue;
      const data = account.data[0] ? Buffer.from(account.data[0], "base64") : Buffer.alloc(0);
      try {
        const obligation = KaminoObligation.fromAccountData(markets, batch[i]!, data, ledgerInstant);
        if (obligation) obligations.push(obligation);
      } catch {
        // Malformed / incompatible account; skip it
      }
    }
    done += batch.length;
    params.onProgress(Math.min(done, pubkeys.length), pubkeys.length);
  };

  // Parallel workers: each runs batches back-to-back with pacing between its own calls
  const workerCount = Math.min(HYDRATE_CONCURRENCY, batches.length);
  let nextBatch = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      await runBatch(batch!);
      if (nextBatch < batches.length) await sleep(HYDRATE_DELAY_MS);
    }
  });
  await Promise.all(workers);
  return obligations;
}

export interface PreloadedMarket {
  market: KaminoMarket;
  marketAddress: string;
  marketReserves: MarketReserveMap;
  loadedAt: number;
}

const MARKET_CACHE_TTL_MS = 60_000;

// Single-flight: every caller (scan cycle, hot tick, executeDue, executeLiquidationOnce)
// hits preloadMarket whenever the 60s cache is stale; without dedup those concurrent loads
// each fire their own loadMarket (~dozens of RPC calls) and self-inflict 429 storms on the
// shared Helius key. Track one in-flight promise per (rpc, market) so N callers share it.
const preloadInFlight = new Map<string, Promise<PreloadedMarket>>();
const preloadCache = new Map<string, PreloadedMarket>();

// Single-flight getCurrentLedgerInstant too: every hot tick and every executor refresh
// fetches it; when the key throttles each caller previously spawned its OWN backoff chain
// (the duplicated "hot ledger instant attempt N" lines). Callers share one in-flight fetch.
const ledgerInstantInFlight = new Map<string, Promise<Awaited<ReturnType<typeof getCurrentLedgerInstant>>>>();
let ledgerInstantLast = { at: 0, value: undefined as Awaited<ReturnType<typeof getCurrentLedgerInstant>> | undefined };

/** True for the getSlot→getBlockTime race: the slot number exists but its block
 *  isn't in the node's blockstore yet (-32004 "Block not available for slot").
 *  Transient by construction — the block lands (or the slot is skipped) within a
 *  slot or two; observed ~1x/day on Helius. */
export function isBlockNotAvailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /-32004|block not available/i.test(message);
}

async function fetchLedgerInstant(rpc: Rpc<SolanaRpcApi>, label: string): Promise<Awaited<ReturnType<typeof getCurrentLedgerInstant>>> {
  const now = Date.now();
  if (ledgerInstantLast.value && now - ledgerInstantLast.at < 500) return ledgerInstantLast.value;
  const endpoint = (rpc as unknown as { url?: string } | null)?.url ?? "rpc";
  const inFlight = ledgerInstantInFlight.get(endpoint);
  if (inFlight) {
    try {
      const value = await inFlight;
      if (value && now - ledgerInstantLast.at > 5000) ledgerInstantLast = { at: Date.now(), value };
      return value;
    } catch {
      // a failed shared fetch must not poison followers — fall through to our own attempt
    }
  }
  const promise = (async () => {
    try {
      // -32004 race: getSlot returns the newest slot but getBlockTime for that
      // exact slot can 404 while the blockstore catches up. Retry with a short
      // pause — by the second attempt the block is virtually always there.
      let value: Awaited<ReturnType<typeof getCurrentLedgerInstant>>;
      try {
        value = await withBackoff(() => getCurrentLedgerInstant(rpc), label);
      } catch (error) {
        if (!isBlockNotAvailableError(error)) throw error;
        await sleep(600);
        try {
          value = await withBackoff(() => getCurrentLedgerInstant(rpc), label);
        } catch (retryError) {
          // Still racing (rare): fall back to the last known-good instant when
          // it's fresh enough — blockTime only feeds margin-call AGE in hours
          // and refresh-staleness windows; a seconds-stale timestamp is fine.
          if (isBlockNotAvailableError(retryError) && ledgerInstantLast.value && Date.now() - ledgerInstantLast.at < 300_000) {
            return ledgerInstantLast.value;
          }
          throw retryError;
        }
      }
      ledgerInstantLast = { at: Date.now(), value };
      return value;
    } finally {
      ledgerInstantInFlight.delete(endpoint);
    }
  })();
  ledgerInstantInFlight.set(endpoint, promise);
  return promise;
}

function preloadKey(rpc: Rpc<SolanaRpcApi>, marketAddress: string): string {
  const endpoint = (rpc as unknown as { url?: string } | null)?.url
    ?? (rpc as unknown as { constructor?: { name?: string } })?.constructor?.name
    ?? "rpc";
  return `${endpoint}|${marketAddress}`;
}

export async function preloadMarket(rpc: Rpc<SolanaRpcApi>, marketAddress: string): Promise<PreloadedMarket> {
  const key = preloadKey(rpc, marketAddress);
  const fresh = preloadCache.get(key);
  if (fresh && Date.now() - fresh.loadedAt < MARKET_CACHE_TTL_MS) return fresh;

  const inFlight = preloadInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const { loadMarket } = await import("../../kamino.js");
      const market = await withBackoff(() => loadMarket(rpc, marketAddress), "market load");
      const loaded: PreloadedMarket = { market, marketAddress, marketReserves: buildMarketReserveMap(market, Number(market.state.liquidationMaxDebtCloseFactorPct) || 100), loadedAt: Date.now() };
      preloadCache.set(key, loaded);
      return loaded;
    } finally {
      preloadInFlight.delete(key);
    }
  })();
  preloadInFlight.set(key, promise);
  return promise;
}

export async function scanOnce(params: ScreenerDeps & {
  options: ScanOptions;
  onProgress?: (done: number, total: number) => void;
  preloaded?: PreloadedMarket | undefined;
  /** Override the effective health-watch band for this scan (surge adaptive widening). */
  effectiveHealthWatch?: number | undefined;
}): Promise<ScanResult> {
  const { rpc, marketAddress, options } = params;
  const cached = params.preloaded && Date.now() - params.preloaded.loadedAt < MARKET_CACHE_TTL_MS
    ? params.preloaded
    : await preloadMarket(rpc, marketAddress);
  const { market, marketReserves } = cached;
  const effectiveOptions: ScanOptions = params.effectiveHealthWatch !== undefined
    ? { ...options, healthWatch: params.effectiveHealthWatch, nearMissHealth: Math.max(options.nearMissHealth, params.effectiveHealthWatch) }
    : options;

  const snapshot = await fetchCachedSnapshot({ rpc, marketAddress });
  const adlMarked = snapshot.filter((entry) => entry.adlTargetLtvPct > 0);
  const adlPubkeys = new Set(adlMarked.map((entry) => entry.pubkey.toString()));
  const needsHydration = snapshot
    .filter((entry) => adlPubkeys.has(entry.pubkey.toString()) || sliceNeedsHydration(entry, effectiveOptions))
    .sort((a, b) => healthFactorFromSf(a.debtSf, a.unhealthySf) - healthFactorFromSf(b.debtSf, b.unhealthySf));

  const ledgerInstant = await fetchLedgerInstant(rpc, "ledger instant");
  const hydrated = await hydrateShortlist({
    rpc,
    market,
    ledgerInstant,
    pubkeys: needsHydration.map((entry) => entry.pubkey),
    onProgress: params.onProgress ?? (() => {}),
  });

  // Pass the program's stored scaled-factor health through for DUE gating (see filters.ts).
  const storedHealthByPubkey = new Map<string, number>();
  for (const entry of snapshot) {
    const health = healthFactorFromSf(entry.debtSf, entry.unhealthySf);
    storedHealthByPubkey.set(entry.pubkey.toString(), health);
  }

  const { candidates, nearMiss, skipped } = filterLiquidatable(hydrated, marketReserves, effectiveOptions, undefined, storedHealthByPubkey);

  // ADL-marked candidates: hydrated full detail, enriched with target LTV / margin-call age
  const hydratedByAddress = new Map(hydrated.map((o) => [o.obligationAddress.toString(), o]));
  const adlCandidates = adlMarked.flatMap((entry) => {
    const obligation = hydratedByAddress.get(entry.pubkey.toString());
    if (!obligation || obligation.obligationTag !== 0) return [];
    try {
      const candidate = obligationToCandidate(obligation, marketReserves);
      const stats = obligation.refreshedStats;
      const ltvPct = stats.userTotalDeposit.gt(0)
        ? Number(stats.userTotalBorrow.div(stats.userTotalDeposit).mul(100).toFixed(2))
        : 0;
      return [{
        ...candidate,
        adlTargetLtvPct: entry.adlTargetLtvPct,
        currentLtvPct: ltvPct,
        marginCallAgeHours: entry.adlMarginCallTs > 0
          ? Math.max(0, Math.round((Number(ledgerInstant.blockTime) - entry.adlMarginCallTs) / 3600))
          : 0,
      }];
    } catch {
      return [];
    }
  });

  return {
    scannedAt: new Date().toISOString(),
    obligationsScanned: snapshot.length,
    shortlistScanned: hydrated.length,
    liquidatable: candidates,
    nearMiss,
    adlMarked: adlCandidates,
    stats: {
      nonVanilla: skipped.nonVanilla,
      healthy: skipped.healthy,
      outOfBand: skipped.outOfBand,
      noFlashDebt: skipped.noFlashDebt,
      staleOracle: skipped.staleOracle,
      belowFloor: skipped.belowFloor,
    },
    effectiveHealthWatch: effectiveOptions.healthWatch,
  };
}

/**
 * Fast targeted refresh for the hot watch: hydrates only the given obligation
 * addresses with fresh oracles and converts them to candidates (health, debt,
 * collateral). Returns [] when nothing is tracked. Skips non-vanilla obligations.
 * The raw hydrated KaminoObligation objects (keyed by address) come back alongside
 * the candidates so the executor can skip its duplicate hydrate RPC.
 */
export interface StreamAccountSnapshot {
  pubkey: Address;
  accountData?: Buffer;
  slot?: bigint;
  receivedAt?: number;
}

const slotInstants = new WeakMap<object, Map<bigint, Promise<LedgerInstant>>>();
/** Share block-time resolution for every account delivered in the same slot. */
export function ledgerInstantAtSlot(rpc: Rpc<SolanaRpcApi>, slot: bigint): Promise<LedgerInstant> {
  let cache = slotInstants.get(rpc);
  if (!cache) { cache = new Map(); slotInstants.set(rpc, cache); }
  const existing = cache.get(slot);
  if (existing) return existing;
  const promise = rpc.getBlockTime(slot).send().then((blockTime) => {
    if (blockTime === null) throw new Error("Notification slot block time unavailable");
    return { slot, blockTime };
  }).catch((error) => { cache!.delete(slot); throw error; });
  cache.set(slot, promise);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return promise;
}

export function streamSnapshotFresh(snapshot: StreamAccountSnapshot | undefined, pubkey: Address, now = Date.now()): boolean {
  return Boolean(snapshot?.pubkey === pubkey && snapshot.accountData && snapshot.slot !== undefined
    && snapshot.receivedAt !== undefined && now >= snapshot.receivedAt && now - snapshot.receivedAt < 1500);
}

/** Fast race-rail ledger instant for an account delivered by WS. Resolving
 * getBlockTime(slot) can add hundreds of milliseconds under RPC pressure. The
 * account snapshot is already the authoritative slot payload and the executor
 * rechecks health in simulation, so wall-clock seconds are sufficient for this
 * preflight decode; normal scans still use the coherent RPC ledger instant. */
export function streamLedgerInstant(snapshot: StreamAccountSnapshot): LedgerInstant {
  if (snapshot.slot === undefined) throw new Error("WS snapshot has no slot");
  return {
    slot: snapshot.slot,
    blockTime: BigInt(Math.floor(Date.now() / 1000)) as LedgerInstant["blockTime"],
  };
}

export async function refreshTrackedObligations(params: {
  rpc: Rpc<SolanaRpcApi>;
  preloaded: PreloadedMarket;
  pubkeys: Address[];
  streamSnapshot?: StreamAccountSnapshot;
}): Promise<{ candidates: LiquidatableCandidate[]; obligations: Map<string, KaminoObligation>; market: KaminoMarket }> {
  const { rpc, preloaded, pubkeys } = params;
  if (!pubkeys.length) return { candidates: [], obligations: new Map(), market: preloaded.market };
  const loaded = freshPreloaded(preloaded) ? preloaded : await preloadMarket(rpc, preloaded.marketAddress);
  const market = loaded.market;
  let hydrated: KaminoObligation[] | undefined;
  const snapshot = params.streamSnapshot;
  if (pubkeys.length === 1 && streamSnapshotFresh(snapshot, pubkeys[0]!)) {
    try {
      const ledgerInstant = streamLedgerInstant(snapshot!);
      // A slow block-time call must not extend the account snapshot's lifetime.
      if (streamSnapshotFresh(snapshot, pubkeys[0]!)) {
        const obligation = KaminoObligation.fromAccountData(
          new Map([[market.getAddress(), market]]), pubkeys[0]!, snapshot!.accountData!, ledgerInstant,
        );
        if (obligation) hydrated = [obligation];
      }
    } catch { /* unavailable slot time or incompatible data: use fresh RPC account */ }
  }
  if (!hydrated) {
    const ledgerInstant = await fetchLedgerInstant(rpc, "hot ledger instant");
    hydrated = await hydrateShortlist({ rpc, market, ledgerInstant, pubkeys, onProgress: () => {} });
  }
  const vanilla = hydrated.filter((obligation) => obligation.obligationTag === 0);
  const obligations = new Map(vanilla.map((obligation) => [obligation.obligationAddress.toString(), obligation]));
  const candidates = vanilla.map((obligation) => {
    try { return obligationToCandidate(obligation, loaded.marketReserves); } catch { return null; }
  }).filter((candidate): candidate is LiquidatableCandidate => candidate !== null);
  return { candidates, obligations, market };
}

export function freshPreloaded(preloaded: PreloadedMarket | undefined): boolean {
  return Boolean(preloaded && Date.now() - preloaded.loadedAt < MARKET_CACHE_TTL_MS);
}

export function createScreener(deps: { loadMarket?: typeof import("../../kamino.js").loadMarket } = {}) {
  return {
    scan: scanOnce,
    ...deps,
  };
}

export type { ScanEvent, ScanOptions, ScanResult };
