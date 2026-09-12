export type MetricSummary = {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type QualifiedMetricSummary = {
  count: number;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  status: "READY" | "INSUFFICIENT_DATA";
  minimumSamples: { p50: number; p95: number; p99: number };
  ready: { p50: boolean; p95: boolean; p99: boolean };
};

export const LATENCY_PERCENTILE_MIN_SAMPLES = Object.freeze({ p50: 5, p95: 30, p99: 100 });

export type LatencyRegressionDecision = {
  status: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
  baselineP95Ms: number | null;
  candidateP95Ms: number | null;
  maximumCandidateP95Ms: number | null;
  reason: string;
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
  bodyReceivedAt?: Date | null;
  parsedAt?: Date | null;
  hotCandidateAt?: Date | null;
  journalPersistedAt?: Date | null;
  filterCompletedAt?: Date | null;
  dispatchAttemptedAt?: Date | null;
  telegramRequestedAt?: Date | null;
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
  firstByteToBodyReceivedMs: MetricSummary;
  bodyReceivedToParsedMs: MetricSummary;
  parsedToHotCandidateMs: MetricSummary;
  firstByteToHotCandidateMs: MetricSummary;
  hotCandidateToDurableJournalMs: MetricSummary;
  hotCandidateToTelegramAcceptanceMs: MetricSummary;
  durableJournalToFilterCompletedMs: MetricSummary;
  durableJournalToTelegramRequestMs: MetricSummary;
  filterCompletedToTelegramRequestMs: MetricSummary;
  dispatchAttemptedToTelegramRequestMs: MetricSummary;
  telegramRequestToTelegramAcceptanceMs: MetricSummary;
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
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
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
    p99: percentile(sorted, 0.99),
  };
}

/**
 * Hides unstable tail percentiles until their explicit evidence threshold is
 * met. The raw summary remains available for diagnostics, but user-facing SLO
 * surfaces must not present a p95/p99 calculated from a handful of samples.
 */
export function qualifyMetricSummary(
  summary: MetricSummary,
  minimumSamples = LATENCY_PERCENTILE_MIN_SAMPLES,
): QualifiedMetricSummary {
  const ready = {
    p50: summary.count >= minimumSamples.p50,
    p95: summary.count >= minimumSamples.p95,
    p99: summary.count >= minimumSamples.p99,
  };
  return {
    count: summary.count,
    max: summary.max,
    p50: ready.p50 ? summary.p50 : null,
    p95: ready.p95 ? summary.p95 : null,
    p99: ready.p99 ? summary.p99 : null,
    status: ready.p95 ? "READY" : "INSUFFICIENT_DATA",
    minimumSamples: { ...minimumSamples },
    ready,
  };
}

export function evaluateLatencyRegression(input: {
  baseline: MetricSummary;
  candidate: MetricSummary;
  minimumSamples?: number;
  maximumGrowthRatio: number;
}): LatencyRegressionDecision {
  const minimumSamples = Math.max(1, Math.trunc(input.minimumSamples ?? LATENCY_PERCENTILE_MIN_SAMPLES.p95));
  if (input.baseline.count < minimumSamples || input.candidate.count < minimumSamples
    || input.baseline.p95 == null || input.candidate.p95 == null) {
    return {
      status: "INSUFFICIENT_DATA",
      baselineP95Ms: input.baseline.p95,
      candidateP95Ms: input.candidate.p95,
      maximumCandidateP95Ms: null,
      reason: `p95 comparison requires ${minimumSamples} samples in both cohorts`,
    };
  }
  const maximumCandidateP95Ms = Math.round(input.baseline.p95 * Math.max(1, input.maximumGrowthRatio));
  const passed = input.candidate.p95 <= maximumCandidateP95Ms;
  return {
    status: passed ? "PASS" : "FAIL",
    baselineP95Ms: input.baseline.p95,
    candidateP95Ms: input.candidate.p95,
    maximumCandidateP95Ms,
    reason: passed
      ? "candidate p95 remains within the evidence-based growth limit"
      : "candidate p95 exceeds the evidence-based growth limit",
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
  const firstByteToBodyReceived: number[] = [];
  const bodyReceivedToParsed: number[] = [];
  const parsedToHotCandidate: number[] = [];
  const firstByteToHotCandidate: number[] = [];
  const hotCandidateToDurableJournal: number[] = [];
  const hotCandidateToTelegramAcceptance: number[] = [];
  const durableJournalToFilterCompleted: number[] = [];
  const durableJournalToTelegramRequest: number[] = [];
  const filterCompletedToTelegramRequest: number[] = [];
  const dispatchAttemptedToTelegramRequest: number[] = [];
  const telegramRequestToTelegramAcceptance: number[] = [];
  const durableJournalToTelegramAcceptance: number[] = [];
  const requestStartToTelegramAcceptance: number[] = [];

  for (const sample of samples) {
    pushDuration(requestStartToFirstByte, sample.requestStartedAt, sample.firstByteAt);
    pushDuration(firstByteToBodyReceived, sample.firstByteAt, sample.bodyReceivedAt);
    pushDuration(bodyReceivedToParsed, sample.bodyReceivedAt, sample.parsedAt);
    pushDuration(parsedToHotCandidate, sample.parsedAt, sample.hotCandidateAt);
    pushDuration(firstByteToHotCandidate, sample.firstByteAt, sample.hotCandidateAt);
    pushDuration(hotCandidateToDurableJournal, sample.hotCandidateAt, sample.journalPersistedAt);
    pushDuration(hotCandidateToTelegramAcceptance, sample.hotCandidateAt, sample.telegramAcceptedAt);
    pushDuration(durableJournalToFilterCompleted, sample.journalPersistedAt, sample.filterCompletedAt);
    pushDuration(durableJournalToTelegramRequest, sample.journalPersistedAt, sample.telegramRequestedAt);
    pushDuration(filterCompletedToTelegramRequest, sample.filterCompletedAt, sample.telegramRequestedAt);
    pushDuration(dispatchAttemptedToTelegramRequest, sample.dispatchAttemptedAt, sample.telegramRequestedAt);
    pushDuration(telegramRequestToTelegramAcceptance, sample.telegramRequestedAt, sample.telegramAcceptedAt);
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
    firstByteToBodyReceivedMs: summarizeMetric(firstByteToBodyReceived),
    bodyReceivedToParsedMs: summarizeMetric(bodyReceivedToParsed),
    parsedToHotCandidateMs: summarizeMetric(parsedToHotCandidate),
    firstByteToHotCandidateMs: summarizeMetric(firstByteToHotCandidate),
    hotCandidateToDurableJournalMs: summarizeMetric(hotCandidateToDurableJournal),
    hotCandidateToTelegramAcceptanceMs: summarizeMetric(hotCandidateToTelegramAcceptance),
    durableJournalToFilterCompletedMs: summarizeMetric(durableJournalToFilterCompleted),
    durableJournalToTelegramRequestMs: summarizeMetric(durableJournalToTelegramRequest),
    filterCompletedToTelegramRequestMs: summarizeMetric(filterCompletedToTelegramRequest),
    dispatchAttemptedToTelegramRequestMs: summarizeMetric(dispatchAttemptedToTelegramRequest),
    telegramRequestToTelegramAcceptanceMs: summarizeMetric(telegramRequestToTelegramAcceptance),
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
