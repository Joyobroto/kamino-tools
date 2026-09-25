import { address, createSolanaRpcSubscriptions, type Address } from "@solana/kit";
import { withTimeout } from "../../timeout.js";
import { parseFullObligationAccount, type WsObligationSlice } from "./ws-realtime.js";

type Notification = { context?: { slot?: bigint }; value?: { data?: readonly [string, string]; lamports?: bigint } };
type Subscribe = (endpoint: string, account: Address, signal: AbortSignal) => Promise<AsyncIterable<Notification>>;
interface Entry { account: Address; control: AbortController; running: boolean; live: boolean; slot?: bigint; data?: string }
export interface TrackedWsOptions {
  wsUrl: string;
  wsCandidates?: string[];
  onSlice: (slice: WsObligationSlice) => void;
  onReady?: (endpoint: string) => void;
  /** `endpoint` is the candidate the failure happened ON — it is what the sticky rotation below
   *  moves off, so callers collapsing concurrent failures need it to name the dead rail. */
  onError?: (error: unknown, endpoint: string) => void;
  /** A gap, removal or close invalidates cached account bytes. */
  onInvalidate?: (account: Address) => void;
  subscribe?: Subscribe;
  startIntervalMs?: number;
  retryMs?: number;
}

/** Diff subscriptions instead of streaming every account in the lending market.
 * Quiet accounts are normal: transport ping/pong owns socket liveness; silence
 * must not cause periodic subscription churn. HTTP reconciliation remains bounded.
 */
export function subscribeTrackedObligations(options: TrackedWsOptions) {
  const candidates = [...new Set([options.wsUrl, ...(options.wsCandidates ?? [])])];
  const clients = new Map<string, ReturnType<typeof createSolanaRpcSubscriptions>>();
  const subscribe: Subscribe = options.subscribe ?? (async (endpoint, account, signal) => {
    let client = clients.get(endpoint);
    if (!client) { client = createSolanaRpcSubscriptions(endpoint); clients.set(endpoint, client); }
    return client.accountNotifications(account, { commitment: "processed", encoding: "base64" }).subscribe({ abortSignal: signal }) as Promise<AsyncIterable<Notification>>;
  });
  const entries = new Map<string, Entry>();
  let stopped = false;
  let preferred = 0;
  let endpoint = options.wsUrl;
  let received = 0, bytes = 0, duplicates = 0, reconnects = 0, subscribed = 0, removed = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const isCurrent = (entry: Entry) => !stopped && entries.get(entry.account) === entry && !entry.control.signal.aborted;
  const invalidate = (entry: Entry) => { entry.live = false; delete entry.slot; delete entry.data; options.onInvalidate?.(entry.account); };
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
  });
  const run = async (entry: Entry) => {
    let retry = options.retryMs ?? 1_000;
    while (isCurrent(entry)) {
      const index = preferred;
      const activeEndpoint = candidates[index]!;
      const attempt = new AbortController();
      try {
        const stream = await withTimeout(signal => subscribe(activeEndpoint, entry.account,
          AbortSignal.any([signal, entry.control.signal, attempt.signal])), 10_000, "account subscription");
        if (!isCurrent(entry)) break;
        entry.live = true;
        endpoint = activeEndpoint;
        subscribed++;
        resolveReady();
        options.onReady?.(activeEndpoint);
        retry = options.retryMs ?? 1_000;
        for await (const notification of stream) {
          if (!isCurrent(entry)) break;
          received++;
          const encoded = notification.value?.data?.[0];
          if (!encoded || notification.value?.lamports === 0n) { invalidate(entry); continue; }
          bytes += encoded.length; // base64 payload bytes, excludes JSON overhead
          const slot = notification.context?.slot;
          if (entry.slot !== undefined && (slot === undefined || slot < entry.slot)) { duplicates++; continue; }
          if (entry.data === encoded) { if (slot !== undefined) entry.slot = slot; duplicates++; continue; }
          try {
            const slice = parseFullObligationAccount(encoded, entry.account, slot);
            entry.data = encoded;
            if (slot !== undefined) entry.slot = slot;
            entry.live = true;
            options.onSlice(slice);
          } catch { invalidate(entry); }
        }
        if (isCurrent(entry)) throw new Error("obligation account stream ended");
      } catch (error) {
        if (!isCurrent(entry)) break;
        invalidate(entry);
        reconnects++;
        // All accounts on a failed provider share one sticky fallback choice.
        // A flurry of failures must not rotate straight back to the bad endpoint.
        if (preferred === index) preferred = (index + 1) % candidates.length;
        options.onError?.(error, activeEndpoint);
        attempt.abort();
        await wait(retry, entry.control.signal);
        retry = Math.min(retry * 2, 15_000);
      } finally { attempt.abort(); }
    }
  };
  // Pace initial additions. Existing streams survive set changes unchanged.
  const timer = setInterval(() => {
    const next = [...entries.values()].find(entry => !entry.running);
    if (next) { next.running = true; void run(next).catch(error => options.onError?.(error, endpoint)); }
  }, options.startIntervalMs ?? 100);
  return {
    ready,
    setAccounts(accounts: readonly string[]) {
      if (stopped) return;
      const desired = new Set(accounts);
      for (const [key, entry] of entries) if (!desired.has(key)) {
        entries.delete(key); entry.control.abort(); invalidate(entry); removed++;
      }
      for (const key of desired) if (!entries.has(key)) {
        entries.set(key, { account: address(key), control: new AbortController(), running: false, live: false });
      }
    },
    isSubscribed(account: string) { return entries.get(account)?.live === true; },
    activeEndpoint: () => endpoint,
    stats: () => ({ desired: entries.size, active: [...entries.values()].filter(e => e.live).length, received, payloadBytes: bytes, duplicates, reconnects, subscribed, removed }),
    abort() {
      stopped = true; clearInterval(timer);
      for (const entry of entries.values()) { entry.control.abort(); invalidate(entry); }
      entries.clear(); resolveReady();
    },
  };
}
export type TrackedWsHandle = ReturnType<typeof subscribeTrackedObligations>;
