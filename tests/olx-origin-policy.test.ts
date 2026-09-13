import { beforeEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => vi.fn());
vi.mock("../packages/db/src/index.js", () => ({ prisma: { source: { findUnique: source } } }));
import { createOlxOriginPolicy, OlxOriginDeferredError, OlxRequestCoordinator } from "../apps/worker/src/modules/olx-request-coordinator.js";

describe("durable OLX origin policy", () => {
  beforeEach(() => { source.mockReset(); source.mockResolvedValue({ enabled: true, status: "ACTIVE", pausedUntil: null }); });

  it.each(["REALTIME", "RECOVERY", "BACKFILL", "COVERAGE", "ENRICHMENT"] as const)("blocks %s during a persisted pause before HTTP", async (requestClass) => {
    source.mockResolvedValue({ enabled: true, status: "PAUSED", pausedUntil: new Date(Date.now() + 60_000) });
    const operation = vi.fn();
    const coordinator = new OlxRequestCoordinator({ maxBackgroundConcurrency: 1, backgroundMinIntervalMs: 0, backgroundQuietAfterRealtimeMs: 0, postFinishQuietMs: 0, beforeRequest: createOlxOriginPolicy(async () => {}) });
    await expect(coordinator.run(requestClass, operation)).rejects.toBeInstanceOf(OlxOriginDeferredError);
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ rateLimited: 0, challenges: 0, accessDenied: 0 });
  });

  it("allows only an owned realtime probe after pause expiry", async () => {
    source.mockResolvedValue({ enabled: true, status: "PAUSED", pausedUntil: new Date(0) });
    const guard = vi.fn(async () => {});
    const policy = createOlxOriginPolicy(guard);
    await expect(policy("REALTIME")).resolves.toBeUndefined();
    await expect(policy("ENRICHMENT")).rejects.toBeInstanceOf(OlxOriginDeferredError);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("blocks a non-owner before querying policy or invoking HTTP", async () => {
    await expect(createOlxOriginPolicy(async () => { throw new OlxOriginDeferredError(); })("RECOVERY")).rejects.toBeInstanceOf(OlxOriginDeferredError);
    expect(source).not.toHaveBeenCalled();
  });

  it.each([null, { enabled: false, status: "ACTIVE", pausedUntil: null }])("fails closed for absent/disabled source", async (state) => {
    source.mockResolvedValue(state);
    await expect(createOlxOriginPolicy(async () => {})("REALTIME")).rejects.toBeInstanceOf(OlxOriginDeferredError);
  });
});
