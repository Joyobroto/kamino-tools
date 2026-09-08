/**
 * Pool executable-price verification: for a list of pool addresses, compare the
 * vault-truth ratio against an actual Jupiter DIRECT-ROUTE quote of the same
 * pair. Only pools where the two agree are executable-truth constant-product
 * pools (usable for cross-venue arb). Anything else is a layout/mechanics
 * phantom and must be dropped.
 */

import { createRpcClient, decodeTokenAccount } from "./pools.js";
import { decodePoolAccount, venueByName } from "./venues.js";
import { constantsProductVenues } from "./crossvenue-venues.js";
import { fetchRawQuote } from "./lst-arb.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

interface CheckArgs {
  rpcUrl: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export async function verifyPoolExecutable(poolAddress: string, venueName: string, args: CheckArgs): Promise<void> {
  const rpc = createRpcClient(args.rpcUrl);
  const venue = constantsProductVenues().find((v) => v.name === venueName) ?? venueByName(venueName);
  if (!venue) throw new Error(`unknown venue ${venueName}`);
  const accounts = await rpc.getMultipleAccounts([poolAddress]);
  const base64 = accounts[0]?.data?.[0];
  if (!base64) throw new Error(`pool ${poolAddress} fetch failed`);
  const pool = decodePoolAccount(venue, poolAddress, Buffer.from(base64, "base64"));
  if (!pool) throw new Error(`pool ${poolAddress} decode failed (size mismatch)`);

  const [va, vb] = await rpc.getMultipleAccounts([pool.vaultA, pool.vaultB]);
  const tokA = va?.data?.[0] ? decodeTokenAccount(Buffer.from(va.data[0], "base64")) : null;
  const tokB = vb?.data?.[0] ? decodeTokenAccount(Buffer.from(vb.data[0], "base64")) : null;
  if (!tokA || !tokB || tokA.mint !== pool.mintA || tokB.mint !== pool.mintB) {
    console.log(`vault/mint mismatch — NOT a trusted constant-product pool`);
    return;
  }
  const isSolA = pool.mintA === WSOL;
  const usdcAmount = isSolA ? tokB.amount : tokA.amount;
  const solAmount = isSolA ? tokA.amount : tokB.amount;
  const usdcPerSolVault = (Number(usdcAmount) / Number(solAmount)) * 1e3;
  const poolBase = pool.mintA === WSOL ? pool.mintB : pool.mintA;
  const poolQuote = pool.mintA === WSOL ? pool.mintA : pool.mintB;

  console.log(`\npool ${poolAddress.slice(0, 12)}  venue=${venue.name}  pair=${poolBase.slice(0, 6)}/${poolQuote.slice(0, 6)}`);
  console.log(`  vault ratio  = $${usdcPerSolVault.toFixed(4)}/SOL  (SOL=${(Number(solAmount) / 1e9).toFixed(2)}, USDC=${(Number(usdcAmount) / 1e6).toFixed(2)})`);

  // Jupiter direct-route quote: same pair, onlyDirectRoutes=true.
  const direct = await fetchRawQuote(
    { inputMint: WSOL, outputMint: USDC, amount: String(1 * 10 ** 9), slippageBps: 200, onlyDirectRoutes: true },
    args.fetchImpl,
  );
  if (direct) {
    const usdcPerSolJup = Number(direct.outAmount) / 1e6;
    const deltaPct = ((usdcPerSolJup - usdcPerSolVault) / usdcPerSolVault) * 100;
    const routeSteps = (direct.routePlan as Array<{ swapInfo?: { label?: string; inputMint?: string; outputMint?: string } }> | undefined) ?? [];
    console.log(`  jupiter direct = $${usdcPerSolJup.toFixed(4)}/SOL  (via ${routeSteps.map((r) => r.swapInfo?.label ?? "?").join("+")})`);
    console.log(`  delta = ${deltaPct.toFixed(3)}%  → ${Math.abs(deltaPct) < 1 ? "MATCH ✅ (executable ratio)" : "MISMATCH ❌ (phantom)"}`);
    console.log(`  route: ${routeSteps.map((r) => `${r.swapInfo?.label ?? "?"}:${r.swapInfo?.inputMint?.slice(0, 4)}→${r.swapInfo?.outputMint?.slice(0, 4)}`).join(" | ")}`);
  } else {
    console.log(`  jupiter direct = unquotable`);
  }
}

export async function runPoolVerify(poolAddresses: Array<{ pool: string; venue: string }>, rpcUrl: string): Promise<void> {
  for (const spec of poolAddresses) {
    try {
      await verifyPoolExecutable(spec.pool, spec.venue, { rpcUrl });
    } catch (error) {
      console.log(`✗ ${spec.pool.slice(0, 12)} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}