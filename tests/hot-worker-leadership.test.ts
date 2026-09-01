import { describe, expect, it, vi } from "vitest";
import { HOT_WORKER_LEADER_KEY } from "../packages/shared/src/constants/queues.js";
import {
  HotWorkerLeadership,
  HotWorkerLeadershipLostError,
  type HotWorkerLeaseClient,
} from "../apps/worker/src/modules/hot-worker-leadership.js";

class FakeRedis implements HotWorkerLeaseClient {
  readonly values = new Map<string, string>();

  async set(key: string, value: string, _mode: "PX", _ttlMs: number, _condition: "NX") {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK" as const;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async eval(script: string, _numberOfKeys: number, key: string, ...args: string[]) {
    if (this.values.get(key) !== args[0]) return 0;
    if (script.includes("PEXPIRE")) return 1;
    if (script.includes("DEL")) {
      this.values.delete(key);
      return 1;
    }
    throw new Error("Unexpected script");
  }
}

function replica(redis: FakeRedis, instanceId: "a" | "b") {
  const promoted = vi.fn(async () => undefined);
  const demoted = vi.fn(async () => undefined);
  const leadership = new HotWorkerLeadership({
    redis,
    instanceId,
    token: `token-${instanceId}`,
    leaseTtlMs: 5_000,
    renewIntervalMs: 60_000,
    onPromoted: promoted,
    onDemoted: demoted,
  });
  return { leadership, promoted, demoted };
}

describe("hot worker leadership", () => {
  it("allows exactly one active replica and promotes the standby after release", async () => {
    const redis = new FakeRedis();
    const a = replica(redis, "a");
    const b = replica(redis, "b");

    await a.leadership.runElectionCycle();
    await b.leadership.runElectionCycle();
    expect(a.leadership.isLeader).toBe(true);
    expect(b.leadership.isLeader).toBe(false);
    expect(a.promoted).toHaveBeenCalledOnce();
    expect(b.promoted).not.toHaveBeenCalled();

    await a.leadership.stop();
    await b.leadership.runElectionCycle();
    expect(b.leadership.isLeader).toBe(true);
    expect(b.promoted).toHaveBeenCalledOnce();
    await b.leadership.stop();
  });

  it("demotes on token mismatch and never renews or deletes another owner's lease", async () => {
    const redis = new FakeRedis();
    const a = replica(redis, "a");
    await a.leadership.runElectionCycle();
    redis.values.set(HOT_WORKER_LEADER_KEY, "foreign-owner");

    await a.leadership.runElectionCycle();
    expect(a.leadership.isLeader).toBe(false);
    expect(a.demoted).toHaveBeenCalledWith("lease-lost");
    expect(redis.values.get(HOT_WORKER_LEADER_KEY)).toBe("foreign-owner");

    await a.leadership.stop();
    expect(redis.values.get(HOT_WORKER_LEADER_KEY)).toBe("foreign-owner");
  });

  it("fences requests immediately after ownership is lost", async () => {
    const redis = new FakeRedis();
    const a = replica(redis, "a");
    await a.leadership.runElectionCycle();
    await expect(a.leadership.assertOwnership()).resolves.toBeUndefined();

    redis.values.set(HOT_WORKER_LEADER_KEY, "foreign-owner");
    await expect(a.leadership.assertOwnership()).rejects.toBeInstanceOf(HotWorkerLeadershipLostError);
    expect(a.leadership.isLeader).toBe(false);
    await a.leadership.stop();
  });

  it("releases the lease when consumer promotion fails", async () => {
    const redis = new FakeRedis();
    const demoted = vi.fn(async () => undefined);
    const leadership = new HotWorkerLeadership({
      redis,
      instanceId: "a",
      token: "broken-promotion",
      onPromoted: async () => { throw new Error("worker startup failed"); },
      onDemoted: demoted,
    });

    await expect(leadership.runElectionCycle()).rejects.toThrow("worker startup failed");
    expect(leadership.isLeader).toBe(false);
    expect(demoted).toHaveBeenCalledWith("promotion-failed");
    expect(redis.values.has(HOT_WORKER_LEADER_KEY)).toBe(false);
    await leadership.stop();
  });
});
