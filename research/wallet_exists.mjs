import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["BuTTR3T2WsnWSpB4upFAUXfRQkj1CP5kunD1eUFpX7xB"] }) });
const j = await res.json();
console.log("wallet account:", j.result.value ? `exists (${j.result.value.lamports} lamports)` : "NOT FOUND (never funded)");
