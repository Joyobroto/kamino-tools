// Identify famous pools' owners to calibrate program IDs
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const candidates = {
  // famous Raydium AMMv4 SOL/USDC pool (widely referenced):
  "8sLbZs7SjPbLq2JVAn8FgVGwwK3iM19jQVY2NVVaHUKP": "Raydium SOL/USDC AMMv4 (per docs)",
  // Raydium AMM official SOL/USDC v4: "AVs9TA4nWDZhPbrVbfHj1jwx9ZNvb9dVQda9JWP4QR3Y"? 
  // Meteora DLMM SOL/USDC:
  "2hiQCLX59wUUKRVv4wv5LGMjTKzT6LwNQhF7h7XPgSTr": "Meteora DLMM SOL/USDC?",
  // Orca Whirlpool SOL/USDC:
  "9YZ2nN4YvoRhs7BQm3UBuqxC5y1McxC1dd5TUWU6EqJA": "Orca Whirlpool SOL/USDC?",
};
for (const [k, label] of Object.entries(candidates)) {
  try {
    const info = await rpcCall("getAccountInfo", [k, { encoding: "base64" }]);
    if (!info.value) { console.log(k.slice(0, 10), label, "→ not found"); continue; }
    console.log(k.slice(0, 10), label, "→ owner:", info.value.owner, "space:", Buffer.from(info.value.data[0], "base64").length);
  } catch (e) { console.log(k.slice(0, 10), label, "ERR", e.message.slice(0, 50)); }
}
