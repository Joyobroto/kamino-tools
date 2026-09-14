import { strict as assert } from "node:assert";
import { test } from "node:test";
import { address, createNoopSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import type { KaminoMarket, KaminoReserve } from "@kamino-finance/klend-sdk";
import { buildLiquidationSetup, liquidationAltKeys } from "../src/strategies/liquidation/setup.js";
import { deriveAssociatedTokenAccount } from "../src/kamino.js";

test("Token-2022 liquidity uses SPL Token for collateral ATAs in setup and LUT keys", async () => {
  const spl = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const zero = address("11111111111111111111111111111111");
  const liquidity = address("So11111111111111111111111111111111111111112");
  const collateral = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const signer = createNoopSigner(address("AcRF3Zu5imsshcy1pJ3hXt2MrMvUfdsF6eT3DXFU6re1"));
  const reserve = { address: zero, getLiquidityMint: () => liquidity, getCTokenMint: () => collateral,
    getLiquidityTokenProgram: () => address(token2022), state: { lendingMarket: zero,
      liquidity: { supplyVault: zero, feeVault: zero }, collateral: { supplyVault: zero },
      config: { tokenInfo: { scopeConfiguration: { priceFeed: zero } } },
    } } as unknown as KaminoReserve;
  const market = { getAddress: () => zero, programId: zero, farmsProgramId: zero } as unknown as KaminoMarket;
  const rpc = { getAccountInfo: () => ({ send: async () => ({ value: null }) }) } as unknown as Rpc<SolanaRpcApi>;
  const keys = await liquidationAltKeys({ market, reserves: [reserve], authority: signer.address, rpcUrl: "https://unused.invalid" });
  const collateralAta = await deriveAssociatedTokenAccount({ mint: collateral, owner: signer.address, tokenProgram: spl });
  assert.ok(keys.includes(collateralAta));
  assert.ok(!keys.includes(await deriveAssociatedTokenAccount({ mint: collateral, owner: signer.address, tokenProgram: token2022 })));
  const setup = await buildLiquidationSetup({ rpc, market, reserves: [reserve], signer,
    rpcUrl: "https://unused.invalid", existingLookupTable: zero, existingKeys: keys });
  const instructions = setup.transactions.flat();
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0]!.accounts![5]!.address, token2022);
  assert.equal(instructions[1]!.accounts![5]!.address, spl);
  assert.equal(instructions[1]!.accounts![1]!.address, collateralAta);
});
