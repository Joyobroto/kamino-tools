// Use ed25519 directly (node:crypto) — independent of kit types:
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { Buffer } from "node:buffer";
const { publicKey, secretKey } = generateKeyPairSync("ed25519");
const full = new Uint8Array(64);
full.set(secretKey.subarray(0, 32), 0); // seed
full.set(publicKey, 32);
console.log("PUBKEY=" + bs58.encode(Buffer.from(publicKey)));
console.log("PRIVATE_KEY_JSON=" + JSON.stringify(Array.from(full)));
console.log("PRIVATE_KEY_B58=" + bs58.encode(Buffer.from(full)));
