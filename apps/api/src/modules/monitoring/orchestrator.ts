import { prisma, type Source } from "@amb/db";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_JITTER_SECONDS,
  QUEUE_NAMES,
  SOURCE_LABELS,
  intervalWithJitterMs,
} from "@amb/shared";
import { env } from "../../env.js";
import { logError, logInfo } from "../../lib/error-log.js";
import { enqueue } from "../../lib/queues.js";

const STATE_ID = "singleton";
const SCHEDULED_SOURCES = ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO", "MOCK"] as const;
const BACKFILL_SOURCES = new Set(["OLX", "RST", "CARS_UA", "AUTOMOTO"]);

export function defaultSourceDefinitions(
  config: Pick<typeof env, "AUTO_RIA_API_KEY" | "MOCK_SOURCE_ENABLED" | "MONITOR_INTERVAL_SECONDS">,
) {
  return [
    { source: "AUTO_RIA", name: SOURCE_LABELS.AUTO_RIA ?? "AUTO.RIA", enabled: Boolean(config.AUTO_RIA_API_KEY), supportsNewestFirst: true, newestFirstVerified: true, intervalSeconds: env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS, jitterSeconds: env.LIVE_AUTO_RIA_JITTER_SECONDS },
    { source: "OLX", name: SOURCE_LABELS.OLX ?? "OLX", enabled: false, supportsNewestFirst: true, newestFirstVerified: true, intervalSeconds: env.LIVE_OLX_INTERVAL_SECONDS, jitterSeconds: env.LIVE_OLX_JITTER_SECONDS },
    { source: "RST", name: SOURCE_LABELS.RST ?? "RST", enabled: false, supportsNewestFirst: false, newestFirstVerified: false, intervalSeconds: env.LIVE_RST_INTERVAL_SECONDS, jitterSeconds: env.LIVE_RST_JITTER_SECONDS },
    { source: "CARS_UA", name: SOURCE_LABELS.CARS_UA ?? "Cars.ua", enabled: false, supportsNewestFirst: true, newestFirstVerified: false, intervalSeconds: env.LIVE_CARS_UA_INTERVAL_SECONDS, jitterSeconds: env.LIVE_CARS_UA_JITTER_SECONDS },
    { source: "AUTOMOTO", name: SOURCE_LABELS.AUTOMOTO ?? "AutoMoto.ua", enabled: false, supportsNewestFirst: false, newestFirstVerified: false, intervalSeconds: env.LIVE_AUTOMOTO_INTERVAL_SECONDS, jitterSeconds: env.LIVE_AUTOMOTO_JITTER_SECONDS },
    { source: "MOCK", name: SOURCE_LABELS.MOCK ?? "Mock Source", enabled: config.MOCK_SOURCE_ENABLED, supportsNewestFirst: true, newestFirstVerified: true, intervalSeconds: config.MONITOR_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS, jitterSeconds: DEFAULT_JITTER_SECONDS },
  ] as const;
}

export class MonitoringOrchestrator {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private running = false;

  async ensureState() {
    return prisma.monitoringState.upsert({
      where: { id: STATE_ID },
      create: {
        id: STATE_ID,
        status: "STOPPED",
        intervalSeconds: env.MONITOR_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS,
        jitterSeconds: env.MONITOR_JITTER_SECONDS || DEFAULT_JITTER_SECONDS,
        backfillIntervalSeconds: env.BACKFILL_INTERVAL_SECONDS,
      },
      update: { backfillIntervalSeconds: env.BACKFILL_INTERVAL_SECONDS },
    });
  }

  async ensureSources(): Promise<void> {
    for (const definition of defaultSourceDefinitions(env)) {
      await prisma.source.upsert({
        where: { source: definition.source },
        create: {
          source: definition.source,
          name: definition.name,
          enabled: definition.enabled,
          status: definition.enabled ? "ACTIVE" : "DISABLED",
          supportsNewestFirst: definition.supportsNewestFirst,
          newestFirstVerified: definition.newestFirstVerified,
          newestFirstVerifiedAt: definition.newestFirstVerified ? new Date() : null,
          intervalSeconds: definition.intervalSeconds,
          jitterSeconds: definition.jitterSeconds,
        },
        update: definition.source === "MOCK"
          ? {
              enabled: definition.enabled,
              status: definition.enabled ? "ACTIVE" : "DISABLED",
              supportsNewestFirst: definition.supportsNewestFirst,
              newestFirstVerified: definition.newestFirstVerified,
              newestFirstVerifiedAt: definition.newestFirstVerified ? new Date() : null,
              intervalSeconds: definition.intervalSeconds,
              jitterSeconds: definition.jitterSeconds,
            }
          : {
              supportsNewestFirst: definition.supportsNewestFirst,
              newestFirstVerified: definition.newestFirstVerified,
              newestFirstVerifiedAt: definition.newestFirstVerified ? new Date() : null,
            },
      });
    }
  }

  async start() {
    const currentState = await this.ensureState();
    if (currentState.status === "RUNNING" && this.running) return currentState;

    await prisma.monitoringState.update({ where: { id: STATE_ID }, data: { status: "STARTING" } });
    await this.ensureSources();
    const now = new Date();
    await prisma.source.updateMany({ where: { enabled: true }, data: { nextCheckAt: now } });

    this.running = true;
    const state = await prisma.monitoringState.update({
      where: { id: STATE_ID },
      data: {
        status: "RUNNING",
        generation: currentState.status === "RUNNING" ? currentState.generation : { increment: 1 },
        startedAt: now,
        stoppedAt: null,
        nextBackfillTickAt: new Date(now.getTime() + env.BACKFILL_INITIAL_DELAY_SECONDS * 1000),
      },
    });

    await logInfo("orchestrator", `Monitoring started, generation ${state.generation}`);
    void this.tick();
    return state;
  }

  async stop() {
    const currentState = await this.ensureState();
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const state = await prisma.monitoringState.update({
      where: { id: STATE_ID },
      data: {
        status: "STOPPED",
        stoppedAt: currentState.status === "STOPPED" ? currentState.stoppedAt : new Date(),
        nextTickAt: null,
        nextBackfillTickAt: null,
      },
    });
    await logInfo("orchestrator", `Monitoring stopped, generation ${state.generation}`);
    return state;
  }

  async resumeIfRunning(): Promise<void> {
    const state = await this.ensureState();
    if (state.status !== "RUNNING" && state.status !== "STARTING") return;
    this.running = true;
    await this.ensureSources();
    if (!state.nextBackfillTickAt) {
      await prisma.monitoringState.update({
        where: { id: STATE_ID },
        data: { nextBackfillTickAt: new Date(Date.now() + env.BACKFILL_INITIAL_DELAY_SECONDS * 1000) },
      });
    }
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    const now = new Date();

    try {
      const state = await this.ensureState();
      if (state.status !== "RUNNING") {
        this.running = false;
        return;
      }

      const sources = await prisma.source.findMany({
        where: { enabled: true, source: { in: [...SCHEDULED_SOURCES] } },
      });
      const autoRiaContextCount = sources.some((source) => source.source === "AUTO_RIA")
        ? await estimateAutoRiaContextCount()
        : 1;

      for (const source of sources) {
        if (!sourceDue(source, now)) continue;
        const intervalSeconds = effectiveRealtimeIntervalSeconds(source, autoRiaContextCount);
        const dueTimestamp = source.nextCheckAt?.getTime() ?? now.getTime();
        await enqueue(
          QUEUE_NAMES.COLLECTOR_RUN,
          "collect",
          {
            sourceId: source.id,
            source: source.source,
            trigger: "SCHEDULED",
            lane: "REALTIME",
            monitoringGeneration: state.generation,
            scheduledAt: now.toISOString(),
          },
          { jobId: `collector-${source.source}-${state.generation}-${dueTimestamp}` },
        );
        await prisma.source.update({
          where: { id: source.id },
          data: { nextCheckAt: new Date(now.getTime() + intervalWithJitterMs(intervalSeconds, source.jitterSeconds)) },
        });
      }

      let nextBackfillTickAt = state.nextBackfillTickAt;
      if (!nextBackfillTickAt) {
        nextBackfillTickAt = new Date(now.getTime() + env.BACKFILL_INITIAL_DELAY_SECONDS * 1000);
      } else if (nextBackfillTickAt <= now) {
        await this.enqueueBackfill(sources, state.generation, now);
        nextBackfillTickAt = new Date(now.getTime() + env.BACKFILL_INTERVAL_SECONDS * 1000);
      }

      await prisma.monitoringState.update({
        where: { id: STATE_ID },
        data: {
          lastTickAt: now,
          nextBackfillTickAt,
          ...(state.nextBackfillTickAt && state.nextBackfillTickAt <= now ? { lastBackfillTickAt: now } : {}),
        },
      });
    } catch (error) {
      await logError("orchestrator", "Tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.tickInProgress = false;
      await this.scheduleNext();
    }
  }

  private async enqueueBackfill(sources: Source[], generation: number, now: Date): Promise<void> {
    for (const source of sources) {
      if (!BACKFILL_SOURCES.has(source.source)) continue;
      if (source.pausedUntil && source.pausedUntil > now) continue;
      await enqueue(
        QUEUE_NAMES.COLLECTOR_BACKFILL,
        "collect",
        {
          sourceId: source.id,
          source: source.source,
          trigger: "BACKFILL",
          lane: "BACKFILL",
          monitoringGeneration: generation,
          scheduledAt: now.toISOString(),
        },
        { jobId: `collector-backfill-${source.source}-${generation}-${now.getTime()}` },
      );
    }
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const now = Date.now();
    let delayMs = env.SCHEDULER_MAX_SLEEP_MS;
    try {
      const [state, nextSource] = await Promise.all([
        prisma.monitoringState.findUnique({ where: { id: STATE_ID } }),
        prisma.source.findFirst({
          where: {
            enabled: true,
            status: { not: "DISABLED" },
            source: { in: [...SCHEDULED_SOURCES] },
            OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date(now) } }],
          },
          orderBy: { nextCheckAt: "asc" },
          select: { nextCheckAt: true },
        }),
      ]);
      const deadlines = [nextSource?.nextCheckAt, state?.nextBackfillTickAt]
        .filter((value): value is Date => Boolean(value))
        .map((value) => value.getTime());
      if (deadlines.length > 0) delayMs = Math.min(delayMs, Math.max(0, Math.min(...deadlines) - now));
    } catch {
      delayMs = env.SCHEDULER_MAX_SLEEP_MS;
    }

    delayMs = Math.max(env.SCHEDULER_MIN_SLEEP_MS, Math.min(env.SCHEDULER_MAX_SLEEP_MS, delayMs));
    const nextTickAt = new Date(now + delayMs);
    await prisma.monitoringState.update({ where: { id: STATE_ID }, data: { nextTickAt } }).catch(() => undefined);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }
}

function sourceDue(source: Source, now: Date): boolean {
  if (source.status === "DISABLED") return false;
  if (source.pausedUntil && source.pausedUntil > now) return false;
  return !source.nextCheckAt || source.nextCheckAt <= now;
}

function effectiveRealtimeIntervalSeconds(source: Source, autoRiaContextCount: number): number {
  if (source.source !== "AUTO_RIA") return Math.max(1, source.intervalSeconds);
  const hourlySearchBudget = Math.max(
    1,
    Math.min(env.AUTO_RIA_SEARCH_REQUESTS_PER_HOUR, env.AUTO_RIA_HOURLY_REQUEST_LIMIT),
  );
  const quotaSafeInterval = Math.ceil((3600 * Math.max(1, autoRiaContextCount)) / hourlySearchBudget);
  return Math.max(source.intervalSeconds, env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS, quotaSafeInterval);
}

async function estimateAutoRiaContextCount(): Promise<number> {
  const filters = await prisma.filter.findMany({
    where: {
      enabled: true,
      OR: [{ sources: { has: "AUTO_RIA" } }, { sources: { isEmpty: true } }],
    },
    select: {
      autoRiaCategoryId: true,
      autoRiaMarkId: true,
      autoRiaModelId: true,
      bodyTypes: true,
      fuelTypes: true,
      gearboxes: true,
      yearFrom: true,
      yearTo: true,
      priceFrom: true,
      priceTo: true,
      mileageFrom: true,
      mileageTo: true,
      engineVolumeFrom: true,
      engineVolumeTo: true,
      regions: true,
      cities: true,
      freshnessMode: true,
    },
  });
  if (filters.length === 0) return 1;
  const fingerprints = new Set(filters.map((filter) => JSON.stringify(filter, Object.keys(filter).sort())));
  return Math.max(1, fingerprints.size);
}

export const orchestrator = new MonitoringOrchestrator();
