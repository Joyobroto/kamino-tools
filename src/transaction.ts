import { withTimeout } from "./timeout.js";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type FullySignedTransaction,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type Signature,
  type TransactionSigner,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";

export async function createSignedTransaction(rpc: Rpc<SolanaRpcApi>, signer: TransactionSigner, instructions: Instruction[]) {
  const { value: latestBlockhash } = await fetchLatestBlockhash(rpc);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );
  return signTransactionMessageWithSigners(message);
}

/** getLatestBlockhash with bounded 429 backoff (shared Helius key throttles under load). */
export async function fetchLatestBlockhash(rpc: Rpc<SolanaRpcApi>) {
  let delay = 500;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await withTimeout((abortSignal) => rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal }), 3_000, "latest blockhash");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const context = (error as { context?: { statusCode?: unknown } } | null)?.context;
      const is429 = /429|rate.?limit|too many requests/i.test(message)
        || context?.statusCode === 429 || context?.statusCode === "429";
      if (!is429 || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 4_000);
    }
  }
  throw new Error("getLatestBlockhash exhausted retries");
}

/**
 * Signed v0 transaction whose non-signer accounts are compressed via the given
 * address lookup tables (Jupiter swap routes require the shared JUP ALT).
 * ALT contents are fetched with jsonParsed encoding (the node parses the
 * on-chain table layout for us) and applied before signing.
 */
export async function createSignedTransactionWithAlt(
  rpc: Rpc<SolanaRpcApi>,
  rpcUrl: string,
  signer: TransactionSigner,
  instructions: Instruction[],
  lookupTableAddresses: Address[],
) {
  // Share the validated lookup resolver, provider failover and packet guard.
  const { createSignedTransactionWithAltCached } = await import("./strategies/liquidation/hotcache.js");
  return createSignedTransactionWithAltCached(rpc, rpcUrl, signer, instructions, lookupTableAddresses);
}

export async function simulate(rpc: Rpc<SolanaRpcApi>, transaction: FullySignedTransaction) {
  const wire = getBase64EncodedWireTransaction(transaction);
  return withTimeout((abortSignal) => rpc.simulateTransaction(wire, {
    commitment: "confirmed", encoding: "base64", sigVerify: true,
  }).send({ abortSignal }), 3_000, "simulation");
}

export async function sendAndConfirm(
  rpcUrl: string,
  rpc: Rpc<SolanaRpcApi>,
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime,
): Promise<string> {
  // Poll through the supplied failover RPC; a new primary-only WebSocket
  // subscription can strand a successfully submitted transaction during outages.
  return sendAndConfirmPoll(rpc, transaction, 90_000);
}

/** Missing metadata is unknown, never proof that a transaction paid zero fees. */
export async function transactionReceipt(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<{
  transactionStatus: "confirmed" | "failed" | "unknown"; feeLamports?: number;
}> {
  try {
    const tx = await rpc.getTransaction(signature as never, {
      encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0,
    }).send({ abortSignal: AbortSignal.timeout(3_000) });
    if (!tx?.meta) return { transactionStatus: "unknown" };
    return { transactionStatus: tx.meta.err ? "failed" : "confirmed", feeLamports: Number(tx.meta.fee) };
  } catch {
    return { transactionStatus: "unknown" };
  }
}

/** Submit once through the configured RPC, then confirm with bounded polling. */
export async function sendAndConfirmPoll(
  rpc: Rpc<SolanaRpcApi>,
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime,
  timeoutMs = 20_000,
): Promise<string> {
  const signature = getSignatureFromTransaction(transaction);
  await withTimeout((abortSignal) => rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), {
    skipPreflight: true, encoding: "base64",
  }).send({ abortSignal }), Math.min(timeoutMs, 5_000), "transaction submission");
  await confirmTransactionSignature(rpc, signature, timeoutMs);
  return signature;
}

/** A transient status-RPC error is not an on-chain transaction failure. */
export async function confirmTransactionSignature(rpc: Rpc<SolanaRpcApi>, signature: Signature, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status;
    try {
      status = (await withTimeout((abortSignal) => rpc.getSignatureStatuses([signature]).send({ abortSignal }),
        Math.min(3_000, Math.max(1, deadline - Date.now())), "signature status")).value?.[0];
    } catch {
      // Keep the same signature pending; a dropped RPC response proves nothing
      // about execution. The outer deadline always releases the fire lane.
    }
    if (status?.err) throw new Error(`tx ${signature} failed on-chain: ${JSON.stringify(status.err, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)));
  }
  throw new Error(`confirmation timeout after ${timeoutMs}ms (sig ${signature}) — confirmation unknown`);
}
