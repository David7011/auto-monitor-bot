import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, prisma, type ListingSource, type SourceStatus } from "@amb/db";
import { startOfTodayInKyiv } from "@amb/shared";
import { env } from "../env.js";
import { getQueueCounts, getRedisDiagnostics } from "../lib/queues.js";
import { boundedIntegerQuery, cursorQuery } from "../lib/query-validation.js";
import { workerHealthStatus } from "../lib/worker-health.js";

const settingsSchema = z.object({
  intervalSeconds: z.number().int().min(10).max(3600).optional(),
  jitterSeconds: z.number().int().min(0).max(120).optional(),
});

type CheckStatus = "OK" | "WARN" | "FAIL";
type HealthStatus = CheckStatus | "NOT_CONFIGURED" | "IDLE";

const apiStartedAt = new Date();

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const checkedAt = new Date();
    let database: { status: HealthStatus; latencyMs?: number; message: string };
    let redis: { status: HealthStatus; queues?: Awaited<ReturnType<typeof getQueueCounts>>; message: string };

    const dbStartedAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = { status: "OK", latencyMs: Date.now() - dbStartedAt, message: "PostgreSQL доступен" };
    } catch (err) {
      database = { status: "FAIL", message: err instanceof Error ? err.message : String(err) };
    }

    try {
      const diagnostics = await getRedisDiagnostics();
      const queues = await getQueueCounts();
      const failed = Object.values(queues).reduce((sum, queue) => sum + queue.failed, 0);
      redis = {
        status: failed > 0 ? "WARN" : "OK",
        queues,
        message: failed > 0
          ? `Redis ${diagnostics.version}: заданий BullMQ с ошибкой: ${failed}`
          : `Redis ${diagnostics.version} и BullMQ доступны`,
      };
    } catch (err) {
      redis = { status: "FAIL", message: err instanceof Error ? err.message : String(err) };
    }

    let monitoringState = null;
    let activeSources = 0;
    let lastSuccessfulScan = null;
    let lastFinishedScan = null;
    let sourceHealth: Array<{
      source: ListingSource;
      status: HealthStatus;
      sourceStatus: SourceStatus;
      lastCheckedAt: Date | null;
      lastSuccessfulAt: Date | null;
      staleAfterSeconds: number;
      message: string;
    }> = [];
    if (database.status !== "FAIL") {
      try {
        const [state, sourceRows, activeFilters, successfulScan, finishedScan] = await Promise.all([
          prisma.monitoringState.findUnique({ where: { id: "singleton" } }),
          prisma.source.findMany({ where: { enabled: true }, orderBy: { source: "asc" } }),
          prisma.filter.findMany({ where: { enabled: true }, select: { sources: true } }),
          prisma.collectorRun.findFirst({
            where: { status: "SUCCESS" },
            orderBy: { finishedAt: "desc" },
            select: { source: true, finishedAt: true, foundCount: true, newCount: true },
          }),
          prisma.collectorRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: "desc" },
            select: { source: true, lane: true, status: true, finishedAt: true },
          }),
        ]);
        monitoringState = state;
        lastSuccessfulScan = successfulScan;
        lastFinishedScan = finishedScan;
        const targetSources = configuredTargetSources(activeFilters, sourceRows.map((row) => row.source));
        sourceHealth = sourceRows
          .filter((row) => targetSources.has(row.source))
          .map((row) => sourceHealthEntry(row, checkedAt));
        activeSources = sourceHealth.length;
      } catch {
        database.status = "WARN";
        database.message = "PostgreSQL доступен, но подробная диагностика завершилась ошибкой";
      }
    }

    const monitoringRunning = monitoringState?.status === "RUNNING";
    const workerStale = monitoringRunning && activeSources > 0 && (!lastFinishedScan?.finishedAt
      || checkedAt.getTime() - lastFinishedScan.finishedAt.getTime() > env.WORKER_HEARTBEAT_STALE_SECONDS * 1000);
    const sourceDegraded = sourceHealth.some((source) => source.status === "WARN" || source.status === "FAIL");
    const workerStatus: HealthStatus = workerHealthStatus({
      monitoringRunning,
      heartbeatStale: workerStale,
      hasSuccessfulScan: Boolean(lastSuccessfulScan),
      sourceStatuses: sourceHealth.map((source) => source.status),
    });

    return {
      api: {
        status: "OK" as const,
        startedAt: apiStartedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      },
      database,
      redis,
      workers: {
        status: workerStatus,
        message: monitoringRunning
          ? workerStale
            ? `Один или несколько целевых сборщиков превысили допустимую свежесть проверки`
            : sourceDegraded
              ? "Основной worker работает, но отдельные источники ограничены внешней защитой"
            : lastSuccessfulScan
              ? "Сборщики регулярно завершают проверки"
              : "Мониторинг запущен, но успешных проверок пока нет"
          : "Мониторинг остановлен",
      },
      telegramBot: {
        status: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? "OK" : "NOT_CONFIGURED",
        message: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? "Токен бота и получатель настроены"
          : "Telegram-бот не настроен",
      },
      monitoring: {
        status: monitoringState?.status ?? "STOPPED",
        lastTickAt: monitoringState?.lastTickAt ?? null,
        nextTickAt: monitoringState?.nextTickAt ?? null,
      },
      activeSources,
      sourceHealth,
      lastSuccessfulScan,
      lastFinishedScan,
      checkedAt: checkedAt.toISOString(),
    };
  });

  app.get<{ Querystring: { limit?: string; level?: string; cursor?: string } }>("/logs", async (req, reply) => {
    const limit = boundedIntegerQuery(req.query.limit, { fallback: 100, max: 500 });
    if (limit == null) return reply.code(400).send({ error: "limit must be an integer between 1 and 500" });
    const cursor = cursorQuery(req.query.cursor);
    if (cursor === null) return reply.code(400).send({ error: "cursor is invalid" });
    const level = req.query.level;
    const rows = await prisma.errorLog.findMany({
      where: level && ["INFO", "WARN", "ERROR"].includes(level) ? { level: level as "INFO" | "WARN" | "ERROR" } : undefined,
      orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    return { logs, nextCursor: hasMore ? logs.at(-1)?.id ?? null : null };
  });

  app.get("/settings", async () => {
    const state = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
    return {
      intervalSeconds: state?.intervalSeconds ?? 120,
      jitterSeconds: state?.jitterSeconds ?? 20,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    };
  });

  app.patch("/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const state = await prisma.monitoringState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...parsed.data },
      update: parsed.data,
    });
    return { ok: true, intervalSeconds: state.intervalSeconds, jitterSeconds: state.jitterSeconds };
  });

  app.get("/system/check", async () => {
    const checks: Array<{ name: string; status: CheckStatus; message: string }> = [];
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.push({ name: "База данных", status: "OK", message: "PostgreSQL доступен" });
    } catch (err) {
      checks.push({ name: "База данных", status: "FAIL", message: err instanceof Error ? err.message : String(err) });
    }

    try {
      const diagnostics = await getRedisDiagnostics();
      const queues = await getQueueCounts();
      const failed = Object.values(queues).reduce((sum, queue) => sum + queue.failed, 0);
      checks.push({
        name: "Очереди",
        status: failed > 0 ? "WARN" : "OK",
        message: failed > 0
          ? `Redis ${diagnostics.version}: заданий с ошибкой: ${failed}`
          : `Redis ${diagnostics.version} и BullMQ доступны`,
      });
    } catch (err) {
      checks.push({ name: "Очереди", status: "FAIL", message: err instanceof Error ? err.message : String(err) });
    }

    const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    checks.push({
      name: "Telegram",
      status: telegramConfigured ? "OK" : "WARN",
      message: telegramConfigured ? "Токен бота и получатель настроены" : "Telegram не настроен",
    });

    checks.push({
      name: "AUTO.RIA",
      status: env.AUTO_RIA_API_KEY ? "OK" : "WARN",
      message: env.AUTO_RIA_API_KEY
        ? `API-ключ настроен, часовой лимит: ${env.AUTO_RIA_HOURLY_REQUEST_LIMIT}, платные методы: ${
            env.AUTO_RIA_PAID_ENRICHMENT_ENABLED ? "включены" : "выключены"
          }`
        : "API-ключ AUTO.RIA не настроен",
    });

    const [activeRealSources, activeRealFilters] = await Promise.all([
      prisma.source.count({
        where: {
          enabled: true,
          status: { in: ["ACTIVE", "LIMITED"] },
          source: { in: ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"] },
        },
      }),
      prisma.filter.count({
        where: {
          enabled: true,
          sources: { hasSome: ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"] },
        },
      }),
    ]);

    checks.push({
      name: "Источники",
      status: activeRealSources > 0 ? "OK" : "WARN",
      message: `Активных реальных источников: ${activeRealSources}`,
    });
    checks.push({
      name: "Фильтры",
      status: activeRealFilters > 0 ? "OK" : "WARN",
      message: `Активных реальных фильтров: ${activeRealFilters}`,
    });

    const [captchaSources, rateLimitedSources, pausedSources] = await Promise.all([
      prisma.source.count({ where: { status: "CAPTCHA_DETECTED" } }),
      prisma.source.count({ where: { status: "RATE_LIMITED" } }),
      prisma.source.count({ where: { pausedUntil: { gt: new Date() } } }),
    ]);

    checks.push({
      name: "Защита источников",
      status: captchaSources > 0 ? "FAIL" : rateLimitedSources > 0 || pausedSources > 0 ? "WARN" : "OK",
      message: `CAPTCHA: ${captchaSources}, ограничений частоты: ${rateLimitedSources}, источников на паузе: ${pausedSources}`,
    });

    const degradedParsers = await prisma.source.count({
      where: {
        enabled: true,
        OR: [{ healthScore: { lt: 50 } }, { consecutiveEmptyResults: { gte: 3 } }],
      },
    });
    checks.push({
      name: "Состояние парсеров",
      status: degradedParsers > 0 ? "WARN" : "OK",
      message: degradedParsers > 0
        ? `Парсеров, требующих внимания: ${degradedParsers}`
        : "Парсеры источников возвращают корректные данные",
    });

    const status: CheckStatus = checks.some((check) => check.status === "FAIL")
      ? "FAIL"
      : checks.some((check) => check.status === "WARN")
        ? "WARN"
        : "OK";

    return { status, checks, checkedAt: new Date().toISOString() };
  });

  app.get("/metrics", async () => {
    const todayStartedAt = startOfTodayInKyiv();
    const [runs, notifications, dailyListings, dailyNotifications, dailyRuns, sourceHealth, dailyObservations, latestAudit] = await Promise.all([
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
      prisma.telegramNotification.findMany({
        where: {
          sentAt: { not: null },
          listing: {
            discoveryLane: "REALTIME",
            publishedAt: { not: null },
            timestampConfidence: { in: ["HIGH", "MEDIUM"] },
          },
        },
        orderBy: { sentAt: "desc" },
        take: 100,
        select: {
          sentAt: true,
          listing: { select: { source: true, publishedAt: true, firstSeenAt: true, timestampConfidence: true } },
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
    ]);

    const collectorDurations = runs
      .map((run) => (run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null))
      .filter((value): value is number => value != null && value >= 0);

    const publicationToDetection = notifications
      .map((notification) =>
        notification.listing.publishedAt
          ? notification.listing.firstSeenAt.getTime() - notification.listing.publishedAt.getTime()
          : null,
      )
      .filter((value): value is number => value != null && value >= 0);

    const detectionToTelegram = notifications
      .map((notification) =>
        notification.sentAt ? notification.sentAt.getTime() - notification.listing.firstSeenAt.getTime() : null,
      )
      .filter((value): value is number => value != null && value >= 0);
    const collectorDurationSummary = summarize(collectorDurations);
    const publicationToDetectionSummary = summarize(publicationToDetection);
    const detectionToTelegramSummary = summarize(detectionToTelegram);
    const latencyBySource = sourceHealth.map((source) => {
      const sourceRuns = runs.filter((run) => run.source === source.source);
      const sourceNotifications = notifications.filter((notification) => notification.listing.source === source.source);
      return {
        source: source.source,
        collectorDurationMs: summarize(sourceRuns
          .map((run) => run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null)
          .filter((value): value is number => value != null && value >= 0)),
        publicationToDetectionMs: summarize(sourceNotifications
          .map((notification) => notification.listing.publishedAt
            ? notification.listing.firstSeenAt.getTime() - notification.listing.publishedAt.getTime()
            : null)
          .filter((value): value is number => value != null && value >= 0)),
        detectionToTelegramMs: summarize(sourceNotifications
          .map((notification) => notification.sentAt
            ? notification.sentAt.getTime() - notification.listing.firstSeenAt.getTime()
            : null)
          .filter((value): value is number => value != null && value >= 0)),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      sampleSize: {
        collectorRuns: runs.length,
        telegramNotifications: notifications.length,
      },
      collectorDurationMs: collectorDurationSummary,
      publicationToDetectionMs: publicationToDetectionSummary,
      detectionToTelegramMs: detectionToTelegramSummary,
      latencyBySource,
      totalNotificationLatencyMs: summarize(
        notifications
          .map((notification) =>
            notification.sentAt && notification.listing.publishedAt
              ? notification.sentAt.getTime() - notification.listing.publishedAt.getTime()
              : null,
          )
          .filter((value): value is number => value != null && value >= 0),
      ),
      timestampConfidence: {
        preciseLatencyOnlyFor: ["HIGH", "MEDIUM"],
      },
      coverageToday: {
        realtime: groupCount(dailyListings, "discoveryLane", "REALTIME"),
        recovered: groupCount(dailyListings, "discoveryLane", "BACKFILL"),
        manual: groupCount(dailyListings, "discoveryLane", "MANUAL"),
        telegramSent:
          groupCount(dailyNotifications, "status", "SENT") + groupCount(dailyNotifications, "status", "UPDATED"),
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
        collectorP95Under2Seconds: collectorDurationSummary.p95 != null && collectorDurationSummary.p95 <= 2_000,
        telegramP95Under3Seconds: detectionToTelegramSummary.p95 != null && detectionToTelegramSummary.p95 <= 3_000,
        unresolvedObservationsToday:
          groupCount(dailyObservations, "decision", "PENDING")
          + groupCount(dailyObservations, "decision", "MATCHED")
          + groupCount(dailyObservations, "decision", "FAILED"),
      },
      sourceHealth,
    };
  });
}

function groupCount<T extends Record<string, unknown>>(
  groups: Array<T & { _count: { _all: number } }>,
  field: keyof T,
  value: string,
): number {
  return groups.find((group) => group[field] === value)?._count._all ?? 0;
}

function summarize(values: number[]) {
  if (values.length === 0) return { count: 0, avg: null, min: null, max: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] ?? 0;
}

function configuredTargetSources(
  filters: Array<{ sources: ListingSource[] }>,
  availableSources: ListingSource[],
): Set<ListingSource> {
  if (filters.some((filter) => filter.sources.length === 0)) return new Set(availableSources);
  return new Set(filters.flatMap((filter) => filter.sources));
}

function sourceHealthEntry(
  row: {
    source: ListingSource;
    status: SourceStatus;
    intervalSeconds: number;
    lastCheckedAt: Date | null;
    lastSuccessfulAt: Date | null;
  },
  checkedAt: Date,
): {
  source: ListingSource;
  status: HealthStatus;
  sourceStatus: SourceStatus;
  lastCheckedAt: Date | null;
  lastSuccessfulAt: Date | null;
  staleAfterSeconds: number;
  message: string;
} {
  const expectedInterval = liveIntervalSeconds(row.source, row.intervalSeconds);
  const staleAfterSeconds = Math.max(60, expectedInterval * 5);
  const lastCheckedAgeSeconds = row.lastCheckedAt
    ? Math.max(0, Math.round((checkedAt.getTime() - row.lastCheckedAt.getTime()) / 1000))
    : Number.POSITIVE_INFINITY;
  const externallyPaused = row.status === "CAPTCHA_DETECTED" || row.status === "RATE_LIMITED" || row.status === "PAUSED";
  const stale = lastCheckedAgeSeconds > staleAfterSeconds;
  const status: HealthStatus = stale && !externallyPaused
    ? "FAIL"
    : row.status === "ACTIVE" ? "OK" : "WARN";
  const message = status === "FAIL"
    ? `Нет завершённой проверки ${Number.isFinite(lastCheckedAgeSeconds) ? `${lastCheckedAgeSeconds} с` : "с момента запуска"}`
    : status === "WARN"
      ? `Источник ограничен: ${row.status}`
      : `Проверка свежая: ${lastCheckedAgeSeconds} с назад`;
  return {
    source: row.source,
    status,
    sourceStatus: row.status,
    lastCheckedAt: row.lastCheckedAt,
    lastSuccessfulAt: row.lastSuccessfulAt,
    staleAfterSeconds,
    message,
  };
}

function liveIntervalSeconds(source: ListingSource, fallback: number): number {
  switch (source) {
    case "OLX": return env.LIVE_OLX_INTERVAL_SECONDS;
    case "CARS_UA": return env.LIVE_CARS_UA_INTERVAL_SECONDS;
    case "AUTOMOTO": return env.LIVE_AUTOMOTO_INTERVAL_SECONDS;
    case "RST": return env.LIVE_RST_INTERVAL_SECONDS;
    case "AUTO_RIA": return env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS;
    default: return fallback;
  }
}
