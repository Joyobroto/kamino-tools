import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createFailoverRpc } from "../src/rpc-failover.js";

test("403 on both configured endpoints trips cooldown instead of an HTTP retry storm", async (t) => {
  let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response("forbidden",{status:403});});
  const {rpc}=createFailoverRpc({primaryUrl:"https://denied-primary.invalid",fallbackUrl:"https://denied-fallback.invalid"});
  await assert.rejects(rpc.getSlot().send());
  assert.equal(calls,2);
  await Promise.all(Array.from({length:100},()=>assert.rejects(rpc.getSlot().send(),/cooling down/)));
  assert.equal(calls,2);
});

test("a configured working fallback serves requests while a rejected primary cools down", async (t) => {
  let primary=0,fallback=0;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=>{
    if(String(input).includes("blocked-primary")){primary++;return new Response("forbidden",{status:403});}
    fallback++;return new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:123}),{headers:{"Content-Type":"application/json"}});
  });
  const {rpc}=createFailoverRpc({primaryUrl:"https://blocked-primary.invalid",fallbackUrl:"https://working-fallback.invalid"});
  assert.equal(await rpc.getSlot().send(),123n);
  assert.equal(await rpc.getSlot().send(),123n);
  assert.equal(primary,1);assert.equal(fallback,2);
});
