/**
 * Pool feed + vault-truth pricing.
 *
 * New pools are discovered via Helius `getProgramAccountsV2` (cursor pagination,
 * max 10K accounts/page — the plain getProgramAccounts call now returns
 * "account index service overloaded" for programs with hundreds of thousands of
 * accounts). Measured cost: ~5 new pools per 90s on pumpswap, ~200/hour across
 * venues; see research doc.
 *
 * Pricing uses live vault token balances only. Aggregator cached prices were
 * empirically shown to be up to 200,000x stale (ANB case) and are never used.
 */

import {
  decodePoolAccount,
  TOKEN_ACCOUNT_DATA_SIZE,
  TOKEN_ACCOUNT_OWNER_OFFSET,
  VENUES,
  type DecodedPool,
  type Venue,
} from "./venues.js";
import bs58 from "bs58";

/** Minimal JSON-RPC client over HTTP with 429 backoff. */
export interface RpcClient {
  /** Paginated Helius V2 listing (pubkeys only via 0-byte dataSlice). */
  listProgramAccounts(programId: string, filters: unknown[]): Promise<string[]>;
  /** Paginated Helius V2 listing with full account data (base64). */
  listProgramAccountsWithData(programId: string, filters: unknown[]): Promise<Array<{ pubkey: string; data: string }>>;
  /**
   * Paginated Helius V2 listing with a data slice. Returns raw sliced data
   * (base64) per account — the client filters locally. Needed because Helius
   * memcmp fails for 44-char base58 values (empirically verified: USDC/WSOL
   * match, JitoSOL/mSOL do not — see docs/ARB_TREASURE_RESEARCH.md).
   */
  listProgramAccountsSliced(
    programId: string,
    filters: unknown[],
    dataSlice: { offset: number; length: number },
  ): Promise<Array<{ pubkey: string; data: string }>>;
  getMultipleAccounts(pubkeys: string[]): Promise<{ data: [string, string] | null }[]>;
  getMultipleAccountsRaw(pubkeys: string[]): Promise<{ owner: string | null; data: { base64: string } | null }[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests|overloaded/i.test(message);
}

export function createRpcClient(rpcUrl: string, fetchImpl: typeof fetch = fetch): RpcClient {
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let delay = 1_000;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (response.status === 429 || response.status === 503) {
        if (delay > 20_000) throw new Error(`rpc ${method} rate limited after ${attempt} attempts`);
        await sleep(delay);
        delay = Math.min(delay * 2, 20_000);
        continue;
      }
      if (!response.ok) throw new Error(`rpc ${method} failed: HTTP ${response.status}`);
      const json = (await response.json()) as { result?: T; error?: { message?: string } };
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? "unknown error"}`);
      return json.result as T;
    }
  }

  /** Shared V2 pagination loop; `sliceToPubkeys` requests 0-byte data slices. */
  async function listRaw(
    programId: string,
    filters: unknown[],
    sliceToPubkeys: boolean,
  ): Promise<Array<{ pubkey: string; account: { data: [string, string] } }>> {
    return listSliced(programId, filters, sliceToPubkeys ? { offset: 0, length: 0 } : undefined);
  }

  /** Shared V2 pagination loop with an optional explicit data slice. */
  async function listSliced(
    programId: string,
    filters: unknown[],
    dataSlice?: { offset: number; length: number },
  ): Promise<Array<{ pubkey: string; account: { data: [string, string] } }>> {
    interface V2Page {
      accounts: Array<{ pubkey: string; account: { data: [string, string] } }>;
      paginationKey: string | null;
    }
    const out: Array<{ pubkey: string; account: { data: [string, string] } }> = [];
    let paginationKey: string | null = null;
    for (;;) {
      const page: V2Page = await call<V2Page>("getProgramAccountsV2", [
        programId,
        {
          encoding: "base64",
          filters,
          ...(dataSlice ? { dataSlice } : {}),
          limit: 10_000,
          ...(paginationKey ? { paginationKey } : {}),
        },
      ]);
      out.push(...page.accounts);
      paginationKey = page.paginationKey;
      if (!paginationKey || page.accounts.length === 0) break;
    }
    return out;
  }

  return {
    /**
     * Lists all accounts of a program matching the filters using Helius
     * getProgramAccountsV2 with cursor pagination (10K accounts/page).
     * Pagination ends when a page returns no accounts (Helius contract).
     */
    async listProgramAccounts(programId, filters) {
      const pubkeys = await listRaw(programId, filters, true);
      return pubkeys.map((row) => row.pubkey);
    },
    async listProgramAccountsWithData(programId, filters) {
      const rows = await listRaw(programId, filters, false);
      return rows.map((row) => ({ pubkey: row.pubkey, data: row.account.data[0] }));
    },
    async listProgramAccountsSliced(programId, filters, dataSlice) {
      const rows = await listSliced(programId, filters, dataSlice);
      return rows.map((row) => ({ pubkey: row.pubkey, data: row.account.data[0] }));
    },
    async getMultipleAccounts(pubkeys) {
      const out: { data: [string, string] | null }[] = [];
      for (let i = 0; i < pubkeys.length; i += 100) {
        // getMultipleAccounts returns { context, value: [...] } — unwrap .value.
        const rows = await call<{ value: { data: [string, string] | null }[] }>("getMultipleAccounts", [
          pubkeys.slice(i, i + 100),
          { encoding: "base64" },
        ]);
        out.push(...rows.value);
      }
      return out;
    },
    async getMultipleAccountsRaw(pubkeys) {
      const out: { owner: string | null; data: { base64: string } | null }[] = [];
      for (let i = 0; i < pubkeys.length; i += 100) {
        const rows = await call<{ value: { owner: string; data: [string, string] }[] }>("getMultipleAccounts", [
          pubkeys.slice(i, i + 100),
          { encoding: "base64" },
        ]);
        out.push(...rows.value.map((row) => ({ owner: row.owner, data: { base64: row.data[0] } })));
      }
      return out;
    },
  };
}

/** Pool inventory diff result for one venue. */
export interface VenuePoolDelta {
  venue: string;
  newPools: string[];
  totalPools: number;
}

/** Venue with a known baseline of accounts the feed has already seen. */
interface VenueState {
  venue: Venue;
  known: Set<string>;
  /** True once the first listing completed (diffing starts after priming). */
  primed: boolean;
}

/**
 * Known-set cache so repeated scans only surface newly created pools.
 * Heavy venues (meteora-damm-v2: 1.45M accounts, ~85s to list) are re-scanned
 * only every Nth pass — new-pool listings there sit far longer than the extra
 * latency, so the bandwidth saving is free.
 */
export class PoolFeed {
  private readonly states: VenueState[];

  constructor(
    private readonly rpc: RpcClient,
    venues: Venue[] = VENUES,
    /** Venue names to scan only every Nth pass (default: heavy set below). */
    private readonly heavyEvery = new Map<string, number>(
      VENUES.filter((venue) => venue.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG").map((venue) => [venue.name, 8] as const),
    ),
    private pass = 0,
  ) {
    this.states = venues.map((venue) => ({ venue, known: new Set<string>(), primed: false }));
  }

  /** Lists pool addresses for a venue (dataSize filter, paginated V2). */
  private async listVenue(venue: Venue): Promise<string[]> {
    return this.rpc.listProgramAccounts(venue.programId, [{ dataSize: venue.layout.poolAccountSize }]);
  }

  /**
   * One diff scan. First pass primes baselines (reports nothing). Heavy venues
   * are skipped between their scheduled passes — but pass #1 always lists them.
   */
  async scan(): Promise<VenuePoolDelta[]> {
    this.pass += 1;
    const deltas: VenuePoolDelta[] = [];
    for (const state of this.states) {
      const every = this.heavyEvery.get(state.venue.name);
      const due = !state.primed || every === undefined || this.pass % every === 1;
      if (!due) continue;
      const pools = await this.listVenue(state.venue);
      const newPools = state.primed ? pools.filter((pool) => !state.known.has(pool)) : [];
      for (const pool of pools) state.known.add(pool);
      state.primed = true;
      deltas.push({ venue: state.venue.name, newPools, totalPools: pools.length });
    }
    return deltas;
  }

  /** Decodes a batch of pool addresses for a venue into mints/vaults. */
  async decodePools(venueName: string, poolAddresses: string[]): Promise<DecodedPool[]> {
    const state = this.states.find((entry) => entry.venue.name === venueName);
    if (!state || !poolAddresses.length) return [];
    const venue = state.venue;
    const accounts = await this.rpc.getMultipleAccounts(poolAddresses);
    const decoded: DecodedPool[] = [];
    for (let i = 0; i < poolAddresses.length; i += 1) {
      const account = accounts[i];
      const base64 = account?.data?.[0];
      if (!base64) continue;
      const pool = decodePoolAccount(venue, poolAddresses[i]!, Buffer.from(base64, "base64"));
      if (pool) decoded.push(pool);
    }
    return decoded;
  }
}

export interface VaultBalances {
  mint: string;
  amount: bigint;
  decimals: number;
}

/** Raw 165-byte token account view (mint @0, owner @32, amount @64). */
export function decodeTokenAccount(buf: Buffer): { mint: string; owner: string; amount: bigint } | null {
  if (buf.length !== TOKEN_ACCOUNT_DATA_SIZE) return null;
  return {
    mint: bs58.encode(buf.subarray(0, 32)),
    owner: bs58.encode(buf.subarray(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32)),
    amount: buf.readBigUInt64LE(64),
  };
}

/**
 * Fetches live vault balances (amount + decimals + mint) for a decoded pool.
 * Uses getTokenAccountBalance-style multi-fetch via getMultipleAccounts on the
 * vault addresses; decimals are read from the vault's mint account.
 */
export async function fetchVaultBalances(
  rpc: RpcClient,
  pool: DecodedPool,
): Promise<[VaultBalances | null, VaultBalances | null]> {
  const vaultAccounts = await rpc.getMultipleAccounts([pool.vaultA, pool.vaultB]);
  const mints = await rpc.getMultipleAccounts([pool.mintA, pool.mintB]);
  /** SPL mint layout: mintAuthorityOption(4) authority(32) supply(8) decimals(1)@44. */
  const decimalsOf = (buf: Buffer | null): number | null => {
    if (!buf || buf.length < 45) return null;
    const decimals = buf[44] ?? 0;
    return decimals >= 0 && decimals <= 9 ? decimals : null;
  };
  const parse = (
    vault: { data: [string, string] | null } | undefined,
    mintBuf: Buffer | null,
    expectedMint: string,
  ): VaultBalances | null => {
    const base64 = vault?.data?.[0];
    if (!base64) return null;
    const buf = Buffer.from(base64, "base64");
    const tokenAccount = decodeTokenAccount(buf);
    if (!tokenAccount) return null;
    // The vault must actually hold the pool's mint; a mismatch means we read
    // a PDA-collision or the pool layout changed — never trust the balance then.
    if (tokenAccount.mint !== expectedMint) return null;
    const decimals = decimalsOf(mintBuf);
    // A missing/unreadable mint account must invalidate the balance — returning
    // raw amounts as if decimals=0 previously produced phantom "deep" pools.
    if (decimals === null) return null;
    return { mint: expectedMint, amount: tokenAccount.amount, decimals };
  };
  const mintABuf = mints[0]?.data?.[0] ? Buffer.from(mints[0].data[0], "base64") : null;
  const mintBBuf = mints[1]?.data?.[0] ? Buffer.from(mints[1].data[0], "base64") : null;
  return [parse(vaultAccounts[0], mintABuf, pool.mintA), parse(vaultAccounts[1], mintBBuf, pool.mintB)];
}
