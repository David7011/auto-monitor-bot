import type { FastifyInstance } from "fastify";
import {
  getDatabasePoolDiagnostics,
  prisma,
  type DatabasePoolDiagnostics,
  type ListingSource,
  type SourceStatus,
} from "@amb/db";
import {
  BACKGROUND_WORKER_HEARTBEAT_KEY,
  HOT_WORKER_LEADER_KEY,
  HOT_WORKER_REPLICA_HEARTBEAT_KEYS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_MS,
} from "@amb/shared";
import { env } from "../env.js";
import {
  getQueueCounts,
  getRedisDiagnostics,
  queueFailureSummary,
  redisConnection,
} from "../lib/queues.js";
import { workerHealthStatus } from "../lib/worker-health.js";
import { apiStartedAt } from "../lib/runtime-lifecycle.js";
import {
  getListingRetentionHealth,
  type HealthStatus,
  type ListingRetentionHealth,
} from "./system-retention-health.js";

export async function systemHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/live", async () => ({
    status: "OK",
    startedAt: apiStartedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      const [, redisPong, heartbeat, leaderValue, leaderTtlMs] = await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redisConnection.ping(),
        redisConnection.get(WORKER_HEARTBEAT_KEY),
        redisConnection.get(HOT_WORKER_LEADER_KEY),
        redisConnection.pttl(HOT_WORKER_LEADER_KEY),
      ]);
      const heartbeatDetails = workerHeartbeatDetails(heartbeat, new Date());
      if (
        redisPong !== "PONG"
        || !heartbeatDetails.fresh
        || leaderTtlMs <= 0
        || !leaderMatchesHeartbeat(leaderValue, heartbeatDetails)
      ) {
        return reply.code(503).send({
          status: "FAIL",
          reason: "hot worker leader lease or heartbeat is missing, stale, or inconsistent",
        });
      }
      return { status: "OK" };
    } catch (error) {
      return reply.code(503).send({
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/health", async () => {
    const checkedAt = new Date();
    let database: {
      status: HealthStatus;
      latencyMs?: number;
      message: string;
      pool: DatabasePoolDiagnostics;
    };
    let redis: {
      status: HealthStatus;
      queues?: Awaited<ReturnType<typeof getQueueCounts>>;
      message: string;
    };
    let listingRetention: ListingRetentionHealth = {
      status: "IDLE",
      dueNow: 0,
      overdue: 0,
      unmanagedFresh: 0,
      invalid: 0,
      message: "Диагностика хранения недоступна без PostgreSQL",
    };

    const dbStartedAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = {
        status: "OK",
        latencyMs: Date.now() - dbStartedAt,
        message: "PostgreSQL доступен",
        pool: getDatabasePoolDiagnostics(),
      };
    } catch (err) {
      database = {
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
        pool: getDatabasePoolDiagnostics(),
      };
    }

    try {
      const [diagnostics, queues] = await Promise.all([getRedisDiagnostics(), getQueueCounts()]);
      const failures = queueFailureSummary(queues);
      redis = {
        status: failures.recent > 0 ? "WARN" : "OK",
        queues,
        message: failures.recent > 0
          ? `Redis ${diagnostics.version}: недавних BullMQ-сбоев: ${failures.recent}; исторических: ${failures.historical}`
          : failures.historical > 0
            ? `Redis ${diagnostics.version} и BullMQ доступны; исторических завершённых сбоев: ${failures.historical}`
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
      pausedUntil: Date | null;
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
          .map((row) => sourceHealthEntry(row, checkedAt, state?.status === "RUNNING"));
        activeSources = sourceHealth.length;
      } catch {
        database.status = "WARN";
        database.message = "PostgreSQL доступен, но подробная диагностика завершилась ошибкой";
      }
    }

    if (database.status !== "FAIL") {
      try {
        listingRetention = await getListingRetentionHealth(checkedAt);
      } catch (err) {
        listingRetention = {
          status: "FAIL",
          dueNow: 0,
          overdue: 0,
          unmanagedFresh: 0,
          invalid: 0,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const monitoringRunning = monitoringState?.status === "RUNNING";
    const heartbeats = redis.status === "FAIL"
      ? [null, null, null, null, null, -2] as const
      : await redisConnection
        .multi()
        .mget(
          WORKER_HEARTBEAT_KEY,
          BACKGROUND_WORKER_HEARTBEAT_KEY,
          HOT_WORKER_REPLICA_HEARTBEAT_KEYS.a,
          HOT_WORKER_REPLICA_HEARTBEAT_KEYS.b,
        )
        .get(HOT_WORKER_LEADER_KEY)
        .pttl(HOT_WORKER_LEADER_KEY)
        .exec()
        .then((result) => {
          const values = result?.[0]?.[1] as Array<string | null> | undefined;
          return [
            values?.[0] ?? null,
            values?.[1] ?? null,
            values?.[2] ?? null,
            values?.[3] ?? null,
            (result?.[1]?.[1] as string | null | undefined) ?? null,
            Number(result?.[2]?.[1] ?? -2),
          ] as const;
        })
        .catch(() => [null, null, null, null, null, -2] as const);
    const heartbeat = heartbeats[0] ?? null;
    const backgroundHeartbeat = heartbeats[1] ?? null;
    const replicaAHeartbeat = heartbeats[2] ?? null;
    const replicaBHeartbeat = heartbeats[3] ?? null;
    const leaderValue = heartbeats[4] ?? null;
    const leaderTtlMs = heartbeats[5];
    const hotDetails = workerHeartbeatDetails(heartbeat, checkedAt);
    const replicaADetails = workerHeartbeatDetails(replicaAHeartbeat, checkedAt);
    const replicaBDetails = workerHeartbeatDetails(replicaBHeartbeat, checkedAt);
    const liveReplicaCount = Number(replicaADetails.fresh) + Number(replicaBDetails.fresh);
    const leaderConsistent = leaderTtlMs > 0 && leaderMatchesHeartbeat(leaderValue, hotDetails);
    const workerStale = !freshWorkerHeartbeat(heartbeat, checkedAt);
    const backgroundWorkerStale = !freshWorkerHeartbeat(backgroundHeartbeat, checkedAt);
    const sourceDegraded = sourceHealth.some((source) => source.status === "WARN" || source.status === "FAIL");
    const hotWorkerStatus: HealthStatus = workerHealthStatus({
      monitoringRunning,
      heartbeatStale: workerStale,
      hasSuccessfulScan: Boolean(lastSuccessfulScan),
      sourceStatuses: sourceHealth.map((source) => source.status),
    });
    const workerStatus: HealthStatus = hotWorkerStatus === "OK" && backgroundWorkerStale
      ? "WARN"
      : hotWorkerStatus;

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
        roles: {
          hot: hotDetails,
          background: workerHeartbeatDetails(backgroundHeartbeat, checkedAt),
        },
        hotRedundancy: {
          status: liveReplicaCount === 2 && leaderConsistent
            ? "REDUNDANT"
            : liveReplicaCount >= 1 && leaderConsistent
              ? "DEGRADED"
              : "FAIL",
          liveReplicas: liveReplicaCount,
          leaderConsistent,
          leaderLeaseTtlMs: Math.max(-1, leaderTtlMs),
          replicas: {
            a: replicaADetails,
            b: replicaBDetails,
          },
        },
        message: monitoringRunning
          ? workerStale
            ? "Heartbeat hot worker отсутствует или устарел; realtime требует точечного восстановления"
            : backgroundWorkerStale
              ? "Realtime работает, но background worker требует точечного восстановления"
            : sourceDegraded
              ? "Основной worker работает, но отдельные источники ограничены внешней защитой"
              : lastSuccessfulScan
                ? "Сборщики регулярно завершают проверки"
                : "Мониторинг запущен, но успешных проверок пока нет"
          : liveReplicaCount === 2 && leaderConsistent
            ? "Мониторинг остановлен; оба hot-worker готовы к немедленному failover"
            : "Мониторинг остановлен; резервирование hot-worker требует восстановления",
      },
      telegramBot: {
        status: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? "OK" : "NOT_CONFIGURED",
        message: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? "Токен бота и получатель настроены"
          : "Telegram-бот не настроен",
      },
      listingRetention,
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
}

function freshWorkerHeartbeat(value: string | null, now: Date): boolean {
  return workerHeartbeatDetails(value, now).fresh;
}

function workerHeartbeatDetails(value: string | null, now: Date) {
  if (!value) {
    return { fresh: false, pid: null, instanceId: null, leadership: null, startedAt: null, checkedAt: null, eventLoopDelayP95Ms: null, eventLoopUtilization: null };
  }
  try {
    const parsed = JSON.parse(value) as {
      role?: unknown;
      pid?: unknown;
      startedAt?: unknown;
      checkedAt?: unknown;
      eventLoopDelayP95Ms?: unknown;
      eventLoopUtilization?: unknown;
      instanceId?: unknown;
      leadership?: unknown;
    };
    const checkedAt = typeof parsed.checkedAt === "string" ? new Date(parsed.checkedAt) : null;
    const fresh = Boolean(
      checkedAt
      && Number.isFinite(checkedAt.getTime())
      && now.getTime() - checkedAt.getTime() <= WORKER_HEARTBEAT_TTL_MS,
    );
    return {
      fresh,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      instanceId: parsed.instanceId === "a" || parsed.instanceId === "b" ? parsed.instanceId : null,
      leadership: parsed.leadership === "leader" || parsed.leadership === "standby" ? parsed.leadership : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      checkedAt: checkedAt && Number.isFinite(checkedAt.getTime()) ? checkedAt.toISOString() : null,
      eventLoopDelayP95Ms: typeof parsed.eventLoopDelayP95Ms === "number" ? parsed.eventLoopDelayP95Ms : null,
      eventLoopUtilization: typeof parsed.eventLoopUtilization === "number" ? parsed.eventLoopUtilization : null,
    };
  } catch {
    return { fresh: false, pid: null, instanceId: null, leadership: null, startedAt: null, checkedAt: null, eventLoopDelayP95Ms: null, eventLoopUtilization: null };
  }
}

function leaderMatchesHeartbeat(
  leaderValue: string | null,
  heartbeat: ReturnType<typeof workerHeartbeatDetails>,
): boolean {
  if (!leaderValue || !heartbeat.fresh || heartbeat.leadership !== "leader") return false;
  try {
    const leader = JSON.parse(leaderValue) as { instanceId?: unknown; pid?: unknown; token?: unknown };
    return (leader.instanceId === "a" || leader.instanceId === "b")
      && typeof leader.pid === "number"
      && typeof leader.token === "string"
      && leader.token.length > 0
      && leader.instanceId === heartbeat.instanceId
      && leader.pid === heartbeat.pid
      && localProcessAlive(leader.pid);
  } catch {
    return false;
  }
}

function localProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function configuredTargetSources(
  filters: Array<{ sources: ListingSource[] }>,
  availableSources: ListingSource[],
): Set<ListingSource> {
  if (filters.some((filter) => filter.sources.length === 0)) return new Set(availableSources);
  return new Set(filters.flatMap((filter) => filter.sources));
}

export function sourceHealthEntry(
  row: {
    source: ListingSource;
    status: SourceStatus;
    intervalSeconds: number;
    lastCheckedAt: Date | null;
    lastSuccessfulAt: Date | null;
    pausedUntil: Date | null;
  },
  checkedAt: Date,
  monitoringRunning = true,
) {
  const expectedInterval = liveIntervalSeconds(row.source, row.intervalSeconds);
  const staleAfterSeconds = Math.max(60, expectedInterval * 5);
  const lastCheckedAgeSeconds = row.lastCheckedAt
    ? Math.max(0, Math.round((checkedAt.getTime() - row.lastCheckedAt.getTime()) / 1000))
    : Number.POSITIVE_INFINITY;
  const externallyPaused = row.status === "CAPTCHA_DETECTED"
    || row.status === "RATE_LIMITED"
    || row.status === "PAUSED";
  const stale = lastCheckedAgeSeconds > staleAfterSeconds;
  const status: HealthStatus = !monitoringRunning
    ? "IDLE"
    : stale && !externallyPaused
      ? "FAIL"
      : row.status === "ACTIVE"
        ? "OK"
        : "WARN";
  const message = status === "IDLE"
    ? `Мониторинг остановлен; свежесть не оценивается (статус источника: ${row.status})`
    : status === "FAIL"
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
    pausedUntil: row.pausedUntil,
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
