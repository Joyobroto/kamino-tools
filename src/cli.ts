#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { appendFileSync } from "node:fs";
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
import { instructionSummary, loadStrategy } from "./strategy.js";
import { createSignedTransaction, sendAndConfirm, simulate } from "./transaction.js";
import { scanOnce, preloadMarket, refreshTrackedObligations, type PreloadedMarket } from "./strategies/liquidation/screener.js";
import { HotTracker, type TrackerEvent } from "./strategies/liquidation/tracker.js";
import type { ScanEvent, ScanResult, LiquidatableCandidate, AdlCandidate } from "./strategies/liquidation/types.js";
import { type ScanOptions as LiquidationScanConfig } from "./strategies/liquidation/types.js";
import {
  TelegramAlerter,
  telegramConfigFromEnv,
  startupAlert,
  surgeAlert,
  testAlert,
  trackerEventToAlert,
} from "./alerts/telegram.js";
import { scanArbPass } from "./strategies/arb/scanner.js";
import { DEFAULT_ARB_SCAN_OPTIONS, MINTS, type ArbScanOptions, type MintSymbol } from "./strategies/arb/types.js";
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
  appendFileSync(path, `${JSON.stringify(event)}\n`);
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
    if (options.json) console.log(JSON.stringify(selectableReserveRows(rows), null, 2));
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

    const emitTrackerEvents = (events: TrackerEvent[]) => {
      for (const event of events) {
        if (event.type === "spotted") {
          log?.({ type: "spotted", at: event.at, candidate: event.candidate });
          console.log(`${color.bold(color.red("⚡ DUE"))} ${printCandidateLine(event.candidate, "")}`);
        } else if (event.type === "promoted") {
          log?.({ type: "promoted", at: event.at, candidate: event.candidate, fromHealth: event.fromHealth });
          console.log(`${color.bold(color.red("⚡ PROMOTED→DUE"))} ${printCandidateLine(event.candidate, color.yellow(`(was ${event.fromHealth.toFixed(4)})`))}`);
        } else if (event.type === "watching") {
          log?.({ type: "watching", at: event.at, candidate: event.candidate });
          console.log(`${color.magenta("◉ WATCHING")} ${printCandidateLine(event.candidate, color.dim("(hot-tracked)"))}`);
        } else if (event.type === "taken") {
          log?.({ type: "taken", at: event.at, obligation: event.obligation, firstSpottedAt: event.firstSpottedAt, satSeconds: event.satSeconds, wasDue: event.wasDue, ...(event.dueSince ? { dueSince: event.dueSince } : {}) });
          const label = event.wasDue ? `${color.bold(color.yellow("✗ TAKEN"))} ${color.cyan(event.obligation)} ${color.dim(`DUE ${event.satSeconds}s — liquidated/closed`)}` : `${color.bold(color.yellow("✗ GONE"))} ${color.cyan(event.obligation)} ${color.dim(`left band after ${event.satSeconds}s (healed/managed)`)}`;
          console.log(label);
        } else {
          log?.({ type: "healed", at: event.at, obligation: event.obligation, lastHealth: event.lastHealth });
          console.log(`${color.green("✓ HEALED")} ${color.cyan(event.obligation)} ${color.dim(`back to ${event.lastHealth.toFixed(4)} — borrower repaid/topped-up`)}`);
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

loanOptions(program.command("plan").description("validate inputs and print the exact atomic instruction order"), false)
  .action(async (options: LoanOptions) => {
    const { summary } = await prepare(options, false);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      printBanner();
      printPlanSummary(summary);
      console.log(centerBlock(`${color.magenta("[PLAN]")} Tidak ada transaksi dikirim`));
    }
  });

loanOptions(program.command("simulate").description("sign and simulate without broadcasting"), true)
  .action(async (options: LoanOptions) => {
    const { rpc, signer, build, summary } = await prepare(options, true);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
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
    if (options.json) console.log(JSON.stringify(summary, null, 2));
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
    if (options.json) console.log(JSON.stringify({ signature, explorer }, null, 2));
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
