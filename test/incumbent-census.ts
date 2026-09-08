import { config as loadEnv } from "dotenv";
loadEnv();

const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const SCOPE_V1_DISC = "53bacf83cbfec682"; // old refresh_price_list
const SCOPE_V2_DISC = "d807fa2e015c1bba"; // unknown/new refresh (LionX path)

interface IncumbentStat {
  payer: string;
  txs: number;
  usedScopeV2: number;
  usedScopeV1: number;
  noScopeRefresh: number;
  wrapperPrograms: Set<string>;
  liquidatedReserves: Set<string>;
  sampleSig: string;
}

async function fetchJson(url: string, body: unknown): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    return res.json();
  }
  throw new Error(`RPC fetch failed after retries: ${JSON.stringify(body).slice(0, 80)}`);
}

async function main(): Promise<void> {
  const rpc = process.env.SOLANA_RPC_URL!;
  const limit = Number(process.argv[2] ?? "600");
  let before: string | undefined;
  const stats = new Map<string, IncumbentStat>();
  let scanned = 0;
  let liquidations = 0;

  // page through signatures
  for (let page = 0; page < Math.ceil(limit / 100); page++) {
    const params: unknown[] = [KLEND, { limit: 100, ...(before ? { before } : {}) }];
    const { result: sigs } = await fetchJson(rpc, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params });
    if (!sigs?.length) break;
    before = sigs[sigs.length - 1].signature;
    for (const sig of sigs) {
      scanned++;
      if (sig.err) continue;
      await new Promise((r) => setTimeout(r, 120)); // stay under Helius rate limits
      const { result: tx } = await fetchJson(rpc, {
        jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [sig.signature, { maxSupportedTransactionVersion: 0 }],
      });
      if (!tx?.meta) continue;
      const logs: string[] = tx.meta.logMessages ?? [];
      const isLiquidation = logs.some((l) => /Instruction: (LiquidateObligation|LiquidateAndSwap|liquidate)/.test(l));
      if (!isLiquidation) continue;
      liquidations++;
      const keys: string[] = tx.transaction.message.accountKeys;
      const alt = tx.meta.loadedAddresses ?? { writable: [], readonly: [] };
      const allk = [...keys, ...alt.writable, ...alt.readonly];
      const payer = keys[0]!;
      const stat = stats.get(payer) ?? {
        payer, txs: 0, usedScopeV2: 0, usedScopeV1: 0, noScopeRefresh: 0,
        wrapperPrograms: new Set(), liquidatedReserves: new Set(), sampleSig: sig.signature,
      };
      stat.txs++;
      // scope refresh usage: check top-level ix data discriminators on the scope program
      let scopeV2 = 0, scopeV1 = 0;
      for (const ix of tx.transaction.message.instructions) {
        const pid = allk[ix.programIdIndex]!;
        if (String(pid).startsWith("HFn8GnPAD")) {
          const pad = "=".repeat((4 - (ix.data.length % 4)) % 4);
          try {
            const data = Buffer.from(ix.data + pad, "base64");
            if (data.subarray(0, 8).toString("hex") === SCOPE_V2_DISC) scopeV2++;
            if (data.subarray(0, 8).toString("hex") === SCOPE_V1_DISC) scopeV1++;
          } catch { /* ignore */ }
        }
        // wrapper detection: non-standard programs invoking klend
        if (String(pid).startsWith("Fz3jruy")) stat.wrapperPrograms.add("Fz3jruy(LionX-wrapper)");
      }
      if (scopeV2) stat.usedScopeV2 += scopeV2;
      if (scopeV1) stat.usedScopeV1 += scopeV1;
      if (!scopeV1 && !scopeV2) stat.noScopeRefresh++;
      // find which reserve got liquidated: klend ix with 15+ accounts where accounts include a reserve address... just log count
      stats.set(payer, stat);
    }
  }

  console.log(`scanned ${scanned} klend txs, found ${liquidations} liquidation txs`);
  const sorted = [...stats.values()].sort((a, b) => b.txs - a.txs);
  for (const s of sorted) {
    console.log(
      `payer ${s.payer.slice(0, 10)}… txs=${s.txs} scopeV1=${s.usedScopeV1} scopeV2=${s.usedScopeV2} noScope=${s.noScopeRefresh} wrapper=${[...s.wrapperPrograms].join(",") || "-"} sample=${s.sampleSig.slice(0, 16)}…`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });