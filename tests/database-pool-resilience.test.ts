import { describe, expect, it, vi } from "vitest";
import {
  closeDatabaseResources,
  databasePoolConfig,
  isTransientDatabaseConnectError,
  withTransientConnectRetry,
} from "../packages/db/src/database-pool.js";

describe("database pool resilience", () => {
  it("keeps a bounded warm pool to avoid Windows backend churn", () => {
    const config = databasePoolConfig("postgresql://amb@127.0.0.1:55432/auto_monitor", {
      DATABASE_POOL_MAX: "6",
      DATABASE_CONNECT_TIMEOUT_MS: "3000",
      AMB_DATABASE_APPLICATION_NAME: "amb-test",
    });

    expect(config).toMatchObject({
      max: 6,
      min: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 3000,
      keepAlive: true,
      application_name: "amb-test",
    });
  });

  it("recognizes the observed PostgreSQL Windows shared-memory failure", () => {
    expect(isTransientDatabaseConnectError(new Error(
      "could not reserve shared memory region for child: error code 487",
    ))).toBe(true);
    expect(isTransientDatabaseConnectError(Object.assign(new Error("out of memory"), { code: "53200" }))).toBe(true);
  });

  it("does not retry authentication or query errors", async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("password authentication failed"), { code: "28P01" });
    });

    await expect(withTransientConnectRetry(operation, { sleep: async () => undefined })).rejects.toMatchObject({
      code: "28P01",
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("recovers a transient connection creation failure with bounded retries", async () => {
    const retry = vi.fn();
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" }))
      .mockResolvedValueOnce("connected");

    await expect(withTransientConnectRetry(operation, {
      sleep: async () => undefined,
      onRetry: retry,
    })).resolves.toBe("connected");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("fails visibly after the retry budget is exhausted", async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("server closed the connection unexpectedly"), { code: "08006" });
    });

    await expect(withTransientConnectRetry(operation, {
      maxRetries: 2,
      delaysMs: [0],
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "08006" });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("closes the externally owned pool after Prisma disconnects", async () => {
    const order: string[] = [];

    await closeDatabaseResources(
      async () => { order.push("prisma"); },
      async () => { order.push("pool"); },
    );

    expect(order).toEqual(["prisma", "pool"]);
  });

  it("still closes the pool when Prisma disconnect fails", async () => {
    const endPool = vi.fn(async () => undefined);

    await expect(closeDatabaseResources(
      async () => { throw new Error("disconnect failed"); },
      endPool,
    )).rejects.toThrow("disconnect failed");
    expect(endPool).toHaveBeenCalledTimes(1);
  });
});
