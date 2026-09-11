import type { Address, Instruction, Rpc, SolanaRpcApi, TransactionSigner } from "@solana/kit";
import { compressTransactionMessageUsingAddressLookupTables, appendTransactionMessageInstructions, createTransactionMessage, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";

/**
 * Hot-path caches for the liquidation executor (the LionX latency attack).
 *
 * The fire path previously re-fetched, sequentially and ON the critical path:
 *   - getLatestBlockhash           (~80-100ms)
 *   - ALT contents per table       (~80-100ms each, jsonParsed getAccountInfo)
 *   - scope.getAllConfigurations   (~80-150ms, full config map for price refresh)
 *
 * All three are cacheable: a blockhash lives ~60s (150 slots), our own ALT and the
 * Jupiter JUP ALT are effectively immutable once created, and scope configs move
 * only on governance actions. A background refresher keeps the blockhash warm;
 * the executor reads snapshots with ZERO RPC round-trips.
 *
 * The ALT cache also lets us pre-serialize: createSignedTransactionWithAltCached
 * resolves ALT contents once and only fetches the (cached) blockhash.
 */

interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: bigint;
  fetchedAt: number;
}

const BLOCKHASH_MAX_AGE_MS = 30_000; // 150 slots ≈ 60s validity; refresh with a
// safety margin — a fire that assembles + sims for ~10-20s must still have
// enough blockhash lifetime left to land AND confirm.
const BLOCKHASH_STALE_RETRY_MS = 2_000;

const blockhashCache = new Map<unknown, CachedBlockhash>();
const blockhashInFlight = new Map<unknown, Promise<CachedBlockhash>>();

export interface BlockhashSnapshot {
  blockhash: CachedBlockhash["blockhash"];
  lastValidBlockHeight: CachedBlockhash["lastValidBlockHeight"];
}

/** Cached getLatestBlockhash — falls through to a shared in-flight fetch. */
export async function getCachedBlockhash(rpc: Rpc<SolanaRpcApi>, rpcUrl?: string, force = false): Promise<BlockhashSnapshot> {
  const endpoint = rpcUrl ?? rpc;
  const fresh = blockhashCache.get(endpoint);
  const now = Date.now();
  if (!force && fresh && now - fresh.fetchedAt < BLOCKHASH_MAX_AGE_MS) return fresh;
  const inflight = blockhashInFlight.get(endpoint);
  if (inflight) return inflight;
  const promise = (async (): Promise<CachedBlockhash> => {
    const { fetchLatestBlockhash } = await import("../../transaction.js");
    const { value } = await fetchLatestBlockhash(rpc);
    const cached: CachedBlockhash = {
      blockhash: String(value.blockhash),
      lastValidBlockHeight: value.lastValidBlockHeight,
      fetchedAt: Date.now(),
    };
    blockhashCache.set(endpoint, cached);
    return cached;
  })().finally(() => blockhashInFlight.delete(endpoint));
  blockhashInFlight.set(endpoint, promise);
  return promise;
}

/** True when the cached blockhash still has >10s of validity — fire-path eligible. */
export function blockhashFresh(rpc: Rpc<SolanaRpcApi>, rpcUrl?: string): boolean {
  const endpoint = rpcUrl ?? rpc;
  const cached = blockhashCache.get(endpoint);
  return Boolean(cached && Date.now() - cached.fetchedAt < BLOCKHASH_MAX_AGE_MS);
}

/** Kick a background refresh (never on the critical path). Errors are swallowed. */
export function warmBlockhash(rpc: Rpc<SolanaRpcApi>, rpcUrl?: string): void {
  void getCachedBlockhash(rpc, rpcUrl, true).catch(() => {});
}

// ─── ALT contents cache ────────────────────────────────────────────────────

type AltInfoResponse = { result?: { value?: { data?: { parsed?: { info?: { addresses?: string[] } } } } } };
const parseAltResponse = async (r: Response): Promise<AltInfoResponse | null> => r.json().catch(() => null);

interface CachedAlt {
  addresses: Address[];
  fetchedAt: number;
}
const ALT_MAX_AGE_MS = 10 * 60_000; // tables are append-only; 10 min is generous
const altCache = new Map<string, CachedAlt>();
const altInFlight = new Map<string, Promise<CachedAlt>>();

/** Fetch (and cache) an ALT's full address list. jsonParsed fetch with 429 backoff. */
export async function getCachedAltAddresses(
  rpcUrl: string,
  tableAddress: string,
): Promise<Address[]> {
  const cacheKey = `${rpcUrl}|${tableAddress}`;
  const fresh = altCache.get(cacheKey);
  if (fresh && Date.now() - fresh.fetchedAt < ALT_MAX_AGE_MS) return fresh.addresses;
  const inflight = altInFlight.get(cacheKey);
  if (inflight) return inflight.then((cached) => cached.addresses);
  const promise = (async (): Promise<CachedAlt> => {
    let response: Awaited<ReturnType<typeof parseAltResponse>> | null = null;
    for (let attempt = 1; attempt <= 4 && !response?.result?.value?.data?.parsed?.info?.addresses?.length; attempt += 1) {
      const raw = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [tableAddress, { encoding: "jsonParsed" }] }),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      if (!raw) continue;
      if (raw.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
        continue;
      }
      response = (await raw.json().catch(() => null)) as Awaited<ReturnType<typeof parseAltResponse>>;
    }
    const addresses = response?.result?.value?.data?.parsed?.info?.addresses ?? [];
    const cached: CachedAlt = { addresses: addresses.map((a) => a as Address), fetchedAt: Date.now() };
    if (cached.addresses.length) altCache.set(cacheKey, cached);
    return cached;
  })().finally(() => altInFlight.delete(cacheKey));
  altInFlight.set(cacheKey, promise);
  return promise.then((cached) => cached.addresses);
}

/** Pre-warm our persistent ALT + the Jupiter route tables in the background. */
export function warmAltTables(rpcUrl: string, tables: Array<string>): void {
  for (const t of tables) void getCachedAltAddresses(rpcUrl, t).catch(() => {});
}

/** createSignedTransactionWithAlt, minus the two cold RPC round-trips:
 *  blockhash comes from the hot cache (single-flight, <60s old) and ALT contents
 *  from the ALT cache. When either cache is cold we fall back to the fetch path —
 *  correctness is never traded for latency. */
export async function createSignedTransactionWithAltCached(
  rpc: Rpc<SolanaRpcApi>,
  rpcUrl: string,
  signer: TransactionSigner,
  instructions: Instruction[],
  lookupTableAddresses: Address[],
) {
  const uniqueTables = [...new Set(lookupTableAddresses.map(String))];
  const [latestBlockhash, altResults] = await Promise.all([
    getCachedBlockhash(rpc, rpcUrl),
    Promise.all(uniqueTables.map(async (table) => [table, await getCachedAltAddresses(rpcUrl, table)] as const)),
  ]);
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: latestBlockhash.blockhash as never, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      tx,
    ),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  if (uniqueTables.length) {
    const addressesByLookupTableAddress: Record<string, Address[]> = {};
    for (const [table, addresses] of altResults) {
      if (addresses.length) addressesByLookupTableAddress[table] = addresses;
    }
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, addressesByLookupTableAddress as never);
    if (compressed) message = compressed as typeof message;
  }
  return signTransactionMessageWithSigners(message);
}

// ─── Scope configuration cache ──────────────────────────────────────────────

const SCOPE_CONFIG_MAX_AGE_MS = 60_000;
interface CachedScopeConfigs {
  configs: Array<[string, { oraclePrices: unknown }]>;
  fetchedAt: number;
}
let scopeConfigCache: CachedScopeConfigs | null = null;
let scopeConfigInFlight: Promise<CachedScopeConfigs | null> | null = null;

/**
 * Scope oracle configurations with a 60s cache — the executor re-fetches the full
 * config map on every fire (getAllConfigurations) just to build RefreshPriceList;
 * the map changes only on governance actions, so we cache per RPC endpoint.
 */
export async function getCachedScopeConfigurations(rpc: Rpc<SolanaRpcApi>): Promise<Array<[string, { oraclePrices: unknown }]>> {
  if (scopeConfigCache && Date.now() - scopeConfigCache.fetchedAt < SCOPE_CONFIG_MAX_AGE_MS) {
    return scopeConfigCache.configs;
  }
  if (scopeConfigInFlight) {
    const shared = await scopeConfigInFlight;
    return shared?.configs ?? [];
  }
  const promise = (async (): Promise<CachedScopeConfigs | null> => {
    try {
      const { Scope } = await import("@kamino-finance/scope-sdk");
      const scope = new Scope("mainnet-beta", rpc as never);
      const configs = await scope.getAllConfigurations();
      scopeConfigCache = { configs: configs as unknown as Array<[string, { oraclePrices: unknown }]>, fetchedAt: Date.now() };
      return scopeConfigCache;
    } catch {
      return scopeConfigCache; // stale is better than none for a best-effort refresh
    } finally {
      scopeConfigInFlight = null;
    }
  })();
  scopeConfigInFlight = promise;
  const result = await promise;
  return result?.configs ?? [];
}

export function warmScopeConfigurations(rpc: Rpc<SolanaRpcApi>): void {
  void getCachedScopeConfigurations(rpc).catch(() => {});
}

// ─── Signer cache ───────────────────────────────────────────────────────────
// loadWalletSigner decodes the private key (base58/JSON parse + ed25519 key
// derivation) EVERY call — the executor did it once per fire, on the critical
// path. The signer is immutable for the process lifetime: decode once, share.

let cachedSigner: TransactionSigner | null = null;
let signerInFlight: Promise<TransactionSigner> | null = null;

export async function getCachedWalletSigner(): Promise<TransactionSigner> {
  if (cachedSigner) return cachedSigner;
  if (signerInFlight) return signerInFlight;
  const promise = (async (): Promise<TransactionSigner> => {
    const { loadWalletSigner, privateKeyFromEnv } = await import("../../config.js");
    const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
    cachedSigner = signer;
    return signer;
  })().finally(() => { signerInFlight = null; });
  signerInFlight = promise;
  return promise;
}

// ─── ATA existence cache ────────────────────────────────────────────────────
// The executor's three fetchTokenAccount round-trips (~80-100ms each, even
// though parallel) check whether OUR hot ATAs exist — a fact that changes only
// when we (or liq-setup) create them. Cache "exists" for the process lifetime;
// cache "missing" briefly so a fire right after creation still picks it up.

interface CachedAtaState {
  exists: boolean;
  fetchedAt: number;
}
const ataStateCache = new Map<string, CachedAtaState>();
const ATA_MISSING_RECHECK_MS = 60_000;

/** Records an ATA's existence from ANY observation (fire-path fetch, warm pass). */
export function setCachedAtaExists(ata: string, exists: boolean): void {
  if (exists) {
    // existence is monotonic for our own accounts — never revert to missing
    ataStateCache.set(ata, { exists: true, fetchedAt: Date.now() });
  } else {
    const prior = ataStateCache.get(ata);
    if (prior?.exists) return;
    ataStateCache.set(ata, { exists: false, fetchedAt: Date.now() });
  }
}

/** True when a cached "exists" (or a fresh-enough "missing") lets the fire
 *  path skip the getAccountInfo round-trip entirely. */
export function ataStateKnown(ata: string): { exists: boolean } | null {
  const cached = ataStateCache.get(ata);
  if (!cached) return null;
  if (cached.exists) return { exists: true };
  if (Date.now() - cached.fetchedAt < ATA_MISSING_RECHECK_MS) return { exists: false };
  return null;
}

export const HOTCACHE_INTERNALS = { BLOCKHASH_STALE_RETRY_MS };
