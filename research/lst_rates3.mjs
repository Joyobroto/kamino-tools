// Shape mismatch. Inspect the raw response for one LST:
const res = await fetch("https://lite-api.jup.ag/price/v3?ids=J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe", { headers: { Accept: "application/json" } });
console.log(res.status);
console.log(JSON.stringify(await res.json(), null, 1).slice(0, 600));
