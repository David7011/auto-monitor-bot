import { prisma, type ListingSource } from "@amb/db";
import { createHash, randomUUID } from "node:crypto";
import {
  BACKFILL_TELEGRAM_PRIORITY,
  QUEUE_NAMES,
  REALTIME_LISTING_PRIORITY,
  TELEGRAM_SEND_PRIORITY,
  isBackgroundDiscoveryLane,
  olxRecoveryAttemptGeneration,
  sortListingsNewestFirst,
  type ListingDiscoveryLane,
  type EffectiveCadenceMode,
  type NormalizedListing,
} from "@amb/shared";
import type { CollectorResult } from "../collectors/base.js";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { enqueue, redisConnection } from "../lib/queues.js";
import {
  recordChallengeIncident,
} from "../modules/challenge-incident.js";
import { requiresManualChallengeVerification } from "../modules/challenge-incident-policy.js";
import {
  MANUAL_REMINDER_KEY_TTL_SECONDS,
  manualReminderKey,
  shouldSendManualReminder,
} from "../modules/challenge-incident-policy.js";
import { loadSourceSearchState } from "../modules/source-search-plan.js";
import { sendSystemAlert } from "../modules/telegram-service.js";
import {
  observationIdentity,
  recordPendingObservations,
  type PendingObservationState,
} from "../modules/observation-journal.js";
import { mapWithConcurrency } from "../modules/bounded-parallel.js";
import { backfillScanBudget, type BackfillProfile } from "../modules/backfill-profile.js";
import { planRealtimeDispatch } from "../modules/realtime-dispatch-policy.js";
import {
  captchaPauseSeconds,
  rateLimitPauseSeconds,
} from "../modules/source-protection-policy.js";
import { kickOffRstHarvest } from "../modules/rst-clearance-harvester.js";
import { kickOffChallengeSolve } from "../modules/challenge-solver.js";
import { invalidateSourceSessionCache } from "../collectors/source-sessions.js";
import { laneOwnsSourceHealth } from "../modules/source-health-ownership.js";
import {
  createTelegramFlashBundle,
  releaseFlashListingsToCards,
} from "../modules/telegram-service.js";
import { planTelegramFlashBundle } from "../modules/telegram-flash-policy.js";
import { scheduledOlxJobExecutionState } from "../modules/scheduled-job-policy.js";
import {
  processListingDetected,
  type ListingProcessingResult,
} from "./listing-detected.js";

export type CollectorRunJob = {
  source: ListingSource;
  sourceId?: string;
  trigger?: "SCHEDULED" | "MANUAL" | "BACKFILL" | "RECOVERY" | "COVERAGE";
  lane?: ListingDiscoveryLane;
  monitoringGeneration?: number;
  scheduledAt?: string;
  expectedRunAt?: string;
  cadenceMode?: EffectiveCadenceMode;
  cadenceIntervalSeconds?: number;
  cadenceJitterSeconds?: number;
  manual?: boolean;
  lockRetryCount?: number;
  backfillProfile?: BackfillProfile;
  backfillReason?: string;
};

export type CollectorRunTrigger = NonNullable<CollectorRunJob["trigger"]>;

export async function handleExternalProtection(input: {
  source: ListingSource;
  sourceId: string;
  runId: string;
  lane: ListingDiscoveryLane;
  startedAt: Date;
  result: CollectorResult;
  priorConsecutiveErrors: number;
  alreadyProtected: boolean;
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
  const priorRstProbeAttempts = input.result.captchaDetected && input.source === "RST"
    ? (await prisma.challengeIncident.findFirst({
        where: { sourceId: input.sourceId, recoveredAt: null },
        orderBy: { updatedAt: "desc" },
        select: { probeAttempts: true },
      }))?.probeAttempts
    : undefined;
  const pauseSeconds = input.result.captchaDetected
    ? captchaPauseSeconds({
        source: input.source,
        consecutiveErrors: input.priorConsecutiveErrors,
        priorProbeAttempts: priorRstProbeAttempts,
        baseSeconds: Math.max(60, env.CAPTCHA_PAUSE_SECONDS),
        maxSeconds: Math.max(env.CAPTCHA_PAUSE_SECONDS, env.CAPTCHA_PAUSE_MAX_SECONDS),
      })
    : rateLimitPauseSeconds({
        source: input.source,
        responseStatus: input.result.responseStatus,
        retryAfterSeconds: input.result.retryAfterSeconds,
        consecutiveErrors: input.priorConsecutiveErrors,
        baseSeconds: env.RATE_LIMIT_PAUSE_BASE_SECONDS,
        maxSeconds: env.RATE_LIMIT_PAUSE_MAX_SECONDS,
      });
  const pausedUntil = new Date(Date.now() + pauseSeconds * 1000);
  const reason = input.result.limitedReason
    ?? `${status}: источник поставлен на паузу на ${formatPauseDuration(pauseSeconds)} без агрессивных повторов.`;

  const incident = await recordChallengeIncident({
    sourceId: input.sourceId,
    detector: input.result.detector ?? status,
    responseStatus: input.result.responseStatus,
    affectedUrl: input.result.affectedUrl,
    cooldownUntil: pausedUntil,
    limitedReason: reason,
    manualVerificationRequired: requiresManualChallengeVerification({
      captchaDetected: Boolean(input.result.captchaDetected),
      priorConsecutiveErrors: input.priorConsecutiveErrors,
    }),
  });
  if (!laneOwnsSourceHealth(input.lane)) {
    // A protected deep offset does not prove page 1 is unavailable. Stopping
    // the entire source here used to create a realtime blind spot even while
    // concurrent page-1 requests were succeeding.
    await finishRun(input.runId, {
      status,
      startedAt: input.startedAt,
      ...input.counters,
      semanticWarnings: input.semanticWarnings,
      errorMessage: reason,
    });
    await log.warn(
      "collector",
      `${input.source} ${input.lane} stopped by protection without pausing realtime: ${reason}`,
    );
    return;
  }
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
  if ((input.source === "OLX" || input.source === "AUTO_RIA")
    && (input.result.captchaDetected || (input.result.rateLimited && input.result.responseStatus === 403))) {
    // A poisoned session cookie must not ride the next ticks: drop the cached
    // jar so collectors re-read Redis/env (fresh solver output or manual pass)
    // instead of replaying the cookie that just got challenged.
    invalidateSourceSessionCache(input.source);
  }
  if (input.source === "RST" && input.result.captchaDetected) {
    // Best-effort unattended recovery: the harvester warms a persistent
    // profile and stores a fresh clearance when it succeeds. Non-blocking;
    // the manual captcha flow below stays as the guaranteed fallback.
    kickOffRstHarvest("rst-protection-pause");
  }
  if ((input.source === "OLX" || input.source === "AUTO_RIA")
    && (input.result.captchaDetected || (input.result.rateLimited && input.result.responseStatus === 403))) {
    // Interactive challenge (proven CAPTCHA) or an access-denied 403 with no
    // proven cause: the solver behaves like a human in a persistent profile
    // and stores the session for collectors. Cooldown-gated and non-blocking;
    // the existing pause + alert flow stays as the guaranteed fallback.
    kickOffChallengeSolve(input.source, input.result.captchaDetected ? "captcha-protection-pause" : "access-denied-pause");
  }
  if (incident.manualVerificationNew) {
    const lines = [
      `Требуется ручная проверка: ${sourceDisplayName(input.source)}`,
      "Источник несколько раз подряд вернул CAPTCHA или защитную страницу.",
      `Он остаётся на паузе до ${formatKyivDate(pausedUntil)}; остальные источники продолжают работать.`,
      "Автоматический решатель уже пробует обойти проверку (solver/harvester); после паузы будет разрешена только одна безопасная проверка доступности.",
    ];
    if (input.source === "RST") {
      lines.push("RST открывается только через ручную капчу в Opera GX: пройдите проверку на rst.ua и пришлите новое значение cf_clearance.");
    }
    await safeSystemAlert(lines.join("\n"));
    await rememberManualReminderSent(input.sourceId).catch(() => undefined);
  } else if (!input.alreadyProtected && !incident.repeated) {
    const lines = [
      `Защита источника: ${sourceDisplayName(input.source)}`,
      `Статус: ${input.result.captchaDetected ? "обнаружена CAPTCHA или защитная страница" : protectionStatusText(input.result.responseStatus)}`,
      `Источник поставлен на паузу до ${formatKyivDate(pausedUntil)}. Остальные источники продолжают работать.`,
      "После паузы робот выполнит одну безопасную проверку доступности. Повторные одинаковые ответы не будут засорять Telegram.",
    ];
    if (input.source === "RST") {
      lines.push("RST открывается только через ручную капчу в Opera GX: пройдите проверку на rst.ua и пришлите новое значение cf_clearance.");
    }
    await safeSystemAlert(lines.join("\n"));
  }
  if (incident.manualVerificationRequired && !incident.manualVerificationNew) {
    // A source stuck in manual verification would otherwise go silently dark
    // for days (pauses escalate to 3-7 days). One reminder per day keeps the
    // human in the loop without spamming.
    await maybeSendManualReminderAlert({
      sourceId: input.sourceId,
      source: input.source,
      pausedUntil,
    }).catch(() => undefined);
  }
}

async function rememberManualReminderSent(sourceId: string): Promise<void> {  await redisConnection.set(manualReminderKey(sourceId), new Date().toISOString(), "EX", MANUAL_REMINDER_KEY_TTL_SECONDS);
}

async function maybeSendManualReminderAlert(input: {
  sourceId: string;
  source: ListingSource;
  pausedUntil: Date;
}): Promise<void> {
  const key = manualReminderKey(input.sourceId);
  const last = await redisConnection.get(key);
  if (!shouldSendManualReminder(last, Date.now())) return;
  const lines = input.source === "RST"
    ? [
      "Напоминание: RST всё ещё ждёт ручной капчи в Opera GX.",
      `Пауза до ${formatKyivDate(input.pausedUntil)}; остальные источники продолжают работать.`,
      "Пройдите проверку на rst.ua и пришлите новое значение cf_clearance — мониторинг RST возобновится за пару минут без рестарта.",
    ]
    : [
      `Напоминание: требуется ручная проверка: ${sourceDisplayName(input.source)}.`,
      `Источник на паузе до ${formatKyivDate(input.pausedUntil)}; остальные продолжают работать.`,
    ];
  // Claim first: a crash between send and bookkeeping must skip one reminder,
  // never spam. A failed send releases the claim so the next tick retries.
  await rememberManualReminderSent(input.sourceId);
  try {
    await safeSystemAlert(lines.join("\n"));
  } catch (error) {
    await redisConnection.del(key).catch(() => undefined);
    throw error;
  }
}

export async function dispatchListings(
  listings: readonly NormalizedListing[],
  filterIds: string[],
  lane: ListingDiscoveryLane,
  inlineBudget: { used: number },
): Promise<Array<{ listing: NormalizedListing; result: ListingProcessingResult | undefined }>> {
  // Persist the whole callback/result batch before any per-item Redis claim or
  // filtering. A mid-burst crash leaves a replayable tail instead of memory-
  // only candidates that can disappear when the mutable source page shifts.
  const persistedStates = await recordPendingObservations([...listings], lane);
  const flashPlan = planTelegramFlashBundle({
    listings,
    lane,
    enabled: env.TELEGRAM_FLASH_BUNDLE_ENABLED,
    minItems: env.TELEGRAM_FLASH_BUNDLE_MIN_ITEMS,
    maxItems: env.TELEGRAM_FLASH_BUNDLE_MAX_ITEMS,
  });
  if (flashPlan.enabled) {
    inlineBudget.used = Math.max(inlineBudget.used, env.FAST_INLINE_LISTING_LIMIT_PER_RUN);
    const flashResults = await dispatchFlashListings(flashPlan.flash, filterIds, persistedStates);
    const remainderResults = await mapWithConcurrency(
      flashPlan.remainder,
      env.FAST_INLINE_LISTING_CONCURRENCY,
      async (listing) => ({
        listing,
        // Keep an oversized burst's tail behind the durable flash header. The
        // configured flash cap protects Telegram's 4096-character limit; this
        // delay prevents tail cards from taking an earlier global send slot.
        result: await dispatchListing(
          listing,
          filterIds,
          lane,
          false,
          5_000,
          persistedStates.get(observationIdentity(listing)),
        ),
      }),
    );
    return [...flashResults, ...remainderResults];
  }

  const availableInlineSlots = isBackgroundDiscoveryLane(lane)
    ? 0
    : Math.max(0, env.FAST_INLINE_LISTING_LIMIT_PER_RUN - inlineBudget.used);
  const plan = planRealtimeDispatch(listings, availableInlineSlots);
  inlineBudget.used += plan.inline.length;

  // Preserve newest-first order on the direct path. A queued sibling must not
  // overtake the newest advert and consume the first Telegram send slot.
  const inlineResults: Array<{ listing: NormalizedListing; result: ListingProcessingResult | undefined }> = [];
  for (const listing of plan.inline) {
    inlineResults.push({
      listing,
      result: await dispatchListing(
        listing,
        filterIds,
        lane,
        true,
        0,
        persistedStates.get(observationIdentity(listing)),
      ),
    });
  }

  const queuedResults = await mapWithConcurrency(
    plan.queued,
    env.FAST_INLINE_LISTING_CONCURRENCY,
    async (listing) => ({
      listing,
      result: await dispatchListing(
        listing,
        filterIds,
        lane,
        false,
        0,
        persistedStates.get(observationIdentity(listing)),
      ),
    }),
  );
  return [...inlineResults, ...queuedResults];
}

async function dispatchFlashListings(
  listings: readonly NormalizedListing[],
  filterIds: string[],
  persistedStates: ReadonlyMap<string, PendingObservationState>,
): Promise<Array<{ listing: NormalizedListing; result: ListingProcessingResult | undefined }>> {
  const flashBundleId = `flash-${randomUUID()}`;
  const results = await mapWithConcurrency(
    listings,
    env.FAST_INLINE_LISTING_CONCURRENCY,
    async (listing) => {
      try {
        return {
          listing,
          result: await processListingDetected({
            listing,
            filterIds,
            discoveryLane: "REALTIME",
            flashBundleId,
            observationPersisted: true,
            persistedObservationState: persistedStates.get(observationIdentity(listing)),
          }),
        };
      } catch (error) {
        await recordPendingObservations([listing], "REALTIME");
        await enqueue(
          QUEUE_NAMES.LISTING_DETECTED,
          "detected",
          { listing, filterIds, discoveryLane: "REALTIME", observationPersisted: true },
          {
            priority: REALTIME_LISTING_PRIORITY,
            delay: 5_000,
            jobId: `flash-processing-fallback-${listing.source}-${listing.externalId}`,
          },
        );
        void log.warn(
          "telegram-flash",
          "Flash staging failed for one listing; queued delayed card fallback",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        return { listing, result: undefined };
      }
    },
  );
  const stagedIds = results
    .map((item) => item.result)
    .filter((result): result is ListingProcessingResult & { listingId: string; flashStaged: true } =>
      Boolean(result?.listingId && result.flashStaged))
    .map((result) => result.listingId);

  if (stagedIds.length >= env.TELEGRAM_FLASH_BUNDLE_MIN_ITEMS) {
    const created = await createTelegramFlashBundle(flashBundleId, stagedIds);
    if (created) {
      await enqueue(
        QUEUE_NAMES.TELEGRAM_FLASH,
        "flash",
        { flashBundleId },
        { priority: TELEGRAM_SEND_PRIORITY, jobId: `telegram-flash-${flashBundleId}` },
      ).catch((error) => {
        void log.warn(
          "telegram-flash",
          "Flash bundle persisted but Redis enqueue failed; pipeline recovery will retry",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      });
      return results;
    }
  }

  const cardIds = await releaseFlashListingsToCards(flashBundleId, stagedIds);
  for (const listingId of cardIds) {
    await enqueue(
      QUEUE_NAMES.TELEGRAM_SEND,
      "send",
      { listingId },
      { priority: TELEGRAM_SEND_PRIORITY, jobId: `telegram-flash-small-${listingId}` },
    );
  }
  return results;
}

async function dispatchListing(
  listing: NormalizedListing,
  filterIds: string[],
  lane: ListingDiscoveryLane,
  allowInline = true,
  queueDelayMs = 0,
  persistedState?: PendingObservationState,
): Promise<ListingProcessingResult | undefined> {
  if (allowInline && !isBackgroundDiscoveryLane(lane) && env.FAST_INLINE_LISTING_PROCESSING_ENABLED) {
    try {
      return await processListingDetected({
        listing,
        filterIds,
        discoveryLane: lane,
        observationPersisted: true,
        persistedObservationState: persistedState,
      });
    } catch (error) {
      void log.warn(
        "pipeline",
        "Inline listing processing failed; queued fallback",
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
    }
  }

  // Persist the normalized snapshot before handing work to Redis. If Redis or
  // the worker crashes after enqueue, observation replay can still recover it.
  await enqueue(
    QUEUE_NAMES.LISTING_DETECTED,
    "detected",
    { listing, filterIds, discoveryLane: lane, observationPersisted: true },
    {
      priority: isBackgroundDiscoveryLane(lane) ? BACKFILL_TELEGRAM_PRIORITY : REALTIME_LISTING_PRIORITY,
      ...(queueDelayMs > 0 ? { delay: queueDelayMs } : {}),
    },
  );
  return undefined;
}

export function countProcessingResult(result: ListingProcessingResult | undefined): {
  matched: number;
  rejected: number;
  duplicate: number;
  dispatched: number;
  accepted: number;
} {
  if (!result) return { matched: 0, rejected: 0, duplicate: 0, dispatched: 1, accepted: 0 };
  if (result.outcome === "DEFERRED") return { matched: 0, rejected: 0, duplicate: 0, dispatched: 0, accepted: 0 };
  if (result.outcome === "REJECTED") return { matched: 0, rejected: 1, duplicate: 0, dispatched: 0, accepted: 0 };
  if (result.outcome === "DUPLICATE" || result.outcome === "HOT_DUPLICATE") {
    return {
      matched: result.matchedFilterIds.length > 0 ? 1 : 0,
      rejected: 0,
      duplicate: 1,
      dispatched: 0,
      accepted: 0,
    };
  }
  if (result.outcome === "SHADOWED") {
    return { matched: 1, rejected: 0, duplicate: 0, dispatched: 0, accepted: 1 };
  }
  return { matched: 1, rejected: 0, duplicate: 0, dispatched: 1, accepted: 1 };
}

export async function retryLockCollision(job: CollectorRunJob, lane: ListingDiscoveryLane): Promise<void> {
  const retryCount = job.lockRetryCount ?? 0;
  if (job.source === "OLX" && lane === "REALTIME") {
    // The active OLX realtime run remains authoritative. Retrying a collision
    // can survive until that run finishes and then create a compressed request
    // burst; the scheduler will issue the next normal cadence job instead.
    await log.info("collector", `${job.source} ${lane} scan coalesced with an already running scan`);
    return;
  }
  if (job.source === "RST" && isBackgroundDiscoveryLane(lane)) {
    // RST uses one origin-wide lock. Never queue a delayed background retry
    // behind realtime: the next normal backfill cycle is safer than a burst.
    await log.info("collector", `${job.source} ${lane} scan coalesced behind the realtime-safe origin gate`);
    return;
  }
  const maxRetries = isBackgroundDiscoveryLane(lane) ? 1 : env.COLLECTOR_LOCK_RETRY_MAX;
  if (retryCount >= maxRetries) {
    await log.info("collector", `${job.source} ${lane} scan coalesced with an already running scan`);
    return;
  }

  const queue = collectorQueueForJob(job, lane);
  let delay = env.COLLECTOR_LOCK_RETRY_DELAY_MS * (retryCount + 1);
  if (job.source === "OLX" && job.trigger === "RECOVERY" && lane === "BACKFILL") {
    // A killed process leaves its lease until TTL expiry. One short retry
    // cannot recover that case and then completed-job dedupe swallows future
    // signals. Wait for the actual lease once; do not delete another owner's
    // lock or spin through many short attempts.
    const ttl = await redisConnection.pttl(`collector-lock:${job.source}:${collectorLockScope(job, lane)}`);
    if (ttl > 0) delay = Math.max(delay, ttl + 250);
  }
  await enqueue(
    queue,
    "collect",
    { ...job, lane, lockRetryCount: retryCount + 1 },
    {
      delay,
      jobId: `collector-lock-retry-${job.source}-${collectorLockScope(job, lane)}-${Date.now()}-${retryCount + 1}`,
    },
  );
}

export async function scheduledJobState(
  job: CollectorRunJob,
  options: {
    checkExecutionLag?: boolean;
    checkRecoveryPending?: boolean;
    now?: Date;
  } = {},
): Promise<{ stale: boolean; reason: string | null }> {
  const trigger = job.trigger ?? (job.manual ? "MANUAL" : "SCHEDULED");
  if (trigger === "MANUAL") return { stale: false, reason: null };

  if (options.checkExecutionLag !== false) {
    const executionState = scheduledOlxJobExecutionState(job, options.now ?? new Date());
    if (executionState.stale) return executionState;
  }

  const state = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
  if (!state || state.status !== "RUNNING") return { stale: true, reason: "Monitoring is not running" };
  if (typeof job.monitoringGeneration === "number" && state.generation !== job.monitoringGeneration) {
    return {
      stale: true,
      reason: `Stale monitoring generation: job=${job.monitoringGeneration}, current=${state.generation}`,
    };
  }
  if (
    job.source === "OLX"
    && trigger === "RECOVERY"
    && options.checkRecoveryPending !== false
  ) {
    const pendingRecoveryCount = await prisma.sourceSearchState.count({
      where: { source: "OLX", coverageRecoveryPending: true },
    });
    if (pendingRecoveryCount === 0) {
      return { stale: true, reason: "OLX coverage recovery is no longer pending" };
    }
  }
  return { stale: false, reason: null };
}

export function resolveLane(job: CollectorRunJob): ListingDiscoveryLane {
  // Trigger wins over a persisted lane so pre-deploy COVERAGE jobs already in
  // Redis cannot re-enter the system as BACKFILL after this upgrade.
  if (job.trigger === "COVERAGE") return "COVERAGE";
  if (job.lane) return job.lane;
  if (job.trigger === "BACKFILL" || job.trigger === "RECOVERY") return "BACKFILL";
  if (job.trigger === "MANUAL" || job.manual) return "MANUAL";
  return "REALTIME";
}

export function resolveTrigger(job: CollectorRunJob): CollectorRunTrigger {
  if (job.trigger) return job.trigger;
  if (job.manual || job.lane === "MANUAL") return "MANUAL";
  if (job.lane === "COVERAGE") return "COVERAGE";
  if (job.lane === "BACKFILL") return "BACKFILL";
  return "SCHEDULED";
}

export function scanOptions(
  job: CollectorRunJob,
  lane: ListingDiscoveryLane,
  protection: {
    olxProtectionCooling?: boolean;
    olxProtectionProbe?: boolean;
  } = {},
) {
  const coverageOnly = job.trigger === "COVERAGE" || lane === "COVERAGE";
  const budget = backfillScanBudget(job.source, lane, job.backfillProfile, {
    defaultPages: env.BACKFILL_MAX_PAGES,
    olxFullPages: env.OLX_BACKFILL_MAX_PAGES,
    maxCandidates: env.BACKFILL_MAX_CANDIDATES,
    maxDurationMs: env.BACKFILL_MAX_DURATION_MS,
  });
  const maxDurationMs = coverageOnly
    ? env.OLX_COVERAGE_MAX_DURATION_MS
    : lane === "BACKFILL"
      ? budget.maxDurationMs
      : scanDurationMs(lane);
  return {
    lane,
    maxPages: coverageOnly ? 1 : lane === "BACKFILL" ? budget.maxPages : 1,
    maxCandidates: coverageOnly
      ? env.REALTIME_MAX_CANDIDATES
      : lane === "BACKFILL"
        ? budget.maxCandidates
        : env.REALTIME_MAX_CANDIDATES,
    deadlineAt: new Date(Date.now() + maxDurationMs),
    backfillProfile: lane === "BACKFILL" && !coverageOnly ? budget.profile : undefined,
    recovery: job.trigger === "RECOVERY",
    coverageOnly,
    olxProtectionCooling: Boolean(protection.olxProtectionCooling),
    olxProtectionProbe: Boolean(protection.olxProtectionProbe),
  } as const;
}

export function scanDurationMs(lane: ListingDiscoveryLane): number {
  if (lane === "COVERAGE") return env.OLX_COVERAGE_MAX_DURATION_MS;
  return lane === "BACKFILL" ? env.BACKFILL_MAX_DURATION_MS : env.MAX_SCAN_DURATION_MS;
}

export function collectorLockScope(job: CollectorRunJob, lane: ListingDiscoveryLane): string {
  // RST's Cloudflare protection observes the origin, not our internal lanes.
  // One shared lease prevents realtime and backfill workers from hitting it
  // concurrently while keeping OLX coverage isolation unchanged.
  if (job.source === "RST") return "ORIGIN";
  return job.trigger === "COVERAGE" || lane === "COVERAGE" ? "COVERAGE" : lane;
}

export function recoveryContinuationJobId(input: {
  source: ListingSource;
  monitoringGeneration?: number;
  recoveryWindowId: string | null;
  recoveryAttemptCount: number;
  recoveryAttemptGeneration?: string;
}): string {
  const capability = input.recoveryAttemptGeneration ?? (input.source === "OLX"
    ? olxRecoveryAttemptGeneration({ pageSize: env.OLX_API_PAGE_SIZE, maxOffset: env.OLX_API_MAX_OFFSET })
    : "native");
  const capabilityId = createHash("sha256").update(capability).digest("hex").slice(0, 12);
  return [
    "coverage-recovery",
    input.source,
    input.monitoringGeneration ?? "unknown-generation",
    input.recoveryWindowId ?? "legacy-window",
    `capability-${capabilityId}`,
    `attempt-${Math.max(0, Math.trunc(input.recoveryAttemptCount))}`,
  ].join("-");
}

export function collectorQueueForJob(job: CollectorRunJob, lane: ListingDiscoveryLane) {
  if (job.trigger === "COVERAGE" || lane === "COVERAGE") return QUEUE_NAMES.COLLECTOR_COVERAGE;
  return lane === "BACKFILL" ? QUEUE_NAMES.COLLECTOR_BACKFILL : QUEUE_NAMES.COLLECTOR_RUN;
}

export function normalizeCollectedBatch(
  listings: NormalizedListing[],
  lane: ListingDiscoveryLane,
): NormalizedListing[] {
  const limit = lane === "BACKFILL" ? env.BACKFILL_MAX_CANDIDATES : env.REALTIME_MAX_CANDIDATES;
  return sortListingsNewestFirst(listings).slice(0, Math.max(1, limit));
}

export function outageRecoveryListings(
  normallyFresh: readonly NormalizedListing[],
  collected: readonly NormalizedListing[],
  state: Awaited<ReturnType<typeof loadSourceSearchState>>,
  lane: ListingDiscoveryLane,
): NormalizedListing[] {
  if (lane !== "BACKFILL" || !state.coverageRecoveryPending || !state.coverageRecoveryCutoffAt) {
    return [...normallyFresh];
  }
  const selected = new Map(normallyFresh.map((listing) => [listing.externalId, listing]));
  for (const listing of collected) {
    if (
      listing.publishedAt
      && listing.publishedAt >= state.coverageRecoveryCutoffAt
      && listing.timestampConfidence !== "UNKNOWN"
    ) {
      selected.set(listing.externalId, listing);
    }
  }
  return sortListingsNewestFirst([...selected.values()]);
}

export async function finishRun(
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

export function calculateHealthScore(input: {
  limited: boolean;
  emptyStreak: number;
  warnings: number;
}): number {
  const score = 100
    - (input.limited ? 15 : 0)
    - Math.min(45, input.emptyStreak * 15)
    - Math.min(20, input.warnings * 5);
  return Math.max(10, score);
}

export function elapsedMs(startedAt: Date, finishedAt = new Date()): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

export async function releaseLock(lockKey: string, lockValue: string): Promise<void> {
  try {
    await redisConnection.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockValue,
    );
  } catch {
    // The lock has a short TTL; Redis loss during shutdown must not fail a scan.
  }
}

export async function renewLock(lockKey: string, lockValue: string, ttlMs: number): Promise<boolean> {
  try {
    const renewed = await redisConnection.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      lockKey,
      lockValue,
      String(ttlMs),
    );
    return Number(renewed) === 1;
  } catch {
    return false;
  }
}

export async function safeSystemAlert(message: string): Promise<void> {
  try {
    await sendSystemAlert(message);
  } catch (error) {
    await log.warn("telegram", "System alert delivery failed", error instanceof Error ? error.message : String(error));
  }
}

export function sourceDisplayName(source: ListingSource): string {
  if (source === "AUTO_RIA") return "AUTO.RIA";
  if (source === "CARS_UA") return "Cars.ua";
  if (source === "AUTOMOTO") return "AutoMoto.ua";
  return source;
}

export function formatKyivDate(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatPauseDuration(seconds: number): string {
  if (seconds < 120) return `${Math.max(1, Math.round(seconds))} сек`;
  return `${Math.round(seconds / 60)} мин`;
}

function protectionStatusText(responseStatus?: number): string {
  if (responseStatus === 403) return "OLX отклонил доступ (HTTP 403), CAPTCHA не обнаружена";
  if (responseStatus === 429) return "OLX ограничил частоту запросов (HTTP 429)";
  return "сработало ограничение запросов";
}
