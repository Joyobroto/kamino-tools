import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { Buffer } from "node:buffer";
const { publicKey, secretKey } = generateKeyPairSync("ed25519");
// secretKey is a KeyObject — extract raw:
const raw = secretKey.export({ type: "pkcs8", format: "buffer" });
// ed25519 pkcs8 = 16-byte header + 32-byte seed. seed = last 32 bytes:
const seed = raw.subarray(raw.length - 32);
const full = new Uint8Array(64);
full.set(seed, 0);
full.set(publicKey.export({ type: "spki", format: "buffer" }).subarray(-32), 32);
console.log("PUBKEY=" + bs58.encode(Buffer.from(full.subarray(32))));
console.log("PRIVATE_KEY_JSON=" + JSON.stringify(Array.from(full)));
