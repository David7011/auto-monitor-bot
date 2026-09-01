import type { FastifyInstance } from "fastify";
import { Prisma, prisma } from "@amb/db";
import {
  groupCount,
  startOfTodayInKyiv,
  STARTUP_CATCH_UP_WINDOW_MS,
  splitSessionJournalLatencies,
  summarizeJournalLatencies,
  summarizeMetric,
  TELEGRAM_LATENCY_MIN_SAMPLE_SIZE,
  type MetricsResponse,
} from "@amb/shared";
import { apiStartedAt } from "../lib/runtime-lifecycle.js";

export async function systemMetricsRoute(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async () => {
    const generatedAt = new Date();
    const latencyWindowStartedAt = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
    const todayStartedAt = startOfTodayInKyiv();
    const [
      runs,
      latencyObservations,
      dailyListings,
      dailyNotifications,
      dailyRuns,
      sourceHealth,
      dailyObservations,
      latestAudit,
      firstOlxSuccessThisSession,
    ] = await Promise.all([
      prisma.collectorRun.findMany({
        where: { finishedAt: { not: null } },
        orderBy: { startedAt: "desc" },
        take: 100,
        select: {
          source: true,
          lane: true,
          startedAt: true,
          finishedAt: true,
          foundCount: true,
          newCount: true,
          recoveredCount: true,
          pageCount: true,
          requestCount: true,
          observedCount: true,
          matchedCount: true,
          rejectedCount: true,
          duplicateCount: true,
          dispatchedCount: true,
          status: true,
        },
      }),
      prisma.sourceSeenListing.findMany({
        where: {
          discoveryLane: "REALTIME",
          firstSeenAt: { gte: latencyWindowStartedAt, lte: generatedAt },
        },
        orderBy: { firstSeenAt: "asc" },
        select: {
          source: true,
          publishedAt: true,
          firstSeenAt: true,
          notifiedAt: true,
          requestStartedAt: true,
          firstByteAt: true,
          hotCandidateAt: true,
          journalPersistedAt: true,
          telegramAcceptedAt: true,
          timestampConfidence: true,
        },
      }),
      prisma.listing.groupBy({
        by: ["discoveryLane"],
        where: { firstSeenAt: { gte: todayStartedAt } },
        _count: { _all: true },
      }),
      prisma.telegramNotification.groupBy({
        by: ["status"],
        where: { createdAt: { gte: todayStartedAt } },
        _count: { _all: true },
      }),
      prisma.collectorRun.groupBy({
        by: ["lane"],
        where: { startedAt: { gte: todayStartedAt } },
        _count: { _all: true },
        _sum: {
          foundCount: true,
          newCount: true,
          recoveredCount: true,
          pageCount: true,
          requestCount: true,
          observedCount: true,
          matchedCount: true,
          rejectedCount: true,
          duplicateCount: true,
          dispatchedCount: true,
        },
      }),
      prisma.source.findMany({
        where: { enabled: true },
        orderBy: { source: "asc" },
        select: {
          source: true,
          name: true,
          status: true,
          healthScore: true,
          consecutiveErrors: true,
          consecutiveEmptyResults: true,
          lastSuccessfulAt: true,
          lastNonEmptyAt: true,
          lastDurationMs: true,
          lastError: true,
        },
      }),
      prisma.sourceSeenListing.groupBy({
        by: ["decision"],
        where: {
          normalizedData: { not: Prisma.JsonNull },
          OR: [{ publishedAt: { gte: todayStartedAt } }, { firstSeenAt: { gte: todayStartedAt } }],
        },
        _count: { _all: true },
      }),
      prisma.completenessAudit.findFirst({ orderBy: { startedAt: "desc" } }),
      prisma.collectorRun.findFirst({
        where: {
          source: "OLX",
          status: "SUCCESS",
          startedAt: { gte: apiStartedAt },
        },
        orderBy: { finishedAt: "asc" },
        select: { startedAt: true, finishedAt: true },
      }),
    ]);

    const collectorDurations = runs
      .map((run) => (run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null))
      .filter((value): value is number => value != null && value >= 0);

    const collectorDurationSummary = summarizeMetric(collectorDurations);
    const latencySummary = summarizeJournalLatencies(latencyObservations.map((observation) => ({
      ...observation,
      notifiedAt: observation.notifiedAt && observation.notifiedAt <= generatedAt
        ? observation.notifiedAt
        : null,
    })));
    const currentSessionLatency = splitSessionJournalLatencies(
      latencyObservations.map((observation) => ({
        ...observation,
        notifiedAt: observation.notifiedAt && observation.notifiedAt <= generatedAt
          ? observation.notifiedAt
          : null,
      })),
      apiStartedAt,
    );
    const latencyBySource = sourceHealth.map((source) => {
      const sourceRuns = runs.filter((run) => run.source === source.source);
      const sourceLatency = summarizeJournalLatencies(latencyObservations
        .filter((observation) => observation.source === source.source)
        .map((observation) => ({
          ...observation,
          notifiedAt: observation.notifiedAt && observation.notifiedAt <= generatedAt
            ? observation.notifiedAt
            : null,
        })));
      return {
        source: source.source,
        collectorDurationMs: summarizeMetric(sourceRuns
          .map((run) => run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null)
          .filter((value): value is number => value != null && value >= 0)),
        ...sourceLatency,
        publicationToDetectionMs: sourceLatency.publicationTimestampToFirstSeenMs,
        detectionToTelegramMs: sourceLatency.firstSeenToTelegramMs,
      };
    });
    const exactTelegramLatency = latencySummary.durableJournalToTelegramAcceptanceMs;
    const telegramSloReady = exactTelegramLatency.count >= TELEGRAM_LATENCY_MIN_SAMPLE_SIZE;
    const telegramSloPassed = telegramSloReady && exactTelegramLatency.p95 != null
      ? exactTelegramLatency.p95 <= 3_000
      : null;

    return {
      generatedAt: generatedAt.toISOString(),
      latencyWindow: {
        startedAt: latencyWindowStartedAt.toISOString(),
        endedAt: generatedAt.toISOString(),
        hours: 24 as const,
        basis: "SourceSeenListing.firstSeenAt" as const,
      },
      sampleSize: {
        collectorRuns: runs.length,
        realtimeObservations: latencyObservations.length,
        publicationTimestamps: latencySummary.publicationTimestampToFirstSeenMs.count,
        telegramNotifications: exactTelegramLatency.count,
      },
      collectorDurationMs: collectorDurationSummary,
      ...latencySummary,
      publicationToDetectionMs: latencySummary.publicationTimestampToFirstSeenMs,
      detectionToTelegramMs: latencySummary.firstSeenToTelegramMs,
      latencyBySource,
      totalNotificationLatencyMs: latencySummary.publicationTimestampToTelegramMs,
      latencySemantics: {
        publicationTimestampToFirstSeenMs: "SOURCE_REPORTED_PUBLICATION_TO_FIRST_PERSISTED_OBSERVATION" as const,
        firstSeenToTelegramMs: "FIRST_PERSISTED_OBSERVATION_TO_CONFIRMED_TELEGRAM_SEND" as const,
        publicationTimestampToTelegramMs: "SOURCE_REPORTED_PUBLICATION_TO_CONFIRMED_TELEGRAM_SEND" as const,
        requestStartToFirstByteMs: "SOURCE_HTTP_REQUEST_START_TO_RESPONSE_HEADERS" as const,
        firstByteToHotCandidateMs: "SOURCE_RESPONSE_HEADERS_TO_HOT_CANDIDATE" as const,
        hotCandidateToDurableJournalMs: "HOT_CANDIDATE_TO_DURABLE_JOURNAL" as const,
        durableJournalToTelegramAcceptanceMs: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE" as const,
        requestStartToTelegramAcceptanceMs: "SOURCE_HTTP_REQUEST_START_TO_TELEGRAM_ACCEPTANCE" as const,
      },
      currentSession: {
        startedAt: apiStartedAt.toISOString(),
        catchUpUntil: new Date(apiStartedAt.getTime() + STARTUP_CATCH_UP_WINDOW_MS).toISOString(),
        firstOlxSuccessAt: firstOlxSuccessThisSession?.finishedAt?.toISOString() ?? null,
        startupToFirstOlxSuccessMs: firstOlxSuccessThisSession?.finishedAt
          ? Math.max(0, firstOlxSuccessThisSession.finishedAt.getTime() - apiStartedAt.getTime())
          : null,
        catchUp: currentSessionLatency.catchUp,
        steadyState: currentSessionLatency.steadyState,
      },
      timestampConfidence: {
        preciseLatencyOnlyFor: ["HIGH", "MEDIUM"],
      },
      coverageToday: {
        realtime: groupCount(dailyListings, "discoveryLane", "REALTIME"),
        recovered: groupCount(dailyListings, "discoveryLane", "BACKFILL"),
        coverage: groupCount(dailyListings, "discoveryLane", "COVERAGE"),
        manual: groupCount(dailyListings, "discoveryLane", "MANUAL"),
        telegramSent:
          groupCount(dailyNotifications, "status", "SENT")
          + groupCount(dailyNotifications, "status", "UPDATED"),
        telegramPending:
          groupCount(dailyNotifications, "status", "PENDING")
          + groupCount(dailyNotifications, "status", "PROCESSING")
          + groupCount(dailyNotifications, "status", "RETRY_PENDING"),
        telegramFailed: groupCount(dailyNotifications, "status", "FAILED"),
        observations: dailyObservations.reduce((sum, row) => sum + row._count._all, 0),
        observationsRejected: groupCount(dailyObservations, "decision", "REJECTED"),
        observationsNotified: groupCount(dailyObservations, "decision", "NOTIFIED"),
        observationsPending:
          groupCount(dailyObservations, "decision", "PENDING")
          + groupCount(dailyObservations, "decision", "MATCHED")
          + groupCount(dailyObservations, "decision", "FAILED"),
      },
      laneRunsToday: dailyRuns.map((item) => ({
        lane: item.lane,
        runs: item._count._all,
        found: item._sum.foundCount ?? 0,
        new: item._sum.newCount ?? 0,
        recovered: item._sum.recoveredCount ?? 0,
        pages: item._sum.pageCount ?? 0,
        requests: item._sum.requestCount ?? 0,
        observed: item._sum.observedCount ?? 0,
        matched: item._sum.matchedCount ?? 0,
        rejected: item._sum.rejectedCount ?? 0,
        duplicates: item._sum.duplicateCount ?? 0,
        dispatched: item._sum.dispatchedCount ?? 0,
      })),
      latestCompletenessAudit: latestAudit,
      slo: {
        collectorP95Under2Seconds: collectorDurationSummary.p95 != null
          && collectorDurationSummary.p95 <= 2_000,
        telegramP95Under3Seconds: telegramSloPassed,
        telegramP95Metric: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE" as const,
        telegramP95Status: telegramSloPassed == null
          ? "LOW_SAMPLE"
          : telegramSloPassed
            ? "PASS"
            : "FAIL",
        telegramMinimumSampleSize: TELEGRAM_LATENCY_MIN_SAMPLE_SIZE,
        unresolvedObservationsToday:
          groupCount(dailyObservations, "decision", "PENDING")
          + groupCount(dailyObservations, "decision", "MATCHED")
          + groupCount(dailyObservations, "decision", "FAILED"),
      },
      sourceHealth,
    } satisfies MetricsResponse<Date>;
  });
}
