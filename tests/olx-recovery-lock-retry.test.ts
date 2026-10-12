import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ttl: vi.fn(), enqueue: vi.fn(), info: vi.fn() }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ redisConnection: { pttl: mocks.ttl }, enqueue: mocks.enqueue }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { info: mocks.info, warn: vi.fn(), error: vi.fn() } }));
import { retryLockCollision } from "../apps/worker/src/processors/collector-run-helpers.js";
import { env } from "../apps/worker/src/env.js";

beforeEach(() => { vi.clearAllMocks(); mocks.ttl.mockResolvedValue(180_000); });
describe("durable recovery across a surviving collector lease", () => {
  it("queues one recovery after the actual TTL rather than exhausting a short retry", async () => {
    await retryLockCollision({ source: "OLX", trigger: "RECOVERY", lane: "BACKFILL", monitoringGeneration: 3 }, "BACKFILL");
    expect(mocks.ttl).toHaveBeenCalledWith("collector-lock:OLX:BACKFILL");
    expect(mocks.enqueue).toHaveBeenCalledWith("collector.backfill", "collect", expect.objectContaining({
      trigger: "RECOVERY", lockRetryCount: 1,
    }), expect.objectContaining({ delay: 180_250 }));
  });
  it("keeps retry bounded when the lock owner still has useful work", async () => {
    await retryLockCollision({ source: "OLX", trigger: "RECOVERY", lane: "BACKFILL", lockRetryCount: 1 }, "BACKFILL");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.ttl).not.toHaveBeenCalled();
  });
  it("uses the normal delay if the competing lease expired before the TTL read", async () => {
    mocks.ttl.mockResolvedValue(-2);
    await retryLockCollision({ source: "OLX", trigger: "RECOVERY", lane: "BACKFILL" }, "BACKFILL");
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.any(String), "collect", expect.any(Object),
      expect.objectContaining({ delay: env.COLLECTOR_LOCK_RETRY_DELAY_MS }));
  });
  it("keeps realtime coalesced without a delayed source burst", async () => {
    await retryLockCollision({ source: "OLX", trigger: "SCHEDULED", lane: "REALTIME" }, "REALTIME");
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.ttl).not.toHaveBeenCalled();
  });
});
