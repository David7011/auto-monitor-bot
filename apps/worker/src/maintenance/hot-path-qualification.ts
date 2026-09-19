import { LATENCY_PERCENTILE_MIN_SAMPLES } from "@amb/shared";

export function selectQualificationSamples<T extends { firstSeenAt: Date }>(
  samples: T[],
  qualificationStartedAt: Date | null | undefined,
): T[] {
  if (!qualificationStartedAt) return [];
  return samples.filter((sample) => sample.firstSeenAt >= qualificationStartedAt);
}

export function qualificationEvidence(sampleCount: number) {
  const p99SamplesRequired = LATENCY_PERCENTILE_MIN_SAMPLES.p99;
  return {
    completeAcceptedSamples: sampleCount,
    p99SamplesRequired,
    p99SamplesRemaining: Math.max(0, p99SamplesRequired - sampleCount),
    p99Ready: sampleCount >= p99SamplesRequired,
  };
}
