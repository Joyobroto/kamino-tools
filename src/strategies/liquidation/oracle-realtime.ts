import { Buffer } from "node:buffer";
import { createSolanaRpcSubscriptions, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { getAllOracleAccounts, getTokenOracleDataSync, type KaminoMarket } from "@kamino-finance/klend-sdk";

export interface OracleFeedUpdate {
  feed: Address;
  data: Buffer;
  slot?: bigint;
  receivedAt: number;
}

/** Last account payload for every oracle feed used by the loaded market. */
export class OracleFeedCache {
  private readonly values = new Map<string, OracleFeedUpdate>();
  private sdkAccounts: Awaited<ReturnType<typeof getAllOracleAccounts>> = new Map();
  private accountSlots = new Map<Address, bigint>();

  private primedAt = 0;
  private primeInFlight: Promise<void> | undefined;
  private nextPrimeAt = 0;

  async prime(rpc: unknown, market: KaminoMarket): Promise<void> {
    if (this.primeInFlight) return this.primeInFlight;
    const started = Date.now();
    if (started < this.nextPrimeAt) return;
    this.nextPrimeAt = started + 10_000;
    this.primeInFlight = (async () => {
      const feeds = marketOracleFeeds(market);
      const client = rpc as Rpc<SolanaRpcApi>;
      for (let start = 0; start < feeds.length; start += 100) {
        const keys = feeds.slice(start, start + 100);
        const minSlot = keys.reduce((slot, key) => {
          const current = this.values.get(key)?.slot ?? this.accountSlots.get(key) ?? 0n;
          return current > slot ? current : slot;
        }, 0n);
        const result = await client.getMultipleAccounts(keys, {
          encoding: "base64", commitment: "processed", minContextSlot: minSlot,
        }).send({ abortSignal: AbortSignal.timeout(5_000) });
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]!;
          const account = result.value[i];
          if (!account) throw new Error(`oracle account unavailable: ${key}`);
          const update = this.values.get(key);
          const existingSlot = this.accountSlots.get(key) ?? 0n;
          if (result.context.slot < existingSlot) continue;
          this.sdkAccounts.set(key, { ...account, programAddress: account.owner, address: key });
          this.accountSlots.set(key, result.context.slot);
          // Slot ordering, not HTTP start time, resolves concurrent WS updates.
          if (update?.slot !== undefined && update.slot >= result.context.slot) this.apply(update);
        }
      }
      this.primedAt = started;
    })().catch((error: unknown) => {
      this.nextPrimeAt = Date.now() + 30_000;
      throw error;
    }).finally(() => { this.primeInFlight = undefined; });
    return this.primeInFlight;
  }

  private apply(value: OracleFeedUpdate): void {
    const previous = this.sdkAccounts.get(value.feed);
    if (previous) {
      this.sdkAccounts.set(value.feed, { ...previous, data: [value.data.toString("base64"), "base64"] as typeof previous.data });
      if (value.slot !== undefined) this.accountSlots.set(value.feed, value.slot);
    }
  }

  update(value: OracleFeedUpdate): boolean {
    const previous = this.values.get(value.feed.toString());
    const accountSlot = this.accountSlots.get(value.feed);
    if (accountSlot !== undefined && (value.slot === undefined || value.slot < accountSlot)) return false;
    if (previous && ((previous.slot !== undefined && (value.slot === undefined || value.slot < previous.slot))
      || value.receivedAt < previous.receivedAt)) return false;
    this.values.set(value.feed.toString(), value);
    this.apply(value);
    return true;
  }

  get snapshotAgeMs(): number { return this.primedAt ? Date.now() - this.primedAt : Infinity; }
  get lastUpdateAt(): number { return Math.max(0, ...[...this.values.values()].map((value) => value.receivedAt)); }

  /** Apply decoded feed prices to the already-loaded SDK reserve objects. */
  refreshMarket(market: KaminoMarket): boolean {
    // The 15s gate was measured from the last RPC PRIME, but every WS
    // notification overwrites the decoded account payload directly — so while
    // the feed is live the data is fresh regardless of prime age. Use a wider
    // budget so a slow/delayed prime does not silently disable the oracle-first
    // rail (observed: ~half of oracle ticks no-op'ing at tracked=50).
    if (!this.sdkAccounts.size || this.snapshotAgeMs > 30_000) return false;
    const reserves = market.getReserves().map((reserve) => ({ address: reserve.address, state: reserve.state }));
    for (const [reserve, price] of getTokenOracleDataSync(this.sdkAccounts, reserves)) {
      if (price) market.getReserveByAddress(reserve.address)!.tokenOraclePrice = price;
    }
    return true;
  }

  get(feed: Address): OracleFeedUpdate | undefined {
    return this.values.get(feed.toString());
  }

  get size(): number { return this.values.size; }
}

export interface OracleRealtimeOptions {
  wsUrl: string;
  wsCandidates?: string[];
  feeds: Address[];
  cache: OracleFeedCache;
  onUpdate?: (update: OracleFeedUpdate) => void;
  onReady?: (endpoint: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface OracleRealtimeHandle {
  abort: () => void;
  ready: Promise<void>;
}

/**
 * Subscribe to the exact Pyth/Switchboard/Scope accounts referenced by the
 * market. This is the realtime input to the in-memory health layer: the cache
 * itself is not a source of truth until an account notification updates it.
 */
export async function subscribeOracleFeeds(options: OracleRealtimeOptions): Promise<OracleRealtimeHandle> {
  const feeds = [...new Set(options.feeds.map(String))] as Address[];
  const candidates = [...new Set([options.wsUrl, ...(options.wsCandidates ?? [])])];
  const abortController = new AbortController();
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  if (!feeds.length) {
    resolveReady();
    return { abort: () => abortController.abort(), ready };
  }

  const run = async (): Promise<void> => {
    let attempt = 0;
    let delayMs = 1_000;
    while (!abortController.signal.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([abortController.signal, connection.signal]);
      let lastMessage = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastMessage > 60_000) connection.abort(new Error("oracle stream inactive for 60s"));
      }, 5_000);
      try {
        const endpoint = candidates[attempt % candidates.length]!;
        attempt += 1;
        const subscriptions = createSolanaRpcSubscriptions(endpoint);
        const streams = await Promise.all(feeds.map((feed) => subscriptions.accountNotifications(feed, {
          commitment: "processed",
          encoding: "base64",
        }).subscribe({ abortSignal: signal })));
        await options.onReady?.(endpoint);
        resolveReady();
        delayMs = 1_000;
        await Promise.all(streams.map(async (stream, index) => {
          for await (const notification of stream) {
            const value = notification as unknown as { context?: { slot?: bigint }; value?: { data?: [string, string] } };
            const encoded = value.value?.data?.[0];
            if (!encoded) continue;
            const update: OracleFeedUpdate = {
              feed: feeds[index]!,
              data: Buffer.from(encoded, "base64"),
              ...(value.context?.slot !== undefined ? { slot: value.context.slot } : {}),
              receivedAt: Date.now(),
            };
            lastMessage = Date.now();
            if (options.cache.update(update)) options.onUpdate?.(update);
          }
          throw new Error("oracle notification stream ended");
        }));
      } catch (error) {
        connection.abort();
        if (abortController.signal.aborted) break;
        options.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 15_000);
      } finally {
        clearInterval(watchdog);
        connection.abort();
      }
    }
  };
  void run();
  return { abort: () => abortController.abort(), ready };
}

export function marketOracleFeeds(market: { getReserves(): Array<{ state: { config: { tokenInfo: { pythConfiguration?: { price?: string }; switchboardConfiguration?: { priceAggregator?: string; twapAggregator?: string }; scopeConfiguration?: { priceFeed?: string } } } } }> }): Address[] {
  const feeds = new Set<string>();
  for (const reserve of market.getReserves()) {
    const tokenInfo = reserve.state.config.tokenInfo;
    for (const feed of [
      tokenInfo.pythConfiguration?.price,
      tokenInfo.switchboardConfiguration?.priceAggregator,
      tokenInfo.switchboardConfiguration?.twapAggregator,
      tokenInfo.scopeConfiguration?.priceFeed,
    ]) {
      if (feed && feed !== "11111111111111111111111111111111") feeds.add(feed);
    }
  }
  return [...feeds] as Address[];
}
