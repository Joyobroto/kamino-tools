import { Buffer } from "node:buffer";
import { PROGRAM_ID as KLEND_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { address, createSolanaRpcSubscriptions, type Address, type Base58EncodedBytes } from "@solana/kit";
import { parseObligationSlice } from "./screener.js";

const OBLIGATION_ACCOUNT_SIZE = 3344n;
const MARKET_OFFSET_OFFSET = 32n;
const SLICE_OFFSET = 2208;
const SLICE_LENGTH = 130;

export interface WsObligationSlice {
  pubkey: Address;
  debtSf: bigint;
  unhealthySf: bigint;
  adlTargetLtvPct: number;
  adlMarginCallTs: number;
  /** Cached health factor (unhealthy/debt) from the notification. */
  cachedHealth: number;
}

/**
 * Parses the full 3344-byte obligation account (as delivered by program
 * notifications) into the same health slice the GPA snapshot uses.
 */
export function parseFullObligationAccount(dataBase64: string, pubkey: Address): WsObligationSlice {
  const full = Buffer.from(dataBase64, "base64");
  if (full.length !== Number(OBLIGATION_ACCOUNT_SIZE)) {
    throw new Error(`Unexpected obligation account length ${full.length}`);
  }
  const slice = full.subarray(SLICE_OFFSET, SLICE_OFFSET + SLICE_LENGTH).toString("base64");
  const parsed = parseObligationSlice(slice);
  return { pubkey, ...parsed, cachedHealth: healthFactorFromParsed(parsed) };
}

export function healthFactorFromParsed(parsed: { debtSf: bigint; unhealthySf: bigint }): number {
  if (parsed.debtSf <= 0n) return Number.POSITIVE_INFINITY;
  return Number(parsed.unhealthySf) / Number(parsed.debtSf);
}

export interface LiquidationWsOptions {
  wsUrl: string;
  marketAddress: string;
  programId?: Address;
  /** Called for every obligation account change delivered over WSS. */
  onSlice: (slice: WsObligationSlice) => void;
  /** Called when the WSS subscription is (re)established. */
  onReady?: () => void;
  /** Called on subscribe errors or unexpected stream errors. */
  onError?: (error: unknown) => void;
}

export interface LiquidationWsHandle {
  abort: () => void;
  ready: Promise<void>;
}

/**
 * Real-time obligation change stream via Solana program notifications
 * (~1 slot ≈ 400ms latency vs the 60s polling scan). Delivers only DELTAS:
 * the initial state still comes from the GPA snapshot (see screener.ts).
 * Auto-reconnects on stream failure with backoff.
 */
export async function subscribeLiquidationSlices(options: LiquidationWsOptions): Promise<LiquidationWsHandle> {
  const { wsUrl, marketAddress, onSlice } = options;
  const programId = options.programId ?? address(KLEND_PROGRAM_ID.toString());

  const abortController = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const run = async (): Promise<void> => {
    let delayMs = 1_000;
    let first = true;
    while (!abortController.signal.aborted) {
      const subscriptions = createSolanaRpcSubscriptions(wsUrl);
      try {
        const iterable = await subscriptions
          .programNotifications(programId, {
            commitment: "confirmed",
            encoding: "base64",
            filters: [
              { dataSize: OBLIGATION_ACCOUNT_SIZE },
              { memcmp: { offset: MARKET_OFFSET_OFFSET, bytes: marketAddress as unknown as Base58EncodedBytes, encoding: "base58" } },
            ],
          })
          .subscribe({ abortSignal: abortController.signal });
        if (first) {
          options.onReady?.();
          resolveReady();
          first = false;
        }
        delayMs = 1_000;
        for await (const notification of iterable) {
          const value = (notification as unknown as {
            value?: { pubkey?: string; account?: { data?: [string, string] } };
          }).value;
          if (!value?.pubkey || !value.account?.data?.[0]) continue;
          try {
            onSlice(parseFullObligationAccount(value.account.data[0], address(value.pubkey)));
          } catch {
            // malformed account — ignore (error isolation, never crash the stream)
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) break;
        options.onError?.(error);
        if (first) {
          rejectReady(error);
          first = false;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 15_000);
      }
    }
  };

  void run();

  return {
    abort: () => abortController.abort(),
    ready,
  };
}