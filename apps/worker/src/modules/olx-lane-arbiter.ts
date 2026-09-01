type ArbiterDependencies = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Realtime never waits for backfill. Backfill yields between pages while a
 * realtime scan is active and leaves a short quiet window after it completes.
 * This limits request bursts without adding latency to the four-second lane.
 */
export class OlxLaneArbiter {
  private activeRealtimeScans = 0;
  private lastRealtimeFinishedAt = 0;
  private lastReservedBackfillEpoch = -1;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(dependencies: ArbiterDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async runRealtime<T>(operation: () => Promise<T>): Promise<T> {
    this.activeRealtimeScans += 1;
    try {
      return await operation();
    } finally {
      this.activeRealtimeScans = Math.max(0, this.activeRealtimeScans - 1);
      this.lastRealtimeFinishedAt = this.now();
    }
  }

  async waitForBackfillWindow(deadlineAt: Date, quietMs: number): Promise<boolean> {
    const deadline = deadlineAt.getTime();
    const quiet = Math.max(0, quietMs);
    while (this.now() < deadline) {
      const remainingQuiet = Math.max(0, this.lastRealtimeFinishedAt + quiet - this.now());
      if (
        this.activeRealtimeScans === 0
        && remainingQuiet === 0
        && this.lastReservedBackfillEpoch !== this.lastRealtimeFinishedAt
      ) {
        // Reserve at most one deep page between two realtime completions. This
        // prevents a multi-page backfill burst from consuming the whole
        // four-second request window and triggering protection.
        this.lastReservedBackfillEpoch = this.lastRealtimeFinishedAt;
        return true;
      }
      await this.sleep(Math.max(10, Math.min(100, remainingQuiet || 50)));
    }
    return false;
  }
}

export const olxLaneArbiter = new OlxLaneArbiter();
