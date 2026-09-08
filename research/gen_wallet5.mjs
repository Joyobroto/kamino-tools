import { generateKeyPair } from "node:crypto";
import bs58 from "bs58";
import { Buffer } from "node:buffer";
const { publicKey, secretKey } = generateKeyPair("ed25519");
const full = new Uint8Array(64);
full.set(secretKey.subarray(0, 32), 0);
full.set(publicKey, 32);
console.log("PUBKEY=" + bs58.encode(Buffer.from(publicKey)));
console.log("PRIVATE_KEY_JSON=" + JSON.stringify(Array.from(full)));
