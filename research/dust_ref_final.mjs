// Even $1 sell → 0 SOL. The "Meteora DAMM v2" reference pool for 6TJ6JB7k holds dust
// (like AWRUuFUh held 1886 base + 0.0024 SOL). CONFIRMED 100%: all pumpswap-migration
// "discounts" are pool-vs-dust-pool mirages. The ONLY market for these mints IS the pumpswap pool itself.
// SO: is the whole treasure thesis dead? NO — re-read the playbook:
// The REAL version of this game = price DIFFERENCE between TWO DEEP pools for the same mint.
// Our watcher detects NEW pools; the mirage happens because Jupiter's best price for fresh mints
// comes from OTHER NEW dust pools created by the same bots (snipers pre-seed tiny pools).
// WHAT WOULD A REAL TREASURE LOOK LIKE? Both sides of the pair holding $1000+ in the
// SECOND market too. Our current gate only validates OUR pool's depth, not the reference's.
// → Next iteration: add REFERENCE DEPTH GATE (sell $X through Jupiter; require non-zero output
//   at $100+ and price impact < threshold).
console.log("All discounts = mirage vs dust reference. Fix = reference-depth gate before alerting.");
