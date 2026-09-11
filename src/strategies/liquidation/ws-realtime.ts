import { Buffer } from "node:buffer";
import { PROGRAM_ID as KLEND_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { address, createSolanaRpcSubscriptions, type Address, type Base58EncodedBytes } from "@solana/kit";
import { parseObligationSlice } from "./screener.js";

const OBLIGATION_ACCOUNT_SIZE = 3344n;
const MARKET_OFFSET_OFFSET = 32n;
const SLICE_OFFSET = 2208;
const SLICE_LENGTH = 130;
/** Liveness check cadence + soft-resync window for the deltas rail. */
const LIVENESS_CHECK_MS = 20_000;
const LIVENESS_RESYNC_MS = 15 * 60_000;
const RECONNECT_MAX_MS = 15_000;

export interface WsObligationSlice {
  pubkey: Address;
  debtSf: bigint;
  unhealthySf: bigint;
  adlTargetLtvPct: number;
  adlMarginCallTs: number;
  /** Cached health factor (unhealthy/debt) from the notification. */
  cachedHealth: number;
  /** Preserve the already-delivered account for execution; no second account RPC. */
  accountData?: Buffer;
  slot?: bigint;
  receivedAt?: number;
}

/**
 * Parses the full 3344-byte obligation account (as delivered by program
 * notifications) into the same health slice the GPA snapshot uses.
 */
export function parseFullObligationAccount(dataBase64: string, pubkey: Address, slot?: bigint): WsObligationSlice {
  const full = Buffer.from(dataBase64, "base64");
  if (full.length !== Number(OBLIGATION_ACCOUNT_SIZE)) {
    throw new Error(`Unexpected obligation account length ${full.length}`);
  }
  const slice = full.subarray(SLICE_OFFSET, SLICE_OFFSET + SLICE_LENGTH).toString("base64");
  const parsed = parseObligationSlice(slice);
  return { pubkey, ...parsed, cachedHealth: healthFactorFromParsed(parsed), accountData: full, receivedAt: Date.now(), ...(slot !== undefined ? { slot } : {}) };
}

export function healthFactorFromParsed(parsed: { debtSf: bigint; unhealthySf: bigint }): number {
  if (parsed.debtSf <= 0n) return Number.POSITIVE_INFINITY;
  return Number(parsed.unhealthySf) / Number(parsed.debtSf);
}

export interface LiquidationWsOptions {
  wsUrl: string;
  /** Optional rotation list. On every (re)connect attempt the rail advances to
   *  the next candidate, giving automatic provider fallback (primary Helius →
   *  fallback RPC wss → Solana public wss). wsUrl is always the first. */
  wsCandidates?: string[];
  marketAddress: string;
  programId?: Address;
  /** Called for every obligation account change delivered over WSS. */
  onSlice: (slice: WsObligationSlice) => void;
  /** Called when the WSS subscription is (re)established with the active endpoint. */
  onReady?: (activeEndpoint: string) => void;
  /** Called on subscribe errors or unexpected stream errors. */
  onError?: (error: unknown) => void;
}

export interface LiquidationWsHandle {
  abort: () => void;
  ready: Promise<void>;
  /** The endpoint currently serving the (re)established stream. */
  activeEndpoint: () => string;
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
  const candidates = [...new Set([wsUrl, ...(options.wsCandidates ?? [])])];

  const abortController = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Monotonic attempt counter drives the round-robin: after a drop the next try
  // lands on the NEXT provider, so a dead primary falls through to the fallbacks
  // by itself and a healthy stream stays put until IT drops.
  let attempt = 0;
  let activeEndpoint = wsUrl;

  const run = async (): Promise<void> => {
    let delayMs = 1_000;
    let readySettled = false;
    while (!abortController.signal.aborted) {
      const endpoint = candidates[attempt % candidates.length]!;
      attempt += 1;
      // Per-iteration abort (NOT the shared handle abort): lets us teardown a
      // single stream instance without killing the whole rail.
      const iterationControl = new AbortController();
      const subscriptions = createSolanaRpcSubscriptions(endpoint);
      let wantResync = false;
      let lastSyncAt = Date.now();
      // Provider-agnostic liveness: a WS that stays connected but silently stops
      // forwarding (Helius edges have done this) never throws, so the reconnect
      // loop never fires and the live flag goes stale. Slot/ping methods differ
      // across RPCs, so we SOFT-RESYNC on a timer instead: re-establish the whole
      // stream periodically unless it proved alive in the window. One reconnect
      // per rotation is microseconds of duty — and it keeps the heartbeat honest
      // AND catches a dead-but-open socket within that bound.
      const livenessTimer = setInterval(() => {
        if (abortController.signal.aborted || iterationControl.signal.aborted) {
          clearInterval(livenessTimer);
          return;
        }
        if (Date.now() - lastSyncAt > LIVENESS_RESYNC_MS) {
          wantResync = true;
          options.onError?.(new Error(`ws liveness: no activity in ${(LIVENESS_RESYNC_MS / 1000)}s — soft reconnect`));
          iterationControl.abort();
        }
      }, LIVENESS_CHECK_MS);
      try {
        // Combined signal: per-iteration teardown (liveness/watchdog) AND the
        // shared handle.abort() both end this stream.
        const streamSignal = AbortSignal.any([abortController.signal, iterationControl.signal]);
        const iterable = await subscriptions
          .programNotifications(programId, {
            // This is a trigger rail only. The executor refreshes the account and
            // simulates the transaction before sending, so processed delivery
            // removes a confirmation delay without trusting stale WS state.
            commitment: "processed",
            encoding: "base64",
            filters: [
              { dataSize: OBLIGATION_ACCOUNT_SIZE },
              { memcmp: { offset: MARKET_OFFSET_OFFSET, bytes: marketAddress as unknown as Base58EncodedBytes, encoding: "base58" } },
            ],
          })
          .subscribe({ abortSignal: streamSignal });
        lastSyncAt = Date.now();
        activeEndpoint = endpoint;
        // onReady on EVERY (re)establishment — a rail that recovered must flip
        // back to "live", otherwise the heartbeat keeps reporting a stale DOWN.
        options.onReady?.(endpoint);
        // Ready promise settles on the FIRST successful connect ever; it only
        // rejects once every candidate failed a full round (real outage), not on
        // a transient primary failure that a fallback immediately replaces.
        if (!readySettled) {
          resolveReady();
          readySettled = true;
        }
        delayMs = 1_000;
        for await (const notification of iterable) {
          lastSyncAt = Date.now();
          const envelope = notification as unknown as {
            context?: { slot?: bigint };
            value?: { pubkey?: string; account?: { data?: [string, string] } };
          };
          const value = envelope.value;
          if (!value?.pubkey || !value.account?.data?.[0]) continue;
          try {
            onSlice(parseFullObligationAccount(value.account.data[0], address(value.pubkey), envelope.context?.slot));
          } catch {
            // malformed account — ignore (error isolation, never crash the stream)
          }
        }
        if (abortController.signal.aborted) {
          clearInterval(livenessTimer);
          break;
        }
        // Stream ended without an error (upstream closed it quietly) — treat as a
        // drop and let the catch below run a bounded reconnect, never a tight loop.
        throw new Error("program notification stream ended");
      } catch (error) {
        if (abortController.signal.aborted) {
          clearInterval(livenessTimer);
          break;
        }
        options.onError?.(error);
        // Ready rejects only after a FULL round of candidates failed to connect —
        // a transient primary drop that a fallback replaces must NOT reject it.
        if (!readySettled && attempt >= candidates.length) {
          rejectReady(error);
          readySettled = true;
        }
        clearInterval(livenessTimer);
        if (wantResync) {
          // Soft resync: reconnect immediately (success path resets delayMs).
          delayMs = 0;
          wantResync = false;
        } else {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
        }
      }
      iterationControl.abort();
    }
  };

  void run();

  return {
    abort: () => abortController.abort(),
    ready,
    activeEndpoint: () => activeEndpoint,
  };
}
