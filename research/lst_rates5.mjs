// WSOL shows in price v3, JitoSOL empty → Jupiter price feed doesn't list JitoSOL?? 
// Different key: maybe usdPrice only present for tokens they track; JitoSOL mint might use a
// different canonical form. Try jupSOL + mSOL + explicit multi:
const res = await fetch("https://lite-api.jup.ag/price/v3?ids=jupSoLaHXQiZZTSfEWMTRRgpF3fZ4NZxXvdLHvGkd87,mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcvsLYf,J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe", { headers: { Accept: "application/json" } });
console.log(res.status, JSON.stringify(await res.json()).slice(0, 400));
// If still empty → fallback plan: derive reference rate ON-CHAIN from Kamino itself:
// Kamino reserves price JitoSOL via oracle... OR use our OWN vault-truth approach:
// reference rate = mid of the TWO deepest LST/SOL pools (inter-market median). That's
// actually MORE arb-truthful than an oracle — it's executable market consensus.
