// Probe: does lite-api expose /swap-instructions (individual instructions we can embed
// into the flash-loan sandwich as strategy JSON)?
const quoteParams = new URLSearchParams({
  inputMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: String(1 * 10 ** 9),
  slippageBps: "50",
});
const quote = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?${quoteParams}`, { headers: { Accept: "application/json" } })).json();
console.log("quote ok, out:", quote.outAmount, "routes:", (quote.routePlan ?? []).map(s => s.swapInfo?.label).join("+"));
// probe swap-instructions:
const res = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: "11111111111111111111111111111111", // placeholder wallet
    wrapAndUnwrapSol: false,
    dynamicSlippage: false,
  }),
});
console.log("swap-instructions:", res.status);
if (res.ok) {
  const j = await res.json();
  console.log("keys:", Object.keys(j));
  const first = (j.swapInstructions ?? [])[0];
  if (first) console.log("first instruction:", JSON.stringify({ programId: first.programId, accounts: first.accounts?.length, dataLen: first.data?.length, keys: Object.keys(first) }).slice(0, 200));
}
