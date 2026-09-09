import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sourceFindUnique: vi.fn(),
  runCreate: vi.fn(),
  incidentFindFirst: vi.fn(),
  getCollector: vi.fn(),
  buildSourceSearchPlan: vi.fn(),
  redisSet: vi.fn(),
  scheduledJobState: vi.fn(),
  retryLockCollision: vi.fn(),
  olxProtectionCoolingState: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    source: { findUnique: mocks.sourceFindUnique },
    collectorRun: { create: mocks.runCreate },
    challengeIncident: { findFirst: mocks.incidentFindFirst },
  },
}));
vi.mock("../apps/worker/src/collectors/index.js", () => ({ getCollector: mocks.getCollector }));
vi.mock("../apps/worker/src/env.js", () => ({
  env: {
    OLX_PROTECTION_COOLING_SECONDS: 1_800,
    OLX_COVERAGE_MAX_DURATION_MS: 30_000,
  },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: mocks.logWarn } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  enqueue: vi.fn(),
  redisConnection: { set: mocks.redisSet },
}));
vi.mock("../apps/worker/src/modules/challenge-incident.js", () => ({
  markChallengeProbePending: vi.fn(),
  resolveChallengeIncidents: vi.fn(),
}));
vi.mock("../apps/worker/src/modules/source-search-plan.js", () => ({
  buildSourceSearchPlan: mocks.buildSourceSearchPlan,
  contextForCoverageRecovery: vi.fn(),
  loadSourceSearchState: vi.fn(),
  markSourceSearchSuccess: vi.fn(),
}));
vi.mock("../apps/worker/src/modules/olx-lane-arbiter.js", () => ({ olxLaneArbiter: {} }));
vi.mock("../apps/worker/src/modules/olx-protection-cooling.js", () => ({
  olxProtectionCoolingState: mocks.olxProtectionCoolingState,
}));
vi.mock("../apps/worker/src/modules/source-health-ownership.js", () => ({
  laneOwnsSourceHealth: (lane: string) => lane === "REALTIME",
}));
vi.mock("../apps/worker/src/modules/observation-journal.js", () => ({ recordPendingObservations: vi.fn() }));
vi.mock("../apps/worker/src/modules/realtime-dispatch-policy.js", () => ({ realtimeHotHandoffEnabled: vi.fn() }));
vi.mock("../apps/worker/src/processors/collector-run-helpers.js", () => ({
  calculateHealthScore: vi.fn(),
  collectorLockScope: () => "default",
  countProcessingResult: vi.fn(),
  dispatchListings: vi.fn(),
  elapsedMs: vi.fn(),
  finishRun: vi.fn(),
  formatKyivDate: vi.fn(),
  handleExternalProtection: vi.fn(),
  normalizeCollectedBatch: vi.fn(),
  outageRecoveryListings: vi.fn(),
  releaseLock: vi.fn(),
  renewLock: vi.fn(),
  resolveLane: (job: { lane?: string }) => job.lane ?? "REALTIME",
  resolveTrigger: (job: { trigger?: string }) => job.trigger ?? "SCHEDULED",
  retryLockCollision: mocks.retryLockCollision,
  safeSystemAlert: vi.fn(),
  scanDurationMs: () => 30_000,
  scanOptions: vi.fn(),
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
};
const context = { categoryKey: "vehicle.car", fingerprint: "fingerprint", filterIds: ["filter-1"] };

describe("collector.run glue preflight invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCollector.mockReturnValue({ collect: vi.fn() });
    mocks.sourceFindUnique.mockResolvedValue(sourceRecord);
    mocks.buildSourceSearchPlan.mockResolvedValue([context]);
    mocks.scheduledJobState.mockResolvedValue({ stale: false });
    mocks.incidentFindFirst.mockResolvedValue(null);
    mocks.olxProtectionCoolingState.mockReturnValue({ active: false, until: null });
    mocks.redisSet.mockResolvedValue(null);
    mocks.runCreate.mockResolvedValue({ id: "run-1" });
    mocks.retryLockCollision.mockResolvedValue(undefined);
    mocks.logWarn.mockResolvedValue(undefined);
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
});
