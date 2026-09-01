import { prisma } from "@amb/db";
import {
  QUEUE_NAMES,
  backoffDelayMs,
  filterReliableFreshListings,
  isBackgroundDiscoveryLane,
  type NormalizedListing,
} from "@amb/shared";
import { getCollector } from "../collectors/index.js";
import { isNetworkTimeoutError } from "../collectors/html-utils.js";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { enqueue, redisConnection } from "../lib/queues.js";
import {
  markChallengeProbePending,
  resolveChallengeIncidents,
} from "../modules/challenge-incident.js";
import {
  buildSourceSearchPlan,
  contextForCoverageRecovery,
  loadSourceSearchState,
  markSourceSearchSuccess,
} from "../modules/source-search-plan.js";
import { olxLaneArbiter } from "../modules/olx-lane-arbiter.js";
import { olxProtectionCoolingState } from "../modules/olx-protection-cooling.js";
import { laneOwnsSourceHealth } from "../modules/source-health-ownership.js";
import { recordPendingObservations } from "../modules/observation-journal.js";
import type { ListingProcessingResult } from "./listing-detected.js";
import { realtimeHotHandoffEnabled } from "../modules/realtime-dispatch-policy.js";
import {
  calculateHealthScore,
  collectorLockScope,
  countProcessingResult,
  dispatchListings,
  elapsedMs,
  finishRun,
  formatKyivDate,
  handleExternalProtection,
  normalizeCollectedBatch,
  outageRecoveryListings,
  releaseLock,
  renewLock,
  resolveLane,
  resolveTrigger,
  retryLockCollision,
  safeSystemAlert,
  scanDurationMs,
  scanOptions,
  scheduledJobState,
  sourceDisplayName,
  type CollectorRunJob,
} from "./collector-run-helpers.js";

const NETWORK_TIMEOUT_PAUSE_SECONDS = 30;

export type { CollectorRunJob } from "./collector-run-helpers.js";

export async function processCollectorRun(job: CollectorRunJob): Promise<void> {
  const { source } = job;
  const lane = resolveLane(job);
  const trigger = resolveTrigger(job);
  const collector = getCollector(source);
  const sourceRecord = await prisma.source.findUnique({ where: { source } });

  if (!collector) {
    await log.warn("collector", `No collector registered for ${source}, skipping`);
    return;
  }
  if (!sourceRecord || !sourceRecord.enabled) return;
  if (sourceRecord.pausedUntil && sourceRecord.pausedUntil > new Date()) return;

  // Do this before acquiring a collector lock or creating a run. An enabled
  // source with no active filter context has no useful work and must not fill
  // collector_runs or the deduplicated application log.
  const contexts = await buildSourceSearchPlan(source);
  if (contexts.length === 0) return;

  const staleBeforeLock = await scheduledJobState(job);
  if (staleBeforeLock.stale) {
    await prisma.collectorRun.create({
      data: {
        source,
        lane,
        trigger,
        status: "SKIPPED",
        finishedAt: new Date(),
        errorMessage: staleBeforeLock.reason,
      },
    });
    return;
  }

  const recoveringFromChallenge =
    laneOwnsSourceHealth(lane)
    && (sourceRecord.status === "CAPTCHA_DETECTED" || sourceRecord.status === "RATE_LIMITED");
  const latestOlxProtectionIncident = source === "OLX"
    ? await prisma.challengeIncident.findFirst({
        where: { sourceId: sourceRecord.id },
        orderBy: { detectedAt: "desc" },
        select: { detectedAt: true, cooldownUntil: true },
      })
    : null;
  const olxProtectionCooling = olxProtectionCoolingState({
    detectedAt: latestOlxProtectionIncident?.detectedAt,
    cooldownUntil: latestOlxProtectionIncident?.cooldownUntil,
    coolingSeconds: env.OLX_PROTECTION_COOLING_SECONDS,
  });
  if (source === "OLX" && isBackgroundDiscoveryLane(lane) && olxProtectionCooling.active) {
    const now = new Date();
    await prisma.collectorRun.create({
      data: {
        source,
        lane,
        trigger,
        status: "SKIPPED",
        startedAt: now,
        finishedAt: now,
        errorMessage: `OLX background cooling is active until ${olxProtectionCooling.until?.toISOString()}`,
      },
    });
    return;
  }

  const lockScope = collectorLockScope(job, lane);
  const lockKey = `collector-lock:${source}:${lockScope}`;
  const lockValue = `${process.pid}:${Date.now()}:${Math.random()}`;
  const lockTtlMs = Math.max(
    (lane === "COVERAGE" ? env.OLX_COVERAGE_MAX_DURATION_MS : scanDurationMs(lane)) * 2,
    30_000,
  );
  const lock = await redisConnection.set(lockKey, lockValue, "PX", lockTtlMs, "NX");
  if (lock !== "OK") {
    await retryLockCollision(job, lane);
    return;
  }
  const lockRenewal = setInterval(() => {
    void renewLock(lockKey, lockValue, lockTtlMs);
  }, Math.max(5_000, Math.floor(lockTtlMs / 3)));
  lockRenewal.unref();

  const startedAt = new Date();
  const run = await prisma.collectorRun.create({
    data: { source, lane, trigger, status: "RUNNING", startedAt },
  });
  if (recoveringFromChallenge) await markChallengeProbePending(sourceRecord.id);

  let foundCount = 0;
  let newCount = 0;
  let recoveredCount = 0;
  let pageCount = 0;
  let requestCount = 0;
  let observedCount = 0;
  let matchedCount = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;
  let dispatchedCount = 0;
  const semanticWarnings = new Set<string>();
  const coverageMetrics: Array<Record<string, string | number | boolean | null>> = [];
  if (job.trigger === "COVERAGE") {
    coverageMetrics.push({
      kind: "olx-coverage-queue",
      profile: "COVERAGE",
      reason: "durable regional/HTML/private reconciliation",
    });
  } else if (lane === "BACKFILL") {
    coverageMetrics.push({
      kind: "backfill-policy",
      profile: job.backfillProfile ?? "FULL",
      reason: job.backfillReason?.slice(0, 240) ?? "immediate or legacy full-depth recovery",
    });
  }

  try {
    let skippedInitialSync = 0;
    let limitedReason: string | null = null;
    let limited = false;
    const inlineDispatchBudget = { used: 0 };

    // One run-wide scan budget shared across every context, so a multi-context
    // source (AUTO_RIA) cannot exceed the collector lock TTL and let a
    // concurrent scheduled run double-process.
    const scan = scanOptions(job, lane, {
      olxProtectionCooling:
        source === "OLX" && (olxProtectionCooling.active || recoveringFromChallenge),
      olxProtectionProbe: source === "OLX" && recoveringFromChallenge,
    });

    for (const context of contexts) {
      const state = await loadSourceSearchState(context);
      const scanContext = job.trigger === "COVERAGE"
        ? context
        : contextForCoverageRecovery(context, state, lane);
      const earlyDispatches: Array<{
        listing: NormalizedListing;
        result: ListingProcessingResult | undefined;
      }> = [];
      const earlyDispatchedExternalIds = new Set<string>();
      const contextScan = realtimeHotHandoffEnabled(lane, state.initialSyncCompletedAt)
        ? {
            ...scan,
            onHotCandidates: async (candidates: readonly NormalizedListing[]) => {
              const freshCandidates = (context.freshnessMode === "ALL_TIME"
                ? [...candidates]
                : filterReliableFreshListings([...candidates], context.freshnessMode))
                .filter((listing) => !earlyDispatchedExternalIds.has(listing.externalId));
              if (freshCandidates.length === 0) return;
              try {
                const dispatched = await dispatchListings(
                  freshCandidates,
                  context.filterIds,
                  lane,
                  inlineDispatchBudget,
                );
                earlyDispatches.push(...dispatched);
                for (const item of dispatched) earlyDispatchedExternalIds.add(item.listing.externalId);
              } catch (error) {
                // The full collector result will retry these candidates through
                // the normal durable path. A fast-path optimization must never
                // turn a healthy source scan into a failure.
                void log.warn(
                  "pipeline",
                  `Early ${source} candidate handoff failed; continuing with durable dispatch`,
                  error instanceof Error ? error.message : String(error),
                ).catch(() => undefined);
              }
            },
          }
        : scan;
      const result = source === "OLX" && lane === "REALTIME"
        ? await olxLaneArbiter.runRealtime(() => collector.collect(scanContext, state, contextScan))
        : await collector.collect(scanContext, state, contextScan);
      const collectedListings = normalizeCollectedBatch(result.listings, lane);
      const normallyFreshListings = context.freshnessMode === "ALL_TIME"
        ? collectedListings
        : filterReliableFreshListings(collectedListings, context.freshnessMode);
      const notifiableListings = job.trigger === "COVERAGE"
        ? normallyFreshListings
        : outageRecoveryListings(
            normallyFreshListings,
            collectedListings,
            state,
            lane,
          );

      foundCount += collectedListings.length;
      pageCount += result.pageCount ?? (result.requestCount ? 1 : 0);
      requestCount += result.requestCount ?? 0;
      observedCount += result.observedCount ?? collectedListings.length;
      for (const warning of result.semanticWarnings ?? []) semanticWarnings.add(warning);
      if (result.coverageMetrics) coverageMetrics.push(result.coverageMetrics);

      // Execution lag is only meaningful before a job starts. Re-check only
      // monitoring status/generation here so a valid long backfill is not
      // cancelled merely because it has done useful work for over 30 seconds.
      const staleAfterCollect = await scheduledJobState(job, {
        checkExecutionLag: false,
        checkRecoveryPending: false,
      });
      if (staleAfterCollect.stale) {
        await finishRun(run.id, {
          status: "CANCELLED_BY_USER",
          startedAt,
          foundCount,
          newCount,
          recoveredCount,
          pageCount,
          requestCount,
          observedCount,
          semanticWarnings,
          errorMessage: staleAfterCollect.reason,
        });
        return;
      }

      if (result.rateLimited || result.captchaDetected) {
        if (lane === "BACKFILL") {
          const oldestObservedAt = collectedListings.reduce<Date | null>((oldest, listing) => {
            if (!listing.publishedAt) return oldest;
            return !oldest || listing.publishedAt < oldest ? listing.publishedAt : oldest;
          }, null);
          await prisma.coverageRecoveryWindow.updateMany({
            where: { sourceSearchStateId: state.id, status: "PENDING" },
            data: {
              lastAttemptAt: new Date(),
              lastAttemptRunId: run.id,
              oldestObservedAt,
              pageCount: result.pageCount ?? 0,
              requestCount: result.requestCount ?? 0,
              observedCount: result.observedCount ?? collectedListings.length,
            },
          });
        }
        await handleExternalProtection({
          source,
          sourceId: sourceRecord.id,
          runId: run.id,
          lane,
          startedAt,
          result,
          priorConsecutiveErrors: sourceRecord.consecutiveErrors,
          alreadyProtected: recoveringFromChallenge,
          counters: { foundCount, newCount, recoveredCount, pageCount, requestCount, observedCount },
          semanticWarnings,
        });
        return;
      }

      if (result.quotaDeferredSeconds) {
        const nextCheckAt = new Date(Date.now() + Math.max(1, result.quotaDeferredSeconds) * 1000);
        limitedReason = result.limitedReason ?? "Локальный планировщик сохранил квоту API";
        await prisma.source.update({
          where: { source },
          data: {
            status: "LIMITED",
            nextCheckAt,
            lastCheckedAt: new Date(),
            lastError: `${limitedReason}. Следующая проверка после ${formatKyivDate(nextCheckAt)}.`,
            consecutiveErrors: 0,
            pausedUntil: null,
            lastDurationMs: elapsedMs(startedAt),
            healthScore: 85,
          },
        });
        await finishRun(run.id, {
          status: "LIMITED",
          startedAt,
          foundCount,
          newCount,
          recoveredCount,
          pageCount,
          requestCount,
          observedCount,
          semanticWarnings,
          errorMessage: limitedReason,
        });
        return;
      }

      if (result.limited) {
        limited = true;
        limitedReason = result.limitedReason ?? limitedReason ?? "Источник имеет ограниченную точность времени или поиска";
      }

      const needsInitialSync = !state.initialSyncCompletedAt;
      const processedExternalIds = new Set<string>();
      let listingsToDispatch: NormalizedListing[] = [];

      if (needsInitialSync) {
        if (context.initialWindowBehavior === "NOTIFY_MATCHING_IN_WINDOW") {
          listingsToDispatch = notifiableListings
            .filter((listing) => listing.publishedAt && listing.timestampConfidence !== "UNKNOWN")
            .slice(0, context.maxInitialWindowNotifications);
          skippedInitialSync += Math.max(0, collectedListings.length - listingsToDispatch.length);
        } else {
          skippedInitialSync += collectedListings.length;
        }
      } else {
        listingsToDispatch = notifiableListings.filter((listing) => !state.knownExternalIds.has(listing.externalId));
      }

      const dispatches = [
        ...earlyDispatches,
        ...await dispatchListings(
        listingsToDispatch.filter((listing) => !earlyDispatchedExternalIds.has(listing.externalId)),
        context.filterIds,
        lane,
        inlineDispatchBudget,
        ),
      ];
      for (const dispatch of dispatches) {
        processedExternalIds.add(dispatch.listing.externalId);
        const counted = countProcessingResult(dispatch.result);
        matchedCount += counted.matched;
        rejectedCount += counted.rejected;
        duplicateCount += counted.duplicate;
        dispatchedCount += counted.dispatched;
        newCount += counted.accepted;
        if (lane === "BACKFILL") recoveredCount += counted.accepted;
      }

      const unprocessedListings = collectedListings.filter((listing) => !processedExternalIds.has(listing.externalId));
      if (unprocessedListings.length > 0) await recordPendingObservations(unprocessedListings, lane);

      const stateUpdate = await markSourceSearchSuccess(scanContext, state, collectedListings, {
        initialSyncCompleted: needsInitialSync || Boolean(state.initialSyncCompletedAt),
        newestFirstVerified: Boolean(collector.supportsNewestFirst && collector.newestFirstVerified),
        cutoff: scanContext.publishedAfter,
        cutoffReached: result.cutoffReached,
        coverageVerified: result.coverageVerified,
        coverageGap: result.coverageGap,
        coverageVerificationMethod: result.coverageVerificationMethod,
        lane: job.trigger === "COVERAGE" ? "COVERAGE" : lane,
        pageCount: result.pageCount,
        requestCount: result.requestCount,
        observedCount: result.observedCount,
        runId: run.id,
        scannedExternalIds: result.scannedExternalIds,
        coverageStateUpdate: result.coverageStateUpdate,
      });
      if (stateUpdate.recoveryWindowId) {
        coverageMetrics.push({
          kind: "offline-window-recovery-proof",
          windowId: stateUpdate.recoveryWindowId,
          opened: stateUpdate.recoveryWindowOpened,
          verified: stateUpdate.recoveryVerified,
          requiredCutoffAt: stateUpdate.requiredCutoffAt?.toISOString() ?? null,
          verificationMethod: result.coverageVerificationMethod ?? null,
        });
      }
      const immediateRecoveryRequired = (
        lane === "REALTIME" && stateUpdate.recoveryRequired
      ) || (
        job.trigger === "COVERAGE" && stateUpdate.recoveryRequired
      );
      if (immediateRecoveryRequired) {
        const recoveryEpoch = stateUpdate.requiredCutoffAt?.getTime() ?? Date.now();
        await enqueue(
          QUEUE_NAMES.COLLECTOR_BACKFILL,
          "collect",
          {
            sourceId: sourceRecord.id,
            source,
            trigger: "RECOVERY",
            lane: "BACKFILL",
            monitoringGeneration: job.monitoringGeneration,
            scheduledAt: new Date().toISOString(),
          },
          {
            jobId: [
              "coverage-recovery",
              source,
              job.monitoringGeneration ?? "unknown-generation",
              stateUpdate.recoveryWindowId ?? "legacy-window",
              Math.floor(recoveryEpoch / 60_000),
              Math.floor(Date.now() / 60_000),
            ].join("-"),
          },
        );
      }
      if (scan.olxProtectionProbe) break;
    }

    const finishedAt = new Date();
    const emptyStreak = observedCount === 0 ? sourceRecord.consecutiveEmptyResults + 1 : 0;
    if (emptyStreak >= env.SOURCE_EMPTY_RESULT_WARNING_THRESHOLD) {
      semanticWarnings.add(`${source} returned an empty result ${emptyStreak} consecutive time(s)`);
    }
    const healthScore = calculateHealthScore({ limited, emptyStreak, warnings: semanticWarnings.size });

    if (laneOwnsSourceHealth(lane)) {
      // Background depth work must never clear a CAPTCHA/rate-limit pause that
      // a concurrent realtime request has just installed.
      await prisma.source.update({
        where: { source },
        data: {
          status: limited ? "LIMITED" : "ACTIVE",
          lastCheckedAt: finishedAt,
          lastSuccessfulAt: finishedAt,
          lastNonEmptyAt: observedCount > 0 ? finishedAt : sourceRecord.lastNonEmptyAt,
          lastDurationMs: elapsedMs(startedAt, finishedAt),
          lastError: limited ? limitedReason : semanticWarnings.size > 0 ? [...semanticWarnings].join("; ") : null,
          consecutiveErrors: 0,
          consecutiveEmptyResults: emptyStreak,
          healthScore,
          pausedUntil: null,
          supportsNewestFirst: collector.supportsNewestFirst ?? true,
          newestFirstVerified: Boolean(collector.supportsNewestFirst && collector.newestFirstVerified),
          newestFirstVerifiedAt: collector.supportsNewestFirst && collector.newestFirstVerified ? finishedAt : null,
          initialSyncCompletedAt: sourceRecord.initialSyncCompletedAt ?? finishedAt,
        },
      });
    }
    await finishRun(run.id, {
      status: limited ? "LIMITED" : "SUCCESS",
      startedAt,
      foundCount,
      newCount,
      recoveredCount,
      pageCount,
      requestCount,
      observedCount,
      matchedCount,
      rejectedCount,
      duplicateCount,
      dispatchedCount,
      semanticWarnings,
      coverageMetrics,
      errorMessage: limited ? limitedReason : null,
    });

    if (lane === "REALTIME") {
      // A successful hot-path probe is the authoritative recovery signal,
      // including incidents raised only by a deep backfill page.
      await resolveChallengeIncidents(sourceRecord.id);
    }
    if (recoveringFromChallenge && lane === "REALTIME") {
      await safeSystemAlert(`Источник восстановлен: ${sourceDisplayName(source)}\nЗащитная страница исчезла, обычный мониторинг продолжен.`);
    }
    if (skippedInitialSync > 0) {
      await log.info("collector", `${source} ${lane} initial sync completed, skipped ${skippedInitialSync} existing listings`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNetworkTimeoutError(error, message)) {
      if (isBackgroundDiscoveryLane(lane)) {
        const reason = "Фоновая сверка достигла сетевого таймаута; быстрый мониторинг продолжает работу.";
        semanticWarnings.add(reason);
        await finishRun(run.id, {
          status: "LIMITED",
          startedAt,
          foundCount,
          newCount,
          recoveredCount,
          pageCount,
          requestCount,
          observedCount,
          semanticWarnings,
          errorMessage: reason,
        });
        await log.warn("collector", `${source} ${lane} limited by network timeout`, message);
        return;
      }
      const pausedUntil = new Date(Date.now() + NETWORK_TIMEOUT_PAUSE_SECONDS * 1000);
      const reason = `Запрос к источнику превысил время ожидания. Повтор после ${formatKyivDate(pausedUntil)}.`;
      await prisma.source.update({
        where: { source },
        data: {
          status: "LIMITED",
          lastError: reason,
          consecutiveErrors: 0,
          pausedUntil,
          lastCheckedAt: new Date(),
          lastDurationMs: elapsedMs(startedAt),
          healthScore: 70,
        },
      });
      await finishRun(run.id, {
        status: "LIMITED",
        startedAt,
        foundCount,
        newCount,
        recoveredCount,
        pageCount,
        requestCount,
        observedCount,
        semanticWarnings,
        errorMessage: reason,
      });
      await log.warn("collector", `${source} ${lane} limited by network timeout`, reason);
      return;
    }

    if (isBackgroundDiscoveryLane(lane)) {
      semanticWarnings.add(message);
      await finishRun(run.id, {
        status: "FAILED",
        startedAt,
        foundCount,
        newCount,
        recoveredCount,
        pageCount,
        requestCount,
        observedCount,
        semanticWarnings,
        errorMessage: message,
      });
      await log.error("collector", `${source} ${lane} collector failed without pausing realtime`, message);
      return;
    }

    const consecutiveErrors = sourceRecord.consecutiveErrors + 1;
    const pausedUntil = new Date(Date.now() + backoffDelayMs(consecutiveErrors));
    await prisma.source.update({
      where: { source },
      data: {
        status: "ERROR",
        lastError: message,
        consecutiveErrors,
        pausedUntil,
        lastCheckedAt: new Date(),
        lastDurationMs: elapsedMs(startedAt),
        healthScore: Math.max(5, 60 - consecutiveErrors * 10),
      },
    });
    await finishRun(run.id, {
      status: "FAILED",
      startedAt,
      foundCount,
      newCount,
      recoveredCount,
      pageCount,
      requestCount,
      observedCount,
      semanticWarnings,
      errorMessage: message,
    });
    await log.error("collector", `${source} ${lane} collector failed`, message);
  } finally {
    clearInterval(lockRenewal);
    await releaseLock(lockKey, lockValue);
  }
}
