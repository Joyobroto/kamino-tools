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
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );
  return signTransactionMessageWithSigners(message);
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
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
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
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime
): Promise<string> {
  const wsUrl = rpcUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const { createSolanaRpcSubscriptions } = await import("@solana/kit");
  const subscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sender = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions });
  const signature = getSignatureFromTransaction(transaction);
  await sender(transaction, { commitment: "confirmed", skipPreflight: false });
  return signature;
}
