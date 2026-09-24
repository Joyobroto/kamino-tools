import "dotenv/config";
import { rpcClient } from "./src/kamino.js";
import { getCachedWalletSigner, getCachedBlockhash } from "./src/strategies/liquidation/hotcache.js";
import { appendTransactionMessageInstructions, createTransactionMessage, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, getBase64EncodedWireTransaction } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
const rpcUrl = process.env.SOLANA_RPC_URL!;
const rpc = rpcClient(rpcUrl);
const signer = await getCachedWalletSigner(rpcUrl);
console.log("signer addr:", signer.address.toString(), "keys:", Object.keys(signer).join(","));
const bh = await getCachedBlockhash(rpc, rpcUrl);
const msg = pipe(createTransactionMessage({ version: 0 }), (tx)=>setTransactionMessageFeePayer(signer.address, tx), (tx)=>setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, tx), (tx)=>appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 9900 })]));
try {
  const s = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(s);
  console.log("signed OK, bytes:", Buffer.from(wire, "base64").length);
} catch (e) { console.log("throw:", (e as Error).message.slice(0,140)); }
