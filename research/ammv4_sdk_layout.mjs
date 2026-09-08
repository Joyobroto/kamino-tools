// Find AMMv4 state layout inside raydium-sdk-v2 (probably via @raydium-io/raydium-CLMM or api)
// Actually the canonical layout lives in the OLD @raydium-io/raydium-sdk "LAYOUTS" — not installed.
// But WSOL@400/USDC@432 in a 752-byte account is suspicious — that region might be
// "recentEpoch / ammConfig" tail? No. Let me check @raydium-io/raydium-sdk-v2 api directory:
import { readdirSync, statSync } from "node:fs";
const dirs = ["node_modules/@raydium-io/raydium-sdk-v2/lib", "node_modules/@raydium-io/raydium-sdk-v2/src/api"];
for (const d of dirs) {
  try { console.log(d, "→", readdirSync(d).slice(0, 30).join(", ")); } catch { console.log(d, "missing"); }
}
