// Same address twice, slightly different cached values → Gecko pagination glitch, NOT two pools.
// 孙小圣's "3.3% spread" was an artifact of Gecko serving the same pool twice with different staleness.
// LESSON for the screener: never trust aggregator cached prices for arb decisions; on-chain vault reads are the ONLY truth.
// 
// FINAL RESEARCH SYNTHESIS — what we now KNOW empirically:
// 1. New-pool mispricing (playbook #2) exists but window is minutes (MEV battleground, article admits bribes 2.3-141 SOL)
// 2. Hidden treasure (playbook #1) pools = 99% graves (ANB: ghost $6.1M liq, all one-sided)
// 3. Jupiter is NOT blind — routes fresh pumpswap/dust DAMMv2 fine
// 4. Same-name-different-mint spam (CUPCAKE x5, ELUN) poisons name-based grouping
// 5. Gecko cached prices can be arbitrarily stale (ANB showed $0.0096 vs real 4.65e-8)
// 6. The $696K ANB arb was executed by orderflow-insertion bots (Phoenix+Meteora in ONE tx, 1.25M CU, matching LionX's playbook)
console.log("Research synthesis complete. The honest path: on-chain-native new-pool watcher with vault-truth verification.");
