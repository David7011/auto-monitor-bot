import { Prisma, prisma } from "@amb/db";
import { QUEUE_NAMES } from "@amb/shared";
import { env } from "../../env.js";
import { getQueue } from "../../lib/queues.js";
import {
  decideOlxCadenceCanary,
  type OlxCadenceCanaryDecision,
} from "./olx-cadence-canary-policy.js";
import {
  buildOlxCadenceExperimentDescriptor,
  isSameOlxCadenceExperiment,
} from "./olx-cadence-experiment.js";

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
  const exactBaselineConfigured = input.baseIntervalSeconds === env.LIVE_OLX_INTERVAL_SECONDS
    && input.baseJitterSeconds === env.LIVE_OLX_JITTER_SECONDS;
  const experiment = buildOlxCadenceExperimentDescriptor({
    codeRevision: process.env.AMB_CODE_REVISION,
    startedAt: input.now,
    config: {
      owner: env.OLX_EXPERIMENT_OWNER,
      enabled: env.OLX_CADENCE_CANARY_ENABLED
        && env.OLX_EXPERIMENT_OWNER === "cadence"
        && exactBaselineConfigured,
      baseIntervalSeconds: input.baseIntervalSeconds,
      baseJitterSeconds: input.baseJitterSeconds,
      canaryIntervalSeconds: env.OLX_CADENCE_CANARY_INTERVAL_SECONDS,
      canaryJitterSeconds: env.OLX_CADENCE_CANARY_JITTER_SECONDS,
      qualificationRuns: env.OLX_CADENCE_CANARY_QUALIFICATION_RUNS,
      promotionRuns: env.OLX_CADENCE_CANARY_PROMOTION_RUNS,
      hotPathMinimumSamples: env.OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES,
      p95MinimumSamples: env.OLX_CADENCE_CANARY_P95_MIN_SAMPLES,
      p99MinimumSamples: env.OLX_CADENCE_CANARY_P99_MIN_SAMPLES,
      qualificationMaximumP95Ms: env.OLX_CADENCE_CANARY_QUALIFICATION_MAX_P95_MS,
      maximumP95Ms: env.OLX_CADENCE_CANARY_MAX_P95_MS,
      p95GrowthPercent: env.OLX_CADENCE_CANARY_P95_GROWTH_PERCENT,
      queueDepthLimit: env.OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT,
    },
  });
  const experimentChanged = !isSameOlxCadenceExperiment({
    experimentId: state.olxCanaryExperimentId,
    codeRevision: state.olxCanaryCodeRevision,
    configHash: state.olxCanaryConfigHash,
  }, experiment);
  const policyState = experimentChanged
    ? {
        mode: "BASELINE" as const,
        qualificationStartedAt: input.now,
        canaryStartedAt: null,
        baselineP95Ms: null,
        rollbackReason: null,
      }
    : {
        mode: state.olxCanaryMode,
        qualificationStartedAt: state.olxCanaryQualificationStartedAt,
        canaryStartedAt: state.olxCanaryStartedAt,
        baselineP95Ms: state.olxCanaryBaselineP95Ms,
        rollbackReason: state.olxCanaryRollbackReason,
      };
  const earliestEvidenceAt = policyState.canaryStartedAt && policyState.canaryStartedAt < policyState.qualificationStartedAt
    ? policyState.canaryStartedAt
    : policyState.qualificationStartedAt;
  const evidenceLimit = Math.max(
    env.OLX_CADENCE_CANARY_QUALIFICATION_RUNS,
    env.OLX_CADENCE_CANARY_PROMOTION_RUNS,
    env.OLX_CADENCE_CANARY_P95_MIN_SAMPLES,
  ) + 10;
  const [runs, hotPathSamples, queueOverflow] = await Promise.all([
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
    prisma.sourceSeenListing.findMany({
      where: {
        source: "OLX",
        discoveryLane: "REALTIME",
        firstSeenAt: { gte: policyState.qualificationStartedAt },
        requestStartedAt: { not: null },
        firstByteAt: { not: null },
        bodyReceivedAt: { not: null },
        parsedAt: { not: null },
        hotCandidateAt: { not: null },
        journalPersistedAt: { not: null },
        telegramRequestedAt: { not: null },
        telegramAcceptedAt: { not: null },
      },
      orderBy: { firstSeenAt: "desc" },
      take: Math.max(
        env.OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES,
        env.OLX_CADENCE_CANARY_P99_MIN_SAMPLES,
      ),
      select: { id: true },
    }),
    hotPathQueueOverflow(env.OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT),
  ]);
  const hotPathSampleCount = hotPathSamples.length;
  const decision = decideOlxCadenceCanary({
    state: policyState,
    config: {
      enabled: env.OLX_CADENCE_CANARY_ENABLED
        && env.OLX_EXPERIMENT_OWNER === "cadence"
        && exactBaselineConfigured,
      qualificationRuns: env.OLX_CADENCE_CANARY_QUALIFICATION_RUNS,
      promotionRuns: env.OLX_CADENCE_CANARY_PROMOTION_RUNS,
      hotPathMinimumSamples: env.OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES,
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
    hotPathSampleCount,
    protectionActive: input.protectionActive,
    queueOverflow,
    now: input.now,
  });

  if (
    experimentChanged
    || state.olxCanaryMode !== decision.mode
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
        olxCanaryExperimentId: experimentChanged ? experiment.experimentId : state.olxCanaryExperimentId,
        olxCanaryCodeRevision: experiment.codeRevision,
        olxCanaryConfigHash: experiment.configHash,
        olxCanaryConfigSnapshot: experiment.configSnapshot as Prisma.InputJsonValue,
        ...(experimentChanged || decision.transition !== "NONE" ? { olxCanaryLastTransitionAt: input.now } : {}),
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
