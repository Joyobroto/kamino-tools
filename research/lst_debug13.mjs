// slice[80..112] b58 = J1toso1uCk — starts correctly! But .equals(JITO) false →
// bytes DIFFER past the start. Check full lengths:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const sliceB64 = "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHRx3VdsiDUOVM8KcR+qZA3mYxtJPU0cLmKZyX9iVkSoIaPMb/fxhcAAAAAAAAAAAD80UHpgyyvEK2RdJXKDycbWyk81HAn6nNwB+1A6zmgvQ==";
const buf = Buffer.from(sliceB64, "base64");
const got = bs58.encode(buf.subarray(80, 112));
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe";
console.log("got   :", got, `(${got.length} chars)`);
console.log("JitoSOL:", JITO, `(${JITO.length} chars)`);
console.log("equal?", got === JITO);
// AH WAIT — earlier full-account decode showed field@181 = J1toso1uCk... maybe the full read
// truncated? Earlier: 'field@181: J1toso1uCk' — I only printed 10 chars!
console.log("\n→ the b58 of slice[80..112] vs actual JitoSOL — compare byte-by-byte:");
const JITObytes = bs58.decode(JITO);
const gotBytes = buf.subarray(80, 112);
for (let i = 0; i < 32; i++) if (JITObytes[i] !== gotBytes[i]) { console.log("first diff at byte", i); break; }
