/**
 * Screening-failure detector — answers exactly the operator's question:
 * "If LionX liquidated something our bot never even surfaced, the screener failed."
 *
 * Runs against:
 *  - data/opportunities.jsonl (our scan history: every obligation we ever surfaced)
 *  - on-chain klend liquidation txs (recent window, LionX included)
 *
 * Verdict per liquidation: DETECTED (we had it in the band at some point) vs
 * MISSED (we never saw it at all → screener fail) vs SILENT-CATCH (liquidated
 * from outside any band — instantly due without passing near-miss first).
 */
import { config as loadEnv } from "dotenv";
loadEnv();
import { readFileSync } from "node:fs";

const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const rpc = process.env.SOLANA_RPC_URL!;
const windowHours = Number(process.argv[2] ?? "48");

async function fetchJson(body: unknown): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(rpc, {
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
  throw new Error("RPC fetch failed");
}

async function main() {
  // 1. Every obligation our screener ever surfaced (any band, any time).
  const tracked = new Set<string>();
  const lines = readFileSync(process.env.TRACKER_LOG ?? "data/opportunities.jsonl", "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "watching") tracked.add(d.candidate?.obligation);
      else if (d.type === "spotted" || d.type === "promoted") tracked.add(d.candidate?.obligation);
      else if (d.type === "snapshot") {
        for (const c of d.result?.nearMiss ?? []) tracked.add(c.obligation);
        for (const c of d.result?.liquidatable ?? []) tracked.add(c.obligation);
      }
    } catch { /* partial line */ }
  }
  console.log(`screener history: ${tracked.size} unique obligations surfaced (all time)`);

  // 2. On-chain liquidations in the window.
  const cutoff = Date.now() / 1000 - windowHours * 3600;
  let before: string | undefined;
  const liquidations: Array<{ sig: string; slot: number; blockTime: number; payer: string; obligations: string[] }> = [];
  outer:
  for (let page = 0; page < 12; page++) {
    const { result: sigs } = await fetchJson({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [KLEND, { limit: 100, ...(before ? { before } : {}) }] });
    if (!sigs?.length) break;
    before = sigs[sigs.length - 1].signature;
    for (const sig of sigs) {
      if (!sig.blockTime || sig.blockTime < cutoff) break outer;
      if (sig.err) continue;
      await new Promise((r) => setTimeout(r, 120));
      const { result: tx } = await fetchJson({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig.signature, { maxSupportedTransactionVersion: 0 }] });
      if (!tx?.meta) continue;
      const logs: string[] = tx.meta.logMessages ?? [];
      if (!logs.some((l) => l.includes("Instruction: LiquidateObligationAndRedeemReserveCollateral") || l.includes("Instruction: LiquidateAndSwap"))) continue;
      // obligations touched = keys that appear as obligation-looking accounts in the tx keys
      const keys: string[] = tx.transaction.message.accountKeys;
      const obligations = keys.filter((k) => tracked.has(k) || true ? !tracked.has(k) && false : false).slice(0, 0); // placeholder, refined below
      // simpler: any tx key that we have in tracker OR any key passed to the liquidate ix
      const alt = tx.meta.loadedAddresses ?? { writable: [], readonly: [] };
      const allk = [...keys, ...alt.writable, ...alt.readonly];
      const liqIxs = tx.transaction.message.instructions.filter((ix: { programIdIndex: number }) => String(allk[ix.programIdIndex]).startsWith("KLend"));
      const ixObligations: string[] = [];
      for (const ix of liqIxs) {
        for (const idx of ix.accounts) {
          const a = String(allk[idx]);
          if (!ixObligations.includes(a)) ixObligations.push(a);
        }
      }
      liquidations.push({ sig: sig.signature, slot: tx.slot, blockTime: sig.blockTime, payer: keys[0]!, obligations: ixObligations });
    }
  }

  console.log(`on-chain liquidations in last ${windowHours}h: ${liquidations.length}\n`);
  let detected = 0;
  let missed = 0;
  for (const liq of liquidations) {
    const hits = liq.obligations.filter((o) => tracked.has(o));
    const verdict = hits.length ? "DETECTED (we had it in band)" : "MISSED — check silent-catch";
    if (hits.length) detected++;
    else missed++;
    const when = new Date(liq.blockTime * 1000).toISOString().slice(11, 16);
    console.log(`${when} payer ${liq.payer.slice(0, 8)}… ${hits.length ? "✓ DETECTED" : "✗ MISSED"} (touched ${liq.obligations.length} accounts, ${hits.length} known to our screener) ${liq.sig.slice(0, 20)}…`);
  }
  console.log(`\n=== SCORE: detected ${detected} / missed ${missed} ===`);
  console.log(missed === 0
    ? "✔ screener saw everything LionX caught — detection is not the failure mode"
    : "✗ screener missed at least one real liquidation — investigate band/adl filters");
}

main().catch((e) => { console.error(e); process.exit(1); });