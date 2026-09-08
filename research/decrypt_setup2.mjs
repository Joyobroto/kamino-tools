import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
const dir = "/home/administrator/automated-reshape";
const key = fs.readFileSync(path.join(dir, ".envrypt"), "utf8").trim();
const parsed = dotenv.parse(fs.readFileSync(path.join(dir, ".env"), "utf8"));
function decrypt(value) {
  const b = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(b, (ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join("");
}
const secret = decrypt(parsed.WALLET_PRIVATE_KEY);
const bytes = bs58.decode(secret);
console.log("decoded bytes:", bytes.length);
const pubBytes = bytes.subarray(32);
console.log("pubkey:", bs58.encode(Buffer.from(pubBytes)));
// verify seed derives same pubkey:
const { createPrivateKey, createPublicKey } = await import("node:crypto");
const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
const priv = createPrivateKey({ key: Buffer.concat([pkcs8Header, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
const derived = createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32);
console.log("seed-derived pubkey match:", Buffer.compare(derived, pubBytes) === 0 ? "YES ✓" : "NO");
// wallet funded?
const rpc = parsed.RPC_URL || "https://api.mainnet-beta.solana.com";
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [bs58.encode(Buffer.from(pubBytes))] }) });
const j = await res.json();
console.log("balance:", j.result?.value !== undefined ? `${j.result.value / 1e9} SOL` : j.error?.message ?? "err");
// write into kamino-tools .env (JSON array form — config.ts parses it):
const toolsEnv = "/home/administrator/kamino-tools/.env";
let s = fs.readFileSync(toolsEnv, "utf8");
s = s.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${JSON.stringify(Array.from(bytes))}`);
fs.writeFileSync(toolsEnv, s);
console.log("kamino-tools .env updated with the automated-reshape wallet key (base58 of 64B also fine)");
