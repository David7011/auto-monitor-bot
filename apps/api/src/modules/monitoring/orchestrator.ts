import { prisma, type ListingSource, type MonitoringState, type Source } from "@amb/db";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_JITTER_SECONDS,
  QUEUE_NAMES,
  SOURCE_LABELS,
  intervalWithJitterMs,
  olxRecoveryAttemptGeneration,
  olxRecoveryRetryEligible,
} from "@amb/shared";
import { autoRiaRealtimeIntervalSeconds, autoRiaSearchBudgetPerHour } from "../../lib/auto-ria-plan.js";
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
  deferOriginSensitiveBackfillAfterRealtime,
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
import {
  recordEffectiveCadence,
  resolveOlxEffectiveCadence,
  type EffectiveCadenceDecision,
} from "./effective-cadence.js";

const STATE_ID = "singleton";
const BACKFILL_SOURCES = new Set(["OLX", "RST", "CARS_UA", "AUTOMOTO"]);

export function defaultSourceDefinitions(
  config: Pick<typeof env, "AUTO_RIA_API_KEY" | "MOCK_SOURCE_ENABLED" | "MONITOR_INTERVAL_SECONDS">,
) {
  return [
    { source: "AUTO_RIA", name: SOURCE_LABELS.AUTO_RIA ?? "AUTO.RIA", enabled: true, supportsNewestFirst: true, newestFirstVerified: true, intervalSeconds: env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS, jitterSeconds: env.LIVE_AUTO_RIA_JITTER_SECONDS },
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
  private backgroundTickInProgress = false;
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
    // Thundering-herd guard: after a (re)start every enabled source is due at
    // once and the burst coalesces realtime ticks into SKIPPED holes (+20-40s
    // each). Spread only the past-due first deadlines over ~15s; legitimate
    // future deadlines (pauses, steady-state cadence) are never pulled forward.
    // Steady-state jitter takes over from the second tick on.
    const STARTUP_STAGGER_MS = 3_000;
    const dueSources = await prisma.source.findMany({
      where: { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
      select: { source: true },
      orderBy: { source: "asc" },
    });
    for (const [index, row] of dueSources.entries()) {
      await prisma.source.update({
        where: { source: row.source },
        data: { nextCheckAt: new Date(now.getTime() + index * STARTUP_STAGGER_MS) },
      });
    }

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
    // Same thundering-herd guard as start(), but scoped to sources that are
    // actually overdue (an API reboot must not pull future deadlines forward).
    const RESUME_STAGGER_MS = 3_000;
    const overdueSources = await prisma.source.findMany({
      where: { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: resumedAt } }] },
      select: { source: true },
      orderBy: { source: "asc" },
    });
    for (const [index, row] of overdueSources.entries()) {
      await prisma.source.update({
        where: { source: row.source },
        data: { nextCheckAt: new Date(resumedAt.getTime() + index * RESUME_STAGGER_MS) },
      });
    }
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
        if (
          source.source === "OLX"
          && !sourceDue(source, now)
          && (source.status === "RATE_LIMITED" || source.status === "CAPTCHA_DETECTED")
        ) {
          const incident = acceleratedIncident === undefined
            ? await this.latestOlxIncident(source.id)
            : acceleratedIncident;
          const recovery = decideOlxRealtimeCadence({
            configuredIntervalSeconds: source.intervalSeconds,
            configuredJitterSeconds: source.jitterSeconds,
            recoveryRampSeconds: env.OLX_REALTIME_RECOVERY_RAMP_SECONDS,
            incident,
            now,
          });
          const effective = resolveOlxEffectiveCadence({
            persistedIntervalSeconds: source.intervalSeconds,
            persistedJitterSeconds: source.jitterSeconds,
            liveIntervalSeconds: env.LIVE_OLX_INTERVAL_SECONDS,
            liveJitterSeconds: env.LIVE_OLX_JITTER_SECONDS,
            standardIntervalSeconds: env.MONITOR_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS,
            standardJitterSeconds: env.MONITOR_JITTER_SECONDS || DEFAULT_JITTER_SECONDS,
            protectionActive: true,
            canary: {
              mode: state.olxCanaryMode,
              intervalSeconds: source.intervalSeconds,
              jitterSeconds: source.jitterSeconds,
              reason: state.olxCanaryRollbackReason ?? "protection status overrides canary",
            },
            recovery,
          });
          await recordEffectiveCadence({
            source: "OLX",
            ...effective,
            observedAt: now,
            nextExpectedRunAt: source.nextCheckAt,
          });
        }
        if (!sourceDue(source, now)) {
          continue;
        }
        if (source.source === "AUTO_RIA" && autoRiaContextCount == null) {
          autoRiaContextCount = await estimateAutoRiaContextCount();
        }
        let intervalSeconds = effectiveRealtimeIntervalSeconds(source, autoRiaContextCount ?? 1);
        let jitterSeconds = source.jitterSeconds;
        let effectiveCadence: EffectiveCadenceDecision | null = null;
        if (source.source === "OLX") {
          const incident = acceleratedIncident === undefined
            ? await this.latestOlxIncident(source.id)
            : acceleratedIncident;
          const protectionActive = source.status === "RATE_LIMITED"
            || source.status === "CAPTCHA_DETECTED"
            || Boolean(incident && (incident.status !== "RESOLVED" || !incident.recoveredAt));
          const canary = acceleratedCanary ?? await evaluateOlxCadenceCanary({
            baseIntervalSeconds: intervalSeconds,
            baseJitterSeconds: jitterSeconds,
            protectionActive,
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
          effectiveCadence = resolveOlxEffectiveCadence({
            persistedIntervalSeconds: source.intervalSeconds,
            persistedJitterSeconds: source.jitterSeconds,
            liveIntervalSeconds: env.LIVE_OLX_INTERVAL_SECONDS,
            liveJitterSeconds: env.LIVE_OLX_JITTER_SECONDS,
            standardIntervalSeconds: env.MONITOR_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS,
            standardJitterSeconds: env.MONITOR_JITTER_SECONDS || DEFAULT_JITTER_SECONDS,
            protectionActive,
            canary,
            recovery: cadence,
          });
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
            expectedRunAt: source.source === "OLX" ? source.nextCheckAt?.toISOString() : undefined,
            cadenceMode: effectiveCadence?.mode,
            cadenceIntervalSeconds: effectiveCadence?.intervalSeconds,
            cadenceJitterSeconds: effectiveCadence?.jitterSeconds,
          },
          {
            jobId: `collector-${source.source}-${state.generation}-${dueTimestamp}`,
            priority: realtimeCollectorPriority(source.source),
          },
        );
        realtimeEnqueued.add(source.source);
        const nextExpectedRunAt = new Date(now.getTime() + intervalWithJitterMs(intervalSeconds, jitterSeconds));
        await prisma.source.update({
          where: { id: source.id },
          data: { nextCheckAt: nextExpectedRunAt },
        });
        if (source.source === "OLX" && effectiveCadence) {
          await recordEffectiveCadence({
            source: "OLX",
            ...effectiveCadence,
            observedAt: now,
            nextExpectedRunAt,
          });
        }
      }

      // Historical evidence queries and recovery planning can be slow. Keep
      // one background scheduler in flight without holding the realtime clock.
      void this.tickBackground(sources, state, now, realtimeEnqueued);
      await prisma.monitoringState.update({
        where: { id: STATE_ID },
        data: { lastTickAt: now },
      });
    } catch (error) {
      await logError("orchestrator", "Tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.tickInProgress = false;
      await this.scheduleNext();
    }
  }

  private async tickBackground(
    sources: Source[],
    state: MonitoringState,
    now: Date,
    realtimeEnqueued: ReadonlySet<ListingSource>,
  ): Promise<void> {
    if (!this.running || this.backgroundTickInProgress) return;
    this.backgroundTickInProgress = true;
    try {
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
        if (olx && (!olx.pausedUntil || olx.pausedUntil <= now)
          && await this.backgroundGenerationCurrent(state.generation)) {
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

      await prisma.monitoringState.updateMany({
        where: { id: STATE_ID, generation: state.generation, status: "RUNNING" },
        data: {
          nextBackfillTickAt,
          nextCoverageTickAt,
          ...(state.nextBackfillTickAt && state.nextBackfillTickAt <= now && backfillCycleCompleted
            ? { lastBackfillTickAt: now }
            : {}),
          ...(coverageCycleEnqueued ? { lastCoverageTickAt: now } : {}),
        },
      });
    } catch (error) {
      await logError("orchestrator", "Background scheduling failed", error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
    } finally {
      this.backgroundTickInProgress = false;
    }
  }

  private async enqueueBackfill(
    sources: Source[],
    generation: number,
    now: Date,
    realtimeEnqueued: ReadonlySet<ListingSource>,
  ): Promise<{ deferred: boolean }> {
    if (sources.some((source) =>
      BACKFILL_SOURCES.has(source.source)
      && deferOriginSensitiveBackfillAfterRealtime(source.source, realtimeEnqueued)
    )) {
      return { deferred: true };
    }
    for (const source of sources) {
      if (source.source === "AUTO_RIA" && env.AUTO_RIA_ACCESS_MODE === "public") {
        // Retry durable catch-up after crash/restart even if realtime already moved its boundary.
        const due = await prisma.sourceSearchState.count({ where: { source: "AUTO_RIA",
          coverageRecoveryPending: true, OR: [{ recoveryNextAttemptAt: null }, { recoveryNextAttemptAt: { lte: now } }] } });
        if (due && !(source.pausedUntil && source.pausedUntil > now)
          && await this.backgroundGenerationCurrent(generation)) {
          await enqueue(QUEUE_NAMES.COLLECTOR_BACKFILL, "collect", {
            sourceId: source.id, source: source.source, trigger: "RECOVERY", lane: "BACKFILL",
            monitoringGeneration: generation, scheduledAt: now.toISOString(),
          }, { jobId: `collector-recovery-AUTO_RIA-${generation}-${now.getTime()}` });
        }
      }
      if (!BACKFILL_SOURCES.has(source.source)) continue;
      if (source.pausedUntil && source.pausedUntil > now) continue;
      if (source.source === "OLX") await rearmOlxRecoveryForChangedCapability(now);
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
      const recoveryPending = source.source === "OLX" && (evidence?.pendingRecoveryCount ?? 0) > 0;
      const recoveryDue = recoveryPending
        ? await prisma.sourceSearchState.count({
            where: {
              source: "OLX",
              coverageRecoveryPending: true,
              OR: [
                { recoveryNextAttemptAt: null },
                { recoveryNextAttemptAt: { lte: now } },
              ],
            },
          }) > 0
        : false;
      // Pending is durable urgency, not permission to bypass origin cooldowns.
      // Otherwise a pending window defeats PROTECTION/UNRESOLVED backoff and
      // adds another deep job on every scheduler attempt.
      if (source.source === "OLX" && !backfillDue(lastBackfillAt, scheduledDecision, now)) continue;
      if (recoveryPending && !recoveryDue) continue;

      const queuedTrigger = recoveryPending ? "RECOVERY" : "BACKFILL";
      if (!await this.backgroundGenerationCurrent(generation)) return { deferred: false };
      await enqueue(
        QUEUE_NAMES.COLLECTOR_BACKFILL,
        "collect",
        {
          sourceId: source.id,
          source: source.source,
          trigger: queuedTrigger,
          lane: "BACKFILL",
          monitoringGeneration: generation,
          scheduledAt: now.toISOString(),
          backfillProfile: scheduledDecision.profile,
          backfillReason: scheduledDecision.reason,
        },
        { jobId: `collector-${queuedTrigger.toLowerCase()}-${source.source}-${generation}-${now.getTime()}` },
      );
    }
    return { deferred: false };
  }

  private async backgroundGenerationCurrent(generation: number): Promise<boolean> {
    if (!this.running) return false;
    const state = await prisma.monitoringState.findUnique({
      where: { id: STATE_ID },
      select: { status: true, generation: true },
    });
    return this.running && state?.status === "RUNNING" && state.generation === generation;
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
  const hourlySearchBudget = autoRiaSearchBudgetPerHour(
    env.AUTO_RIA_SEARCH_REQUESTS_PER_HOUR,
    env.AUTO_RIA_HOURLY_REQUEST_LIMIT,
    env.AUTO_RIA_MAX_INFO_PER_SCAN,
  );
  return autoRiaRealtimeIntervalSeconds({
    accessMode: env.AUTO_RIA_ACCESS_MODE,
    sourceIntervalSeconds: source.intervalSeconds,
    minimumIntervalSeconds: env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS,
    contextCount: autoRiaContextCount,
    hourlySearchBudget,
  });
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
  const [
    runs,
    recoveredObservations,
    unresolvedObservationCount,
    realtimeAnomaly,
    adverseAudit,
    pendingRecoveryCount,
    unresolvedRecovery,
  ] = await Promise.all([
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
    prisma.coverageRecoveryWindow.count({
      where: { source: "OLX", status: "PENDING" },
    }),
    prisma.coverageRecoveryWindow.findFirst({
      where: { source: "OLX", status: "UNRESOLVED" },
      orderBy: { unresolvedAt: "desc" },
      select: { attemptGeneration: true },
    }),
  ]);

  const currentGeneration = currentOlxRecoveryGeneration();
  const unresolvedRecoveryCount = unresolvedRecovery
    ? await prisma.coverageRecoveryWindow.count({ where: { source: "OLX", status: "UNRESOLVED" } })
    : 0;

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
    pendingRecoveryCount,
    unresolvedRecovery: unresolvedRecovery
      ? {
          count: unresolvedRecoveryCount,
          attemptedGeneration: unresolvedRecovery.attemptGeneration,
          currentGeneration,
        }
      : undefined,
    realtimeAnomalyAt: realtimeAnomaly?.startedAt,
    adverseAuditAt: adverseAudit?.startedAt,
  };
}

function currentOlxRecoveryGeneration(): string {
  return olxRecoveryAttemptGeneration({
    pageSize: env.OLX_API_PAGE_SIZE,
    maxOffset: env.OLX_API_MAX_OFFSET,
  });
}

export async function rearmOlxRecoveryForChangedCapability(now: Date): Promise<number> {
  const currentGeneration = currentOlxRecoveryGeneration();
  const unresolved = await prisma.coverageRecoveryWindow.findMany({
    // Retired planner shards retain their evidence but must not occupy the
    // active recovery lane. A returning shard becomes eligible after realtime
    // has observed it again; a restart alone does not activate old scopes.
    where: { source: "OLX", status: { in: ["UNRESOLVED", "PENDING"] },
      state: { lastSuccessfulScanAt: { gte: new Date(now.getTime() - 15 * 60_000) } } },
    select: {
      id: true,
      sourceSearchStateId: true,
      requiredCutoffAt: true,
      attemptGeneration: true,
      status: true,
      overlapExternalIds: true,
    },
  });
  let rearmed = 0;
  const stateIds = new Set(unresolved.filter((window) => window.status === "UNRESOLVED"
    ? olxRecoveryRetryEligible({ attemptedGeneration: window.attemptGeneration, currentGeneration })
    : window.overlapExternalIds[0] === "olx-offset-evidence-v1")
    .map((window) => window.sourceSearchStateId));
  for (const stateId of stateIds) {
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "source_search_states" WHERE "id" = ${stateId} FOR UPDATE`;
      const state = await tx.sourceSearchState.findUnique({ where: { id: stateId } });
      if (!state) return 0;
      const windows = await tx.coverageRecoveryWindow.findMany({
        where: { sourceSearchStateId: stateId, status: { in: ["PENDING", "UNRESOLVED"] } },
      });
      const eligible = windows.filter((window) => window.status === "PENDING"
        || olxRecoveryRetryEligible({ attemptedGeneration: window.attemptGeneration, currentGeneration }));
      if (!eligible.some((window) => window.status === "UNRESOLVED"
        || window.overlapExternalIds[0] === "olx-offset-evidence-v1")) return 0;
      const cutoff = eligible.reduce((oldest, window) => window.requiredCutoffAt < oldest
        ? window.requiredCutoffAt : oldest, state.coverageRecoveryCutoffAt ?? eligible[0]!.requiredCutoffAt);
      const transition = await tx.coverageRecoveryWindow.updateMany({
        where: { id: { in: eligible.map((window) => window.id) }, status: { in: ["UNRESOLVED", "PENDING"] } },
        data: {
          status: "PENDING",
          unresolvedReason: null,
          unresolvedAt: null,
          attemptGeneration: currentGeneration,
          acknowledgedAt: null,
          acknowledgedBy: null,
          acknowledgementNote: null,
          progressPage: 1,
          overlapPage: null,
          overlapExternalIds: [],
          consecutiveNoProgress: 0,
          lastNoProgressReason: null,
          nextAttemptAt: now,
        },
      });
      if (transition.count === 0) return 0;
      await tx.sourceSearchState.update({
        where: { id: stateId },
        data: {
          coverageRecoveryPending: true,
          coverageRecoveryCutoffAt: cutoff,
          // Reopened historical windows no longer share one frozen ID tail.
          // Only observed timestamp coverage of the oldest cutoff closes them.
          coverageAnchorExternalIds: [],
          lastPage: 1,
          recoveryProgressPage: 1,
          recoveryOverlapPage: null,
          recoveryOverlapExternalIds: [],
          recoveryConsecutiveNoProgress: 0,
          recoveryLastNoProgressReason: null,
          recoveryNextAttemptAt: now,
        },
      });
      return transition.count;
    });
    rearmed += changed;
  }
  if (rearmed > 0) {
    await logInfo(
      "orchestrator",
      `OLX recovery capability changed; re-armed ${rearmed} unresolved window(s)`,
      `generation=${currentGeneration}; shards=${stateIds.size}; at=${now.toISOString()}`,
    );
  }
  return rearmed;
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
