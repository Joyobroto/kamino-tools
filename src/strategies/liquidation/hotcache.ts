import { address, getBase64EncodedWireTransaction, type Address, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { compressTransactionMessageUsingAddressLookupTables, appendTransactionMessageInstructions, createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";

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

interface CachedAlt {
  addresses: Address[];
  fetchedAt: number;
}
const ALT_MAX_AGE_MS = 10 * 60_000; // tables are append-only; 10 min is generous
const altCache = new Map<string, CachedAlt>();
const altInFlight = new Map<string, Promise<CachedAlt>>();

/** Prime the ALT content cache with a candidate address list (validation /
 * diag tooling): lets you measure packet sizes for an ALT that is planned but
 * not yet on-chain. */
export function primeAltCache(rpcUrl: string, tableAddress: string, addresses: Address[]): void {
  altCache.set(`${rpcUrl}|${tableAddress}`, { addresses, fetchedAt: Date.now() });
}

/** Resolve tables through the same failover transport as execution. Never
 * silently omit a requested table: that misreports RPC outages as packet errors. */
export async function getCachedAltAddresses(
  rpcUrl: string,
  tableAddress: string,
  rpc?: Rpc<SolanaRpcApi>,
): Promise<Address[]> {
  const cacheKey = `${rpcUrl}|${tableAddress}`;
  const fresh = altCache.get(cacheKey);
  if (fresh && Date.now() - fresh.fetchedAt < ALT_MAX_AGE_MS) return fresh.addresses;
  const inflight = altInFlight.get(cacheKey);
  if (inflight) return inflight.then((cached) => cached.addresses);
  const promise = (async (): Promise<CachedAlt> => {
    const client = rpc ?? (await import("../../kamino.js")).rpcClient(rpcUrl);
    let value;
    try {
      ({ value } = await client.getAccountInfo(address(tableAddress), {
        encoding: "jsonParsed", commitment: "confirmed",
      }).send({ abortSignal: AbortSignal.timeout(3_000) }));
    } catch {
      throw new Error(`ALT unavailable: ${tableAddress} (RPC failed or timed out)`);
    }
    const data = value?.data as { parsed?: { info?: { addresses?: string[]; deactivationSlot?: string | number | bigint } } } | undefined;
    const info = data?.parsed?.info;
    if (value?.owner !== "AddressLookupTab1e1111111111111111111111111" || !info?.addresses?.length) {
      throw new Error(`ALT unavailable: ${tableAddress} (missing, empty or invalid account)`);
    }
    if (String(info.deactivationSlot) !== "18446744073709551615") {
      throw new Error(`ALT unavailable: ${tableAddress} (table is deactivating)`);
    }
    const cached: CachedAlt = { addresses: info.addresses.map((a) => address(a)), fetchedAt: Date.now() };
    altCache.set(cacheKey, cached);
    return cached;
  })().finally(() => altInFlight.delete(cacheKey));
  altInFlight.set(cacheKey, promise);
  return promise.then((cached) => cached.addresses);
}

/** Pre-warm our persistent ALT + the Jupiter route tables in the background. */
export function warmAltTables(rpcUrl: string, tables: Array<string>): void {
  for (const t of tables) void getCachedAltAddresses(rpcUrl, t).catch(() => {});
}

/** Avoid paying a 34-byte table header to compress just one 32-byte key.
 * Prefer tables covering the most still-inline eligible accounts. */
export function selectLookupTables(instructions: readonly Instruction[], payer: Address,
  tables: Record<string, Address[]>) {
  const excluded = new Set<string>([payer, ...instructions.map((ix) => ix.programAddress)]);
  const eligible = new Set<string>();
  for (const ix of instructions) for (const account of ix.accounts ?? []) {
    if (account.role & 2) excluded.add(account.address);
    eligible.add(account.address);
  }
  for (const key of excluded) eligible.delete(key);
  // The limit applies to accounts referenced by the MESSAGE, not the sum of
  // stored addresses in its tables. Never truncate/reindex on-chain tables.
  const allAccounts = new Set([...excluded, ...eligible]);
  if (allAccounts.size > 256) throw new Error(`transaction references ${allAccounts.size} accounts; maximum is 256`);
  const selected: Record<string, Address[]> = {};
  const remaining = new Map(Object.entries(tables));
  for (;;) {
    let best: string | undefined;
    let score = 1;
    for (const [table, keys] of remaining) {
      const count = new Set(keys.filter((key) => eligible.has(key))).size;
      if (count > score) { best = table; score = count; }
    }
    if (!best) break;
    const keys = remaining.get(best)!;
    const used = keys.filter((key) => eligible.has(key));
    if (!used.length) break;
    selected[best] = keys; // Preserve the actual on-chain address indexes.
    used.forEach((key) => eligible.delete(key));
    remaining.delete(best);
  }
  return { tables: selected, uncovered: [...eligible] };
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
  onCoverage?: (uncovered: string[]) => void,
) {
  const uniqueTables = [...new Set(lookupTableAddresses.map(String))];
  const [latestBlockhash, altResults] = await Promise.all([
    getCachedBlockhash(rpc, rpcUrl),
    Promise.all(uniqueTables.map(async (table) => [table, await getCachedAltAddresses(rpcUrl, table, rpc)] as const)),
  ]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: latestBlockhash.blockhash as never, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      tx,
    ),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const tables: Record<string, Address[]> = {};
  for (const [table, addresses] of altResults) if (addresses.length) tables[table] = addresses;
  const optimized = selectLookupTables(instructions, signer.address, tables);
  onCoverage?.(optimized.uncovered);
  const compressed = compressTransactionMessageUsingAddressLookupTables(message, optimized.tables as never);
  // Preserve encoder/signing errors instead of hiding the cause behind a generic
  // "no encodable coverage" error.
  const best = await signTransactionMessageWithSigners(compressed);
  const bytes = Buffer.from(getBase64EncodedWireTransaction(best), "base64").length;
  if (bytes > 1232) throw new Error(`tx exceeds 1232-byte packet with resolved LUTs (${bytes} bytes); uncovered=${optimized.uncovered.join(",")}; extend liquidation ALT coverage with liq-setup`);
  return best;
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
