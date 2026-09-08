// Addresses starting with "11111..." are System Program-ish dummy decodes → offsets wrong for THIS pool.
// But WSOL mint bytes were found EXACTLY at 400 and USDC at 432 → mints ARE at 400/432 for this account.
// And owner-scan found REAL vaults (GzitgXCv… = USDC 13.2M). Search those vault pubkeys in pool data:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const info = await rpcCall("getAccountInfo", ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (const v of ["4GP9dESJE2jSHGcFpnDf6ucmM1V5ehDTsGMm7bwNMUWQ", "GzitgXCvQF23rjsC2EoMb95NJfXYS3qgfSiP6ZKDSKMm", "JBnYtxGYTUP2ZCf9zkogEhJFujXx4NMbuc6XXuBAFQRt"]) {
  const vb = bs58.decode(v);
  for (let off = 0; off <= 752 - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== vb[i]) { ok = false; break; }
    if (ok) console.log("vault", v.slice(0, 8), "at offset", off);
  }
}
