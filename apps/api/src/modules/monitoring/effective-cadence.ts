import { Prisma, prisma, type ListingSource } from "@amb/db";
import type {
  EffectiveCadenceHistoryRow,
  EffectiveCadenceMode,
  EffectiveCadenceRow,
} from "@amb/shared";
import type { OlxCadenceCanaryDecision } from "./olx-cadence-canary-policy.js";
import type { OlxRealtimeCadenceDecision } from "./olx-realtime-cadence.js";

export type EffectiveCadenceDecision = {
  mode: EffectiveCadenceMode;
  intervalSeconds: number;
  jitterSeconds: number;
  valueSource: string;
  reason: string;
};

/**
 * One precedence chain for the cadence that the scheduler actually applies.
 * It is deliberately pure: observing effective cadence must never change it.
 */
export function resolveOlxEffectiveCadence(input: {
  persistedIntervalSeconds: number;
  persistedJitterSeconds: number;
  liveIntervalSeconds: number;
  liveJitterSeconds: number;
  standardIntervalSeconds: number;
  standardJitterSeconds: number;
  protectionActive: boolean;
  canary: Pick<OlxCadenceCanaryDecision, "mode" | "intervalSeconds" | "jitterSeconds" | "reason">;
  recovery: OlxRealtimeCadenceDecision;
}): EffectiveCadenceDecision {
  const base = baseCadence(input);
  if (input.protectionActive) {
    return {
      mode: "PROTECTED",
      intervalSeconds: input.recovery.intervalSeconds,
      jitterSeconds: input.recovery.jitterSeconds,
      valueSource: "protection.active-incident",
      reason: input.recovery.reason,
    };
  }
  if (input.recovery.mode !== "HEALTHY") {
    return {
      mode: "RECOVERY",
      intervalSeconds: input.recovery.intervalSeconds,
      jitterSeconds: input.recovery.jitterSeconds,
      valueSource: "protection.recovery-ramp",
      reason: input.recovery.reason,
    };
  }
  if (input.canary.mode === "CANARY" || input.canary.mode === "PROMOTED") {
    return {
      mode: "CANARY",
      intervalSeconds: input.canary.intervalSeconds,
      jitterSeconds: input.canary.jitterSeconds,
      valueSource: "canary.policy",
      reason: input.canary.reason,
    };
  }
  return base;
}

export async function recordEffectiveCadence(input: EffectiveCadenceDecision & {
  source: ListingSource;
  nextExpectedRunAt: Date | null;
  observedAt: Date;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.effectiveCadence.findUnique({ where: { source: input.source } });
    const changed = effectiveCadenceIdentityChanged(current, input);
    const cadence = current
      ? await tx.effectiveCadence.update({
          where: { id: current.id },
          data: {
            mode: input.mode,
            intervalSeconds: input.intervalSeconds,
            jitterSeconds: input.jitterSeconds,
            valueSource: input.valueSource,
            reason: input.reason,
            nextExpectedRunAt: input.nextExpectedRunAt,
            ...(changed ? { changedAt: input.observedAt } : {}),
          },
        })
      : await tx.effectiveCadence.create({
          data: {
            source: input.source,
            mode: input.mode,
            intervalSeconds: input.intervalSeconds,
            jitterSeconds: input.jitterSeconds,
            valueSource: input.valueSource,
            reason: input.reason,
            changedAt: input.observedAt,
            nextExpectedRunAt: input.nextExpectedRunAt,
          },
        });
    if (!changed) return;
    await tx.effectiveCadenceHistory.create({
      data: {
        effectiveCadenceId: cadence.id,
        source: input.source,
        mode: input.mode,
        intervalSeconds: input.intervalSeconds,
        jitterSeconds: input.jitterSeconds,
        valueSource: input.valueSource,
        reason: input.reason,
        changedAt: input.observedAt,
        nextExpectedRunAt: input.nextExpectedRunAt,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export function effectiveCadenceIdentityChanged(
  current: Pick<EffectiveCadenceDecision, "mode" | "intervalSeconds" | "jitterSeconds" | "valueSource"> | null,
  next: Pick<EffectiveCadenceDecision, "mode" | "intervalSeconds" | "jitterSeconds" | "valueSource">,
): boolean {
  return !current
    || current.mode !== next.mode
    || current.intervalSeconds !== next.intervalSeconds
    || current.jitterSeconds !== next.jitterSeconds
    || current.valueSource !== next.valueSource;
}

export async function readEffectiveCadence(
  source: "OLX",
  historyLimit = 20,
): Promise<EffectiveCadenceRow<Date> | null> {
  const cadence = await prisma.effectiveCadence.findUnique({
    where: { source },
    include: {
      history: {
        orderBy: [{ changedAt: "desc" }, { createdAt: "desc" }],
        take: Math.max(1, Math.min(100, Math.trunc(historyLimit))),
      },
    },
  });
  if (!cadence) return null;
  return {
    source,
    ...cadenceRow(cadence),
    history: cadence.history.map(cadenceRow),
  };
}

function baseCadence(input: {
  persistedIntervalSeconds: number;
  persistedJitterSeconds: number;
  liveIntervalSeconds: number;
  liveJitterSeconds: number;
  standardIntervalSeconds: number;
  standardJitterSeconds: number;
}): EffectiveCadenceDecision {
  const live = input.persistedIntervalSeconds === input.liveIntervalSeconds
    && input.persistedJitterSeconds === input.liveJitterSeconds;
  if (live) {
    return {
      mode: "LIVE",
      intervalSeconds: input.persistedIntervalSeconds,
      jitterSeconds: input.persistedJitterSeconds,
      valueSource: "environment.live-baseline",
      reason: `persisted OLX cadence matches LIVE baseline ${input.liveIntervalSeconds}±${input.liveJitterSeconds}s`,
    };
  }
  const standard = input.persistedIntervalSeconds === input.standardIntervalSeconds
    && input.persistedJitterSeconds === input.standardJitterSeconds;
  return {
    mode: "STANDARD",
    intervalSeconds: input.persistedIntervalSeconds,
    jitterSeconds: input.persistedJitterSeconds,
    valueSource: standard ? "monitoring-state.standard" : "source.persisted-override",
    reason: standard
      ? `persisted OLX cadence matches STANDARD ${input.standardIntervalSeconds}±${input.standardJitterSeconds}s`
      : `persisted OLX cadence ${input.persistedIntervalSeconds}±${input.persistedJitterSeconds}s differs from LIVE baseline ${input.liveIntervalSeconds}±${input.liveJitterSeconds}s`,
  };
}

function cadenceRow(row: {
  mode: EffectiveCadenceMode;
  intervalSeconds: number;
  jitterSeconds: number;
  valueSource: string;
  reason: string;
  changedAt: Date;
  nextExpectedRunAt: Date | null;
}): EffectiveCadenceHistoryRow<Date> {
  return {
    mode: row.mode,
    intervalSeconds: row.intervalSeconds,
    jitterSeconds: row.jitterSeconds,
    valueSource: row.valueSource,
    reason: row.reason,
    changedAt: row.changedAt,
    nextExpectedRunAt: row.nextExpectedRunAt,
  };
}
