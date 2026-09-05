import type { LiquidatableCandidate } from "./types.js";

export interface TrackedCandidate {
  candidate: LiquidatableCandidate;
  firstSpottedAt: string;
  lastSeenAt: string;
  lastSeenHealth: number;
  /** Set when the position was last observed below health 1.0 (DUE). */
  dueSince?: string;
  /** Consecutive hot ticks where the position sat above the watch band. */
  consecutiveAboveBand?: number;
}

export type TrackerEvent =
  | { type: "spotted"; at: string; candidate: LiquidatableCandidate }
  | { type: "promoted"; at: string; candidate: LiquidatableCandidate; fromHealth: number }
  | { type: "watching"; at: string; candidate: LiquidatableCandidate }
  | { type: "taken"; at: string; obligation: string; firstSpottedAt: string; satSeconds: number; wasDue: boolean; dueSince: string | undefined }
  | { type: "healed"; at: string; obligation: string; lastHealth: number };

export interface HotThresholds {
  nearMissHealth: number;
  hotHealth: number;
  /** Candidates below this health are hot-refreshed (watch tier) even while still >= 1.0. */
  watchHealth: number;
  /** Cap on watch-tier size; DUE positions are always tracked regardless of the cap. */
  maxWatch: number;
}

export const DEFAULT_HOT_THRESHOLDS: HotThresholds = {
  nearMissHealth: 1.05,
  hotHealth: 1.02,
  watchHealth: 1.02,
  maxWatch: 60,
};

/**
 * Two-tier hot list.
 *
 * **DUE tier** — every position seen below health 1.0. Always hot-refreshed, never capped.
 * This is what Phase 2/3 will execute against.
 *
 * **Watch tier** — at-risk positions still above 1.0 (health < watchHealth). Hot refresh
 * catches the crossing within one hot tick (~10s) instead of waiting for the next full
 * scan (~60s+), which is the blind window that missed `6qzcv4qA`. Capped at maxWatch;
 * when the cap is exceeded, the healthiest (furthest from DUE) are dropped first —
 * in a surge the tracker deliberately narrows onto the positions closest to the line.
 */
export class HotTracker {
  private readonly tracked = new Map<string, TrackedCandidate>();
  private readonly thresholds: HotThresholds;

  constructor(thresholds: HotThresholds = DEFAULT_HOT_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  get size(): number {
    return this.tracked.size;
  }

  trackedObligations(): string[] {
    return [...this.tracked.keys()];
  }

  /** Obligations in the DUE tier (last seen below 1.0). */
  dueObligations(): string[] {
    return [...this.tracked.values()]
      .filter((entry) => entry.lastSeenHealth < 1)
      .map((entry) => entry.candidate.obligation);
  }

  /** Obligations hot-refreshed on ticks: everything tracked (DUE tier + watch tier).
   *  Tracked-only means bounded cost; the hysteresis counter needs their updates to
   *  progress, so band-edge positions must stay in the refresh set until released. */
  hotObligations(): string[] {
    return [...this.tracked.keys()];
  }

  all(): TrackedCandidate[] {
    return [...this.tracked.values()].sort((a, b) => a.lastSeenHealth - b.lastSeenHealth);
  }

  /** Highest health still admitted to the watch tier (for trimming). */
  private trimWatchTier(at: string): void {
    const watchEntries = [...this.tracked.values()]
      .filter((entry) => entry.lastSeenHealth >= 1)
      .sort((a, b) => b.lastSeenHealth - a.lastSeenHealth); // healthiest first
    const excess = watchEntries.length - this.thresholds.maxWatch;
    for (let i = 0; i < excess; i += 1) {
      this.tracked.delete(watchEntries[i]!.candidate.obligation);
    }
  }

  /**
   * Ingest a full-scan candidate list (liquidatable + nearMiss). Near-miss candidates
   * below watchHealth enter the watch tier (bounded); unhealthy candidates enter the
   * DUE tier (unbounded).
   */
  absorb(candidates: LiquidatableCandidate[], at: string): TrackerEvent[] {
    const events: TrackerEvent[] = [];
    for (const candidate of candidates) {
      const existing = this.tracked.get(candidate.obligation);
      if (!existing) {
        if (candidate.healthFactor < 1) {
          this.tracked.set(candidate.obligation, {
            candidate,
            firstSpottedAt: at,
            lastSeenAt: at,
            lastSeenHealth: candidate.healthFactor,
            dueSince: at,
          });
          events.push({ type: "spotted", at, candidate });
        } else if (candidate.healthFactor < this.thresholds.watchHealth) {
          const watchCount = [...this.tracked.values()].filter((e) => e.lastSeenHealth >= 1).length;
          if (watchCount < this.thresholds.maxWatch) {
            this.tracked.set(candidate.obligation, {
              candidate,
              firstSpottedAt: at,
              lastSeenAt: at,
              lastSeenHealth: candidate.healthFactor,
            });
            events.push({ type: "watching", at, candidate });
          }
        }
      } else {
        const wasDue = existing.lastSeenHealth < 1;
        // The hot loop is fresher than the full scan: never resurrect a DUE entry into the
        // watch tier based on a stale full-scan observation (surge correctness).
        if (wasDue && candidate.healthFactor >= 1) continue;
        existing.candidate = candidate;
        existing.lastSeenAt = at;
        existing.lastSeenHealth = candidate.healthFactor;
        if (candidate.healthFactor < 1 && !existing.dueSince) existing.dueSince = at;
        if (candidate.healthFactor >= this.thresholds.nearMissHealth) {
          // rose above the near-miss band — release silently (hot loop emits healed/taken)
          this.tracked.delete(candidate.obligation);
        } else if (candidate.healthFactor < 1 && !wasDue) {
          events.push({ type: "promoted", at, candidate, fromHealth: existing.lastSeenHealth });
        }
      }
    }
    this.trimWatchTier(at);
    return events;
  }

  /**
   * Apply a hot tick: refresh of all hotObligations. Emits promoted on crossing,
   * taken when an obligation disappears (liquidated/closed), healed when it rises
   * above the near-miss band. Unknown addresses are ignored.
   */
  applyHotUpdate(updates: LiquidatableCandidate[], at: string): TrackerEvent[] {
    const events: TrackerEvent[] = [];
    const byAddress = new Map(updates.map((candidate) => [candidate.obligation, candidate]));
    for (const candidate of updates) {
      const existing = this.tracked.get(candidate.obligation);
      if (!existing) continue;
      const wasDue = existing.lastSeenHealth < 1;
      if (candidate.healthFactor < 1) {
        if (!wasDue) {
          events.push({ type: "promoted", at, candidate, fromHealth: existing.lastSeenHealth });
        }
        if (!existing.dueSince) existing.dueSince = at;
        existing.candidate = candidate;
        existing.lastSeenAt = at;
        existing.lastSeenHealth = candidate.healthFactor;
        existing.consecutiveAboveBand = 0;
      } else if (candidate.healthFactor >= this.thresholds.nearMissHealth) {
        // rose above the near-miss band while still being tracked — borrower healed it
        events.push({
          type: "healed",
          at,
          obligation: candidate.obligation,
          lastHealth: candidate.healthFactor,
        });
        this.tracked.delete(candidate.obligation);
      } else if (candidate.healthFactor >= this.thresholds.watchHealth) {
        // Hysteresis: a single tick above the watch band is boundary noise (health bouncing
        // around the band edge) — only release after consecutive ticks clearly outside.
        existing.consecutiveAboveBand = (existing.consecutiveAboveBand ?? 0) + 1;
        if (existing.consecutiveAboveBand >= 2) {
          events.push({
            type: "taken",
            at,
            obligation: candidate.obligation,
            firstSpottedAt: existing.firstSpottedAt,
            satSeconds: Math.max(0, Math.round((Date.parse(at) - Date.parse(existing.firstSpottedAt)) / 1000)),
            wasDue,
            dueSince: existing.dueSince,
          });
          this.tracked.delete(candidate.obligation);
        } else {
          existing.candidate = candidate;
          existing.lastSeenAt = at;
          existing.lastSeenHealth = candidate.healthFactor;
        }
      } else {
        existing.candidate = candidate;
        existing.lastSeenAt = at;
        existing.lastSeenHealth = candidate.healthFactor;
        existing.consecutiveAboveBand = 0;
      }
    }
    for (const [obligation, entry] of [...this.tracked.entries()]) {
      if (!byAddress.has(obligation)) {
        events.push({
          type: "taken",
          at,
          obligation,
          firstSpottedAt: entry.firstSpottedAt,
          satSeconds: Math.max(0, Math.round((Date.parse(at) - Date.parse(entry.firstSpottedAt)) / 1000)),
          wasDue: entry.lastSeenHealth < 1,
          dueSince: entry.dueSince,
        });
        this.tracked.delete(obligation);
      }
    }
    return events;
  }

  /** Optional pruning of watch-tier entries that drifted above the near-miss band. */
  pruneWatchTier(): TrackerEvent[] {
    const events: TrackerEvent[] = [];
    const now = new Date().toISOString();
    for (const [obligation, entry] of [...this.tracked.entries()]) {
      if (entry.lastSeenHealth >= 1 && entry.lastSeenHealth >= this.thresholds.nearMissHealth) {
        this.tracked.delete(obligation);
      }
    }
    return events;
  }
}
