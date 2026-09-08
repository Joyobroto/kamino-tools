// The TOKEN PROGRAM id is wrong?? "Tokenkeg..." — wait, actual length 33 means MY program address string is 43+ chars?
// Let me count: standard is 43-44 chars. I typo'd it. Print lengths:
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP";
console.log("len:", TOKEN.length); // should be 43? token program is 41 chars? verify against known constants
const known = ["11111111111111111111111111111111", "So11111111111111111111111111111111111111112"];
console.log(known.map(k => k.length));
// Actual Solana Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP ← check online known value:
// REAL: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP is 41? print:
console.log(TOKEN);
