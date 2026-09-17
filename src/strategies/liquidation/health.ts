import { readFileSync, writeFileSync, renameSync } from "node:fs";

export interface Heartbeat {
  at: number; pid: number; scanAt: number; hotAt: number; oracleAt: number;
  oracleLive: boolean; oracleSnapshotAgeMs: number; wsLive: boolean;
  executorBusy: number; scanMaxAgeMs: number;
}
export const HEARTBEAT_PATH = process.env.LIQ_HEARTBEAT_PATH ?? "/tmp/kamino-heartbeat.json";
export function writeHeartbeat(value: Heartbeat, path = HEARTBEAT_PATH): void {
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(value));
    renameSync(`${path}.tmp`, path);
  } catch (error) { console.error("heartbeat write failed", error instanceof Error ? error.message : String(error)); }
}
export function heartbeatProblems(value: Heartbeat, now = Date.now()): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(value.at) || now - value.at > 30_000 || value.at > now) problems.push("watcher heartbeat stale");
  if (!Number.isFinite(value.scanAt) || now - value.scanAt > value.scanMaxAgeMs) problems.push("scan stalled");
  if (!value.oracleLive || !value.oracleAt || now - value.oracleAt > 60_000) problems.push("oracle stream stale");
  if (!Number.isFinite(value.oracleSnapshotAgeMs) || value.oracleSnapshotAgeMs > 30_000) problems.push("oracle snapshot stale");
  if (!value.wsLive) problems.push("obligation stream down");
  return problems;
}
export function checkHeartbeat(path = HEARTBEAT_PATH): string[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
    process.kill(value.pid, 0);
    return heartbeatProblems(value);
  } catch { return ["watcher process or heartbeat unavailable"]; }
}
