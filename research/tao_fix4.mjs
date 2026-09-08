// "WrongSize" from getTokenAccountsByOwner even on known-good — Helius quirk?
// Our liquidation screener must use something similar... check how repo's kamino.ts fetches accounts:
import { readFileSync } from "node:fs";
const src = readFileSync("/home/administrator/kamino-tools/src/kamino.ts", "utf8");
const lines = src.split("\n");
lines.forEach((l, i) => { if (/getTokenAccount|getProgramAccounts|dataSlice|getMultiple/i.test(l)) console.log(i + 1, l.trim().slice(0, 100)); });
