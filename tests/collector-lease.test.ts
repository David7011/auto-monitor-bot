import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorLease, CollectorLeaseLostError, activeCollectorLease } from "../apps/worker/src/modules/collector-lease.js";

describe("collector ownership fencing", () => {
  afterEach(() => { vi.useRealTimers(); });
  it.each(["zero", "error"])("latches loss after renewal %s", async (mode) => {
    vi.useFakeTimers();
    const owns = vi.fn(async () => true);
    const lease = new CollectorLease({ ttlMs: 300, renewalIntervalMs: 100, owns, renew: async () => { if (mode === "error") throw new Error("Redis deadline"); return false; } });
    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.assertOwnership()).rejects.toBeInstanceOf(CollectorLeaseLostError);
      expect(owns).not.toHaveBeenCalled();
    } finally { lease.stop(); }
  });
  it("does not overlap renewals or resurrect an owner with a late ACK", async () => {
    vi.useFakeTimers();
    let resolve!: (result: boolean) => void;
    const renew = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const lease = new CollectorLease({ ttlMs: 300, renewalIntervalMs: 100, owns: async () => true, renew });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(renew).toHaveBeenCalledOnce();
      resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      await expect(lease.assertOwnership()).rejects.toBeInstanceOf(CollectorLeaseLostError);
    } finally { lease.stop(); }
  });
  it("fences a foreign owner and passes an abort signal through request scope", async () => {
    const lease = new CollectorLease({ ttlMs: 1000, owns: async () => false, renew: async () => true });
    try {
      await lease.run(async () => {
        expect(activeCollectorLease()).toBe(lease);
        await expect(lease.assertOwnership()).rejects.toBeInstanceOf(CollectorLeaseLostError);
        expect(lease.signal.aborted).toBe(true);
      });
      expect(activeCollectorLease()).toBeUndefined();
    } finally { lease.stop(); }
  });
});
