import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type FullySignedTransaction,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";

type AltInfoResponse = { result?: { value?: { data?: { parsed?: { info?: { addresses?: string[] } } } } } };
const parseAltResponse = async (r: Response): Promise<AltInfoResponse | null> => r.json().catch(() => null);

export async function createSignedTransaction(rpc: Rpc<SolanaRpcApi>, signer: TransactionSigner, instructions: Instruction[]) {
  const { value: latestBlockhash } = await fetchLatestBlockhash(rpc);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
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
      return await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
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
  const { value: latestBlockhash } = await fetchLatestBlockhash(rpc);
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );
  const uniqueTables = [...new Set(lookupTableAddresses.map((a) => a.toString()))];
  if (uniqueTables.length) {
    const addressesByLookupTableAddress: Record<string, Address[]> = {};
    for (const tableAddress of uniqueTables) {
      // jsonParsed: the node decodes the ALT and returns the address list directly.
      let response: Awaited<ReturnType<typeof parseAltResponse>> | null = null;
      for (let attempt = 1; attempt <= 4 && !response?.result?.value?.data?.parsed?.info?.addresses?.length; attempt += 1) {
        const raw = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [tableAddress, { encoding: "jsonParsed" }] }),
        }).catch(() => null);
        if (!raw) continue;
        if (raw.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
          continue;
        }
        response = (await raw.json().catch(() => null)) as Awaited<ReturnType<typeof parseAltResponse>>;
      }
      const addresses = response?.result?.value?.data?.parsed?.info?.addresses;
      if (addresses?.length) addressesByLookupTableAddress[tableAddress] = addresses.map((a) => a as Address);
    }
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, addressesByLookupTableAddress as never);
    if (compressed) message = compressed as typeof message;
  }
  return signTransactionMessageWithSigners(message);
}

export async function simulate(rpc: Rpc<SolanaRpcApi>, transaction: FullySignedTransaction) {
  const wire = getBase64EncodedWireTransaction(transaction);
  return rpc.simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    sigVerify: true,
  }).send();
}

export async function sendAndConfirm(
  rpcUrl: string,
  rpc: Rpc<SolanaRpcApi>,
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime,
): Promise<string> {
  const wsUrl = rpcUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const { createSolanaRpcSubscriptions } = await import("@solana/kit");
  const subscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sender = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions });
  const signature = getSignatureFromTransaction(transaction);
  // Hard timeout: a tx that never confirms (lost blockspace race, expired
  // blockhash behind a slow send) must RELEASE the fire lane — without this the
  // sendAndConfirm promise hangs forever and all 3 MAX_FIRE_LANES stall
  // permanently (the "bot froze overnight" failure mode). The blockhash
  // lifetime is ≤60s; 90s covers worst-case confirmation latency.
  const SEND_CONFIRM_TIMEOUT_MS = 90_000;
  await Promise.race([
    sender(transaction, { commitment: "confirmed", skipPreflight: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sendAndConfirm timeout after ${SEND_CONFIRM_TIMEOUT_MS}ms — tx likely expired (blockhash) or lost the blockspace race`)), SEND_CONFIRM_TIMEOUT_MS),
    ),
  ]);
  return signature;
}

/**
 * Deterministic send+confirm WITHOUT the websocket subscription factory.
 * The kit's sendAndConfirmTransactionFactory leans on a WS subscription for
 * confirmation; when the WS endpoint is flaky it silently re-submits the SAME
 * signed tx until the blockhash dies (150 slots) and only THEN surfaces the
 * misleading "currentBlockHeight > lastValidBlockHeight" error — seen live on
 * EVERY one-off admin tx (liq-setup extends, alt-reclaim deactivate/close) while
 * fire-path txs through the same factory confirm fine. One-off txs don't need
 * WS at all: raw send + poll getSignatureStatuses. The fire path is untouched.
 */
export async function sendAndConfirmPoll(
  rpc: Rpc<SolanaRpcApi>,
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime,
  timeoutMs = 20_000,
): Promise<string> {
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), {
    skipPreflight: true,
    encoding: "base64",
  }).send();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const status = (await rpc.getSignatureStatuses([signature]).send()).value?.[0];
    if (status) {
      const rep = (_: unknown, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
      if (status.err) throw new Error(`tx ${signature} failed on-chain: ${JSON.stringify(status.err, rep)}`);
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return signature;
    }
    if (Date.now() > deadline) throw new Error(`sendAndConfirmPoll timeout after ${timeoutMs}ms (sig ${signature})`);
  }
}
