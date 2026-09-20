import { confirmTransactionSignature } from "../../transaction.js";
/**
 * Helius Sender — execution-only transaction submission lane.
 *
 * Docs: https://www.helius.dev/docs/sending-transactions/sender
 *
 * Sender is a credit-free, tip-based submission service with two tiers:
 *
 *   - SWQOS-only : single stake-weighted path, min tip 0.000005 SOL
 *                  (`?swqos_only=true`). Cost-optimized.
 *   - Sender Max : all high-speed pathways + priority tip buffer, min tip
 *                  0.001 SOL. Fastest landing — for contested fires.
 *
 * Both tiers REQUIRE a SOL tip transfer to a designated tip account AND a
 * compute-unit price instruction. Sender does NOT consume API credits and is
 * only used to BROADCAST — blockhash, oracle, screen, and confirmation keep
 * flowing through the existing data RPC (`SOLANA_RPC_URL`).
 *
 * The lane is picked by EXPECTED PRIZE: dust/small prizes take the cheap
 * SWQOS path; high-prize fires pay for the multi-path Max lane. Every lane
 * cost (tip + priority fee + base fee) is estimated in USD and compared
 * against the worst-case profit; if the prize does not cover the lane the
 * caller refuses to execute.
 */

import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  getBase64EncodedWireTransaction,
  type Instruction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

/** Designated mainnet-beta Sender tip accounts (docs: Requirements). */
export const SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

/** SWQOS-only minimum tip (0.000005 SOL). */
export const SWQOS_MIN_TIP_LAMPORTS = 5_000n;
/** Sender Max minimum tip (0.001 SOL) — enters the priority tip buffer. */
export const SENDER_MAX_MIN_TIP_LAMPORTS = 1_000_000n;
/** Sender Max minimum priority fee (5,000 lamports); 10k recommended. */
export const SENDER_MAX_MIN_PRIORITY_LAMPORTS = 5_000n;
export const SENDER_MAX_RECOMMENDED_PRIORITY_LAMPORTS = 10_000n;
/** SWQOS accepts any CU-price instruction; we still send a tiny priority fee. */
export const SWQOS_MIN_PRIORITY_LAMPORTS = 5_000n;
/** Base network fee for a single-signature transaction. */
export const BASE_FEE_LAMPORTS = 5_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;
/** Fallback SOL/USD when the market has no usable WSOL oracle. */
export const FALLBACK_SOL_USD = 150;

export type SenderTier = "swqos" | "max";

export interface SenderConfig {
  enabled: boolean;
  /** Regional/gobal Sender base endpoint, e.g. http://ewr-sender.helius-rpc.com/fast */
  endpoint: string;
  /** Prize (worst-case profit USD) at/above which Sender Max is used. */
  maxPrizeUsd: number;
  /** Hard cap on the tip as a fraction of the prize (never burn the reward). */
  maxTipFraction: number;
  /** Absolute tip cap per fire, SOL. */
  maxTipCapSol: number;
  /** Required worst-case net profit AFTER lane cost, USD. */
  minProfitUsd: number;
  /** Submit Sender Max fires as an atomic bundle (Jito + all pathways). */
  bundle: boolean;
}

export interface SenderLane {
  tier: SenderTier;
  /** Max-tier fires are submitted as an atomic bundle (Jito routed). */
  bundle: boolean;
  tipLamports: bigint;
  tipUsd: number;
  priorityFeeLamports: bigint;
  priorityFeeUsd: number;
  estimatedCostUsd: number;
  microlamportsPerCu: number;
}

/**
 * Competitive tip ladder, mirroring the FASTLANE prize ladder: higher prize →
 * higher tip, always bounded by `maxTipFraction` of the prize and `maxTipCapSol`.
 * These are Sender tips (SOL transfers), so the priority fee stays at the
 * Sender minimum and the whole bid lives in the tip buffer.
 */
export const SENDER_TIP_LADDER: Array<{ minPrizeUsd: number; tipUsd: number; label: string }> = [
  { minPrizeUsd: 500, tipUsd: 6.0, label: "max-kill-shot" },
  { minPrizeUsd: 100, tipUsd: 1.8, label: "max-hot" },
  { minPrizeUsd: 25, tipUsd: 0.6, label: "max-fast" },
  { minPrizeUsd: 5, tipUsd: 0.2, label: "max-quick" },
  { minPrizeUsd: 0, tipUsd: 0, label: "swqos-base" },
];

export function lamportsToUsd(lamports: bigint, solUsd: number): number {
  return (Number(lamports) / LAMPORTS_PER_SOL) * solUsd;
}

/**
 * CU price (micro-lamports) that yields `priorityFeeLamports` at the REQUESTED
 * CU limit. Priority fees are charged on the requested limit, so the price must
 * be recomputed whenever the executor pins a smaller CU limit — otherwise a
 * re-sim CU pin silently drops the fee below Sender's minimum and the tx is
 * rejected.
 */
export function priorityMicrolamports(priorityFeeLamports: bigint, computeUnitLimit: number): number {
  return Math.max(1, Math.ceil((Number(priorityFeeLamports) * 1_000_000) / Math.max(1, Math.floor(computeUnitLimit))));
}

/** Reads the Sender execution config from the environment. */
export function senderConfigFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<SenderConfig> = {}): SenderConfig {
  const endpoint = (overrides.endpoint ?? env.HELIUS_SENDER_ENDPOINT ?? env.LIQ_SENDER_ENDPOINT ?? "").trim();
  const configuredEnabled = env.LIQ_SENDER_ENABLED ?? env.HELIUS_SENDER_ENABLED;
  const enabled = overrides.enabled ?? (configuredEnabled ? /^(1|true|yes|on)$/i.test(configuredEnabled.trim()) : Boolean(endpoint));
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    enabled: enabled && endpoint.length > 0,
    endpoint,
    maxPrizeUsd: overrides.maxPrizeUsd ?? number(env.LIQ_SENDER_MAX_PRIZE_USD, 5),
    maxTipFraction: overrides.maxTipFraction ?? number(env.LIQ_SENDER_MAX_TIP_FRACTION, 0.01),
    maxTipCapSol: overrides.maxTipCapSol ?? number(env.LIQ_SENDER_MAX_TIP_CAP_SOL, 0.02),
    minProfitUsd: overrides.minProfitUsd ?? number(env.LIQ_SENDER_MIN_PROFIT_USD, 0.05),
    bundle: overrides.bundle ?? (env.LIQ_SENDER_BUNDLE ? /^(1|true|yes|on)$/i.test(env.LIQ_SENDER_BUNDLE.trim()) : true),
  };
}

/**
 * Pick the cheapest lane that still leaves `minProfitUsd` of worst-case profit
 * after the lane's tip, priority fee, and base fee.
 *
 * - High prize (≥ `maxPrizeUsd`) uses Sender Max when affordable.
 * - Everything else uses SWQOS-only.
 * - Returns null when even SWQOS costs more than the prize less the floor —
 *   the caller must NOT execute.
 */
export function chooseSenderLane(input: {
  prizeUsd: number;
  solUsd: number;
  computeUnitLimit: number;
  config: Pick<SenderConfig, "maxPrizeUsd" | "maxTipFraction" | "maxTipCapSol" | "minProfitUsd" | "bundle">;
}): SenderLane | null {
  const solUsd = input.solUsd > 0 ? input.solUsd : FALLBACK_SOL_USD;
  const prize = Number.isFinite(input.prizeUsd) ? Math.max(0, input.prizeUsd) : 0;
  const cuLimit = Math.max(1, Math.floor(input.computeUnitLimit));

  const costFor = (tipLamports: bigint, priorityLamports: bigint): {
    cost: number;
    priorityUsd: number;
    tipUsd: number;
    micro: number;
  } => {
    const total = BASE_FEE_LAMPORTS + priorityLamports + tipLamports;
    const priorityUsd = lamportsToUsd(priorityLamports, solUsd);
    return {
      cost: lamportsToUsd(total, solUsd),
      priorityUsd,
      tipUsd: lamportsToUsd(tipLamports, solUsd),
      // Priority fees are charged on the REQUESTED CU limit, not consumed units.
      micro: priorityMicrolamports(priorityLamports, cuLimit),
    };
  };

  const swqos = costFor(SWQOS_MIN_TIP_LAMPORTS, SWQOS_MIN_PRIORITY_LAMPORTS);

  if (prize >= input.config.maxPrizeUsd) {
    const ladder = SENDER_TIP_LADDER.find((bucket) => prize >= bucket.minPrizeUsd) ?? SENDER_TIP_LADDER[SENDER_TIP_LADDER.length - 1]!;
    const fractionCapSol = (prize * input.config.maxTipFraction) / solUsd;
    const ladderCapSol = ladder.tipUsd / solUsd;
    const targetSol = Math.min(
      input.config.maxTipCapSol,
      Math.max(Number(SENDER_MAX_MIN_TIP_LAMPORTS) / LAMPORTS_PER_SOL, Math.min(ladderCapSol, fractionCapSol)),
    );
    if (targetSol * LAMPORTS_PER_SOL >= Number(SENDER_MAX_MIN_TIP_LAMPORTS)) {
      const tipLamports = BigInt(Math.round(targetSol * LAMPORTS_PER_SOL));
      const lane = costFor(tipLamports, SENDER_MAX_RECOMMENDED_PRIORITY_LAMPORTS);
      if (prize - lane.cost >= input.config.minProfitUsd) {
        return {
          tier: "max",
          // Max fires ride an atomic Sender bundle (routed through Jito and all
          // other pathways): the tip sits inside the bundle, so a failed
          // simulation/execution reverts it — nothing is charged for a miss.
          bundle: input.config.bundle,
          tipLamports,
          tipUsd: lane.tipUsd,
          priorityFeeLamports: SENDER_MAX_RECOMMENDED_PRIORITY_LAMPORTS,
          priorityFeeUsd: lane.priorityUsd,
          estimatedCostUsd: lane.cost,
          microlamportsPerCu: lane.micro,
        };
      }
    }
  }

  if (prize - swqos.cost >= input.config.minProfitUsd) {
    return {
      tier: "swqos",
      bundle: false,
      tipLamports: SWQOS_MIN_TIP_LAMPORTS,
      tipUsd: swqos.tipUsd,
      priorityFeeLamports: SWQOS_MIN_PRIORITY_LAMPORTS,
      priorityFeeUsd: swqos.priorityUsd,
      estimatedCostUsd: swqos.cost,
      microlamportsPerCu: swqos.micro,
    };
  }
  return null;
}

/** Builds the Sender tip transfer (SystemProgram.transfer → designated tip account). */
export function buildSenderTipInstruction(input: {
  signer: TransactionSigner;
  lamports: bigint;
  tipAccountIndex?: number;
}): Instruction {
  const index = ((input.tipAccountIndex ?? Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)) % SENDER_TIP_ACCOUNTS.length + SENDER_TIP_ACCOUNTS.length) % SENDER_TIP_ACCOUNTS.length;
  const destination = address(SENDER_TIP_ACCOUNTS[index]!);
  return getTransferSolInstruction({
    source: input.signer,
    destination,
    amount: input.lamports,
  });
}

/** Applies the `?swqos_only=true` tier selector to a Sender endpoint. */
export function senderEndpointForTier(endpoint: string, tier: SenderTier): string {
  try {
    const url = new URL(endpoint);
    if (tier === "swqos") url.searchParams.set("swqos_only", "true");
    else url.searchParams.delete("swqos_only");
    return url.toString();
  } catch {
    const separator = endpoint.includes("?") ? "&" : "?";
    return tier === "swqos" ? `${endpoint}${separator}swqos_only=true` : endpoint;
  }
}

/**
 * Broadcast a signed transaction through Helius Sender. The JSON-RPC response
 * result is the transaction signature; confirmation is polled on the EXISTING
 * data RPC (Sender is submission-only). Throws on rejection so the caller can
 * fall back to a direct RPC send.
 */
export async function sendViaSender(input: {
  endpoint: string;
  tier: SenderTier;
  transaction: { wireTransaction: string };
  signal?: AbortSignal;
}): Promise<Signature> {
  const url = senderEndpointForTier(input.endpoint, input.tier);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [
        input.transaction.wireTransaction,
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ],
    }),
    signal: input.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Sender HTTP ${response.status}`);
  const json = (await response.json()) as { result?: string; error?: { code?: number; message?: string } };
  if (json.error) throw new Error(`Sender rejected (${json.error.code ?? "?"}): ${json.error.message ?? "unknown error"}`);
  if (!json.result) throw new Error("Sender returned no signature");
  return json.result as Signature;
}

/**
 * Submit an atomic Sender Max bundle (routed across Jito + every pathway). One
 * transaction must carry the Sender tip and every transaction needs priority
 * fee — both are already baked into the liquidation tx. Bundles are
 * all-or-nothing: if simulation/execution fails the whole bundle is dropped and
 * the tip transfer reverts, so a miss costs nothing.
 */
export async function sendViaSenderBundle(input: {
  endpoint: string;
  transactions: string[];
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.transactions.length || input.transactions.length > 5) throw new Error("Sender bundle needs 1–5 transactions");
  const url = senderEndpointForTier(input.endpoint, "max");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendBundle",
      params: [input.transactions, { encoding: "base64" }],
    }),
    signal: input.signal ?? AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Sender bundle HTTP ${response.status}`);
  const json = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (json.error) throw new Error(`Sender bundle rejected (${json.error.code ?? "?"}): ${json.error.message ?? "unknown error"}`);
  if (!json.result) throw new Error("Sender bundle returned no result");
}

/** Keeps the Sender HTTP connection warm during idle periods (>5s between fires). */export async function warmSenderConnection(endpoint: string, signal?: AbortSignal): Promise<void> {
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/fast$/, "/ping");
    if (url.pathname === "/") url.pathname = "/ping";
    await fetch(url.toString(), { method: "GET", signal: signal ?? AbortSignal.timeout(2_000) });
  } catch {
    // warming is best-effort
  }
}

/** Extracts the base64 wire transaction for the Sender JSON-RPC payload. */
export function wireTransaction(transaction: Parameters<typeof getBase64EncodedWireTransaction>[0]): string {
  return getBase64EncodedWireTransaction(transaction);
}

/** Polls the data RPC until the Sender-submitted signature confirms. */
export async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  timeoutMs = 60_000,
): Promise<void> {
  return confirmTransactionSignature(rpc, signature, timeoutMs);
}
