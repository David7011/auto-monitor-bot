import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRiaRealtimeIntervalSeconds } from "../apps/api/src/lib/auto-ria-plan.js";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(),
  ensureState: vi.fn(), ensureSources: vi.fn(), start: vi.fn(),
  env: {
    AUTO_RIA_ACCESS_MODE: "public" as "public" | "api",
    AUTO_RIA_HOURLY_REQUEST_LIMIT: 30,
    LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS: 60,
    LIVE_AUTO_RIA_JITTER_SECONDS: 5,
    LIVE_OLX_INTERVAL_SECONDS: 20,
    LIVE_OLX_JITTER_SECONDS: 4,
  },
}));
vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    monitoringState: { upsert: mocks.upsert },
    source: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
  },
}));
vi.mock("../apps/api/src/env.js", () => ({ env: mocks.env }));
vi.mock("../apps/api/src/modules/monitoring/orchestrator.js", () => ({
  orchestrator: { ensureState: mocks.ensureState, ensureSources: mocks.ensureSources, start: mocks.start },
}));
vi.mock("../apps/api/src/lib/queues.js", () => ({ getQueueCounts: vi.fn() }));
vi.mock("../apps/api/src/modules/monitoring/effective-cadence.js", () => ({ readEffectiveCadence: vi.fn() }));

describe("AUTO.RIA LIVE control cadence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mocks.env.AUTO_RIA_ACCESS_MODE = "public";
    mocks.env.AUTO_RIA_HOURLY_REQUEST_LIMIT = 30;
    mocks.findUnique.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.start.mockResolvedValue({ status: "RUNNING" });
  });

  it("persists 60 seconds on public LIVE start and repeated start despite a 30/hour API quota", async () => {
    const { startLiveMonitoring } = await import("../apps/api/src/modules/monitoring/control.js");
    await startLiveMonitoring();
    await startLiveMonitoring();
    const updates = mocks.updateMany.mock.calls.filter(([query]) => query.where.source === "AUTO_RIA");
    expect(updates).toHaveLength(2);
    for (const [query] of updates) {
      expect(query.data).toMatchObject({ intervalSeconds: 60, jitterSeconds: 5 });
      expect(autoRiaRealtimeIntervalSeconds({
        accessMode: "public", sourceIntervalSeconds: query.data.intervalSeconds,
        minimumIntervalSeconds: 60, contextCount: 4, hourlySearchBudget: 1,
      })).toBe(60);
    }
  });

  it("preserves API quota pacing and the scheduler's context reserve", async () => {
    mocks.env.AUTO_RIA_ACCESS_MODE = "api";
    const { startLiveMonitoring } = await import("../apps/api/src/modules/monitoring/control.js");
    await startLiveMonitoring();
    const [query] = mocks.updateMany.mock.calls.find(([item]) => item.where.source === "AUTO_RIA")!;
    expect(query.data.intervalSeconds).toBe(120);
    expect(autoRiaRealtimeIntervalSeconds({
      accessMode: "api", sourceIntervalSeconds: query.data.intervalSeconds,
      minimumIntervalSeconds: 60, contextCount: 2, hourlySearchBudget: 20,
    })).toBe(360);
  });

  it("sets the public cadence without shortening an active source pause", async () => {
    const pausedUntil = new Date(Date.now() + 120_000);
    mocks.findUnique.mockImplementation(async ({ where }) => where.source === "AUTO_RIA" ? { pausedUntil } : null);
    const { startLiveMonitoring } = await import("../apps/api/src/modules/monitoring/control.js");
    await startLiveMonitoring();
    const [query] = mocks.updateMany.mock.calls.find(([item]) => item.where.source === "AUTO_RIA")!;
    expect(query.data.intervalSeconds).toBe(60);
    expect(query.data.nextCheckAt).toBe(pausedUntil);
    expect(query.data).not.toHaveProperty("pausedUntil");
    expect(query.data).not.toHaveProperty("status");
  });
});
