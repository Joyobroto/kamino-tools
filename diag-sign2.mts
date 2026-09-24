import "dotenv/config";
import { getCachedWalletSigner } from "./src/strategies/liquidation/hotcache.js";
const signer = await getCachedWalletSigner();
console.log("type:", typeof signer, "isAsync?:", typeof (signer as any).signMessages, "keys:", Object.getOwnPropertyNames(signer));
if ((signer as any).signMessages) {
  try {
    const out = await (signer as any).signMessages([new Uint8Array(32)]);
    console.log("signMessages result keys:", out.map((s: any)=>s[0]));
  } catch (e) { console.log("signMessages threw:", (e as Error).message?.slice(0,200)); }
}
