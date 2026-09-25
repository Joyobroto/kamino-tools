#!/usr/bin/env node
import { getClmmQuoter } from "./strategies/liquidation/clmm.js";
import { writeHeartbeat } from "./strategies/liquidation/health.js";
import { createTaskQueue } from "./strategies/liquidation/pipeline.js";
import { config as loadEnv } from "dotenv";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { Command } from "commander";
import "./quiet-bigint.js";
import { address, createNoopSigner, getSignatureFromTransaction, type Instruction } from "@solana/kit";
import { formatTokenAmount, parseTokenAmount } from "./amount.js";
import {
  configuredValue,
  DEFAULT_RPC,
  loadWalletSigner,
  MAIN_MARKET,
  privateKeyFromEnv,
} from "./config.js";
import {
  buildFlashLoan,
  createAtaInstruction,
  deriveAssociatedTokenAccount,
  fetchTokenAccount,
  loadMarket,
  reserveDisplaySymbol,
  reserveMatchesAsset,
  reserveSummary,
  rpcClient,
  selectReserve,
} from "./kamino.js";
import { instructionSummary, loadStrategy, externalInstructionsToStrategy } from "./strategy.js";
import { createSignedTransaction, createSignedTransactionWithAlt, sendAndConfirm, sendAndConfirmPoll, simulate, transactionReceipt } from "./transaction.js";
import { scanOnce, preloadMarket, refreshTrackedObligations, valuationSnapshotKeys, seedValuationSnapshots, type PreloadedMarket, type StreamAccountSnapshot } from "./strategies/liquidation/screener.js";
import { HotTracker, type TrackerEvent } from "./strategies/liquidation/tracker.js";
import { executeLiquidationOnce } from "./strategies/liquidation/execute.js";
import { senderConfigFromEnv, warmSenderConnection } from "./strategies/liquidation/sender.js";
import { broadcastLiquidation } from "./strategies/liquidation/execution-lane.js";
import { subscribeTrackedObligations, type TrackedWsHandle } from "./strategies/liquidation/tracked-ws.js";
import { altTableAddresses, buildLiquidationSetup, loadAltState, saveAltState, ALT_STATE_PATH } from "./strategies/liquidation/setup.js";
import { deactivateLookupTableIx, closeLookupTableIx } from "@kamino-finance/klend-sdk";
import { getCloseAccountInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getAccountsInLut } from "@kamino-finance/klend-sdk";
import type { KaminoObligation, KaminoReserve } from "@kamino-finance/klend-sdk";
import type { ScanEvent, ScanResult, LiquidatableCandidate, AdlCandidate } from "./strategies/liquidation/types.js";
import { type ScanOptions as LiquidationScanConfig } from "./strategies/liquidation/types.js";
import {
  TelegramAlerter,
  telegramConfigFromEnv,
  startupAlert,
  surgeAlert,
  testAlert,
  trackerEventToAlert,
  executionAlert, // kept for test compat
  profitAlert,
  liquidationQuoteAlert,
  liquidationFailedAlert,
  budgetPausedAlert,
  heartbeatAlert,
  wsRailAlert,
  dueAttemptAlert,
} from "./alerts/telegram.js";
import { DEFAULT_AUTOFIRE_OPTIONS, evaluateFireGuards, loadLedger, logLedgerEntry, type AutofireOptions } from "./strategies/arb/autofire.js";
import { failoverHealth } from "./rpc-failover.js";
import { resolveVetoFate } from "./strategies/liquidation/veto-forensics.js";
import { OracleFeedCache, marketOracleFeeds, subscribeOracleFeeds } from "./strategies/liquidation/oracle-realtime.js";
import { planLstArb, fetchSwapInstructions, applySlippage } from "./strategies/arb/lst-arb.js";
import {
  centerBlock,
  color,
  printBanner,
  printError,
  printMenu,
  printPlanSummary,
  Prompter,
  renderTable,
  safeJsonStringify,
  terminalLink,
} from "./ui.js";

loadEnv({ quiet: true });

interface LoanOptions {
  rpc: string;
  market: string;
  asset?: string;
  reserve?: string;
  amount: string;
  tokenAccount?: string;
  strategy?: string;
  keypair?: string;
  yes?: boolean;
  json?: boolean;
}

interface ReserveOptions {
  rpc: string;
  market: string;
  asset?: string;
  json: boolean;
}

interface ScanOptions {
  rpc: string;
  market: string;
  minDebt: string;
  maxDebt: string;
  profitFloor: string;
  healthWatch: string;
  nearMiss: string;
  watch: boolean;
  interval: string;
  hotInterval: string;
  hotBand: string;
  maxHotWatch: string;
  log?: string;
  trace?: string;
  json: boolean;
  execute: boolean;
  broadcast: boolean;
  minProfit: string;
  minPrize: string;
  slippageBps: string;
  maxAttemptsPerDay: string;
  maxLossPerDay: string;
  ledger: string;
  stopFile: string;
  fast: boolean;
  priorityMode: string;
  raceTolerance: string;
  ws?: string;
  sender: boolean;
  senderEndpoint: string;
  senderMaxPrize: string;
  senderMaxTipFraction: string;
  senderMaxTipCapSol: string;
}

function validateScanConfig(config: LiquidationScanConfig): void {
  if (!Number.isFinite(config.minDebtUsd) || config.minDebtUsd < 0) throw new Error("--min-debt must be a non-negative number (0 disables the band)");
  if (!Number.isFinite(config.maxDebtUsd) || config.maxDebtUsd < 0) throw new Error("--max-debt must be a non-negative number (0 disables the band)");
  if (config.minDebtUsd > 0 && config.maxDebtUsd > 0 && config.maxDebtUsd < config.minDebtUsd) throw new Error("--max-debt must be >= --min-debt");
  if (!Number.isFinite(config.profitFloorUsd) || config.profitFloorUsd < 0) throw new Error("--profit-floor must be a non-negative number");
  if (!Number.isFinite(config.healthWatch) || config.healthWatch < 1) throw new Error("--health-watch must be >= 1");
  if (!Number.isFinite(config.nearMissHealth) || config.nearMissHealth < 1) throw new Error("--near-miss must be >= 1");
  if (config.nearMissHealth < 1 || config.nearMissHealth > config.healthWatch) throw new Error("--near-miss must be between 1 and --health-watch");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendScanEvent(path: string, event: ScanEvent): void {
  appendFileSync(path, `${safeJsonStringify(event)}\n`);
}

function printCandidateLine(candidate: LiquidatableCandidate, label: string): string {
  return [
    `${label}`,
    `OBLIGATION=${color.cyan(candidate.obligation)}`,
    `HEALTH=${color.white(candidate.healthFactor.toFixed(4))}`,
    `DEBT=${color.yellow(`${(candidate.repayDebt ?? candidate.largestDebt).amountUsd.toFixed(2)} ${(candidate.repayDebt ?? candidate.largestDebt).symbol}`)}`,
    `EST.MARGIN=${color.green(`${(candidate.estimatedProfitUsd ?? 0).toFixed(2)} USD`)}`,
    color.dim(`COLLATERAL=${candidate.collateralSymbols.join(",") || "n/a"}`),
  ].join("  ");
}

function localTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function printAdlLine(candidate: AdlCandidate): string {
  return [
    `OBLIGATION=${color.cyan(candidate.obligation)}`,
    `LTV=${color.white(`${candidate.currentLtvPct.toFixed(1)}%`)}`,
    `ADL TARGET=${color.magenta(`${candidate.adlTargetLtvPct}%`)}`,
    color.dim(`MARGIN-CALL AGE=${candidate.marginCallAgeHours}h`),
    `DEBT=${color.yellow(`${(candidate.repayDebt ?? candidate.largestDebt).amountUsd.toFixed(2)} ${(candidate.repayDebt ?? candidate.largestDebt).symbol}`)}`,
    color.dim(`COLLATERAL=${candidate.collateralSymbols.join(",") || "n/a"}`),
  ].join("  ");
}

function printScanPanel(cycle: number, result: ScanResult, scanNearMissBand: number, detailNearMiss: boolean): void {
  const { liquidatable, nearMiss, adlMarked, stats } = result;
  // One-liner per scan. The cycle # prefix is dropped — "cycle #N scanning…"
  // already announced it above; here only the timestamp + outcome matter.
  // Skip-filters only list their NON-ZERO counts (out-of-band/below-floor
  // are always 0 in this market's config — noise dropped from the line).
  const skips: string[] = [];
  if (stats.nonVanilla) skips.push(`${stats.nonVanilla} non-vanilla`);
  if (stats.healthy) skips.push(`${stats.healthy} healthy`);
  if (stats.outOfBand) skips.push(`${stats.outOfBand} out of band`);
  if (stats.noFlashDebt) skips.push(`${stats.noFlashDebt} no flash debt`);
  if (stats.staleOracle) skips.push(`${stats.staleOracle} stale oracle`);
  if (stats.belowFloor) skips.push(`${stats.belowFloor} below floor`);
  const skipCell = skips.length ? color.dim(`  ·  ${skips.join(" · ")}`) : "";
  console.log(
    color.dim(`[${localTimestamp(result.scannedAt)}]`) +
    color.bold(color.cyan(` scanned=${result.obligationsScanned} hydrated=${result.shortlistScanned}`)) +
    (liquidatable.length ? color.bold(color.red(`  ⚡ DUE=${liquidatable.length}`)) : "") +
    (adlMarked.length ? color.bold(color.magenta(`  ADL=${adlMarked.length}`)) : "") +
    skipCell,
  );

  // Detail panels only when non-zero (counts already travel in the one-liner
  // above; the WATCHBOARD carries the live cohort status every cycle anyway).
  if (adlMarked.length) {
    adlMarked.forEach((candidate) => console.log(printAdlLine(candidate)));
  }

  if (liquidatable.length) {
    // Cap the panel — in a dust/spray market dozens of ~$0.50 positions sit DUE every
    // scan; printing all of them floods the log while adding nothing. Show the
    // biggest prizes first + a truncation line.
    const sorted = [...liquidatable].sort((a, b) => (b.estimatedProfitUsd ?? 0) - (a.estimatedProfitUsd ?? 0));
    sorted.slice(0, 15).forEach((candidate, index) => console.log(printCandidateLine(candidate, color.red(`[${index + 1}]`))));
    if (liquidatable.length > 15) console.log(color.dim(`  … and ${liquidatable.length - 15} more`));
  }

  if (nearMiss.length) {
    // Watch-mode: the WATCHBOARD panel below already carries this cohort with
    // LIVE status (WS + hot ticks merged), so here only the count — no duplicate
    // listing. Single-scan mode (no --watch) keeps the detailed list.
    if (detailNearMiss) {
      console.log(color.bold(color.yellow(`⚠ NEAR MISS (health 1.00–${scanNearMissBand.toFixed(2)}): ${nearMiss.length}`)));
      nearMiss.slice(0, 10).forEach((candidate, index) => console.log(printCandidateLine(candidate, color.yellow(`[${index + 1}]`))));
      if (nearMiss.length > 10) console.log(color.dim(`  … and ${nearMiss.length - 10} more`));
    } else if (nearMiss.length) {
      console.log(color.yellow(`⚠ NEAR MISS (health 1.00–${scanNearMissBand.toFixed(2)}): ${nearMiss.length}`) + color.dim("  → see WATCHBOARD below for live status"));
    }
  }
}

function loanOptions(command: Command, needsKeypair: boolean): Command {
  command
    .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
    .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
    .option("--asset <symbol>", "reserve token symbol, for example USDC")
    .option("--reserve <address>", "exact reserve address; preferred when symbols are duplicated")
    .requiredOption("--amount <tokens>", "flash-loan amount in token units")
    .option("--token-account <address>", "override the automatically derived wallet ATA")
    .option("--strategy <path>", "JSON file containing atomic strategy instructions")
    .option("--json", "print machine-readable JSON", false);
  if (needsKeypair) command.option("--keypair <path>", "fallback Solana keypair JSON (PRIVATE_KEY env takes priority)", configuredValue(process.env.KEYPAIR_PATH));
  return command;
}

async function prepare(options: LoanOptions, withSecret: boolean) {
  const rpc = rpcClient(options.rpc);
  const market = await loadMarket(rpc, options.market);
  const reserve = selectReserve(market, options);
  const requestedTokenAccount = configuredValue(options.tokenAccount);
  const privateKey = privateKeyFromEnv();
  const keypairPath = configuredValue(options.keypair) ?? configuredValue(process.env.KEYPAIR_PATH);
  const walletSigner = withSecret || !requestedTokenAccount
    ? await loadWalletSigner({ privateKey, keypairPath })
    : undefined;
  const tokenAccountAddress = address(requestedTokenAccount ?? await deriveAssociatedTokenAccount({
    mint: reserve.getLiquidityMint(),
    owner: walletSigner!.address,
    tokenProgram: reserve.getLiquidityTokenProgram(),
  }));
  const existingTokenAccount = await fetchTokenAccount(rpc, tokenAccountAddress);
  if (!existingTokenAccount && requestedTokenAccount) {
    throw new Error(`Override token account ${tokenAccountAddress} belum ada on-chain; hapus --token-account agar ATA dibuat otomatis`);
  }
  const tokenAccount = existingTokenAccount ?? {
    address: tokenAccountAddress,
    mint: reserve.getLiquidityMint(),
    owner: walletSigner!.address,
    amount: 0n,
    decimals: reserve.getMintDecimals(),
  };
  const signer = withSecret ? walletSigner! : createNoopSigner(walletSigner?.address ?? tokenAccount.owner);
  const setupInstructions = existingTokenAccount ? [] : [await createAtaInstruction({
    payer: signer,
    mint: tokenAccount.mint,
    owner: tokenAccount.owner,
    tokenProgram: reserve.getLiquidityTokenProgram(),
    ata: tokenAccount.address,
  })];
  const strategy = await loadStrategy(options.strategy, signer);
  const amountBaseUnits = parseTokenAmount(options.amount, reserve.getMintDecimals());
  const build = await buildFlashLoan({
    market,
    reserve,
    signer,
    tokenAccount,
    amountBaseUnits,
    strategy,
    setupInstructions,
  });
  const summary = {
    network: "solana-mainnet-beta",
    rpc: options.rpc,
    market: market.getAddress(),
    wallet: signer.address,
    tokenAccount: tokenAccount.address,
    tokenAccountStatus: existingTokenAccount ? "EXISTING" : "CREATE AUTOMATICALLY",
    asset: reserveDisplaySymbol(reserve),
    reserve: reserve.address,
    mint: reserve.getLiquidityMint(),
    amount: formatTokenAmount(amountBaseUnits, reserve.getMintDecimals()),
    amountBaseUnits: amountBaseUnits.toString(),
    estimatedFee: formatTokenAmount(build.feeBaseUnits, reserve.getMintDecimals()),
    estimatedFeeBaseUnits: build.feeBaseUnits.toString(),
    initialTokenBalance: formatTokenAmount(tokenAccount.amount, reserve.getMintDecimals()),
    initialTokenBalanceBaseUnits: tokenAccount.amount.toString(),
    feeShortfall: formatTokenAmount(
      tokenAccount.amount >= build.feeBaseUnits ? 0n : build.feeBaseUnits - tokenAccount.amount,
      reserve.getMintDecimals(),
    ),
    feeShortfallBaseUnits: (tokenAccount.amount >= build.feeBaseUnits ? 0n : build.feeBaseUnits - tokenAccount.amount).toString(),
    strategy: strategy.name,
    borrowInstructionIndex: build.borrowInstructionIndex,
    repayInstructionIndex: build.instructions.length - 1,
    instructions: build.instructions.map(instructionSummary),
    warning:
      !existingTokenAccount && strategy.instructions.length === 0
        ? "ATA will be created automatically, but a no-op strategy still needs enough token balance to pay the flash-loan fee."
        : strategy.instructions.length === 0
        ? "No-op flash loan: the token account must already contain enough tokens to pay the fee."
        : "Strategy must leave principal plus fee in the configured token account before repay.",
  };
  return { rpc, signer, build, summary };
}

function assertNoOpRepayable(summary: Record<string, unknown>): void {
  if (summary.strategy !== "no-op") return;
  const shortfall = BigInt(String(summary.feeShortfallBaseUnits));
  if (shortfall === 0n) return;
  throw new Error(
    `Saldo fee kurang ${summary.feeShortfall} ${summary.asset}. Kirim minimal ${summary.feeShortfall} ${summary.asset} ke ATA ${summary.tokenAccount}, atau isi Strategy JSON yang menghasilkan principal + fee.`,
  );
}

function printSimulation(result: Awaited<ReturnType<typeof simulate>>): void {
  console.log(safeJsonStringify({
    err: result.value.err,
    unitsConsumed: result.value.unitsConsumed?.toString(),
    logs: result.value.logs,
  }, 2));
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function safeWebsocketHost(wsUrl: string): string {
  try {
    return new URL(wsUrl).hostname;
  } catch {
    return "";
  }
}

/** "primary" | "fallback" | "public" | "custom" for a websocket endpoint. */
function websocketRole(endpoint: string, primaryUrl: string, fallbackUrl: string): string {
  const host = safeWebsocketHost(endpoint);
  if (!host) return "unknown";
  const primaryHost = safeWebsocketHost(primaryUrl);
  const fallbackHost = safeWebsocketHost(fallbackUrl);
  return host === primaryHost ? "primary" : host === fallbackHost ? "fallback" : host === "api.mainnet-beta.solana.com" ? "public" : "custom";
}

function websocketEndpointLabel(wsUrl: string, primaryUrl: string, fallbackUrl: string): string {
  const host = safeWebsocketHost(wsUrl);
  if (!host) return "unknown";
  return `${host} / ${websocketRole(wsUrl, primaryUrl, fallbackUrl)}`;
}

function compactNumber(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(numeric) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 6,
  }).format(numeric);
}

function compactUsd(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `$${value}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(numeric);
}

const MIN_LIQUIDITY_USD_CENTS = 10_000_000n;
const SUPPORTED_FLASH_ASSETS = new Set([
  "wsol",
  "usdt",
  "usdc",
  "dsol",
  "jitosol",
  "cbbtc",
  "jupsol",
  "usdg",
  "pyusd",
  "usds",
  "eurc",
]);

function isEligibleReserve(row: ReserveRow): boolean {
  return SUPPORTED_FLASH_ASSETS.has(row.symbol.toLowerCase())
    && row.flashLoanEnabled
    && row.priceValid
    && BigInt(row.availableBaseUnits) > 0n
    && BigInt(row.availableValueUsdCents) >= MIN_LIQUIDITY_USD_CENTS;
}

function printLiquidityScan(rows: Awaited<ReturnType<typeof getReserveRows>>): void {
  const ready = selectableReserveRows(rows);
  console.log(`\n${centerBlock(color.bold(color.cyan("SOLANA MAINNET / LIQUIDITY")))}`);
  console.log(centerBlock(`${color.green(`${ready.length} assets ready`)} ${color.dim("• minimum $100K •")} ${rows.length} reserves scanned`));
  if (!ready.length) {
    console.log(centerBlock(color.yellow("Tidak ada reserve flashloan bernilai minimal $100K.")));
    return;
  }
  console.log(centerBlock(renderTable(
    [
      { title: "#", align: "right" }, { title: "ASSET" },
      { title: "AVAILABLE", align: "right" }, { title: "VALUE", align: "right" },
      { title: "FEE", align: "right" }, { title: "RESERVE" },
    ],
    ready.map((row, index) => [
      color.magenta(String(index + 1).padStart(2, "0")),
      color.yellow(row.symbol),
      color.white(compactNumber(row.available)),
      color.green(compactUsd(row.availableValueUsd)),
      color.white(`${(Number(row.flashLoanFeeRate) * 100).toFixed(4)}%`),
      color.cyan(shortAddress(row.reserve)),
    ]),
  )));
}

function printSimulationPanel(result: Awaited<ReturnType<typeof simulate>>): void {
  const success = !result.value.err;
  console.log(`\n${centerBlock(color.bold(color.cyan("TRANSACTION SIMULATION")))}`);
  console.log(centerBlock(renderTable(
    [{ title: "FIELD" }, { title: "RESULT" }],
    [
      [color.dim("STATUS"), success ? color.green("SUCCESS") : color.red("FAILED")],
      [color.dim("COMPUTE"), color.white(`${result.value.unitsConsumed?.toString() ?? "n/a"} units`)],
      [color.dim("BROADCAST"), color.magenta("NOT SENT")],
    ],
  )));
  if (!success) {
    console.log(centerBlock(color.red(`Error: ${safeJsonStringify(result.value.err)}`)));
    const logs = result.value.logs?.slice(-12) ?? [];
    if (logs.length) console.log(logs.map((line) => color.dim(`  ${line}`)).join("\n"));
  } else {
    console.log(centerBlock(`${color.green("✓")} Simulasi flashloan berhasil`));
  }
}

async function getReserveRows(options: Omit<ReserveOptions, "json">) {
  const market = await loadMarket(rpcClient(options.rpc), options.market);
  return market.getReserves()
    .filter((reserve) => !options.asset || reserveMatchesAsset(reserve, options.asset))
    .map(reserveSummary)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

type ReserveRow = Awaited<ReturnType<typeof getReserveRows>>[number];

function selectableReserveRows(rows: ReserveRow[]): ReserveRow[] {
  const bestBySymbol = new Map<string, ReserveRow>();
  for (const row of rows) {
    if (!isEligibleReserve(row)) continue;
    const key = row.symbol.toLowerCase();
    const current = bestBySymbol.get(key);
    if (!current || BigInt(row.availableValueUsdCents) > BigInt(current.availableValueUsdCents)) {
      bestBySymbol.set(key, row);
    }
  }
  return [...bestBySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function selectPromptedReserve(allRows: ReserveRow[], choices: ReserveRow[], input: string): ReserveRow {
  const normalized = input.trim();
  if (/^\d+$/.test(normalized)) {
    const selected = choices[Number(normalized) - 1];
    if (selected) return selected;
  }
  const bySymbol = choices.find((row) => row.symbol.toLowerCase() === normalized.toLowerCase());
  if (bySymbol) return bySymbol;
  const byAddress = allRows.find((row) => row.reserve === normalized);
  if (byAddress && isEligibleReserve(byAddress)) return byAddress;
  throw new Error(`Asset "${input}" tidak tersedia. Pilih nomor, simbol, atau reserve address dari daftar.`);
}

async function promptReserveChoice(prompter: Prompter, rpc: string, market: string): Promise<ReserveRow> {
  console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Membaca reserve Kamino dari Solana...")}`));
  const rows = await getReserveRows({ rpc, market });
  const choices = selectableReserveRows(rows);
  if (!choices.length) throw new Error("Tidak ada reserve flashloan dengan likuiditas tersedia");
  printLiquidityScan(choices);
  const input = await prompter.required("Pilih asset", undefined, "nomor / simbol / reserve address");
  return selectPromptedReserve(rows, choices, input);
}

async function promptLoanOptions(prompter: Prompter): Promise<LoanOptions> {
  const rpc = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const market = process.env.KAMINO_MARKET || MAIN_MARKET;
  const selected = await promptReserveChoice(prompter, rpc, market);
  const amount = await prompter.required("Masukkan nominal", undefined, "contoh: 1000");
  const privateKey = privateKeyFromEnv();
  const keypairPath = configuredValue(process.env.KEYPAIR_PATH);
  const wallet = await loadWalletSigner({ privateKey, keypairPath });
  const tokenAccount = await deriveAssociatedTokenAccount({
    mint: selected.mint,
    owner: wallet.address,
    tokenProgram: selected.tokenProgram,
  });
  console.log(centerBlock(`${color.green("✓")} Wallet terdeteksi ${color.cyan(wallet.address)}`));
  console.log(centerBlock(`${color.green("✓")} ATA otomatis ${color.cyan(tokenAccount)}`));
  const strategy = await prompter.ask("Strategy JSON", undefined, "kosong = no-op; perlu saldo untuk fee");
  const options: LoanOptions = { rpc, market, amount, reserve: selected.reserve };
  if (strategy) options.strategy = strategy;
  if (keypairPath && !privateKey) options.keypair = keypairPath;
  return options;
}

async function runInteractive(): Promise<void> {
  const prompter = new Prompter();
  try {
    printBanner();
    while (true) {
      printMenu();
      const choice = await prompter.ask("Pilih menu", undefined, "[0-3]");
      if (choice === "0") {
        console.log(centerBlock(color.dim("Toolkit ditutup.\n")));
        return;
      }
      try {
        if (choice === "1") {
          const rpc = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
          const market = process.env.KAMINO_MARKET || MAIN_MARKET;
          const asset = await prompter.ask("Filter asset", undefined, "kosong = semua");
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Membaca reserve Kamino dari Solana...")}`));
          const options: Omit<ReserveOptions, "json"> = { rpc, market };
          if (asset) options.asset = asset;
          printLiquidityScan(await getReserveRows(options));
        } else if (choice === "2") {
          const options = await promptLoanOptions(prompter);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Memvalidasi plan on-chain...")}`));
          const { summary } = await prepare(options, false);
          printPlanSummary(summary);
          console.log(centerBlock(`${color.magenta("[PLAN]")} Tidak ada transaksi dikirim`));
        } else if (choice === "3") {
          const options = await promptLoanOptions(prompter);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Menyusun transaksi atomik...")}`));
          const { rpc, signer, build, summary } = await prepare(options, true);
          printPlanSummary(summary);
          assertNoOpRepayable(summary);
          const transaction = await createSignedTransaction(rpc, signer, build.instructions);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Menjalankan simulasi wajib...")}`));
          const result = await simulate(rpc, transaction);
          printSimulationPanel(result);
          if (result.value.err) {
            console.log(centerBlock(`${color.red("✗")} Simulasi gagal ${color.dim("• transaksi tidak dikirim")}`));
          } else {
            const confirmation = await prompter.ask(
              `Kirim flashloan ${summary.amount} ${summary.asset} di Solana mainnet`,
              undefined,
              "ketik YES",
            );
            if (confirmation !== "YES") {
              console.log(centerBlock(`${color.magenta("[PLAN]")} Broadcast dibatalkan`));
            } else {
              console.log(centerBlock(`${color.yellow("◌")} ${color.dim("Mengirim transaksi mainnet...")}`));
              const signature = await sendAndConfirm(options.rpc, rpc, transaction);
              const explorer = `https://solscan.io/tx/${signature}`;
              console.log(`\n${centerBlock(color.bold(color.green("TRANSACTION CONFIRMED")))}`);
              console.log(centerBlock(`${color.green("✓")} FLASHLOAN  ${color.dim(shortAddress(signature))}  ${terminalLink("OPEN ↗", explorer)}`));
            }
          }
        } else {
          console.log(centerBlock(color.yellow("Menu tidak valid. Pilih 0–3.")));
        }
      } catch (error) {
        printError(error);
      }
      await prompter.pause();
      if (process.stdout.isTTY) console.clear();
      printBanner();
    }
  } finally {
    prompter.close();
  }
}

const program = new Command()
  .name("kamino-tools")
  .description("Build, inspect, simulate, and execute atomic Kamino Lend flash loans")
  .showHelpAfterError();

program
  .command("reserves")
  .description("list reserves and their current flash-loan state")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--asset <symbol>", "filter by token symbol")
  .option("--json", "print JSON instead of a table", false)
  .action(async (options: ReserveOptions) => {
    const rows = await getReserveRows(options);
    if (options.json) console.log(safeJsonStringify(selectableReserveRows(rows), 2));
    else {
      printBanner();
      printLiquidityScan(rows);
    }
  });

program
  .command("interactive")
  .alias("i")
  .description("open the guided terminal menu")
  .action(runInteractive);

program
  .command("scan")
  .description("scan Kamino vanilla obligations for liquidatable long-tail positions (read-only)")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--min-debt <usd>", "minimum largest-debt USD (0 disables the band — full-market research mode)", "0")
  .option("--max-debt <usd>", "maximum largest-debt USD (0 disables the band)", "0")
  .option("--profit-floor <usd>", "minimum estimated gross profit in USD. Applied by the scanner AND by the fire path, so sub-floor dust never reaches assembly", "0.5")
  .option("--health-watch <ratio>", "hydrate obligations with cached health below this ratio", "1.5")
  .option("--near-miss <ratio>", "report obligations below this health ratio as near-miss", "1.1")
  .option("--watch", "keep scanning in a loop", false)
  .option("--interval <seconds>", "seconds between full scans when --watch is set (reconciliation only — detection rides the WS rail; 120s recommended)", "120")
  .option("--hot-interval <seconds>", "seconds between hot refreshes of tracked at-risk obligations", "10")
  .option("--hot-band <ratio>", "near-miss health below which obligations are hot-tracked (watch tier)", "1.02")
  .option("--max-hot-watch <count>", "cap on hot-tracked near-miss obligations (DUE positions are always tracked)", "60")
  .option("--log <path>", "append scan snapshots and watch events as JSON lines to this file")
  .option("--trace <address[,address...]>", "watch specific obligation addresses across cycles (health drift per cycle)")
  .option("--json", "print machine-readable JSON", false)
  .option("--execute", "arm the in-process executor: DUE positions spotted by this scan (or the hot loop) are attempted immediately (shadow unless --broadcast)", false)
  .option("--broadcast", "actually send liquidation transactions (default: shadow — plan+simulate only)", false)
  .option("--min-profit <usd>", "minimum worst-case net profit in USD for the executor to fire (close factor 10% makes plays smaller)", "0.05")
  .option("--min-prize <usd>", "extra prize floor applied BEFORE the executor spends any hydration/assembly RPC. The fire path always enforces at least --profit-floor and --min-profit, so 0 means 'add no extra bar' rather than 'no bar at all'", "0")
  .option("--slippage-bps <n>", "slippage tolerance on the executor's collateral→debt swap", "50")
  .option("--max-attempts-per-day <n>", "executor broadcast attempt budget (rolling day)", "12")
  .option("--max-loss-per-day <usd>", "executor fee-burn budget per rolling day", "1.5")
  .option("--ledger <path>", "executor attempt/outcome JSONL ledger", "data/liq_autofire_ledger.jsonl")
  .option("--stop-file <path>", "executor kill-switch file", "data/liq_autofire.stop")
  .option("--fast", "FAST mode: single simulation, skip the CU-pinned re-sim roundtrip (~1-2s faster)", false)
  .option("--priority-mode <mode>", "FASTLANE priority fee: off | fixed | auto (auto scales the bid with the prize, capped at 2% of worst-case profit)", "auto")
  .option("--ws <url>", "WebSocket endpoint for real-time obligation deltas (default: derived from --rpc)", "")
  .option("--race-tolerance <ratio>", "health band ABOVE 1.0 still routed into the pipeline so SIM can arbitrate a position sitting on the boundary. Keep this tiny: the program's threshold is the hard wall, so every unit above 1.0 is a bet against it. 0.02 admitted health 1.00–1.02, a band where 100% of attempts reverted 6016 ObligationHealthy.", "0.001")
  .option("--sender-endpoint <url>", "Helius Sender execution endpoint (execution-only; scanning/oracle keep --rpc)", process.env.HELIUS_SENDER_ENDPOINT || process.env.LIQ_SENDER_ENDPOINT || "")
  .option("--no-sender", "disable Helius Sender and broadcast directly on --rpc")
  .option("--sender-max-prize <usd>", "prize at/above which Sender Max is used (below it: SWQOS-only)", process.env.LIQ_SENDER_MAX_PRIZE_USD || "5")
  .option("--sender-max-tip-fraction <n>", "cap the Sender tip at this fraction of the prize", process.env.LIQ_SENDER_MAX_TIP_FRACTION || "0.01")
  .option("--sender-max-tip-cap-sol <sol>", "absolute Sender Max tip cap per fire, SOL", process.env.LIQ_SENDER_MAX_TIP_CAP_SOL || "0.02")
  .action(async (options: ScanOptions) => {
    const scanConfig: LiquidationScanConfig = {
      minDebtUsd: Number(options.minDebt),
      maxDebtUsd: Number(options.maxDebt),
      profitFloorUsd: Number(options.profitFloor),
      healthWatch: Number(options.healthWatch),
      nearMissHealth: Number(options.nearMiss),
    };
    validateScanConfig(scanConfig);
    const intervalMs = Math.max(1, Number(options.interval)) * 1000;
    const hotIntervalMs = Math.min(intervalMs, Math.max(5, Number(options.hotInterval)) * 1000);
    const hotBand = Math.min(Number(options.hotBand), scanConfig.nearMissHealth);
    const maxHotWatch = Math.max(1, Number(options.maxHotWatch));
    const log = options.log ? (event: ScanEvent) => appendScanEvent(options.log!, event) : undefined;
    const traceTargets = options.trace
      ? options.trace.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    const traceHistory = new Map<string, Array<{ cycle: number; health: number; at: string }>>();
    const alerter = new TelegramAlerter(telegramConfigFromEnv(process.env));
    const tracker = new HotTracker({
      nearMissHealth: scanConfig.nearMissHealth,
      hotHealth: hotBand,
      watchHealth: hotBand,
      maxWatch: maxHotWatch,
    });
    const scanRpc = rpcClient(options.rpc);
    let preloaded: PreloadedMarket | undefined;
    if (options.watch) preloaded = await preloadMarket(scanRpc, options.market);

    // ── In-process executor (unified pipeline: monitor → risk → execute → notify) ──
    // When --execute is set, DUE events emitted anywhere in this process (full
    // scan, hot tick) flow straight into the verdict chain — no separate
    // container, no file bridge, zero extra detection latency. The scan's
    // preloaded market is reused (no second market-load RPC burst).
    let executeMarket = options.execute ? (preloaded?.market ?? await loadMarket(scanRpc, options.market)) : undefined;
    const executorAltState = loadAltState();
    const executorAltTables = altTableAddresses(executorAltState);
    // Helius Sender execution lane: env-driven, CLI-overridable. Only the
    // BROADCAST rides Sender — blockhash, oracle, scan, and confirmation stay on
    // the existing data RPC (options.rpc).
    const senderConfig = senderConfigFromEnv(process.env, {
      endpoint: options.senderEndpoint,
      maxPrizeUsd: Number(options.senderMaxPrize),
      maxTipFraction: Number(options.senderMaxTipFraction),
      maxTipCapSol: Number(options.senderMaxTipCapSol),
      minProfitUsd: Number(options.minProfit),
      ...(options.sender === false ? { enabled: false } : {}),
    });
    if (options.execute && options.broadcast) {
      console.log(color.dim(`execution lane: ${senderConfig.enabled ? `Helius Sender (${senderConfig.endpoint}, Max ≥ $${senderConfig.maxPrizeUsd})` : "direct RPC (--no-sender)"}`));
    }
    // Warm the fire path BEFORE the first fire: blockhash + every chained ALT
    // contents are fetched in the background so the first DUE never eats the
    // cold-fetch round-trips on the critical path (ALT contents ~80-100ms each;
    // with companion tables that same cost every fire would be).
    if (options.execute) {
      const { warmAltTables, warmBlockhash, warmScopeConfigurations } = await import("./strategies/liquidation/hotcache.js");
      const warmExecution = () => {
        warmBlockhash(scanRpc, options.rpc);
        warmScopeConfigurations(scanRpc);
        warmAltTables(options.rpc, executorAltTables);
        if (senderConfig.enabled) void warmSenderConnection(senderConfig.endpoint);
      };
      warmExecution();
      if (options.watch) setInterval(warmExecution, 20_000).unref();
    }
    const executorAutoOptions: AutofireOptions = {
      lsts: [],
      sizeUsd: 0,
      slippageBps: Number(options.slippageBps),
      minProfitUsd: Number(options.minProfit),
      intervalSec: Math.max(1, Number(options.interval)),
      // Global pacing disabled (burst policy, 2026-09-09): the per-obligation
      // 30s cooldown + daily caps below already bind; a global cooldown would
      // hold fires 2..N of a same-slot DUE burst while LionX takes them all.
      cooldownSec: 0,
      maxAttemptsPerDay: Number(options.maxAttemptsPerDay),
      maxLossPerDayUsd: Number(options.maxLossPerDay),
      ledgerPath: options.ledger,
      stopFilePath: options.stopFile,
      // Prize firewall: skip sub-USD dust before spending any RPC (surge dust-spray
      // keeps ~40 tiny positions DUE — every one was previously charged a full
      // assemble pipeline. Big prizes are unaffected; only the $0.50 noise dies.)
      minPrizeUsd: Number(options.minPrize),
    };
    const HEALTH_GATE_TOLERANCE = Math.max(0, Number(options.raceTolerance));
    const executorCooldownMs = 30_000;
    const executorRecentlyTried = new Map<string, number>();
    // Bounded-concurrency fire lanes: LionX's census shows they fire PARALLEL txs
    // (3 liquidations in the same slot, one per obligation). Keep exactly three
    // lanes so RPC concurrency (and the 429 storm) is unchanged, but split them in
    // FAVOUR of the race rails: the measured queue wait was p90 1131ms because a
    // single reserved lane serialized every WS trigger, and a scan burst could
    // otherwise occupy both general slots. Races get two lanes; scan/hot gets one.
    const MAX_FIRE_LANES = 3;
    const RACE_FIRE_LANES = 2;
    const enqueueWsFire = createTaskQueue(RACE_FIRE_LANES, (error) => {
      console.error(`race executor lane failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const enqueueGeneralFire = createTaskQueue(MAX_FIRE_LANES - RACE_FIRE_LANES, (error) => {
      console.error(`executor lane failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const enqueueForensics = createTaskQueue(1, () => {});
    const executorBusy = new Set<string>();
    // Runtime stats for the heartbeat alert — the post-mortem data when things
    // don't work as expected. Every counter is a REAL event that happened in
    // this process: triggers seen, vetoes by class, attempts, fires, and races
    // lost (deduped across the tracker + forensics detection rails).
    const executorStats = {
      startedAt: Date.now(),
      cycles: 0,
      dueTriggers: 0,
      dueAttempted: 0,
      dueFired: 0,
      vetoDust: 0,
      vetoHealth: 0,
      selfHealed: 0,
      lastFailure: undefined as string | undefined,
    };
    // Count only verified on-chain liquidations, deduplicated per obligation/hour.
    const lostRaces = new Map<string, { prizeUsd: number; at: number }>();
    const LOST_RACE_DEDUP_MS = 60 * 60_000;
    const markRaceLost = (obligation: string, prizeUsd: number): void => {
      if ((lostRaces.get(obligation)?.at ?? 0) > Date.now() - LOST_RACE_DEDUP_MS) return;
      lostRaces.set(obligation, { prizeUsd: Math.max(prizeUsd, lostRaces.get(obligation)?.prizeUsd ?? 0), at: Date.now() });
    };
    const raceLostStats = (): { count: number; prizeUsd: number } => {
      let prize = 0;
      let count = 0;
      const now = Date.now();
      for (const [obligation, row] of [...lostRaces.entries()]) {
        if (now - row.at > LOST_RACE_DEDUP_MS) { lostRaces.delete(obligation); continue; }
        count += 1;
        prize += row.prizeUsd;
      }
      return { count, prizeUsd: prize };
    };
    // ── Smart retry policy (ported pattern) ──
    // Blocklist: obligations that consistently fail structurally (deprecated banks,
    // unquotable routes) never burn attempt budget again.
    const executorBlocklist = new Set<string>();
    // No-route cooldown: Jupiter couldn't quote this pair — don't spam retries.
    const executorNoRouteUntil = new Map<string, number>();
    const NO_ROUTE_COOLDOWN_MS = 10 * 60_000;
    const BLOCKLIST_AFTER = 3;
    const executorFailStreak = new Map<string, number>();
    // ── Race-mode retry policy (#2 of the LionX gap analysis) ──
    // Oscillating positions bounce around 1.0: the 2026-09-09 winners landed at
    // +3s..+43s while our old 30s cooldown put our 2nd attempt at +30s (sim fail,
    // not durable yet) and 3rd at +60s (taken). When a DUE attempt fails with
    // 6016 ObligationHealthy BUT the WS rail still sees it < 1.0, retry FAST
    // (5s) for a bounded window — the oscillation crosses below 1.0 repeatedly
    // and one of the fast retries lands in the same window the winners did.
    const EXECUTOR_RACE_RETRY_MS = 5_000;
    const EXECUTOR_RACE_RETRY_WINDOW_MS = 120_000;
    const executorStillDue = new Map<string, number>(); // obligation → last WS-seen-DUE timestamp
    // ── Watchboard: live per-obligation status board across ALL rails ──
    // Declared BEFORE executeDue/the scan loop: boardUpdate is called from the
    // very first scan cycle (and from WS slices), so a later `const` would hit
    // the temporal dead zone and crash the scanner ("Cannot access
    // 'boardUpdate' before initialization").
    interface WatchboardRow {
      obligation: string;
      health: number;
      healthAt: number;
      healthSource: "scan" | "hot" | "ws" | "executor";
      lastSeen: number;
      debtSymbol: string;
      debtUsd: number;
      prizeUsd: number;
      status: "WATCH" | "UNHEALTHY" | "EXECUTOR" | "FIRED" | "LOST" | "HEALED";
      statusSince: number;
      executedBy?: string;
    }
    const watchboard = new Map<string, WatchboardRow>();
    const WATCHBOARD_TTL_MS = 15 * 60_000;
    const boardUpdate = (obligation: string, patch: Partial<WatchboardRow> & { health?: number }): void => {
      const existing = watchboard.get(obligation);
      const status = patch.status ?? existing?.status ?? "WATCH";
      const hasHealth = patch.health !== undefined;
      const row: WatchboardRow = {
        obligation,
        health: patch.health ?? existing?.health ?? Number.NaN,
        healthAt: hasHealth ? (patch.healthAt ?? Date.now()) : (existing?.healthAt ?? 0),
        healthSource: hasHealth ? (patch.healthSource ?? "scan") : (existing?.healthSource ?? "scan"),
        lastSeen: Date.now(),
        debtSymbol: patch.debtSymbol ?? existing?.debtSymbol ?? "?",
        debtUsd: patch.debtUsd ?? existing?.debtUsd ?? 0,
        prizeUsd: patch.prizeUsd ?? existing?.prizeUsd ?? 0,
        status,
        statusSince: status !== existing?.status ? Date.now() : (existing?.statusSince ?? Date.now()),
        ...(patch.executedBy ? { executedBy: patch.executedBy } : (existing?.executedBy ? { executedBy: existing.executedBy } : {})),
      };
      watchboard.set(obligation, row);
      // Ticker: only ACTIONABLE transitions print a line — entering the board as
      // WATCH is silent (the panel lists the cohort every cycle; a restart's
      // first scan would otherwise dump 50 ◆ WATCH lines). The operator sees:
      // UNHEALTHY → EXECUTOR → FIRED/LOST, and HEALED only when it mattered
      // (was in the DUE tier, recovered — not routine band churn).
      if (!options.json && status !== existing?.status) {
        const actionable = status === "UNHEALTHY" || status === "EXECUTOR" || status === "FIRED" || status === "LOST"
          || (status === "HEALED" && (existing?.status === "UNHEALTHY" || existing?.status === "EXECUTOR" || existing?.status === "LOST"));
        if (actionable) {
          const label = {
            WATCH: color.yellow("◆ WATCH"),
            UNHEALTHY: color.bold(color.red("⚡ UNHEALTHY")),
            EXECUTOR: color.bold(color.magenta("▶ EXECUTOR")),
            FIRED: color.bold(color.green("✅ FIRED")),
            LOST: color.bold(color.red("✗ LOST")),
            HEALED: color.green("↑ HEALED"),
          }[status];
          const prize = row.prizeUsd > 0 ? `  $${row.prizeUsd.toFixed(2)} prize` : "";
          const winner = row.executedBy ? color.dim(`  (by ${row.executedBy.slice(0, 8)}…)`) : "";
          console.log(
            `${label} ${color.cyan(shortAddress(obligation))}` +
              `  health ${Number.isFinite(row.health) ? row.health.toFixed(4) : "?"}${prize}` +
              `  ${row.debtUsd > 0 ? `${row.debtUsd.toFixed(0)} ${row.debtSymbol}` : ""}${winner}`,
          );
        }
      }
    };
    const executeDue = (obligation: string, opts: { bypassHealth?: boolean; rail?: "ws" | "scan" | "hot" | "oracle"; oracleTrigger?: StreamAccountSnapshot; streamSnapshot?: import("./strategies/liquidation/screener.js").StreamAccountSnapshot; prepared?: Awaited<ReturnType<typeof refreshTrackedObligations>>; preparedAt?: number } = {}): void => {
      const triggeredAtMs = Date.now();
      executorStats.dueTriggers++;
      const rail = opts.rail ?? "scan";
      if (!options.execute || !executeMarket) return;
      if (executorBlocklist.has(obligation)) return;
      const noRoute = executorNoRouteUntil.get(obligation ?? "") ?? 0;
      if (Date.now() < noRoute) return;
      if (executorBusy.has(obligation)) return;
      // Race-aware cooldown: a WS-rail trigger that failed sim with 6016 while
      // still observed DUE re-arms in 5s (inside the window), everything else
      // keeps the 30s pacing.
      const inRaceWindow = (executorStillDue.get(obligation) ?? 0) > 0 && Date.now() - (executorStillDue.get(obligation) ?? 0) < EXECUTOR_RACE_RETRY_WINDOW_MS;
      const cooldownMs = inRaceWindow ? EXECUTOR_RACE_RETRY_MS : executorCooldownMs;
      const last = executorRecentlyTried.get(obligation) ?? 0;
      if (Date.now() - last < cooldownMs) return;
      executorRecentlyTried.set(obligation, Date.now());
      executorBusy.add(obligation);
      // Fact-based veto forensics: when a DUE trigger is declined by the
      // HEALTH GATE, resolve WHY against the chain — "lost-race" (another bot
      // liquidated it; who won, how fast) vs "self-healed" (nothing landed).
      // Post-mortem 2026-09-09: 3 of 9 vetoes were races we LOST 3–43s later.
      // Forensics is a getSignatures+getTransaction burst: dust/hydration
      // vetoes log WITHOUT it (40+ dust vetoes per surge cycle used to
      // self-inflict a 429 storm exactly when the race lanes needed the key).
      const logVeto = (reason: string, detail: { liveHealth?: number; prizeUsd?: number; forensics?: boolean; triggerHealth?: number }): void => {
        const latencyMs = Date.now() - triggeredAtMs;
        // Which rail fired, how old the oracle snapshot was, and the health the
        // trigger saw versus the live recompute that declined it. Without that
        // delta a health-gate veto is indistinguishable from a stale-trigger
        // false alarm — the 2026-09-24 batch could only be diagnosed by scraping
        // console output, because the ledger recorded only the live side.
        const vetoBase = {
          rail,
          oracleSnapshotAgeMs: oracleCache.snapshotAgeMs,
          ...(detail.liveHealth !== undefined ? { liveHealth: detail.liveHealth } : {}),
          ...(detail.triggerHealth !== undefined ? { triggerHealth: detail.triggerHealth } : {}),
          ...(detail.prizeUsd !== undefined ? { prizeUsd: detail.prizeUsd } : {}),
        };
        const runForensics = detail.forensics ?? false;
        // Real counters for the heartbeat: every veto class is distinguishable
        // (dust vs health-gate vs hydration noise) instead of one opaque "0".
        if (/dust|min-prize/i.test(reason)) executorStats.vetoDust++;
        else if (/client gate|health/i.test(reason)) executorStats.vetoHealth++;
        if (!runForensics) {
          logLedgerEntry(executorAutoOptions.ledgerPath, {
            at: new Date().toISOString(),
            type: "vetoed",
            obligation,
            reason,
            latencyMs,
            ...vetoBase,
          });
          return;
        }
        enqueueForensics(async () => {
          // Forensics reads ride the configured data RPC, not the public cluster —
          // a 429 here silently drops the race-loss verdict and undercounts losses.
          const fate = await resolveVetoFate({ rpcUrl: options.rpc, obligation, triggeredAtMs });
          logLedgerEntry(executorAutoOptions.ledgerPath, {
            at: new Date().toISOString(),
            type: "vetoed",
            obligation,
            reason,
            outcome: fate.outcome,
            // 6 of the 9 vetoes on 2026-09-24 landed in "unknown" with no
            // explanation recorded — the reader cannot tell a genuine
            // no-liquidation from an RPC that gave up mid-scan.
            ...(fate.reason ? { vetoFate: fate.reason } : {}),
            ...(fate.slot !== undefined && opts.streamSnapshot?.slot !== undefined ? {
              triggerSlot: opts.streamSnapshot.slot.toString(),
              postLiquidationNotification: BigInt(fate.slot) <= opts.streamSnapshot.slot,
            } : {}),
            ...(fate.winner ? { winner: fate.winner } : {}),
            ...(fate.winnerSignature ? { winnerSignature: fate.winnerSignature } : {}),
            ...(fate.feePayer ? { feePayer: fate.feePayer } : {}),
            ...(fate.slot !== undefined ? { liquidationSlot: fate.slot } : {}),
            ...(fate.raceLostAfterMs !== undefined ? { raceLostAfterMs: fate.raceLostAfterMs } : {}),
            triggeredAt: new Date(triggeredAtMs).toISOString(),
            latencyMs,
            ...vetoBase,
          });
          if (options.json) return;
          if (fate.outcome === "lost-race") {
            markRaceLost(obligation, detail.prizeUsd ?? 0);
            boardUpdate(obligation, { status: "LOST", ...(fate.winner ? { executedBy: fate.winner } : {}) });
            const lostAfter = ((fate.raceLostAfterMs ?? 0) / 1000).toFixed(1);
            console.log(
              color.bold(color.red(`✗ LOST RACE ${obligation.slice(0, 8)}…`)) +
                color.dim(`  ${reason} @+${(latencyMs / 1000).toFixed(1)}s — winner ${fate.winner?.slice(0, 8) ?? "?"}… liquidation delta ${lostAfter}s relative to our trigger  https://solscan.io/tx/${fate.winnerSignature}`),
            );
          } else {
            console.log(
              color.dim(`[${localTimestamp(new Date().toISOString())}] veto ${obligation.slice(0, 8)}…  ${reason} — ${fate.outcome.toUpperCase()} (recovery is not proven)`),
            );
          }
        });
      };
      // WS gets its reserved lane; scan/hot work uses the other two. Priority
      // is stable FIFO for equal scores, with fresh/prepared race candidates
      // ahead of older queued work.
      //
      // This score was previously computed and then DISCARDED — `enqueueFire` was
      // called with no priority, so every task ran plain FIFO and a fresh race
      // trigger sat behind older scan work. It is now actually passed through.
      const queuePriority = (opts.streamSnapshot?.receivedAt !== undefined
        ? Math.max(0, 2_000 - (Date.now() - opts.streamSnapshot.receivedAt))
        : 0) + Math.max(0, opts.prepared?.candidates[0]?.estimatedProfitUsd ?? 0);
      // The oracle rail is a RACE rail (it is the fast detection path), so it shares
      // the reserved lanes with the WS rail instead of queueing behind scan work.
      const enqueueFire = rail === "ws" || rail === "oracle" ? enqueueWsFire : enqueueGeneralFire;
      enqueueFire(async () => {
        try {
          const guards = evaluateFireGuards(executorAutoOptions, loadLedger(executorAutoOptions.ledgerPath), Date.now(), existsSync(executorAutoOptions.stopFilePath));
          if (!guards.allowed) {
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "blocked", obligation, reason: guards.reason ?? "blocked" });
            if (/loss|budget|cap/i.test(guards.reason ?? "")) {
              alerter.push(budgetPausedAlert({ dailyLossUsd: executorAutoOptions.maxLossPerDayUsd, capUsd: executorAutoOptions.maxLossPerDayUsd }));
            }
            return;
          }
          executorStats.dueAttempted++;
          const hydrationStartedAt = Date.now();
          let hydrated: Awaited<ReturnType<typeof refreshTrackedObligations>> =
            opts.prepared && opts.preparedAt !== undefined && Date.now() - opts.preparedAt < 1000
              ? opts.prepared : { candidates: [], obligations: new Map(), market: executeMarket! };
          // ── Race rail (#1 of the LionX gap analysis) ──
          // A WS-triggered DUE skips the ~800ms client-side health gate: the
          // slice's stored sf already said < 1.0, and SIMULATION (~50ms) runs the
          // program's own eligibility check on fresh prices — the hydration
          // roundtrip was pure added latency (the 2026-09-09 winners' failed-tx
          // spam shows they fire with NO pre-check at all). Scan/hot rails keep
          // the full gate below (they arrive with fresh candidates anyway).
          const raceRail = rail === "ws" || rail === "oracle";
          {
            // Both rails hydrate for prize/debt metadata — with bounded retries
            // and NO swallowed errors (a swallowed RPC error used to morph into
            // a false "closed or unparseable" veto). The race rail differs only
            // in that health is never gated afterwards — sim arbitrates.
            for (let tryIndex = 0; tryIndex < 3 && !hydrated.candidates.length; tryIndex++) {
              try {
                hydrated = await refreshTrackedObligations({ rpc: scanRpc, preloaded: preloaded!, pubkeys: [address(obligation)], applyOraclePrices: (market) => oracleCache.refreshMarket(market), ...(opts.streamSnapshot ? { streamSnapshot: opts.streamSnapshot } : {}) });
              } catch {
                if (tryIndex === 2) {
                  // Race rail: RPC hiccup must NOT end the attempt — re-arm via
                  // timer so a live DUE survives infra noise.
                  if (raceRail) {
                    executorRecentlyTried.delete(obligation);
                    setTimeout(() => executeDue(obligation, { rail }), 3_000);
                    return;
                  }
                  logVeto("hydration failed 3× (RPC errors during live-gate check)", {});
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 750 * (tryIndex + 1)));
              }
            }
          }
          // The health the TRIGGER saw (WS stored scaled factors, or the scan/hot
          // candidate) as opposed to the live recompute that follows. Their delta
          // is what the gate is actually rejecting, and it is the only way to tell
          // a position that healed from one the trigger read stale.
          const triggerHealth = opts.streamSnapshot?.cachedHealth ?? opts.prepared?.candidates[0]?.healthFactor;
          if (raceRail) {
            const raceCandidate = hydrated.candidates[0];
            // Prize firewall ONLY when configured (>0). Default 0 = learning
            // mode: dust DUE attempts are welcome — the net-profit guard and the
            // on-chain sim are the real "don't lose money" arbiters, and every
            // attempt is measured cost (fee burn) against measured learning.
            const raceMinPrize = executorAutoOptions.minPrizeUsd ?? 0;
            if (raceCandidate && raceMinPrize > 0 && (raceCandidate.estimatedProfitUsd ?? 0) < raceMinPrize) {
              logVeto(`WS race: prize $${(raceCandidate.estimatedProfitUsd ?? 0).toFixed(2)} < min-prize $${raceMinPrize.toFixed(2)} (dust firewall)`, { liveHealth: raceCandidate.healthFactor, prizeUsd: raceCandidate.estimatedProfitUsd ?? 0, ...(triggerHealth !== undefined ? { triggerHealth } : {}) });
              return;
            }
            boardUpdate(obligation, {
              status: "EXECUTOR",
              ...(raceCandidate ? {
                health: raceCandidate.healthFactor,
                debtSymbol: (raceCandidate.repayDebt ?? raceCandidate.largestDebt).symbol,
                debtUsd: (raceCandidate.repayDebt ?? raceCandidate.largestDebt).amountUsd,
                prizeUsd: Math.max(0, raceCandidate.estimatedProfitUsd ?? 0),
              } : {}),
            });
          }
          const candidate = hydrated.candidates[0];
          if (!candidate) {
            logVeto("hydration returned no candidate (closed or unparseable)", {});
            return;
          }
          // Client-side live gate — EVERY rail (ws / oracle / scan / hot).
          //
          // Kamino's own test is `borrow_factor_adjusted_debt >= unhealthy_borrow_value`,
          // i.e. health <= 1 (docs: "Current LTV >= Health limit"). The program
          // re-runs exactly that after RefreshObligation, so firing above this band
          // cannot succeed: it reverts 6016 ObligationHealthy. This gate used to be
          // skipped entirely for the ws/oracle rail, and 111 of 111 recorded 6016
          // failures came from that rail — the tx was built for a position the
          // client already knew was healthy. SIM arbitrates races that are AT the
          // boundary, not races we have already lost on paper.
          if (candidate.healthFactor >= 1 + HEALTH_GATE_TOLERANCE && !opts.bypassHealth) {
            logVeto(`live health ${candidate.healthFactor.toFixed(4)} ≥ ${(1 + HEALTH_GATE_TOLERANCE).toFixed(2)} (client gate declined)`, { liveHealth: candidate.healthFactor, prizeUsd: Math.max(0, candidate.estimatedProfitUsd ?? 0), forensics: true, ...(triggerHealth !== undefined ? { triggerHealth } : {}) });
            return;
          }
          const marginalBand = candidate.healthFactor >= 1;
          if (!raceRail) {
            boardUpdate(obligation, {
              status: "EXECUTOR",
              health: candidate.healthFactor,
              debtSymbol: (candidate.repayDebt ?? candidate.largestDebt).symbol,
              debtUsd: (candidate.repayDebt ?? candidate.largestDebt).amountUsd,
              prizeUsd: Math.max(0, candidate.estimatedProfitUsd ?? 0),
            });
          }
          // (position-age guard: hydration above IS the freshness guarantee — the
          // candidate data was fetched seconds ago, never stale cached state)
          // ── Fire-path floors ──
          // refreshTrackedObligations returns RAW tracked accounts: no debt band,
          // no profit floor, no health filter (unlike scanOnce -> filterLiquidatable).
          // A ws/oracle trigger therefore hands the executor whatever the tracker is
          // holding — which was sub-dollar dust ($0.00-$0.77 debts) that cannot clear
          // min-profit under this market's 10% close factor. Observed prizes:
          // $0.0022-$0.0245 against a $0.05 floor. Apply the SAME floors the scanner
          // applies so we stop burning hydration + a 30s cooldown discovering it.
          // The prize is also the worst-case profit on the table, which drives the
          // FASTLANE bid in auto mode.
          const prizeUsd = Math.max(0, candidate.estimatedProfitUsd ?? 0);
          const scanMinPrize = executorAutoOptions.minPrizeUsd ?? 0;
          const fireFloorUsd = Math.max(scanMinPrize, scanConfig.profitFloorUsd, executorAutoOptions.minProfitUsd ?? 0);
          const debtUsd = Math.max(candidate.repayDebt?.amountUsd ?? 0, candidate.largestDebt.amountUsd);
          if (prizeUsd < fireFloorUsd) {
            executorFailStreak.delete(obligation);
            logVeto(`prize $${prizeUsd.toFixed(4)} < floor $${fireFloorUsd.toFixed(2)} on $${debtUsd.toFixed(2)} debt (dust firewall — 10% close factor cannot clear it)`, { liveHealth: candidate.healthFactor, prizeUsd });
            return;
          }
          const runExecutor = () =>
            executeLiquidationOnce({
              rpc: scanRpc,
              rpcUrl: options.rpc,
              market: hydrated.market,
              obligationAddress: address(obligation),
              slippageBps: executorAutoOptions.slippageBps,
              minProfitUsd: executorAutoOptions.minProfitUsd,
              ...(executorAltTables.length ? { lookupTableAddresses: executorAltTables.map(address) } : {}),
              ...(options.fast ? { fast: true } : {}),
              // Every automatic attempt must pass simulation before broadcast.
              ...(raceRail ? { healthGateTolerance: HEALTH_GATE_TOLERANCE } : marginalBand ? { healthGateTolerance: HEALTH_GATE_TOLERANCE } : {}),
              ...(hydrated.obligations.get(obligation) ? { prehydratedObligation: hydrated.obligations.get(obligation) as KaminoObligation } : {}),
              ...({ priorityMode: (["off", "fixed", "auto"] as const).includes(options.priorityMode as never) ? (options.priorityMode as "off" | "fixed" | "auto") : "auto", prizeUsd, bypassHealth: opts.bypassHealth ?? false }),
              sender: senderConfig,
            }).catch((error: unknown) => ({ stage: "assemble", passed: false, reason: error instanceof Error ? error.message : String(error) }) as const);
          const hydrateMs = Date.now() - hydrationStartedAt;
          const queueMs = hydrationStartedAt - triggeredAtMs;
          let outcome = await runExecutor();
          if ("timings" in outcome && outcome.timings) {
            outcome.timings.queue = queueMs;
            outcome.timings.hydrateInput = hydrateMs;
          }
          // ReserveStale / RPC-throttle retries NO LONGER sleep inside the fire
          // lane (a sleeping lane blocks the queue — 2 retries × 15s held = the
          // same 3-lane stall shape as a hung send). The retry re-triggers
          // executeDue on a timer, OUTSIDE the lane, and this lane exits now.
          if (!outcome.passed) {
            logLedgerEntry(executorAutoOptions.ledgerPath, {
              at: new Date().toISOString(), type: "skipped", obligation, stage: outcome.stage,
              reason: outcome.reason.slice(0, 2000), rail,
              ...(opts.streamSnapshot?.slot !== undefined ? { triggerSlot: opts.streamSnapshot.slot.toString() } : {}),
              ...(opts.oracleTrigger ? { oracleSlot: opts.oracleTrigger.slot?.toString(), oracleReceivedAt: opts.oracleTrigger.receivedAt,
                oracleToTriggerMs: triggeredAtMs - (opts.oracleTrigger.receivedAt ?? triggeredAtMs) } : {}),
              oracleSnapshotAgeMs: oracleCache.snapshotAgeMs,
              triggeredAt: new Date(triggeredAtMs).toISOString(), latencyMsTotal: Date.now() - triggeredAtMs,
              ...("timings" in outcome && outcome.timings ? { timingsMs: outcome.timings } : {}),
              ...("routeDiagnostics" in outcome && outcome.routeDiagnostics ? { routeDiagnostics: outcome.routeDiagnostics } : {}),
              ...("simulationSlot" in outcome && outcome.simulationSlot !== undefined ? { simulationSlot: outcome.simulationSlot } : {}),
              simulationPerformed: "timings" in outcome && outcome.timings ? outcome.timings.simulate !== undefined : false,
              ...("logs" in outcome ? { simulationLogs: outcome.logs.slice(-40) } : {}),
            });
          }
          if (!outcome.passed && outcome.reason.startsWith("ALT unavailable:")) {
            // Infrastructure failure is not an unquotable route or a broken obligation.
            executorNoRouteUntil.set(obligation, Date.now() + 5_000);
            executorRecentlyTried.delete(obligation);
            boardUpdate(obligation, { status: "WATCH" });
            executorStats.lastFailure = outcome.reason;
            if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] executor: ${outcome.reason}`));
            return;
          }
          const retryable =
            !outcome.passed && (/ReserveStale|6009|price_status/.test(outcome.reason)
              || /8100002|429|too many|rate.?limit/i.test(outcome.reason));
          if (retryable) {
            const delayMs = /ReserveStale|6009|price_status/.test(outcome.reason) ? 5_000 : 3_000;
            if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] executor: ${obligation.slice(0, 8)}… ${/ReserveStale/.test(outcome.reason) ? "reserve stale" : "RPC throttled"} — re-arming in ${delayMs / 1000}s (lane released)`));
            executorRecentlyTried.delete(obligation); // let the re-trigger pass cooldown
            setTimeout(() => executeDue(obligation, { rail }), delayMs);
            return;
          }
          if (!outcome.passed) {
            if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] executor ✗ ${obligation.slice(0, 8)}… ${outcome.stage}: ${outcome.reason.slice(0, 160)}`));
            // Only alert on late-stage failures (assemble/simulate) — plan-stage rejections
            // (not liquidatable, no flash debt) are normal market noise, not incidents.
            if (outcome.stage !== "plan" && !outcome.reason.startsWith("ObligationHealthy (6016):")) {
              executorStats.lastFailure = `${outcome.stage}: ${outcome.reason.slice(0, 160)}`;
              alerter.push(liquidationFailedAlert({ obligation: obligation.slice(0, 12), stage: outcome.stage, reason: outcome.reason.slice(0, 300) }));
            }
            if (/6016|ObligationHealthy/.test(outcome.reason)) {
              logVeto("simulation found a healthy obligation", {
                liveHealth: candidate.healthFactor, prizeUsd, forensics: true,
              });
            }
            // ── Smart retry policy ──
            // Cooldown-clear on healthy: the play was taken or repaid by someone else —
            // the position changed state, so the cooldown no longer protects anything.
            // RACE EXCEPTION (#2): on the WS rail a 6016 sim-fail while the slice
            // keeps reporting < 1.0 means OSCILLATION — arm the 5s fast-retry
            // instead of clearing, so our next attempt lands inside the +3..+43s
            // window the 2026-09-09 winners actually took.
            if (/6016|ObligationHealthy|IllegalLiquidation|0x1780|0xbbf|not liquidatable/i.test(outcome.reason)) {
              executorFailStreak.delete(obligation);
              if (raceRail) {
                executorStillDue.set(obligation, Date.now());
                // Retain the attempt time so repeated feed updates respect the 5s retry floor.
                if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] race ✗ ${obligation.slice(0, 8)}… sim says healthy — fast-retry armed (5s) while WS keeps it DUE`));
                return;
              }
              executorRecentlyTried.delete(obligation);
              // Scan/hot rail: the position sits in the near-miss band, still
              // tracked — return the board row to WATCH (with the live health),
              // NOT a terminal HEALED (that's for genuinely-recovered positions;
              // a stuck EXECUTOR row hides the cohort state).
              boardUpdate(obligation, { status: "WATCH", ...(candidate.healthFactor < 1.05 ? { health: candidate.healthFactor } : {}) });
              return;
            }
            // Farm-accounts shape (6120): the obligation participates in Kamino
            // farms and our none() farm accounts fail the program's refresh —
            // structural, not transient. Back off long (it's not market noise)
            // but DON'T blocklist: implementing farm-account support later will
            // revive these positions.
            if (/6120|FarmAccountsMissing/i.test(outcome.reason)) {
              executorNoRouteUntil.set(obligation, Date.now() + 60 * 60_000);
              boardUpdate(obligation, { status: "WATCH", ...(candidate.healthFactor < 1.05 ? { health: candidate.healthFactor } : {}) });
              if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] executor ✗ ${obligation.slice(0, 8)}… farm-backed obligation (6120) — needs farm-account support, parked 1h`));
              return;
            }
            // No-route: Jupiter couldn't quote — back off 10 minutes, don't spam.
            if (/unquotable|No routes|unavailable|6024|6035|packet|deadline|worst-case/i.test(outcome.reason)) {
              executorFailStreak.delete(obligation);
              executorRecentlyTried.delete(obligation);
              executorNoRouteUntil.set(obligation, Date.now() + 3_000);
              return;
            }
            executorRecentlyTried.delete(obligation);
            executorNoRouteUntil.set(obligation, Date.now() + 5_000);
            return;
          }
          const line = {
            obligation,
            repay: `${outcome.plan.repayUsd.toFixed(2)} ${outcome.plan.repayReserveSymbol}`,
            withdraw: outcome.plan.withdrawReserveSymbol,
            quoted: outcome.plan.quotedProfitUsd.toFixed(4),
            worst: outcome.plan.worstCaseProfitUsd.toFixed(4),
            ...(outcome.plan.netWorstCaseProfitUsd !== undefined
              ? { net: outcome.plan.netWorstCaseProfitUsd.toFixed(4), cost: outcome.plan.senderCostUsd?.toFixed(4) } : {}),
            ...(outcome.plan.swapSource ? { swap: outcome.plan.swapSource } : {}),
          };
          if (options.json) console.log(safeJsonStringify({ executable: { ...line, shadow: !options.broadcast } }));
          else console.log(color.bold(color.green(`⚡ EXECUTABLE ${obligation.slice(0, 8)}…`)) + `  repay ${line.repay} → ${line.withdraw}  gross $${line.quoted}/$${line.worst}${line.net ? `  net $${line.net} (send cost $${line.cost})` : ""}  swap ${line.swap ?? "?"}  ${options.broadcast ? "FIRING" : "SHADOW"}`);
          alerter.push(dueAttemptAlert({
            obligation: obligation.slice(0, 12),
            health: outcome.plan.healthFactor,
            repayUsd: outcome.plan.repayUsd,
            repaySymbol: outcome.plan.repayReserveSymbol,
            withdrawSymbol: outcome.plan.withdrawReserveSymbol,
            worstProfitUsd: outcome.plan.worstCaseProfitUsd,
            timingsMs: outcome.timings,
            shadow: !options.broadcast,
            priorityLane: outcome.priorityLane,
            tipUsd: outcome.tipUsd,
          }));
          logLedgerEntry(executorAutoOptions.ledgerPath, {
            at: new Date().toISOString(), type: "pass", stage: "ready", obligation, rail,
            triggeredAt: new Date(triggeredAtMs).toISOString(), latencyMsTotal: Date.now() - triggeredAtMs,
            ...(opts.streamSnapshot?.slot !== undefined ? { triggerSlot: opts.streamSnapshot.slot.toString() } : {}),
            timingsMs: outcome.timings, simulationPerformed: true,
            quotedProfitUsd: outcome.plan.quotedProfitUsd, worstCaseProfitUsd: outcome.plan.worstCaseProfitUsd,
            ...(outcome.sender ? { senderTier: outcome.sender.tier, senderTipLamports: outcome.sender.tipLamports.toString(), senderCostUsd: outcome.sender.estimatedCostUsd } : {}),
            ...(outcome.plan.netWorstCaseProfitUsd !== undefined ? { netWorstCaseProfitUsd: outcome.plan.netWorstCaseProfitUsd } : {}),
          });
          if (!options.broadcast) {
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "skipped", obligation, reason: "shadow — executable play not broadcast", quotedProfitUsd: outcome.plan.quotedProfitUsd, worstCaseProfitUsd: outcome.plan.worstCaseProfitUsd });
            return;
          }
          const attemptedSignature = getSignatureFromTransaction(outcome.transaction);
          // Budget estimate remains explicitly separate from the measured lamport fee.
          const lossUsdEstimate = 0.0011 + outcome.tipUsd;
          const signature = await broadcastLiquidation({ outcome, dataRpc: scanRpc, dataRpcUrl: options.rpc, sender: senderConfig }).catch(async (error: unknown) => {
            const failReason = error instanceof Error ? error.message : "unknown";
            const receipt = await transactionReceipt(scanRpc, attemptedSignature);
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", obligation, signature: attemptedSignature, ...receipt, reason: `broadcast failed: ${failReason.slice(0, 100)}`, lossUsdEstimate, ...(outcome.sender ? { senderTier: outcome.sender.tier, senderTipLamports: outcome.sender.tipLamports.toString(), senderCostUsd: outcome.sender.estimatedCostUsd } : {}) });
            console.log(color.red(`✗ broadcast failed: ${failReason}`));
            executorStats.lastFailure = `broadcast: ${failReason.slice(0, 160)}`;
            alerter.push(liquidationFailedAlert({ obligation: obligation.slice(0, 12), stage: "broadcast", reason: failReason.slice(0, 300) }));
            return null;
          });
          if (!signature) return;
          executorStats.dueFired++;
          boardUpdate(obligation, { status: "FIRED", prizeUsd: outcome.plan.worstCaseProfitUsd });
          console.log(color.bold(color.green(`✅ FIRED ${obligation.slice(0, 8)}…`)) + `  ${color.white(`https://solscan.io/tx/${signature}`)}`);
          const receipt = await transactionReceipt(scanRpc, signature);
          logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", obligation, signature, ...receipt, quotedProfitUsd: outcome.plan.quotedProfitUsd, worstCaseProfitUsd: outcome.plan.worstCaseProfitUsd, lossUsdEstimate, ...(outcome.sender ? { senderTier: outcome.sender.tier, senderTipLamports: outcome.sender.tipLamports.toString(), senderCostUsd: outcome.sender.estimatedCostUsd } : {}) });
          alerter.push(liquidationQuoteAlert({ signature, quotedUsd: outcome.plan.quotedProfitUsd, worstUsd: outcome.plan.worstCaseProfitUsd }));
        } finally {
          executorBusy.delete(obligation);
        }
      }, queuePriority);
    };

    const emitTrackerEvents = (events: TrackerEvent[], prepared?: Awaited<ReturnType<typeof refreshTrackedObligations>>, preparedAt?: number, oracleTrigger?: StreamAccountSnapshot) => {
      for (const event of events) {
        if (event.type === "spotted") {
          log?.({ type: "spotted", at: event.at, candidate: event.candidate });
          console.log(`${color.bold(color.red("⚡ DUE"))} ${printCandidateLine(event.candidate, "")}`);
          executeDue(event.candidate.obligation, prepared ? {
            rail: oracleTrigger ? "oracle" : "hot", ...(oracleTrigger ? { oracleTrigger } : {}), prepared: { ...prepared, candidates: [event.candidate] }, preparedAt: preparedAt!,
          } : {});
        } else if (event.type === "promoted") {
          log?.({ type: "promoted", at: event.at, candidate: event.candidate, fromHealth: event.fromHealth });
          console.log(`${color.bold(color.red("⚡ PROMOTED→DUE"))} ${printCandidateLine(event.candidate, color.yellow(`(was ${event.fromHealth.toFixed(4)})`))}`);
          executeDue(event.candidate.obligation, prepared ? {
            rail: oracleTrigger ? "oracle" : "hot", ...(oracleTrigger ? { oracleTrigger } : {}), prepared: { ...prepared, candidates: [event.candidate] }, preparedAt: preparedAt!,
          } : {});
        } else if (event.type === "watching") {
          // Near-miss entries below the watch band — no console chatter (the cycle
          // panel's NEAR MISS list + Telegram digest are the visibility for this tier).
          log?.({ type: "watching", at: event.at, candidate: event.candidate });
        } else if (event.type === "taken") {
          log?.({ type: "taken", at: event.at, obligation: event.obligation, firstSpottedAt: event.firstSpottedAt, satSeconds: event.satSeconds, wasDue: event.wasDue, ...(event.dueSince ? { dueSince: event.dueSince } : {}) });
          // Watchlist disappearance is a state transition, not proof of liquidation.
          if (event.wasDue) {
            const debt = `${(event.debtUsd ?? 0).toFixed(2)} ${event.debtSymbol ?? "?"}`;
            console.log(
              `${color.bold(color.yellow("⚡ LEFT WATCHLIST"))} ${color.red(event.obligation)}` +
              color.dim(`  last health ${(event.lastHealth ?? 0).toFixed(4)}, debt ${debt}, DUE ${event.satSeconds}s — liquidation unverified`),
            );
          }
        } else {
          log?.({ type: "healed", at: event.at, obligation: event.obligation, lastHealth: event.lastHealth });
        }
        const alert = trackerEventToAlert(event);
        if (alert) alerter.push(alert);
      }
    };

    const snapshots = new Map<string, StreamAccountSnapshot>();
    let wsHandle: TrackedWsHandle | undefined;
    const syncObligationSubscriptions = () => {
      const accounts = tracker.hotObligations();
      wsHandle?.setAccounts(accounts);
      const desired = new Set(accounts);
      for (const key of snapshots.keys()) if (!desired.has(key)) snapshots.delete(key);
    };
    // Evict rows that went quiet (healed far above the band / closed) so the
    // board stays a live cohort, not a growing archive. Declared before the
    // scan loop that calls it.
    const boardSweep = (): void => {
      for (const [obligation, row] of [...watchboard.entries()]) {
        if (Date.now() - row.lastSeen > WATCHBOARD_TTL_MS) { watchboard.delete(obligation); snapshots.delete(obligation); }
      }
    };
    let lastScanCompletedAt = Date.now();
    let lastHotCompletedAt = Date.now();
    let oracleLive = false;
    let lastOracleTrigger: StreamAccountSnapshot | undefined;
    // Oracle-first observability: how many tracked positions were revalued from
    // the oracle tick (and how many came out DUE) — the numbers the race audit
    // needs to prove the oracle rail fires BEFORE the obligation mutation.
    let lastOracleRevalue: { revalued: number; due: number; at: number; trackedPassMs?: number } | undefined;
    let pendingOracle = false;
    let adaptiveBand = scanConfig.healthWatch;
    let surgeActive = false;
    let hotTickRunning = false;
    let nextHotRpcAt = 0;

    const hotTick = async (oracleTrigger?: StreamAccountSnapshot) => {
      // Never overlap: while one hot tick is mid-backoff (the shared key throttled), a
      // second tick starting at its 10s cadence would spawn a parallel RPC chain and
      // double the load — serially re-arm only after the previous tick settled.
      if (hotTickRunning) { if (oracleTrigger) pendingOracle = true; return; }
      if (!oracleTrigger && Date.now() < nextHotRpcAt) return;
      hotTickRunning = true;
      try {
        if (!preloaded) return;
        // Narrow once: the captured `preloaded` is a mutable binding, so TS cannot
        // keep the guard's narrowing inside the closure below.
        const loadedMarket = preloaded;
        // Refresh a cohort and consume the result (board + tracker + fire) as ONE
        // unit, so the race rail can run it as TWO passes.
        //
        // Why two: executeDue only fires once a pass completes, so revaluing all 393
        // in a single batch made the most-endangered (tracked) positions wait the
        // full ~350ms instead of ~74ms — the widening would have taxed exactly the
        // cohort that matters most. Two passes cost ~74ms of duplicated fixed
        // overhead in total while letting the DUE tier fire ~276ms earlier.
        //
        // syncObligationSubscriptions is deliberately OUTSIDE this helper: it evicts
        // any snapshot whose pubkey is not tracked, so it must not run between
        // seeding the valuation cache and the valuation pass reading it.
        const refreshAndConsume = async (addresses: string[]): Promise<{ revalued: number; due: number }> => {
          if (!addresses.length) return { revalued: 0, due: 0 };
          const updates = await refreshTrackedObligations({
            rpc: scanRpc,
            preloaded: loadedMarket,
            pubkeys: addresses.map((value) => address(value)),
            snapshots,
            ...(lastOracleTrigger ? { valuationSnapshot: lastOracleTrigger } : {}),
            isSubscribed: key => wsHandle?.isSubscribed(key) ?? false,
            ...(oracleTrigger ? { oracleTrigger } : {}),
            applyOraclePrices: (market) => oracleCache.refreshMarket(market),
          });
          // Watchboard ingest: hot-tick refreshes carry the freshest per-position
          // health of the tracked cohort — update rows without changing status.
          // The widened valuation set is a DETECTION net, not a display cohort:
          // refresh rows that already exist, and let a genuinely DUE position earn a
          // new row — but never let ~340 healthy cache entries flood the board.
          const boardTracked = new Set(tracker.hotObligations());
          for (const candidate of updates.candidates) {
            if (!watchboard.has(candidate.obligation)
              && candidate.healthFactor >= 1
              && !boardTracked.has(candidate.obligation)) continue;
            boardUpdate(candidate.obligation, {
              health: candidate.healthFactor,
              healthSource: "hot",
              debtSymbol: (candidate.repayDebt ?? candidate.largestDebt).symbol,
              debtUsd: (candidate.repayDebt ?? candidate.largestDebt).amountUsd,
              prizeUsd: candidate.estimatedProfitUsd ?? 0,
              ...(candidate.healthFactor < 1 ? { status: "UNHEALTHY" } : {}),
            });
          }
          const events = tracker.applyHotUpdate(updates.candidates, new Date().toISOString(), !oracleTrigger);
          if (events.length) emitTrackerEvents(events, updates, Date.now(), oracleTrigger);
          // A still-DUE position needs a new attempt after a transient failure,
          // even if it never crossed back above one. Cooldown/busy guards bound this.
          const emitted = new Set(events.filter((event) => event.type === "promoted" || event.type === "spotted")
            .map((event) => event.candidate.obligation));
          for (const candidate of updates.candidates) {
            if (candidate.healthFactor < 1 && !emitted.has(candidate.obligation)) executeDue(candidate.obligation, {
              rail: oracleTrigger ? "oracle" : "hot", ...(oracleTrigger ? { oracleTrigger } : {}),
              prepared: { ...updates, candidates: [candidate] }, preparedAt: Date.now(),
            });
          }
          return {
            revalued: updates.candidates.length,
            due: updates.candidates.filter((candidate) => candidate.healthFactor < 1).length,
          };
        };
        const trackedKeys = tracker.hotObligations();
        let revalued = 0;
        let due = 0;
        const accumulate = ({ revalued: batchRevalued, due: batchDue }: { revalued: number; due: number }) => {
          revalued += batchRevalued;
          due += batchDue;
        };
        // Pass 1 — the tracked cohort (DUE + watch tier): the race-critical set.
        const trackedPassStartedAt = Date.now();
        accumulate(await refreshAndConsume(trackedKeys));
        const trackedPassMs = Date.now() - trackedPassStartedAt;
        // Pass 2 — the widened valuation net. Overlaps with the tracker (the tracked
        // rows are themselves the lowest-health ones), so filter them out: they were
        // just refreshed a moment ago and must not be fired twice.
        if (oracleTrigger) {
          seedValuationSnapshots(snapshots);
          const trackedSet = new Set(trackedKeys);
          accumulate(await refreshAndConsume(valuationSnapshotKeys().filter((key) => !trackedSet.has(key))));
          lastOracleRevalue = { revalued, due, at: Date.now(), trackedPassMs };
        }
        syncObligationSubscriptions();
        lastHotCompletedAt = Date.now();
      } catch (error) {
        if (!oracleTrigger) nextHotRpcAt = Date.now() + 30_000;
        throw error;
      } finally {
        if (!oracleTrigger) nextHotRpcAt = Math.max(nextHotRpcAt, Date.now() + hotIntervalMs);
        hotTickRunning = false;
        if (pendingOracle) {
          pendingOracle = false;
          setTimeout(() => { void hotTick(lastOracleTrigger).catch(printError); }, 100);
        }
      }
    };

    // Oracle-driven invalidation: account WS notifications update a process
    // memory cache and coalesce a targeted hot refresh. The cache is not used
    // as an unverified price source; simulation and the transaction's oracle
    // refresh remain the final authority before broadcast.
    let oracleRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const oracleBenchmarkEnabled = process.env.ORACLE_BENCHMARK === "1";
    let oracleUpdateAt = 0;
    let oracleUpdateCount = 0;
    let oracleMetricAt = 0;
    const oracleCache = new OracleFeedCache();
    if (options.watch && executeMarket) {
      const oracleFeeds = marketOracleFeeds(executeMarket);
      const oracleFeedWsUrl = options.ws || options.rpc.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      const oracleFallbackWsUrl = (process.env.SOLANA_RPC_FALLBACK ?? "").replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      await oracleCache.prime(scanRpc, executeMarket).catch((error: unknown) => {
        if (!options.json) console.warn(color.yellow(`[${localTimestamp(new Date().toISOString())}] oracle cache prime failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      const oracleWs = await subscribeOracleFeeds({
        wsUrl: oracleFeedWsUrl,
        // Same-provider rotation ONLY: primary → SOLANA_RPC_FALLBACK. The public
        // Solana cluster is never a candidate — no SLA, shared connection budget,
        // and it lags so far behind that minContextSlot primes come back -32016.
        ...(!options.ws ? { wsCandidates: [oracleFeedWsUrl, oracleFallbackWsUrl].filter(Boolean) } : {}),
        feeds: oracleFeeds,
        cache: oracleCache,
        onReady: async (endpoint) => {
          await oracleCache.prime(scanRpc, executeMarket!);
          oracleLive = true;
          const safeEndpoint = endpoint.replace(/\?.*$/, "");
          if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] oracle feeds live (${oracleFeeds.length}) ${safeEndpoint}`));
        },
        onError: (error) => {
          oracleLive = false;
          if (!options.json) console.warn(color.yellow(`[${localTimestamp(new Date().toISOString())}] oracle rail: ${error instanceof Error ? error.message : String(error)}`));
        },
        onUpdate: (update) => {
          lastOracleTrigger = { pubkey: update.feed, ...(update.slot !== undefined ? { slot: update.slot } : {}), receivedAt: update.receivedAt };
          if (oracleBenchmarkEnabled) {
            oracleUpdateAt = Date.now();
            oracleUpdateCount += 1;
          }
          if (hotTickRunning) { pendingOracle = true; return; }
          if (oracleRefreshTimer) return;
          // Several feeds update in the same slot. One coalesced refresh avoids
          // multiplying RPC work while still reacting within one event loop turn.
          oracleRefreshTimer = setTimeout(() => {
            oracleRefreshTimer = undefined;
            const hotStartedAt = oracleBenchmarkEnabled ? Date.now() : 0;
            const hotRun = hotTick(lastOracleTrigger);
            if (!oracleBenchmarkEnabled) {
              void hotRun.catch((error: unknown) => printError(error));
              return;
            }
            void hotRun
              .then(() => {
                const finishedAt = Date.now();
                if (!options.json && finishedAt - oracleMetricAt >= 10_000) {
                  oracleMetricAt = finishedAt;
                  console.log(color.dim(
                    `[${localTimestamp(new Date().toISOString())}] oracle benchmark: updates=${oracleUpdateCount} ` +
                    `update->hot=${Math.max(0, hotStartedAt - oracleUpdateAt)}ms ` +
                    `hot=${finishedAt - hotStartedAt}ms tracked=${tracker.hotObligations().length}` +
                    `${lastOracleRevalue ? ` revalued=${lastOracleRevalue.revalued} due=${lastOracleRevalue.due} pass1=${lastOracleRevalue.trackedPassMs ?? "?"}ms` : ""}`,
                  ));
                }
              })
              .catch((error: unknown) => printError(error));
          }, 100);
        },
      });
      void oracleWs.ready.catch(() => {});
      setInterval(() => {
        void oracleCache.prime(scanRpc, executeMarket!).catch((error: unknown) => {
          console.warn(`oracle prime: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 10_000).unref();
    }

    const printTrace = (cycle: number, result: ScanResult) => {
      if (!traceTargets.length) return;
      const all = [...result.liquidatable, ...result.nearMiss];
      for (const target of [...traceTargets]) {
        const current = all.find((candidate) => candidate.obligation === target);
        const history = traceHistory.get(target) ?? [];
        if (current) {
          history.push({ cycle, health: current.healthFactor, at: result.scannedAt });
          traceHistory.set(target, history);
          const drift = history.length > 1
            ? current.healthFactor - history[history.length - 2]!.health
            : 0;
          const driftLabel = history.length > 1
            ? (drift <= 0 ? color.red(drift.toFixed(4)) : color.green(`+${drift.toFixed(4)}`))
            : color.dim("baseline");
          const debt = `${current.largestDebt.amountUsd.toFixed(2)} ${current.largestDebt.symbol}`;
          console.log(
            color.magenta(`TRACE ${shortAddress(target)}`) +
            `  HEALTH=${color.white(current.healthFactor.toFixed(4))}` +
            `  DRIFT=${driftLabel}` +
            color.dim(`  DEBT=${debt}`) +
            (current.healthFactor < 1 ? color.bold(color.red("  ⚡ DUE")) : ""),
          );
        } else if (history.length) {
          // Known in a previous cycle but gone now: either taken by someone else or self-healed above watch band
          console.log(
            color.magenta(`TRACE ${shortAddress(target)}`) +
            color.yellow("  GONE — taken/self-healed (last health: " +
              `${history[history.length - 1]!.health.toFixed(4)} at cycle #${history[history.length - 1]!.cycle})`),
          );
          traceHistory.delete(target);
        }
      }
    };

    const runOnce = async (cycle: number) => {
      executorStats.cycles = cycle;
      if (!options.json) console.log(color.dim(`\n[${localTimestamp(new Date().toISOString())}] cycle #${cycle} scanning${surgeActive ? color.red(" [SURGE MODE]") : ""}...`));
      if (!preloaded || Date.now() - preloaded.loadedAt >= 30_000) {
        preloaded = await preloadMarket(scanRpc, options.market);
        if (options.execute) executeMarket = preloaded.market;
      }
      const result = await scanOnce({
        rpc: scanRpc,
        marketAddress: options.market,
        options: scanConfig,
        preloaded,
        effectiveHealthWatch: surgeActive ? adaptiveBand : undefined,
      });
      lastScanCompletedAt = Date.now();
      log?.({ type: "snapshot", at: result.scannedAt, result });
      // Watchboard ingest: near-miss cohort enters as WATCH, DUE enters red.
      for (const candidate of result.nearMiss) {
        boardUpdate(candidate.obligation, {
          health: candidate.healthFactor,
          healthSource: "scan",
          debtSymbol: (candidate.repayDebt ?? candidate.largestDebt).symbol,
          debtUsd: (candidate.repayDebt ?? candidate.largestDebt).amountUsd,
          prizeUsd: candidate.estimatedProfitUsd ?? 0,
        });
      }
      for (const candidate of result.liquidatable) {
        boardUpdate(candidate.obligation, {
          health: candidate.healthFactor,
          healthSource: "scan",
          debtSymbol: (candidate.repayDebt ?? candidate.largestDebt).symbol,
          debtUsd: (candidate.repayDebt ?? candidate.largestDebt).amountUsd,
          prizeUsd: candidate.estimatedProfitUsd ?? 0,
          status: "UNHEALTHY",
        });
      }
      boardSweep();
      // Feed the hot tracker: full scan acts as ground truth for tracked DUE positions
      const absorbEvents = tracker.absorb([...result.liquidatable, ...result.nearMiss], result.scannedAt);
      syncObligationSubscriptions();
      if (absorbEvents.length) emitTrackerEvents(absorbEvents);
      // Register observed pairs without issuing requests. Prewarming is a
      // bounded, paced pass after this scan; fresh fire-path reads are on demand.
      if (executeMarket) {
        const { getClmmQuoter } = await import("./strategies/liquidation/clmm.js");
        const { PublicKey } = await import("@solana/web3.js");
        const quoter = getClmmQuoter(options.rpc);
        // symbol → liquidity mint (the market's own reserve map)
        const mintBySymbol = new Map<string, string>();
        for (const reserve of executeMarket.getReserves()) {
          mintBySymbol.set(reserve.getTokenSymbol(), reserve.getLiquidityMint().toString());
        }
        mintBySymbol.set("WSOL", "So11111111111111111111111111111111111111112");
        const pairs = new Set<string>();
        for (const candidate of [...result.liquidatable, ...result.nearMiss]) {
          const debtMint = mintBySymbol.get((candidate.repayDebt ?? candidate.largestDebt).symbol);
          if (!debtMint) continue;
          for (const symbol of candidate.collateralSymbols) {
            const collMint = mintBySymbol.get(symbol);
            if (!collMint || collMint === debtMint) continue;
            const key = [collMint, debtMint].sort().join("|");
            if (pairs.has(key)) continue;
            pairs.add(key);
            quoter.keepWarm(new PublicKey(collMint), new PublicKey(debtMint));
          }
        }
        if (pairs.size) {
          const { getClmmQuoter } = await import("./strategies/liquidation/clmm.js");
          const quoter = getClmmQuoter(options.rpc);
          await quoter.loadAllWarm().then((ok) => {
            if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] clmm prewarm: ${ok} refreshed (max 2 per scan; ${pairs.size} observed pairs)`));
          });
        }
      }
      // Adaptive surge widening: DUE presence widens the watch band so the next full
      // scan hydrates positions further from the line before they cross; calm clears it.
      const dueCount = result.liquidatable.length;
      if (dueCount > 0) {
        const widened = Math.min(scanConfig.healthWatch * 2, scanConfig.healthWatch * (1 + Math.min(dueCount, 50) / 25));
        const newBand = Math.max(scanConfig.healthWatch, widened);
        if (newBand > adaptiveBand) {
          adaptiveBand = newBand;
          if (!surgeActive) {
            console.log(color.bold(color.red(`⚑ SURGE MODE ON — DUE=${dueCount}, watch band widened to ${adaptiveBand.toFixed(2)}`)));
            alerter.push(surgeAlert(true, dueCount, adaptiveBand));
          }
          surgeActive = true;
        }
      } else if (surgeActive && tracker.dueObligations().length === 0) {
        adaptiveBand = scanConfig.healthWatch;
        surgeActive = false;
        console.log(color.green("⚑ SURGE MODE OFF — market calmed, watch band back to normal"));
        alerter.push(surgeAlert(false, 0, adaptiveBand));
      }
      log?.({
        type: "summary",
        at: new Date().toISOString(),
        obligationsScanned: result.obligationsScanned,
        shortlistScanned: result.shortlistScanned,
        liquidatable: result.liquidatable.length,
        nearMiss: result.nearMiss.length,
        hotTracked: tracker.size,
        hotDue: tracker.dueObligations().length,
        hotWatch: tracker.size - tracker.dueObligations().length,
        adaptiveBand,
      });
      // Near-miss Telegram digest disabled by operator decision — the console
      // NEAR MISS panel is the visibility for this tier; TG only carries action
      // signals (DUE attempts, fires, losses, heartbeats).
      if (options.json) console.log(safeJsonStringify(result));
      else {
        printScanPanel(cycle, result, scanConfig.nearMissHealth, !options.watch);
        printTrace(cycle, result);
        // ── Watchboard panel: the live cohort across ALL rails ──
        // Table layout, FULL obligation addresses (never truncated — they're
        // the copy-paste key for solscan/ledger forensics), aligned columns,
        // sorted by: DUE-tier status first, then health ascending (closest to
        // liquidation at the top), newest activity breaking ties. Capped at 30.
        if (watchboard.size) {
          const statusRank: Record<WatchboardRow["status"], number> = {
            UNHEALTHY: 0, EXECUTOR: 1, FIRED: 2, LOST: 3, WATCH: 4, HEALED: 5,
          };
          const rows = [...watchboard.values()]
            .sort((a, b) => (statusRank[a.status] - statusRank[b.status])
              || (a.health - b.health)
              || (b.lastSeen - a.lastSeen))
            .slice(0, 30);
          const dueCount = rows.filter((r) => r.status === "UNHEALTHY" || r.status === "EXECUTOR").length;
          console.log(
            color.bold(color.cyan("▤ WATCHBOARD")) +
            color.dim(`  ${watchboard.size} live · EST.$ after protocol/flash fees, before swap/network costs`) +
            (dueCount ? color.bold(color.red(`  ⚡ ${dueCount} IN DUE TIER`) as string) : ""),
          );
          // Column header — built with the SAME pads as the rows below so every
          // column left-aligns exactly with its data cells.
            console.log(color.dim(
            "  " + "STATUS".padEnd(11) + "OBLIGATION".padEnd(46) + "HEALTH".padEnd(11)
              + "AGE".padEnd(7) + "DEBT".padEnd(15) + "EST.$".padEnd(7) + "HELD",
          ));
          for (const row of rows) {
            const statusPlain = {
              WATCH: "WATCH",
              UNHEALTHY: "UNHEALTHY",
              EXECUTOR: "EXECUTOR",
              FIRED: "FIRED",
              LOST: "LOST",
              HEALED: "HEALED",
            }[row.status];
            const statusCell = {
              WATCH: color.yellow("WATCH"),
              UNHEALTHY: color.bold(color.red("UNHEALTHY")),
              EXECUTOR: color.bold(color.magenta("EXECUTOR")),
              FIRED: color.bold(color.green("FIRED")),
              LOST: color.bold(color.red("LOST")),
              HEALED: color.green("HEALED"),
            }[row.status];
            // HELD = how long the position has held its CURRENT status
            // ("in this state for Ns") — the "stuck at 1.004 for 40 minutes"
            // signal. Not a data-age clock: the scan itself just refreshed every
            // tracked row at panel-print time (data-age would always read 0s).
            const statusForSec = Math.max(0, Math.round((Date.now() - row.statusSince) / 1000));
            const forText = statusForSec >= 3600 ? `${(statusForSec / 3600).toFixed(1)}h` : statusForSec >= 60 ? `${Math.round(statusForSec / 60)}m` : `${statusForSec}s`;
            const healthText = Number.isFinite(row.health) ? row.health.toFixed(6) : "       ?";
            const healthCell = Number.isFinite(row.health)
              ? (row.health < 1 ? color.bold(color.red(healthText))
                : row.health < 1.01 ? color.white(healthText)
                : color.dim(healthText))
              : color.dim(healthText);
            const healthPad = (Number.isFinite(row.health) ? row.health.toFixed(6) : "       ?").padEnd(11);
            const healthAgeSec = row.healthAt > 0 ? Math.max(0, Math.round((Date.now() - row.healthAt) / 1000)) : -1;
            const healthAgeText = healthAgeSec < 0 ? "?" : healthAgeSec >= 3600 ? `${(healthAgeSec / 3600).toFixed(1)}h` : healthAgeSec >= 60 ? `${Math.round(healthAgeSec / 60)}m` : `${healthAgeSec}s`;
            const healthAgeCell = color.dim(healthAgeText.padEnd(7));
            const debtText = row.debtUsd > 0
              ? `${row.debtUsd >= 10000 ? `${(row.debtUsd / 1000).toFixed(1)}k` : row.debtUsd.toFixed(0)} ${row.debtSymbol}`
              : "—";
            const debtCell = color.yellow(debtText.padEnd(15));
            const prizeText = row.prizeUsd > 0 ? `$${row.prizeUsd.toFixed(2)}` : "—";
            const prizeCell = color.green(prizeText.padEnd(7));
            const forCell = color.dim(forText);
            console.log(
              `  ${statusCell}${" ".repeat(Math.max(1, 11 - statusPlain.length))}${color.cyan(row.obligation)}  ` +
                `${healthCell}${" ".repeat(Math.max(1, healthPad.length - healthText.length + 2))}${healthAgeCell}${debtCell}${prizeCell}${forCell}`,
            );
          }
        }
      }
      return result;
    };
    if (!options.watch) {
      await runOnce(1);
      return;
    }
    console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] watching every ${intervalMs / 1000}s (hot ${hotIntervalMs / 1000}s, band ${hotBand}) — Ctrl+C to stop`));
    if (alerter.enabled) {
      alerter.push(startupAlert({ cyclesPerHour: Math.round(3_600_000 / intervalMs), hotIntervalSec: hotIntervalMs / 1000, broadcast: options.broadcast, wsLive: options.watch }));
      console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] telegram alerts enabled (chat ${process.env.TELEGRAM_CHAT_ID})`));
    }
    // Periodic Telegram heartbeat — the eval surface for "is the system alive and
    // what did it do" (mirrors the repo pattern's 60s STATS line, delivered to TG
    // hourly instead of spamming).
    if (options.watch && !options.json) {
      setInterval(() => {
        void (async () => {
          const wallet = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
          const walletSol = await scanRpc
            .getBalance(wallet.address)
            .send()
            .then((r) => Number(r.value) / 1e9)
            .catch(() => 0);
          const losses = raceLostStats();
          alerter.push(heartbeatAlert({
            uptimeMinutes: Math.round((Date.now() - executorStats.startedAt) / 60_000),
            cycles: executorStats.cycles,
            nearMissCount: tracker.size,
            dueTriggers: executorStats.dueTriggers,
            dueAttempted: executorStats.dueAttempted,
            dueFired: executorStats.dueFired,
            vetoDust: executorStats.vetoDust,
            vetoHealth: executorStats.vetoHealth,
            selfHealed: executorStats.selfHealed,
            lostRaces: losses.count,
            lostPrizeUsd: losses.prizeUsd,
            walletSol,
            mode: options.broadcast ? "live" : "shadow",
            wsLive: wsRailAlive(),
            wsActive: websocketEndpointLabel(activeWsEndpoint, wsUrl, fallbackWsUrl),
            // Failover telemetry must cover BOTH transports. The HTTP failover is a
            // separate code path (createFailoverRpc) from the wsCandidates rotation,
            // so a bot whose WS had rotated to the fallback provider still reported
            // `onFallback: false` — 40h of logs contained ZERO `rpc-failover` lines
            // while the WS rail was demonstrably serving from the fallback.
            rpcOnFallback: failoverHealth({ primaryUrl: options.rpc, fallbackUrl: process.env.SOLANA_RPC_FALLBACK ?? "" }).onFallback
              || websocketRole(activeWsEndpoint, wsUrl, fallbackWsUrl) === "fallback",
            ...(executorStats.lastFailure ? { lastFailure: executorStats.lastFailure } : {}),
          }));
        })();
      }, 60 * 60_000).unref();
    }
    // Heartbeat + ticker share the WS-rail aliveness flag — set by onReady,
    // cleared by onError/subscribe-fail; a DOWN rail means the bot races blind
    // and the heartbeat must say so.
    let wsRailState: "connecting" | "live" | "down" = "connecting";
    const wsRailAlive = (): boolean => {
      const stats = wsHandle?.stats();
      return stats ? stats.active === stats.desired && (stats.desired > 0 || cycle > 0) : wsRailState === "live";
    };
    let cycle = 0;
    let fullScanPromise: Promise<void> | null = null;
    let nextFullScan = 0;
    let nextHotTick = 0;
    // ── Realtime detection: exact accounts in the tracked watch/DUE cohort ──
    // WS deltas are the LOW-LATENCY path (per-account changes arrive within ~1 slot
    // vs the 10s hot loop / 60s full scan). A cached health < 1 here is a signal to
    // go straight to executeDue — every later stage (fresh hydration, guards, sim,
    // broadcast) is owned by the executor, so we never execute on stale slate.
    const wsUrl = options.ws || options.rpc.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    // Auto-fallback WS rotation: primary → SOLANA_RPC_FALLBACK wss, both on our
    // own provider. ws-realtime advances one spot per failed attempt, so a dead
    // primary falls through by itself. An explicit --ws override pins a single
    // endpoint. The public Solana cluster is deliberately NOT a candidate: it has
    // no SLA, shares one connection budget with the whole network, and sits far
    // enough behind that our minContextSlot guards reject its responses — a
    // rotation onto it looked "healthy" while silently starving the rails.
    const fallbackWsUrl = (process.env.SOLANA_RPC_FALLBACK ?? "").replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const wsCandidates = options.ws
      ? undefined
      : [...new Set([wsUrl, fallbackWsUrl].filter(Boolean))];
    let activeWsEndpoint = "";
    if (options.watch) {
      // ── WS rail observability ──
      // Every tracked account shares ONE socket, so the provider recycling that
      // socket takes all ~55 subscriptions down inside the same tick. Logging each
      // failure separately produced 440+ near-identical lines in 12h and still never
      // said whether the WHOLE rail had dropped — the one fact that separates a
      // harmless socket recycle from "we are racing blind". Consecutive failures
      // inside WS_ERROR_BURST_GAP_MS collapse into a single line carrying the rail
      // size at the moment it broke plus the endpoint it broke on.
      const WS_ERROR_BURST_GAP_MS = 3_000;
      const WS_RAIL_SAMPLE_MS = 10_000;
      const WS_RAIL_DOWN_ALERT_AFTER_MS = 30_000;
      const WS_RAIL_ALERT_COOLDOWN_MS = 15 * 60_000;
      // Deploy grace: subscriptions are paced one every startIntervalMs (100ms), so
      // the rail reads "down" for the first few seconds of every clean boot.
      const WS_RAIL_GRACE_MS = 60_000;
      const railSamplerStartedAt = Date.now();
      let wsErrBurst = 0, wsErrFirstAt = 0, wsErrLastAt = 0;
      let wsErrEndpoint = "", wsErrMessage = "";
      let wsErrRailAtStart: { active: number; desired: number } | undefined;
      let wsDownSince: number | null = null;
      let wsDownAlerted = false;
      let wsLastDownAlertAt = 0;

      const endpointLabelFor = (endpoint: string): string => websocketEndpointLabel(endpoint, wsUrl, fallbackWsUrl);

      const flushWsErrorBurst = (): void => {
        if (!wsErrBurst) return;
        const count = wsErrBurst;
        const span = Math.max(0, wsErrLastAt - wsErrFirstAt);
        const endpoint = wsErrEndpoint;
        const message = wsErrMessage;
        const railAtStart = wsErrRailAtStart;
        wsErrBurst = 0; wsErrFirstAt = 0; wsErrLastAt = 0; wsErrRailAtStart = undefined;
        if (options.json) return;
        const rail = railAtStart ? `${railAtStart.active}/${railAtStart.desired} live` : "no subscriptions yet";
        console.warn(color.yellow(`[${localTimestamp(new Date().toISOString())}] ws rail: ${count} subscription failure${count === 1 ? "" : "s"} in ${span}ms — ${rail} — ${endpointLabelFor(endpoint)} — ${message}`));
      };

      const onWsRailError = (error: unknown, failedEndpoint: string): void => {
        const now = Date.now();
        if (wsErrBurst && now - wsErrLastAt > WS_ERROR_BURST_GAP_MS) flushWsErrorBurst();
        if (!wsErrBurst) {
          wsErrFirstAt = now;
          wsErrRailAtStart = wsHandle?.stats();
        }
        wsErrLastAt = now;
        wsErrBurst += 1;
        wsErrEndpoint = failedEndpoint;
        wsErrMessage = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        if (wsRailState === "live") wsRailState = "down";
      };

      // Sampled rather than fired from onError: a socket recycle drops and restores
      // every subscription within ~1-2s, and we saw ~8 of those per 12h. Firing on the
      // event would page for each one and bury a real outage; sampling debounces the
      // recycles to nothing while still catching an outage that outlives them.
      const sampleWsRail = (): void => {
        const now = Date.now();
        const stats = wsHandle?.stats();
        const label = endpointLabelFor(activeWsEndpoint || wsUrl);
        if (wsRailAlive()) {
          if (wsDownSince === null) return;
          const downForMs = now - wsDownSince;
          wsDownSince = null;
          if (wsDownAlerted) {
            wsDownAlerted = false;
            alerter.push(wsRailAlert({ live: true, endpoint: label, downForMs, ...(stats ? { active: stats.active, desired: stats.desired } : {}) }));
          }
          return;
        }
        if (wsDownSince === null) wsDownSince = now;
        if (now - railSamplerStartedAt < WS_RAIL_GRACE_MS) return;
        if (wsDownAlerted || now - wsDownSince < WS_RAIL_DOWN_ALERT_AFTER_MS) return;
        if (now - wsLastDownAlertAt < WS_RAIL_ALERT_COOLDOWN_MS) return;
        wsDownAlerted = true;
        wsLastDownAlertAt = now;
        alerter.push(wsRailAlert({ live: false, endpoint: label, ...(stats ? { active: stats.active, desired: stats.desired } : {}) }));
      };

      setInterval(() => { if (wsErrBurst && Date.now() - wsErrLastAt >= 1_000) flushWsErrorBurst(); }, 2_000).unref();
      setInterval(sampleWsRail, WS_RAIL_SAMPLE_MS).unref();

      const wsLogged = new Map<string, number>();
      wsHandle = subscribeTrackedObligations({
        wsUrl,
        ...(wsCandidates ? { wsCandidates } : {}),
        onInvalidate: (account) => { snapshots.delete(account); },
        onSlice: (slice) => {
          const obligation = slice.pubkey.toString();
          const previous = snapshots.get(obligation);
          if (previous?.slot !== undefined && slice.slot !== undefined && slice.slot < previous.slot) return;
          snapshots.set(obligation, slice);
          // Feed every tracked-band slice to the board (WATCH ↔ UNHEALTHY
          // transitions), not just the <1.0 triggers.
          const health = slice.cachedHealth;
          if (Number.isFinite(health) && (health < 1.05 || watchboard.has(obligation))) {
            boardUpdate(obligation, { health, ...(slice.receivedAt !== undefined ? { healthAt: slice.receivedAt } : {}), healthSource: "ws", ...(health < 1 ? { status: "UNHEALTHY" } : {}) });
          }
           if (health >= 1) {
             // Healed back above 1.0 — disarm any armed fast-retry (position
             // recovered) AND release a lane-stuck EXECUTOR row: a position the
             // WS now sees healthy is back in the tracked cohort (WATCH), not
             // mid-verdict-chain.
             if (executorStillDue.has(obligation) || (watchboard.get(obligation)?.status === "EXECUTOR" || watchboard.get(obligation)?.status === "UNHEALTHY")) {
               executorStillDue.delete(obligation);
               boardUpdate(obligation, { status: "HEALED", health, ...(slice.receivedAt !== undefined ? { healthAt: slice.receivedAt } : {}), healthSource: "ws" });
             }
             return;
           }
          // Still < 1.0: if a fast-retry is armed (sim said healthy but WS disagrees),
          // every further slice re-triggers the 5s race until the window closes.
          executeDue(obligation, { rail: "ws", streamSnapshot: slice });
          const lastLogged = wsLogged.get(obligation) ?? 0;
          if (Date.now() - lastLogged < 30_000) return;
          wsLogged.set(obligation, Date.now());
          const wsEvent = { type: "ws-due", at: new Date(slice.receivedAt ?? Date.now()).toISOString(), obligation, health: slice.cachedHealth, slot: slice.slot?.toString() };
          log?.(wsEvent as never);
          if (options.json) console.log(safeJsonStringify(wsEvent));
          else console.log(`${color.bold(color.red("⚡ WS DUE"))} ${shortAddress(obligation)}  health ${slice.cachedHealth.toFixed(4)}`);
          // The WS slice's stored-sf ratio is the health at the moment the program last
          // wrote the account — a low-latency TRIGGER, not proof. Prices move between that
          // write and our fire: the race rail runs the executor with SIM as the single
          // arbiter (the tx's own RefreshObligation re-checks on fresh prices).
        },
        onReady: (endpoint: string) => {
          wsRailState = "live";
          activeWsEndpoint = endpoint;
          // Close out the failure burst this recovery belongs to, so the summary
          // lands now instead of waiting on the 2s flush timer.
          flushWsErrorBurst();
          const label = endpointLabelFor(endpoint);
          if (!options.json && (wsHandle?.stats().active === 1)) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] tracked account WS live (${label})`));
        },
        onError: onWsRailError,
      });
      syncObligationSubscriptions();
      // Discovery supplies the first account set; do not await subscriptions.

    }
    setInterval(() => {
      const stats = wsHandle?.stats();
      if (stats && !options.json) console.log(color.dim(`[WS-USAGE] accounts=${stats.active}/${stats.desired} notifications=${stats.received} payloadMB=${(stats.payloadBytes / 1e6).toFixed(3)} duplicates=${stats.duplicates} reconnects=${stats.reconnects}`));
    }, 60_000).unref();
    setInterval(() => {
      writeHeartbeat({ at: Date.now(), pid: process.pid, scanAt: lastScanCompletedAt,
        hotAt: lastHotCompletedAt, oracleAt: oracleCache.lastUpdateAt, oracleLive,
        oracleSnapshotAgeMs: oracleCache.snapshotAgeMs, wsLive: wsRailAlive(),
        executorBusy: executorBusy.size, scanMaxAgeMs: Math.max(300_000, intervalMs * 3),
      });
    }, 10_000).unref();
    while (true) {
      const now = Date.now();
      if (now >= nextFullScan && !fullScanPromise) {
        cycle += 1;
        nextFullScan = now + intervalMs;
        nextHotTick = now + hotIntervalMs;
        fullScanPromise = runOnce(cycle)
          .then(() => undefined)
          .catch((error: unknown) => printError(error))
          .finally(() => { fullScanPromise = null; });
        continue;
      }
      if (now >= nextHotTick) {
        nextHotTick = now + hotIntervalMs;
        // Hot ticks run even while a full scan is in flight (concurrent), so surge crossings
        // are never starved by a long hydration pass.
        hotTick().catch((error) => printError(error));
        continue;
      }
      await sleep(Math.max(50, Math.min(nextFullScan, nextHotTick) - now));
    }
  });

program
  .command("alt-reclaim")
  .description("close rent-locked accounts (empty look-up tables + zero-balance ATAs) owned by this wallet, keeping the ones the bot uses; --yes actually closes")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--yes", "broadcast close txs after listing (default: dry-run)", false)
  .action(async (options: { rpc: string; yes: boolean }) => {
    const rpc = rpcClient(options.rpc);
    const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
    const keep = new Set(altTableAddresses(loadAltState()));
    console.log(`wallet ${signer.address} — keeping in-use tables: ${[...keep].join(", ") || "(none — primary/hot will be re-created on demand)"}`);

    // 1) look-up tables owned by this wallet (LUT account: authority pubkey at data offset 22)
    const LUT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
    const fetchJson = async (method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> => {
      const res = await fetch(options.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return res.json() as Promise<{ result?: unknown; error?: { message?: string } }>;
    };
    const gpa = await fetchJson("getProgramAccounts", [
      LUT_PROGRAM,
      { commitment: "finalized", encoding: "base64", filters: [{ memcmp: { offset: 22, bytes: signer.address } }] },
    ]);
    const lutRows: { pubkey: string; deactivationSlot: bigint; rentLamports: number }[] = [];
    for (const a of (gpa.result as { pubkey: string; account: { data: [string]; lamports: number } }[]) ?? []) {
      const bytes = Buffer.from(a.account.data[0], "base64");
      lutRows.push({
        pubkey: a.pubkey,
        deactivationSlot: bytes.readBigUInt64LE(4),
        rentLamports: a.account.lamports,
      });
    }
    const reclaimLuts = lutRows.filter((row) => !keep.has(row.pubkey));
    const activeSlotResult = (await fetchJson("getSlot", [{ commitment: "finalized" }])) as { result: number };
    const currentSlot = typeof activeSlotResult.result === "number" ? BigInt(activeSlotResult.result) : 0n;

    for (const row of lutRows) {
      const inUse = keep.has(row.pubkey);
      console.log(`${inUse ? "KEEP" : "FREE"} LUT ${row.pubkey} deactivation_slot=${row.deactivationSlot.toString()} rent=₿${(row.rentLamports / 1e9).toFixed(6)} ${inUse ? "" : "→ reclaimable"}`);
    }

    // 2) zero-balance token accounts (standard token program)
    const tokenResult = (await fetchJson("getTokenAccountsByOwner", [
      signer.address,
      { programId: TOKEN_PROGRAM_ADDRESS },
      { encoding: "jsonParsed" },
    ])) as { result?: { value?: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } }; lamports: number } }[] } };
    const ataRows: { pubkey: string; mint: string; balance: bigint; lamports: number }[] = [];
    for (const a of tokenResult.result?.value ?? []) {
      ataRows.push({
        pubkey: a.pubkey,
        mint: a.account.data.parsed.info.mint,
        balance: BigInt(a.account.data.parsed.info.tokenAmount.amount),
        lamports: a.account.lamports,
      });
    }
    const reclaimAtas = ataRows.filter((row) => row.balance === 0n);
    let totalRent = 0n;
    for (const row of reclaimLuts) totalRent += BigInt(row.rentLamports);
    for (const row of reclaimAtas) totalRent += BigInt(row.lamports);
    console.log(`\nreclaimable: ${reclaimLuts.length} LUT + ${reclaimAtas.length} zero-balance ATA = ₿${(Number(totalRent) / 1e9).toFixed(6)} SOL ≈ $${((Number(totalRent) / 1e9) * 154).toFixed(2)}`);
    for (const row of reclaimAtas) console.log(`  FREE ATA ${row.pubkey} mint=${row.mint.slice(0, 8)}… rent=₿${(row.lamports / 1e9).toFixed(6)}`);

    if (!options.yes) {
      console.log(color.dim("dry-run only — re-run with --yes to broadcast the closes"));
      return;
    }
    const setupIxs: Instruction[][] = [];
    for (const row of reclaimLuts) {
      if (row.deactivationSlot === 0xffffffffffffffffn) {
        setupIxs.push([deactivateLookupTableIx(signer, address(row.pubkey))]);
        console.log(`  → deactivate ${row.pubkey}`);
      }
    }
    for (const [index, ixs] of setupIxs.entries()) {
      try {
        const tx = await createSignedTransactionWithAlt(rpc, options.rpc, signer, ixs, []);
        await sendAndConfirmPoll(rpc, tx, 15_000);
        console.log(`  ✓ deactivated ${index + 1}/${setupIxs.length}`);
      } catch (error) {
        console.log(color.yellow(`  ⚠ deactivate skipped (${(error instanceof Error ? error.message : String(error)).slice(0, 120).replace(/\n/g, " ")}) — will retry on the next run once the wallet is funded`));
      }
    }
    const fetchSlot = async (): Promise<bigint> => {
      const res = (await fetchJson("getSlot", [{ commitment: "finalized" }])) as { result: number };
      return BigInt(typeof res.result === "number" ? res.result : 0);
    };
    const fetchDeactivationSlot = async (pubkey: string): Promise<bigint> => {
      // jsonParsed responses do not reliably expose the freshly written slot
      // immediately after deactivate. The ALT state layout stores it at byte
      // offset 4, so read the raw account data just as the inventory scan does.
      const info = (await fetchJson("getAccountInfo", [pubkey, { commitment: "finalized", encoding: "base64" }])) as {
        result?: { value?: { data?: [string, string] } };
      };
      const encoded = info.result?.value?.data?.[0];
      if (!encoded) return 0xffffffffffffffffn;
      try {
        return Buffer.from(encoded, "base64").readBigUInt64LE(4);
      } catch {
        return 0xffffffffffffffffn;
      }
    };
    for (const row of [...reclaimLuts]) {
      if (keep.has(row.pubkey)) continue;
      const deactivationSlot = row.deactivationSlot === 0xffffffffffffffffn ? await fetchDeactivationSlot(row.pubkey) : row.deactivationSlot;
      let slot = await fetchSlot();
      if (deactivationSlot !== 0xffffffffffffffffn) {
        while (slot < deactivationSlot + 513n) {
          console.log(`  waiting for deactivation cooldown… slot ${slot.toString()}/${(deactivationSlot + 513n).toString()}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          slot = await fetchSlot();
        }
      }
      const tx = await createSignedTransactionWithAlt(rpc, options.rpc, signer, [closeLookupTableIx(signer, address(row.pubkey))], []);
      try {
        await sendAndConfirmPoll(rpc, tx, 45_000);
        console.log(`  ✓ closed LUT ${row.pubkey}`);
      } catch (error) {
        console.log(color.yellow(`  ⚠ LUT close skipped (${(error instanceof Error ? error.message : String(error)).slice(0, 160).replace(/\n/g, " ")})`));
      }
    }
    const closeBatches: Instruction[][] = [];
    let batch: Instruction[] = [];
    for (const row of reclaimAtas) {
      batch.push(getCloseAccountInstruction({ account: address(row.pubkey), destination: signer.address, owner: signer }));
      if (batch.length >= 6) { closeBatches.push(batch); batch = []; }
    }
    if (batch.length) closeBatches.push(batch);
    for (const [index, ixs] of closeBatches.entries()) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const tx = await createSignedTransactionWithAlt(rpc, options.rpc, signer, ixs, []);
        try {
          await sendAndConfirmPoll(rpc, tx, 45_000);
          console.log(`  ✓ closed ATA batch ${index + 1}/${closeBatches.length}`);
          break;
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).replace(/\n/g, " ");
          if (message.includes("failed on-chain")) {
            console.log(color.yellow(`  ⚠ ATA batch ${index + 1} rejected (${message.slice(0, 160)})`));
            break;
          }
          console.log(color.yellow(`  ⚠ ATA batch ${index + 1} attempt ${attempt}/3 failed (${message.slice(0, 100)})${attempt < 3 ? " — retrying with fresh blockhash" : ""}`));
          if (attempt === 3) break;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
    console.log(color.green(`✅ reclaim complete — rent returned to wallet`));
  });

program
  .command("liq-setup")
  .description("one-time: create our persistent ALT + pre-create hot ATAs so liquidation txs fit the 1232-byte packet")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--symbols <list>", "comma-separated reserve symbols to include (default: the common liquidation pairs)", "USDC,SOL,USDT,FDUSD,USDS,JitoSOL,JupSOL")
  .option("--all", "include every reserve in the market", false)
  .option("--reuse-alt <address>", "extend an existing ALT instead of creating a new one", "")
  .option("--companion-alts <list>", "comma-separated existing LUTs to use as the overflow tables (extends them instead of creating new — resume an aborted run)", "")
  .action(async (options: { rpc: string; market: string; symbols: string; all: boolean; reuseAlt: string; companionAlts: string }) => {
    const rpc = rpcClient(options.rpc);
    const market = await loadMarket(rpc, options.market);
    const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
    const mem = () => `rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB heap=${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB`;
    const wanted = options.all ? null : new Set(options.symbols.split(",").map((s) => s.trim().toUpperCase()));
    const reserves = market.getReserves().filter((reserve: KaminoReserve) => !wanted || wanted.has(reserve.getTokenSymbol().toUpperCase()));
    console.log(`reserves in scope (${reserves.length}): ${reserves.map((r: KaminoReserve) => r.getTokenSymbol()).join(", ")} (${mem()})`);

    // Reuse the persisted tables by default. A plain `liq-setup` must be
    // idempotent; creating another rent-locked LUT requires an explicit
    // override or an empty state file.
    const savedState = loadAltState();
    const reuseAlt = options.reuseAlt
      ? address(options.reuseAlt)
      : savedState?.lookupTable
        ? address(savedState.lookupTable)
        : undefined;
    const companionAlts = options.companionAlts
      ? options.companionAlts.split(",").map((s) => s.trim()).filter(Boolean).map((a) => address(a))
      : (savedState?.complements?.map((c) => address(c.lookupTable)) ?? []);
    const tableAddresses = reuseAlt ? [reuseAlt, ...companionAlts] : [];
    const tableKeys = await Promise.all(tableAddresses.map((table) => getAccountsInLut(rpc, table)));
    const existingKeys = tableKeys.length ? tableKeys.flat() : undefined;
    const existingTableKeyCounts = tableKeys.length ? tableKeys.map((keys) => keys.length) : undefined;
    const { transactions, lookupTable, keyCount, complements, kinds } = await buildLiquidationSetup({
      rpc,
      market,
      reserves,
      signer,
      rpcUrl: options.rpc,
      ...(reuseAlt ? { existingLookupTable: reuseAlt } : {}),
      ...(companionAlts.length ? { existingCompanionAlts: companionAlts } : {}),
      ...(existingKeys?.length ? { existingKeys: existingKeys.map((k: string) => address(k)) } : {}),
      ...(existingTableKeyCounts ? { existingTableKeyCounts } : {}),
      skipAta: true,
    });
    console.log(`ALT ${lookupTable} will hold ${keyCount} keys${existingKeys?.length ? ` (${existingKeys.length} already present)` : ""} across ${transactions.length} transactions… (${mem()})`);
    if (complements.length) console.log(color.dim(`  companion tables for the overflow: ${complements.map((c) => `${c.lookupTable} (${c.keyCount} keys)`).join(", ")}`));
    for (const [index, instructions] of transactions.entries()) {
      const kind = kinds[index] ?? "tx";
      if (!instructions.length) continue;
      const setupTx = await createSignedTransactionWithAlt(rpc, options.rpc, signer, instructions, []);
      try {
        const signature = await sendAndConfirmPoll(rpc, setupTx, 45_000);
        console.log(color.green(`  ✅ setup tx ${index + 1}/${transactions.length} [${kind}] ${signature} (${mem()})`));
      } catch (error) {
        // Best-effort semantics: ATA pre-creation can fail for exotic reserves
        // (e.g. non-Associated weirdness) and is NOT load-bearing — the executor
        // creates any missing ATA inside the fire's setupInstructions anyway.
        // The ALT create/extend txs are the critical ones; a failure there is
        // caught by the coverage check below instead of aborting mid-run.
        console.log(color.yellow(`  ⚠ setup tx ${index + 1}/${transactions.length} [${kind}] skipped (${(error instanceof Error ? error.message : String(error)).slice(0, 160).replace(/\n/g, " ")})`));
      }
    }
    // Honest complements: only record companion tables that actually exist
    // on-chain (sendAndConfirm of the create could still have failed).
    const existingCompanions: typeof complements = [];
    for (const comp of complements) {
      const probe = getAccountsInLut(rpc, address(comp.lookupTable));
      const [[probed]] = await Promise.all([probe]);
      if (probed && probed.length > 0) existingCompanions.push(comp);
    }
    if (existingCompanions.length !== complements.length) {
      console.log(color.red(`  ✗ ${complements.length - existingCompanions.length} companion table(s) did NOT materialize — re-run liq-setup extends them`));
    }
    console.log(color.green(`✅ SETUP COMPLETE`));
    saveAltState({
      lookupTable: lookupTable.toString(),
      createdAt: new Date().toISOString(),
      authority: signer.address.toString(),
      keyCount,
      ...(existingCompanions.length ? { complements: existingCompanions } : {}),
    });
    console.log(color.bold(color.green(`✔ ALT${complements.length ? "s" : ""} saved to ${ALT_STATE_PATH} — future liquidation txs now compress via the chained tables`)));
  });

program
  .command("liq-execute")
  .description("run the liquidation verdict chain for one obligation (simulate-only unless --yes)")
  .argument("<obligation>", "obligation address to liquidate")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--slippage-bps <n>", "slippage tolerance on the collateral→debt swap", "50")
  .option("--min-profit <usd>", "minimum worst-case net profit in USD", "0.05")
  .option("--bypass-health", "skip the client-side health gate (E2E mechanics test — program still reverts if truly healthy)", false)
  .option("--yes", "broadcast the transaction after passing guards (default: shadow)", false)
  .option("--sender-endpoint <url>", "Helius Sender execution endpoint (execution-only)", process.env.HELIUS_SENDER_ENDPOINT || process.env.LIQ_SENDER_ENDPOINT || "")
  .option("--no-sender", "disable Helius Sender and broadcast directly on --rpc")
  .option("--sender-max-prize <usd>", "prize at/above which Sender Max is used", process.env.LIQ_SENDER_MAX_PRIZE_USD || "5")
  .action(async (obligation: string, options: {
    rpc: string;
    market: string;
    slippageBps: string;
    minProfit: string;
    bypassHealth: boolean;
    yes: boolean;
    sender: boolean;
    senderEndpoint: string;
    senderMaxPrize: string;
  }) => {
    const rpc = rpcClient(options.rpc);
    const market = await loadMarket(rpc, options.market);
    const altState = loadAltState();
    const senderConfig = senderConfigFromEnv(process.env, {
      endpoint: options.senderEndpoint,
      maxPrizeUsd: Number(options.senderMaxPrize),
      minProfitUsd: Number(options.minProfit),
      ...(options.sender === false ? { enabled: false } : {}),
    });
    const outcome = await executeLiquidationOnce({
      rpc,
      rpcUrl: options.rpc,
      market,
      obligationAddress: address(obligation),
      slippageBps: Number(options.slippageBps),
      minProfitUsd: Number(options.minProfit),
      ...(options.bypassHealth ? { bypassHealth: true } : {}),
      ...(altTableAddresses(altState).length ? { lookupTableAddresses: altTableAddresses(altState).map(address) } : {}),
      sender: senderConfig,
    }).catch((error: unknown) => ({ stage: "assemble", passed: false, reason: error instanceof Error ? error.message : String(error) }) as const);

    if (!outcome.passed) {
      console.log(color.yellow(`${outcome.stage}: ${outcome.reason}`));
      if (outcome.stage === "simulate") (outcome as { logs?: string[] }).logs?.forEach((line) => console.log(color.dim(line)));
      const timings = (outcome as { timings?: Record<string, number> }).timings;
      if (timings && Object.keys(timings).length) {
        const parts = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join("  ");
        const total = Object.values(timings).reduce((a, b) => a + b, 0);
        console.log(color.dim(`⏱ ${parts}  total=${total}ms`));
      }
      process.exitCode = 1;
      return;
    }
    console.log(color.bold(color.green("✔ SIMULATION PASSED")));
    console.log(safeJsonStringify(outcome.plan));
    const timings = (outcome as { timings?: Record<string, number> }).timings;
    if (timings && Object.keys(timings).length) {
      const parts = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join("  ");
      const total = Object.values(timings).reduce((a, b) => a + b, 0);
      console.log(color.dim(`⏱ ${parts}  total=${total}ms`));
    }
    if (!options.yes) {
      console.log(color.dim("shadow — pass --yes to broadcast"));
      return;
    }
    const signature = await broadcastLiquidation({ outcome, dataRpc: rpc, dataRpcUrl: options.rpc, sender: senderConfig });
    console.log(color.green(`✅ FIRED ${signature}`));
  });


program
  .command("alerts-test")
  .description("send a Telegram test alert using TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .env")
  .action(async () => {
    const config = telegramConfigFromEnv(process.env);
    if (!config) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first");
    const alerter = new TelegramAlerter(config);
    alerter.push(testAlert());
    await alerter.flush();
    const stats = alerter.getStats();
    if (stats.sent === 0) throw new Error(`Alert was not delivered (sent=0, dropped=${stats.dropped}) — check token/chat id, and make sure you messaged the bot first`);
    console.log(color.green(`✓ Test alert delivered to chat ${config.chatId}`));
  });

loanOptions(program.command("plan").description("validate inputs and print the exact atomic instruction order"), false)
  .action(async (options: LoanOptions) => {
    const { summary } = await prepare(options, false);
    if (options.json) console.log(safeJsonStringify(summary, 2));
    else {
      printBanner();
      printPlanSummary(summary);
      console.log(centerBlock(`${color.magenta("[PLAN]")} Tidak ada transaksi dikirim`));
    }
  });

loanOptions(program.command("simulate").description("sign and simulate without broadcasting"), true)
  .action(async (options: LoanOptions) => {
    const { rpc, signer, build, summary } = await prepare(options, true);
    if (options.json) console.log(safeJsonStringify(summary, 2));
    else {
      printBanner();
      printPlanSummary(summary);
    }
    assertNoOpRepayable(summary);
    const transaction = await createSignedTransaction(rpc, signer, build.instructions);
    const result = await simulate(rpc, transaction);
    if (options.json) printSimulation(result);
    else printSimulationPanel(result);
    if (result.value.err) process.exitCode = 2;
  });

loanOptions(program.command("execute").description("simulate, then broadcast the atomic transaction"), true)
  .option("--yes", "acknowledge mainnet broadcast", false)
  .action(async (options: LoanOptions) => {
    if (!options.yes) throw new Error("Refusing mainnet broadcast without --yes");
    const { rpc, signer, build, summary } = await prepare(options, true);
    if (options.json) console.log(safeJsonStringify(summary, 2));
    else {
      printBanner();
      printPlanSummary(summary);
    }
    assertNoOpRepayable(summary);
    const transaction = await createSignedTransaction(rpc, signer, build.instructions);
    const simulation = await simulate(rpc, transaction);
    if (options.json) printSimulation(simulation);
    else printSimulationPanel(simulation);
    if (simulation.value.err) throw new Error("Simulation failed; transaction was not broadcast");
    const signature = await sendAndConfirm(options.rpc, rpc, transaction);
    const explorer = `https://solscan.io/tx/${signature}`;
    if (options.json) console.log(safeJsonStringify({ signature, explorer }, 2));
    else {
      console.log(`\n${centerBlock(color.bold(color.green("TRANSACTION CONFIRMED")))}`);
      console.log(centerBlock(`${color.green("✓")} FLASHLOAN  ${color.dim(shortAddress(signature))}  ${terminalLink("OPEN ↗", explorer)}`));
    }
  });

async function main(): Promise<void> {
  if (process.argv.length === 2) {
    if (process.stdin.isTTY) await runInteractive();
    else program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  printError(error);
  process.exitCode = 1;
});
