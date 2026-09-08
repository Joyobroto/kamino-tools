// Concrete numbers for JitoSOL:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const WSOL = "So11111111111111111111111111111111111111112";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 1) deepest pool price (orca Hp53XEtt): vaults?
const bal = [];
for (const v of ["F7tcS67EfPwFqakPGE1HYWAWcKWyaBdLztdVYdVCUyqz", "8tfJVFdcogNzBtBMSLwP5zKFCyoZKgoCSkvJz6PB828V"]) {
  try {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [v] }) });
    const j = await res.json();
    bal.push(j.result?.value?.uiAmountString ?? "err");
  } catch { bal.push("err"); }
  await sleep(1500);
}
console.log("orca JitoSOL/SOL vaults (A=WSOL@133, B=JitoSOL@213):", bal);
// 2) Jupiter executable: 2 JitoSOL → SOL
const params = new URLSearchParams({ inputMint: JITO, outputMint: WSOL, amount: String(2 * 10 ** 9), slippageBps: "100" });
const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } })).json();
console.log("Jup: 2 JitoSOL →", Number(q.outAmount) / 1e9, "SOL → rate", (Number(q.outAmount) / 1e9 / 2).toFixed(6));
