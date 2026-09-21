import { Buffer } from "node:buffer";
import type { Address } from "@solana/kit";
import { parseObligationSlice } from "./screener.js";

const OBLIGATION_ACCOUNT_SIZE = 3344n;
const SLICE_OFFSET = 2208;
const SLICE_LENGTH = 130;
export interface WsObligationSlice {
  pubkey: Address;
  debtSf: bigint;
  unhealthySf: bigint;
  adlTargetLtvPct: number;
  adlMarginCallTs: number;
  /** Cached health factor (unhealthy/debt) from the notification. */
  cachedHealth: number;
  /** Preserve the already-delivered account for execution; no second account RPC. */
  accountData?: Buffer;
  slot?: bigint;
  receivedAt?: number;
}

/**
 * Parses the full 3344-byte obligation account (as delivered by account
 * notifications) into the same health slice the GPA snapshot uses.
 */
export function parseFullObligationAccount(dataBase64: string, pubkey: Address, slot?: bigint): WsObligationSlice {
  const full = Buffer.from(dataBase64, "base64");
  if (full.length !== Number(OBLIGATION_ACCOUNT_SIZE)) {
    throw new Error(`Unexpected obligation account length ${full.length}`);
  }
  const slice = full.subarray(SLICE_OFFSET, SLICE_OFFSET + SLICE_LENGTH).toString("base64");
  const parsed = parseObligationSlice(slice);
  return { pubkey, ...parsed, cachedHealth: healthFactorFromParsed(parsed), accountData: full, receivedAt: Date.now(), ...(slot !== undefined ? { slot } : {}) };
}

export function healthFactorFromParsed(parsed: { debtSf: bigint; unhealthySf: bigint }): number {
  if (parsed.debtSf <= 0n) return Number.POSITIVE_INFINITY;
  return Number(parsed.unhealthySf) / Number(parsed.debtSf);
}
