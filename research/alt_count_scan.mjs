import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
for (let a = 0; a < 5; a++) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 10000)); continue; }
  const j = await res.json();
  const buf = Buffer.from(j.result.value.data[0], "base64");
  const len = buf.length;
  console.log("len:", len);
  // scan every offset for u64 n where off + 8 + n*32 === len:
  for (let off = 0; off < 200; off++) {
    const n = Number(buf.readBigUInt64LE(off));
    if (off + 8 + n * 32 === len) console.log(`✓ off=${off} count=${n}`);
  }
  break;
}
