/**
 * E2E: DUE obligation → full executor verdict chain → Sender fire.
 *
 * The on-chain liquidation is MOCKED at the two true boundaries the executor
 * cannot cross offline: the signed-transaction builder (no live RPC/ALT) and
 * the simulation. Everything else is the real code path:
 *
 *   hydrate (prehydrated) → health gate → pair selection → collateral estimate →
 *   swap quote (mocked local CLMM) → assemble 15-ix sandwich with the
 *   Sender tip → packet guard → simulation → profit guard → Sender cost gate →
 *   ready → broadcastLiquidation → Sender JSON-RPC → confirmation on data RPC.
 *
 * It asserts the executor reaches `ready`, picks the right Sender tier by prize,
 * embeds the tip transfer, and that the broadcast router posts to the correct
 * Sender endpoint with skipPreflight/maxRetries=0 and confirms.
 */
import { ClmmLocalQuoter } from "../src/strategies/liquidation/clmm.js";
import { mock } from "node:test";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { executeLiquidationOnce, type LiquidationInput } from "../src/strategies/liquidation/execute.js";
import { broadcastLiquidation } from "../src/strategies/liquidation/execution-lane.js";
import { SENDER_TIP_ACCOUNTS, type SenderConfig } from "../src/strategies/liquidation/sender.js";

// ── The executor reads the signer from the env (hot-cached); give it a test key. ──
process.env.PRIVATE_KEY = JSON.stringify(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));

// ── Deterministic valid base58 accounts ────────────────────────────────────────
const pk = (index: number): string => new PublicKey(Uint8Array.from([7, ...new Array(30).fill(0), index])).toBase58();
const MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const FARMS = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const REPAY_RESERVE = pk(11); // USDC side
const WITHDRAW_RESERVE = pk(12); // WSOL side
const OBLIGATION = pk(100);
const NULL_ORACLE = "11111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const REPAY_AMOUNT_BASE_UNITS = 1_000_000_000n;

// ── Mocked external HTTP: Sender submission only ────────
let quoteOutAmount = "1010000000";
const senderRequests: Array<{ url: string; body: { method?: string; params: unknown[] } }> = [];
const SENT_SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: async () => payload }) as unknown as Response;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("sender.helius-rpc.com")) {
    senderRequests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: SENT_SIGNATURE });
  }
  if (url.endsWith("/ping")) return jsonResponse({});
  // Any aggregator request is unexpected in the CLMM-only executor.
  throw new Error(`unexpected fetch in E2E: ${url}`);
}) as typeof fetch;

mock.method(ClmmLocalQuoter.prototype, "quoteExactIn", async () => ({
  allTradeConfirmed: () => true,
  amountOutBigInt: () => BigInt(quoteOutAmount),
  amountOutMinBigInt: () => BigInt(quoteOutAmount) * 9950n / 10000n,
}));
mock.method(ClmmLocalQuoter.prototype, "buildSwapInstruction", async () => ({
  poolId: new PublicKey(pk(9)),
  instruction: new TransactionInstruction({
    programId: new PublicKey(CLMM_PROGRAM), data: Buffer.from([1, 2, 3, 4]),
    keys: [WSOL_MINT, USDC_MINT].map(pubkey => ({ pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true })),
  }),
}));

// ── Mocked data RPC (blockhash, ATA reads, status polling) ─────────────────────
const rpc = {
  getAccountInfo: () => ({ send: async () => ({ value: null }) }),
  getMultipleAccounts: () => ({ send: async () => ({ value: [] }) }),
  getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 999_999n } }) }),
  getSignatureStatuses: () => ({ send: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }) }),
} as unknown as Rpc<SolanaRpcApi>;

// ── Fake Kamino market / obligation (only the methods the executor calls) ──────
function makeReserve(input: {
  address: string; symbol: string; mint: string; decimals: number; priceUsd: number;
  tokenProgram?: string; nonce: number;
}): Record<string, unknown> {
  const price = new Decimal(input.priceUsd);
  return {
    address: address(input.address),
    getTokenSymbol: () => input.symbol,
    getLiquidityMint: () => address(input.mint),
    getMintDecimals: () => input.decimals,
    getLiquidityAvailableAmount: () => new Decimal(1_000_000_000),
    getOracleMarketPrice: () => price,
    hasValidOraclePrice: () => true,
    getFlashLoanFee: () => new Decimal(0),
    getLiquidityTokenProgram: () => address(input.tokenProgram ?? TOKEN_PROGRAM),
    getCTokenMint: () => address(pk(50 + input.nonce)),
    getDebtFarmAddress: () => ({ __option: "None" }),
    getCollateralFarmAddress: () => ({ __option: "None" }),
    calculateFlashLoanFees: () => ({ protocolFees: new Decimal(0), referrerFees: new Decimal(0) }),
    state: {
      lendingMarket: address(MARKET),
      liquidity: { supplyVault: address(pk(20 + input.nonce)), feeVault: address(pk(30 + input.nonce)) },
      collateral: { supplyVault: address(pk(40 + input.nonce)) },
      config: {
        fees: { flashLoanFeeSf: new Decimal(0) },
        minLiquidationBonusBps: 100,
        maxLiquidationBonusBps: 1000,
        badDebtLiquidationBonusBps: 0,
        liquidationThresholdPct: 80,
        protocolLiquidationFeePct: 0,
        borrowFactorPct: new Decimal(100),
        loanToValuePct: 80,
        tokenInfo: {
          pythConfiguration: { price: NULL_ORACLE },
          switchboardConfiguration: { priceAggregator: NULL_ORACLE, twapAggregator: NULL_ORACLE },
          scopeConfiguration: { priceFeed: NULL_ORACLE },
        },
      },
    },
  };
}

const repayReserve = makeReserve({ address: REPAY_RESERVE, symbol: "USDC", mint: USDC_MINT, decimals: 6, priceUsd: 1, nonce: 1 });
const withdrawReserve = makeReserve({ address: WITHDRAW_RESERVE, symbol: "WSOL", mint: WSOL_MINT, decimals: 9, priceUsd: 150, nonce: 2 });

const market = {
  getAddress: () => address(MARKET),
  programId: address(KLEND),
  farmsProgramId: address(FARMS),
  state: { liquidationMaxDebtCloseFactorPct: 100, referralFeeBps: 0 },
  getReserves: () => [repayReserve, withdrawReserve],
  getReservesByMint: (mint: unknown) => (String(mint) === WSOL_MINT ? [withdrawReserve] : []),
  getReserveByAddress: (a: unknown) =>
    [repayReserve, withdrawReserve].find((r) => String((r as { address: unknown }).address) === String(a)),
  getLendingMarketAuthority: async () => address(pk(60)),
} as unknown as LiquidationInput["market"];

const obligation = {
  obligationTag: 0,
  refreshedStats: {
    userTotalDeposit: new Decimal(2000),
    userTotalBorrow: new Decimal(1000),
    userTotalBorrowBorrowFactorAdjusted: new Decimal(1000),
    borrowLiquidationLimit: new Decimal(900), // health 0.90 → DUE
  },
  getDeposits: () => [{ reserveAddress: address(WITHDRAW_RESERVE), marketValueRefreshed: new Decimal(2000), amount: new Decimal(2000) }],
  getBorrows: () => [{ reserveAddress: address(REPAY_RESERVE), marketValueRefreshed: new Decimal(1000), amount: new Decimal(1000) }],
} as unknown as NonNullable<LiquidationInput["prehydratedObligation"]>;

// ── Transaction-builder mock: captures the REAL assembled instructions, returns a
//    packet-safe signed tx (the live path compresses with a live ALT we can't have
//    offline). This is the "mocked liquidation" boundary. ────────────────────────
type BuildTransactionFn = NonNullable<NonNullable<LiquidationInput["deps"]>["createSignedTransaction"]>;
type SimulateFn = NonNullable<NonNullable<LiquidationInput["deps"]>["simulate"]>;
let capturedInstructions: Instruction[][] = [];
const createSignedTransaction = (async (
  _rpc: unknown, _rpcUrl: unknown, signer: Parameters<typeof setTransactionMessageFeePayerSigner>[0], instructions: Instruction[], _tables: unknown, onCoverage?: (uncovered: string[]) => void,
) => {
  capturedInstructions.push(instructions);
  onCoverage?.([]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 999_999n }, tx),
    (tx) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 100_000 })], tx),
  );
  return signTransactionMessageWithSigners(message);
}) as unknown as BuildTransactionFn;

const simulate = (async () => ({
  context: { slot: 123n },
  value: { err: null, logs: ["Program KLend... success"], unitsConsumed: 250_000n },
})) as unknown as SimulateFn;

const senderConfig = (enabled: boolean): SenderConfig => ({
  enabled,
  endpoint: "http://ewr-sender.helius-rpc.com/fast",
  maxPrizeUsd: 5,
  maxTipFraction: 0.01,
  maxTipCapSol: 0.02,
  minProfitUsd: 0.05,
  bundle: true,
});

async function runExecutor(options: { prizeUsd: number; minProfitUsd?: number }, overrides: Partial<LiquidationInput> = {}): Promise<Awaited<ReturnType<typeof executeLiquidationOnce>>> {
  capturedInstructions = [];
  return executeLiquidationOnce({
    rpc,
    rpcUrl: "http://data-rpc.test",
    market,
    obligationAddress: address(OBLIGATION),
    slippageBps: 50,
    minProfitUsd: options.minProfitUsd ?? 0.05,
    prehydratedObligation: obligation,
    prizeUsd: options.prizeUsd,
    sender: senderConfig(true),
    deps: { createSignedTransaction, simulate },
    ...overrides,
  });
}

function findSenderTip(instructions: Instruction[]): Instruction | undefined {
  return instructions.find(
    (ix) => String(ix.programAddress) === "11111111111111111111111111111111"
      && SENDER_TIP_ACCOUNTS.includes(String(ix.accounts?.[1]?.address) as (typeof SENDER_TIP_ACCOUNTS)[number]),
  );
}

function tipLamports(ix: Instruction): bigint {
  const data = Buffer.from(ix.data ?? []);
  return data.readBigUInt64LE(4);
}

test("E2E: due obligation reaches ready and embeds the tip in the atomic sandwich", async () => {
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : `${outcome.stage}: ${outcome.reason}`);
  assert.equal(outcome.stage, "ready");
  if (!outcome.passed) return;

  // The tip is inside the REAL assembled instruction list (all four stages ran).
  const instructions = capturedInstructions.flat();
  const tip = findSenderTip(instructions);
  assert.ok(tip, "sender tip transfer missing from the assembled transaction");
  assert.equal(tipLamports(tip), outcome.sender?.tipLamports);

  // Flash borrow + liquidate program is present, and the swap backend resolved.
  assert.ok(instructions.some((ix) => String(ix.programAddress) === KLEND), "klend liquidation instructions missing");
  assert.ok(outcome.plan.swapSource?.startsWith("clmm-local/"), `unexpected swap source ${outcome.plan.swapSource}`);
  assert.equal(outcome.plan.repayReserveSymbol, "USDC");
  assert.equal(outcome.plan.withdrawReserveSymbol, "WSOL");
});

test("E2E: small prize routes to SWQOS-only; broadcast posts ?swqos_only=true and confirms", async () => {
  senderRequests.length = 0;
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true);
  if (!outcome.passed) return;
  assert.equal(outcome.sender?.tier, "swqos");

  const signature = await broadcastLiquidation({ outcome, dataRpc: rpc, dataRpcUrl: "http://data-rpc.test", sender: senderConfig(true) });
  assert.equal(signature, getSignatureFromTransaction(outcome.transaction));
  assert.equal(senderRequests.length, 1);
  const request = senderRequests[0]!;
  assert.ok(request.url.includes("swqos_only=true"), `expected swqos_only in ${request.url}`);
  assert.equal(request.body.method, "sendTransaction");
  const txOptions = request.body.params[1] as { skipPreflight?: boolean; maxRetries?: number };
  assert.equal(txOptions.skipPreflight, true);
  assert.equal(txOptions.maxRetries, 0);
  // The wire tx the executor handed to Sender is the signed transaction carrying the tip.
  const wire = request.body.params[0];
  assert.ok(typeof wire === "string" && wire.length > 0);
});

test("E2E: high prize routes to Sender Max bundle (Jito-routed, no swqos_only)", async () => {
  senderRequests.length = 0;
  const outcome = await runExecutor({ prizeUsd: 25 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : `${outcome.stage}: ${outcome.reason}`);
  if (!outcome.passed) return;
  assert.equal(outcome.sender?.tier, "max");
  assert.equal(outcome.sender?.bundle, true);
  assert.ok((outcome.sender?.tipLamports ?? 0n) > 1_000_000n, "Max tip should exceed the 0.001 SOL floor");

  const signature = await broadcastLiquidation({ outcome, dataRpc: rpc, dataRpcUrl: "http://data-rpc.test", sender: senderConfig(true) });
  assert.equal(signature, getSignatureFromTransaction(outcome.transaction));
  assert.equal(senderRequests.length, 1);
  const request = senderRequests[0]!;
  assert.ok(!request.url.includes("swqos_only"), "Max must not carry swqos_only");
  assert.equal(request.body.method, "sendBundle");
  assert.ok(Array.isArray(request.body.params[0]) && (request.body.params[0] as string[]).length === 1);
});

test("E2E: prize below the lane cost is refused before doing any work", async () => {
  const outcome = await runExecutor({ prizeUsd: 0.0001 });
  assert.equal(outcome.passed, false);
  if (outcome.passed) return;
  assert.equal(outcome.stage, "plan");
  assert.match(outcome.reason, /sender cost gate/);
  assert.equal(capturedInstructions.length, 0, "no transaction should be assembled when the prize cannot cover the cost");
});

test("E2E: post-simulation gate refuses when the measured profit no longer covers the lane", async () => {
  // Prize 10 clears the pre-build gate (tier Max), but the quoted worst case is
  // tuned down to ~$0.01 — the post-sim gate must refuse the fire.
  const previous = quoteOutAmount;
  quoteOutAmount = "11056";
  try {
    const outcome = await runExecutor({ prizeUsd: 10, minProfitUsd: 0 });
    assert.equal(outcome.passed, false);
    if (outcome.passed) return;
    assert.equal(outcome.stage, "simulate");
    assert.match(outcome.reason, /sender-max cost/);
  } finally {
    quoteOutAmount = previous;
  }
});

test("E2E: limited flash liquidity scales the loan instead of rejecting the signal", async (t) => {
  t.mock.method(repayReserve, "getLiquidityAvailableAmount", () => new Decimal(500));
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : outcome.reason);
  if (outcome.passed) assert.equal(outcome.plan.repayAmountBaseUnits, 500n);
});

test("E2E: Token-2022 liquidity still uses SPL Token for the cToken collateral account", async (t) => {
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  t.mock.method(withdrawReserve, "getLiquidityTokenProgram", () => address(token2022));
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : outcome.reason);
  const liquidate = capturedInstructions.flat().find(ix => Buffer.from(ix.data ?? []).subarray(0, 8).equals(Buffer.from([162,161,35,143,30,187,185,103])));
  assert.equal(liquidate?.accounts?.[16]?.address, TOKEN_PROGRAM);
  assert.equal(liquidate?.accounts?.[18]?.address, token2022);
});

test("E2E: same-mint liquidation requires no CLMM pool or swap instruction", async (t) => {
  t.mock.method(withdrawReserve, "getLiquidityMint", () => address(USDC_MINT));
  t.mock.method(withdrawReserve, "getMintDecimals", () => 6);
  t.mock.method(withdrawReserve, "getOracleMarketPrice", () => new Decimal(1));
  t.mock.method(obligation, "getBorrows", () => [{ reserveAddress: address(REPAY_RESERVE), marketValueRefreshed: new Decimal(1000), amount: new Decimal(1_000_000_000) }]);
  let quotes = 0;
  t.mock.method(ClmmLocalQuoter.prototype, "quoteExactIn", async () => { quotes++; throw new Error("same-mint must not quote"); });
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : outcome.reason);
  assert.equal(quotes, 0);
  if (outcome.passed) assert.equal(outcome.plan.swapSource, "same-mint");
  assert.ok(capturedInstructions.flat().every(ix => ix.programAddress !== CLMM_PROGRAM));
});

test("E2E: invalid slippage and zero collateral prices fail before quote or assembly", async (t) => {
  const invalid = await runExecutor({ prizeUsd: 1 }, { slippageBps: 10000 });
  assert.equal(invalid.passed, false);
  if (!invalid.passed) assert.match(invalid.reason, /slippage/);
  t.mock.method(withdrawReserve, "getOracleMarketPrice", () => new Decimal(0));
  const zero = await runExecutor({ prizeUsd: 1 });
  assert.equal(zero.passed, false);
  if (!zero.passed) assert.match(zero.reason, /collateral reserve price invalid/);
});

test("E2E: Scope refresh is included in every simulated liquidation, without a separate warmup", async (t) => {
  const { Scope } = await import("@kamino-finance/scope-sdk");
  const feed = address(pk(211)), scopeProgram = address(pk(212));
  const info = (withdrawReserve as any).state.config.tokenInfo;
  const previous = info.scopeConfiguration;
  info.scopeConfiguration = { priceFeed: feed, priceChain: [1,65535,65535,65535], twapChain: [65535,65535,65535,65535] };
  t.after(() => { info.scopeConfiguration = previous; });
  t.mock.method(Scope.prototype, "getAllConfigurations", async () => [[pk(213), { oraclePrices: feed }]]);
  t.mock.method(Scope.prototype, "refreshPriceListIx", async () => ({ programAddress: scopeProgram, accounts: [], data: new Uint8Array([42]) }));
  const outcome = await runExecutor({ prizeUsd: 1 });
  assert.equal(outcome.passed, true, outcome.passed ? "" : outcome.reason);
  assert.ok(capturedInstructions.length > 0);
  for (const instructions of capturedInstructions) {
    const refresh = instructions.findIndex(ix => ix.programAddress === scopeProgram);
    const borrow = instructions.findIndex(ix => Buffer.from(ix.data ?? []).subarray(0, 8).equals(Buffer.from([135,231,52,167,7,52,212,193])));
    assert.ok(refresh >= 0 && refresh < borrow, "Scope must run before the atomic flash loan");
  }
  assert.ok(!("warmupTransaction" in outcome));
});
