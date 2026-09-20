import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { address, type Address, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import {
  createLookupTableIx,
  extendLookupTableIxs,
  getTokenIdsForScopeRefresh,
  initLookupTableIx,
  type KaminoMarket,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@solana/sysvars";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { deriveAssociatedTokenAccount, fetchTokenAccount, createAtaInstruction, rpcClient } from "../../kamino.js";
import { getCachedScopeConfigurations } from "./hotcache.js";
import { SENDER_TIP_ACCOUNTS } from "./sender.js";

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
  const put = (a: Address | string | null | undefined) => {
    if (!a) return;
    keys.set(String(a), address(String(a)));
  };

  put(authority);
  put(market.getAddress());
  put(market.programId);
  put(market.farmsProgramId);
  put(SYSVAR_INSTRUCTIONS_ADDRESS);
  // The lending-market authority PDA is a writable account on every flash
  // borrow/repay and Liquidate V2 — static per market, so ALT-compress it.
  const lendingMarketAuthority = await market.getLendingMarketAuthority?.();
  if (lendingMarketAuthority) put(lendingMarketAuthority);

  // Helius Sender tip accounts — when the Sender execution lane is enabled the
  // tip transfer adds one writable destination to every fire; compressing the
  // ten candidates keeps the packet inside 1232 bytes.
  for (const tipAccount of SENDER_TIP_ACCOUNTS) put(tipAccount);

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

    // Reserve farm state — every liquidation tx that touches a farm-joined
    // reserve (Liquidate V2 collateral/debt farms) references it inline; it is
    // static per reserve, so it belongs in the ALT. The obligation-side farm
    // PDA varies per obligation and stays inline (unavoidable).
    const debtFarm = reserve.getDebtFarmAddress?.();
    if (debtFarm?.__option === "Some") put(debtFarm.value);
    const collateralFarm = reserve.getCollateralFarmAddress?.();
    if (collateralFarm?.__option === "Some") put(collateralFarm.value);

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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    );
  }

  // Scope oracle refresh — fires prepend a RefreshPriceList ix (mirroring the
  // refresh-keeper pattern) whose account list carries the Scope program, the
  // config, the oraclePrices account and one feed per token-chain. Those are
  // governance-static and identical for every fire over the same reserves, yet
  // were previously inlined, pushing multi-reserve sandwich txs past the
  // 1232-byte packet. Enumerate them exactly as the executor does so the ALT
  // covers them.
  try {
    const { Scope, SCOPE_PROGRAM_ADDRESS } = await import("@kamino-finance/scope-sdk");
    const rpc = rpcClient(input.rpcUrl);
    const scope = new Scope("mainnet-beta", rpc as never);
    const reserveAddresses = reserves.map((r) => r.address);
    const tokenIdsByPrices = getTokenIdsForScopeRefresh(market, reserveAddresses);
    const feedsInPlay = new Set(
      reserves
        .map((r) => r.state.config.tokenInfo.scopeConfiguration.priceFeed)
        .filter((feed): feed is Address => Boolean(feed) && feed !== "11111111111111111111111111111111")
        .map((feed) => feed.toString()),
    );
    const scopeConfigurations = await getCachedScopeConfigurations(rpc);
    put(SCOPE_PROGRAM_ADDRESS);
    // The RefreshPriceList instruction embeds the config + oraclePrices accounts
    // plus one feed per token-chain; the feeds themselves are already recorded
    // per-reserve above, so we only need the governance-static config/prices
    // accounts here. NOTE: do not build the market-wide ix to enumerate them —
    // a full-market refresh carries >255 token ids and the SDK's u8 vec codec
    // refuses it.
    for (const [configPubkey, config] of scopeConfigurations) {
      if (!feedsInPlay.has(String(config.oraclePrices))) continue;
      const tokenIds = [...new Set(tokenIdsByPrices.get(address(String(config.oraclePrices))) ?? [])];
      if (!tokenIds.length) continue;
      put(configPubkey as string);
      put(config.oraclePrices as string);
      const feed = config as { oracleMappings?: string; oracleTwaps?: string };
      put(feed.oracleMappings);
      put(feed.oracleTwaps);
      // Enumerate the actual refresh accounts per reserve. Passing every token
      // in the market to one instruction can overflow the SDK's u8 vector.
      for (const reserve of reserves) {
        const ids = [...new Set(getTokenIdsForScopeRefresh(market, [reserve.address]).get(address(String(config.oraclePrices))) ?? [])];
        if (!ids.length) continue;
        const ix = await scope.refreshPriceListIx({ config: configPubkey as never }, ids);
        if (ix) for (const account of ix.accounts ?? []) put(account.address);
      }
    }
  } catch {
    // Scope keys are best-effort — pyth/switchboard-only markets don't use them.
  }

  // Phase-3: CLMM pool accounts for the hot collateral↔debt mint pairs —
  // the local-CLMM swap backend's instructions compress against OUR ALT so
  // the liquidation tx stays inside the 1232-byte packet. Tick arrays drift
  // with price; rerun setup to extend coverage when the packet guard reports
  // uncovered accounts. Cover every reserve pair, not an arbitrary first 21.
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
      const clmmKeys = await clmmAltKeys(input.rpcUrl, pairs);
      for (const key of clmmKeys) put(key);
    }
  } catch (error) {
    console.warn(`CLMM ALT coverage incomplete: ${error instanceof Error ? error.message : "pool discovery failed"}`);
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
  /** Existing companion tables to extend instead of creating new PDAs (resume
   *  support after an aborted --all run — companion PDAs are slot-derived, so a
   *  fresh run would otherwise mint brand-new junk tables). */
  existingCompanionAlts?: Address[];
  /** Keys already in the ALT (skip re-appending them). */
  existingKeys?: Address[];
  /** Number of addresses already stored in the primary and companion tables. */
  existingTableKeyCounts?: number[];
  /** Skip ATA pre-creation (--all market-wide: non-essential — the executor
   *  creates any missing ATA inside the fire's setupInstructions anyway, and the
   *  pre-creation batches were clogging the pipeline with retry storms). */
  skipAta?: boolean;
}): Promise<{ transactions: Instruction[][]; lookupTable: Address; keyCount: number; complements: AltRef[]; kinds: string[] }> {
  const { rpc, market, reserves, signer } = input;
  let createIx: Instruction | null = null;
  let lookupTable = input.existingLookupTable;
  if (!lookupTable) [createIx, lookupTable] = await createLookupTableIx(rpc, signer);

  // Tx 1..n: create ALT (first tx) + pre-create ATAs in small batches (each
  // create-ATA ix carries ~7 accounts — keep every tx well under the packet size).
  const ataBatches: Instruction[][] = [];
  const current: Instruction[] = [];
  if (!input.skipAta) {
    for (const reserve of reserves) {
      for (const mint of [reserve.getLiquidityMint(), reserve.getCTokenMint()]) {
        // Kamino collateral mints use SPL Token even when liquidity is Token-2022.
        const tokenProgram = mint === reserve.getCTokenMint() ? TOKEN_PROGRAM_ADDRESS : reserve.getLiquidityTokenProgram();
        const ata = address(
          await deriveAssociatedTokenAccount({
            mint,
            owner: signer.address,
            tokenProgram,
          }),
        );
        const exists = await fetchTokenAccount(rpc, ata.toString());
        if (!exists) {
          const ix = await createAtaInstruction({
            payer: signer,
            mint,
            owner: signer.address,
            tokenProgram,
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
  }
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

  const companionCreates: Instruction[][] = [];
  const extendTransactions: Instruction[][] = [];
  const existingTables: Address[] = [
    lookupTable,
    ...(input.existingCompanionAlts ?? []),
  ];
  const existingCounts = input.existingTableKeyCounts ?? [existing.size];
  const tableGroups: Array<{ table: Address; keys: Address[]; companion: boolean }> = [];
  let tableIndex = 0;
  let group: Address[] = [];
  let groupBudget = Math.max(0, MAX_ALT_KEYS - (existingCounts[tableIndex] ?? 0));
  for (const key of toAdd) {
    while (groupBudget <= 0 && tableIndex < existingTables.length) {
      if (group.length) tableGroups.push({ table: existingTables[tableIndex]!, keys: group, companion: tableIndex > 0 });
      tableIndex += 1;
      group = [];
      groupBudget = Math.max(0, MAX_ALT_KEYS - (existingCounts[tableIndex] ?? 0));
    }
    if (tableIndex >= existingTables.length) {
      if (group.length) {
        tableGroups.push({ table: address("11111111111111111111111111111111"), keys: group, companion: true });
        group = [];
      }
      groupBudget = MAX_ALT_KEYS;
    }
    group.push(key);
    groupBudget -= 1;
  }
  if (group.length) {
    tableGroups.push({ table: tableIndex < existingTables.length ? existingTables[tableIndex]! : address("11111111111111111111111111111111"), keys: group, companion: tableIndex > 0 });
  }

  const complements: AltRef[] = (input.existingCompanionAlts ?? []).map((table, index) => ({
    lookupTable: table.toString(),
    keyCount: existingCounts[index + 1] ?? 0,
  }));
  let newCompanionNumber = 0;
  // Companion PDAs must be DISTINCT. createLookupTableIx seeds the PDA with the
  // CURRENT finalized slot — two creates back-to-back resolve to the SAME slot
  // (same PDA) and the second create tx fails "already initialized" (seen live
  // on the first --all run). Derive each with an explicit slot offset instead.
  const baseSlot =
    tableGroups.some((g) => g.table.toString() === "11111111111111111111111111111111")
      ? (await rpc.getSlot({ commitment: "finalized" }).send())
      : 0n;
  for (const tableGroup of tableGroups) {
    let tableForGroup = tableGroup.table;
    if (tableForGroup.toString() === "11111111111111111111111111111111") {
      newCompanionNumber += 1;
      const [createCompanionIx, newTable] = await initLookupTableIx(signer, baseSlot - BigInt(newCompanionNumber));
      if (createCompanionIx) companionCreates.push([createCompanionIx]);
      tableForGroup = newTable;
      complements.push({ lookupTable: tableForGroup.toString(), keyCount: tableGroup.keys.length });
    } else if (tableGroup.companion && !complements.some((c) => c.lookupTable === tableForGroup.toString())) {
      complements.push({ lookupTable: tableForGroup.toString(), keyCount: tableGroup.keys.length });
      console.log(`  reuse companion table ${tableForGroup.toString()}`);
    }
    for (let i = 0; i < tableGroup.keys.length; i += EXTEND_CHUNK) {
      extendTransactions.push(extendLookupTableIxs(signer, tableForGroup, tableGroup.keys.slice(i, i + EXTEND_CHUNK), signer));
    }
  }
  // kinds MUST mirror the exact ordering of `transactions` below — keep them in
  // the same array order or the per-tx labels lie (seen live: log mismatches).
  const transactions = [...ataTransactions, ...companionCreates, ...extendTransactions].filter((tx) => tx.length > 0);
  const kinds = [
    ...ataTransactions.map(() => "ata"),
    ...companionCreates.map(() => "create"),
    ...extendTransactions.map(() => "extend"),
  ];
  return { transactions, lookupTable, keyCount: keys.length, complements, kinds };
}
