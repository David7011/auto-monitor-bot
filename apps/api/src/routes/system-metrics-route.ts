import type { FastifyInstance } from "fastify";
import { Prisma, prisma } from "@amb/db";
import {
  groupCount,
  marketplaceCategoryKey,
  isMarketplaceCategoryKey,
  qualifyMetricSummary,
  startOfTodayInKyiv,
  STARTUP_CATCH_UP_WINDOW_MS,
  splitSessionJournalLatencies,
  summarizeJournalLatencies,
  summarizeMetric,
  TELEGRAM_LATENCY_MIN_SAMPLE_SIZE,
  type MetricsResponse,
} from "@amb/shared";
import { env } from "../env.js";
import { apiStartedAt } from "../lib/runtime-lifecycle.js";
import { deriveOlxHotPathStates, deriveOlxProtectionState } from "../lib/olx-hot-path-state.js";
import {
  COLLECTOR_DURATION_MIN_SAMPLE_SIZE,
  buildCollectorDurationBreakdown,
  type CollectorDurationAggregateRow,
} from "../lib/collector-duration-metrics.js";

export async function systemMetricsRoute(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async () => {
    const generatedAt = new Date();
    const latencyWindowStartedAt = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
    const todayStartedAt = startOfTodayInKyiv();
    const [
      collectorDurationRows,
      latencyObservations,
      dailyListings,
      dailyNotifications,
      dailyRuns,
      sourceHealth,
      dailyObservations,
      latestAudit,
      firstOlxSuccessThisSession,
      categoryDurationRows,
      categoryStates,
      monitoringState,
      olxProtectionIncidents,
      olxPressureRows,
    ] = await Promise.all([
      prisma.$queryRaw<CollectorDurationAggregateRow[]>(Prisma.sql`
        WITH durations AS (
          SELECT
            "source",
            "lane",
            EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000 AS duration_ms
          FROM "collector_runs"
          WHERE "finishedAt" IS NOT NULL
            AND "startedAt" >= ${latencyWindowStartedAt}
            AND "startedAt" <= ${generatedAt}
            AND "status"::text IN ('SUCCESS', 'LIMITED')
            AND "finishedAt" >= "startedAt"
        )
        SELECT
          CASE WHEN GROUPING("source") = 1 THEN NULL ELSE "source"::text END AS "source",
          "lane"::text AS "lane",
          COUNT(*)::integer AS "sampleCount",
          ROUND(AVG(duration_ms))::integer AS "averageMs",
          ROUND(MIN(duration_ms))::integer AS "minimumMs",
          ROUND(MAX(duration_ms))::integer AS "maximumMs",
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))::integer AS "p50Ms",
          ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::integer AS "p95Ms"
          , ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms))::integer AS "p99Ms"
        FROM durations
        GROUP BY GROUPING SETS (("lane"), ("source", "lane"))
        ORDER BY "lane", "source" NULLS FIRST
      `),
      prisma.sourceSeenListing.findMany({
        where: {
          discoveryLane: "REALTIME",
          firstSeenAt: { gte: latencyWindowStartedAt, lte: generatedAt },
        },
        orderBy: { firstSeenAt: "asc" },
        select: {
          source: true,
          categoryKey: true,
          publishedAt: true,
          firstSeenAt: true,
          notifiedAt: true,
          requestStartedAt: true,
          firstByteAt: true,
          bodyReceivedAt: true,
          parsedAt: true,
          hotCandidateAt: true,
          journalPersistedAt: true,
          filterCompletedAt: true,
          dispatchAttemptedAt: true,
          telegramRequestedAt: true,
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
          pausedUntil: true,
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
      prisma.$queryRaw<Array<{
        categoryKey: string;
        sampleCount: number;
        averageMs: number;
        minimumMs: number;
        maximumMs: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
      }>>(Prisma.sql`
        SELECT
          "categoryKey" AS "categoryKey",
          COUNT(*)::integer AS "sampleCount",
          ROUND(AVG(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "averageMs",
          ROUND(MIN(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "minimumMs",
          ROUND(MAX(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "maximumMs",
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "p50Ms",
          ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "p95Ms"
          , ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000))::integer AS "p99Ms"
        FROM "collector_runs"
        WHERE "lane" = 'REALTIME'::"CollectorLane"
          AND "finishedAt" IS NOT NULL
          AND "finishedAt" >= "startedAt"
          AND "startedAt" BETWEEN ${latencyWindowStartedAt} AND ${generatedAt}
          AND "status"::text IN ('SUCCESS', 'LIMITED')
        GROUP BY "categoryKey"
        ORDER BY "categoryKey"
      `),
      prisma.sourceSearchState.findMany({
        select: {
          source: true,
          categoryKey: true,
          parserHealth: true,
          coverageRecoveryPending: true,
          lastSuccessfulScanAt: true,
        },
      }),
      prisma.monitoringState.findUnique({ where: { id: "singleton" } }),
      prisma.challengeIncident.findMany({
        where: {
          detectedAt: { gte: latencyWindowStartedAt, lte: generatedAt },
          source: { source: "OLX" },
        },
        select: { detector: true, responseStatus: true },
      }),
      prisma.collectorRun.groupBy({
        by: ["lane"],
        where: {
          source: "OLX",
          startedAt: { gte: latencyWindowStartedAt, lte: generatedAt },
        },
        _count: { _all: true },
        _sum: { requestCount: true },
      }),
    ]);

    const collectorDurations = buildCollectorDurationBreakdown(collectorDurationRows);
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
      const realtimeCollectorDuration = collectorDurations.bySourceLane.find((row) =>
        row.source === source.source && row.lane === "REALTIME")?.durationMs
        ?? summarizeMetric([]);
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
        collectorDurationMs: realtimeCollectorDuration,
        ...sourceLatency,
        publicationToDetectionMs: sourceLatency.publicationTimestampToFirstSeenMs,
        detectionToTelegramMs: sourceLatency.firstSeenToTelegramMs,
      };
    });
    const exactTelegramLatency = latencySummary.durableJournalToTelegramAcceptanceMs;
    const categoryKeys = [...new Set([
      ...categoryDurationRows.map((row) => row.categoryKey).filter(isMarketplaceCategoryKey),
      ...categoryStates.map((state) => marketplaceCategoryKey(state.categoryKey)),
      ...latencyObservations.map((observation) => marketplaceCategoryKey(observation.categoryKey)),
    ])].sort();
    const categoryHealth = categoryKeys.map((categoryKey) => {
      const duration = categoryDurationRows.find((row) => row.categoryKey === categoryKey);
      const states = categoryStates.filter((state) => marketplaceCategoryKey(state.categoryKey) === categoryKey);
      const observations = latencyObservations.filter((observation) => marketplaceCategoryKey(observation.categoryKey) === categoryKey);
      const categoryLatency = summarizeJournalLatencies(observations.map((observation) => ({
        ...observation,
        notifiedAt: observation.notifiedAt && observation.notifiedAt <= generatedAt ? observation.notifiedAt : null,
      })));
      return {
        categoryKey,
        realtimeDurationMs: duration ? {
          count: duration.sampleCount,
          avg: duration.averageMs,
          min: duration.minimumMs,
          max: duration.maximumMs,
          p50: duration.p50Ms,
          p95: duration.p95Ms,
          p99: duration.p99Ms,
        } : summarizeMetric([]),
        durableJournalToTelegramAcceptanceMs: categoryLatency.durableJournalToTelegramAcceptanceMs,
        observations: observations.length,
        discoveryShards: states.length,
        parserDegradedShards: states.filter((state) => state.parserHealth === "DEGRADED").length,
        recoveryPendingShards: states.filter((state) => state.coverageRecoveryPending).length,
        lastSuccessfulScanAt: states.map((state) => state.lastSuccessfulScanAt).filter((date): date is Date => Boolean(date)).sort((left, right) => right.getTime() - left.getTime())[0] ?? null,
      };
    });
    const telegramSloReady = exactTelegramLatency.count >= TELEGRAM_LATENCY_MIN_SAMPLE_SIZE;
    const telegramSloPassed = telegramSloReady && exactTelegramLatency.p95 != null
      ? exactTelegramLatency.p95 <= 3_000
      : null;
    const collectorSloReady = collectorDurations.realtimeDurationMs.count >= COLLECTOR_DURATION_MIN_SAMPLE_SIZE;
    const collectorSloPassed = collectorSloReady && collectorDurations.realtimeDurationMs.p95 != null
      ? collectorDurations.realtimeDurationMs.p95 <= 2_000
      : null;
    const olxLatency = summarizeJournalLatencies(latencyObservations
      .filter((observation) => observation.source === "OLX")
      .map((observation) => ({
        ...observation,
        notifiedAt: observation.notifiedAt && observation.notifiedAt <= generatedAt ? observation.notifiedAt : null,
      })));
    const olxCollectorDuration = collectorDurations.bySourceLane.find((row) =>
      row.source === "OLX" && row.lane === "REALTIME")?.durationMs ?? summarizeMetric([]);
    const qualifiedOlxCollector = qualifyMetricSummary(olxCollectorDuration);
    const qualifiedOlxInternal = qualifyMetricSummary(olxLatency.hotCandidateToTelegramAcceptanceMs);
    const olxSource = sourceHealth.find((source) => source.source === "OLX");
    const olxProtection = deriveOlxProtectionState(olxSource, generatedAt);
    const olxProtected = olxProtection.protected;
    const olxParserDegraded = categoryStates.some((state) => state.source === "OLX" && state.parserHealth === "DEGRADED");
    const olxP95Ready = qualifiedOlxCollector.ready.p95 && qualifiedOlxInternal.ready.p95;
    const olxP95Exceeded = (qualifiedOlxCollector.p95 ?? 0) > 2_000 || (qualifiedOlxInternal.p95 ?? 0) > 3_000;
    const olxStates = deriveOlxHotPathStates({
      protected: olxProtected,
      sourceStatus: olxSource?.status ?? null,
      parserDegraded: olxParserDegraded,
      p95Ready: olxP95Ready,
      p95Exceeded: olxP95Exceeded,
    });
    const olxState = olxStates.compatibilityState;
    const olxStateReason = olxProtected
      ? olxProtection.reason ?? "OLX protection is active; no extra traffic is authorized"
      : olxState === "INSUFFICIENT_DATA"
        ? `p95 requires 30 complete samples (collector=${qualifiedOlxCollector.count}, accepted hot path=${qualifiedOlxInternal.count})`
        : olxParserDegraded
          ? "At least one OLX discovery shard reports parser degradation"
          : olxState === "DEGRADED"
            ? "Measured OLX collector or internal delivery p95 exceeds its existing diagnostic target"
            : "OLX collector and internal delivery tails have sufficient healthy evidence";
    const olxRequests = olxPressureRows.reduce((sum, row) => sum + (row._sum.requestCount ?? 0), 0);
    const olxCaptcha = olxProtectionIncidents.filter((incident) => incident.detector.toUpperCase().includes("CAPTCHA")).length;
    const olxCanaryMode = monitoringState?.olxCanaryMode ?? "BASELINE";
    const acceleratedCadence = olxCanaryMode === "CANARY" || olxCanaryMode === "PROMOTED";

    return {
      generatedAt: generatedAt.toISOString(),
      latencyWindow: {
        startedAt: latencyWindowStartedAt.toISOString(),
        endedAt: generatedAt.toISOString(),
        hours: 24 as const,
        basis: "SourceSeenListing.firstSeenAt" as const,
      },
      sampleSize: {
        collectorRuns: collectorDurations.totalCount,
        realtimeObservations: latencyObservations.length,
        publicationTimestamps: latencySummary.publicationTimestampToFirstSeenMs.count,
        telegramNotifications: exactTelegramLatency.count,
      },
      olxHotPath: {
        state: olxState,
        operationalState: olxStates.operationalState,
        optimizationReadiness: olxStates.optimizationReadiness,
        stateReason: olxStateReason,
        windowHours: 24 as const,
        cadence: {
          mode: olxCanaryMode,
          intervalSeconds: acceleratedCadence
            ? env.OLX_CADENCE_CANARY_INTERVAL_SECONDS
            : env.LIVE_OLX_INTERVAL_SECONDS,
          jitterSeconds: acceleratedCadence
            ? env.OLX_CADENCE_CANARY_JITTER_SECONDS
            : env.LIVE_OLX_JITTER_SECONDS,
          experimentId: monitoringState?.olxCanaryExperimentId ?? null,
        },
        collectorDurationMs: qualifiedOlxCollector,
        stages: {
          requestStartToFirstByteMs: qualifyMetricSummary(olxLatency.requestStartToFirstByteMs),
          firstByteToBodyReceivedMs: qualifyMetricSummary(olxLatency.firstByteToBodyReceivedMs),
          bodyReceivedToParsedMs: qualifyMetricSummary(olxLatency.bodyReceivedToParsedMs),
          parsedToHotCandidateMs: qualifyMetricSummary(olxLatency.parsedToHotCandidateMs),
          hotCandidateToDurableJournalMs: qualifyMetricSummary(olxLatency.hotCandidateToDurableJournalMs),
          durableJournalToTelegramRequestMs: qualifyMetricSummary(olxLatency.durableJournalToTelegramRequestMs),
          telegramRequestToTelegramAcceptanceMs: qualifyMetricSummary(olxLatency.telegramRequestToTelegramAcceptanceMs),
          hotCandidateToTelegramAcceptanceMs: qualifiedOlxInternal,
          requestStartToTelegramAcceptanceMs: qualifyMetricSummary(olxLatency.requestStartToTelegramAcceptanceMs),
        },
        pressure: {
          requests: olxRequests,
          requestsPerHour: Math.round((olxRequests / 24) * 100) / 100,
          byLane: olxPressureRows.map((row) => ({
            lane: row.lane,
            requests: row._sum.requestCount ?? 0,
            runs: row._count._all,
          })),
          protectionIncidents: olxProtectionIncidents.length,
          protectionIncidentsPerThousandRequests: olxRequests > 0
            ? Math.round((olxProtectionIncidents.length * 1_000_000) / olxRequests) / 1_000
            : null,
          http403: olxProtectionIncidents.filter((incident) => incident.responseStatus === 403).length,
          http429: olxProtectionIncidents.filter((incident) => incident.responseStatus === 429).length,
          captcha: olxCaptcha,
          recoveryPendingShards: categoryStates.filter((state) =>
            state.source === "OLX" && state.coverageRecoveryPending).length,
        },
      },
      collectorDurationMs: collectorDurations.realtimeDurationMs,
      collectorRealtimeDurationMs: collectorDurations.realtimeDurationMs,
      collectorDurationByLane: collectorDurations.byLane,
      collectorDurationBySourceLane: collectorDurations.bySourceLane,
      categoryHealth,
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
        firstByteToBodyReceivedMs: "SOURCE_RESPONSE_HEADERS_TO_BODY_RECEIVED" as const,
        bodyReceivedToParsedMs: "SOURCE_BODY_RECEIVED_TO_PARSED" as const,
        parsedToHotCandidateMs: "SOURCE_PARSED_TO_HOT_CANDIDATE" as const,
        firstByteToHotCandidateMs: "SOURCE_RESPONSE_HEADERS_TO_HOT_CANDIDATE" as const,
        hotCandidateToDurableJournalMs: "HOT_CANDIDATE_TO_DURABLE_JOURNAL" as const,
        hotCandidateToTelegramAcceptanceMs: "HOT_CANDIDATE_TO_TELEGRAM_ACCEPTANCE" as const,
        durableJournalToFilterCompletedMs: "DURABLE_JOURNAL_TO_FILTER_COMPLETED" as const,
        durableJournalToTelegramRequestMs: "DURABLE_JOURNAL_TO_TELEGRAM_REQUEST" as const,
        filterCompletedToTelegramRequestMs: "FILTER_COMPLETED_TO_TELEGRAM_REQUEST" as const,
        dispatchAttemptedToTelegramRequestMs: "DISPATCH_ATTEMPTED_TO_TELEGRAM_REQUEST" as const,
        telegramRequestToTelegramAcceptanceMs: "TELEGRAM_REQUEST_TO_TELEGRAM_ACCEPTANCE" as const,
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
        collectorP95Under2Seconds: collectorSloPassed,
        collectorP95Metric: "REALTIME_SUCCESS_OR_LIMITED_24H" as const,
        collectorP95Status: collectorSloPassed == null
          ? "LOW_SAMPLE"
          : collectorSloPassed
            ? "PASS"
            : "FAIL",
        collectorMinimumSampleSize: COLLECTOR_DURATION_MIN_SAMPLE_SIZE,
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
