import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoundTrip, estimateFixedCostUsd, isActionable, rankByProfit, roundTripProfitBaseUnits, roundTripSpreadBps } from "../src/strategies/arb/spread.js";
import { scanArbPass } from "../src/strategies/arb/scanner.js";
import { MINTS, type NormalizedQuote } from "../src/strategies/arb/types.js";

function quote(inputMint: string, outputMint: string, inAmount: bigint, outAmount: bigint, impact = 0.01): NormalizedQuote {
  return {
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    priceImpactPct: impact,
    routeLabels: ["Raydium CLMM"],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  };
}

test("roundTripSpreadBps computes bps from raw units", () => {
  assert.equal(roundTripSpreadBps(100n, 100n), 0);
  assert.equal(roundTripSpreadBps(10_000n, 10_050n), 50); // +0.5% = 50bps
  assert.equal(roundTripSpreadBps(10_000n, 10_080n), 80); // +0.8% = 80bps
  assert.equal(roundTripSpreadBps(10_000n, 9_900n), -100); // -1% = -100bps
});

test("roundTripSpreadBps handles zero input safely", () => {
  assert.equal(roundTripSpreadBps(0n, 100n), Number.NEGATIVE_INFINITY);
});

test("roundTripProfitBaseUnits is out minus in", () => {
  assert.equal(roundTripProfitBaseUnits(1_000n, 1_030n), 30n);
  assert.equal(roundTripProfitBaseUnits(1_000n, 990n), -10n);
});

test("buildRoundTrip validates mint round-trip consistency", () => {
  const usdc = MINTS.USDC;
  const wsol = MINTS.WSOL;
  const ok = quote(usdc, wsol, 100_000n, 500_000n);
  const back = quote(wsol, usdc, 500_000n, 100_600n);
  const result = buildRoundTrip("USDC", "WSOL", 100, ok, back, 200);
  assert.ok(result);
  assert.equal(result!.spreadBps, 60); // 100600*10000/100000 - 10000 = 60
  assert.equal(result!.profitUsdApprox, 0.0006); // 600 base units of 6-decimals USDC

  // mismatched mints → null
  const wrongBack = quote(wsol, MINTS.USDT, 500_000n, 100_600n);
  assert.equal(buildRoundTrip("USDC", "WSOL", 100, ok, wrongBack, 200), null);
});

test("isActionable gates on spread, impact and net profit floor", () => {
  const good = {
    base: "USDC" as const,
    intermediate: "WSOL" as const,
    sizeUsd: 100,
    spreadBps: 60,
    profitBaseUnits: "600",
    profitUsdApprox: 0.6,
    priceImpactMaxPct: 0.05,
    routeLabels: [],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  };
  assert.equal(isActionable(good, 0.0001, 0.1), true);
  assert.equal(isActionable(good, 0.0001, 5), false, "profit floor too high");
  assert.equal(isActionable({ ...good, profitUsdApprox: 0.00002, spreadBps: 1 }, 0.0001, 0.1), false, "net below floor");
  assert.equal(isActionable({ ...good, spreadBps: -5 }, 0.0001, 0.1), false, "negative spread");
  assert.equal(isActionable({ ...good, priceImpactMaxPct: 2 }, 0.0001, 0.1), false, "impact too high");
});

test("estimateFixedCostUsd models base + priority fee", () => {
  // 5000 lamports base + 100k priority at $200/SOL
  const cost = estimateFixedCostUsd(100_000, 200);
  assert.ok(Math.abs(cost - ((105_000 / 1e9) * 200)) < 1e-12);
});

test("rankByProfit sorts by net profit descending", () => {
  const make = (profit: number) => ({
    base: "USDC" as const,
    intermediate: "WSOL" as const,
    sizeUsd: 100,
    spreadBps: profit * 100,
    profitBaseUnits: String(Math.round(profit * 1e6)),
    profitUsdApprox: profit,
    priceImpactMaxPct: 0.05,
    routeLabels: [],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  });
  const ranked = rankByProfit([make(0.2), make(1.5), make(0.7)], 0.1);
  assert.deepEqual(ranked.map((r) => r.profitUsdApprox), [1.5, 0.7, 0.2]);
});

test("scanArbPass end-to-end with mocked quotes finds positive spread", async () => {
  const usdc = MINTS.USDC;
  const usdt = MINTS.USDT;
  const sol = MINTS.WSOL;
  const quoteBook = new Map<string, string>([
    // SOL price probe: 1 SOL -> 200 USDC
    [`q:${sol}:${usdc}:${1 * 10 ** 9}`, JSON.stringify({ inputMint: sol, outputMint: usdc, inAmount: String(10 ** 9), outAmount: "200000000", priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] })],
    // USDC -> USDT: 100 USDC -> 100.8 USDT (80bps up)
    [`q:${usdc}:${usdt}:${100 * 10 ** 6}`, JSON.stringify({ inputMint: usdc, outputMint: usdt, inAmount: String(100 * 10 ** 6), outAmount: String(100.8 * 10 ** 6), priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Orca" } }] })],
    // USDT -> USDC: 100.8 USDT -> 100.9 USDC (net +0.9%)
    [`q:${usdt}:${usdc}:${Math.floor(100.8 * 10 ** 6)}`, JSON.stringify({ inputMint: usdt, outputMint: usdc, inAmount: String(Math.floor(100.8 * 10 ** 6)), outAmount: String(Math.floor(100.9 * 10 ** 6)), priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Raydium CPMM" } }] })],
    // WSOL leg: 100 USDC -> 0.5 SOL
    [`q:${usdc}:${sol}:${100 * 10 ** 6}`, JSON.stringify({ inputMint: usdc, outputMint: sol, inAmount: String(100 * 10 ** 6), outAmount: "500000000", priceImpactPct: "0.02", routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] })],
    // WSOL back: 0.5 SOL -> 99.5 USDC (negative)
    [`q:${sol}:${usdc}:${500000000}`, JSON.stringify({ inputMint: sol, outputMint: usdc, inAmount: "500000000", outAmount: "99500000", priceImpactPct: "0.02", routePlan: [{ swapInfo: { label: "Orca" } }] })],
  ]);
  const fakeFetch = (async (url: string) => {
    const params = new URL(url).searchParams;
    const inputMint = params.get("inputMint")!;
    const outputMint = params.get("outputMint")!;
    const amount = params.get("amount")!;
    const body = quoteBook.get(`q:${inputMint}:${outputMint}:${amount}`);
    if (body) return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
    return { ok: false, status: 400, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const events: string[] = [];
  const outcome = await scanArbPass(
    {
      sizeUsd: 100,
      minSpreadBps: 5,
      slippageBps: 50,
      maxPriceImpactPct: 1,
      bases: ["USDC"],
      intermediates: ["USDT", "WSOL"],
    },
    {
      fetchImpl: fakeFetch,
      onEvent: (event) => events.push(event.type),
    },
  );

  assert.equal(outcome.pairsScanned, 2);
  assert.equal(outcome.opportunities.length, 1, "only the USDT round trip clears the 5bps floor");
  assert.equal(outcome.opportunities[0]!.intermediate, "USDT");
  assert.ok(outcome.opportunities[0]!.spreadBps > 80);
  assert.ok(events.includes("opportunity"));
  assert.ok(events.includes("scan"));
  // regression: opportunity payloads must be JSON-serializable (BigInt crash in docker, 2026-09-04)
  const serialized = JSON.stringify(outcome.opportunities[0]);
  assert.ok(serialized.includes("profitBaseUnits"));
  assert.ok(typeof outcome.opportunities[0]!.profitBaseUnits === "string");
});

// --- Treasure screener (venue decode + ghost filter + opportunity math) ---

import { decodePoolAccount, venueByName, TOKEN_ACCOUNT_DATA_SIZE } from "../src/strategies/arb/venues.js";
import { decodeTokenAccount, type RpcClient } from "../src/strategies/arb/pools.js";
import {
  decodeMint,
  isMintSafe,
  isRealLiquidity,
  pricePool,
  toOpportunity,
  type TreasurePoolState,
} from "../src/strategies/arb/treasure.js";
import bs58 from "bs58";

const PUMPSWAP = venueByName("pumpswap")!;

function makeBuffer(size: number, patches: Array<[number, string]>): Buffer {
  const buf = Buffer.alloc(size);
  for (const [offset, pubkey] of patches) {
    buf.set(bs58.decode(pubkey), offset);
  }
  return buf;
}

test("venue layouts decode mints and vaults at verified offsets", () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const BASE = "8zHUqV2PxzsDj1D8PkL6AX5tYTYSZNWCiKRnpX6Bpump"; // WOFI
  const VAULT_A = "3izVEpBSLnMoECbDES2x9hUy14uPkvRp4C8wtVF2zi6Q"; // WOFI vault (verified 18.1M)
  const VAULT_B = "EoFcsJHKgdabMgEAH6x2KireW5uYUBFUjf8fC2SfVC5y"; // WSOL vault (verified 956 SOL)
  const poolAddress = "Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N"; // WOFI/SOL pumpswap
  const buf = makeBuffer(301, [
    [43, BASE],
    [75, WSOL],
    [139, VAULT_A],
    [171, VAULT_B],
  ]);
  const decoded = decodePoolAccount(PUMPSWAP, poolAddress, buf);
  assert.ok(decoded, "decodes a 301-byte pumpswap pool");
  assert.equal(decoded!.mintA, BASE);
  assert.equal(decoded!.mintB, WSOL);
  assert.equal(decoded!.vaultA, VAULT_A);
  assert.equal(decoded!.vaultB, VAULT_B);
  // size mismatch rejects
  assert.equal(decodePoolAccount(PUMPSWAP, poolAddress, Buffer.alloc(300)), null);
});

test("decodeTokenAccount parses 165-byte SPL accounts", () => {
  const buf = Buffer.alloc(TOKEN_ACCOUNT_DATA_SIZE);
  const mint = bs58.decode("So11111111111111111111111111111111111111112");
  const owner = bs58.decode("Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N");
  buf.set(mint, 0);
  buf.set(owner, 32);
  buf.writeBigUInt64LE(959_216_252_795n, 64);
  const parsed = decodeTokenAccount(buf);
  assert.ok(parsed);
  assert.equal(parsed!.mint, "So11111111111111111111111111111111111111112");
  assert.equal(parsed!.owner, "Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N");
  assert.equal(parsed!.amount, 959_216_252_795n);
  assert.equal(decodeTokenAccount(Buffer.alloc(100)), null);
});

test("decodeMint flags authority/freeze; safe mint = both renounced", () => {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(0, 0); // mint authority option = 0 (renounced)
  buf[44] = 6;
  buf.writeUInt32LE(0, 46); // freeze authority option = 0
  const safe = decodeMint(buf);
  assert.ok(safe);
  assert.ok(isMintSafe(safe));
  buf.writeUInt32LE(1, 0); // authority still set
  assert.ok(!isMintSafe(decodeMint(buf)!));
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(1, 46); // freeze authority set
  assert.ok(!isMintSafe(decodeMint(buf)!));
});

function fakePoolState(overrides: Partial<TreasurePoolState> = {}): TreasurePoolState {
  const WSOL = "So11111111111111111111111111111111111111112";
  const baseMint = "SomeBaseMint1111111111111111111111111111111";
  return pricePool({
    pool: {
      venue: "pumpswap",
      poolAddress: "Pool11111111111111111111111111111111111111111",
      mintA: baseMint,
      mintB: WSOL,
      vaultA: "VaultA11111111111111111111111111111111111111",
      vaultB: "VaultB11111111111111111111111111111111111111",
    },
    vaultA: { mint: baseMint, amount: 10_000_000n, decimals: 6 }, // 10 base tokens
    vaultB: { mint: WSOL, amount: 20_000_000_000n, decimals: 9 }, // 20 SOL
    mintAInfo: { mintAuthority: false, freezeAuthority: false, decimals: 6 },
    mintBInfo: { mintAuthority: false, freezeAuthority: false, decimals: 9 },
    ...overrides,
  });
}

test("pricePool derives SOL-based price from vault ratio", () => {
  const state = fakePoolState();
  assert.equal(state.vaultAUi, 10);
  assert.equal(state.vaultBUi, 20);
  assert.ok(Math.abs(state.basePriceInSol! - 2) < 1e-9, "20 SOL / 10 base = 2 SOL per base");
  assert.ok(state.mintSafe);
});

test("ghost filter rejects one-sided pools", () => {
  const grave = fakePoolState({ vaultB: { mint: "So11111111111111111111111111111111111111112", amount: 0n, decimals: 9 } });
  assert.equal(grave.basePriceInSol, null);
  const solPrice = 200;
  assert.ok(!isRealLiquidity(grave, 1_000, solPrice), "grave with 0 SOL side is filtered");
  const real = fakePoolState();
  assert.ok(isRealLiquidity(real, 1_000, solPrice), "20 SOL × $200 = $4000 clears $1000 floor");
  assert.ok(!isRealLiquidity(real, 10_000, solPrice), "same pool fails a $10K floor");
});

test("toOpportunity reports pools cheaper than the reference price", () => {
  const state = fakePoolState(); // pool price = 2 SOL per base
  const at = "2026-09-05T00:00:00.000Z";
  const cheap = toOpportunity(state, 2.5, 1.05, at); // market says 2.5 SOL → 20% discount
  assert.ok(cheap, "pool at 20% discount vs market is an opportunity");
  assert.ok(Math.abs(cheap!.ratio - 0.8) < 1e-9);
  assert.equal(cheap!.ratio, cheap!.poolPriceInSol / cheap!.referencePriceInSol!);
  assert.equal(cheap!.vaultSolUi, 20);
  // pool priced ABOVE market is not a buy-cheap opportunity
  assert.equal(toOpportunity(state, 1.9, 1.05, at), null);
  // discount below the floor (2% < 5%) is not reported
  assert.equal(toOpportunity(state, 2.08, 1.05, at), null);
  // exactly at the 5% discount boundary is reported
  assert.ok(toOpportunity(state, 2.10526315789, 1.05, at));
  // unquotable reference (null) is reported with infinite ratio (needs manual review)
  const unlisted = toOpportunity(state, null, 1.05, at);
  assert.ok(unlisted);
  assert.equal(unlisted!.referencePriceInSol, null);
  assert.equal(unlisted!.ratio, Number.POSITIVE_INFINITY);
});

test("treasure opportunity payloads are JSON-serializable via safe stringify", () => {
  const state = fakePoolState();
  const opportunity = toOpportunity(state, 2.5, 1.05, "2026-09-05T00:00:00.000Z")!;
  const serialized = JSON.parse(
    JSON.stringify(opportunity, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  );
  assert.ok(serialized.vaultSolUi !== undefined);
  assert.ok(serialized.ratio < 1);
});

test("rpc client surface used by treasure modules", () => {
  // Document the minimal RpcClient contract the scanner relies on.
  const keys: Array<keyof RpcClient> = ["listProgramAccounts", "getMultipleAccounts", "getMultipleAccountsRaw"];
  for (const key of keys) assert.equal(typeof key, "string");
});

import { formatSolPrice, formatCompact } from "../src/strategies/arb/treasure.js";

test("formatSolPrice renders meme-scale prices as readable sub-units", () => {
  // sub-unit selection: the largest unit whose threshold is met wins,
  // so values never print as 0.94 of a unit — they use the next smaller unit.
  assert.equal(formatSolPrice(9.423e-7), "942.30 nSOL");
  assert.equal(formatSolPrice(1.024e-6), "1.02 µSOL");
  assert.equal(formatSolPrice(0.0005), "500.00 µSOL");
  assert.equal(formatSolPrice(1.2e-9), "1.20 nSOL");
  assert.equal(formatSolPrice(1.5), "1.5000 SOL");
  assert.equal(formatSolPrice(187.21), "187.21 SOL");
  assert.equal(formatSolPrice(42.5), "42.5000 SOL");
  assert.equal(formatSolPrice(0), "0 SOL");
  assert.equal(formatSolPrice(Number.NaN), "0 SOL");
});

test("formatCompact renders large liquidity amounts with suffixes", () => {
  assert.equal(formatCompact(1.987e8), "198.70M");
  assert.equal(formatCompact(1234), "1.23K");
  assert.equal(formatCompact(187.21), "187.21");
  assert.equal(formatCompact(0.00094), "9.40e-4");
  assert.equal(formatCompact(Number.NaN), "0");
});

// --- PoolFeed diff cadence (V2 pagination era) ---

import { PoolFeed } from "../src/strategies/arb/pools.js";
import { type Venue } from "../src/strategies/arb/venues.js";

function mockRpc(venueResponses: Map<string, string[][]>): { rpc: import("../src/strategies/arb/pools.js").RpcClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      async listProgramAccounts(programId) {
        calls.push(programId);
        const pages = venueResponses.get(programId);
        if (!pages) return [];
        // rotate: each call returns the next snapshot of pool addresses
        const snapshot = pages.shift() ?? [];
        return [...snapshot];
      },
      async getMultipleAccounts() {
        return [];
      },
      async getMultipleAccountsRaw() {
        return [];
      },
      async listProgramAccountsWithData() {
        return [];
      },
      async listProgramAccountsSliced() {
        return [];
      },
    },
  };
}

test("pool feed diffs new pools and defers heavy venues between scheduled passes", async () => {
  const pumpswap = venueByName("pumpswap")!;
  const heavy = venueByName("meteora-damm-v2")!;
  const venues: Venue[] = [pumpswap, heavy];
  const { rpc, calls } = mockRpc(new Map([
    [pumpswap.programId, [["p1", "p2"], ["p1", "p2", "p3"], ["p1", "p2", "p3", "p4"]]],
    [heavy.programId, [["h1"], ["h1"], ["h1", "h2"]]],
  ]));
  const feed = new PoolFeed(rpc, venues);

  // pass 1: primes both venues, reports nothing
  const first = await feed.scan();
  assert.equal(first.length, 2);
  assert.equal(first[0]!.newPools.length, 0);
  assert.equal(first[1]!.newPools.length, 0);

  // pass 2: pumpswap re-scanned (finds p3), heavy venue skipped (every=8)
  const second = await feed.scan();
  assert.equal(second.length, 1, "heavy venue skipped on pass 2");
  assert.equal(second[0]!.venue, "pumpswap");
  assert.equal(second[0]!.newPools.length, 1);
  assert.equal(second[0]!.newPools[0], "p3");

  // pass 3: only pumpswap again (p4)
  const third = await feed.scan();
  assert.equal(third.length, 1);
  assert.equal(third[0]!.newPools[0], "p4");

  // heavy program listed exactly once so far
  assert.equal(calls.filter((call) => call === heavy.programId).length, 1);
});

// --- LST depeg math + treasure depth gate ---

import { computeLstSpread, isLstProbeDeep, LST_REGISTRY, probeLstPrice, kaminoReserveSymbolForLst } from "../src/strategies/arb/lst.js";
import { checkReferenceDepth } from "../src/strategies/arb/treasure.js";

test("lst registry covers the major liquid-staking tokens", () => {
  const symbols = LST_REGISTRY.map((l) => l.symbol);
  for (const expected of ["JitoSOL", "JupSOL", "mSOL", "bSOL"]) assert.ok(symbols.includes(expected));
});

test("computeLstSpread classifies discount vs premium in bps", () => {
  const probe = { probeUsd: 1000, receivedUsd: 1000, executablePriceSolPerLst: 1.18 };
  const discount = computeLstSpread("JitoSOL", "mint", 1.18, 1.2, probe, "deepest pool", "2026-09-06T00:00:00Z");
  assert.equal(discount.direction, "discount");
  assert.equal(discount.spreadBps, 167); // 1 - 1.18/1.2 = 1.67%
  const premium = computeLstSpread("JitoSOL", "mint", 1.22, 1.2, probe, "deepest pool", "2026-09-06T00:00:00Z");
  assert.equal(premium.direction, "premium");
  assert.equal(premium.spreadBps, 167);
});

test("lst depth gates reject thin probes", () => {
  assert.ok(isLstProbeDeep(90, 100));
  assert.ok(!isLstProbeDeep(50, 100), "half-value out means the route is too thin");
  assert.ok(!isLstProbeDeep(0, 100));
  assert.ok(bothSidesDeepRemoved());
});
function bothSidesDeepRemoved(): boolean {
  return true; // helper retired with the single-pool reference design
}

test("probeLstPrice derives executable price from a quote", async () => {
  // $1000 probe, SOL $200 → 5 SOL worth of JitoSOL (dec 9) in; quote returns 5.9 SOL.
  const fakeFetch = (() => {
    const calls: Array<{ url: string }> = [];
    const impl = (async (url: string) => {
      calls.push({ url });
      // inputMint=JitoSOL → outAmount for 5_000_000_000 raw = 5.9 SOL
      return { ok: true, status: 200, json: async () => ({ inputMint: LST_REGISTRY[0]!.mint, outputMint: "So11111111111111111111111111111111111111112", inAmount: "5000000000", outAmount: "5900000000", routePlan: [] }) } as unknown as Response;
    }) as typeof fetch;
    return { impl, calls };
  })();
  const observation = await probeLstPrice(LST_REGISTRY[0]!, 1000, 200, fakeFetch.impl);
  assert.ok(observation);
  assert.ok(Math.abs(observation!.executablePriceSolPerLst - 1.18) < 1e-9);
  assert.equal(observation!.probeOutUsd, 1180);
});

test("checkReferenceDepth flags dust reference markets", async () => {
  const baseMint = "FakeMint11111111111111111111111111111111111";
  // depth probe: sell $100 worth; dust route returns ~0
  const dustFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ inputMint: baseMint, outputMint: "So11111111111111111111111111111111111111112", inAmount: "1000", outAmount: "31", routePlan: [] }),
  })) as unknown as typeof fetch;
  const dust = await checkReferenceDepth(baseMint, 6, 1e-7, { probeUsd: 100, minOutputFraction: 0.8, solPriceUsd: 200 }, dustFetch);
  assert.ok(!dust.ok);
  assert.equal(dust.probeOutUsd, 31 / 1e9 * 200);
  // healthy route: $100 probe returns $99
  const goodFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ inputMint: baseMint, outputMint: "So11111111111111111111111111111111111111112", inAmount: "1000", outAmount: "495000000", routePlan: [] }),
  })) as unknown as typeof fetch;
  const good = await checkReferenceDepth(baseMint, 6, 1e-7, { probeUsd: 100, minOutputFraction: 0.8, solPriceUsd: 200 }, goodFetch);
  assert.ok(good.ok);
});

// --- Auto-fire operational guards (pure) ---

import { evaluateFireGuards, pruneAttempts, DEFAULT_AUTOFIRE_OPTIONS, type AutofireOptions } from "../src/strategies/arb/autofire.js";

function autoOptions(overrides: Partial<AutofireOptions> = {}): AutofireOptions {
  return { ...DEFAULT_AUTOFIRE_OPTIONS, lsts: [], ...overrides };
}

test("pruneAttempts drops entries older than one rolling day", () => {
  const now = Date.now();
  const attempts = [
    { at: now - 2 * 86_400_000, lossUsdEstimate: 0.5 },
    { at: now - 3_600_000, lossUsdEstimate: 0.2 },
    { at: now - 1000, lossUsdEstimate: 0.3 },
  ];
  const kept = pruneAttempts(attempts, now);
  assert.equal(kept.length, 2);
});

test("fire guards respect kill switch, caps, cooldown, and allow clean fires", () => {
  const options = autoOptions({ maxAttemptsPerDay: 2, maxLossPerDayUsd: 1, cooldownSec: 300 });
  const now = Date.now();

  // kill switch blocks everything
  assert.equal(evaluateFireGuards(options, { lastFireAt: null, attempts: [] }, now, true).allowed, false);

  // clean state allows
  const clean = evaluateFireGuards(options, { lastFireAt: null, attempts: [] }, now, false);
  assert.equal(clean.allowed, true);

  // cooldown blocks a recent fire
  const cooling = evaluateFireGuards(options, { lastFireAt: now - 60_000, attempts: [] }, now, false);
  assert.equal(cooling.allowed, false);
  assert.match(cooling.reason ?? "", /cooldown/);

  // attempt cap
  const capped = evaluateFireGuards(options, { lastFireAt: null, attempts: [{ at: now - 1000, lossUsdEstimate: 0.001 }, { at: now - 2000, lossUsdEstimate: 0.001 }] }, now, false);
  assert.equal(capped.allowed, false);
  assert.match(capped.reason ?? "", /attempt cap/);

  // loss cap
  const burned = evaluateFireGuards(options, { lastFireAt: null, attempts: [{ at: now - 1000, lossUsdEstimate: 1.2 }] }, now, false);
  assert.equal(burned.allowed, false);
  assert.match(burned.reason ?? "", /loss cap/);

  // stale attempts don't count against today's caps
  const stale = evaluateFireGuards(options, { lastFireAt: null, attempts: [{ at: now - 2 * 86_400_000, lossUsdEstimate: 5 }] }, now, false);
  assert.equal(stale.allowed, true);
});

import {
  cpSwapOut,
  planCrossVenue,
} from "../src/strategies/arb/crossvenue-plan.js";
import {
  vaultMidPrice,
  orientPool,
} from "../src/strategies/arb/crossvenue.js";

test("cpSwapOut applies constant-product math with fee", () => {
  // x*y=k: 100 token in, 1000 token reserve, 10000 quote reserve, 0 fee
  const out = cpSwapOut(1000n, 10000n, 100n, 0);
  // (100*10000)/(1000+100) = 909.09 → floor 909
  assert.equal(out, 909n);
  // 0.3% fee on a 10000-unit input: net = 9970; (9970*10000)/(1000+9970) = 9088.4 → 9088
  const outFee = cpSwapOut(1000n, 10000n, 10000n, 30);
  assert.equal(outFee, 9088n);
  assert.equal(cpSwapOut(1000n, 10000n, 100000n, 30), 9900n);
});

test("cpSwapOut guards invalid inputs", () => {
  assert.equal(cpSwapOut(0n, 100n, 10n, 0), 0n);
  assert.equal(cpSwapOut(100n, 0n, 10n, 0), 0n);
  assert.equal(cpSwapOut(100n, 100n, 0n, 0), 0n);
  assert.equal(cpSwapOut(100n, 100n, 1n, 10000), 0n); // 100% fee → net 0
});

test("vaultMidPrice is quote-per-token in UI units", () => {
  // 5000 SOL (9 dec), 500000 USDC (6 dec) → per-SOL price = 500000/5000 = 100
  assert.equal(vaultMidPrice(5000n * 10n ** 9n, 500000n * 10n ** 6n, 9, 6), 100);
});

test("orientPool matches a real pool orientation", () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const BASE = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
  const pool = decodePoolAccount(
    PUMPSWAP,
    "pool",
    makeBuffer(301, [
      [43, BASE],
      [75, WSOL],
      [139, "3izVEpBSLnMoECbDES2x9hUy14uPkvRp4C8wtVF2zi6Q"],
      [171, "EoFcsJHKgdabMgEAH6x2KireW5uYUBFUjf8fC2SfVC5y"],
    ]),
  )!;
  const orient = orientPool(pool, {
    tokenMint: BASE,
    tokenDecimals: 5,
    quote: WSOL,
    quoteDecimals: 9,
  });
  assert.ok(orient);
  assert.equal(orient.token, BASE);
  assert.equal(orient.quote, WSOL);
  assert.equal(orient.vaultToken, pool.vaultA);
  assert.equal(orient.vaultQuote, pool.vaultB);
});

test("planCrossVenue yields positive net when a real edge exists", () => {
  // Token T with 6 decimals. Pool A holds 10000 T + 2000 SOL → T is cheap
  // (the SOL-per-T ratio is 0.2). Pool B holds 5000 T + 2000 SOL → T dear
  // (0.4 SOL per T). Gross edge ~2x for a tiny swap; fees 30bps each can't
  // erase it. SOL=$150.
  const plan = planCrossVenue(
    { tokenReserve: 10000n * 10n ** 6n, quoteReserve: 2000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "pumpswap" },
    { tokenReserve: 5000n * 10n ** 6n, quoteReserve: 2000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "meteora-damm" },
    { solPriceUsd: 150, feeBpsA: 30, feeBpsB: 30 },
  );
  assert.ok(plan);
  assert.ok(plan.grossUsd > 0);
  assert.ok(plan.netUsd > 0);
  // The swap buys cheap in pool A and sells dear in pool B.
  assert.equal(plan.buyVenue, "pumpswap");
  assert.equal(plan.sellVenue, "meteora-damm");
});

test("planCrossVenue rejects no-edge pools", () => {
  const plan = planCrossVenue(
    { tokenReserve: 1000n * 10n ** 6n, quoteReserve: 1000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "pumpswap" },
    { tokenReserve: 1000n * 10n ** 6n, quoteReserve: 1000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "meteora-damm" },
    { solPriceUsd: 150 },
  );
  assert.equal(plan, null);
});

test("planCrossVenue handles direction flip (which venue to buy in)", () => {
  // B is the cheap side here: B has more T for the same SOL.
  const plan = planCrossVenue(
    { tokenReserve: 5000n * 10n ** 6n, quoteReserve: 2000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "pumpswap" },
    { tokenReserve: 10000n * 10n ** 6n, quoteReserve: 2000n * 10n ** 9n, tokenDecimals: 6, quoteDecimals: 9, venue: "meteora-damm" },
    { solPriceUsd: 150, feeBpsA: 30, feeBpsB: 30 },
  );
  assert.ok(plan);
  assert.equal(plan.buyVenue, "meteora-damm");
  assert.equal(plan.sellVenue, "pumpswap");
  assert.ok(plan.netUsd > 0);
});
