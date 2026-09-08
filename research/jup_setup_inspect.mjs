// What are Jupiter's setupInstructions? (likely createIdempotent ATA for destination mint)
const params = new URLSearchParams({
  inputMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: "3661951946", slippageBps: "50",
});
const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } })).json();
const res = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ quoteResponse: q, userPublicKey: "BuTTR3T2WsnWSpB4upFAUXfRQkj1CP5kunD1eUFpX7xB", wrapAndUnwrapSol: false, dynamicSlippage: false }),
});
const j = await res.json();
console.log("setup:", (j.setupInstructions ?? []).map(s => ({ programId: s.programId?.slice(0, 8), dataLen: s.data?.length, firstBytes: s.data?.slice(0, 16) })));
console.log("cleanup:", j.cleanupInstruction ? { programId: j.cleanupInstruction.programId.slice(0, 8) } : null);
