/**
 * RPC benchmark: current endpoint (mainnet.helius-rpc.com + key) vs the public
 * pump.helius-rpc.com. Measures per-method latency (median of N) for the exact
 * calls the bot makes, then probes rate-limit behavior on a burst, then checks
 * WS subscribe support (the realtime rail depends on programNotifications).
 */
const CURRENT = "https://mainnet.helius-rpc.com/?api-key=995b38c4-0098-48a4-be99-938e31eb1906";
const PUMP = "https://pump.helius-rpc.com";
const KLEND = "KaminoLendVUovr3ia8N5iV9F2t1v3eURhKo9q4uvhAsw";
const MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

const call = async (url: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message ?? j.error.code));
  return j.result;
};

const time = async <T>(fn: () => Promise<T>): Promise<number> => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? NaN;

async function benchEndpoint(name: string, url: string): Promise<void> {
  console.log(`\n=== ${name} — ${url.replace(/api-key=[^&]+/, "api-key=***")} ===`);
  // per-method latency (median of 7, first call warms DNS/TLS separately)
  try {
    await call(url, "getSlot"); // warm connection
  } catch (e) {
    console.log(`  BROKEN: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const methods: Array<[string, () => Promise<unknown>]> = [
    ["getSlot            ", () => call(url, "getSlot", [{ commitment: "confirmed" }])],
    ["getLatestBlockhash ", () => call(url, "getLatestBlockhash")],
    ["getBlockTime      ", async () => call(url, "getBlockTime", [await call(url, "getSlot", [{ commitment: "confirmed" }])])],
    ["getMultipleAccounts", () => call(url, "getMultipleAccounts", [[KLEND], { encoding: "base64" }])],
    ["GPA + dataSlice    ", () => call(url, "getProgramAccounts", [KLEND, {
      filters: [
        { dataSize: 3344 },
        { memcmp: { offset: 32, bytes: MARKET, encoding: "base58" } },
      ],
      encoding: "base64",
      dataSlice: { offset: 2208, length: 130 },
    }])],
  ];
  for (const [label, fn] of methods) {
    const xs: number[] = [];
    let err: string | null = null;
    for (let i = 0; i < 7; i++) {
      try {
        xs.push(await time(fn));
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (err) console.log(`  ${label} ✗ ${err.slice(0, 80)}`);
    else console.log(`  ${label} median ${median(xs).toFixed(0)}ms   p95 ${p95(xs).toFixed(0)}ms   (n=${xs.length})`);
  }
}

async function rateLimitProbe(name: string, url: string): Promise<void> {
  console.log(`\n--- ${name} rate-limit probe (20 rapid getSlot + 5 rapid GPA) ---`);
  let ok = 0; let throttled = 0; let err429 = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, () =>
      call(url, "getSlot").then(() => { ok++; }).catch((e) => {
        const m = e instanceof Error ? e.message : String(e);
        if (/429|too many|rate/i.test(m)) { throttled++; err429++; } else { throttled++; }
      }),
    ),
  );
  console.log(`  20× getSlot burst: ${ok} ok · ${throttled} throttled/err (in ${(performance.now() - t0).toFixed(0)}ms)`);
  let gpaOk = 0; let gpa429 = 0;
  const t1 = performance.now();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      call(url, "getProgramAccounts", [KLEND, {
        filters: [{ dataSize: 3344 }, { memcmp: { offset: 32, bytes: MARKET, encoding: "base58" } }],
        encoding: "base64",
        dataSlice: { offset: 2208, length: 130 },
      }]).then(() => { gpaOk++; }).catch((e) => {
        const m = e instanceof Error ? e.message : String(e);
        if (/429|too many|rate/i.test(m)) gpa429++;
      }),
    ),
  );
  console.log(`  5× GPA burst:      ${gpaOk} ok · ${gpa429} × 429 (in ${(performance.now() - t1).toFixed(0)}ms)`);
}

async function wsProbe(name: string, url: string): Promise<void> {
  console.log(`\n--- ${name} WebSocket probe (programSubscribe) ---`);
  const wsUrl = url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (msg: string) => { if (!settled) { settled = true; console.log(msg); resolve(); } };
    try {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => done(`  ✗ timeout (10s)`), 10_000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "programSubscribe", params: [KLEND, { encoding: "base64", filters: [{ dataSize: 3344 }] }] }));
      };
      ws.onmessage = (ev) => {
        try {
          const j = JSON.parse(String(ev.data));
          if (j.id === 1 && j.result !== undefined) {
            clearTimeout(timer);
            ws.close();
            done(`  ✓ subscribe ok (subscription ${j.result})`);
          }
        } catch { /* ignore */ }
      };
      ws.onerror = () => { clearTimeout(timer); done(`  ✗ connection error`); };
    } catch (e) {
      done(`  ✗ ${e instanceof Error ? e.message : e}`);
    }
  });
}

(async () => {
  await benchEndpoint("CURRENT (mainnet.helius-rpc.com + key)", CURRENT);
  await benchEndpoint("PUMP (pump.helius-rpc.com, public)", PUMP);
  await rateLimitProbe("CURRENT", CURRENT);
  await rateLimitProbe("PUMP", PUMP);
  await wsProbe("CURRENT", CURRENT);
  await wsProbe("PUMP", PUMP);
})();
