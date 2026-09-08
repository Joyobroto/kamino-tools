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
import { subscribeLiquidationSlices, type LiquidationWsHandle } from "./strategies/liquidation/ws-realtime.js";
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
  executionAlert, // kept for test compat
  profitAlert,
  liquidationFailedAlert,
  budgetPausedAlert,
  heartbeatAlert,
  dueAttemptAlert,
} from "./alerts/telegram.js";
import { DEFAULT_AUTOFIRE_OPTIONS, evaluateFireGuards, loadLedger, logLedgerEntry, type AutofireOptions } from "./strategies/arb/autofire.js";
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
  ws?: string;
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
  .option("--ws <url>", "WebSocket endpoint for real-time obligation deltas (default: derived from --rpc)", "")
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
      alerter.push(startupAlert({ cyclesPerHour: Math.round(3_600_000 / intervalMs), hotIntervalSec: hotIntervalMs / 1000, broadcast: options.broadcast, wsLive: options.watch && !options.json }));
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
    // ── Realtime detection rail: programNotifications on the obligation stream ──
    // WS deltas are the LOW-LATENCY path (per-account changes arrive within ~1 slot
    // vs the 10s hot loop / 60s full scan). A cached health < 1 here is a signal to
    // go straight to executeDue — every later stage (fresh hydration, guards, sim,
    // broadcast) is owned by the executor, so we never execute on stale slate.
    const wsUrl = options.ws || options.rpc.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    let wsHandle: LiquidationWsHandle | undefined;
    if (options.watch && !options.json) {
      const wsLogged = new Map<string, number>();
      subscribeLiquidationSlices({
        wsUrl,
        marketAddress: options.market,
        onSlice: (slice) => {
          if (slice.cachedHealth >= 1) return;
          const obligation = slice.pubkey.toString();
          const lastLogged = wsLogged.get(obligation) ?? 0;
          if (Date.now() - lastLogged < 30_000) return;
          wsLogged.set(obligation, Date.now());
          console.log(`${color.bold(color.red("⚡ WS DUE"))} ${shortAddress(obligation)}  health ${slice.cachedHealth.toFixed(4)}`);
          executeDue(obligation);
        },
        onReady: () => {
          console.log(color.dim(`[${localTimestamp(new Date().toISOString())}] ws deltas live (${wsUrl})`));
        },
        onError: (error: unknown) => {
          console.warn(color.yellow(`[${localTimestamp(new Date().toISOString())}] ws rail: ${error instanceof Error ? error.message : String(error)}`));
        },
      }).then((handle) => {
        wsHandle = handle;
      }).catch((error: unknown) => {
        if (!options.json) console.warn(color.yellow(`[${localTimestamp(new Date().toISOString())}] ws subscribe failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    }
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
