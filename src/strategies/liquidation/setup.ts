import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { address, type Address, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import {
  createLookupTableIx,
  extendLookupTableIxs,
  type KaminoMarket,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@solana/sysvars";
import { deriveAssociatedTokenAccount, fetchTokenAccount, createAtaInstruction } from "../../kamino.js";

export const ALT_STATE_PATH = process.env.LIQ_ALT_STATE ?? "data/liq_alt.json";

/** Static klend-side addresses every liquidation tx touches (compressed via our ALT). */
export async function liquidationAltKeys(input: {
  market: KaminoMarket;
  reserves: KaminoReserve[];
  authority: Address;
}): Promise<Address[]> {
  const { market, reserves, authority } = input;
  const keys = new Map<string, Address>();
  const put = (a: Address | string) => keys.set(String(a), address(String(a)));

  put(authority);
  put(market.getAddress());
  put(market.programId);
  put(market.farmsProgramId);
  put(SYSVAR_INSTRUCTIONS_ADDRESS);

  for (const reserve of reserves) {
    put(reserve.address);
    put(reserve.state.lendingMarket);
    put(reserve.getLiquidityMint());
    put(reserve.getCTokenMint());
    put(reserve.state.liquidity.supplyVault);
    put(reserve.state.liquidity.feeVault);
    put(reserve.state.collateral.supplyVault);
    put(reserve.getLiquidityTokenProgram());
    const tokenInfo = reserve.state.config.tokenInfo;
    const scopeFeed = tokenInfo.scopeConfiguration.priceFeed;
    if (scopeFeed && scopeFeed !== "11111111111111111111111111111111") put(scopeFeed);
    const pyth = tokenInfo.pythConfiguration?.price;
    if (pyth && pyth !== "11111111111111111111111111111111") put(pyth);
    const sbPrice = tokenInfo.switchboardConfiguration?.priceAggregator;
    if (sbPrice && sbPrice !== "11111111111111111111111111111111") put(sbPrice);
    const sbTwap = tokenInfo.switchboardConfiguration?.twapAggregator;
    if (sbTwap && sbTwap !== "11111111111111111111111111111111") put(sbTwap);

    // Our ATAs (liquidity + cToken) — pre-created and ALT-compressed.
    put(
      await deriveAssociatedTokenAccount({
        mint: reserve.getLiquidityMint(),
        owner: authority,
        tokenProgram: reserve.getLiquidityTokenProgram(),
      }),
    );
    put(
      await deriveAssociatedTokenAccount({
        mint: reserve.getCTokenMint(),
        owner: authority,
        tokenProgram: reserve.getLiquidityTokenProgram(),
      }),
    );
  }
  return [...keys.values()];
}

export interface AltState {
  lookupTable: string;
  createdAt: string;
  authority: string;
  keyCount: number;
}

export function loadAltState(path: string = ALT_STATE_PATH): AltState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AltState;
  } catch {
    return null;
  }
}

export function saveAltState(state: AltState, path: string = ALT_STATE_PATH): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

/**
 * One-time setup: creates our persistent ALT (or extends the one given) and
 * pre-creates the hot ATAs. Returns SEPARATE transactions (each fits the packet
 * size — an ALT-extend carries its full key list inline).
 */
export async function buildLiquidationSetup(input: {
  rpc: Rpc<SolanaRpcApi>;
  market: KaminoMarket;
  reserves: KaminoReserve[];
  signer: TransactionSigner;
  /** Existing ALT to extend instead of creating a new one. */
  existingLookupTable?: Address;
  /** Keys already in the ALT (skip re-appending them). */
  existingKeys?: Address[];
}): Promise<{ transactions: Instruction[][]; lookupTable: Address; keyCount: number }> {
  const { rpc, market, reserves, signer } = input;
  let createIx: Instruction | null = null;
  const lookupTable = input.existingLookupTable ?? (await createLookupTableIx(rpc, signer))[1];
  if (!input.existingLookupTable) {
    [createIx] = await createLookupTableIx(rpc, signer);
  }

  // Tx 1..n: create ALT (first tx) + pre-create ATAs in small batches (each
  // create-ATA ix carries ~7 accounts — keep every tx well under the packet size).
  const ataBatches: Instruction[][] = [];
  const current: Instruction[] = [];
  for (const reserve of reserves) {
    for (const mint of [reserve.getLiquidityMint(), reserve.getCTokenMint()]) {
      const ata = address(
        await deriveAssociatedTokenAccount({
          mint,
          owner: signer.address,
          tokenProgram: reserve.getLiquidityTokenProgram(),
        }),
      );
      const exists = await fetchTokenAccount(rpc, ata.toString());
      if (!exists) {
        const ix = await createAtaInstruction({
          payer: signer,
          mint,
          owner: signer.address,
          tokenProgram: reserve.getLiquidityTokenProgram(),
          ata,
        });
        current.push(ix);
        if (current.length >= 5) {
          ataBatches.push([...current]);
          current.length = 0;
        }
      }
    }
  }
  if (current.length) ataBatches.push([...current]);
  const ataTransactions: Instruction[][] = createIx
    ? [[createIx, ...(ataBatches.shift() ?? [])], ...ataBatches]
    : ataBatches;

  // Tx 2..n: extend the ALT in small chunks. An ALT cannot hold duplicate keys,
  // so skip anything already present when reusing.
  const keys = await liquidationAltKeys({ market, reserves, authority: signer.address });
  const existing = new Set((input.existingKeys ?? []).map((a) => a.toString()));
  const toAdd = keys.filter((k) => !existing.has(k.toString()));
  const CHUNK = 20;
  const extendTransactions: Instruction[][] = [];
  for (let i = 0; i < toAdd.length; i += CHUNK) {
    extendTransactions.push(extendLookupTableIxs(signer, lookupTable, toAdd.slice(i, i + CHUNK), signer));
  }
  const transactions = [...ataTransactions, ...extendTransactions].filter((tx) => tx.length > 0);
  return { transactions, lookupTable, keyCount: keys.length };
}