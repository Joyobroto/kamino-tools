// Semua 1112B accounts = valid pools (mints selalu terisi). 1.45M pools memang benar —
// cpamdpZ adalah program yang SANGAT aktif (launchpad-style DAMMv2 dengan jutaan listing).
// Pubkeys semua mulai "1" = PDA derivation.
// KESIMPULAN ARSITEKTUR: 
//   - full re-list cpamdpZ tiap pass = 83s + 145 request — TERLALU MAHAL untuk diff.
//   - Ganti strategi: JANGAN diff cpamdpZ via listing. Pakai getSignaturesForAddress?? 
//     Program ini seberapa tx/min? Cek:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const sigs = await call("getSignaturesForAddress", ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", { limit: 1000 }]);
const times = sigs.map(s => s.blockTime).filter(Boolean).sort((a, b) => b - a);
console.log("1000 sigs span:", ((times[0] - times[times.length - 1]) / 60).toFixed(1), "min →", (1000 / ((times[0] - times[times.length - 1]) / 60)).toFixed(0), "tx/min");
