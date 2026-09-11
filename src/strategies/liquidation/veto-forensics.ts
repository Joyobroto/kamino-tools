import { getBase58Encoder } from "@solana/kit";

const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
// Installed SDK V1/V2 discriminators. Both put liquidator and obligation first.
const DISCRIMINATORS = ["b1479abce2854a37", "a2a1238f1ebbb967"];
export interface VetoResolution {
  outcome: "lost-race" | "no-liquidation-found" | "unknown";
  winner?: string;
  feePayer?: string;
  winnerSignature?: string;
  liquidatedAt?: number;
  /** Signed delta; a negative value means liquidation preceded our trigger. */
  raceLostAfterMs?: number;
  slot?: number;
  reason?: string;
}

interface ParsedInstruction { programId?: string; accounts?: string[]; data?: string }
export interface ParsedTransaction {
  blockTime?: number | null;
  slot: number;
  meta?: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: Array<{ instructions: ParsedInstruction[] }> | null;
  } | null;
  transaction?: { message?: {
    accountKeys?: Array<{ pubkey: string }>;
    instructions?: ParsedInstruction[];
  } } | null;
}

/** Match the target in the actual KLend instruction, including wrapper CPIs. */
export function liquidationForObligation(tx: ParsedTransaction, obligation: string): { liquidator: string; feePayer?: string } | null {
  if (!tx.meta || tx.meta.err !== null) return null;
  const instructions = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  for (const ix of instructions) {
    if (ix.programId !== KLEND || ix.accounts?.[1] !== obligation || !ix.data) continue;
    let data: Uint8Array;
    try { data = Uint8Array.from(getBase58Encoder().encode(ix.data)); } catch { continue; }
    if (!DISCRIMINATORS.includes(Buffer.from(data.slice(0, 8)).toString("hex"))) continue;
    const liquidator = ix.accounts[0];
    if (!liquidator) continue;
    const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
    return { liquidator, ...(feePayer ? { feePayer } : {}) };
  }
  return null;
}

interface SignatureEntry { signature: string; blockTime: number | null; err: unknown }

/** Read-only bounded history search. Absence and RPC failure never imply recovery. */
export async function resolveVetoFate(params: {
  rpcUrl: string;
  obligation: string;
  triggeredAtMs: number;
  limit?: number;
  maxPages?: number;
  lookbackMs?: number;
  lookaheadMs?: number;
}): Promise<VetoResolution> {
  const from = params.triggeredAtMs - (params.lookbackMs ?? 30_000);
  const to = params.triggeredAtMs + (params.lookaheadMs ?? 60_000);
  const deadline = AbortSignal.timeout(12_000);
  async function rpc<T>(method: string, args: unknown[]): Promise<T> {
    const response = await fetch(params.rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: args }),
      signal: deadline,
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const json = await response.json() as { result?: T; error?: { code: number } };
    if (json.error || json.result === undefined) throw new Error(`RPC ${method} unavailable`);
    return json.result;
  }
  let before: string | undefined;
  let incomplete = false;
  try {
    for (let page = 0; page < (params.maxPages ?? 3); page++) {
      const signatures = await rpc<SignatureEntry[]>("getSignaturesForAddress", [params.obligation, {
        limit: params.limit ?? 20, commitment: "confirmed", ...(before ? { before } : {}),
      }]);
      if (!signatures.length) return { outcome: incomplete ? "unknown" : "no-liquidation-found" };
      for (const entry of signatures) {
        if (entry.blockTime === null) { incomplete = true; continue; }
        const at = entry.blockTime * 1000;
        if (at < from) return { outcome: incomplete ? "unknown" : "no-liquidation-found" };
        if (at > to || entry.err !== null) continue;
        const tx = await rpc<ParsedTransaction | null>("getTransaction", [entry.signature, {
          encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed",
        }]);
        if (!tx) { incomplete = true; continue; }
        const match = liquidationForObligation(tx, params.obligation);
        if (!match) continue;
        return {
          outcome: "lost-race", winner: match.liquidator,
          ...(match.feePayer ? { feePayer: match.feePayer } : {}),
          winnerSignature: entry.signature, slot: tx.slot,
          liquidatedAt: at, raceLostAfterMs: at - params.triggeredAtMs,
        };
      }
      before = signatures.at(-1)!.signature;
    }
    return { outcome: "unknown", reason: "History page limit reached" };
  } catch {
    return { outcome: "unknown", reason: "RPC unavailable or history incomplete" };
  }
}
