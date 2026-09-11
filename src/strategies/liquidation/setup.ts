import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { address, type Address, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import {
  createLookupTableIx,
  extendLookupTableIxs,
  initLookupTableIx,
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
  rpcUrl: string;
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

  // Phase-3: CLMM pool accounts for the hot collateral↔debt mint pairs —
  // the local-CLMM swap backend's instructions compress against OUR ALT so
  // the liquidation tx stays inside the 1232-byte packet. Tick arrays drift
  // with price; the executor's size guard falls back to Jupiter when the
  // pool moves beyond the cached arrays, so staleness never breaks a fire.
  try {
    const inputMints = new Set(reserves.map((r) => r.getLiquidityMint().toString()));
    const { clmmAltKeys } = await import("./clmm.js");
    // Every unordered reserve-mint pair (the pool PDA normalizes order).
    const mintList = [...inputMints];
    const pairs: Array<{ mintA: string; mintB: string }> = [];
    for (let i = 0; i < mintList.length; i++) {
      for (let j = i + 1; j < mintList.length; j++) pairs.push({ mintA: mintList[i]!, mintB: mintList[j]! });
    }
    if (pairs.length) {
      const clmmKeys = await clmmAltKeys(input.rpcUrl, pairs.slice(0, 21));
      for (const key of clmmKeys) put(key);
    }
  } catch {
    // CLMM keys are best-effort — klend-side ALT coverage is what's critical.
  }
  return [...keys.values()];
}

export interface AltRef {
  lookupTable: string;
  keyCount: number;
}

export interface AltState {
  lookupTable: string;
  createdAt: string;
  authority: string;
  keyCount: number;
  /** Chained companion tables (each ≤256 slots) holding the overflow from
   *  market-wide --all coverage — see buildLiquidationSetup MAX_ALT_KEYS. */
  complements?: AltRef[];
}

/** Primary + all companion tables as address strings (empty when no ALT). */
export function altTableAddresses(state: AltState | null): string[] {
  if (!state) return [];
  return [state.lookupTable, ...(state.complements?.map((c) => c.lookupTable) ?? [])];
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
/** Table slots to fill before rotating to a fresh companion table — well under
 *  the 256-slot hard cap, leaving headroom so a late extend never straddles. */
const MAX_ALT_KEYS = 240;
const EXTEND_CHUNK = 20;

export async function buildLiquidationSetup(input: {
  rpc: Rpc<SolanaRpcApi>;
  market: KaminoMarket;
  reserves: KaminoReserve[];
  signer: TransactionSigner;
  /** The rpc ENDPOINT STRING (kit Rpc.url is a function — unusable as string). */
  rpcUrl: string;
  /** Existing ALT to extend instead of creating a new one. */
  existingLookupTable?: Address;
  /** Keys already in the ALT (skip re-appending them). */
  existingKeys?: Address[];
}): Promise<{ transactions: Instruction[][]; lookupTable: Address; keyCount: number; complements: AltRef[] }> {
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

  // Tx 2..n: extend the ALT(s) in small chunks. An ALT cannot hold duplicate
  // keys, so skip anything already present when reusing. Market-wide coverage
  // (58 reserves ≈ 1000+ keys) exceeds the 256-slot table cap — group the
  // overflow into chained companion tables, each independently ≤ MAX_ALT_KEYS.
  const keys = await liquidationAltKeys({ market, reserves, authority: signer.address, rpcUrl: input.rpcUrl });
  const existing = new Set((input.existingKeys ?? []).map((a) => a.toString()));
  const toAdd = keys.filter((k) => !existing.has(k.toString()));

  const groups: Address[][] = [];
  let group: Address[] = [];
  let groupBudget = MAX_ALT_KEYS - existing.size;
  for (const key of toAdd) {
    if (groupBudget <= 0) {
      groups.push(group);
      group = [];
      groupBudget = MAX_ALT_KEYS;
    }
    group.push(key);
    groupBudget -= 1;
  }
  if (group.length) groups.push(group);

  const companionCreates: Instruction[][] = [];
  const complements: AltRef[] = [];
  const extendTransactions: Instruction[][] = [];
  let tableForGroup: Address = lookupTable;
  // Companion PDAs must be DISTINCT. createLookupTableIx seeds the PDA with the
  // CURRENT finalized slot — two creates back-to-back resolve to the SAME slot
  // (same PDA) and the second create tx fails "already initialized" (seen live
  // on the first --all run). Derive each with an explicit slot offset instead.
  const baseSlot =
    groups.length > 1
      ? (await rpc.getSlot({ commitment: "finalized" }).send())
      : 0n;
  for (let g = 0; g < groups.length; g += 1) {
    const keysIn = groups[g]!;
    if (g > 0) {
      const [createCompanionIx, newTable] = await initLookupTableIx(signer, baseSlot + BigInt(g));
      if (createCompanionIx) companionCreates.push([createCompanionIx]);
      tableForGroup = newTable;
      complements.push({ lookupTable: newTable.toString(), keyCount: keysIn.length });
    }
    for (let i = 0; i < keysIn.length; i += EXTEND_CHUNK) {
      extendTransactions.push(extendLookupTableIxs(signer, tableForGroup, keysIn.slice(i, i + EXTEND_CHUNK), signer));
    }
  }
  const transactions = [...ataTransactions, ...companionCreates, ...extendTransactions].filter((tx) => tx.length > 0);
  return { transactions, lookupTable, keyCount: keys.length, complements };
}