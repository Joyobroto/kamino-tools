import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { transactionReceipt } from "../src/transaction.js";

test("receipts report actual fees for both success and on-chain failure", async () => {
  for (const err of [null, { InstructionError: [2, "InvalidArgument"] }]) {
    const rpc = { getTransaction: () => ({ send: async () => ({ meta: { err, fee: 98765n } }) }) } as unknown as Rpc<SolanaRpcApi>;
    assert.deepEqual(await transactionReceipt(rpc, "signature"), {
      transactionStatus: err ? "failed" : "confirmed", feeLamports: 98765,
    });
  }
});

test("missing metadata or RPC failure does not invent zero gas or failed status", async () => {
  for (const send of [async () => null, async () => { throw new Error("offline"); }]) {
    const rpc = { getTransaction: () => ({ send }) } as unknown as Rpc<SolanaRpcApi>;
    assert.deepEqual(await transactionReceipt(rpc, "signature"), { transactionStatus: "unknown" });
  }
});
