import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
  source: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  recovery: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  runs: { findMany: vi.fn(), findFirst: vi.fn() },
  observations: { findMany: vi.fn(), count: vi.fn() },
  searchStates: { count: vi.fn() },
  filters: { findMany: vi.fn() },
  audits: { findFirst: vi.fn() },
  incident: { findFirst: vi.fn() },
  enqueue: vi.fn(), log: vi.fn(), canary: vi.fn(), recordCadence: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({ prisma: {
  monitoringState: mocks.state, source: mocks.source,
  coverageRecoveryWindow: mocks.recovery, collectorRun: mocks.runs,
  sourceSeenListing: mocks.observations, filter: mocks.filters,
  sourceSearchState: mocks.searchStates,
  completenessAudit: mocks.audits, challengeIncident: mocks.incident,
} }));
vi.mock("../apps/api/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));
vi.mock("../apps/api/src/lib/error-log.js", () => ({
  logInfo: mocks.log, logWarn: mocks.log, logError: mocks.log,
}));
vi.mock("../apps/api/src/modules/monitoring/olx-cadence-canary.js", () => ({
  evaluateOlxCadenceCanary: mocks.canary,
}));
vi.mock("../apps/api/src/modules/monitoring/effective-cadence.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../apps/api/src/modules/monitoring/effective-cadence.js")>();
  return { ...original, recordEffectiveCadence: mocks.recordCadence };
});

import { MonitoringOrchestrator } from "../apps/api/src/modules/monitoring/orchestrator.js";

/**
 * Restart thundering herd: without a stagger every enabled source is due at
 * the same instant and the burst coalesces realtime ticks into SKIPPED holes
 * (+20-40s each). Only past-due first deadlines are spread; legitimate future
 * deadlines (pauses, steady-state cadence) must never move.
 */
describe("orchestrator startup stagger", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.resetAllMocks();
    mocks.state.upsert.mockImplementation(async ({ create }) => create);
    mocks.state.findUnique.mockResolvedValue(null);
    mocks.state.update.mockImplementation(async ({ data }) => data);
    mocks.source.upsert.mockResolvedValue({});
    mocks.filters.findMany.mockResolvedValue([]);
    mocks.recovery.findMany.mockResolvedValue([]);
    mocks.recovery.findFirst.mockResolvedValue(null);
    mocks.recovery.count.mockResolvedValue(0);
    mocks.runs.findMany.mockResolvedValue([]);
    mocks.runs.findFirst.mockResolvedValue(null);
    mocks.observations.findMany.mockResolvedValue([]);
    mocks.observations.count.mockResolvedValue(0);
    mocks.searchStates.count.mockResolvedValue(1);
    mocks.audits.findFirst.mockResolvedValue(null);
    mocks.incident.findFirst.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.log.mockResolvedValue(undefined);
    mocks.canary.mockResolvedValue({ transition: "NONE", mode: "BASELINE", intervalSeconds: 20, jitterSeconds: 4 });
    mocks.recordCadence.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("start() spreads past-due first deadlines and keeps future pauses", async () => {
    const pastA = { source: "AAA", nextCheckAt: new Date(now.getTime() - 60_000) };
    const pastB = { source: "BBB", nextCheckAt: null };
    mocks.source.findMany.mockResolvedValue([pastA, pastB]);
    const updated = new Map<string, Date>();
    mocks.source.update.mockImplementation(async ({ where, data }) => {
      updated.set(where.source, data.nextCheckAt);
      return {};
    });
    mocks.state.findUnique.mockResolvedValue({ id: "singleton", status: "STOPPED", generation: 3 });

    const runtime = new MonitoringOrchestrator();
    await runtime.start();
    await runtime.stop();

    expect(updated.get("AAA")?.getTime()).toBe(now.getTime());
    expect(updated.get("BBB")?.getTime()).toBe(now.getTime() + 3_000);
    expect(updated.size).toBe(2);
  });

  it("resumeIfRunning() staggers only overdue sources", async () => {
    const overdue = { source: "OLX", nextCheckAt: new Date(now.getTime() - 5_000) };
    mocks.source.findMany.mockResolvedValue([overdue]);
    mocks.state.upsert.mockResolvedValue({ id: "singleton", status: "RUNNING", generation: 3 });
    const updated = new Map<string, Date>();
    mocks.source.update.mockImplementation(async ({ where, data }) => {
      updated.set(where.source, data.nextCheckAt);
      return {};
    });
    mocks.state.findUnique.mockResolvedValue({
      id: "singleton", status: "RUNNING", generation: 3,
      nextBackfillTickAt: new Date(now.getTime() + 60_000),
      nextCoverageTickAt: new Date(now.getTime() + 60_000),
    });

    const runtime = new MonitoringOrchestrator();
    await runtime.resumeIfRunning();

    expect(updated.get("OLX")?.getTime()).toBe(now.getTime());
    expect(updated.size).toBe(1);
  });
});
