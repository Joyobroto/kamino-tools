// Pull the REAL layout from installed @raydium-io/raydium-sdk-v2 (it has AmmV4 layouts!)
import { readFileSync, readdirSync } from "node:fs";
import bs58 from "bs58";
const files = readdirSync("node_modules/@raydium-io/raydium-sdk-v2/dist").slice(0, 50);
console.log("sdk files sample:", files.join(", "));
