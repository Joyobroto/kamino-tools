// vault@168 = D6uDyjtptL5Mr267BiLZJF4y3tNVm8RwT31KM9W5t6ZA — that's the POOL's PDA vault authority,
// and it owns ALL DAMMv2 vaults. The "vault" at pool offset 168 IS the PDA, not the token account!
// The actual token vaults are DERIVED: PDA seeds [pool, mint] → vault. So for Eo7WjKq (Meteora DAMMv2):
// mints@8/@40 ✓, vaults = PDA-derived (can't read at fixed offsets).
// BUT WAIT — the ANB pool (cpamdpZ, 1112B) DID have working vault offsets @232/@264 ($0.003/$8.5 verified!)
// and Gecko labeled it "meteora-damm-v2". cpamdpZ = Phoenix?? Earlier we saw cpamdpZ in ANB txs = "Phoenix" label?
// Let's check what program cpamdpZ actually is — decode ANB pool's config/authority and check a Phoenix pool:
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
// Gecko search for a known meteora-damm-v2 pool & a known phoenix pool, check owners:
const s = await fetch("https://api.geckoterminal.com/api/v2/search/pools?query=CPEPEP", { headers: { Accept: "application/json" } });
const j = await s.json();
for (const p of (j.data ?? []).slice(0, 5)) {
  const a = p.attributes;
  const ai = await rpcCall("getAccountInfo", [a.address, { encoding: "base64" }]);
  if (!ai.value) { console.log(a.name, a.address.slice(0, 10), "gone"); continue; }
  console.log(`${a.name} dex=${p.relationships?.dex?.data?.id} owner=${ai.value.owner} space=${Buffer.from(ai.value.data[0], "base64").length}`);
}
