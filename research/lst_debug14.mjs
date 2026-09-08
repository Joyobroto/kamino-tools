// got = J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn ≠ JitoSOL J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe
// LOOK CLOSELY: first 29 chars match "J1toso1uCk3RLmjorhTtrVwY9HJ" then DIVERGE:
//   got:      ...wY9HJ7X8V9yYac6Y7kGCPn
//   JitoSOL:  ...wY9HJ4XfsdL9qsm7tCvWe
// The rest differs → this pool's token B is a DIFFERENT JitoSOL-LIKE mint?! Or the dataSlice
// returned bytes from a DIFFERENT SLOT offset... Actually first-diff printed "byte 0" because
// my comparison loop compared JITObytes[i] vs gotBytes[i] — full compare should show where.
// Check leading bytes:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const sliceB64 = "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHRx3VdsiDUOVM8KcR+qZA3mYxtJPU0cLmKZyX9iVkSoIaPMb/fxhcAAAAAAAAAAAD80UHpgyyvEK2RdJXKDycbWyk81HAn6nNwB+1A6zmgvQ==";
const buf = Buffer.from(sliceB64, "base64");
const JITObytes = bs58.decode("J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe");
const gotBytes = buf.subarray(80, 112);
console.log("JITObytes[0..8]:", JITObytes.subarray(0, 8).toString("hex"));
console.log("gotBytes [0..8]:", gotBytes.subarray(0, 8).toString("hex"));
console.log("JITObytes full:", JITObytes.toString("hex"));
console.log("gotBytes  full:", gotBytes.toString("hex"));
// ALSO: my earlier decode of Hp53XEtt full account showed field@181 = 'J1toso1uCk' — but that was
// only 10 chars prefix — consistent with EITHER mint. So this whirlpool's tokenB is a JitoSOL
// IMPOSTOR mint (same prefix!). Verify by getting the mint account info for the got address:
const gotAddr = bs58.encode(gotBytes);
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [gotAddr, { encoding: "jsonParsed" }] }) });
const info = (await res.json()).result.value;
console.log("\ngotAddr:", gotAddr, "exists:", !!info, info?.data?.parsed?.info ? `decimals=${info.data.parsed.info.decimals} supply=${info.data.parsed.info.supply}` : "");
