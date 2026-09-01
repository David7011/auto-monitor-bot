import { prisma, type ListingSource, type Source } from "@amb/db";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_JITTER_SECONDS,
  QUEUE_NAMES,
  SOURCE_LABELS,
  intervalWithJitterMs,
} from "@amb/shared";
import { env } from "../../env.js";
import { logError, logInfo, logWarn } from "../../lib/error-log.js";
import { enqueue } from "../../lib/queues.js";
import {
  BACKFILL_EVIDENCE_TRIGGERS,
  backfillDue,
  backfillProfileFromMetrics,
  decideAdaptiveBackfill,
  targetedSources,
  type AdaptiveBackfillDecision,
  type AdaptiveBackfillEvidence,
} from "./backfill-policy.js";
import {
  deferOlxBackfillAfterRealtime,
  nextBackfillTickAfterAttempt,
  startupBackfillDeadline,
} from "./startup-backfill-policy.js";
import {
  prioritizeRealtimeSources,
  realtimeCollectorPriority,
  SCHEDULED_SOURCES,
} from "./realtime-source-priority.js";
import {
  decideOlxRealtimeCadence,
  type OlxRealtimeCadenceDecision,
} from "./olx-realtime-cadence.js";
import {
  evaluateOlxCadenceCanary,
} from "./olx-cadence-canary.js";
import type { OlxCadenceCanaryDecision } from "./olx-cadence-canary-policy.js";
import {
  coverageJobId,
  nextCoverageTickAfterAttempt,
  startupCoverageDeadline,
} from "./coverage-schedule.js";

const STATE_ID = "singleton";
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
  private activeTargetSources = new Set<ListingSource>();
  private backfillPolicyModes = new Map<string, string>();
  private olxCadenceSignature: string | null = null;

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
        nextBackfillTickAt: startupBackfillDeadline(now, null, env.BACKFILL_INITIAL_DELAY_SECONDS),
        nextCoverageTickAt: startupCoverageDeadline(now, null, env.OLX_COVERAGE_INITIAL_DELAY_SECONDS),
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
        nextCoverageTickAt: null,
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
    const resumedAt = new Date();
    await prisma.source.updateMany({
      where: { source: "OLX", enabled: true },
      data: { nextCheckAt: resumedAt },
    });
    const nextBackfillTickAt = startupBackfillDeadline(
      resumedAt,
      state.nextBackfillTickAt,
      env.BACKFILL_INITIAL_DELAY_SECONDS,
    );
    const nextCoverageTickAt = startupCoverageDeadline(
      resumedAt,
      state.nextCoverageTickAt,
      env.OLX_COVERAGE_INITIAL_DELAY_SECONDS,
    );
    if (
      !state.nextBackfillTickAt
      || state.nextBackfillTickAt.getTime() !== nextBackfillTickAt.getTime()
      || !state.nextCoverageTickAt
      || state.nextCoverageTickAt.getTime() !== nextCoverageTickAt.getTime()
    ) {
      await prisma.monitoringState.update({
        where: { id: STATE_ID },
        data: { nextBackfillTickAt, nextCoverageTickAt },
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

      const [enabledSources, activeFilters] = await Promise.all([
        prisma.source.findMany({
          where: { enabled: true, source: { in: [...SCHEDULED_SOURCES] } },
        }),
        prisma.filter.findMany({
          where: { enabled: true },
          select: { sources: true },
        }),
      ]);
      const targets = targetedSources(activeFilters, SCHEDULED_SOURCES);
      this.activeTargetSources = new Set(targets);
      const sources = prioritizeRealtimeSources(
        enabledSources.filter((source) => targets.has(source.source)),
      );
      let autoRiaContextCount: number | undefined;

      const realtimeEnqueued = new Set<ListingSource>();
      for (const source of sources) {
        let acceleratedCanary: OlxCadenceCanaryDecision | null = null;
        let acceleratedIncident: {
          status: string;
          detectedAt: Date;
          cooldownUntil: Date | null;
          recoveredAt: Date | null;
        } | null | undefined;
        if (
          source.source === "OLX"
          && (state.olxCanaryMode === "CANARY" || state.olxCanaryMode === "PROMOTED")
        ) {
          acceleratedIncident = await this.latestOlxIncident(source.id);
          acceleratedCanary = await evaluateOlxCadenceCanary({
            baseIntervalSeconds: source.intervalSeconds,
            baseJitterSeconds: source.jitterSeconds,
            protectionActive: source.status === "RATE_LIMITED"
              || source.status === "CAPTCHA_DETECTED"
              || Boolean(acceleratedIncident && (acceleratedIncident.status !== "RESOLVED" || !acceleratedIncident.recoveredAt)),
            now,
          });
          await this.reportOlxCanary(acceleratedCanary);
        }
        if (!sourceDue(source, now)) {
          continue;
        }
        if (source.source === "AUTO_RIA" && autoRiaContextCount == null) {
          autoRiaContextCount = await estimateAutoRiaContextCount();
        }
        let intervalSeconds = effectiveRealtimeIntervalSeconds(source, autoRiaContextCount ?? 1);
        let jitterSeconds = source.jitterSeconds;
        if (source.source === "OLX") {
          const incident = acceleratedIncident === undefined
            ? await this.latestOlxIncident(source.id)
            : acceleratedIncident;
          const canary = acceleratedCanary ?? await evaluateOlxCadenceCanary({
            baseIntervalSeconds: intervalSeconds,
            baseJitterSeconds: jitterSeconds,
            protectionActive: source.status === "RATE_LIMITED"
              || source.status === "CAPTCHA_DETECTED"
              || Boolean(incident && (incident.status !== "RESOLVED" || !incident.recoveredAt)),
            now,
          });
          intervalSeconds = canary.intervalSeconds;
          jitterSeconds = canary.jitterSeconds;
          await this.reportOlxCanary(canary);
          const cadence = decideOlxRealtimeCadence({
            configuredIntervalSeconds: intervalSeconds,
            configuredJitterSeconds: jitterSeconds,
            recoveryRampSeconds: env.OLX_REALTIME_RECOVERY_RAMP_SECONDS,
            incident,
            now,
          });
          intervalSeconds = cadence.intervalSeconds;
          jitterSeconds = cadence.jitterSeconds;
          await this.reportOlxCadence(cadence);
        }
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
          {
            jobId: `collector-${source.source}-${state.generation}-${dueTimestamp}`,
            priority: realtimeCollectorPriority(source.source),
          },
        );
        realtimeEnqueued.add(source.source);
        await prisma.source.update({
          where: { id: source.id },
          data: { nextCheckAt: new Date(now.getTime() + intervalWithJitterMs(intervalSeconds, jitterSeconds)) },
        });
      }

      let nextBackfillTickAt = state.nextBackfillTickAt;
      let backfillCycleCompleted = false;
      if (!nextBackfillTickAt) {
        nextBackfillTickAt = startupBackfillDeadline(now, null, env.BACKFILL_INITIAL_DELAY_SECONDS);
      } else if (nextBackfillTickAt <= now) {
        const backfill = await this.enqueueBackfill(sources, state.generation, now, realtimeEnqueued);
        backfillCycleCompleted = !backfill.deferred;
        nextBackfillTickAt = nextBackfillTickAfterAttempt(
          now,
          env.BACKFILL_INTERVAL_SECONDS,
          backfill.deferred,
        );
      }

      let nextCoverageTickAt = state.nextCoverageTickAt;
      let coverageCycleEnqueued = false;
      if (!nextCoverageTickAt) {
        nextCoverageTickAt = startupCoverageDeadline(now, null, env.OLX_COVERAGE_INITIAL_DELAY_SECONDS);
      } else if (nextCoverageTickAt <= now) {
        const olx = sources.find((source) => source.source === "OLX");
        if (olx && (!olx.pausedUntil || olx.pausedUntil <= now)) {
          await enqueue(
            QUEUE_NAMES.COLLECTOR_COVERAGE,
            "collect",
            {
              sourceId: olx.id,
              source: "OLX",
              trigger: "COVERAGE",
              lane: "COVERAGE",
              monitoringGeneration: state.generation,
              scheduledAt: now.toISOString(),
            },
            {
              jobId: coverageJobId(state.generation, nextCoverageTickAt),
            },
          );
          coverageCycleEnqueued = true;
        }
        nextCoverageTickAt = nextCoverageTickAfterAttempt(now, env.OLX_COVERAGE_INTERVAL_SECONDS);
      }

      await prisma.monitoringState.update({
        where: { id: STATE_ID },
        data: {
          lastTickAt: now,
          nextBackfillTickAt,
          nextCoverageTickAt,
          ...(state.nextBackfillTickAt && state.nextBackfillTickAt <= now && backfillCycleCompleted
            ? { lastBackfillTickAt: now }
            : {}),
          ...(coverageCycleEnqueued ? { lastCoverageTickAt: now } : {}),
        },
      });
    } catch (error) {
      await logError("orchestrator", "Tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.tickInProgress = false;
      await this.scheduleNext();
    }
  }

  private async enqueueBackfill(
    sources: Source[],
    generation: number,
    now: Date,
    realtimeEnqueued: ReadonlySet<ListingSource>,
  ): Promise<{ deferred: boolean }> {
    if (
      sources.some((source) => source.source === "OLX")
      && deferOlxBackfillAfterRealtime("OLX", realtimeEnqueued)
    ) {
      return { deferred: true };
    }
    for (const source of sources) {
      if (!BACKFILL_SOURCES.has(source.source)) continue;
      if (source.pausedUntil && source.pausedUntil > now) continue;
      const evidence = source.source === "OLX" ? await loadOlxBackfillEvidence(now) : undefined;
      const decision = evidence
        ? decideAdaptiveBackfill(evidence, env.BACKFILL_INTERVAL_SECONDS, now)
        : defaultBackfillDecision();
      const scheduledDecision = source.source === "OLX"
        ? {
            ...decision,
            intervalSeconds: Math.max(
              decision.intervalSeconds,
              env.OLX_BACKFILL_MIN_INTERVAL_SECONDS,
            ),
          }
        : decision;
      await this.reportBackfillPolicy(source.source, scheduledDecision);

      const lastBackfillAt = evidence?.runs[0]?.startedAt;
      if (source.source === "OLX" && !backfillDue(lastBackfillAt, scheduledDecision, now)) continue;

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
          backfillProfile: scheduledDecision.profile,
          backfillReason: scheduledDecision.reason,
        },
        { jobId: `collector-backfill-${source.source}-${generation}-${now.getTime()}` },
      );
    }
    return { deferred: false };
  }

  private async reportBackfillPolicy(source: string, decision: AdaptiveBackfillDecision): Promise<void> {
    if (source !== "OLX") return;
    const signature = `${decision.mode}:${decision.profile}:${decision.intervalSeconds}`;
    if (this.backfillPolicyModes.get(source) === signature) return;
    this.backfillPolicyModes.set(source, signature);
    await logInfo(
      "orchestrator",
      `${source} adaptive backfill mode changed to ${decision.mode}`,
      `profile=${decision.profile}; interval=${decision.intervalSeconds}s; reason=${decision.reason}`,
    );
  }

  private async reportOlxCadence(decision: OlxRealtimeCadenceDecision): Promise<void> {
    const signature = `${decision.mode}:${decision.intervalSeconds}:${decision.jitterSeconds}`;
    if (this.olxCadenceSignature === signature) return;
    this.olxCadenceSignature = signature;
    await logInfo(
      "orchestrator",
      `OLX realtime cadence changed to ${decision.mode}`,
      `interval=${decision.intervalSeconds}s; jitter=${decision.jitterSeconds}s; reason=${decision.reason}`,
    );
  }

  private async reportOlxCanary(decision: OlxCadenceCanaryDecision): Promise<void> {
    if (decision.transition === "NONE") return;
    const details = [
      `mode=${decision.mode}`,
      `interval=${decision.intervalSeconds}s`,
      `jitter=${decision.jitterSeconds}s`,
      `clean=${decision.cleanRunCount}`,
      `canary=${decision.canaryRunCount}`,
      `baselineP95=${decision.baselineP95Ms ?? "n/a"}ms`,
      `currentP95=${decision.currentP95Ms ?? "n/a"}ms`,
      `reason=${decision.reason}`,
    ].join("; ");
    if (decision.transition === "ROLLBACK") {
      await logWarn("olx-cadence-canary", "OLX cadence canary rolled back immediately", details);
      return;
    }
    await logInfo(
      "olx-cadence-canary",
      `OLX cadence canary transition: ${decision.transition}`,
      details,
    );
  }

  private latestOlxIncident(sourceId: string) {
    return prisma.challengeIncident.findFirst({
      where: { sourceId },
      orderBy: [{ detectedAt: "desc" as const }, { updatedAt: "desc" as const }],
      select: {
        status: true,
        detectedAt: true,
        cooldownUntil: true,
        recoveredAt: true,
      },
    });
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const now = Date.now();
    let delayMs = env.SCHEDULER_MAX_SLEEP_MS;
    try {
      const [state, nextSource] = await Promise.all([
        prisma.monitoringState.findUnique({ where: { id: STATE_ID } }),
        this.activeTargetSources.size > 0 ? prisma.source.findFirst({
          where: {
            enabled: true,
            status: { not: "DISABLED" },
            source: { in: [...this.activeTargetSources] },
            OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date(now) } }],
          },
          orderBy: { nextCheckAt: "asc" },
          select: { nextCheckAt: true },
        }) : Promise.resolve(null),
      ]);
      const deadlines = [nextSource?.nextCheckAt, state?.nextBackfillTickAt, state?.nextCoverageTickAt]
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

async function loadOlxBackfillEvidence(now: Date): Promise<AdaptiveBackfillEvidence> {
  const evidenceCutoff = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const anomalyCutoff = new Date(now.getTime() - 30 * 60 * 1000);
  const observationCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [runs, recoveredObservations, unresolvedObservationCount, realtimeAnomaly, adverseAudit] = await Promise.all([
    prisma.collectorRun.findMany({
      where: {
        source: "OLX",
        lane: "BACKFILL",
        trigger: { in: [...BACKFILL_EVIDENCE_TRIGGERS] },
        startedAt: { gte: evidenceCutoff },
      },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        startedAt: true,
        finishedAt: true,
        status: true,
        recoveredCount: true,
        errorMessage: true,
        coverageMetrics: true,
      },
    }),
    prisma.sourceSeenListing.findMany({
      where: {
        source: "OLX",
        discoveryLane: "BACKFILL",
        decision: "NOTIFIED",
        firstSeenAt: { gte: evidenceCutoff },
      },
      select: { firstSeenAt: true },
    }),
    prisma.sourceSeenListing.count({
      where: {
        source: "OLX",
        listingId: null,
        decision: { in: ["PENDING", "MATCHED", "FAILED"] },
        firstSeenAt: { gte: observationCutoff },
      },
    }),
    prisma.collectorRun.findFirst({
      where: {
        source: "OLX",
        lane: "REALTIME",
        startedAt: { gte: anomalyCutoff },
        status: { in: ["FAILED", "RATE_LIMITED", "CAPTCHA_DETECTED"] },
      },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
    prisma.completenessAudit.findFirst({
      where: {
        startedAt: { gte: evidenceCutoff },
        finishedAt: { not: null },
        OR: [
          { failedCount: { gt: 0 } },
          { pendingCount: { gt: 0 } },
        ],
      },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
  ]);

  return {
    runs: runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
      recoveredCount: Math.max(
        run.recoveredCount,
        recoveredObservations.filter((observation) =>
          observation.firstSeenAt >= run.startedAt
          && Boolean(run.finishedAt && observation.firstSeenAt <= run.finishedAt)
        ).length,
      ),
      errorMessage: run.errorMessage,
      profile: backfillProfileFromMetrics(run.coverageMetrics),
    })),
    unresolvedObservationCount,
    realtimeAnomalyAt: realtimeAnomaly?.startedAt,
    adverseAuditAt: adverseAudit?.startedAt,
  };
}

function defaultBackfillDecision(): AdaptiveBackfillDecision {
  return {
    mode: "EVIDENCE",
    profile: "FULL",
    intervalSeconds: env.BACKFILL_INTERVAL_SECONDS,
    reason: "fixed safety backfill for this source",
  };
}

export const orchestrator = new MonitoringOrchestrator();
