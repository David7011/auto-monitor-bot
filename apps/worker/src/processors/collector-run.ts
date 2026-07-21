import { prisma, type ListingSource } from "@amb/db";
import {
  BACKFILL_TELEGRAM_PRIORITY,
  QUEUE_NAMES,
  REALTIME_LISTING_PRIORITY,
  backoffDelayMs,
  filterReliableFreshListings,
  protectionPauseSeconds,
  sortListingsNewestFirst,
  type ListingDiscoveryLane,
  type NormalizedListing,
} from "@amb/shared";
import { getCollector } from "../collectors/index.js";
import { isNetworkTimeoutError } from "../collectors/html-utils.js";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { enqueue, redisConnection } from "../lib/queues.js";
import {
  markChallengeProbePending,
  recordChallengeIncident,
  resolveChallengeIncidents,
} from "../modules/challenge-incident.js";
import {
  buildSourceSearchPlan,
  loadSourceSearchState,
  markSourceSearchSuccess,
} from "../modules/source-search-plan.js";
import { sendSystemAlert } from "../modules/telegram-service.js";
import { recordPendingObservations } from "../modules/observation-journal.js";
import {
  processListingDetected,
  type ListingProcessingResult,
} from "./listing-detected.js";

const NETWORK_TIMEOUT_PAUSE_SECONDS = 30;

export type CollectorRunJob = {
  source: ListingSource;
  sourceId?: string;
  trigger?: "SCHEDULED" | "MANUAL" | "BACKFILL";
  lane?: ListingDiscoveryLane;
  monitoringGeneration?: number;
  scheduledAt?: string;
  manual?: boolean;
  lockRetryCount?: number;
};

export async function processCollectorRun(job: CollectorRunJob): Promise<void> {
  const { source } = job;
  const lane = resolveLane(job);
  const collector = getCollector(source);
  const sourceRecord = await prisma.source.findUnique({ where: { source } });

  if (!collector) {
    await log.warn("collector", `No collector registered for ${source}, skipping`);
    return;
  }
  if (!sourceRecord || !sourceRecord.enabled) return;
  if (sourceRecord.pausedUntil && sourceRecord.pausedUntil > new Date()) return;

  const staleBeforeLock = await scheduledJobState(job);
  if (staleBeforeLock.stale) {
    await prisma.collectorRun.create({
      data: {
        source,
        lane,
        status: "SKIPPED",
        finishedAt: new Date(),
        errorMessage: staleBeforeLock.reason,
      },
    });
    return;
  }

  const lockKey = `collector-lock:${source}:${lane}`;
  const lockValue = `${process.pid}:${Date.now()}:${Math.random()}`;
  const lockTtlMs = Math.max(scanDurationMs(lane) * 2, 30_000);
  const lock = await redisConnection.set(lockKey, lockValue, "PX", lockTtlMs, "NX");
  if (lock !== "OK") {
    await retryLockCollision(job, lane);
    return;
  }

  const startedAt = new Date();
  const run = await prisma.collectorRun.create({ data: { source, lane, status: "RUNNING", startedAt } });
  const recoveringFromChallenge = sourceRecord.status === "CAPTCHA_DETECTED";
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

  try {
    const contexts = await buildSourceSearchPlan(source);
    if (contexts.length === 0) {
      await finishRun(run.id, {
        status: "SUCCESS",
        startedAt,
        foundCount,
        newCount,
        recoveredCount,
        pageCount,
        requestCount,
        observedCount,
        semanticWarnings,
      });
      await log.info("collector", `${source} ${lane} scan skipped: no active filters target this source`);
      return;
    }

    let skippedInitialSync = 0;
    let limitedReason: string | null = null;
    let limited = false;
    let inlineDispatchAttempts = 0;

    // One run-wide scan budget shared across every context, so a multi-context
    // source (AUTO_RIA) cannot exceed the collector lock TTL and let a
    // concurrent scheduled run double-process.
    const scan = scanOptions(lane);

    for (const context of contexts) {
      const state = await loadSourceSearchState(context);
      const result = await collector.collect(context, state, scan);
      const collectedListings = normalizeCollectedBatch(result.listings, lane);
      const notifiableListings = context.freshnessMode === "ALL_TIME"
        ? collectedListings
        : filterReliableFreshListings(collectedListings, context.freshnessMode);

      foundCount += collectedListings.length;
      pageCount += result.pageCount ?? (result.requestCount ? 1 : 0);
      requestCount += result.requestCount ?? 0;
      observedCount += result.observedCount ?? collectedListings.length;
      for (const warning of result.semanticWarnings ?? []) semanticWarnings.add(warning);
      if (result.coverageMetrics) coverageMetrics.push(result.coverageMetrics);

      const staleAfterCollect = await scheduledJobState(job);
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
        await handleExternalProtection({
          source,
          sourceId: sourceRecord.id,
          runId: run.id,
          lane,
          startedAt,
          result,
          priorConsecutiveErrors: sourceRecord.consecutiveErrors,
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

      if (needsInitialSync) {
        if (context.initialWindowBehavior === "NOTIFY_MATCHING_IN_WINDOW") {
          const safeInitialListings = notifiableListings
            .filter((listing) => listing.publishedAt && listing.timestampConfidence !== "UNKNOWN")
            .slice(0, context.maxInitialWindowNotifications);
          for (const listing of safeInitialListings) {
            const allowInline = inlineDispatchAttempts < env.FAST_INLINE_LISTING_LIMIT_PER_RUN;
            if (allowInline) inlineDispatchAttempts += 1;
            const result = await dispatchListing(listing, context.filterIds, lane, allowInline);
            processedExternalIds.add(listing.externalId);
            const counted = countProcessingResult(result);
            matchedCount += counted.matched;
            rejectedCount += counted.rejected;
            duplicateCount += counted.duplicate;
            dispatchedCount += counted.dispatched;
            newCount += counted.accepted;
            if (lane === "BACKFILL") recoveredCount += counted.accepted;
          }
          skippedInitialSync += Math.max(0, collectedListings.length - safeInitialListings.length);
        } else {
          skippedInitialSync += collectedListings.length;
        }
      } else {
        const unseenListings = notifiableListings.filter((listing) => !state.knownExternalIds.has(listing.externalId));
        for (const listing of unseenListings) {
          const allowInline = inlineDispatchAttempts < env.FAST_INLINE_LISTING_LIMIT_PER_RUN;
          if (allowInline) inlineDispatchAttempts += 1;
          const result = await dispatchListing(listing, context.filterIds, lane, allowInline);
          processedExternalIds.add(listing.externalId);
          const counted = countProcessingResult(result);
          matchedCount += counted.matched;
          rejectedCount += counted.rejected;
          duplicateCount += counted.duplicate;
          dispatchedCount += counted.dispatched;
          newCount += counted.accepted;
          if (lane === "BACKFILL") recoveredCount += counted.accepted;
        }
      }

      const unprocessedListings = collectedListings.filter((listing) => !processedExternalIds.has(listing.externalId));
      if (unprocessedListings.length > 0) await recordPendingObservations(unprocessedListings, lane);

      await markSourceSearchSuccess(context, state, collectedListings, {
        initialSyncCompleted: needsInitialSync || Boolean(state.initialSyncCompletedAt),
        newestFirstVerified: Boolean(collector.supportsNewestFirst && collector.newestFirstVerified),
        cutoff: context.publishedAfter,
        cutoffReached: result.cutoffReached,
        lane,
        pageCount: result.pageCount,
        scannedExternalIds: result.scannedExternalIds,
        coverageStateUpdate: result.coverageStateUpdate,
      });
      if (lane === "REALTIME" && result.coverageGap) {
        await enqueue(
          QUEUE_NAMES.COLLECTOR_BACKFILL,
          "collect",
          {
            sourceId: sourceRecord.id,
            source,
            trigger: "BACKFILL",
            lane: "BACKFILL",
            monitoringGeneration: job.monitoringGeneration,
            scheduledAt: new Date().toISOString(),
          },
          { jobId: `coverage-recovery-${source}-${Math.floor(Date.now() / 60_000)}` },
        );
      }
    }

    const finishedAt = new Date();
    const emptyStreak = observedCount === 0 ? sourceRecord.consecutiveEmptyResults + 1 : 0;
    if (emptyStreak >= env.SOURCE_EMPTY_RESULT_WARNING_THRESHOLD) {
      semanticWarnings.add(`${source} returned an empty result ${emptyStreak} consecutive time(s)`);
    }
    const healthScore = calculateHealthScore({ limited, emptyStreak, warnings: semanticWarnings.size });

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

    if (recoveringFromChallenge) {
      await resolveChallengeIncidents(sourceRecord.id);
      await safeSystemAlert(`Источник восстановлен: ${sourceDisplayName(source)}\nЗащитная страница исчезла, обычный мониторинг продолжен.`);
    }
    if (skippedInitialSync > 0) {
      await log.info("collector", `${source} ${lane} initial sync completed, skipped ${skippedInitialSync} existing listings`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNetworkTimeoutError(error, message)) {
      if (lane === "BACKFILL") {
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
        await log.warn("collector", `${source} BACKFILL limited by network timeout`, message);
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

    if (lane === "BACKFILL") {
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
      await log.error("collector", `${source} BACKFILL collector failed without pausing realtime`, message);
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
    await releaseLock(lockKey, lockValue);
  }
}

async function handleExternalProtection(input: {
  source: ListingSource;
  sourceId: string;
  runId: string;
  lane: ListingDiscoveryLane;
  startedAt: Date;
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof getCollector>>["collect"]>>;
  priorConsecutiveErrors: number;
  counters: {
    foundCount: number;
    newCount: number;
    recoveredCount: number;
    pageCount: number;
    requestCount: number;
    observedCount: number;
  };
  semanticWarnings: Set<string>;
}): Promise<void> {
  const status = input.result.captchaDetected ? "CAPTCHA_DETECTED" : "RATE_LIMITED";
  const pauseSeconds = input.result.captchaDetected
    ? protectionPauseSeconds({
        consecutiveErrors: input.priorConsecutiveErrors,
        baseSeconds: Math.max(60, env.CAPTCHA_PAUSE_SECONDS),
        maxSeconds: Math.max(env.CAPTCHA_PAUSE_SECONDS, env.CAPTCHA_PAUSE_MAX_SECONDS),
      })
    : protectionPauseSeconds({
        retryAfterSeconds: input.result.retryAfterSeconds,
        consecutiveErrors: input.priorConsecutiveErrors,
        baseSeconds: env.RATE_LIMIT_PAUSE_BASE_SECONDS,
        maxSeconds: env.RATE_LIMIT_PAUSE_MAX_SECONDS,
      });
  const pausedUntil = new Date(Date.now() + pauseSeconds * 1000);
  const reason = input.result.limitedReason
    ?? `${status}: источник поставлен на паузу на ${formatPauseDuration(pauseSeconds)} без агрессивных повторов.`;

  await recordChallengeIncident({
    sourceId: input.sourceId,
    detector: input.result.detector ?? status,
    responseStatus: input.result.responseStatus,
    affectedUrl: input.result.affectedUrl,
    cooldownUntil: pausedUntil,
    limitedReason: reason,
  });
  await prisma.source.update({
    where: { source: input.source },
    data: {
      status,
      pausedUntil,
      lastError: `${reason} Пауза до ${formatKyivDate(pausedUntil)}.`,
      consecutiveErrors: { increment: 1 },
      lastCheckedAt: new Date(),
      lastDurationMs: elapsedMs(input.startedAt),
      healthScore: input.result.captchaDetected ? 20 : 40,
    },
  });
  await finishRun(input.runId, {
    status,
    startedAt: input.startedAt,
    ...input.counters,
    semanticWarnings: input.semanticWarnings,
    errorMessage: reason,
  });
  await log.warn("collector", `${input.source} ${input.lane} paused: ${reason}`);
  await safeSystemAlert([
    `Защита источника: ${sourceDisplayName(input.source)}`,
    `Статус: ${input.result.captchaDetected ? "обнаружена CAPTCHA или защитная страница" : "сработало ограничение запросов"}`,
    `Источник поставлен на паузу до ${formatKyivDate(pausedUntil)}. Остальные источники продолжают работать.`,
    "После паузы робот выполнит одну безопасную проверку доступности.",
  ].join("\n"));
}

async function dispatchListing(
  listing: NormalizedListing,
  filterIds: string[],
  lane: ListingDiscoveryLane,
  allowInline = true,
): Promise<ListingProcessingResult | undefined> {
  if (allowInline && lane !== "BACKFILL" && env.FAST_INLINE_LISTING_PROCESSING_ENABLED) {
    try {
      return await processListingDetected({ listing, filterIds, discoveryLane: lane });
    } catch (error) {
      void log.warn(
        "pipeline",
        "Inline listing processing failed, queued fallback",
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
    }
  }

  // Persist the normalized snapshot before handing work to Redis. If Redis or
  // the worker crashes after enqueue, observation replay can still recover the
  // advert even though its external ID is already part of the search cursor.
  await recordPendingObservations([listing], lane);
  await enqueue(
    QUEUE_NAMES.LISTING_DETECTED,
    "detected",
    { listing, filterIds, discoveryLane: lane },
    { priority: lane === "BACKFILL" ? BACKFILL_TELEGRAM_PRIORITY : REALTIME_LISTING_PRIORITY },
  );
  return undefined;
}

function countProcessingResult(result: ListingProcessingResult | undefined): {
  matched: number;
  rejected: number;
  duplicate: number;
  dispatched: number;
  accepted: number;
} {
  if (!result) return { matched: 0, rejected: 0, duplicate: 0, dispatched: 1, accepted: 0 };
  if (result.outcome === "REJECTED") return { matched: 0, rejected: 1, duplicate: 0, dispatched: 0, accepted: 0 };
  if (result.outcome === "DUPLICATE" || result.outcome === "HOT_DUPLICATE") {
    return { matched: result.matchedFilterIds.length > 0 ? 1 : 0, rejected: 0, duplicate: 1, dispatched: 0, accepted: 0 };
  }
  return { matched: 1, rejected: 0, duplicate: 0, dispatched: 1, accepted: 1 };
}

async function retryLockCollision(job: CollectorRunJob, lane: ListingDiscoveryLane): Promise<void> {
  const retryCount = job.lockRetryCount ?? 0;
  const maxRetries = lane === "BACKFILL" ? 1 : env.COLLECTOR_LOCK_RETRY_MAX;
  if (retryCount >= maxRetries) {
    await log.info("collector", `${job.source} ${lane} scan coalesced with an already running scan`);
    return;
  }

  const queue = lane === "BACKFILL" ? QUEUE_NAMES.COLLECTOR_BACKFILL : QUEUE_NAMES.COLLECTOR_RUN;
  const delay = env.COLLECTOR_LOCK_RETRY_DELAY_MS * (retryCount + 1);
  await enqueue(
    queue,
    "collect",
    { ...job, lane, lockRetryCount: retryCount + 1 },
    {
      delay,
      jobId: `collector-lock-retry-${job.source}-${lane}-${Date.now()}-${retryCount + 1}`,
    },
  );
}

async function scheduledJobState(job: CollectorRunJob): Promise<{ stale: boolean; reason: string | null }> {
  const trigger = job.trigger ?? (job.manual ? "MANUAL" : "SCHEDULED");
  if (trigger === "MANUAL") return { stale: false, reason: null };

  const state = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
  if (!state || state.status !== "RUNNING") return { stale: true, reason: "Monitoring is not running" };
  if (typeof job.monitoringGeneration === "number" && state.generation !== job.monitoringGeneration) {
    return { stale: true, reason: `Stale monitoring generation: job=${job.monitoringGeneration}, current=${state.generation}` };
  }
  return { stale: false, reason: null };
}

function resolveLane(job: CollectorRunJob): ListingDiscoveryLane {
  if (job.lane) return job.lane;
  if (job.trigger === "BACKFILL") return "BACKFILL";
  if (job.trigger === "MANUAL" || job.manual) return "MANUAL";
  return "REALTIME";
}

function scanOptions(lane: ListingDiscoveryLane) {
  const maxDurationMs = scanDurationMs(lane);
  return {
    lane,
    maxPages: lane === "BACKFILL" ? env.BACKFILL_MAX_PAGES : 1,
    maxCandidates: lane === "BACKFILL" ? env.BACKFILL_MAX_CANDIDATES : env.REALTIME_MAX_CANDIDATES,
    deadlineAt: new Date(Date.now() + maxDurationMs),
  } as const;
}

function scanDurationMs(lane: ListingDiscoveryLane): number {
  return lane === "BACKFILL" ? env.BACKFILL_MAX_DURATION_MS : env.MAX_SCAN_DURATION_MS;
}

function normalizeCollectedBatch(listings: NormalizedListing[], lane: ListingDiscoveryLane): NormalizedListing[] {
  const limit = lane === "BACKFILL" ? env.BACKFILL_MAX_CANDIDATES : env.REALTIME_MAX_CANDIDATES;
  return sortListingsNewestFirst(listings).slice(0, Math.max(1, limit));
}

async function finishRun(
  runId: string,
  input: {
    status: "SUCCESS" | "LIMITED" | "SKIPPED" | "CANCELLED_BY_USER" | "FAILED" | "RATE_LIMITED" | "CAPTCHA_DETECTED";
    startedAt: Date;
    foundCount: number;
    newCount: number;
    recoveredCount: number;
    pageCount: number;
    requestCount: number;
    observedCount: number;
    matchedCount?: number;
    rejectedCount?: number;
    duplicateCount?: number;
    dispatchedCount?: number;
    semanticWarnings: Set<string>;
    coverageMetrics?: Array<Record<string, string | number | boolean | null>>;
    errorMessage?: string | null;
  },
): Promise<void> {
  await prisma.collectorRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      finishedAt: new Date(),
      foundCount: input.foundCount,
      newCount: input.newCount,
      recoveredCount: input.recoveredCount,
      pageCount: input.pageCount,
      requestCount: input.requestCount,
      observedCount: input.observedCount,
      matchedCount: input.matchedCount ?? 0,
      rejectedCount: input.rejectedCount ?? 0,
      duplicateCount: input.duplicateCount ?? 0,
      dispatchedCount: input.dispatchedCount ?? 0,
      semanticWarnings: [...input.semanticWarnings].slice(0, 20),
      coverageMetrics: input.coverageMetrics?.slice(0, 20) ?? undefined,
      errorMessage: input.errorMessage ?? null,
    },
  });
}

function calculateHealthScore(input: { limited: boolean; emptyStreak: number; warnings: number }): number {
  const score = 100 - (input.limited ? 15 : 0) - Math.min(45, input.emptyStreak * 15) - Math.min(20, input.warnings * 5);
  return Math.max(10, score);
}

function elapsedMs(startedAt: Date, finishedAt = new Date()): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

async function releaseLock(lockKey: string, lockValue: string): Promise<void> {
  try {
    await redisConnection.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockValue,
    );
  } catch {
    // The lock has a short TTL; losing Redis during shutdown must not turn a completed scan into a failed job.
  }
}

async function safeSystemAlert(message: string): Promise<void> {
  try {
    await sendSystemAlert(message);
  } catch (error) {
    await log.warn("telegram", "System alert delivery failed", error instanceof Error ? error.message : String(error));
  }
}

function sourceDisplayName(source: ListingSource): string {
  if (source === "AUTO_RIA") return "AUTO.RIA";
  if (source === "CARS_UA") return "Cars.ua";
  if (source === "AUTOMOTO") return "AutoMoto.ua";
  return source;
}

function formatPauseDuration(seconds: number): string {
  if (seconds < 120) return `${Math.max(1, Math.round(seconds))} сек`;
  return `${Math.round(seconds / 60)} мин`;
}

function formatKyivDate(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
