// Pool B (DAMMv2, "liq $240K" per Gecko): vault0 = 0.003306, vault1 = 8.508136 (both 6 dec).
// One of these is ANB vault, one is USDC vault. Gecko claims $240K liquidity. On-chain reality:
// vaults hold 0.003 + 8.5 units → TOTAL ~$8.51. GHOST LIQUIDITY CONFIRMED.
// Which is which? vault@232 balance 0.003306; vault@264 8.508136. ANB mints@168 = tokenA. Typically vaultA@232.
// Price implied: if 232=ANB(0.003306) & 264=USDC(8.508136) → $2,573/ANB?? Nonsense. Reverse: USDC=0.0033, ANB=8.508 → 0.000389/ANB.
// ANB "real" value in pool A was 4.65e-8. So B's 0.000389 is 8,000x higher — but extractable $ = dust.
// THE ANB STORY IS DEAD for arb (all pools are graves), BUT the MECHANISM is now proven.
// Final question for thesis: how COMMON are live mismatches like article describes? Sweep systematically:
// Plan: pull N dead-volume pools per dex from Gecko + cross-check on-chain vault ratios + match mints across pools.
console.log("ANB conclusion: all pools one-sided graves; Gecko stale prices create phantom spread. No executable arb.");
console.log("But tx evidence: bots extracted $696K/tx on May 1 when pools WERE fresh and two-sided.");
