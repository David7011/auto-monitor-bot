export type MetricSummary = {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
};

export const TELEGRAM_LATENCY_TARGET_MS = 3_000;
export const TELEGRAM_LATENCY_MIN_SAMPLE_SIZE = 30;
export const STARTUP_CATCH_UP_WINDOW_MS = 2 * 60 * 1000;

export type JournalLatencySample = {
  source: string;
  publishedAt: Date | null;
  firstSeenAt: Date;
  notifiedAt: Date | null;
  requestStartedAt?: Date | null;
  firstByteAt?: Date | null;
  hotCandidateAt?: Date | null;
  journalPersistedAt?: Date | null;
  telegramAcceptedAt?: Date | null;
  timestampConfidence: string;
};

export type JournalLatencySummary = {
  /** Source-reported publication timestamp to the first persisted observation. */
  publicationTimestampToFirstSeenMs: MetricSummary;
  /** First persisted observation to a confirmed Telegram send. */
  firstSeenToTelegramMs: MetricSummary;
  /** Source-reported publication timestamp to a confirmed Telegram send. */
  publicationTimestampToTelegramMs: MetricSummary;
  requestStartToFirstByteMs: MetricSummary;
  firstByteToHotCandidateMs: MetricSummary;
  hotCandidateToDurableJournalMs: MetricSummary;
  durableJournalToTelegramAcceptanceMs: MetricSummary;
  requestStartToTelegramAcceptanceMs: MetricSummary;
};

const PRECISE_TIMESTAMP_CONFIDENCE = new Set(["HIGH", "MEDIUM"]);

export function groupCount<T extends Record<string, unknown>>(
  groups: Array<T & { _count: { _all: number } }>,
  field: keyof T,
  value: string,
): number {
  return groups.find((group) => group[field] === value)?._count._all ?? 0;
}

export function summarizeMetric(values: number[]): MetricSummary {
  if (values.length === 0) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Summarizes latency stages from the durable observation journal. Publication
 * based stages intentionally exclude LOW/UNKNOWN timestamps because those are
 * source estimates rather than sufficiently precise publication times.
 */
export function summarizeJournalLatencies(samples: JournalLatencySample[]): JournalLatencySummary {
  const publicationTimestampToFirstSeen: number[] = [];
  const firstSeenToTelegram: number[] = [];
  const publicationTimestampToTelegram: number[] = [];
  const requestStartToFirstByte: number[] = [];
  const firstByteToHotCandidate: number[] = [];
  const hotCandidateToDurableJournal: number[] = [];
  const durableJournalToTelegramAcceptance: number[] = [];
  const requestStartToTelegramAcceptance: number[] = [];

  for (const sample of samples) {
    pushDuration(requestStartToFirstByte, sample.requestStartedAt, sample.firstByteAt);
    pushDuration(firstByteToHotCandidate, sample.firstByteAt, sample.hotCandidateAt);
    pushDuration(hotCandidateToDurableJournal, sample.hotCandidateAt, sample.journalPersistedAt);
    pushDuration(durableJournalToTelegramAcceptance, sample.journalPersistedAt, sample.telegramAcceptedAt);
    pushDuration(requestStartToTelegramAcceptance, sample.requestStartedAt, sample.telegramAcceptedAt);
    const firstSeenToNotification = durationMs(sample.firstSeenAt, sample.notifiedAt);
    if (firstSeenToNotification != null) firstSeenToTelegram.push(firstSeenToNotification);

    if (!PRECISE_TIMESTAMP_CONFIDENCE.has(sample.timestampConfidence)) continue;
    const publicationToFirstSeen = durationMs(sample.publishedAt, sample.firstSeenAt);
    if (publicationToFirstSeen == null) continue;
    publicationTimestampToFirstSeen.push(publicationToFirstSeen);

    const publicationToNotification = durationMs(sample.publishedAt, sample.notifiedAt);
    if (publicationToNotification != null) publicationTimestampToTelegram.push(publicationToNotification);
  }

  return {
    publicationTimestampToFirstSeenMs: summarizeMetric(publicationTimestampToFirstSeen),
    firstSeenToTelegramMs: summarizeMetric(firstSeenToTelegram),
    publicationTimestampToTelegramMs: summarizeMetric(publicationTimestampToTelegram),
    requestStartToFirstByteMs: summarizeMetric(requestStartToFirstByte),
    firstByteToHotCandidateMs: summarizeMetric(firstByteToHotCandidate),
    hotCandidateToDurableJournalMs: summarizeMetric(hotCandidateToDurableJournal),
    durableJournalToTelegramAcceptanceMs: summarizeMetric(durableJournalToTelegramAcceptance),
    requestStartToTelegramAcceptanceMs: summarizeMetric(requestStartToTelegramAcceptance),
  };
}

export function splitSessionJournalLatencies(
  samples: JournalLatencySample[],
  sessionStartedAt: Date,
  catchUpWindowMs = STARTUP_CATCH_UP_WINDOW_MS,
): {
  catchUp: JournalLatencySummary & { observations: number };
  steadyState: JournalLatencySummary & { observations: number };
} {
  const startedAtMs = sessionStartedAt.getTime();
  const catchUpUntilMs = startedAtMs + Math.max(0, catchUpWindowMs);
  const currentSession = samples.filter((sample) => sample.firstSeenAt.getTime() >= startedAtMs);
  const catchUp = currentSession.filter((sample) => sample.firstSeenAt.getTime() <= catchUpUntilMs);
  const steadyState = currentSession.filter((sample) => sample.firstSeenAt.getTime() > catchUpUntilMs);
  return {
    catchUp: { observations: catchUp.length, ...summarizeJournalLatencies(catchUp) },
    steadyState: { observations: steadyState.length, ...summarizeJournalLatencies(steadyState) },
  };
}

export function percentile(sorted: number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] ?? 0;
}

function durationMs(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const value = end.getTime() - start.getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function pushDuration(
  target: number[],
  start: Date | null | undefined,
  end: Date | null | undefined,
): void {
  const duration = durationMs(start ?? null, end ?? null);
  if (duration != null) target.push(duration);
}
