import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sourceFindUnique: vi.fn(),
  runCreate: vi.fn(),
  sourceUpdate: vi.fn(),
  recoveryUpdateMany: vi.fn(),
  incidentFindFirst: vi.fn(),
  getCollector: vi.fn(),
  buildSourceSearchPlan: vi.fn(),
  redisSet: vi.fn(),
  enqueue: vi.fn(),
  scheduledJobState: vi.fn(),
  retryLockCollision: vi.fn(),
  olxProtectionCoolingState: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  loadSourceSearchState: vi.fn(),
  markSourceSearchSuccess: vi.fn(),
  contextForCoverageRecovery: vi.fn(),
  dispatchListings: vi.fn(),
  recordPendingObservations: vi.fn(),
  finishRun: vi.fn(),
  releaseLock: vi.fn(),
  handleExternalProtection: vi.fn(),
  safeSystemAlert: vi.fn(),
  markChallengeProbePending: vi.fn(),
  resolveChallengeIncidents: vi.fn(),
  realtimeHotHandoffEnabled: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    source: { findUnique: mocks.sourceFindUnique, update: mocks.sourceUpdate },
    collectorRun: { create: mocks.runCreate },
    challengeIncident: { findFirst: mocks.incidentFindFirst },
    coverageRecoveryWindow: { updateMany: mocks.recoveryUpdateMany },
  },
}));
vi.mock("../apps/worker/src/collectors/index.js", () => ({ getCollector: mocks.getCollector }));
vi.mock("../apps/worker/src/env.js", () => ({
  env: {
    OLX_PROTECTION_COOLING_SECONDS: 1_800,
    OLX_COVERAGE_MAX_DURATION_MS: 30_000,
    SOURCE_EMPTY_RESULT_WARNING_THRESHOLD: 3,
  },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: {
  warn: mocks.logWarn,
  info: mocks.logInfo,
  error: mocks.logError,
} }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  enqueue: mocks.enqueue,
  redisConnection: { set: mocks.redisSet },
}));
vi.mock("../apps/worker/src/modules/challenge-incident.js", () => ({
  markChallengeProbePending: mocks.markChallengeProbePending,
  resolveChallengeIncidents: mocks.resolveChallengeIncidents,
}));
vi.mock("../apps/worker/src/modules/source-search-plan.js", () => ({
  buildSourceSearchPlan: mocks.buildSourceSearchPlan,
  contextForCoverageRecovery: mocks.contextForCoverageRecovery,
  loadSourceSearchState: mocks.loadSourceSearchState,
  markSourceSearchSuccess: mocks.markSourceSearchSuccess,
}));
vi.mock("../apps/worker/src/modules/olx-lane-arbiter.js", () => ({
  olxLaneArbiter: { runRealtime: (operation: () => Promise<unknown>) => operation() },
}));
vi.mock("../apps/worker/src/modules/olx-protection-cooling.js", () => ({
  olxProtectionCoolingState: mocks.olxProtectionCoolingState,
}));
vi.mock("../apps/worker/src/modules/source-health-ownership.js", () => ({
  laneOwnsSourceHealth: (lane: string) => lane === "REALTIME",
}));
vi.mock("../apps/worker/src/modules/observation-journal.js", () => ({ recordPendingObservations: mocks.recordPendingObservations }));
vi.mock("../apps/worker/src/modules/realtime-dispatch-policy.js", () => ({ realtimeHotHandoffEnabled: mocks.realtimeHotHandoffEnabled }));
vi.mock("../apps/worker/src/processors/collector-run-helpers.js", () => ({
  calculateHealthScore: vi.fn(() => 100),
  collectorLockScope: () => "default",
  countProcessingResult: (result: { outcome?: string } | undefined) => result?.outcome === "REJECTED"
    ? { matched: 0, rejected: 1, duplicate: 0, dispatched: 0, accepted: 0 }
    : { matched: 1, rejected: 0, duplicate: 0, dispatched: 1, accepted: 1 },
  dispatchListings: mocks.dispatchListings,
  elapsedMs: vi.fn(() => 10),
  finishRun: mocks.finishRun,
  formatKyivDate: vi.fn(() => "date"),
  handleExternalProtection: mocks.handleExternalProtection,
  normalizeCollectedBatch: (listings: unknown[]) => listings,
  outageRecoveryListings: (listings: unknown[]) => listings,
  releaseLock: mocks.releaseLock,
  recoveryContinuationJobId: (input: { source: string; monitoringGeneration?: number; recoveryWindowId: string | null; recoveryAttemptCount: number }) =>
    `coverage-recovery-${input.source}-${input.monitoringGeneration ?? "unknown-generation"}-${input.recoveryWindowId ?? "legacy-window"}-attempt-${input.recoveryAttemptCount}`,
  renewLock: vi.fn(),
  resolveLane: (job: { lane?: string }) => job.lane ?? "REALTIME",
  resolveTrigger: (job: { trigger?: string }) => job.trigger ?? "SCHEDULED",
  retryLockCollision: mocks.retryLockCollision,
  safeSystemAlert: mocks.safeSystemAlert,
  scanDurationMs: () => 30_000,
  scanOptions: vi.fn(() => ({})),
  scheduledJobState: mocks.scheduledJobState,
  sourceDisplayName: vi.fn(),
}));

import { processCollectorRun } from "../apps/worker/src/processors/collector-run.js";

const sourceRecord = {
  id: "source-olx",
  source: "OLX",
  enabled: true,
  status: "ACTIVE",
  pausedUntil: null,
  consecutiveErrors: 0,
  consecutiveEmptyResults: 0,
  lastSuccessfulAt: null,
  lastNonEmptyAt: null,
  initialSyncCompletedAt: null,
  healthScore: 100,
};
const context = {
  categoryKey: "vehicle.car",
  fingerprint: "fingerprint",
  filterIds: ["filter-1"],
  freshnessMode: "ALL_TIME",
  initialWindowBehavior: "SKIP_EXISTING",
  maxInitialWindowNotifications: 20,
};
const state = {
  id: "state-1",
  initialSyncCompletedAt: new Date("2026-09-12T08:00:00Z"),
  knownExternalIds: new Set<string>(),
  coverageRecoveryPending: false,
};
const listing = {
  source: "OLX",
  externalId: "olx-1",
  url: "https://www.olx.ua/d/olx-1",
  canonicalUrl: "https://www.olx.ua/d/olx-1",
  photoUrls: [],
  firstSeenAt: new Date("2026-09-12T08:00:00Z"),
};

describe("collector.run glue preflight invariants", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCollector.mockReturnValue({
      collect: vi.fn().mockResolvedValue({ listings: [listing], requestCount: 1, observedCount: 1, pageCount: 1 }),
      supportsNewestFirst: true,
      newestFirstVerified: true,
    });
    mocks.sourceFindUnique.mockResolvedValue(sourceRecord);
    mocks.buildSourceSearchPlan.mockResolvedValue([context]);
    mocks.scheduledJobState.mockResolvedValue({ stale: false });
    mocks.incidentFindFirst.mockResolvedValue(null);
    mocks.olxProtectionCoolingState.mockReturnValue({ active: false, until: null });
    mocks.redisSet.mockResolvedValue("OK");
    mocks.runCreate.mockResolvedValue({ id: "run-1" });
    mocks.retryLockCollision.mockResolvedValue(undefined);
    mocks.logWarn.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.logError.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.sourceUpdate.mockResolvedValue(undefined);
    mocks.recoveryUpdateMany.mockResolvedValue({ count: 0 });
    mocks.loadSourceSearchState.mockResolvedValue(state);
    mocks.contextForCoverageRecovery.mockImplementation((value) => value);
    mocks.markSourceSearchSuccess.mockResolvedValue({
      clearedKnownIdCount: 0,
      recoveryRequired: false,
      outageDetected: false,
      recoveryWindowId: null,
      recoveryWindowOpened: false,
      recoveryVerified: false,
      recoveryUnresolved: false,
      recoveryUnresolvedReason: null,
      recoveryAttemptCount: 0,
      requiredCutoffAt: null,
    });
    mocks.dispatchListings.mockImplementation(async (listings: unknown[]) => listings.map((item) => ({
      listing: item,
      result: { outcome: "DISPATCHED", matchedFilterIds: ["filter-1"], rejectionReasons: [] },
    })));
    mocks.recordPendingObservations.mockResolvedValue(new Map());
    mocks.finishRun.mockResolvedValue(undefined);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.handleExternalProtection.mockResolvedValue(undefined);
    mocks.safeSystemAlert.mockResolvedValue(undefined);
    mocks.markChallengeProbePending.mockResolvedValue(undefined);
    mocks.resolveChallengeIncidents.mockResolvedValue(undefined);
    mocks.realtimeHotHandoffEnabled.mockReturnValue(false);
  });

  it("reports a missing collector and stops before planning or locking", async () => {
    mocks.getCollector.mockReturnValueOnce(undefined);

    await processCollectorRun({ source: "OLX" });

    expect(mocks.logWarn).toHaveBeenCalledWith("collector", "No collector registered for OLX, skipping");
    expect(mocks.buildSourceSearchPlan).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("does not create runs for disabled, paused, or unreferenced sources", async () => {
    mocks.sourceFindUnique.mockResolvedValueOnce({ ...sourceRecord, enabled: false });
    await processCollectorRun({ source: "OLX" });
    mocks.sourceFindUnique.mockResolvedValueOnce({ ...sourceRecord, pausedUntil: new Date(Date.now() + 60_000) });
    await processCollectorRun({ source: "OLX" });
    mocks.buildSourceSearchPlan.mockResolvedValueOnce([]);
    await processCollectorRun({ source: "OLX" });

    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("persists a stale scheduled job as SKIPPED before acquiring a source lock", async () => {
    mocks.scheduledJobState.mockResolvedValueOnce({ stale: true, reason: "monitoring generation changed" });

    await processCollectorRun({ source: "OLX", monitoringGeneration: 4 });

    expect(mocks.runCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      source: "OLX",
      lane: "REALTIME",
      trigger: "SCHEDULED",
      status: "SKIPPED",
      errorMessage: "monitoring generation changed",
    }) });
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("keeps OLX background work stopped during protection cooling without blocking realtime", async () => {
    const until = new Date(Date.now() + 60_000);
    mocks.olxProtectionCoolingState.mockReturnValueOnce({ active: true, until });

    await processCollectorRun({ source: "OLX", lane: "BACKFILL", trigger: "BACKFILL" });

    expect(mocks.runCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      lane: "BACKFILL",
      status: "SKIPPED",
      errorMessage: expect.stringContaining(until.toISOString()),
    }) });
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("coalesces a lock collision into the bounded retry policy", async () => {
    mocks.redisSet.mockResolvedValueOnce(null);
    await processCollectorRun({ source: "OLX", lane: "REALTIME", lockRetryCount: 1 });

    expect(mocks.redisSet).toHaveBeenCalledWith(
      "collector-lock:OLX:default",
      expect.any(String),
      "PX",
      60_000,
      "NX",
    );
    expect(mocks.retryLockCollision).toHaveBeenCalledWith(
      expect.objectContaining({ source: "OLX", lockRetryCount: 1 }),
      "REALTIME",
    );
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it("completes normal durable dispatch before state advancement and finalizes the run", async () => {
    await processCollectorRun({ source: "OLX", lane: "REALTIME", monitoringGeneration: 7 });

    expect(mocks.dispatchListings).toHaveBeenCalledWith([listing], ["filter-1"], "REALTIME", { used: 0 });
    expect(mocks.markSourceSearchSuccess).toHaveBeenCalledWith(
      context,
      state,
      [listing],
      expect.objectContaining({ lane: "REALTIME", advanceSuccessBoundary: true, runId: "run-1" }),
    );
    expect(mocks.dispatchListings.mock.invocationCallOrder[0]).toBeLessThan(mocks.markSourceSearchSuccess.mock.invocationCallOrder[0]!);
    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "SUCCESS", foundCount: 1, requestCount: 1 }));
    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE" }) }));
    expect(mocks.resolveChallengeIncidents).toHaveBeenCalledWith("source-olx");
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("uses a successful hot callback once and does not redispatch the returned duplicate", async () => {
    mocks.realtimeHotHandoffEnabled.mockReturnValue(true);
    mocks.getCollector.mockReturnValueOnce({
      supportsNewestFirst: true,
      newestFirstVerified: true,
      collect: vi.fn(async (_context: unknown, _state: unknown, options: { onHotCandidates?: (items: typeof listing[]) => Promise<void> }) => {
        await options.onHotCandidates?.([listing]);
        return { listings: [listing], requestCount: 1, observedCount: 1, pageCount: 1 };
      }),
    });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.realtimeHotHandoffEnabled).toHaveReturnedWith(true);
    expect(mocks.dispatchListings.mock.calls.map((call) => call[0])).toEqual([[listing], []]);
  });

  it("falls back to the normal durable path when the hot callback fails", async () => {
    mocks.realtimeHotHandoffEnabled.mockReturnValue(true);
    mocks.dispatchListings.mockRejectedValueOnce(new Error("hot callback failed"));
    mocks.getCollector.mockReturnValueOnce({
      supportsNewestFirst: true,
      newestFirstVerified: true,
      collect: vi.fn(async (_context: unknown, _state: unknown, options: { onHotCandidates?: (items: typeof listing[]) => Promise<void> }) => {
        await options.onHotCandidates?.([listing]);
        return { listings: [listing], requestCount: 1, observedCount: 1, pageCount: 1 };
      }),
    });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.realtimeHotHandoffEnabled).toHaveReturnedWith(true);
    expect(mocks.dispatchListings.mock.calls.map((call) => call[0])).toEqual([[listing], [listing]]);
    expect(mocks.logWarn).toHaveBeenCalledWith("pipeline", expect.stringContaining("Early OLX"), "hot callback failed");
    expect(mocks.markSourceSearchSuccess).toHaveBeenCalledTimes(1);
  });

  it("cancels a stale generation after collection without advancing state", async () => {
    mocks.scheduledJobState
      .mockResolvedValueOnce({ stale: false })
      .mockResolvedValueOnce({ stale: true, reason: "monitoring stopped" });

    await processCollectorRun({ source: "OLX", lane: "REALTIME", monitoringGeneration: 3 });

    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "CANCELLED_BY_USER",
      errorMessage: "monitoring stopped",
    }));
    expect(mocks.markSourceSearchSuccess).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: { rateLimited: true, responseStatus: 403 }, label: "rate limit" },
    { result: { captchaDetected: true, responseStatus: 403 }, label: "CAPTCHA" },
  ])("hands $label to protection and never advances the boundary", async ({ result }) => {
    mocks.getCollector.mockReturnValueOnce({
      collect: vi.fn().mockResolvedValue({ listings: [], requestCount: 1, observedCount: 0, ...result }),
    });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.handleExternalProtection).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining(result) }));
    expect(mocks.markSourceSearchSuccess).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("persists unprocessed initial-sync observations before advancing state", async () => {
    mocks.loadSourceSearchState.mockResolvedValueOnce({ ...state, initialSyncCompletedAt: undefined });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.dispatchListings).toHaveBeenCalledWith([], ["filter-1"], "REALTIME", { used: 0 });
    expect(mocks.recordPendingObservations).toHaveBeenCalledWith([listing], "REALTIME");
    expect(mocks.recordPendingObservations.mock.invocationCallOrder[0]).toBeLessThan(mocks.markSourceSearchSuccess.mock.invocationCallOrder[0]!);
    expect(mocks.logInfo).toHaveBeenCalledWith("collector", expect.stringContaining("initial sync completed"));
  });

  it("reports UNRESOLVED without stopping realtime", async () => {
    mocks.loadSourceSearchState.mockResolvedValueOnce({ ...state, coverageRecoveryPending: true });
    mocks.markSourceSearchSuccess.mockResolvedValueOnce({
      recoveryRequired: false,
      outageDetected: true,
      recoveryWindowId: "window-1",
      recoveryWindowOpened: false,
      recoveryVerified: false,
      recoveryUnresolved: true,
      recoveryUnresolvedReason: "PUBLIC_OFFSET_CAP",
      recoveryAttemptCount: 1,
      requiredCutoffAt: new Date("2026-09-12T07:00:00Z"),
    });

    await processCollectorRun({ source: "OLX", lane: "BACKFILL", trigger: "RECOVERY" });

    expect(mocks.safeSystemAlert).toHaveBeenCalledWith(expect.stringContaining("PUBLIC_OFFSET_CAP"));
    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "SUCCESS" }));
    expect(mocks.sourceUpdate).not.toHaveBeenCalled();
  });

  it("enqueues a stable follow-up when realtime opens a recovery window", async () => {
    mocks.markSourceSearchSuccess.mockResolvedValueOnce({
      recoveryRequired: true,
      outageDetected: true,
      recoveryWindowId: "window-1",
      recoveryWindowOpened: true,
      recoveryVerified: false,
      recoveryUnresolved: false,
      recoveryUnresolvedReason: null,
      recoveryAttemptCount: 0,
      requiredCutoffAt: new Date("2026-09-12T07:00:00Z"),
    });

    await processCollectorRun({ source: "OLX", lane: "REALTIME", monitoringGeneration: 8 });

    expect(mocks.enqueue).toHaveBeenCalledWith(
      "collector.backfill",
      "collect",
      expect.objectContaining({ trigger: "RECOVERY", lane: "BACKFILL", monitoringGeneration: 8 }),
      { jobId: "coverage-recovery-OLX-8-window-1-attempt-0" },
    );
  });

  it("queues Recovery B after an incomplete active Recovery A", async () => {
    mocks.loadSourceSearchState.mockResolvedValueOnce({ ...state, coverageRecoveryPending: true });
    mocks.markSourceSearchSuccess.mockResolvedValueOnce({
      recoveryRequired: true,
      outageDetected: false,
      recoveryWindowId: "window-1",
      recoveryWindowOpened: false,
      recoveryVerified: false,
      recoveryUnresolved: false,
      recoveryUnresolvedReason: null,
      recoveryAttemptCount: 2,
      requiredCutoffAt: new Date("2026-09-12T07:00:00Z"),
    });

    await processCollectorRun({ source: "OLX", lane: "BACKFILL", trigger: "RECOVERY", monitoringGeneration: 8 });

    expect(mocks.enqueue).toHaveBeenCalledWith(
      "collector.backfill",
      "collect",
      expect.objectContaining({ trigger: "RECOVERY", lane: "BACKFILL", monitoringGeneration: 8 }),
      { jobId: "coverage-recovery-OLX-8-window-1-attempt-2" },
    );
  });

  it.each([
    { lane: "REALTIME" as const, expectedStatus: "LIMITED", updatesSource: true },
    { lane: "BACKFILL" as const, expectedStatus: "LIMITED", updatesSource: false },
  ])("contains a network timeout in $lane", async ({ lane, expectedStatus, updatesSource }) => {
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockRejectedValue(new Error("network timeout")) });

    await processCollectorRun({ source: "OLX", lane });

    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: expectedStatus }));
    expect(mocks.sourceUpdate).toHaveBeenCalledTimes(updatesSource ? 1 : 0);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lane: "REALTIME" as const, expectedStatus: "FAILED", updatesSource: true },
    { lane: "BACKFILL" as const, expectedStatus: "FAILED", updatesSource: false },
  ])("contains a generic collector failure in $lane", async ({ lane, expectedStatus, updatesSource }) => {
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockRejectedValue(new Error("parse exploded")) });

    await processCollectorRun({ source: "OLX", lane });

    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: expectedStatus }));
    expect(mocks.sourceUpdate).toHaveBeenCalledTimes(updatesSource ? 1 : 0);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("defers a quota-limited scan without advancing search state", async () => {
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockResolvedValue({
      listings: [], requestCount: 0, observedCount: 0,
      quotaDeferredSeconds: 60,
      limitedReason: "quota preserved",
    }) });

    await processCollectorRun({ source: "AUTO_RIA", lane: "REALTIME" });

    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { source: "AUTO_RIA" },
      data: expect.objectContaining({ status: "LIMITED", lastError: expect.stringContaining("quota preserved") }),
    }));
    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "LIMITED" }));
    expect(mocks.markSourceSearchSuccess).not.toHaveBeenCalled();
  });

  it("does not let a degraded empty OLX response advance the success boundary", async () => {
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockResolvedValue({
      listings: [], requestCount: 1, observedCount: 0,
      limited: true,
      limitedReason: "parser output inconclusive",
      parserHealth: "DEGRADED",
      semanticWarnings: ["schema changed"],
    }) });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.markSourceSearchSuccess).toHaveBeenCalledWith(
      context,
      state,
      [],
      expect.objectContaining({ advanceSuccessBoundary: false, parserHealth: "DEGRADED" }),
    );
    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "LIMITED",
      errorMessage: "parser output inconclusive",
    }));
  });

  it("records protection evidence for a pending backfill window", async () => {
    mocks.loadSourceSearchState.mockResolvedValueOnce({ ...state, coverageRecoveryPending: true });
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockResolvedValue({
      listings: [{ ...listing, publishedAt: new Date("2026-09-12T07:30:00Z") }],
      requestCount: 2,
      observedCount: 1,
      pageCount: 2,
      rateLimited: true,
      responseStatus: 429,
    }) });

    await processCollectorRun({ source: "OLX", lane: "BACKFILL", trigger: "RECOVERY" });

    expect(mocks.recoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sourceSearchStateId: "state-1", status: "PENDING" },
      data: expect.objectContaining({ pageCount: 2, requestCount: 2, observedCount: 1 }),
    }));
    expect(mocks.handleExternalProtection).toHaveBeenCalledTimes(1);
  });

  it("runs only pending contexts for a recovery job", async () => {
    const pendingContext = { ...context, fingerprint: "pending" };
    mocks.buildSourceSearchPlan.mockResolvedValueOnce([context, pendingContext]);
    mocks.loadSourceSearchState
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, id: "state-2", coverageRecoveryPending: true });

    await processCollectorRun({ source: "OLX", lane: "BACKFILL", trigger: "RECOVERY" });

    const collector = mocks.getCollector.mock.results[0]?.value as { collect: ReturnType<typeof vi.fn> };
    expect(collector.collect).toHaveBeenCalledTimes(1);
    expect(mocks.markSourceSearchSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful coverage lane from owning realtime source health", async () => {
    await processCollectorRun({ source: "OLX", lane: "COVERAGE", trigger: "COVERAGE" });

    expect(mocks.sourceUpdate).not.toHaveBeenCalled();
    expect(mocks.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "SUCCESS",
      coverageMetrics: expect.arrayContaining([expect.objectContaining({ kind: "olx-coverage-queue" })]),
    }));
  });

  it("performs one successful recovery probe and emits one recovery alert", async () => {
    mocks.sourceFindUnique.mockResolvedValueOnce({ ...sourceRecord, status: "RATE_LIMITED" });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.markChallengeProbePending).toHaveBeenCalledWith("source-olx");
    expect(mocks.resolveChallengeIncidents).toHaveBeenCalledWith("source-olx");
    expect(mocks.safeSystemAlert).toHaveBeenCalledWith(expect.stringContaining("Источник восстановлен"));
  });

  it("keeps protection active when a recovery probe is inconclusive", async () => {
    mocks.sourceFindUnique.mockResolvedValueOnce({ ...sourceRecord, status: "RATE_LIMITED", consecutiveErrors: 2 });
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockResolvedValue({
      listings: [], requestCount: 1, observedCount: 0, limited: true, limitedReason: "empty probe",
    }) });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RATE_LIMITED", consecutiveErrors: 2, pausedUntil: expect.any(Date) }),
    }));
    expect(mocks.resolveChallengeIncidents).not.toHaveBeenCalled();
  });

  it("durably observes existing initial-window items while notifying only reliable in-window candidates", async () => {
    const initialContext = {
      ...context,
      initialWindowBehavior: "NOTIFY_MATCHING_IN_WINDOW",
      maxInitialWindowNotifications: 1,
    };
    const reliable = { ...listing, publishedAt: new Date("2026-09-12T07:59:00Z"), timestampConfidence: "HIGH" };
    const unknown = { ...listing, externalId: "olx-2", timestampConfidence: "UNKNOWN" };
    mocks.buildSourceSearchPlan.mockResolvedValueOnce([initialContext]);
    mocks.loadSourceSearchState.mockResolvedValueOnce({ ...state, initialSyncCompletedAt: undefined });
    mocks.getCollector.mockReturnValueOnce({ collect: vi.fn().mockResolvedValue({ listings: [reliable, unknown], observedCount: 2 }) });

    await processCollectorRun({ source: "OLX", lane: "REALTIME" });

    expect(mocks.dispatchListings).toHaveBeenCalledWith([reliable], ["filter-1"], "REALTIME", { used: 0 });
    expect(mocks.recordPendingObservations).toHaveBeenCalledWith([unknown], "REALTIME");
  });
});
