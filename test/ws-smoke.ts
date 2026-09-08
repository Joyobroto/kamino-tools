import { createSolanaRpcSubscriptions, address } from "@solana/kit";
import { PROGRAM_ID as KLEND_PROGRAM } from "@kamino-finance/klend-sdk";
import { config as loadEnv } from "dotenv";
import { rpcClient } from "../src/kamino.js";
import { fetchCachedSnapshot } from "../src/strategies/liquidation/screener.js";
loadEnv();

const SCRIPT_MS = Number(process.env.SMOKE_MS ?? "60000") || 60_000;

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL!;
  const marketAddress = process.env.KAMINO_MARKET!;
  const rpc = rpcClient(rpcUrl);

  const snapshot = await fetchCachedSnapshot({ rpc, marketAddress });
  const snapshotKeys = new Set(snapshot.map((e) => e.pubkey.toString()));
  console.log(`GPA snapshot (same dataSize+memcmp filter): ${snapshot.length} obligations for ${marketAddress.slice(0, 8)}…`);

  const wsUrl = rpcUrl.replace(/^https?:/, "wss:");
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), SCRIPT_MS).unref();

  const subscriptions = createSolanaRpcSubscriptions(wsUrl);
  let inSnapshot = 0;
  let outside = 0;
  const samples: string[] = [];
  const iterable = await subscriptions
    .programNotifications(address(KLEND_PROGRAM.toString()), {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize: 3344n },
        { memcmp: { offset: 32n, bytes: marketAddress as unknown as never, encoding: "base58" } },
      ],
    })
    .subscribe({ abortSignal: abortController.signal });
  console.log("✔ filtered stream SUBSCRIBED — listening…");
  for await (const raw of iterable) {
    const pk = ((raw as { value?: { pubkey?: string } }).value?.pubkey) ?? "";
    if (snapshotKeys.has(pk)) inSnapshot++;
    else outside++;
    if (samples.length < 3) samples.push(`${pk.slice(0, 12)}…`);
  }

  console.log("\n===== RESULT =====");
  console.log(`filtered notifications:        ${inSnapshot + outside}`);
  console.log(`…pubkeys in GPA snapshot set:  ${inSnapshot}`);
  console.log(`…pubkeys NOT in snapshot set:  ${outside}`);
  console.log(`samples: ${samples.join(", ") || "none"}`);
  const ok = snapshot.length > 0 && (inSnapshot > 0);
  console.log(ok ? "✔ memcmp(market@32) filter matches the GPA filter — WS identifies this market's obligations" : "⚠ no filtered notifications observed in window");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});