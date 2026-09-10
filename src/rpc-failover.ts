/**
 * Failover RPC — primary + fallback endpoint with automatic switching.
 *
 * The watcher ran on ONE Helius key until now; when its quota ran dry the
 * whole pipeline (scan, hot ticks, race fires) starved with 429 storms.
 * This transport wraps both endpoints:
 *
 *   - Normal traffic goes to the PRIMARY.
 *   - On a 429 / rate-limit / transport failure the transport FLIPS to the
 *     FALLBACK for a cooldown window (default 2 min), then probes the primary
 *     again on the next call — self-healing, zero operator action.
 *   - Both clients stay alive (their caches/pipes are per-endpoint); the
 *     transport just picks per request.
 *
 * Why proxy at the transport layer: every `rpcClient(url)` call site, the
 * screener's single-flight maps, the executor's race path — all keep working
 * unchanged; they never learn which endpoint actually served the request.
 */

import { createHttpTransport } from "@solana/rpc-transport-http";
import { createSolanaRpcFromTransport, type Rpc, type RpcTransport, type SolanaRpcApi } from "@solana/kit";

export interface FailoverOptions {
  /** Primary endpoint (with key). */
  primaryUrl: string;
  /** Fallback endpoint (no key / different provider). */
  fallbackUrl: string;
  /** How long the transport stays on the fallback after a primary failure. */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 120_000;

interface FailoverState {
  fallbackUntil: number;
  primaryFailures: number;
  fallbackFailures: number;
  lastFlipAt: number;
}

const states = new Map<string, FailoverState>();

function getState(key: string): FailoverState {
  const existing = states.get(key);
  if (existing) return existing;
  const fresh: FailoverState = { fallbackUntil: 0, primaryFailures: 0, fallbackFailures: 0, lastFlipAt: 0 };
  states.set(key, fresh);
  return fresh;
}

function isRateLimitFailure(statusCode: number | undefined, error: unknown): boolean {
  if (statusCode === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests/i.test(message);
}

/** Connection-level failures (DNS, refused, timeout) — the primary being DOWN,
 *  not busy. These also warrant a flip (a dead endpoint is worse than a
 *  throttled one). */
function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|UND_ERR|network/i.test(message + " " + causeMessage);
}

/** Server-side failures (HTTP 5xx) — the provider is broken, not busy.
 *  Observed live 2026-09-10: Helius returned 500s for 8 straight minutes and
 *  three full-scan cycles died while the (free) fallback sat idle. A provider
 *  outage is exactly what the fallback exists for — flip, and let the primary
 *  re-earn traffic after the cooldown. */
function isServerErrorFailure(statusCode: number | undefined, error: unknown): boolean {
  if (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600) return true;
  const context = (error as { context?: { statusCode?: unknown } } | null)?.context;
  if (context && typeof context.statusCode === "number" && context.statusCode >= 500 && context.statusCode < 600) return true;
  // kit's SolanaError #8100002 wraps HTTP status in the context; regex as a
  // last resort for message-embedded status codes.
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP error \(5\d\d\)/i.test(message);
}

/**
 * Creates a failover transport: `fetch`-level requests are dispatched to the
 * primary except during a cooldown window (post-failure) when they go to the
 * fallback. If BOTH fail, the primary's error is thrown (it is the one the
 * operator pays for and needs to see).
 */
export function createFailoverRpc(options: FailoverOptions): { rpc: Rpc<SolanaRpcApi>; state: () => FailoverState } {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const stateKey = options.primaryUrl;
  const state = getState(stateKey);

  const primaryTransport = createHttpTransport({ url: options.primaryUrl });
  const fallbackTransport = createHttpTransport({ url: options.fallbackUrl });

  // Wrap BOTH under one transport that selects per request. An RpcTransport is
  // callable with { payload, signal } and returns RpcResponse<TResponse>; the
  // generic is threaded through so kit's RpcFromTransport type-checks.
  const selectingTransport = (<TResponse>(config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    const onFallback = Date.now() < state.fallbackUntil;
    const chosen = onFallback ? fallbackTransport : primaryTransport;
    const chosenIsPrimary = !onFallback;
    return (chosenIsPrimary ? primaryTransport(config) : fallbackTransport(config))
      .then((result: unknown) => {
        if (chosenIsPrimary) state.primaryFailures = 0;
        else state.fallbackFailures = 0;
        return result as TResponse;
      })
      .catch(async (error: unknown) => {
        const statusCode = (error as { context?: { statusCode?: number } } | null)?.context?.statusCode;
        const shouldFlip = isRateLimitFailure(statusCode, error) || isConnectionFailure(error) || isServerErrorFailure(statusCode, error);
        if (!shouldFlip) throw error;
        if (!chosenIsPrimary) {
          state.fallbackFailures += 1;
          throw error;
        }
        // Primary throttled or unreachable: flip to the fallback for the
        // cooldown window and retry the SAME request there — the caller never
        // sees the failure.
        state.fallbackUntil = Date.now() + cooldownMs;
        state.primaryFailures += 1;
        state.lastFlipAt = Date.now();
        return fallbackTransport(config) as unknown as Promise<TResponse>;
      });
  }) as RpcTransport;

  const rpc = createSolanaRpcFromTransport(selectingTransport);
  return { rpc, state: () => ({ ...state }) };
}

/** Reads the failover endpoint order for logs/health output. */
export function failoverHealth(options: FailoverOptions): { onFallback: boolean; cooldownRemainingMs: number } {
  const state = getState(options.primaryUrl);
  const remaining = Math.max(0, state.fallbackUntil - Date.now());
  return { onFallback: remaining > 0, cooldownRemainingMs: remaining };
}

// Re-export for call sites that only need a plain (non-failover) client.
export { createSolanaRpc } from "@solana/kit";
