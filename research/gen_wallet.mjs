import { generateKeyPairSigner } from "@solana/signers";
import bs58 from "bs58";
const signer = await generateKeyPairSigner();
console.log("PUBKEY=" + signer.address.toString());
// privateKey is 32-byte seed; 64-byte JSON array form = seed+pub
const seed = signer.keyPair.privateKey;
const pub = signer.keyPair.publicKey;
const full = new Uint8Array(64);
full.set(seed, 0);
full.set(new Uint8Array(pub.toBytes ? pub.toBytes() : pub), 32);
// use base-x via bs58 with Buffer shim:
import { Buffer } from "node:buffer";
console.log("PRIVATE_KEY_JSON=" + JSON.stringify(Array.from(full)));
console.log("PRIVATE_KEY_B58=" + bs58.encode(Buffer.from(full)));
