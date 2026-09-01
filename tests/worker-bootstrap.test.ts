import { describe, expect, it } from "vitest";
import { bootstrapWorkerRuntime } from "../apps/worker/src/modules/worker-bootstrap.js";

describe("worker bootstrap", () => {
  it("makes queue workers ready before deferring startup maintenance", async () => {
    const ready = deferred<void>();
    const order: string[] = [];
    const bootstrap = bootstrapWorkerRuntime({
      prewarmDatabase: async () => { order.push("database-warm"); },
      createQueueWorkers: () => { order.push("workers-created"); },
      waitForQueueWorkers: async () => {
        order.push("workers-waiting");
        await ready.promise;
        order.push("workers-ready");
      },
      writeHeartbeat: async () => { order.push("heartbeat"); },
      deferStartupMaintenance: () => { order.push("maintenance-deferred"); },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["database-warm", "workers-created", "workers-waiting"]);

    ready.resolve();
    await bootstrap;
    expect(order).toEqual([
      "database-warm",
      "workers-created",
      "workers-waiting",
      "workers-ready",
      "heartbeat",
      "maintenance-deferred",
    ]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
