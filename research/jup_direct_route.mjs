// Try quote params that avoid ALTs: onlyDirectRoutes=true
const params = new URLSearchParams({
  inputMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: String(3654661085),
  slippageBps: "50",
  onlyDirectRoutes: "true",
});
const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
console.log("direct-route quote:", res.status);
if (res.ok) {
  const q = await res.json();
  console.log("out:", q.outAmount, "routes:", (q.routePlan ?? []).map(s => s.swapInfo?.label).join("+"));
  // then swap-instructions with it:
  const res2 = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: "BuTTR3T2WsnWSpB4upFAUXfRQkj1CP5kunD1eUFpX7xB", wrapAndUnwrapSol: false, dynamicSlippage: false }),
  });
  const j = await res2.json();
  console.log("ALTs needed:", (j.addressLookupTableAddresses ?? []).length);
}
