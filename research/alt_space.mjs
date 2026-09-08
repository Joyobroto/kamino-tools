import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
for (let a = 0; a < 5; a++) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "jsonParsed" }] }) });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 10000)); continue; }
  const j = await res.json();
  console.log("space:", j.result.value.space, "dataLen:", j.result.value.data.content ? "parsed" : "-", "keys:", Object.keys(j.result.value.data));
  console.log(JSON.stringify(j.result.value.data).slice(0, 200));
  break;
}
