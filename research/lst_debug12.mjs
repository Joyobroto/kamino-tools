// Slice works per-account and V2 pages return 9999 accounts of 112 bytes... so my scan loop
// should have found it. BUG in my loop: `page.accounts ?? []` with `do...while(key && found<500)`
// — loop CONTINUES while key non-null... but maybe I broke early? No: found.length<500 never true →
// loop runs until key null. 156K pools = 16 pages. Did it CRASH midway (429 swallowed)? do/while
// with key — the loop worked... wait, "found.length < 500" as CONTINUE condition — if found.length
// hits 500 we STOP (intended). It printed 0 — so no match in ANY page?!
// Compare bytes: maybe my slice offsets were right but comparison failed because
// JitoSOL appears at ABS 181 = slice offset 80 ✓. Let me verify raw equality on the known pool:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const sliceB64 = "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHRx3VdsiDUOVM8KcR+qZA3mYxtJPU0cLmKZyX9iVkSoIaPMb/fxhcAAAAAAAAAAAD80UHpgyyvEK2RdJXKDycbWyk81HAn6nNwB+1A6zmgvQ==";
const buf = Buffer.from(sliceB64, "base64");
const JITO = bs58.decode("J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe");
console.log("slice[0..32] equals JitoSOL?", buf.subarray(0, 32).equals(JITO));
console.log("slice[80..112] equals JitoSOL?", buf.subarray(80, 112).equals(JITO));
console.log("slice[0..32] b58:", bs58.encode(buf.subarray(0, 32)).slice(0, 10));
console.log("slice[80..112] b58:", bs58.encode(buf.subarray(80, 112)).slice(0, 10));
