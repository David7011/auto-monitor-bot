import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
  source: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  recovery: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  runs: { findMany: vi.fn(), findFirst: vi.fn() },
  observations: { findMany: vi.fn(), count: vi.fn() },
  filters: { findMany: vi.fn() },
  audits: { findFirst: vi.fn() },
  incident: { findFirst: vi.fn() },
  enqueue: vi.fn(), log: vi.fn(), canary: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({ prisma: {
  monitoringState: mocks.state, source: mocks.source,
  coverageRecoveryWindow: mocks.recovery, collectorRun: mocks.runs,
  sourceSeenListing: mocks.observations, filter: mocks.filters,
  completenessAudit: mocks.audits, challengeIncident: mocks.incident,
} }));
vi.mock("../apps/api/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));
vi.mock("../apps/api/src/lib/error-log.js", () => ({
  logInfo: mocks.log, logWarn: mocks.log, logError: mocks.log,
}));
vi.mock("../apps/api/src/modules/monitoring/olx-cadence-canary.js", () => ({
  evaluateOlxCadenceCanary: mocks.canary,
}));

import { MonitoringOrchestrator } from "../apps/api/src/modules/monitoring/orchestrator.js";

type TestOrchestrator = {
  running: boolean;
  backgroundTickInProgress: boolean;
  tick(): Promise<void>;
};

describe("orchestrator background isolation", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  let runtime: TestOrchestrator;
  let state: Record<string, unknown>;
  let source: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.resetAllMocks();
    state = {
      id: "singleton", status: "RUNNING", generation: 4, olxCanaryMode: "OFF",
      nextBackfillTickAt: new Date(now.getTime() - 1_000),
      nextCoverageTickAt: new Date(now.getTime() + 60_000),
    };
    source = {
      id: "olx", source: "OLX", enabled: true, status: "ACTIVE", pausedUntil: null,
      intervalSeconds: 4, jitterSeconds: 0, nextCheckAt: new Date(now.getTime() + 4_000),
    };
    mocks.state.upsert.mockImplementation(async () => state);
    mocks.state.findUnique.mockImplementation(async () => state);
    mocks.state.update.mockImplementation(async ({ data }) => Object.assign(state, data));
    mocks.state.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.generation !== state.generation || where.status !== state.status) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    });
    mocks.source.findMany.mockImplementation(async () => [source]);
    mocks.source.findFirst.mockImplementation(async () => source);
    mocks.source.update.mockImplementation(async ({ data }) => Object.assign(source, data));
    mocks.filters.findMany.mockResolvedValue([{ sources: ["OLX"] }]);
    mocks.recovery.findMany.mockResolvedValue([]);
    mocks.recovery.findFirst.mockResolvedValue(null);
    mocks.recovery.count.mockResolvedValue(0);
    mocks.runs.findMany.mockResolvedValue([]);
    mocks.runs.findFirst.mockResolvedValue(null);
    mocks.observations.findMany.mockResolvedValue([]);
    mocks.observations.count.mockResolvedValue(0);
    mocks.audits.findFirst.mockResolvedValue(null);
    mocks.incident.findFirst.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.log.mockResolvedValue(undefined);
    mocks.canary.mockResolvedValue({ transition: "NONE", mode: "BASELINE", intervalSeconds: 4, jitterSeconds: 0 });
    runtime = new MonitoringOrchestrator() as unknown as TestOrchestrator;
    runtime.running = true;
  });

  afterEach(() => {
    runtime.running = false;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function finishBackground(): Promise<void> {
    for (let index = 0; index < 100 && runtime.backgroundTickInProgress; index += 1) {
      await Promise.resolve();
    }
    expect(runtime.backgroundTickInProgress).toBe(false);
  }

  it("enqueues the next OLX realtime run while historical evidence is still blocked", async () => {
    let release!: (value: never[]) => void;
    mocks.recovery.findMany.mockReturnValue(new Promise<never[]>((resolve) => { release = resolve; }));
    await runtime.tick();
    expect(runtime.backgroundTickInProgress).toBe(true);
    source.nextCheckAt = now;
    await runtime.tick();
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.any(String), "collect",
      expect.objectContaining({ source: "OLX", lane: "REALTIME" }), expect.any(Object));
    expect(mocks.recovery.findMany).toHaveBeenCalledTimes(1);
    release([]);
    await finishBackground();
  });

  it("does not enqueue stale background jobs or restore deadlines after monitoring stops", async () => {
    let release!: (value: never[]) => void;
    mocks.recovery.findMany.mockReturnValue(new Promise<never[]>((resolve) => { release = resolve; }));
    await runtime.tick();
    runtime.running = false;
    Object.assign(state, { status: "STOPPED", nextBackfillTickAt: null, nextCoverageTickAt: null });
    release([]);
    await finishBackground();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(state.nextBackfillTickAt).toBeNull();
    expect(state.nextCoverageTickAt).toBeNull();
  });

  it("does not bypass a 429 protection interval when recovery remains pending", async () => {
    mocks.recovery.count.mockResolvedValue(1);
    mocks.runs.findMany.mockResolvedValue([{
      startedAt: new Date(now.getTime() - 60_000), finishedAt: now,
      status: "RATE_LIMITED", recoveredCount: 0, errorMessage: "HTTP 429", coverageMetrics: [],
    }]);
    await runtime.tick();
    await finishBackground();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
