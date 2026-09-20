import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ClmmLocalQuoter, CLMM_STATE_TTL_MS, type LocalClmmQuote } from "../src/strategies/liquidation/clmm.js";
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const a = key(1), b = key(2);
function snapshot() {
  return { fetchedAt: Date.now(), mintA: a, mintB: b, vaultA: key(3), vaultB: key(4), bitmapAddress: key(5),
    tickArrayCache: {}, poolInfo: { id: key(6), ammConfig: { id: key(7).toBase58() }, mintA: { address: a.toBase58() }, observationId: key(8) } };
}
function quoter() { return new ClmmLocalQuoter("http://localhost:8899"); }
test("CLMM expires snapshots, deduplicates reloads, and keepWarm refreshes", async () => {
  const q = quoter(); let calls = 0; const old = snapshot();
  (q as any).discoverAndHydrate = async () => { calls++; return calls === 1 ? old : snapshot(); };
  await q.loadPairState(a,b); old.fetchedAt -= CLMM_STATE_TTL_MS + 1;
  const reads = await Promise.all([q.loadPairState(a,b),q.loadPairState(b,a)]);
  assert.equal(calls,2); assert.equal(reads[0],reads[1]); assert.notEqual(reads[0],old);
  reads[0]!.fetchedAt -= CLMM_STATE_TTL_MS + 1;
  q.keepWarm(a,b); await q.loadPairState(a,b); assert.equal(calls,3);
});
test("CLMM retries expired no-pool results and backs off failed RPC", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const q = quoter(); let calls = 0;
  (q as any).discoverAndHydrate = async () => { calls++; if (calls === 1) return null; if (calls === 2) throw new Error("RPC down"); return snapshot(); };
  assert.equal(await q.loadPairState(a,b), null);
  await q.loadPairState(a,b); assert.equal(calls,1);
  for (const entry of (q as any).pairs.values()) entry.noPoolAt -= 600_001;
  await assert.rejects(q.loadPairState(a,b), /RPC down/);
  for (let i = 0; i < 50; i++) assert.equal(await q.loadPairState(a,b), null);
  assert.equal(calls,2);
  now += 30_001;
  assert.ok(await q.loadPairState(a,b)); assert.equal(calls,3);
});

test("registering many CLMM pairs performs no RPC; one warm pass loads at most two", async () => {
  const q = quoter(); let calls = 0;
  (q as any).discoverAndHydrate = async () => { calls++; return snapshot(); };
  for (let n = 2; n < 24; n++) q.keepWarm(a,key(n));
  assert.equal(calls,0);
  await Promise.all([q.loadAllWarm(),q.loadAllWarm()]);
  assert.equal(calls,2);
});
test("both swap directions use canonical vaults, exact-input and bitmap before tick arrays", async () => {
  const q = quoter();
  for (const [tokenIn, tokenOut, vaultIn, vaultOut] of [[a,b,key(3),key(4)],[b,a,key(4),key(3)]] as const) {
    const state = snapshot();
    const quote: LocalClmmQuote = { snapshot: state, tokenIn, tokenOut, amountIn: new BN(100), amountOut: new BN(95), amountOutMin: new BN(90),
      poolId: key(6), tickArrayAccounts: [key(9)], allTradeConfirmed:()=>true, amountOutBigInt:()=>95n, amountOutMinBigInt:()=>90n };
    (q as any).loadPairState = () => { throw new Error("builder must reuse quoted snapshot"); };
    const params = { tokenIn, tokenOut, amountIn: new BN(100), amountOutMin: new BN(90), payer: key(10), ownerTokenIn:key(11), ownerTokenOut:key(12), quote };
    const swap = await q.buildSwapInstruction(params);
    assert.ok(swap); assert.ok(swap.instruction.keys[5]!.pubkey.equals(vaultIn)); assert.ok(swap.instruction.keys[6]!.pubkey.equals(vaultOut));
    assert.equal(swap.instruction.data[40],1);
    assert.ok(swap.instruction.keys[13]!.pubkey.equals(key(5))); assert.ok(swap.instruction.keys[14]!.pubkey.equals(key(9)));
    assert.equal(await q.buildSwapInstruction({...params, amountIn: new BN(101)}),null);
    assert.equal(await q.buildSwapInstruction({...params, tokenIn:tokenOut,tokenOut:tokenIn}),null);
    assert.equal(await q.buildSwapInstruction({...params, amountOutMin:new BN(1)}),null);
    state.fetchedAt -= CLMM_STATE_TTL_MS + 1;
    assert.equal(await q.buildSwapInstruction(params),null);
  }
});

test("CLMM RPC follows the configured fallback and shares rejected-primary cooldown", async (t) => {
  const previous = process.env.SOLANA_RPC_FALLBACK;
  process.env.SOLANA_RPC_FALLBACK = "https://clmm-fallback.invalid";
  t.after(() => { if (previous === undefined) delete process.env.SOLANA_RPC_FALLBACK; else process.env.SOLANA_RPC_FALLBACK = previous; });
  const hosts: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).host; hosts.push(host);
    if (host === "clmm-primary.invalid") return new Response("forbidden", { status: 403 });
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value: null } }), { headers: { "Content-Type": "application/json" } });
  });
  const q = new ClmmLocalQuoter("https://clmm-primary.invalid");
  assert.equal(await (q as any).connection.getAccountInfo(a), null);
  assert.equal(await (q as any).connection.getAccountInfo(b), null);
  assert.deepEqual(hosts, ["clmm-primary.invalid", "clmm-fallback.invalid", "clmm-fallback.invalid"]);
});
