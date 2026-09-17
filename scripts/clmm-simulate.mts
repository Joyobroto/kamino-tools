/** Read-only mainnet validation. Unsigned transactions are simulated with sigVerify=false;
 * there is deliberately no sendTransaction call. */
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import { getClmmQuoter } from '../src/strategies/liquidation/clmm.js';
import { loadMarket, rpcClient } from '../src/kamino.js';
import { loadWalletSigner, privateKeyFromEnv, MAIN_MARKET } from '../src/config.js';
import { loadAltState, altTableAddresses } from '../src/strategies/liquidation/setup.js';
config({quiet:true});
const endpoint = process.env.SOLANA_RPC_URL!;
const connection = new Connection(endpoint,{commitment:'processed',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10_000)})});
const wallet = await loadWalletSigner({privateKey:privateKeyFromEnv(),keypairPath:undefined});
const payer = new PublicKey(wallet.address);
const sol = new PublicKey('So11111111111111111111111111111111111111112');
const market = await loadMarket(rpcClient(endpoint),process.env.KAMINO_MARKET || MAIN_MARKET);
const quoter = getClmmQuoter(endpoint);
const tableKeys = [...altTableAddresses(loadAltState()),'AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU'];
const tables = (await Promise.all(tableKeys.map(async key=>(await connection.getAddressLookupTable(new PublicKey(key))).value))).filter(x=>x!==null);
const results: unknown[] = [];
for (const route of [['SOL','USDC','SOL'],['SOL','cbBTC','SOL'],['SOL','USDC','cbBTC','USDC','SOL']]) {
  const symbol = route.join('→');
  try {
    const mints = route.map(symbol => symbol === 'SOL' ? sol : new PublicKey(market.getReserves().find(r=>r.getTokenSymbol().toLowerCase()===symbol.toLowerCase())!.getLiquidityMint()));
    await Promise.all(mints.slice(1).map((mint,i)=>quoter.loadPairState(mints[i]!,mint)));
    const atas = mints.map(mint=>getAssociatedTokenAddressSync(mint,payer));
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),
      ...mints.map((mint,i)=>createAssociatedTokenAccountIdempotentInstruction(payer,atas[i]!,payer,mint)),
      SystemProgram.transfer({fromPubkey:payer,toPubkey:atas[0]!,lamports:10_000_000}),createSyncNativeInstruction(atas[0]!)];
    let amount = new BN(10_000_000);
    const pools: Array<{pool:string;bitmap?:string}> = [];
    for (let i=0;i<mints.length-1;i++) {
      const tokenIn=mints[i]!, tokenOut=mints[i+1]!;
      const quote=await quoter.quoteExactIn({tokenIn,tokenOut,amountIn:amount,slippageBps:100});
      if (!quote) throw new Error(`no fresh quote at leg ${i}`);
      const swap=await quoter.buildSwapInstruction({tokenIn,tokenOut,payer,ownerTokenIn:atas[i]!,ownerTokenOut:atas[i+1]!,amountIn:amount,amountOutMin:quote.amountOutMin,quote});
      if (!swap) throw new Error(`builder declined leg ${i}`);
      instructions.push(swap.instruction);
      pools.push({pool:quote.poolId.toBase58(),...(quote.snapshot.bitmapAddress?{bitmap:quote.snapshot.bitmapAddress.toBase58()}:{})});
      amount=quote.amountOutMin;
    }
    const {blockhash}=await connection.getLatestBlockhash('processed');
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions}).compileToV0Message(tables));
    const simulation=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'processed'});
    const result={symbol,pools,wireBytes:tx.serialize().length,slot:simulation.context.slot,error:simulation.value.err,units:simulation.value.unitsConsumed,logs:simulation.value.logs};
    results.push(result); console.log(JSON.stringify({...result,logs:undefined}));
  } catch(error) {const message=String(error).replace(/https?:\/\/[^\s]+/g,'[rpc]');results.push({symbol,error:message});console.log(JSON.stringify({symbol,error:message}));}
}
writeFileSync('docs/CLMM_SIMULATION_2026-09-16.json',JSON.stringify(results,null,2)+'\n');
process.exitCode=results.some((x:any)=>x.error!==null)?1:0;
