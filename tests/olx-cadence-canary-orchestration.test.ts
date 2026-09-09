import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stateFind: vi.fn(),
  stateUpdate: vi.fn(),
  runsFind: vi.fn(),
  hotPathFind: vi.fn(),
  getJobCounts: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../packages/db/src/index.js")>();
  return {
    ...original,
    prisma: {
      monitoringState: { findUniqueOrThrow: mocks.stateFind, update: mocks.stateUpdate },
      collectorRun: { findMany: mocks.runsFind },
      sourceSeenListing: { findMany: mocks.hotPathFind },
    },
  };
});
vi.mock("../apps/api/src/env.js", () => ({
  env: {
    LIVE_OLX_INTERVAL_SECONDS: 20,
    LIVE_OLX_JITTER_SECONDS: 4,
    OLX_EXPERIMENT_OWNER: "cadence",
    OLX_CADENCE_CANARY_ENABLED: true,
    OLX_CADENCE_CANARY_QUALIFICATION_RUNS: 100,
    OLX_CADENCE_CANARY_PROMOTION_RUNS: 100,
    OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES: 30,
    OLX_CADENCE_CANARY_P95_MIN_SAMPLES: 30,
    OLX_CADENCE_CANARY_P99_MIN_SAMPLES: 100,
    OLX_CADENCE_CANARY_INTERVAL_SECONDS: 18,
    OLX_CADENCE_CANARY_JITTER_SECONDS: 3,
    OLX_CADENCE_CANARY_QUALIFICATION_MAX_P95_MS: 8_000,
    OLX_CADENCE_CANARY_MAX_P95_MS: 12_000,
    OLX_CADENCE_CANARY_P95_GROWTH_PERCENT: 125,
    OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT: 25,
  },
}));
vi.mock("../apps/api/src/lib/queues.js", () => ({
  getQueue: () => ({ getJobCounts: mocks.getJobCounts }),
}));

import { evaluateOlxCadenceCanary } from "../apps/api/src/modules/monitoring/olx-cadence-canary.js";
import { buildOlxCadenceExperimentDescriptor } from "../apps/api/src/modules/monitoring/olx-cadence-experiment.js";

const now = new Date("2026-09-09T20:00:00.000Z");
const effectiveConfig = {
  owner: "cadence" as const,
  enabled: true,
  baseIntervalSeconds: 20,
  baseJitterSeconds: 4,
  canaryIntervalSeconds: 18,
  canaryJitterSeconds: 3,
  qualificationRuns: 100,
  promotionRuns: 100,
  hotPathMinimumSamples: 30,
  p95MinimumSamples: 30,
  p99MinimumSamples: 100,
  qualificationMaximumP95Ms: 8_000,
  maximumP95Ms: 12_000,
  p95GrowthPercent: 125,
  queueDepthLimit: 25,
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    id: "singleton",
    olxCanaryMode: "ROLLED_BACK",
    olxCanaryQualificationStartedAt: new Date("2026-09-08T00:00:00.000Z"),
    olxCanaryStartedAt: new Date("2026-09-08T01:00:00.000Z"),
    olxCanaryBaselineP95Ms: 4_000,
    olxCanaryCurrentP95Ms: 5_000,
    olxCanaryCleanRunCount: 10,
    olxCanaryRunCount: 10,
    olxCanaryRollbackReason: "old experiment",
    olxCanaryLastEvaluatedRunId: "old-run",
    olxCanaryExperimentId: "old-experiment",
    olxCanaryCodeRevision: "old-revision",
    olxCanaryConfigHash: "old-hash",
    ...overrides,
  };
}

describe("OLX cadence canary orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AMB_CODE_REVISION = "revision-under-test";
    mocks.stateFind.mockResolvedValue(state());
    mocks.stateUpdate.mockResolvedValue({});
    mocks.runsFind.mockResolvedValue([]);
    mocks.hotPathFind.mockResolvedValue([]);
    mocks.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, prioritized: 0 });
  });

  it("starts clean evidence when revision or effective config changes", async () => {
    const decision = await evaluateOlxCadenceCanary({
      baseIntervalSeconds: 20,
      baseJitterSeconds: 4,
      protectionActive: false,
      now,
    });

    expect(decision).toMatchObject({ mode: "BASELINE", qualificationStartedAt: now, cleanRunCount: 0 });
    expect(mocks.runsFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ startedAt: { gte: now } }),
    }));
    expect(mocks.stateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        olxCanaryMode: "BASELINE",
        olxCanaryQualificationStartedAt: now,
        olxCanaryCodeRevision: "revision-under-test",
        olxCanaryConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        olxCanaryConfigSnapshot: effectiveConfig,
      }),
    }));
  });

  it("preserves immediate protection rollback for an unchanged accelerated experiment", async () => {
    const descriptor = buildOlxCadenceExperimentDescriptor({
      config: effectiveConfig,
      codeRevision: "revision-under-test",
      startedAt: now,
    });
    mocks.stateFind.mockResolvedValueOnce(state({
      olxCanaryMode: "CANARY",
      olxCanaryQualificationStartedAt: new Date("2026-09-09T18:00:00.000Z"),
      olxCanaryStartedAt: new Date("2026-09-09T19:00:00.000Z"),
      olxCanaryRollbackReason: null,
      olxCanaryExperimentId: descriptor.experimentId,
      olxCanaryCodeRevision: descriptor.codeRevision,
      olxCanaryConfigHash: descriptor.configHash,
    }));
    mocks.hotPathFind.mockResolvedValueOnce(Array.from({ length: 30 }, (_, id) => ({ id })));

    const decision = await evaluateOlxCadenceCanary({
      baseIntervalSeconds: 20,
      baseJitterSeconds: 4,
      protectionActive: true,
      now,
    });

    expect(decision).toMatchObject({
      mode: "ROLLED_BACK",
      transition: "ROLLBACK",
      rollbackReason: "OLX protection signal",
      intervalSeconds: 20,
      jitterSeconds: 4,
    });
    expect(mocks.stateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ olxCanaryMode: "ROLLED_BACK", olxCanaryRollbackReason: "OLX protection signal" }),
    }));
  });
});
