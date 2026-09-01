import { prisma } from "@amb/db";
import { QUEUE_NAMES } from "@amb/shared";
import { env } from "../../env.js";
import { getQueue } from "../../lib/queues.js";
import {
  decideOlxCadenceCanary,
  type OlxCadenceCanaryDecision,
} from "./olx-cadence-canary-policy.js";

const PRESSURE_QUEUES = [
  QUEUE_NAMES.COLLECTOR_RUN,
  QUEUE_NAMES.LISTING_DETECTED,
  QUEUE_NAMES.TELEGRAM_FLASH,
  QUEUE_NAMES.TELEGRAM_SEND,
] as const;

export async function evaluateOlxCadenceCanary(input: {
  baseIntervalSeconds: number;
  baseJitterSeconds: number;
  protectionActive: boolean;
  now: Date;
}): Promise<OlxCadenceCanaryDecision> {
  const state = await prisma.monitoringState.findUniqueOrThrow({ where: { id: "singleton" } });
  const earliestEvidenceAt = state.olxCanaryStartedAt && state.olxCanaryStartedAt < state.olxCanaryQualificationStartedAt
    ? state.olxCanaryStartedAt
    : state.olxCanaryQualificationStartedAt;
  const evidenceLimit = Math.max(
    env.OLX_CADENCE_CANARY_QUALIFICATION_RUNS,
    env.OLX_CADENCE_CANARY_PROMOTION_RUNS,
    env.OLX_CADENCE_CANARY_P95_MIN_SAMPLES,
  ) + 10;
  const [runs, queueOverflow] = await Promise.all([
    prisma.collectorRun.findMany({
      where: {
        source: "OLX",
        lane: "REALTIME",
        finishedAt: { not: null },
        startedAt: { gte: earliestEvidenceAt },
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: evidenceLimit,
      select: {
        id: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        recoveredCount: true,
        semanticWarnings: true,
        errorMessage: true,
      },
    }),
    hotPathQueueOverflow(env.OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT),
  ]);
  const exactBaselineConfigured = input.baseIntervalSeconds === env.LIVE_OLX_INTERVAL_SECONDS
    && input.baseJitterSeconds === env.LIVE_OLX_JITTER_SECONDS;
  const decision = decideOlxCadenceCanary({
    state: {
      mode: state.olxCanaryMode,
      qualificationStartedAt: state.olxCanaryQualificationStartedAt,
      canaryStartedAt: state.olxCanaryStartedAt,
      baselineP95Ms: state.olxCanaryBaselineP95Ms,
      rollbackReason: state.olxCanaryRollbackReason,
    },
    config: {
      enabled: env.OLX_CADENCE_CANARY_ENABLED && exactBaselineConfigured,
      qualificationRuns: env.OLX_CADENCE_CANARY_QUALIFICATION_RUNS,
      promotionRuns: env.OLX_CADENCE_CANARY_PROMOTION_RUNS,
      p95MinimumSamples: env.OLX_CADENCE_CANARY_P95_MIN_SAMPLES,
      qualificationMaximumP95Ms: env.OLX_CADENCE_CANARY_QUALIFICATION_MAX_P95_MS,
      maximumP95Ms: env.OLX_CADENCE_CANARY_MAX_P95_MS,
      p95GrowthRatio: env.OLX_CADENCE_CANARY_P95_GROWTH_PERCENT / 100,
      baseIntervalSeconds: input.baseIntervalSeconds,
      baseJitterSeconds: input.baseJitterSeconds,
      canaryIntervalSeconds: env.OLX_CADENCE_CANARY_INTERVAL_SECONDS,
      canaryJitterSeconds: env.OLX_CADENCE_CANARY_JITTER_SECONDS,
    },
    runs,
    protectionActive: input.protectionActive,
    queueOverflow,
    now: input.now,
  });

  if (
    state.olxCanaryMode !== decision.mode
    || state.olxCanaryQualificationStartedAt.getTime() !== decision.qualificationStartedAt.getTime()
    || nullableDateMs(state.olxCanaryStartedAt) !== nullableDateMs(decision.canaryStartedAt)
    || state.olxCanaryBaselineP95Ms !== decision.baselineP95Ms
    || state.olxCanaryCurrentP95Ms !== decision.currentP95Ms
    || state.olxCanaryCleanRunCount !== decision.cleanRunCount
    || state.olxCanaryRunCount !== decision.canaryRunCount
    || state.olxCanaryRollbackReason !== decision.rollbackReason
    || state.olxCanaryLastEvaluatedRunId !== decision.lastEvaluatedRunId
  ) {
    await prisma.monitoringState.update({
      where: { id: "singleton" },
      data: {
        olxCanaryMode: decision.mode,
        olxCanaryQualificationStartedAt: decision.qualificationStartedAt,
        olxCanaryStartedAt: decision.canaryStartedAt,
        olxCanaryBaselineP95Ms: decision.baselineP95Ms,
        olxCanaryCurrentP95Ms: decision.currentP95Ms,
        olxCanaryCleanRunCount: decision.cleanRunCount,
        olxCanaryRunCount: decision.canaryRunCount,
        olxCanaryRollbackReason: decision.rollbackReason,
        olxCanaryLastEvaluatedRunId: decision.lastEvaluatedRunId,
        ...(decision.transition !== "NONE" ? { olxCanaryLastTransitionAt: input.now } : {}),
      },
    });
  }
  return decision;
}

function nullableDateMs(value: Date | null): number | null {
  return value?.getTime() ?? null;
}

async function hotPathQueueOverflow(limit: number): Promise<boolean> {
  try {
    const depths = await Promise.all(PRESSURE_QUEUES.map(async (name) => {
      const counts = await getQueue(name).getJobCounts("waiting", "active", "prioritized");
      return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0);
    }));
    return depths.some((depth) => depth > limit);
  } catch {
    // Unknown queue health is not evidence that acceleration is safe.
    return true;
  }
}
