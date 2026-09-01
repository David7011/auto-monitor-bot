import {
  summarizeMetric,
  TELEGRAM_LATENCY_MIN_SAMPLE_SIZE as DEFAULT_MINIMUM_SAMPLE_SIZE,
  TELEGRAM_LATENCY_TARGET_MS as DEFAULT_TARGET_MS,
  type MetricSummary,
} from "@amb/shared";

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_LATENCY_TARGET_MS = DEFAULT_TARGET_MS;
export const TELEGRAM_LATENCY_MIN_SAMPLE_SIZE = DEFAULT_MINIMUM_SAMPLE_SIZE;

export type TelegramLatencySample = {
  source: string;
  journalPersistedAt: Date;
  telegramAcceptedAt: Date;
};

export type TelegramLatencyReport = {
  generatedAt: string;
  baselineAt: string | null;
  baselineAgeHours: number | null;
  windowStartedAt: string;
  windowHours: number;
  status: "COLLECTING" | "LOW_SAMPLE" | "READY";
  windowComplete: boolean;
  sampleSize: number;
  minimumSampleSize: number;
  remainingSamples: number;
  metric: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE";
  latencyMs: MetricSummary;
  bySource: Array<{ source: string; sampleSize: number; latencyMs: MetricSummary }>;
  target: { p95Ms: number; passed: boolean | null };
};

export function createTelegramLatencyReport(input: {
  samples: TelegramLatencySample[];
  now?: Date;
  baselineAt?: Date | null;
  minimumSampleSize?: number;
}): TelegramLatencyReport {
  const now = input.now ?? new Date();
  const rollingStart = new Date(now.getTime() - WINDOW_MS);
  const baselineAt = input.baselineAt && input.baselineAt <= now ? input.baselineAt : null;
  const windowStart = baselineAt && baselineAt > rollingStart ? baselineAt : rollingStart;
  const baselineAgeMs = baselineAt ? Math.max(0, now.getTime() - baselineAt.getTime()) : null;
  const windowComplete = baselineAgeMs != null && baselineAgeMs >= WINDOW_MS;
  const minimumSampleSize = positiveInteger(input.minimumSampleSize, TELEGRAM_LATENCY_MIN_SAMPLE_SIZE);
  const valid = input.samples.filter((sample) => {
    const latency = sample.telegramAcceptedAt.getTime() - sample.journalPersistedAt.getTime();
    return sample.journalPersistedAt >= windowStart
      && sample.journalPersistedAt <= now
      && sample.telegramAcceptedAt <= now
      && Number.isFinite(latency)
      && latency >= 0;
  });
  const latencies = valid.map((sample) => sample.telegramAcceptedAt.getTime() - sample.journalPersistedAt.getTime());
  const latencyMs = summarizeMetric(latencies);
  const sources = [...new Set(valid.map((sample) => sample.source))].sort();
  const bySource = sources.map((source) => {
    const sourceValues = valid
      .filter((sample) => sample.source === source)
      .map((sample) => sample.telegramAcceptedAt.getTime() - sample.journalPersistedAt.getTime());
    return { source, sampleSize: sourceValues.length, latencyMs: summarizeMetric(sourceValues) };
  });
  const enoughSamples = valid.length >= minimumSampleSize;
  const status: TelegramLatencyReport["status"] = !windowComplete
    ? "COLLECTING"
    : enoughSamples ? "READY" : "LOW_SAMPLE";

  return {
    generatedAt: now.toISOString(),
    baselineAt: baselineAt?.toISOString() ?? null,
    baselineAgeHours: baselineAgeMs == null ? null : Number((baselineAgeMs / 3_600_000).toFixed(2)),
    windowStartedAt: windowStart.toISOString(),
    windowHours: Number(((now.getTime() - windowStart.getTime()) / 3_600_000).toFixed(2)),
    status,
    windowComplete,
    sampleSize: valid.length,
    minimumSampleSize,
    remainingSamples: Math.max(0, minimumSampleSize - valid.length),
    metric: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE",
    latencyMs,
    bySource,
    target: {
      p95Ms: TELEGRAM_LATENCY_TARGET_MS,
      passed: status === "READY" && latencyMs.p95 != null ? latencyMs.p95 <= TELEGRAM_LATENCY_TARGET_MS : null,
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}
