// Even direct routes need 1 ALT (Jup uses ALTs for their own account lists).
// Options: (1) support ALTs in buildFlashLoan — kit createSolanaV2Transaction supports ALTs.
// (2) Manifest direct program swap via its own instruction builder (no ALT).
// Fastest robust path: support ALT loading in our sandwich. Check how big the ALT list is:
const params = new URLSearchParams({
  inputMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: String(3654661085), slippageBps: "50", onlyDirectRoutes: "true",
});
const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } })).json();
const res2 = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ quoteResponse: q, userPublicKey: "BuTTR3T2WsnWSpB4upFAUXfRQkj1CP5kunD1eUFpX7xB", wrapAndUnwrapSol: false, dynamicSlippage: false }),
});
const j = await res2.json();
console.log("ALTs:", JSON.stringify(j.addressLookupTableAddresses));
console.log("swapInstruction accounts:", j.swapInstruction?.accounts?.length);
console.log("accounts:", JSON.stringify(j.swapInstruction?.accounts?.slice(0, 5)));
