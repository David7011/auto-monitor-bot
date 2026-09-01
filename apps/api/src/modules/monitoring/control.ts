import { prisma, type ListingSource } from "@amb/db";
import { SOURCE_CAPABILITIES, type MonitoringStatusResponse } from "@amb/shared";
import { getQueueCounts } from "../../lib/queues.js";
import { env } from "../../env.js";
import { orchestrator } from "./orchestrator.js";

const LIVE_MONITOR_INTERVAL_SECONDS = 10;
const LIVE_MONITOR_JITTER_SECONDS = 2;
const STANDARD_MONITOR_INTERVAL_SECONDS = env.MONITOR_INTERVAL_SECONDS || 120;
const STANDARD_MONITOR_JITTER_SECONDS = env.MONITOR_JITTER_SECONDS || 20;
const LIVE_SOURCE_INTERVALS: Partial<Record<ListingSource, { intervalSeconds: number; jitterSeconds: number }>> = {
  AUTO_RIA: { intervalSeconds: autoRiaLiveIntervalSeconds(), jitterSeconds: env.LIVE_AUTO_RIA_JITTER_SECONDS },
  OLX: { intervalSeconds: env.LIVE_OLX_INTERVAL_SECONDS, jitterSeconds: env.LIVE_OLX_JITTER_SECONDS },
  CARS_UA: { intervalSeconds: env.LIVE_CARS_UA_INTERVAL_SECONDS, jitterSeconds: env.LIVE_CARS_UA_JITTER_SECONDS },
  AUTOMOTO: { intervalSeconds: env.LIVE_AUTOMOTO_INTERVAL_SECONDS, jitterSeconds: env.LIVE_AUTOMOTO_JITTER_SECONDS },
  RST: { intervalSeconds: env.LIVE_RST_INTERVAL_SECONDS, jitterSeconds: env.LIVE_RST_JITTER_SECONDS },
};

export async function startMonitoring() {
  await orchestrator.ensureState();
  const state = await orchestrator.start();
  return { ok: true, state };
}

export async function startLiveMonitoring() {
  await orchestrator.ensureState();
  await orchestrator.ensureSources();
  const sources = configuredScheduledSources();
  const now = new Date();

  await prisma.monitoringState.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      status: "STOPPED",
      intervalSeconds: LIVE_MONITOR_INTERVAL_SECONDS,
      jitterSeconds: LIVE_MONITOR_JITTER_SECONDS,
    },
    update: {
      intervalSeconds: LIVE_MONITOR_INTERVAL_SECONDS,
      jitterSeconds: LIVE_MONITOR_JITTER_SECONDS,
    },
  });

  for (const source of sources) {
    const live = LIVE_SOURCE_INTERVALS[source] ?? { intervalSeconds: LIVE_MONITOR_INTERVAL_SECONDS, jitterSeconds: LIVE_MONITOR_JITTER_SECONDS };
    await activateLiveSource(source, live, now);
  }

  const state = await orchestrator.start();
  return { ok: true, mode: "LIVE" as const, state, sources };
}

export async function startStandardMonitoring() {
  await orchestrator.ensureState();
  await orchestrator.ensureSources();
  const sources = configuredScheduledSources();
  const now = new Date();

  await prisma.monitoringState.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      status: "STOPPED",
      intervalSeconds: STANDARD_MONITOR_INTERVAL_SECONDS,
      jitterSeconds: STANDARD_MONITOR_JITTER_SECONDS,
    },
    update: {
      intervalSeconds: STANDARD_MONITOR_INTERVAL_SECONDS,
      jitterSeconds: STANDARD_MONITOR_JITTER_SECONDS,
    },
  });

  await prisma.source.updateMany({
    where: { source: { in: sources } },
    data: {
      intervalSeconds: STANDARD_MONITOR_INTERVAL_SECONDS,
      jitterSeconds: STANDARD_MONITOR_JITTER_SECONDS,
      nextCheckAt: now,
    },
  });

  const state = await orchestrator.start();
  return { ok: true, mode: "STANDARD" as const, state, sources };
}

export async function stopMonitoring() {
  const state = await orchestrator.stop();
  return { ok: true, state };
}

export async function getMonitoringStatus(): Promise<MonitoringStatusResponse<Date>> {
  const state = await orchestrator.ensureState();
  await orchestrator.ensureSources();
  const [sources, queueCounts, todayCount, lastRun, totalFilters, activeFilters, activeRealFilters] = await Promise.all([
    prisma.source.findMany({ orderBy: { name: "asc" } }),
    getQueueCounts(),
    prisma.listing.count({
      where: { firstSeenAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
    prisma.collectorRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.filter.count(),
    prisma.filter.count({ where: { enabled: true } }),
    prisma.filter.count({
      where: {
        enabled: true,
        sources: { hasSome: ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"] },
      },
    }),
  ]);

  return {
    state,
    sources: sources.map((source) => ({
      ...source,
      capabilities: SOURCE_CAPABILITIES[source.source],
    })),
    mode: monitoringMode(state, sources),
    queues: queueCounts,
    filters: {
      total: totalFilters,
      active: activeFilters,
      activeReal: activeRealFilters,
    },
    foundToday: todayCount,
    lastRun,
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  };
}

async function activateLiveSource(
  source: ListingSource,
  live: { intervalSeconds: number; jitterSeconds: number },
  now: Date,
): Promise<void> {
  const current = await prisma.source.findUnique({ where: { source } });
  const activePauseUntil = current?.pausedUntil != null && current.pausedUntil > now ? current.pausedUntil : null;

  await prisma.source.updateMany({
    where: { source },
    data: {
      enabled: true,
      intervalSeconds: live.intervalSeconds,
      jitterSeconds: live.jitterSeconds,
      nextCheckAt: activePauseUntil ?? now,
      ...(activePauseUntil
        ? {}
        : {
            status: "ACTIVE",
            pausedUntil: null,
            consecutiveErrors: 0,
            lastError: null,
          }),
    },
  });
}

export function configuredScheduledSources(): ListingSource[] {
  return env.AUTO_RIA_API_KEY
    ? ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"]
    : ["OLX", "RST", "CARS_UA", "AUTOMOTO"];
}

function autoRiaLiveIntervalSeconds(): number {
  const hourlyLimit = Math.max(1, env.AUTO_RIA_HOURLY_REQUEST_LIMIT);
  const quotaInterval = Math.ceil(3600 / hourlyLimit);
  return Math.max(env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS, quotaInterval);
}

export function monitoringMode(
  state: { status: string; intervalSeconds: number; jitterSeconds: number },
  sources: Array<{ source: ListingSource; enabled: boolean; intervalSeconds: number }>,
): "LIVE" | "STANDARD" {
  if (state.status !== "RUNNING") return "STANDARD";
  const liveSources = configuredScheduledSources();
  const liveLike = sources.filter((source) => liveSources.includes(source.source) && source.enabled);
  if (state.intervalSeconds <= LIVE_MONITOR_INTERVAL_SECONDS && liveLike.some((source) => source.intervalSeconds <= 20)) return "LIVE";
  return "STANDARD";
}
