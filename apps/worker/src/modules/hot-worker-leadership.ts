import { randomUUID } from "node:crypto";
import {
  HOT_WORKER_LEADER_KEY,
  HOT_WORKER_LEASE_RENEW_INTERVAL_MS,
  HOT_WORKER_LEASE_TTL_MS,
  type HotWorkerInstance,
} from "@amb/shared";

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export type HotWorkerLeaseClient = {
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, key: string, ...args: string[]): Promise<unknown>;
};

export type HotWorkerLeadershipOptions = {
  redis: HotWorkerLeaseClient;
  instanceId: HotWorkerInstance;
  onPromoted: () => Promise<void>;
  onDemoted: (reason: "lease-lost" | "shutdown" | "promotion-failed") => Promise<void>;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  token?: string;
};

export class HotWorkerLeadership {
  private readonly redis: HotWorkerLeaseClient;
  private readonly instanceId: HotWorkerInstance;
  private readonly onPromoted: () => Promise<void>;
  private readonly onDemoted: HotWorkerLeadershipOptions["onDemoted"];
  private readonly leaseTtlMs: number;
  private readonly renewIntervalMs: number;
  private readonly leaseValue: string;
  private leader = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;

  constructor(options: HotWorkerLeadershipOptions) {
    this.redis = options.redis;
    this.instanceId = options.instanceId;
    this.onPromoted = options.onPromoted;
    this.onDemoted = options.onDemoted;
    this.leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? HOT_WORKER_LEASE_TTL_MS);
    this.renewIntervalMs = Math.max(100, options.renewIntervalMs ?? HOT_WORKER_LEASE_RENEW_INTERVAL_MS);
    this.leaseValue = JSON.stringify({
      token: options.token ?? randomUUID(),
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get value(): string {
    return this.leaseValue;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Hot worker leadership cannot be restarted after stop");
    await this.runElectionCycle();
    this.scheduleNextCycle();
  }

  async runElectionCycle(): Promise<void> {
    if (this.stopped || this.cycle) return this.cycle ?? Promise.resolve();
    this.cycle = this.runElectionCycleInner().finally(() => {
      this.cycle = null;
    });
    return this.cycle;
  }

  async assertOwnership(): Promise<void> {
    if (!this.leader) throw new HotWorkerLeadershipLostError();
    const current = await this.redis.get(HOT_WORKER_LEADER_KEY);
    if (current !== this.leaseValue) {
      await this.demote("lease-lost");
      throw new HotWorkerLeadershipLostError();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.cycle) await this.cycle.catch(() => undefined);
    if (this.leader) await this.demote("shutdown");
    await this.compareAndRelease().catch(() => undefined);
  }

  private async runElectionCycleInner(): Promise<void> {
    try {
      if (this.leader) {
        const renewed = await this.redis.eval(
          RENEW_SCRIPT,
          1,
          HOT_WORKER_LEADER_KEY,
          this.leaseValue,
          String(this.leaseTtlMs),
        );
        if (Number(renewed) !== 1) await this.demote("lease-lost");
        return;
      }

      const acquired = await this.redis.set(
        HOT_WORKER_LEADER_KEY,
        this.leaseValue,
        "PX",
        this.leaseTtlMs,
        "NX",
      );
      if (acquired !== "OK") return;
      this.leader = true;
      try {
        await this.onPromoted();
      } catch (error) {
        await this.demote("promotion-failed").catch(() => undefined);
        await this.compareAndRelease().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (this.leader) await this.demote("lease-lost");
      throw error;
    }
  }

  private async demote(reason: "lease-lost" | "shutdown" | "promotion-failed"): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    await this.onDemoted(reason);
  }

  private async compareAndRelease(): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, HOT_WORKER_LEADER_KEY, this.leaseValue);
  }

  private scheduleNextCycle(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runElectionCycle()
        .catch(() => undefined)
        .finally(() => this.scheduleNextCycle());
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }
}

export class HotWorkerLeadershipLostError extends Error {
  constructor() {
    super("Hot worker leadership lease is not owned by this process");
    this.name = "HotWorkerLeadershipLostError";
  }
}
