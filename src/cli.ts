#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { Command } from "commander";
import "./quiet-bigint.js";
import { address, createNoopSigner } from "@solana/kit";
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
import { createSignedTransaction, createSignedTransactionWithAlt, sendAndConfirm, simulate } from "./transaction.js";
import { scanOnce, preloadMarket, refreshTrackedObligations, type PreloadedMarket } from "./strategies/liquidation/screener.js";
import { HotTracker, type TrackerEvent } from "./strategies/liquidation/tracker.js";
import { executeLiquidationOnce } from "./strategies/liquidation/execute.js";
import { buildLiquidationSetup, loadAltState, saveAltState, ALT_STATE_PATH } from "./strategies/liquidation/setup.js";
import { getAccountsInLut } from "@kamino-finance/klend-sdk";
import type { KaminoReserve } from "@kamino-finance/klend-sdk";
import type { ScanEvent, ScanResult, LiquidatableCandidate, AdlCandidate } from "./strategies/liquidation/types.js";
import { type ScanOptions as LiquidationScanConfig } from "./strategies/liquidation/types.js";
import {
  TelegramAlerter,
  telegramConfigFromEnv,
  startupAlert,
  surgeAlert,
  testAlert,
  trackerEventToAlert,
  treasureAlert,
  lstAlert,
  executionAlert, // kept for test compat
  profitAlert,
  liquidationFailedAlert,
  budgetPausedAlert,
  heartbeatAlert,
  dueAttemptAlert,
} from "./alerts/telegram.js";
import { scanArbPass, scanTreasurePass, scanLstPass, DEFAULT_LST_OPTIONS, kaminoLstReference } from "./strategies/arb/scanner.js";
import { fetchSolPriceUsdc } from "./strategies/arb/quotes.js";
import { DEFAULT_ARB_SCAN_OPTIONS, MINTS, type ArbScanOptions, type MintSymbol } from "./strategies/arb/types.js";
import { createRpcClient, PoolFeed } from "./strategies/arb/pools.js";
import { runCvProbe } from "./strategies/arb/cv-probe.js";
import { scanCvPass } from "./strategies/arb/crossvenue-scan.js";
import { runPoolVerify } from "./strategies/arb/pool-verify.js";
import { DEFAULT_TREASURE_OPTIONS, formatCompact, formatSolPrice, type TreasureScanOptions } from "./strategies/arb/treasure.js";
import { LST_REGISTRY } from "./strategies/arb/lst.js";
import { TRIANGLE_TOKENS, planTriangle, usdcFlashFeeBaseUnits } from "./strategies/arb/triangle.js";
import { executeMultiLegCycle, cycleCostsUsd } from "./strategies/arb/execute-triangle.js";
import { DEFAULT_AUTOFIRE_OPTIONS, evaluateFireGuards, loadLedger, logLedgerEntry, type AutofireOptions } from "./strategies/arb/autofire.js";
import { executeLstArbOnce } from "./strategies/arb/execute.js";
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
  slippageBps: string;
  maxAttemptsPerDay: string;
  maxLossPerDay: string;
  ledger: string;
  stopFile: string;
  fast: boolean;
  priorityMode: string;
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
    `DEBT=${color.yellow(`${candidate.largestDebt.amountUsd.toFixed(2)} ${candidate.largestDebt.symbol}`)}`,
    `EST.PROFIT=${color.green(`${(candidate.estimatedProfitUsd ?? 0).toFixed(2)} USD`)}`,
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
    `DEBT=${color.yellow(`${candidate.largestDebt.amountUsd.toFixed(2)} ${candidate.largestDebt.symbol}`)}`,
    color.dim(`COLLATERAL=${candidate.collateralSymbols.join(",") || "n/a"}`),
  ].join("  ");
}

function printScanPanel(cycle: number, result: ScanResult, scanNearMissBand: number): void {
  const { liquidatable, nearMiss, adlMarked, stats } = result;
  console.log(color.bold(color.cyan(`CYCLE #${cycle}`)) + color.dim(`  ${localTimestamp(result.scannedAt)}  scanned=${result.obligationsScanned} hydrated=${result.shortlistScanned}`));
  console.log(color.dim(`skipped: ${stats.nonVanilla} non-vanilla, ${stats.healthy} healthy, ${stats.outOfBand} out of band, ${stats.noFlashDebt} no flash debt, ${stats.staleOracle} stale oracle, ${stats.belowFloor} below floor`));

  if (adlMarked.length) {
    console.log(color.bold(color.magenta(`◆ AUTO-DELEVERAGE MARKED: ${adlMarked.length}`)));
    adlMarked.forEach((candidate) => console.log(printAdlLine(candidate)));
  } else {
    console.log(color.dim("ADL=0"));
  }

  if (liquidatable.length) {
    console.log(color.bold(color.red(`⚡ DUE FOR LIQUIDATION: ${liquidatable.length}`)));
    liquidatable.forEach((candidate, index) => console.log(printCandidateLine(candidate, color.red(`[${index + 1}]`))));
  } else {
    console.log(color.dim("DUE=0"));
  }

  if (nearMiss.length) {
    console.log(color.bold(color.yellow(`⚠ NEAR MISS (health 1.00–${scanNearMissBand.toFixed(2)}): ${nearMiss.length}`)));
    nearMiss.slice(0, 10).forEach((candidate, index) => console.log(printCandidateLine(candidate, color.yellow(`[${index + 1}]`))));
    if (nearMiss.length > 10) console.log(color.dim(`  … and ${nearMiss.length - 10} more`));
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
  .option("--profit-floor <usd>", "minimum estimated gross profit in USD", "0.5")
  .option("--health-watch <ratio>", "hydrate obligations with cached health below this ratio", "1.5")
  .option("--near-miss <ratio>", "report obligations below this health ratio as near-miss", "1.1")
  .option("--watch", "keep scanning in a loop", false)
  .option("--interval <seconds>", "seconds between full scans when --watch is set", "60")
  .option("--hot-interval <seconds>", "seconds between hot refreshes of tracked at-risk obligations", "10")
  .option("--hot-band <ratio>", "near-miss health below which obligations are hot-tracked (watch tier)", "1.02")
  .option("--max-hot-watch <count>", "cap on hot-tracked near-miss obligations (DUE positions are always tracked)", "60")
  .option("--log <path>", "append scan snapshots and watch events as JSON lines to this file")
  .option("--trace <address[,address...]>", "watch specific obligation addresses across cycles (health drift per cycle)")
  .option("--json", "print machine-readable JSON", false)
  .option("--execute", "arm the in-process executor: DUE positions spotted by this scan (or the hot loop) are attempted immediately (shadow unless --broadcast)", false)
  .option("--broadcast", "actually send liquidation transactions (default: shadow — plan+simulate only)", false)
  .option("--min-profit <usd>", "minimum worst-case net profit in USD for the executor to fire (close factor 10% makes plays smaller)", "0.05")
  .option("--slippage-bps <n>", "slippage tolerance on the executor's collateral→debt swap", "50")
  .option("--max-attempts-per-day <n>", "executor broadcast attempt budget (rolling day)", "12")
  .option("--max-loss-per-day <usd>", "executor fee-burn budget per rolling day", "1.5")
  .option("--ledger <path>", "executor attempt/outcome JSONL ledger", "data/liq_autofire_ledger.jsonl")
  .option("--stop-file <path>", "executor kill-switch file", "data/liq_autofire.stop")
  .option("--fast", "FAST mode: single simulation, skip the CU-pinned re-sim roundtrip (~1-2s faster)", false)
  .option("--priority-mode <mode>", "FASTLANE priority fee: off | fixed | auto (auto scales the bid with the prize, capped at 2% of worst-case profit)", "auto")
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
    let preloaded: PreloadedMarket | undefined;
    if (options.watch) preloaded = await preloadMarket(rpcClient(options.rpc), options.market);

    // ── In-process executor (unified pipeline: monitor → risk → execute → notify) ──
    // When --execute is set, DUE events emitted anywhere in this process (full
    // scan, hot tick) flow straight into the verdict chain — no separate
    // container, no file bridge, zero extra detection latency. The scan's
    // preloaded market is reused (no second market-load RPC burst).
    const executeMarket = options.execute ? (preloaded?.market ?? await loadMarket(rpcClient(options.rpc), options.market)) : undefined;
    const executorAltState = loadAltState();
    const executorAutoOptions: AutofireOptions = {
      lsts: [],
      sizeUsd: 0,
      slippageBps: Number(options.slippageBps),
      minProfitUsd: Number(options.minProfit),
      intervalSec: Math.max(1, Number(options.interval)),
      cooldownSec: 30,
      maxAttemptsPerDay: Number(options.maxAttemptsPerDay),
      maxLossPerDayUsd: Number(options.maxLossPerDay),
      ledgerPath: options.ledger,
      stopFilePath: options.stopFile,
    };
    const executorCooldownMs = 30_000;
    const executorRecentlyTried = new Map<string, number>();
    const executorBusy = new Set<string>();
    // Runtime stats for the heartbeat alert — the post-mortem data when things
    // don't work as expected (how many DUE we saw, tried, fired, and lost).
    const executorStats = {
      startedAt: Date.now(),
      cycles: 0,
      dueAttempted: 0,
      dueFired: 0,
      liquidatedByOthers: 0,
      lastFailure: undefined as string | undefined,
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
    const executeDue = (obligation: string): void => {
      if (!options.execute || !executeMarket) return;
      if (executorBlocklist.has(obligation)) return;
      const noRoute = executorNoRouteUntil.get(obligation) ?? 0;
      if (Date.now() < noRoute) return;
      if (executorBusy.has(obligation)) return;
      const last = executorRecentlyTried.get(obligation) ?? 0;
      if (Date.now() - last < executorCooldownMs) return;
      executorRecentlyTried.set(obligation, Date.now());
      executorBusy.add(obligation);
      void (async () => {
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
          let hydrated: Awaited<ReturnType<typeof refreshTrackedObligations>> = [];
          for (let tryIndex = 0; tryIndex < 3 && !hydrated.length; tryIndex++) {
            try {
              hydrated = await refreshTrackedObligations({ rpc: rpcClient(options.rpc), preloaded: preloaded!, pubkeys: [address(obligation)] });
            } catch {
              if (tryIndex === 2) return;
              await new Promise((resolve) => setTimeout(resolve, 750 * (tryIndex + 1)));
            }
          }
          const candidate = hydrated[0];
          if (!candidate || candidate.healthFactor >= 1) return;
          // (position-age guard: hydration above IS the freshness guarantee — the
          // candidate data was fetched seconds ago, never stale cached state)
          // The prize drives the FASTLANE bid (auto mode) — worst-case profit on the table.
          const prizeUsd = Math.max(0, candidate.estimatedProfitUsd ?? 0);
          const runExecutor = () =>
            executeLiquidationOnce({
              rpc: rpcClient(options.rpc),
              rpcUrl: options.rpc,
              market: executeMarket,
              obligationAddress: address(obligation),
              slippageBps: executorAutoOptions.slippageBps,
              minProfitUsd: executorAutoOptions.minProfitUsd,
              ...(executorAltState ? { lookupTableAddresses: [address(executorAltState.lookupTable)] } : {}),
              ...(options.fast ? { fast: true } : {}),
              ...({ priorityMode: (["off", "fixed", "auto"] as const).includes(options.priorityMode as never) ? (options.priorityMode as "off" | "fixed" | "auto") : "auto", prizeUsd }),
            }).catch((error: unknown) => ({ stage: "assemble", passed: false, reason: error instanceof Error ? error.message : String(error) }) as const);
          let outcome = await runExecutor();
          if (!outcome.passed && /ReserveStale|6009|price_status/.test(outcome.reason)) {
            if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] executor: ${obligation.slice(0, 8)}… reserve stale (EMA window tail) — retrying in 15s`));
            await new Promise((resolve) => setTimeout(resolve, 15_000));
            outcome = await runExecutor();
          }
          if (!outcome.passed) {
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "skipped", obligation, stage: outcome.stage, reason: outcome.reason.slice(0, 200) });
            if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] executor ✗ ${obligation.slice(0, 8)}… ${outcome.stage}: ${outcome.reason.slice(0, 160)}`));
            // Only alert on late-stage failures (assemble/simulate) — plan-stage rejections
            // (not liquidatable, no flash debt) are normal market noise, not incidents.
            if (outcome.stage !== "plan") {
              executorStats.lastFailure = `${outcome.stage}: ${outcome.reason.slice(0, 160)}`;
              alerter.push(liquidationFailedAlert({ obligation: obligation.slice(0, 12), stage: outcome.stage, reason: outcome.reason.slice(0, 300) }));
            }
            // ── Smart retry policy ──
            // Cooldown-clear on healthy: the play was taken or repaid by someone else —
            // the position changed state, so the cooldown no longer protects anything.
            if (/ObligationHealthy|IllegalLiquidation|0x1780|0xbbf|not liquidatable/i.test(outcome.reason)) {
              executorRecentlyTried.delete(obligation);
              executorFailStreak.delete(obligation);
              return;
            }
            // No-route: Jupiter couldn't quote — back off 10 minutes, don't spam.
            if (/unquotable|No routes|unavailable/i.test(outcome.reason)) {
              executorNoRouteUntil.set(obligation, Date.now() + NO_ROUTE_COOLDOWN_MS);
              return;
            }
            // Structural failures: after a streak, blocklist so it never burns budget again.
            const streak = (executorFailStreak.get(obligation) ?? 0) + 1;
            executorFailStreak.set(obligation, streak);
            if (streak >= BLOCKLIST_AFTER) {
              executorBlocklist.add(obligation);
              logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "blocked", obligation, reason: `blocklisted after ${streak} structural failures` });
            }
            return;
          }
          const line = {
            obligation,
            repay: `${outcome.plan.repayUsd.toFixed(2)} ${outcome.plan.repayReserveSymbol}`,
            withdraw: outcome.plan.withdrawReserveSymbol,
            quoted: outcome.plan.quotedProfitUsd.toFixed(4),
            worst: outcome.plan.worstCaseProfitUsd.toFixed(4),
          };
          if (options.json) console.log(safeJsonStringify({ executable: { ...line, shadow: !options.broadcast } }));
          else console.log(color.bold(color.green(`⚡ EXECUTABLE ${obligation.slice(0, 8)}…`)) + `  repay ${line.repay} → ${line.withdraw}  quoted $${line.quoted} worst $${line.worst}  ${options.broadcast ? "FIRING" : "SHADOW"}`);
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
          if (!options.broadcast) {
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "skipped", obligation, reason: "shadow — executable play not broadcast", quotedProfitUsd: outcome.plan.quotedProfitUsd, worstCaseProfitUsd: outcome.plan.worstCaseProfitUsd });
            return;
          }
          const signature = await sendAndConfirm(options.rpc, rpcClient(options.rpc), outcome.transaction as Parameters<typeof sendAndConfirm>[2]).catch((error: unknown) => {
            const failReason = error instanceof Error ? error.message : "unknown";
            logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", obligation, reason: `broadcast failed: ${failReason.slice(0, 100)}`, lossUsdEstimate: 0.0011 });
            console.log(color.red(`✗ broadcast failed: ${failReason}`));
            executorStats.lastFailure = `broadcast: ${failReason.slice(0, 160)}`;
            alerter.push(liquidationFailedAlert({ obligation: obligation.slice(0, 12), stage: "broadcast", reason: failReason.slice(0, 300), gasBurnedUsd: 0.0011 }));
            return null;
          });
          if (!signature) return;
          executorStats.dueFired++;
          console.log(color.bold(color.green(`✅ FIRED ${obligation.slice(0, 8)}…`)) + `  ${color.white(`https://solscan.io/tx/${signature}`)}`);
          logLedgerEntry(executorAutoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", obligation, signature, quotedProfitUsd: outcome.plan.quotedProfitUsd, worstCaseProfitUsd: outcome.plan.worstCaseProfitUsd, lossUsdEstimate: 0.0011 });
          alerter.push(profitAlert({ signature, grossUsd: outcome.plan.quotedProfitUsd, feesUsd: 0, netUsd: outcome.plan.worstCaseProfitUsd }));
        } finally {
          executorBusy.delete(obligation);
        }
      })();
    };

    const emitTrackerEvents = (events: TrackerEvent[]) => {
      for (const event of events) {
        if (event.type === "spotted") {
          log?.({ type: "spotted", at: event.at, candidate: event.candidate });
          console.log(`${color.bold(color.red("⚡ DUE"))} ${printCandidateLine(event.candidate, "")}`);
          executeDue(event.candidate.obligation);
        } else if (event.type === "promoted") {
          log?.({ type: "promoted", at: event.at, candidate: event.candidate, fromHealth: event.fromHealth });
          console.log(`${color.bold(color.red("⚡ PROMOTED→DUE"))} ${printCandidateLine(event.candidate, color.yellow(`(was ${event.fromHealth.toFixed(4)})`))}`);
          executeDue(event.candidate.obligation);
        } else if (event.type === "watching") {
          // Near-miss entries below the watch band — no console chatter (the cycle
          // panel's NEAR MISS list + Telegram digest are the visibility for this tier).
          log?.({ type: "watching", at: event.at, candidate: event.candidate });
        } else if (event.type === "taken") {
          log?.({ type: "taken", at: event.at, obligation: event.obligation, firstSpottedAt: event.firstSpottedAt, satSeconds: event.satSeconds, wasDue: event.wasDue, ...(event.dueSince ? { dueSince: event.dueSince } : {}) });
          // Only surface LIQUIDATIONS: a tracked candidate that went DUE and was taken
          // by another liquidator. Healed/managed band exits stay in the JSONL only.
          if (event.wasDue) {
            executorStats.liquidatedByOthers++;
            const debt = `${(event.debtUsd ?? 0).toFixed(2)} ${event.debtSymbol ?? "?"}`;
            console.log(
              `${color.bold(color.red("⚡ LIQUIDATED"))} ${color.red(event.obligation)}` +
              color.dim(`  last health ${(event.lastHealth ?? 0).toFixed(4)}, debt ${debt}, DUE ${event.satSeconds}s — taken by another liquidator`),
            );
          }
        } else {
          log?.({ type: "healed", at: event.at, obligation: event.obligation, lastHealth: event.lastHealth });
        }
        const alert = trackerEventToAlert(event);
        if (alert) alerter.push(alert);
      }
    };

    let adaptiveBand = scanConfig.healthWatch;
    let surgeActive = false;

    const hotTick = async () => {
      if (!preloaded) return;
      const hotAddresses = tracker.hotObligations();
      if (!hotAddresses.length) return;
      const updates = await refreshTrackedObligations({
        rpc: rpcClient(options.rpc),
        preloaded,
        pubkeys: hotAddresses.map((value) => address(value)),
      });
      const events = tracker.applyHotUpdate(updates, new Date().toISOString());
      if (events.length) emitTrackerEvents(events);
    };

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
      if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] cycle #${cycle} scanning${surgeActive ? color.red(" [SURGE MODE]") : ""}...`));
      const result = await scanOnce({
        rpc: rpcClient(options.rpc),
        marketAddress: options.market,
        options: scanConfig,
        preloaded,
        effectiveHealthWatch: surgeActive ? adaptiveBand : undefined,
      });
      log?.({ type: "snapshot", at: result.scannedAt, result });
      // Feed the hot tracker: full scan acts as ground truth for tracked DUE positions
      const absorbEvents = tracker.absorb([...result.liquidatable, ...result.nearMiss], result.scannedAt);
      if (absorbEvents.length) emitTrackerEvents(absorbEvents);
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
        printScanPanel(cycle, result, scanConfig.nearMissHealth);
        printTrace(cycle, result);
      }
      return result;
    };
    if (!options.watch) {
      await runOnce(1);
      return;
    }
    console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] watching every ${intervalMs / 1000}s (hot ${hotIntervalMs / 1000}s, band ${hotBand}) — Ctrl+C to stop`));
    if (alerter.enabled) {
      alerter.push(startupAlert(Math.round(3_600_000 / intervalMs), hotIntervalMs / 1000));
      console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] telegram alerts enabled (chat ${process.env.TELEGRAM_CHAT_ID})`));
    }
    // Periodic Telegram heartbeat — the eval surface for "is the system alive and
    // what did it do" (mirrors the repo pattern's 60s STATS line, delivered to TG
    // hourly instead of spamming).
    if (options.watch && !options.json) {
      setInterval(() => {
        void (async () => {
          const wallet = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
          const walletSol = await rpcClient(options.rpc)
            .getBalance(wallet.address)
            .send()
            .then((r) => Number(r.value) / 1e9)
            .catch(() => 0);
          alerter.push(heartbeatAlert({
            uptimeMinutes: Math.round((Date.now() - executorStats.startedAt) / 60_000),
            cycles: executorStats.cycles,
            nearMissCount: tracker.size,
            dueAttempted: executorStats.dueAttempted,
            dueFired: executorStats.dueFired,
            liquidatedByOthers: executorStats.liquidatedByOthers,
            walletSol,
          }));
        })();
      }, 60 * 60_000).unref();
    }
    let cycle = 0;
    let fullScanPromise: Promise<void> | null = null;
    let nextFullScan = 0;
    let nextHotTick = 0;
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
  .command("liq-setup")
  .description("one-time: create our persistent ALT + pre-create hot ATAs so liquidation txs fit the 1232-byte packet")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--symbols <list>", "comma-separated reserve symbols to include (default: the common liquidation pairs)", "USDC,SOL,USDT,FDUSD,USDS,JitoSOL,JupSOL")
  .option("--all", "include every reserve in the market", false)
  .option("--reuse-alt <address>", "extend an existing ALT instead of creating a new one", "")
  .action(async (options: { rpc: string; market: string; symbols: string; all: boolean; reuseAlt: string }) => {
    const rpc = rpcClient(options.rpc);
    const market = await loadMarket(rpc, options.market);
    const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
    const wanted = options.all ? null : new Set(options.symbols.split(",").map((s) => s.trim().toUpperCase()));
    const reserves = market.getReserves().filter((reserve: KaminoReserve) => !wanted || wanted.has(reserve.getTokenSymbol().toUpperCase()));
    console.log(`reserves in scope (${reserves.length}): ${reserves.map((r: KaminoReserve) => r.getTokenSymbol()).join(", ")}`);

    const reuseAlt = options.reuseAlt ? address(options.reuseAlt) : undefined;
    const existingKeys = reuseAlt ? await getAccountsInLut(rpc, reuseAlt) : undefined;
    const { transactions, lookupTable, keyCount } = await buildLiquidationSetup({
      rpc,
      market,
      reserves,
      signer,
      ...(reuseAlt ? { existingLookupTable: reuseAlt } : {}),
      ...(existingKeys?.length ? { existingKeys: existingKeys.map((k: string) => address(k)) } : {}),
    });
    console.log(`ALT ${lookupTable} will hold ${keyCount} keys${existingKeys?.length ? ` (${existingKeys.length} already present)` : ""} across ${transactions.length} transactions…`);
    for (const [index, instructions] of transactions.entries()) {
      if (!instructions.length) continue;
      const setupTx = await createSignedTransactionWithAlt(rpc, options.rpc, signer, instructions, []);
      try {
        const signature = await sendAndConfirm(options.rpc, rpc, setupTx);
        console.log(color.green(`  ✅ setup tx ${index + 1}/${transactions.length} ${signature}`));
      } catch (error) {
        console.log(color.red(`  ✗ setup tx ${index + 1}/${transactions.length} failed: ${safeJsonStringify(error instanceof Error ? error.message : error).slice(0, 400)}`));
        throw error;
      }
    }
    console.log(color.green(`✅ SETUP COMPLETE`));
    saveAltState({ lookupTable: lookupTable.toString(), createdAt: new Date().toISOString(), authority: signer.address.toString(), keyCount });
    console.log(color.bold(color.green(`✔ ALT saved to ${ALT_STATE_PATH} — future liquidation txs now compress via it`)));
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
  .action(async (obligation: string, options: {
    rpc: string;
    market: string;
    slippageBps: string;
    minProfit: string;
    bypassHealth: boolean;
    yes: boolean;
  }) => {
    const rpc = rpcClient(options.rpc);
    const market = await loadMarket(rpc, options.market);
    const altState = loadAltState();
    const outcome = await executeLiquidationOnce({
      rpc,
      rpcUrl: options.rpc,
      market,
      obligationAddress: address(obligation),
      slippageBps: Number(options.slippageBps),
      minProfitUsd: Number(options.minProfit),
      ...(options.bypassHealth ? { bypassHealth: true } : {}),
      ...(altState ? { lookupTableAddresses: [address(altState.lookupTable)] } : {}),
    }).catch((error: unknown) => ({ stage: "assemble", passed: false, reason: error instanceof Error ? error.message : String(error) }) as const);

    if (!outcome.passed) {
      console.log(color.yellow(`${outcome.stage}: ${outcome.reason}`));
      if (outcome.stage === "simulate") (outcome as { logs?: string[] }).logs?.forEach((line) => console.log(color.dim(line)));
      process.exitCode = 1;
      return;
    }
    console.log(color.bold(color.green("✔ SIMULATION PASSED")));
    console.log(safeJsonStringify(outcome.plan));
    if (!options.yes) {
      console.log(color.dim("shadow — pass --yes to broadcast"));
      return;
    }
    const signature = await sendAndConfirm(options.rpc, rpc, outcome.transaction as Parameters<typeof sendAndConfirm>[2]);
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

program
  .command("arb-scan")
  .description("scan Jupiter quotes for round-trip arbitrage spreads (read-only, no transactions)")
  .option("--size <usd>", "trade size per leg in USD", "100")
  .option("--min-spread <bps>", "minimum round-trip spread in bps to report", "5")
  .option("--slippage <bps>", "slippage buffer requested on quotes", "50")
  .option("--max-impact <pct>", "skip pairs whose price impact exceeds this percent", "1")
  .option("--bases <symbols>", "comma-separated base symbols for round trips", "USDC")
  .option("--intermediates <symbols>", "comma-separated intermediate symbols", "WSOL,JitoSOL,JupSOL,USDT,USDS,FDUSD,USDG,PYUSD")
  .option("--watch", "keep scanning in a loop", false)
  .option("--interval <seconds>", "seconds between scan passes when --watch is set", "30")
  .option("--log <path>", "append opportunities as JSON lines to this file")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    size: string;
    minSpread: string;
    slippage: string;
    maxImpact: string;
    bases: string;
    intermediates: string;
    watch: boolean;
    interval: string;
    log?: string;
    json: boolean;
  }) => {
    const knownMints = new Set(Object.keys(MINTS) as MintSymbol[]);
    const parseSymbols = (value: string): MintSymbol[] => {
      const symbols = value.split(",").map((item) => item.trim()).filter(Boolean);
      const unknown = symbols.filter((symbol) => !knownMints.has(symbol as MintSymbol));
      if (unknown.length) throw new Error(`Unknown mint symbol(s): ${unknown.join(", ")}. Valid: ${[...knownMints].join(",")}`);
      return symbols as MintSymbol[];
    };
    const arbOptions: ArbScanOptions = {
      ...DEFAULT_ARB_SCAN_OPTIONS,
      sizeUsd: Number(options.size),
      minSpreadBps: Number(options.minSpread),
      slippageBps: Number(options.slippage),
      maxPriceImpactPct: Number(options.maxImpact),
      bases: parseSymbols(options.bases),
      intermediates: parseSymbols(options.intermediates),
    };
    if (!Number.isFinite(arbOptions.sizeUsd) || arbOptions.sizeUsd <= 0) throw new Error("--size must be a positive number");
    if (!Number.isFinite(arbOptions.minSpreadBps) || arbOptions.minSpreadBps < 0) throw new Error("--min-spread must be non-negative");
    if (!arbOptions.bases.length || !arbOptions.intermediates.length) throw new Error("provide at least one base and one intermediate");

    const intervalMs = Math.max(5, Number(options.interval)) * 1000;
    const log = options.log ? (line: unknown) => appendFileSync(options.log!, `${safeJsonStringify(line)}\n`) : undefined;

    const runPass = async (pass: number) => {
      if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] arb pass #${pass} scanning ${arbOptions.bases.length * arbOptions.intermediates.length} pairs...`));
      const outcome = await scanArbPass(arbOptions, {
        onEvent: (event) => {
          if (event.type === "opportunity") log?.(event.result);
        },
      });
      if (options.json) {
        console.log(safeJsonStringify(outcome));
      } else {
        console.log(color.bold(color.cyan(`ARB SCAN`)) + color.dim(`  ${localTimestamp(outcome.at)}  pairs=${outcome.pairsScanned}  opportunities=${outcome.opportunities.length}  (size $${arbOptions.sizeUsd}, floor ${arbOptions.minSpreadBps}bps)`));
        if (outcome.opportunities.length === 0) {
          console.log(color.dim("OPPS=0"));
        } else {
          outcome.opportunities.forEach((result, index) => {
            console.log(
              [
                color.yellow(`[${index + 1}]`),
                `ROUTE=${color.white(`${result.base}→${result.intermediate}→${result.base}`)}`,
                `SPREAD=${color.green(`${result.spreadBps.toFixed(1)}bps`)}`,
                `PROFIT=${color.green(`$${result.profitUsdApprox.toFixed(4)}`)}`,
                color.dim(`IMPACT=${result.priceImpactMaxPct.toFixed(3)}%`),
                color.dim(`VIA=${result.routeLabels.slice(0, 4).join(",")}`),
              ].join("  "),
            );
          });
        }
      }
      return outcome;
    };

    if (!options.watch) {
      await runPass(1);
      return;
    }
    let pass = 0;
    while (true) {
      pass += 1;
      try {
        await runPass(pass);
      } catch (error) {
        printError(error);
      }
      await sleep(intervalMs);
    }
  });

  program
  .command("treasure-scan")
  .description("watch for newly created pools and flag live cross-venue price mismatches (read-only)")
  .option("--min-vault <usd>", "minimum USD value in the pool's SOL vault to count as real liquidity", "1000")
  .option("--min-ratio <ratio>", "pool-vs-reference price ratio to report (1.05 = 5%)", "1.05")
  .option("--allow-unsafe-mints", "report pools even when mint/freeze authorities are still set", false)
  .option("--skip-depth-gate", "report discounted pools without verifying the reference market can absorb a probe sell", false)
  .option("--depth-probe <usd>", "probe sell size used to verify reference-market depth", "100")
  .option("--watch", "keep scanning in a loop", false)
  .option("--interval <seconds>", "seconds between feed diffs when --watch is set", "45")
  .option("--log <path>", "append events as JSON lines to this file")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    minVault: string;
    minRatio: string;
    allowUnsafeMints: boolean;
    skipDepthGate: boolean;
    depthProbe: string;
    watch: boolean;
    interval: string;
    log?: string;
    json: boolean;
  }) => {
    const rpcUrl = configuredValue(process.env.SOLANA_RPC_URL) ?? DEFAULT_RPC;
    const treasureOptions: TreasureScanOptions = {
      ...DEFAULT_TREASURE_OPTIONS,
      minVaultUsd: Number(options.minVault),
      minPriceRatio: Number(options.minRatio),
      requireSafeMint: !options.allowUnsafeMints,
      requireReferenceDepth: !options.skipDepthGate,
      depthProbeUsd: Number(options.depthProbe),
    };
    if (!Number.isFinite(treasureOptions.minVaultUsd) || treasureOptions.minVaultUsd < 0) throw new Error("--min-vault must be non-negative");
    if (!Number.isFinite(treasureOptions.minPriceRatio) || treasureOptions.minPriceRatio <= 1) throw new Error("--min-ratio must be > 1");

    const intervalMs = Math.max(15, Number(options.interval)) * 1000;
    const logPath = options.log;
    const log = logPath ? (line: unknown) => appendFileSync(logPath, `${safeJsonStringify(line)}\n`) : undefined;

    const rpc = createRpcClient(rpcUrl);
    const feed = new PoolFeed(rpc);
    const telegramConfig = telegramConfigFromEnv(process.env);
    const alerter = telegramConfig ? new TelegramAlerter(telegramConfig) : null;
    if (alerter) {
      console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] telegram alerts enabled (chat ${process.env.TELEGRAM_CHAT_ID})`));
      alerter.push({
        kind: "startup",
        title: "🟢 Treasure Watcher Started",
        lines: [`Feed diff: every ${intervalMs / 1000}s`, `Venues: pumpswap, meteora-damm-v2, meteora-damm, raydium-clmm, orca-whirlpool`, "Read-only — no transactions will be sent"],
      });
    }

    const runPass = async (pass: number) => {
      if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] treasure pass #${pass} diffing venues...`));
      const outcome = await scanTreasurePass(feed, rpc, treasureOptions, {
        onEvent: (event) => {
          if (event.type === "opportunity") {
            log?.(event.opportunity);
            alerter?.push(treasureAlert(event.opportunity));
          }
        },
      });
      if (options.json) {
        console.log(safeJsonStringify(outcome));
      } else {
        console.log(
          color.bold(color.cyan("TREASURE SCAN")) +
            color.dim(`  ${localTimestamp(outcome.at)}  pools=${outcome.poolsSeen} real=${outcome.poolsReal} opps=${outcome.opportunities.length} errors=${outcome.errors}`),
        );
        outcome.opportunities.forEach((opportunity, index) => {
          console.log(
            [
              color.yellow(`[${index + 1}]`),
              `VENUE=${color.white(opportunity.venue)}`,
              `POOL=${color.white(opportunity.poolAddress.slice(0, 12) + "…")}`,
              `DISCOUNT=${color.green(`${((1 - opportunity.ratio) * 100).toFixed(1)}%`)}`,
              `PRICE=${color.white(formatSolPrice(opportunity.poolPriceInSol))}`,
              opportunity.referencePriceInSol ? `REF=${color.white(formatSolPrice(opportunity.referencePriceInSol))}` : color.red("REF=none (unlisted!)"),
              color.dim(`LIQ=${formatCompact(opportunity.vaultBaseUi)} base + ${opportunity.vaultSolUi.toFixed(2)} SOL`),
            ].join("  "),
          );
        });
      }
      return outcome;
    };

    if (!options.watch) {
      // A single pass only primes the baseline; instruct the caller.
      await runPass(1);
      if (!options.json) {
        console.log(color.dim("Note: single pass primes the baseline. Run with --watch to detect new pools."));
      }
      return;
    }
    let pass = 0;
    while (true) {
      pass += 1;
      try {
        await runPass(pass);
      } catch (error) {
        printError(error);
      }
      await sleep(intervalMs);
    }
  });

  program
  .command("lst-scan")
  .description("measure LST market rates vs deepest-pool reference (depeg watch, read-only)")
  .option("--probe <usd>", "executable probe size per LST in USD", "1000")
  .option("--min-spread <bps>", "minimum spread in bps to report", "20")
  .option("--symbols <list>", "comma-separated LST symbols to scan (default: registry)")
  .option("--watch", "keep scanning in a loop", false)
  .option("--interval <seconds>", "seconds between passes when --watch is set", "120")
  .option("--log <path>", "append spreads as JSON lines to this file")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    probe: string;
    minSpread: string;
    symbols?: string;
    watch: boolean;
    interval: string;
    log?: string;
    json: boolean;
  }) => {
    const rpcUrl = configuredValue(process.env.SOLANA_RPC_URL) ?? DEFAULT_RPC;
    const wanted = options.symbols ? options.symbols.split(",").map((s) => s.trim().toUpperCase()) : null;
    const lsts = wanted ? LST_REGISTRY.filter((lst) => wanted.includes(lst.symbol.toUpperCase())) : LST_REGISTRY;
    if (!lsts.length) throw new Error(`Unknown LST symbol(s): ${options.symbols}. Valid: ${LST_REGISTRY.map((l) => l.symbol).join(",")}`);
    const lstOptions = { ...DEFAULT_LST_OPTIONS, probeUsd: Number(options.probe), minSpreadBps: Number(options.minSpread), lsts };
    if (!Number.isFinite(lstOptions.probeUsd) || lstOptions.probeUsd <= 0) throw new Error("--probe must be positive");
    if (!Number.isFinite(lstOptions.minSpreadBps) || lstOptions.minSpreadBps < 0) throw new Error("--min-spread must be non-negative");

    const intervalMs = Math.max(15, Number(options.interval)) * 1000;
    const logPath = options.log;
    const log = logPath ? (line: unknown) => appendFileSync(logPath, `${safeJsonStringify(line)}\n`) : undefined;
    const rpc = createRpcClient(rpcUrl);
    const telegramConfig = telegramConfigFromEnv(process.env);
    const alerter = telegramConfig ? new TelegramAlerter(telegramConfig) : null;

    const runPass = async (pass: number) => {
      if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] lst pass #${pass} probing ${lsts.length} LSTs...`));
      const outcome = await scanLstPass(rpc, lstOptions, {
        onEvent: (event) => {
          if (event.type === "spread") {
            log?.(event.result);
            alerter?.push(lstAlert(event.result));
          }
        },
      });
      if (options.json) {
        console.log(safeJsonStringify(outcome));
      } else {
        console.log(
          color.bold(color.magenta("LST SCAN")) +
            color.dim(`  ${localTimestamp(outcome.at)}  lsts=${outcome.lstsChecked} spreads=${outcome.spreads.length} errors=${outcome.errors}`),
        );
        outcome.spreads.forEach((result, index) => {
          console.log(
            [
              color.yellow(`[${index + 1}]`),
              `LST=${color.white(result.symbol)}`,
              `${result.direction === "discount" ? color.green("DISCOUNT") : color.red("PREMIUM")}`,
              `SPREAD=${color.white(`${result.spreadBps}bps`)}`,
              `PROBE=$${result.probeUsd}→$${result.receivedUsd.toFixed(0)}`,
              color.dim(`REF=${result.referenceLabel}`),
            ].join("  "),
          );
        });
      }
      return outcome;
    };

    if (!options.watch) {
      await runPass(1);
      return;
    }
    if (alerter) {
      alerter.push({
        kind: "startup",
        title: "🟢 LST Depeg Watcher Started",
        lines: [`Scan: every ${intervalMs / 1000}s`, `LSTs: ${lsts.map((l) => l.symbol).join(",")}`, "Read-only — no transactions will be sent"],
      });
    }
    let pass = 0;
    while (true) {
      pass += 1;
      try {
        await runPass(pass);
      } catch (error) {
        printError(error);
      }
      await sleep(intervalMs);
    }
  });

  program
  .command("lst-execute")
  .description("prove an LST depeg play atomically: Kamino flashBorrow → 2 Jupiter legs → repay; SIMULATED, never broadcast without --yes")
  .option("--symbol <lst>", "LST symbol from the registry (JitoSOL, JupSOL, ...)")
  .option("--size <usd>", "borrow size in USD at the oracle rate", "500")
  .option("--slippage <bps>", "per-leg slippage tolerance", "50")
  .option("--min-profit <usd>", "minimum simulated profit to allow broadcasting", "0.25")
  .option("--dry-run", "stop after printing the plan (no signing)", false)
  .option("--yes", "broadcast after a profitable simulation (without it: simulate-only)", false)
  .option("--rpc <url>", "Solana RPC", configuredValue(process.env.SOLANA_RPC_URL) ?? DEFAULT_RPC)
  .option("--market <address>", "Kamino market", configuredValue(process.env.KAMINO_MARKET) ?? MAIN_MARKET)
  .option("--keypair <path>", "fallback Solana keypair JSON", configuredValue(process.env.KEYPAIR_PATH))
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    symbol: string;
    size: string;
    slippage: string;
    minProfit: string;
    dryRun: boolean;
    yes: boolean;
    rpc: string;
    market: string;
    keypair?: string;
    json: boolean;
  }) => {
    const lst = LST_REGISTRY.find((entry) => entry.symbol.toUpperCase() === options.symbol.trim().toUpperCase());
    if (!lst) throw new Error(`Unknown LST ${options.symbol}. Valid: ${LST_REGISTRY.map((entry) => entry.symbol).join(", ")}`);
    const sizeUsd = Number(options.size);
    const slippageBps = Number(options.slippage);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new Error("--size must be positive");
    if (!Number.isFinite(slippageBps) || slippageBps < 0) throw new Error("--slippage must be non-negative");

    const rpc = rpcClient(options.rpc);
    if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] loading Kamino market + oracle rates...`));
    const market = await loadMarket(rpc, options.market);
    const reference = kaminoLstReference(market as never);
    const ref = reference?.(lst.symbol) ?? null;
    if (!ref?.solPerLst) throw new Error(`${lst.symbol} has no valid Kamino oracle rate (is it a Main-market reserve?)`);

    const solPriceUsd = await fetchSolPriceUsdc().catch(() => 0);
    if (solPriceUsd <= 0) throw new Error("could not derive SOL price for sizing");

    if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] planning 2-leg atomic swap (oracle ${ref.solPerLst.toFixed(6)} SOL/${lst.symbol})...`));
    const result = await planLstArb(lst, ref.solPerLst, solPriceUsd, { sizeUsd, solPriceUsd, slippageBps, onlyDirectRoutes: true });
    if (!result.ok) throw new Error(`plan failed: ${result.reason}`);
    const { plan, profitUsd, worstCaseProfitUsd } = result;

    const planLine = {
      symbol: lst.symbol,
      borrow: `${plan.amountBaseUnits.toString()} base units`,
      oracleSolPerLst: ref.solPerLst,
      marketSolPerLst: plan.marketSolPerLst,
      spreadBps: plan.spreadBps,
      profitUsd: profitUsd.toFixed(4),
      worstCaseProfitUsd: worstCaseProfitUsd.toFixed(4),
      routes: plan.routeLabels,
    };
    if (options.json) console.log(safeJsonStringify({ plan: planLine }));
    else {
      console.log(color.bold(color.magenta("LST DEPEG PLAN")) + color.dim(`  ${localTimestamp(plan.at)}`));
      console.log(`  BORROW      = ${color.white(planLine.borrow)} (${lst.symbol}, Kamino 0% fee reserve)`);
      console.log(`  ORACLE REF  = ${planLine.oracleSolPerLst} SOL per ${lst.symbol}`);
      console.log(`  MARKET      = ${planLine.marketSolPerLst.toFixed(6)} SOL per ${lst.symbol}`);
      console.log(`  QUOTED P&L  = ${profitUsd >= 0 ? color.green(`$${profitUsd.toFixed(4)}`) : color.red(`$${profitUsd.toFixed(4)}`)} (worst-case $${worstCaseProfitUsd.toFixed(4)})`);
      console.log(`  ROUTES      = ${planLine.routes.join(" + ")}`);
    }

    if (options.dryRun) {
      if (!options.json) console.log(color.dim("dry-run: stopping before signing"));
      return;
    }

    // Assemble strategy instructions from the two Jupiter legs.
    const walletSigner = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: options.keypair });
    const reserve = selectReserve(market, { asset: lst.symbol });
    const leg1 = await fetchSwapInstructions(plan.legOutQuote, walletSigner.address.toString());
    const leg2 = await fetchSwapInstructions(plan.legBackQuote, walletSigner.address.toString());
    if (!leg1 || !leg2) throw new Error("could not assemble swap instructions from Jupiter");
    const reserveMint = reserve.getLiquidityMint().toString();
    const ataProgram = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";
    const isNewAtaFor = (instruction: { programId: string; accounts: Array<{ pubkey: string }> }, mint: string): boolean => {
      if (instruction.programId !== ataProgram) return false;
      // ATokenGPv2 create-idempotent accounts: payer, ata, owner, mint, system… (mint at index 3)
      return instruction.accounts[3]?.pubkey === mint;
    };
    const filteredLeg1 = leg1.swapInstructions.filter((instruction) => {
      // the sandwich already creates the reserve-mint ATA; drop Jupiter's duplicate for it.
      if (isNewAtaFor(instruction, reserveMint)) return false;
      return true;
    });
    const filteredLeg2 = leg2.swapInstructions.filter((instruction) => {
      if (isNewAtaFor(instruction, reserveMint)) return false;
      return true;
    });
    // The two legs may both request identical setup instructions (e.g. idempotent
    // destination-ATA creation for WSOL) — the runtime rejects duplicates, so merge
    // with a fingerprint dedupe.
    const fingerprint = (instruction: { programId: string; data: string; accounts: Array<{ pubkey: string; isWritable: boolean }> }): string =>
      `${instruction.programId}|${instruction.data}|${instruction.accounts.map((a) => `${a.pubkey}:${a.isWritable}`).join(",")}`;
    const merged: typeof leg1.swapInstructions = [];
    for (const instruction of [...filteredLeg1, ...filteredLeg2]) {
      const id = fingerprint(instruction);
      if (merged.some((existing) => fingerprint(existing) === id)) continue;
      merged.push(instruction);
    }
    const budgetMerged: typeof leg1.computeBudgetInstructions = [];
    for (const instruction of [...leg1.computeBudgetInstructions, ...leg2.computeBudgetInstructions]) {
      // Keep only the LAST compute-budget settings (highest limits win).
      const existingIndex = budgetMerged.findIndex((existing) => existing.programId === instruction.programId && existing.data.slice(0, 8) === instruction.data.slice(0, 8));
      if (existingIndex >= 0) budgetMerged.splice(existingIndex, 1);
      budgetMerged.push(instruction);
    }
    const strategy = externalInstructionsToStrategy(merged, budgetMerged, walletSigner);

    // Build the Kamino flash-loan sandwich around the strategy.
    const tokenAccountAddress = address(await deriveAssociatedTokenAccount({
      mint: reserve.getLiquidityMint(),
      owner: walletSigner.address,
      tokenProgram: reserve.getLiquidityTokenProgram(),
    }));
    const existingTokenAccount = await fetchTokenAccount(rpc, tokenAccountAddress);
    const tokenAccount = existingTokenAccount ?? {
      address: tokenAccountAddress,
      mint: reserve.getLiquidityMint(),
      owner: walletSigner.address,
      amount: 0n,
      decimals: reserve.getMintDecimals(),
    };
    const setupInstructions = existingTokenAccount ? [] : [await createAtaInstruction({
      payer: walletSigner,
      mint: tokenAccount.mint,
      owner: tokenAccount.owner,
      tokenProgram: reserve.getLiquidityTokenProgram(),
      ata: tokenAccount.address,
    })];
    const build = await buildFlashLoan({
      market,
      reserve,
      signer: walletSigner,
      tokenAccount,
      amountBaseUnits: plan.amountBaseUnits,
      strategy,
      setupInstructions,
    });

    const transaction = await createSignedTransactionWithAlt(
      rpc,
      options.rpc,
      walletSigner,
      build.instructions,
      [...new Set([...leg1.addressLookupTableAddresses, ...leg2.addressLookupTableAddresses])].map((a) => address(a)),
    );
    const simulation = await simulate(rpc, transaction);
    const simErr = simulation.value?.err;
    if (simErr) {
      // Surface which referenced account is missing: check existence for all
      // addresses named by the instructions (post-ALT-compression metas included).
      const addressesToCheck = [...new Set(
        build.instructions.flatMap((instruction) =>
          (instruction.accounts ?? []).map((account) => String((account as unknown as { address: { toString(): string } }).address)),
        ),
      )];
      const missing: string[] = [];
      for (let i = 0; i < addressesToCheck.length; i += 100) {
        const res = await fetch(options.rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addressesToCheck.slice(i, i + 100), { encoding: "base64" }] }),
        })
          .then((r) => r.json() as Promise<{ result?: { value?: Array<unknown | null> } }>)
          .catch(() => null);
        res?.result?.value?.forEach((account, index) => {
          if (account === null) missing.push(addressesToCheck[i + index] ?? "?");
        });
      }
      const logs = simulation.value?.logs ?? [];
      throw new Error(`simulation failed: ${safeJsonStringify(simErr)}\nmissing accounts: ${missing.join(", ") || "none detected"}\n${logs.slice(-10).join("\n")}`);
    }
    const logs = simulation.value?.logs ?? [];
    let returnedUnits: bigint | null = null;
    let consumedUnits = 0n;
    for (const log of logs) {
      if (log.startsWith("Program log: Custom program error:")) {
        throw new Error(`simulation failed: ${log}`);
      }
      const match = log.match(/consumed (\d+) of \d+ compute units/);
      if (match) consumedUnits = BigInt(match[1] ?? 0);
      const returned = log.match(/Program return: (\d+) (\d+)/);
      if (returned) returnedUnits = BigInt(returned[2] ?? 0);
    }
    // Worst-case enforceable profit in USD at the min-out floors:
    const worstNetUsd = worstCaseProfitUsd;
    const outcome = {
      simulation: "ok",
      computeUnitsConsumed: consumedUnits.toString(),
      instructions: build.instructions.length,
      borrowInstructionIndex: build.borrowInstructionIndex,
      quotedProfitUsd: profitUsd.toFixed(4),
      worstCaseProfitUsd: worstNetUsd.toFixed(4),
      executable: worstNetUsd >= Number(options.minProfit),
    };
    if (options.json) console.log(safeJsonStringify(outcome));
    else {
      console.log(color.bold(color.green("SIMULATION OK")) + color.dim(`  CU=${consumedUnits}  ix=${build.instructions.length}`));
      console.log(`  QUOTED P&L  = $${profitUsd.toFixed(4)} | WORST-CASE = $${worstNetUsd.toFixed(4)}`);
      console.log(`  EXECUTABLE  = ${outcome.executable ? color.green("YES (>= min-profit)") : color.yellow("NO (below min-profit)")}`);
    }
    if (!options.yes) {
      if (!options.json) console.log(color.dim("simulate-only: add --yes to broadcast when executable"));
      return;
    }
    if (!outcome.executable) throw new Error(`worst-case profit $${worstNetUsd.toFixed(4)} is below --min-profit $${options.minProfit}; refusing to broadcast`);
    throw new Error("broadcast path reached — wire sendAndConfirm(rpc, transaction) when you are ready to go live (deliberately guarded)");
  });

  program
  .command("lst-autofire")
  .description("auto-fire LST depeg plays: poll → plan → simulate → guards → broadcast (atomic, budget-capped)")
  .option("--symbols <list>", "comma-separated LST symbols to watch (default: JitoSOL,JupSOL)")
  .option("--size <usd>", "borrow size per attempt in USD", "500")
  .option("--slippage <bps>", "per-leg slippage tolerance", "50")
  .option("--min-profit <usd>", "minimum WORST-CASE profit to fire", "0.5")
  .option("--interval <seconds>", "seconds between polls when idle", "60")
  .option("--cooldown <seconds>", "re-arm delay after a fired tx", "300")
  .option("--max-attempts <n>", "max broadcast attempts per rolling day", "8")
  .option("--max-loss <usd>", "max estimated fee burn per rolling day", "1")
  .option("--ledger <path>", "JSONL ledger path", "data/autofire_ledger.jsonl")
  .option("--stop-file <path>", "kill-switch file path", "data/autofire.stop")
  .option("--no-broadcast", "run the full loop but never broadcast (shadow mode)", false)
  .option("--rpc <url>", "Solana RPC", configuredValue(process.env.SOLANA_RPC_URL) ?? DEFAULT_RPC)
  .option("--market <address>", "Kamino market", configuredValue(process.env.KAMINO_MARKET) ?? MAIN_MARKET)
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    symbols?: string;
    size: string;
    slippage: string;
    minProfit: string;
    interval: string;
    cooldown: string;
    maxAttempts: string;
    maxLoss: string;
    ledger: string;
    stopFile: string;
    broadcast: boolean;
    rpc: string;
    market: string;
    json: boolean;
  }) => {
    const wanted = (options.symbols ?? "JitoSOL,JupSOL").split(",").map((s) => s.trim().toUpperCase());
    const lsts = LST_REGISTRY.filter((entry) => wanted.includes(entry.symbol.toUpperCase()));
    if (!lsts.length) throw new Error(`No valid LSTs in --symbols. Valid: ${LST_REGISTRY.map((l) => l.symbol).join(", ")}`);
    const rpc = rpcClient(options.rpc);
    // NOTE: no initial market load here — the loop refreshes it per pass (the
    // oracle rate must never go stale; see marketLoadedAt handling below).
    const telegramConfig = telegramConfigFromEnv(process.env);
    const alerter = telegramConfig ? new TelegramAlerter(telegramConfig) : null;

    const autoOptions: AutofireOptions = {
      lsts,
      sizeUsd: Number(options.size),
      slippageBps: Number(options.slippage),
      minProfitUsd: Number(options.minProfit),
      intervalSec: Math.max(15, Number(options.interval)),
      cooldownSec: Math.max(0, Number(options.cooldown)),
      maxAttemptsPerDay: Math.max(1, Number(options.maxAttempts)),
      maxLossPerDayUsd: Number(options.maxLoss),
      ledgerPath: options.ledger,
      stopFilePath: options.stopFile,
    };

    const banner = [
      color.bold(color.red("LST AUTO-FIRE")) + color.dim(`  ${localTimestamp(new Date().toISOString())}`),
      `  LSTS        = ${lsts.map((l) => l.symbol).join(", ")}`,
      `  SIZE        = $${autoOptions.sizeUsd} | SLIPPAGE = ${autoOptions.slippageBps}bps | MIN-PROFIT(worst) = $${autoOptions.minProfitUsd}`,
      `  BROADCAST   = ${options.broadcast ? color.red("ARMED") : color.yellow("SHADOW (no broadcast)")}`,
      `  CAPS        = ${autoOptions.maxAttemptsPerDay} attempts/day, $${autoOptions.maxLossPerDayUsd} loss/day, ${autoOptions.cooldownSec}s cooldown`,
      `  KILL-SWITCH = touch ${autoOptions.stopFilePath} to stop`,
    ];
    if (!options.json) banner.forEach((line) => console.log(line));
    alerter?.push({
      kind: "startup",
      title: "🔴 LST AUTO-FIRE ARMED",
      lines: [
        `LSTs: ${lsts.map((l) => l.symbol).join(", ")}`,
        `Size $${autoOptions.sizeUsd} | min worst-case profit $${autoOptions.minProfitUsd}`,
        `Broadcast: ${options.broadcast ? "ARMED" : "SHADOW"}`,
        `Caps: ${autoOptions.maxAttemptsPerDay}/day, $${autoOptions.maxLossPerDayUsd} loss/day`,
        `Kill switch: touch ${autoOptions.stopFilePath}`,
      ],
    });

    let pass = 0;
    let market: Awaited<ReturnType<typeof loadMarket>> | null = null;
    let marketLoadedAt = 0;
    while (true) {
      pass += 1;
      const now = Date.now();
      try {
        // Fresh market per pass: the oracle rate is the depeg reference — a
        // stale one turns every comparison into a false signal.
        if (!market || now - marketLoadedAt > 60_000) {
          market = await loadMarket(rpc, options.market);
          marketLoadedAt = Date.now();
        }
        const activeMarket = market;
        const guards = evaluateFireGuards(autoOptions, loadLedger(autoOptions.ledgerPath), now, existsSync(autoOptions.stopFilePath));
        if (!guards.allowed) {
          if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] pass #${pass} ${guards.reason}`));
          logLedgerEntry(autoOptions.ledgerPath, { at: new Date().toISOString(), type: "blocked", reason: guards.reason ?? "blocked" });
          await sleep(autoOptions.intervalSec * 1000);
          continue;
        }

        // Heartbeat: prove liveness + surface the current oracle-vs-market
        // spread every 5 passes (5 min) — a quiet loop otherwise writes nothing.
        if (!options.json && pass % 5 === 0) {
          const rates = lsts.map((lst) => {
            const ref = kaminoLstReference(activeMarket as never)?.(lst.symbol) ?? null;
            return ref?.solPerLst ? `${lst.symbol} ${ref.solPerLst.toFixed(6)}` : `${lst.symbol} n/a`;
          });
          console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] heartbeat #${pass}: ${rates.join(" · ")} (no tradable spread, watching)`));
        }

        for (const lst of lsts) {
          const outcome = await executeLstArbOnce({
            rpc,
            rpcUrl: options.rpc,
            market: activeMarket,
            lst,
            sizeUsd: autoOptions.sizeUsd,
            slippageBps: autoOptions.slippageBps,
            minProfitUsd: autoOptions.minProfitUsd,
          }).catch((error: unknown) => ({ stage: "assemble", passed: false, reason: error instanceof Error ? error.message : String(error) }) as const);

          if (!outcome.passed) {
            if (outcome.stage === "plan" && /spread too thin|no valid Kamino oracle/i.test(outcome.reason ?? "")) {
              // quiet: normal efficient-market reading, no ledger spam
              continue;
            }
            logLedgerEntry(autoOptions.ledgerPath, {
              at: new Date().toISOString(),
              type: "skipped",
              symbol: lst.symbol,
              stage: outcome.stage,
              reason: outcome.reason,
            });
            if (!options.json) console.log(color.yellow(`[${localTimestamp(new Date().toISOString())}] ${lst.symbol} ${outcome.stage}: ${outcome.reason}`));
            continue;
          }

          // Simulation-proven executable play — fire or shadow-report it.
          const fireLine = {
            symbol: lst.symbol,
            quotedProfitUsd: outcome.quotedProfitUsd.toFixed(4),
            worstCaseProfitUsd: outcome.worstCaseProfitUsd.toFixed(4),
            computeUnits: outcome.computeUnitsConsumed.toString(),
            shadow: !options.broadcast,
          };
          if (options.json) console.log(safeJsonStringify({ fired: fireLine }));
          else {
            console.log(color.bold(color.green(`⚡ EXECUTABLE ${lst.symbol}`)) + color.dim(`  quoted $${fireLine.quotedProfitUsd} worst $${fireLine.worstCaseProfitUsd} CU=${fireLine.computeUnits}`));
          }
          alerter?.push({
            kind: "execution",
            title: `⚡ LST DEPEG SIGNAL: ${lst.symbol}`,
            lines: [
              `Quoted P&L: $${fireLine.quotedProfitUsd}`,
              `Worst-case P&L: $${fireLine.worstCaseProfitUsd}`,
              `Simulation: PASSED (repay covered at min-out floors)`,
              `Mode: ${options.broadcast ? "FIRING" : "SHADOW"}`,
            ],
          });

          if (!options.broadcast) {
            logLedgerEntry(autoOptions.ledgerPath, { at: new Date().toISOString(), type: "skipped", symbol: lst.symbol, reason: "shadow mode — executable play not broadcast", quotedProfitUsd: outcome.quotedProfitUsd, worstCaseProfitUsd: outcome.worstCaseProfitUsd });
            continue;
          }

          // Broadcast (guarded path — the only one in the repo).
          const feeEstimateUsd = 0.0011; // 5000 lamports base + ~500k CU priority, priced conservatively
          const signature = await sendAndConfirm(options.rpc, rpc, outcome.transaction as Parameters<typeof sendAndConfirm>[2]).catch(async (error: unknown) => {
            // Broadcast failed: log the burn (the tx fee may still have been charged).
            logLedgerEntry(autoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", symbol: lst.symbol, reason: `broadcast failed: ${error instanceof Error ? error.message.slice(0, 100) : "unknown"}`, lossUsdEstimate: feeEstimateUsd });
            alerter?.push({
              kind: "execution",
              title: `✗ BROADCAST FAILED: ${lst.symbol}`,
              lines: [`Error: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`, "Fee burn logged against the daily cap"],
            });
            throw error;
          });
          const explorer = `https://solscan.io/tx/${signature}`;
          console.log(color.bold(color.green(`✅ FIRED ${lst.symbol}`)) + `  ${color.white(explorer)}`);
          logLedgerEntry(autoOptions.ledgerPath, { at: new Date().toISOString(), type: "fired", symbol: lst.symbol, signature, quotedProfitUsd: outcome.quotedProfitUsd, worstCaseProfitUsd: outcome.worstCaseProfitUsd, lossUsdEstimate: feeEstimateUsd });
          alerter?.push({
            kind: "profit",
            title: `💰 FIRED: ${lst.symbol}`,
            lines: [`Signature: ${signature}`, `Worst-case P&L: $${outcome.worstCaseProfitUsd.toFixed(4)}`, explorer],
          });
          break; // one fire per pass; cooldown re-arms via guards
        }
      } catch (error) {
        printError(error);
        logLedgerEntry(autoOptions.ledgerPath, { at: new Date().toISOString(), type: "pass", reason: error instanceof Error ? error.message.slice(0, 120) : "unknown error" });
      }
      await sleep(autoOptions.intervalSec * 1000);
    }
  });

  program
  .command("triangle-scan")
  .description("probe USDC→TOKEN→SOL→USDC flash-loan cycles across Jupiter routes (read-only)")
  .option("--size <usd>", "cycle size in USDC", "200")
  .option("--slippage <bps>", "per-hop slippage tolerance", "30")
  .option("--tokens <list>", "comma-separated mid-token symbols (default: registry)")
  .option("--watch", "keep probing in a loop", false)
  .option("--interval <seconds>", "seconds between passes", "30")
  .option("--log <path>", "append cycle results as JSON lines")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    size: string;
    slippage: string;
    tokens?: string;
    watch: boolean;
    interval: string;
    log?: string;
    json: boolean;
  }) => {
    const wanted = options.tokens ? options.tokens.split(",").map((t) => t.trim().toUpperCase()) : null;
    const tokens = wanted ? TRIANGLE_TOKENS.filter((t) => wanted.includes(t.symbol.toUpperCase())) : TRIANGLE_TOKENS;
    if (!tokens.length) throw new Error(`No valid tokens. Valid: ${TRIANGLE_TOKENS.map((t) => t.symbol).join(", ")}`);
    const sizeBaseUnits = BigInt(Math.floor(Number(options.size) * 1e6));
    const slippageBps = Number(options.slippage);
    if (sizeBaseUnits <= 0n) throw new Error("--size must be positive");
    const intervalMs = Math.max(15, Number(options.interval)) * 1000;
    const logPath = options.log;
    const log = logPath ? (line: unknown) => appendFileSync(logPath, `${safeJsonStringify(line)}\n`) : undefined;

    const runPass = async (pass: number) => {
      if (!options.json) console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] triangle pass #${pass} (${tokens.length} tokens, $${options.size}/cycle)...`));
      const results: Array<{ symbol: string; profitUsd?: number; worstUsd?: number; status: string }> = [];
      let positive = 0;
      for (const token of tokens) {
        const result = await planTriangle(token, { sizeBaseUnits, slippageBps });
        if (result.ok) {
          positive += 1;
          results.push({ symbol: token.symbol, profitUsd: result.profitUsd, worstUsd: result.worstProfitUsd, status: "CYCLE-POSITIVE" });
          log?.({ at: new Date().toISOString(), symbol: token.symbol, profitUsd: result.profitUsd, worstUsd: result.worstProfitUsd, sizeUsd: Number(options.size) });
        } else {
          results.push({ symbol: token.symbol, status: result.reason });
        }
      }
      if (options.json) console.log(safeJsonStringify({ at: new Date().toISOString(), positive, results }));
      else {
        console.log(color.bold(color.cyan("TRIANGLE SCAN")) + color.dim(`  ${localTimestamp(new Date().toISOString())}  positive=${positive}/${tokens.length}`));
        for (const r of results) {
          if (r.status === "CYCLE-POSITIVE") {
            console.log(`  ${color.green("⭐ " + r.symbol)}  quoted=$${r.profitUsd?.toFixed(4)} worst=$${r.worstUsd?.toFixed(4)}`);
          }
        }
      }
      return positive;
    };

    if (!options.watch) {
      await runPass(1);
      return;
    }
    let pass = 0;
    while (true) {
      pass += 1;
      try {
        await runPass(pass);
      } catch (error) {
        printError(error);
      }
      await sleep(intervalMs);
    }
  });

  program
  .command("triangle-execute")
  .description("prove a triangle cycle atomically: Kamino borrow → 3 hops → repay; SIMULATED, never broadcast without --yes")
  .option("--symbol <token>", "mid-token symbol from the triangle registry")
  .option("--size <usd>", "cycle size in USDC", "200")
  .option("--slippage <bps>", "per-hop slippage tolerance", "30")
  .option("--min-profit <usd>", "minimum worst-case profit to allow broadcasting", "0.05")
  .option("--dry-run", "stop after the plan (no signing)", false)
  .option("--yes", "broadcast after a profitable simulation", false)
  .option("--rpc <url>", "Solana RPC", configuredValue(process.env.SOLANA_RPC_URL) ?? DEFAULT_RPC)
  .option("--market <address>", "Kamino market", configuredValue(process.env.KAMINO_MARKET) ?? MAIN_MARKET)
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: {
    symbol: string;
    size: string;
    slippage: string;
    minProfit: string;
    dryRun: boolean;
    yes: boolean;
    rpc: string;
    market: string;
    json: boolean;
  }) => {
    const token = TRIANGLE_TOKENS.find((t) => t.symbol.toUpperCase() === options.symbol.trim().toUpperCase());
    if (!token) throw new Error(`Unknown token ${options.symbol}. Valid: ${TRIANGLE_TOKENS.map((t) => t.symbol).join(", ")}`);
    const sizeBaseUnits = BigInt(Math.floor(Number(options.size) * 1e6));
    const minProfitUsd = Number(options.minProfit);

    const rpc = rpcClient(options.rpc);
    const solPriceUsd = await fetchSolPriceUsdc().catch(() => 0);
    if (solPriceUsd <= 0) throw new Error("could not derive SOL price");

    const planResult = await planTriangle(token, { sizeBaseUnits, slippageBps: Number(options.slippage) });
    if (!planResult.ok) throw new Error(`plan failed: ${planResult.reason}`);
    const { plan } = planResult;

    const costsUsd = cycleCostsUsd(sizeBaseUnits, solPriceUsd);
    const netQuoted = planResult.profitUsd - costsUsd;
    const netWorst = planResult.worstProfitUsd - costsUsd;
    if (options.json) {
      console.log(safeJsonStringify({ plan: { symbol: token.symbol, quotedProfitUsd: planResult.profitUsd, worstCaseProfitUsd: planResult.worstProfitUsd, costsUsd, netQuoted, netWorst, routes: plan.hops.map((h) => h.labels) } }));
    } else {
      console.log(color.bold(color.magenta("TRIANGLE PLAN")) + color.dim(`  ${localTimestamp(plan.at)}  ${token.symbol}`));
      console.log(`  BORROW      = ${color.white(options.size + " USDC")} (Kamino 0.001% fee)`);
      console.log(`  QUOTED P&L  = ${netQuoted >= 0 ? color.green("$" + netQuoted.toFixed(4)) : color.red("$" + netQuoted.toFixed(4))} | WORST = ${color.yellow("$" + netWorst.toFixed(4))} (after $${costsUsd.toFixed(4)} costs)`);
      console.log(`  ROUTES      = ${plan.hops.map((h) => h.labels.join("+")).join(" → ")}`);
    }
    if (options.dryRun) {
      if (!options.json) console.log(color.dim("dry-run: stopping before signing"));
      return;
    }

    const market = await loadMarket(rpc, options.market);
    const outcome = await executeMultiLegCycle({
      rpc,
      rpcUrl: options.rpc,
      market,
      reserveAsset: "USDC",
      amountBaseUnits: sizeBaseUnits,
      plan,
      minProfitUsd,
      solPriceUsd,
    });
    if (!outcome.passed) {
      const failure = outcome as { stage: string; reason?: string; logs?: string[] };
      const reason = failure.reason ?? "unknown";
      const logs = failure.logs;
      throw new Error(`${failure.stage} failed: ${reason}${logs ? "\n" + logs.slice(-6).join("\n") : ""}`);
    }
    if (options.json) {
      console.log(safeJsonStringify({ simulation: "ok", computeUnitsConsumed: outcome.computeUnitsConsumed.toString(), instructions: outcome.instructions, quotedProfitUsd: outcome.quotedProfitUsd.toFixed(4), worstCaseProfitUsd: outcome.worstProfitUsd.toFixed(4), executable: outcome.worstProfitUsd >= minProfitUsd }));
    } else {
      console.log(color.bold(color.green("SIMULATION OK")) + color.dim(`  CU=${outcome.computeUnitsConsumed}  ix=${outcome.instructions}`));
      console.log(`  NET QUOTED  = $${outcome.quotedProfitUsd.toFixed(4)} | NET WORST = $${outcome.worstProfitUsd.toFixed(4)}`);
      console.log(`  EXECUTABLE  = ${outcome.worstProfitUsd >= minProfitUsd ? color.green("YES") : color.yellow("NO")}`);
    }
    if (!options.yes) {
      if (!options.json) console.log(color.dim("simulate-only: add --yes to broadcast when executable"));
      return;
    }
    if (outcome.worstProfitUsd < minProfitUsd) throw new Error(`worst-case below floor; refusing to broadcast`);
    const signature = await sendAndConfirm(options.rpc, rpc, outcome.transaction as Parameters<typeof sendAndConfirm>[2]);
    console.log(color.bold(color.green(`✅ FIRED ${token.symbol}`)) + `  ${color.white(`https://solscan.io/tx/${signature}`)}`);
  });

const cv = program
  .command("cv")
  .description("cross-venue constant-product arb tools")
  .addHelpText("after", `Commands:\n  probe   premise check: SOL/USDC pools across venues + vault-truth spread\n  scan    full cross-venue scan for executable arb plans`);
cv
  .command("probe")
  .description("premise check: constant-product SOL/USDC pools across venues and their vault-truth price spread")
  .option("--full", "print full pool addresses", false)
  .option("--venue <names>", "comma-separated venue names to probe (pumpswap,meteora-damm,meteora-damm-v2)")
  .action(async (options: { full: boolean; venue?: string }) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
    const venues = options.venue ? options.venue.split(",").map((v) => v.trim()).filter(Boolean) : undefined;
    await runCvProbe(rpcUrl, venues ? { showFull: options.full, venues } : { showFull: options.full });
  });
cv
  .command("scan")
  .description("cross-venue vault-truth scan: same token across constant-product venues, executable arb plans")
  .option("--min-profit <usd>", "minimum net USD edge to report", "0.05")
  .option("--min-vault-usd <usd>", "minimum quote depth (USD)", "1000")
  .option("--log <path>", "append plans as JSON lines")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: { minProfit: string; minVaultUsd: string; log?: string; json: boolean }) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
    const rpc = createRpcClient(rpcUrl);
    const minNetUsd = Number(options.minProfit);
    const minVaultUsd = Number(options.minVaultUsd);
    const logPath = options.log;
    const log = logPath ? (line: unknown) => appendFileSync(logPath, `${safeJsonStringify(line)}\n`) : undefined;
    const outcome = await scanCvPass(rpc, { minNetUsd, minVaultUsd });
    if (options.json) {
      console.log(safeJsonStringify(outcome));
    } else {
      console.log(`cross-venue scan @ ${localTimestamp(outcome.at)}: markets=${outcome.markets} pairs=${outcome.pairsSeen} opportunities=${outcome.opportunities.length} errors=${outcome.errors}`);
      for (const plan of outcome.opportunities) {
        log?.({ at: outcome.at, ...plan });
        console.log(`  ${color.green("⭐")} ${plan.tokenLabel}  buy ${plan.buyVenue} → sell ${plan.sellVenue}`);
        console.log(`     solIn=${plan.solIn.toFixed(4)} tokenOut=${plan.tokenOut.toFixed(4)} solOut=${plan.solOut.toFixed(4)}`);
        console.log(`     gross=${color.cyan("$" + plan.grossUsd.toFixed(4))}  net=${plan.netUsd >= 0 ? color.green("$" + plan.netUsd.toFixed(4)) : color.red("$" + plan.netUsd.toFixed(4))}`);
      }
    }
  });

cv
  .command("verify")
  .description("verify a pool's vault ratio vs Jupiter direct-route (executable-truth check)")
  .argument("<venue>", "venue name (pumpswap|meteora-damm|meteora-damm-v2)")
  .argument("<pool>", "pool address")
  .action(async (venue: string, pool: string) => {
    await runPoolVerify([{ pool, venue }], process.env.SOLANA_RPC_URL || DEFAULT_RPC);
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
