import { prisma, type ListingSource, type Source } from "@amb/db";
import { QUEUE_NAMES } from "@amb/shared";
import { enqueue, redisConnection } from "../../lib/queues.js";
import { env } from "../../env.js";
import { orchestrator } from "../monitoring/orchestrator.js";

const BULK_REAL_SOURCES = ["OLX", "RST", "CARS_UA", "AUTOMOTO"] as const;

export type ManualCheckBlocked = {
  ok: false;
  statusCode: 409;
  body: {
    error: string;
    code: "MONITORING_STOPPED";
    allowManualCheckWhenStopped: false;
  };
};

export type ManualCheckResult = {
  ok: true;
  queued: ListingSource[];
  deduplicated: ListingSource[];
  count: number;
};

export async function getSourcesStatus() {
  await orchestrator.ensureSources();
  const sources = await prisma.source.findMany({ orderBy: { name: "asc" } });
  const runs = await prisma.collectorRun.findMany({
    where: {
      OR: [
        { errorMessage: null },
        {
          NOT: {
            errorMessage: {
              contains: "supportsNewestFirst",
            },
          },
        },
      ],
    },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  const challengeIncidents = await prisma.challengeIncident.findMany({
    orderBy: { detectedAt: "desc" },
    take: 20,
    include: { source: { select: { source: true, name: true } } },
  });
  return { sources, recentRuns: runs, challengeIncidents };
}

export async function checkActiveSourcesNow(): Promise<ManualCheckResult | ManualCheckBlocked> {
  const manualAllowed = await ensureManualCheckAllowed();
  if (!manualAllowed.ok) return manualAllowed;

  const sources = await prisma.source.findMany({
    where: {
      enabled: true,
      status: { in: ["ACTIVE", "LIMITED"] },
      source: { in: ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"] },
    },
    orderBy: { name: "asc" },
  });

  const queued: ListingSource[] = [];
  const deduplicated: ListingSource[] = [];
  for (const source of sources) {
    const result = await enqueueManualCollector(source);
    if (result.queued) queued.push(source.source);
    if (result.deduplicated) deduplicated.push(source.source);
  }

  return { ok: true, queued, deduplicated, count: queued.length };
}

export async function checkSourceNow(source: Source): Promise<{ ok: true; queued: boolean; deduplicated: boolean } | ManualCheckBlocked> {
  const manualAllowed = await ensureManualCheckAllowed();
  if (!manualAllowed.ok) return manualAllowed;

  const result = await enqueueManualCollector(source);
  return { ok: true, ...result };
}

export async function enableBulkRealSources(): Promise<{ ok: true; updated: number; sources: ListingSource[] }> {
  await orchestrator.ensureSources();
  const sources = configuredBulkRealSources();
  let updated = 0;
  for (const source of sources) {
    updated += await enableRealSource(source);
  }
  return { ok: true, updated, sources };
}

export async function disableBulkRealSources(): Promise<{ ok: true; updated: number; sources: ListingSource[] }> {
  const sources = configuredBulkRealSources();
  const result = await prisma.source.updateMany({
    where: { source: { in: sources } },
    data: {
      enabled: false,
      status: "DISABLED",
    },
  });
  return { ok: true, updated: result.count, sources };
}

async function enableRealSource(source: ListingSource): Promise<number> {
  const current = await prisma.source.findUnique({ where: { source } });
  const activePauseUntil = current?.pausedUntil != null && current.pausedUntil > new Date() ? current.pausedUntil : null;
  const result = await prisma.source.updateMany({
    where: { source },
    data: {
      enabled: true,
      nextCheckAt: activePauseUntil ?? new Date(),
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
  return result.count;
}

async function ensureManualCheckAllowed(): Promise<{ ok: true } | ManualCheckBlocked> {
  if (env.ALLOW_MANUAL_CHECK_WHEN_STOPPED) return { ok: true };
  const state = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
  if (!state || state.status === "RUNNING") return { ok: true };
  return {
    ok: false,
    statusCode: 409,
    body: {
      error: "Manual source check is disabled while monitoring is stopped",
      code: "MONITORING_STOPPED",
      allowManualCheckWhenStopped: false,
    },
  };
}

async function enqueueManualCollector(source: Source): Promise<{ queued: boolean; deduplicated: boolean }> {
  const dedupSeconds = Math.max(1, env.MANUAL_CHECK_DEDUP_SECONDS || 30);
  const dedupKey = `collector:${source.id}:manual`;
  const dedup = await redisConnection.set(dedupKey, String(Date.now()), "EX", dedupSeconds, "NX");
  if (dedup !== "OK") return { queued: false, deduplicated: true };

  await enqueue(
    QUEUE_NAMES.COLLECTOR_RUN,
    "collect",
    {
      sourceId: source.id,
      source: source.source,
      trigger: "MANUAL",
      scheduledAt: new Date().toISOString(),
    },
    { jobId: manualCollectorJobId(source.source, dedupSeconds) },
  );
  await prisma.source.update({
    where: { id: source.id },
    data: { nextCheckAt: new Date() },
  });
  return { queued: true, deduplicated: false };
}

function manualCollectorJobId(source: string, dedupSeconds: number): string {
  return `collector-${source}-manual-${Math.floor(Date.now() / (dedupSeconds * 1000))}`;
}

function configuredBulkRealSources(): ListingSource[] {
  return env.AUTO_RIA_API_KEY ? ["AUTO_RIA", ...BULK_REAL_SOURCES] : [...BULK_REAL_SOURCES];
}
