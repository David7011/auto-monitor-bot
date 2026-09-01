import { summarizeMetric } from "@amb/shared";

export type OlxCadenceCanaryMode = "BASELINE" | "CANARY" | "PROMOTED" | "ROLLED_BACK" | "DISABLED";

export type OlxCadenceRunEvidence = {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  recoveredCount: number;
  semanticWarnings: readonly string[];
  errorMessage: string | null;
};

export type OlxCadenceCanaryState = {
  mode: OlxCadenceCanaryMode;
  qualificationStartedAt: Date;
  canaryStartedAt: Date | null;
  baselineP95Ms: number | null;
  rollbackReason: string | null;
};

export type OlxCadenceCanaryConfig = {
  enabled: boolean;
  qualificationRuns: number;
  promotionRuns: number;
  p95MinimumSamples: number;
  qualificationMaximumP95Ms: number;
  maximumP95Ms: number;
  p95GrowthRatio: number;
  baseIntervalSeconds: number;
  baseJitterSeconds: number;
  canaryIntervalSeconds: number;
  canaryJitterSeconds: number;
};

export type OlxCadenceCanaryDecision = {
  mode: OlxCadenceCanaryMode;
  intervalSeconds: number;
  jitterSeconds: number;
  cleanRunCount: number;
  canaryRunCount: number;
  baselineP95Ms: number | null;
  currentP95Ms: number | null;
  qualificationStartedAt: Date;
  canaryStartedAt: Date | null;
  rollbackReason: string | null;
  lastEvaluatedRunId: string | null;
  transition: "NONE" | "ENTER_CANARY" | "PROMOTE" | "ROLLBACK" | "DISABLE";
  reason: string;
};

/**
 * Pure state machine for the OLX realtime cadence experiment. Runs must be
 * newest-first. A signal is adverse if it is not an entirely clean SUCCESS,
 * contains an overflow warning, exceeds the hard p95 ceiling, or if external
 * protection/queue pressure is active.
 */
export function decideOlxCadenceCanary(input: {
  state: OlxCadenceCanaryState;
  config: OlxCadenceCanaryConfig;
  runs: readonly OlxCadenceRunEvidence[];
  protectionActive: boolean;
  queueOverflow: boolean;
  now?: Date;
}): OlxCadenceCanaryDecision {
  const now = input.now ?? new Date();
  const base = baseDecision(input);
  if (!input.config.enabled) {
    return { ...base, mode: "DISABLED", transition: input.state.mode === "DISABLED" ? "NONE" : "DISABLE", reason: "OLX cadence canary is disabled" };
  }

  const accelerated = input.state.mode === "CANARY" || input.state.mode === "PROMOTED";
  if (accelerated) return evaluateAccelerated(input, base, now);

  const qualificationRuns = consecutiveCleanRuns(
    input.runs.filter((run) => run.startedAt >= input.state.qualificationStartedAt),
  );
  const qualificationDurations = qualificationRuns.map(runDurationMs);
  const baselineP95Ms = summarizeMetric(qualificationDurations).p95;
  const required = Math.max(1, Math.trunc(input.config.qualificationRuns));
  const blockedReason = immediateExternalRollbackReason(input);
  if (blockedReason) {
    return {
      ...base,
      cleanRunCount: qualificationRuns.length,
      currentP95Ms: baselineP95Ms,
      reason: `qualification blocked: ${blockedReason}`,
    };
  }
  if (qualificationRuns.length < required) {
    return {
      ...base,
      cleanRunCount: qualificationRuns.length,
      currentP95Ms: baselineP95Ms,
      reason: `clean OLX realtime runs ${qualificationRuns.length}/${required}`,
    };
  }
  if (baselineP95Ms == null || baselineP95Ms > input.config.qualificationMaximumP95Ms) {
    return {
      ...base,
      cleanRunCount: qualificationRuns.length,
      currentP95Ms: baselineP95Ms,
      reason: `baseline p95 ${baselineP95Ms ?? "unknown"}ms exceeds ${input.config.qualificationMaximumP95Ms}ms`,
    };
  }

  return {
    ...base,
    mode: "CANARY",
    intervalSeconds: input.config.canaryIntervalSeconds,
    jitterSeconds: input.config.canaryJitterSeconds,
    cleanRunCount: qualificationRuns.length,
    canaryRunCount: 0,
    baselineP95Ms,
    currentP95Ms: null,
    canaryStartedAt: now,
    rollbackReason: null,
    transition: "ENTER_CANARY",
    reason: `${qualificationRuns.length} clean runs; baseline p95 ${baselineP95Ms}ms`,
  };
}

function evaluateAccelerated(
  input: Parameters<typeof decideOlxCadenceCanary>[0],
  base: OlxCadenceCanaryDecision,
  now: Date,
): OlxCadenceCanaryDecision {
  const canaryStartedAt = input.state.canaryStartedAt ?? now;
  const canaryRuns = input.runs.filter((run) => run.startedAt >= canaryStartedAt);
  const cleanCanaryRuns = consecutiveCleanRuns(canaryRuns);
  const durations = cleanCanaryRuns.map(runDurationMs);
  const currentP95Ms = summarizeMetric(durations).p95;
  const latest = canaryRuns[0];
  const adverseRun = canaryRuns.find((run) => !isCleanRun(run));
  const hardLatencyRun = canaryRuns.find((run) => run.finishedAt && runDurationMs(run) > input.config.maximumP95Ms);
  const externalReason = immediateExternalRollbackReason(input);
  const dirtyRunReason = adverseRun ? describeDirtyRun(adverseRun) : null;
  const hardLatencyReason = hardLatencyRun
    ? `run ${hardLatencyRun.id} took ${runDurationMs(hardLatencyRun)}ms and exceeds hard limit ${input.config.maximumP95Ms}ms`
    : null;
  const baselineP95Ms = input.state.baselineP95Ms;
  const growthLimitMs = baselineP95Ms == null
    ? input.config.maximumP95Ms
    : Math.min(input.config.maximumP95Ms, Math.round(baselineP95Ms * input.config.p95GrowthRatio));
  const p95GrowthReason = cleanCanaryRuns.length >= input.config.p95MinimumSamples
    && currentP95Ms != null
    && currentP95Ms > growthLimitMs
    ? `canary p95 ${currentP95Ms}ms exceeds growth limit ${growthLimitMs}ms`
    : null;
  const rollbackReason = externalReason ?? dirtyRunReason ?? hardLatencyReason ?? p95GrowthReason;

  if (rollbackReason) {
    return {
      ...base,
      mode: "ROLLED_BACK",
      cleanRunCount: 0,
      canaryRunCount: canaryRuns.length,
      baselineP95Ms,
      currentP95Ms,
      qualificationStartedAt: now,
      canaryStartedAt,
      rollbackReason,
      lastEvaluatedRunId: latest?.id ?? null,
      transition: "ROLLBACK",
      reason: `automatic rollback: ${rollbackReason}`,
    };
  }

  const promotionRuns = Math.max(1, Math.trunc(input.config.promotionRuns));
  const promote = input.state.mode === "CANARY" && cleanCanaryRuns.length >= promotionRuns;
  return {
    ...base,
    mode: promote ? "PROMOTED" : input.state.mode,
    intervalSeconds: input.config.canaryIntervalSeconds,
    jitterSeconds: input.config.canaryJitterSeconds,
    cleanRunCount: cleanCanaryRuns.length,
    canaryRunCount: canaryRuns.length,
    baselineP95Ms,
    currentP95Ms,
    qualificationStartedAt: input.state.qualificationStartedAt,
    canaryStartedAt,
    rollbackReason: null,
    lastEvaluatedRunId: latest?.id ?? null,
    transition: promote ? "PROMOTE" : "NONE",
    reason: promote
      ? `${cleanCanaryRuns.length} clean canary runs; cadence promoted with rollback guard active`
      : `canary clean runs ${cleanCanaryRuns.length}/${promotionRuns}; p95 ${currentP95Ms ?? "pending"}ms`,
  };
}

function baseDecision(
  input: Parameters<typeof decideOlxCadenceCanary>[0],
): OlxCadenceCanaryDecision {
  return {
    mode: input.state.mode === "ROLLED_BACK" ? "ROLLED_BACK" : "BASELINE",
    intervalSeconds: input.config.baseIntervalSeconds,
    jitterSeconds: input.config.baseJitterSeconds,
    cleanRunCount: 0,
    canaryRunCount: 0,
    baselineP95Ms: input.state.baselineP95Ms,
    currentP95Ms: null,
    qualificationStartedAt: input.state.qualificationStartedAt,
    canaryStartedAt: input.state.canaryStartedAt,
    rollbackReason: input.state.rollbackReason,
    lastEvaluatedRunId: input.runs[0]?.id ?? null,
    transition: "NONE",
    reason: "baseline cadence",
  };
}

function consecutiveCleanRuns(runs: readonly OlxCadenceRunEvidence[]): OlxCadenceRunEvidence[] {
  const clean: OlxCadenceRunEvidence[] = [];
  for (const run of runs) {
    if (!isCleanRun(run)) break;
    clean.push(run);
  }
  return clean;
}

function isCleanRun(run: OlxCadenceRunEvidence): boolean {
  return run.status === "SUCCESS"
    && Boolean(run.finishedAt)
    && run.recoveredCount === 0
    && run.semanticWarnings.length === 0
    && !run.errorMessage;
}

function runDurationMs(run: OlxCadenceRunEvidence): number {
  return Math.max(0, (run.finishedAt?.getTime() ?? run.startedAt.getTime()) - run.startedAt.getTime());
}

function immediateExternalRollbackReason(input: Parameters<typeof decideOlxCadenceCanary>[0]): string | null {
  if (input.protectionActive) return "OLX protection signal";
  if (input.queueOverflow) return "hot-path queue overflow";
  return null;
}

function describeDirtyRun(run: OlxCadenceRunEvidence): string {
  const overflow = run.semanticWarnings.find((warning) => /overflow/iu.test(warning));
  if (overflow) return overflow;
  if (run.status !== "SUCCESS") return `OLX realtime run status ${run.status}`;
  if (run.recoveredCount > 0) return `recovery count ${run.recoveredCount}`;
  if (run.errorMessage) return run.errorMessage;
  return run.semanticWarnings[0] ?? "unclean OLX realtime run";
}
