import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { address } from "@solana/kit";
import { parseFullObligationAccount } from "../src/strategies/liquidation/ws-realtime.js";

const TEST_ADDR = address("11111111111111111111111111111111");

function makeObligationBuffer(overrides: { debtSf?: bigint; unhealthySf?: bigint; adlTargetLtvPct?: number; adlMarginCallTs?: bigint }): Buffer {
  const buf = Buffer.alloc(3344);
  const base = 2208;
  buf.writeBigUInt64LE(overrides.debtSf ?? 100n, base + 0);
  buf.writeBigUInt64LE(0n, base + 8);
  buf.writeBigUInt64LE(overrides.unhealthySf ?? 80n, base + 48);
  buf.writeBigUInt64LE(0n, base + 56);
  buf.writeUInt8(overrides.adlTargetLtvPct ?? 0, base + 113);
  buf.writeBigUInt64LE(overrides.adlMarginCallTs ?? 0n, base + 120);
  return buf;
}

test("parseFullObligationAccount extracts slice and computes cachedHealth", () => {
  const slice = parseFullObligationAccount(makeObligationBuffer({ debtSf: 100n, unhealthySf: 80n }).toString("base64"), TEST_ADDR);
  assert.equal(slice.cachedHealth, 0.8);
  assert.equal(slice.debtSf, 100n);
  assert.equal(slice.unhealthySf, 80n);
  assert.equal(slice.adlTargetLtvPct, 0);
});

test("parseFullObligationAccount reports infinite health for zero debt", () => {
  const slice = parseFullObligationAccount(makeObligationBuffer({ debtSf: 0n, unhealthySf: 10n }).toString("base64"), TEST_ADDR);
  assert.equal(slice.cachedHealth, Number.POSITIVE_INFINITY);
});

test("adlTargetLtvPct is forwarded from the slice", () => {
  const buf = makeObligationBuffer({ adlTargetLtvPct: 90 });
  const slice = parseFullObligationAccount(buf.toString("base64"), TEST_ADDR);
  assert.equal(slice.adlTargetLtvPct, 90);
});

test("parseFullObligationAccount rejects wrong-length payloads", () => {
  assert.throws(() => parseFullObligationAccount(Buffer.alloc(100).toString("base64"), TEST_ADDR), /Unexpected obligation account length/);
});