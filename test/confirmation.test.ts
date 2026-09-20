import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Rpc, SolanaRpcApi, Signature } from "@solana/kit";
import { confirmTransactionSignature } from "../src/transaction.js";
import { withTimeout } from "../src/timeout.js";
const signature = "test-signature" as Signature;
const rpc = (send: () => Promise<unknown>) => ({ getSignatureStatuses: () => ({ send }) }) as unknown as Rpc<SolanaRpcApi>;

test("confirmation retries transient transport errors without treating them as failed transactions", async () => {
  let calls = 0;
  await confirmTransactionSignature(rpc(async () => {
    if (++calls === 1) throw new Error("temporary 429");
    return { value: [{ err: null, confirmationStatus: "confirmed" }] };
  }), signature, 1_000);
  assert.equal(calls, 2);
});
test("confirmation deadline releases a lane even if RPC never resolves", async () => {
  await assert.rejects(confirmTransactionSignature(rpc(() => new Promise(() => {})), signature, 25), /confirmation timeout.*confirmation unknown/);
});
test("confirmed on-chain errors are surfaced, including bigint error details", async () => {
  await assert.rejects(confirmTransactionSignature(rpc(async () => ({ value: [{ err: { InstructionError: [2n, { Custom: 6016n }] }, confirmationStatus: "confirmed" }] })), signature, 100), /failed on-chain.*6016/);
});
test("deadline aborts the underlying request and propagates immediate errors", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(withTimeout(async s => { signal = s; return new Promise(() => {}); }, 10, "test RPC"), /test RPC timed out/);
  assert.equal(signal?.aborted, true);
  await assert.rejects(withTimeout(async () => { throw new Error("real error"); }, 100, "test RPC"), /real error/);
});
