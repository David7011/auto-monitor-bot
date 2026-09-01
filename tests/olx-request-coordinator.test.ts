import { describe, expect, it } from "vitest";
import {
  OlxCircuitOpenError,
  OlxRequestCoordinator,
} from "../apps/worker/src/modules/olx-request-coordinator.js";

describe("OLX request coordinator", () => {
  it("serializes the origin and serves queued realtime before background work", async () => {
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 3,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
    });
    const first = deferred<void>();
    const order: string[] = [];
    const running = coordinator.run("REALTIME", async () => {
      order.push("first");
      await first.promise;
    });

    await waitUntil(() => coordinator.snapshot().activeRealtime === 1);
    const background = coordinator.run("COVERAGE", async () => {
      order.push("background");
    });
    const realtime = coordinator.run("REALTIME", async () => {
      order.push("realtime");
      return "hot";
    });

    expect(coordinator.snapshot().activeRealtime).toBe(1);
    expect(coordinator.snapshot().started.REALTIME).toBe(1);
    first.resolve();
    await expect(realtime).resolves.toBe("hot");
    await Promise.all([running, background]);
    expect(order).toEqual(["first", "realtime", "background"]);
  });

  it("preempts an active background request, runs realtime, and transparently resumes background", async () => {
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
    });
    const order: string[] = [];
    let backfillAttempt = 0;
    const backfill = coordinator.run("BACKFILL", async (signal) => {
      backfillAttempt += 1;
      order.push(`backfill-${backfillAttempt}`);
      if (backfillAttempt > 1) return "recovered";
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          order.push("backfill-aborted");
          reject(signal.reason);
        }, { once: true });
      });
    });
    await waitUntil(() => coordinator.snapshot().activeBackgroundClass === "BACKFILL");

    const realtime = coordinator.run("REALTIME", async () => {
      order.push("realtime");
      return "hot";
    });

    await expect(realtime).resolves.toBe("hot");
    await expect(backfill).resolves.toBe("recovered");
    expect(order).toEqual(["backfill-1", "backfill-aborted", "realtime", "backfill-2"]);
    expect(coordinator.snapshot()).toMatchObject({
      realtimePreemptions: 1,
      activeRealtime: 0,
      activeBackground: 0,
      completed: { REALTIME: 1, BACKFILL: 1 },
      started: { REALTIME: 1, BACKFILL: 2 },
    });
  });

  it("prioritizes recovery and coverage ahead of enrichment", async () => {
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
    });
    const first = deferred<void>();
    const order: string[] = [];
    const running = coordinator.run("ENRICHMENT", async () => {
      order.push("first");
      await first.promise;
    });
    await waitUntil(() => coordinator.snapshot().activeBackground === 1);

    const queued = [
      coordinator.run("ENRICHMENT", async () => { order.push("enrichment"); }),
      coordinator.run("BACKFILL", async () => { order.push("backfill"); }),
      coordinator.run("COVERAGE", async () => { order.push("coverage"); }),
      coordinator.run("RECOVERY", async () => { order.push("recovery"); }),
    ];
    first.resolve();
    await Promise.all([running, ...queued]);

    expect(order).toEqual(["first", "recovery", "coverage", "backfill", "enrichment"]);
  });

  it("paces background starts without delaying the first request", async () => {
    let now = 1_000;
    const starts: number[] = [];
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 2,
      backgroundMinIntervalMs: 250,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await Promise.all([
      coordinator.run("COVERAGE", async () => { starts.push(now); }),
      coordinator.run("COVERAGE", async () => { starts.push(now); }),
    ]);

    expect(starts).toEqual([1_000, 1_250]);
  });

  it("keeps the 3.5s background contract isolated from realtime and eventually runs fresh backfill", async () => {
    let now = 1_000;
    const starts: Array<{ requestClass: string; at: number }> = [];
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 3_500,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await coordinator.run("BACKFILL", async () => {
      starts.push({ requestClass: "BACKFILL", at: now });
    });
    await coordinator.run("REALTIME", async () => {
      starts.push({ requestClass: "REALTIME", at: now });
    });
    await coordinator.run("BACKFILL", async () => {
      starts.push({ requestClass: "BACKFILL", at: now });
    });

    expect(starts).toEqual([
      { requestClass: "BACKFILL", at: 1_000 },
      { requestClass: "REALTIME", at: 1_000 },
      { requestClass: "BACKFILL", at: 4_500 },
    ]);
  });

  it("keeps the configured quiet window after realtime before starting background work", async () => {
    let now = 1_000;
    const starts: Array<{ requestClass: string; at: number }> = [];
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 1_000,
      postFinishQuietMs: 350,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await coordinator.run("REALTIME", async () => {
      starts.push({ requestClass: "REALTIME", at: now });
    });
    await coordinator.run("BACKFILL", async () => {
      starts.push({ requestClass: "BACKFILL", at: now });
    });

    expect(starts).toEqual([
      { requestClass: "REALTIME", at: 1_000 },
      { requestClass: "BACKFILL", at: 2_000 },
    ]);
  });

  it("opens the circuit before releasing the slot and rejects queued HTTP work", async () => {
    let now = 1_000;
    const protectedResult = deferred<{ classification: "RATE_LIMITED"; retryAfterSeconds: number }>();
    let queuedCalls = 0;
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 3,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      rateLimitPauseMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    const first = coordinator.run("REALTIME", () => protectedResult.promise);
    await waitUntil(() => coordinator.snapshot().activeRealtime === 1);
    const queued = coordinator.run("COVERAGE", async () => {
      queuedCalls += 1;
      return { classification: "SUCCESS" as const };
    });

    protectedResult.resolve({ classification: "RATE_LIMITED", retryAfterSeconds: 30 });
    await expect(first).resolves.toMatchObject({ classification: "RATE_LIMITED" });
    await expect(queued).rejects.toBeInstanceOf(OlxCircuitOpenError);
    expect(queuedCalls).toBe(0);

    now += 30_000;
    await expect(coordinator.run("REALTIME", async () => "recovered")).resolves.toBe("recovered");
  });

  it("preserves a protection response that wins the realtime abort race", async () => {
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      rateLimitPauseMs: 30_000,
    });
    const background = coordinator.run("BACKFILL", (signal) =>
      new Promise<{ classification: "RATE_LIMITED"; retryAfterSeconds: number }>((resolve) => {
        signal.addEventListener("abort", () => {
          resolve({ classification: "RATE_LIMITED", retryAfterSeconds: 30 });
        }, { once: true });
      }));
    await waitUntil(() => coordinator.snapshot().activeBackgroundClass === "BACKFILL");

    const realtime = coordinator.run("REALTIME", async () => "must-not-run");
    await expect(background).resolves.toMatchObject({ classification: "RATE_LIMITED" });
    await expect(realtime).rejects.toBeInstanceOf(OlxCircuitOpenError);
    expect(coordinator.snapshot()).toMatchObject({
      rateLimited: 1,
      realtimePreemptions: 0,
      completed: { BACKFILL: 1, REALTIME: 0 },
    });
  });

  it("keeps a small post-finish floor without changing normal scheduler cadence", async () => {
    let now = 1_000;
    const starts: number[] = [];
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 350,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await Promise.all([
      coordinator.run("REALTIME", async () => { starts.push(now); }),
      coordinator.run("REALTIME", async () => { starts.push(now); }),
    ]);

    expect(starts).toEqual([1_000, 1_350]);
  });

  it("measures exact queue wait and promotes only consecutive realtime quiet after qualification", async () => {
    let now = 1_000;
    const starts: number[] = [];
    const timings: Array<{ waitMs: number; quietMs: number }> = [];
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 350,
      realtimeQuietCanary: {
        enabled: true,
        candidateQuietMs: 150,
        qualificationRequests: 3,
        evaluationRequests: 2,
        p95GrowthPercent: 120,
        queueDepthLimit: 2,
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    for (let request = 0; request < 5; request += 1) {
      await coordinator.run("REALTIME", async () => {
        starts.push(now);
        return { classification: "SUCCESS" as const };
      }, (timing) => {
        timings.push({
          waitMs: timing.coordinatorWaitMs,
          quietMs: timing.postFinishQuietMs,
        });
      });
    }
    await coordinator.run("COVERAGE", async () => {
      starts.push(now);
      return { classification: "SUCCESS" as const };
    });

    expect(starts).toEqual([1_000, 1_350, 1_700, 1_850, 2_000, 2_350]);
    expect(timings).toEqual([
      { waitMs: 0, quietMs: 350 },
      { waitMs: 350, quietMs: 350 },
      { waitMs: 350, quietMs: 350 },
      { waitMs: 150, quietMs: 150 },
      { waitMs: 150, quietMs: 150 },
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      totalWaitMs: { REALTIME: 1_000 },
      lastWaitMs: { REALTIME: 150 },
      maxWaitMs: { REALTIME: 350 },
      realtimeQuietCanary: {
        mode: "PROMOTED",
        qualifyingSamples: 3,
        canarySamples: 2,
        rollbackReason: null,
      },
    });
  });

  it("rolls the quiet canary back immediately on protection", async () => {
    let now = 1_000;
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 350,
      rateLimitPauseMs: 1_000,
      realtimeQuietCanary: {
        enabled: true,
        candidateQuietMs: 150,
        qualificationRequests: 2,
        evaluationRequests: 2,
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await coordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    await coordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    await coordinator.run("REALTIME", async () => ({
      classification: "RATE_LIMITED" as const,
      retryAfterSeconds: 1,
    }));

    expect(coordinator.snapshot().realtimeQuietCanary).toMatchObject({
      mode: "ROLLED_BACK",
      rollbackReason: "PROTECTION_RATE_LIMITED",
    });
  });

  it("rolls the quiet canary back on p95 growth or realtime queue overflow", async () => {
    let now = 1_000;
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 350,
      realtimeQuietCanary: {
        enabled: true,
        candidateQuietMs: 150,
        qualificationRequests: 2,
        evaluationRequests: 3,
        p95GrowthPercent: 120,
        queueDepthLimit: 2,
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await coordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    await coordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    await coordinator.run("REALTIME", async () => {
      now += 1_000;
      return { classification: "SUCCESS" as const };
    });
    expect(coordinator.snapshot().realtimeQuietCanary).toMatchObject({
      mode: "ROLLED_BACK",
      rollbackReason: expect.stringMatching(/^P95_GROWTH_/u),
    });

    const overflowCoordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      realtimeQuietCanary: {
        enabled: true,
        candidateQuietMs: 0,
        qualificationRequests: 1,
        evaluationRequests: 3,
        queueDepthLimit: 1,
      },
    });
    // A zero baseline disables the speed canary; use a measurable floor.
    const measurableOverflowCoordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 10,
      realtimeQuietCanary: {
        enabled: true,
        candidateQuietMs: 1,
        qualificationRequests: 1,
        evaluationRequests: 3,
        queueDepthLimit: 1,
      },
    });
    expect(overflowCoordinator.snapshot().realtimeQuietCanary.mode).toBe("DISABLED");
    await measurableOverflowCoordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    const blocker = deferred<void>();
    const active = measurableOverflowCoordinator.run("REALTIME", async () => {
      await blocker.promise;
      return { classification: "SUCCESS" as const };
    });
    await waitUntil(() => measurableOverflowCoordinator.snapshot().activeRealtime === 1);
    const queuedOne = measurableOverflowCoordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    const queuedTwo = measurableOverflowCoordinator.run("REALTIME", async () => ({ classification: "SUCCESS" as const }));
    expect(measurableOverflowCoordinator.snapshot().realtimeQuietCanary).toMatchObject({
      mode: "ROLLED_BACK",
      rollbackReason: "REALTIME_QUEUE_DEPTH_2",
    });
    blocker.resolve();
    await Promise.all([active, queuedOne, queuedTwo]);
  });

  it("checks the leadership fence immediately before every origin request", async () => {
    let operationCalls = 0;
    let ownsLease = true;
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      beforeRequest: async () => {
        if (!ownsLease) throw new Error("lease lost");
      },
    });

    await expect(coordinator.run("REALTIME", async () => {
      operationCalls += 1;
      return "ok";
    })).resolves.toBe("ok");
    ownsLease = false;
    await expect(coordinator.run("REALTIME", async () => {
      operationCalls += 1;
    })).rejects.toThrow("lease lost");
    expect(operationCalls).toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
