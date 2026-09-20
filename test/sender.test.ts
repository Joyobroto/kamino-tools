import { strict as assert } from "node:assert";
import { test } from "node:test";
import { address, createNoopSigner } from "@solana/kit";
import {
  SENDER_TIP_ACCOUNTS,
  SENDER_MAX_MIN_TIP_LAMPORTS,
  SWQOS_MIN_TIP_LAMPORTS,
  buildSenderTipInstruction,
  chooseSenderLane,
  lamportsToUsd,
  senderConfigFromEnv,
  senderEndpointForTier,
} from "../src/strategies/liquidation/sender.js";

const LANE_CONFIG = { maxPrizeUsd: 5, maxTipFraction: 0.01, maxTipCapSol: 0.02, minProfitUsd: 0.05, bundle: true };

test("swqos endpoint sets the tier query parameter and max removes it", () => {
  const base = "http://ewr-sender.helius-rpc.com/fast";
  assert.equal(senderEndpointForTier(base, "swqos"), `${base}?swqos_only=true`);
  assert.equal(senderEndpointForTier(`${base}?api-key=k`, "swqos"), `${base}?api-key=k&swqos_only=true`);
  assert.equal(senderEndpointForTier(`${base}?swqos_only=true`, "max"), base);
});

test("small prize takes SWQOS-only, high prize takes Sender Max", () => {
  const swqos = chooseSenderLane({ prizeUsd: 1, solUsd: 150, computeUnitLimit: 1_400_000, config: LANE_CONFIG });
  assert.equal(swqos?.tier, "swqos");
  assert.equal(swqos?.bundle, false);
  assert.equal(swqos?.tipLamports, SWQOS_MIN_TIP_LAMPORTS);

  const max = chooseSenderLane({ prizeUsd: 25, solUsd: 150, computeUnitLimit: 1_400_000, config: LANE_CONFIG });
  assert.equal(max?.tier, "max");
  assert.equal(max?.bundle, true);
  assert.ok((max?.tipLamports ?? 0n) >= SENDER_MAX_MIN_TIP_LAMPORTS);

  // Opt-out keeps Max as a plain (single) submission.
  const maxSingle = chooseSenderLane({ prizeUsd: 25, solUsd: 150, computeUnitLimit: 1_400_000, config: { ...LANE_CONFIG, bundle: false } });
  assert.equal(maxSingle?.tier, "max");
  assert.equal(maxSingle?.bundle, false);
});

test("prize that does not cover the lane cost is refused", () => {
  // SWQOS floor cost is ~$0.002 at $150/SOL; a $0.01 prize leaves $0.008 net,
  // below the $0.05 floor → no lane.
  assert.equal(chooseSenderLane({ prizeUsd: 0.01, solUsd: 150, computeUnitLimit: 1_400_000, config: LANE_CONFIG }), null);
  assert.equal(chooseSenderLane({ prizeUsd: 0, solUsd: 150, computeUnitLimit: 1_400_000, config: LANE_CONFIG }), null);
});

test("high prize falls back to SWQOS when the Max tip would break the floor", () => {
  // A prize just above the Max threshold cannot afford the 0.001 SOL minimum
  // tip plus fees while still leaving the profit floor — it must not pick Max.
  const lane = chooseSenderLane({ prizeUsd: 5, solUsd: 150, computeUnitLimit: 1_400_000, config: LANE_CONFIG });
  assert.equal(lane?.tier, "max");
  const capped = chooseSenderLane({ prizeUsd: 5, solUsd: 150, computeUnitLimit: 1_400_000, config: { ...LANE_CONFIG, minProfitUsd: 4.95 } });
  assert.equal(capped?.tier, "swqos");
});

test("tip never exceeds the fraction cap or the absolute cap", () => {
  const lane = chooseSenderLane({ prizeUsd: 100_000, solUsd: 150, computeUnitLimit: 1_400_000, config: { ...LANE_CONFIG, maxTipFraction: 0.01, maxTipCapSol: 0.02 } });
  assert.equal(lane?.tier, "max");
  assert.ok(lamportsToUsd(lane!.tipLamports, 150) <= 0.02 * 150 + 1e-9);
});

test("sender tip instruction is a SystemProgram transfer to a designated tip account", () => {
  const signer = createNoopSigner(address("11111111111111111111111111111112"));
  const ix = buildSenderTipInstruction({ signer, lamports: 1_000_000n, tipAccountIndex: 0 });
  assert.equal(ix.programAddress, "11111111111111111111111111111111");
  assert.equal(ix.accounts?.length, 2);
  assert.equal(String(ix.accounts?.[1]?.address), SENDER_TIP_ACCOUNTS[0]);
  assert.equal([...(ix.data ?? [])].length, 12);
  assert.equal(Buffer.from(ix.data ?? []).toString("hex"), "0200000040420f0000000000");
});

test("env config parses endpoint, enable flag and thresholds", () => {
  const configured = senderConfigFromEnv({
    HELIUS_SENDER_ENDPOINT: "http://ewr-sender.helius-rpc.com/fast",
    LIQ_SENDER_MAX_PRIZE_USD: "12",
    LIQ_SENDER_MAX_TIP_FRACTION: "0.02",
    LIQ_SENDER_MAX_TIP_CAP_SOL: "0.05",
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.maxPrizeUsd, 12);
  assert.equal(configured.maxTipFraction, 0.02);
  assert.equal(configured.maxTipCapSol, 0.05);
  // Sender Max bundles (Jito-routed) are on by default.
  assert.equal(configured.bundle, true);
  assert.equal(senderConfigFromEnv({ HELIUS_SENDER_ENDPOINT: "http://x/fast", LIQ_SENDER_BUNDLE: "false" }).bundle, false);

  const disabled = senderConfigFromEnv({ HELIUS_SENDER_ENDPOINT: "http://ewr-sender.helius-rpc.com/fast", LIQ_SENDER_ENABLED: "false" });
  assert.equal(disabled.enabled, false);

  const noEndpoint = senderConfigFromEnv({});
  assert.equal(noEndpoint.enabled, false);
});

test("bundle submission rejects empty success responses and invalid bundle counts", async (t) => {
  const { sendViaSenderBundle } = await import("../src/strategies/liquidation/sender.js");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { headers: { "Content-Type": "application/json" } }); });
  await assert.rejects(sendViaSenderBundle({ endpoint: "https://sender.invalid/fast", transactions: ["wire"] }), /no result/);
  await assert.rejects(sendViaSenderBundle({ endpoint: "https://sender.invalid/fast", transactions: Array(6).fill("wire") }), /1–5/);
  assert.equal(requests, 1);
});
