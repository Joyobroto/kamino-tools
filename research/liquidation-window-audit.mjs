// Read-only replay of the September 11 window. Uses public RPC only; no dotenv or signer.
import { readFileSync, writeFileSync } from 'node:fs';
const rpcUrl='https://api.mainnet-beta.solana.com';
if(!rpcUrl) throw new Error('SOLANA_RPC_URL missing');
const rows=readFileSync(new URL('../data/liq_autofire_ledger.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.at.startsWith('2026-09-11T12:30:'));
async function rpc(method,params){
 for(let n=0;n<4;n++){
  await new Promise(r=>setTimeout(r,1200));
  let res;
  try{res=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});}catch(e){throw new Error(`RPC transport failed: ${e.cause?.code??e.name}`);}
  if(res.status===429 || res.status>=500){await new Promise(r=>setTimeout(r,1000*(n+1)));continue;}
  const j=await res.json();if(j.error)throw new Error(`RPC ${method} error code ${j.error.code}`);return j.result;
 }throw new Error('RPC retries exhausted');
}
const start=Date.parse('2026-09-11T12:28:00Z')/1000,end=Date.parse('2026-09-11T12:32:00Z')/1000;
const results=[];
for(const row of rows){
 let before, reached=false, inspected=0;
 const matches=[];
 for(let page=0;page<30;page++){
  const sigs=await rpc('getSignaturesForAddress',[row.obligation,{limit:100,...(before?{before}:{})}]);
  if(!sigs?.length){reached=true;break;}
  inspected+=sigs.length;
  for(const sig of sigs){
   if(sig.blockTime && sig.blockTime<start){reached=true;break;}
   if(sig.err || !sig.blockTime || sig.blockTime>end)continue;
   const tx=await rpc('getTransaction',[sig.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);
   matches.push({signature:sig.signature,...tx});
  }
  if(reached)break;before=sigs.at(-1).signature;
 }
 results.push({obligation:row.obligation,triggerApprox:row.at,inspected,reached,transactions:matches});
 writeFileSync('/tmp/kamino-winners-raw.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify({obligation:row.obligation,inspected,reached,transactions:matches.map(tx=>({signature:tx.signature,slot:tx.slot,at:tx.blockTime?new Date(tx.blockTime*1000).toISOString():null,payer:tx.transaction?.message?.accountKeys?.[0]?.pubkey,err:tx.meta?.err,logs:tx.meta?.logMessages?.filter(l=>/liquidat|repaid|withdrew/i.test(l))}))}));
}
