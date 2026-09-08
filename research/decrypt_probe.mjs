// probe secret SHAPE without printing it
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
const dir = "/home/administrator/automated-reshape";
const key = fs.readFileSync(path.join(dir, ".envrypt"), "utf8").trim();
const parsed = dotenv.parse(fs.readFileSync(path.join(dir, ".env"), "utf8"));
const encrypted = new Set();
let next = false;
for (const line of fs.readFileSync(path.join(dir, ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t) { next = false; continue; }
  if (t.toLowerCase() === "# encrypted") { next = true; continue; }
  const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (m && next) encrypted.add(m[1]);
  next = false;
}
console.log("encrypted keys:", [...encrypted]);
function decrypt(value) {
  const b = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(b, (ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join("");
}
const raw = parsed.WALLET_PRIVATE_KEY;
console.log("encrypted b64 len:", raw.length);
const dec = decrypt(raw);
console.log("decrypted len:", dec.length);
console.log("first 3 chars:", dec.slice(0, 3).replace(/[^\[\{"\d]/g, "?"));
console.log("looks like JSON array:", dec.startsWith("["));
console.log("looks like base58:", /^[1-9A-HJ-NP-Za-km-z]+$/.test(dec));
console.log("charcode range sample:", [dec.charCodeAt(0), dec.charCodeAt(1), dec.charCodeAt(2), dec.charCodeAt(3)]);
