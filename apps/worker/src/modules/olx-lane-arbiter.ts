type ArbiterDependencies = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Realtime never waits for backfill. Backfill yields between pages while a
 * realtime scan is active and leaves a short quiet window after it completes.
 * This limits request bursts without adding latency to the configured realtime lane.
 */
export class OlxLaneArbiter {
  private activeRealtimeScans = 0;
  private lastRealtimeFinishedAt = 0;
  private lastReservedBackfillEpoch = -1;
  private readonly now: () => number;

  constructor(dependencies: ArbiterDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    // Keep the injected sleep dependency source-compatible with older tests;
    // slot admission itself is deliberately non-blocking.
    void dependencies.sleep;
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
    const now = this.now();
    if (now >= deadline) return false;
    const remainingQuiet = Math.max(0, this.lastRealtimeFinishedAt + quiet - now);
    if (
      this.activeRealtimeScans > 0
      || remainingQuiet > 0
      || this.lastReservedBackfillEpoch === this.lastRealtimeFinishedAt
    ) return false;
    // Reserve at most one deep page between two realtime completions. A
    // missing slot defers the BullMQ job instead of occupying a worker until
    // its ~90-second scan deadline.
    this.lastReservedBackfillEpoch = this.lastRealtimeFinishedAt;
    return true;
  }
}

export const olxLaneArbiter = new OlxLaneArbiter();
