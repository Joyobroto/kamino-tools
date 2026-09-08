// CRITICAL DISCOVERY: byte[0] of JitoSOL mint = 0x045be23d... vs pool tokenB = 0xfcd141e9...
// The base58 prefix "J1toso1uCk" is IDENTICAL for both but they are DIFFERENT MINTS.
// gotAddr J1toso1uCk...GCPn = decimals 9, supply 7.8M — THIS is likely the REAL JitoSOL?
// My registry mint "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" — check it:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
for (const [label, mint] of [
  ["registry 'JitoSOL'", "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe"],
  ["pool tokenB", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
]) {
  const info = await call("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const p = info.value?.data?.parsed?.info;
  console.log(`${label}: ${mint}`);
  console.log(`  decimals=${p?.decimals} supply=${p ? (Number(p.supply) / 10 ** p.decimals).toExponential(3) : "gone"} mintAuth=${!!p?.mintAuthority}`);
}
// The classic JitoSOL mint is famously: J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe — I'm quite sure.
// But pool tokenB could be the same token... byte comparison says NO. One of these is an
// impostor/copy. Check Gecko: which mint does Gecko list for JitoSOL?
const s = await fetch("https://api.geckoterminal.com/api/v2/search/pools?query=JitoSOL%20SOL%20orca", { headers: { Accept: "application/json" } });
const j = await s.json();
for (const p of (j.data ?? []).slice(0, 3)) console.log("gecko:", p.attributes.address, p.attributes.name, p.relationships?.dex?.data?.id);
