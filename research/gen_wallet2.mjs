import { generateKeyPairSigner } from "@solana/signers";
const signer = await generateKeyPairSigner();
console.log("PUBKEY=" + signer.address.toString());
const seed = signer.keyPair.privateKey; // 32-byte seed (SecretKey object)
const seedBytes = seed instanceof Uint8Array ? seed : seed.bytes ?? seed.secretKey ?? null;
if (!seedBytes) {
  console.log("privateKey type:", typeof seed, seed?.constructor?.name);
  console.log("own props:", Object.getOwnPropertyNames(seed));
  // try toString/decode:
  console.log("has toString:", typeof seed.toString === "function" ? seed.toString().slice(0, 20) : "no");
}
