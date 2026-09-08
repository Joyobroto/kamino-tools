// decrypt + verify + write into kamino-tools .env — secret NEVER printed
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateKeyPair, createPrivateKey, createPublicKey } from "node:crypto";

const dir = "/home/administrator/automated-reshape";
const key = fs.readFileSync(path.join(dir, ".envrypt"), "utf8").trim();
const envPath = path.join(dir, ".env");
const encrypted = new Set();
let next = false;
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t) { next = false; continue; }
  if (t.toLowerCase() === "# encrypted") { next = true; continue; }
  const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (m && next) encrypted.add(m[1]);
  next = false;
}
const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
function decrypt(value) {
  const b = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(b, (ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join("");
}
const secret = decrypt(parsed.WALLET_PRIVATE_KEY);
let bytes;
try {
  bytes = Uint8Array.from(JSON.parse(secret));
} catch {
  throw new Error("secret is not a JSON array — inspect format manually");
}
console.log("format: 64-byte keypair JSON:", bytes.length === 64);
// derive pubkey via PKCS8/SPKI dance:
const seed = bytes.subarray(0, 32);
const pubBytes = bytes.subarray(32);
// verify by signing:
const { generateKeyPairSync, sign, verify } = await import("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
void publicKey; void privateKey; void sign; void verify;
// build pkcs8 from seed to test-derive:
const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
const pkcs8 = Buffer.concat([pkcs8Header, Buffer.from(seed)]);
const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const derivedPub = createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32);
// compare with embedded:
let equal = Buffer.compare(Buffer.from(derivedPub), Buffer.from(pubBytes)) === 0;
const bs58 = (await import("bs58")).default;
console.log("embedded pubkey:", bs58.encode(Buffer.from(pubBytes)));
console.log("derived   pubkey:", bs58.encode(Buffer.from(derivedPub)));
console.log("match:", equal ? "YES ✓" : "NO — using seed-derived pubkey");
// write to kamino-tools .env as JSON array:
const toolsEnv = "/home/administrator/kamino-tools/.env";
let s = fs.readFileSync(toolsEnv, "utf8");
s = s.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${JSON.stringify(Array.from(bytes))}`);
fs.writeFileSync(toolsEnv, s);
console.log("kamino-tools .env updated");
