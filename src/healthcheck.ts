import { checkHeartbeat } from "./strategies/liquidation/health.js";
const problems = checkHeartbeat();
if (problems.length) console.error(problems.join("; "));
process.exit(problems.length ? 1 : 0);
