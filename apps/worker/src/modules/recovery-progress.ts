export type RecoveryProgressDecision = {
  progressPage: number;
  progressed: boolean;
  consecutiveNoProgress: number;
  noProgressReason: string | null;
  retryDelayMs: number;
};

export function decideRecoveryProgress(input: {
  currentProgressPage?: number | null;
  attemptedProgressPage?: number | null;
  currentConsecutiveNoProgress: number;
  noProgressReason?: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}): RecoveryProgressDecision {
  const current = Math.max(1, Math.trunc(input.currentProgressPage ?? 1));
  const attempted = Math.max(1, Math.trunc(input.attemptedProgressPage ?? current));
  const progressPage = Math.max(current, attempted);
  const progressed = progressPage > current;
  const consecutiveNoProgress = progressed
    ? 0
    : Math.max(0, Math.trunc(input.currentConsecutiveNoProgress)) + 1;
  const base = Math.max(1_000, Math.trunc(input.baseBackoffMs ?? 5_000));
  const cap = Math.max(base, Math.trunc(input.maxBackoffMs ?? 300_000));
  const noProgressReason = progressed ? null : input.noProgressReason?.trim() || "NO_PROGRESS_UNSPECIFIED";
  return {
    progressPage,
    progressed,
    consecutiveNoProgress,
    noProgressReason,
    retryDelayMs: progressed
      ? 1_000
      // Slot contention makes no origin request. Exponential delays can stay
      // aligned with realtime scans indefinitely and starve the recovery lane.
      : noProgressReason === "BACKGROUND_SLOT_UNAVAILABLE"
        ? base
        : Math.min(cap, base * (2 ** Math.min(10, consecutiveNoProgress - 1))),
  };
}
