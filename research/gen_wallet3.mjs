// CryptoKey (WebCrypto) — export via crypto.subtle:
import { generateKeyPairSigner } from "@solana/signers";
import bs58 from "bs58";
import { Buffer } from "node:buffer";
const signer = await generateKeyPairSigner();
const pub = signer.address.toString();
// export seed via subtle:
const cryptoKey = signer.keyPair.privateKey;
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoKey));
const full = new Uint8Array(64);
full.set(raw, 0);
// pubkey bytes: address has .toBytes? try decode from base58:
const pubBytes = bs58.decode(pub);
full.set(pubBytes, 32);
console.log("PUBKEY=" + pub);
console.log("PRIVATE_KEY_JSON=" + JSON.stringify(Array.from(full)));
console.log("PRIVATE_KEY_B58=" + bs58.encode(Buffer.from(full)));
