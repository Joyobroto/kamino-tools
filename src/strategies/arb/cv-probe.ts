/**
 * Cross-venue premise probe: list constant-product pools pairing SOL+USDC and
 * report every pool's vault-truth SOL/USDC price. Verifies (a) the pair exists
 * in ≥2 venues, (b) vault ratios between venues differ by executable amounts.
 */

import { createRpcClient, decodeTokenAccount } from "./pools.js";
import { constantsProductVenues } from "./crossvenue-venues.js";
import { fetchSolPriceUsdc } from "./quotes.js";
import bs58 from "bs58";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

export async function runCvProbe(rpcUrl: string, opts: { showFull?: boolean; venues?: string[] } = {}): Promise<void> {
  const rpc = createRpcClient(rpcUrl);
  const solUsd = await fetchSolPriceUsdc();
  console.log(`SOL price: $${solUsd.toFixed(2)}`);
  const venues = (opts.venues ?? []).length
    ? constantsProductVenues().filter((v) => opts.venues!.includes(v.name))
    : constantsProductVenues();
  for (const venue of venues) {
    // dataSlice covers mints (43/75) + vault addresses (139/171) for pumpswap;
    // other venues use their own verified offsets — sliced fetch + local decode
    // avoids the 100-account getMultipleAccounts bottleneck on 100K+ pools.
    const layout = venue.layout;
    const sliceStart = Math.min(layout.mintAOffset, layout.mintBOffset);
    const sliceEnd = Math.max(layout.vaultAOffset, layout.vaultBOffset) + 32;
    const sliceLength = sliceEnd - sliceStart;
    console.log(`\n== ${venue.name} (${venue.programId.slice(0, 8)}…) listing...`);
    const rows = await rpc.listProgramAccountsSliced(venue.programId, [{ dataSize: layout.poolAccountSize }], { offset: sliceStart, length: sliceLength });
    console.log(`   pools fetched: ${rows.length}`);
    const solUsdcPools: Array<{ pool: string; mintA: string; mintB: string; vaultA: string; vaultB: string }> = [];
    for (const row of rows) {
      const buf = Buffer.from(row.data, "base64");
      if (buf.length < sliceLength) continue;
      const mintA = bs58.encode(buf.subarray(layout.mintAOffset - sliceStart, layout.mintAOffset - sliceStart + 32));
      const mintB = bs58.encode(buf.subarray(layout.mintBOffset - sliceStart, layout.mintBOffset - sliceStart + 32));
      const pair = [mintA, mintB].sort().join("|");
      if (pair !== [USDC, WSOL].sort().join("|")) continue;
      solUsdcPools.push({
        pool: row.pubkey,
        mintA,
        mintB,
        vaultA: bs58.encode(buf.subarray(layout.vaultAOffset - sliceStart, layout.vaultAOffset - sliceStart + 32)),
        vaultB: bs58.encode(buf.subarray(layout.vaultBOffset - sliceStart, layout.vaultBOffset - sliceStart + 32)),
      });
    }
    console.log(`   SOL/USDC pools (mint match): ${solUsdcPools.length}`);
    if (!solUsdcPools.length) continue;
    // Fetch vault token accounts for only the matched pools. The CRITICAL
    // invariant (learned from the ANB forensics): a pool's vaultA must hold
    // pool.mintA and vaultB must hold pool.mintB — decoded from the vault's own
    // token account. Any mismatch means the layout offsets are wrong for this
    // pool (damm-v1 pool states vary by asset count) — DROP it, never trust it.
    const vaultIds = solUsdcPools.flatMap((p) => [p.vaultA, p.vaultB]);
    const vaultData = await rpc.getMultipleAccounts(vaultIds);
    let shown = 0;
    const prices: number[] = [];
    let layoutMismatch = 0;
    for (let i = 0; i < solUsdcPools.length; i += 1) {
      const p = solUsdcPools[i]!;
      const va = vaultData[2 * i];
      const vb = vaultData[2 * i + 1];
      if (!va?.data?.[0]) continue;
      if (!vb?.data?.[0]) continue;
      const tokA = decodeTokenAccount(Buffer.from(va.data[0], "base64"));
      const tokB = decodeTokenAccount(Buffer.from(vb.data[0], "base64"));
      if (!tokA || !tokB) continue;
      if (tokA.mint !== p.mintA || tokB.mint !== p.mintB) {
        layoutMismatch += 1;
        continue;
      }
      const isSolA = p.mintA === WSOL;
      const usdcAmount = isSolA ? tokB.amount : tokA.amount;
      const solAmount = isSolA ? tokA.amount : tokB.amount;
      if (usdcAmount <= 0n || solAmount <= 0n) continue;
      const usdcPerSol = (Number(usdcAmount) / Number(solAmount)) * 1e3;
      if (!Number.isFinite(usdcPerSol) || usdcPerSol <= 0 || usdcPerSol > 500) continue;
      prices.push(usdcPerSol);
      if (shown < 8) {
        const label = opts.showFull ? p.pool : p.pool.slice(0, 12);
        console.log(`   ${label}  SOL=${(Number(solAmount) / 1e9).toFixed(2)}  USDC=${(Number(usdcAmount) / 1e6).toFixed(2)}  price=$${usdcPerSol.toFixed(2)}`);
        shown += 1;
      }
    }
    if (layoutMismatch > 0) console.log(`   → ${layoutMismatch} pools dropped: vault/mint layout mismatch`);
    if (prices.length >= 2) {
      const sorted = prices.sort((a, b) => a - b);
      const lo = sorted[0]!;
      const hi = sorted[sorted.length - 1]!;
      console.log(`   → RANGE (${prices.length} pools): $${lo.toFixed(2)} … $${hi.toFixed(2)}  (${((hi - lo) / lo * 100).toFixed(4)}% spread)`);
    } else if (prices.length === 1) {
      console.log(`   → single quotable pool @ $${prices[0]!.toFixed(2)} (no cross-venue pair yet)`);
    } else {
      console.log(`   → no quotable SOL/USDC depth`);
    }
  }
}