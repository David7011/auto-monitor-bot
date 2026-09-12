import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenewableTelegramLease } from "../apps/worker/src/modules/telegram-send-lease.js";

describe("renewable Telegram send lease", () => {
  afterEach(() => vi.useRealTimers());

  it("renews through a gate wait longer than the original lease and checks before sending", async () => {
    vi.useFakeTimers();
    let expiresAt = Date.now() + 60_000;
    const renew = vi.fn(async () => {
      if (expiresAt <= Date.now()) return false;
      expiresAt = Date.now() + 60_000;
      return true;
    });
    const send = vi.fn();
    const operation = withRenewableTelegramLease(renew, async (assertOwned) => {
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      await assertOwned();
      send();
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await operation;
    expect(send).toHaveBeenCalledOnce();
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["lost", "unavailable"])("fails closed after renewal is %s", async (kind) => {
    vi.useFakeTimers();
    const send = vi.fn();
    const operation = withRenewableTelegramLease(async () => {
      if (kind === "unavailable") throw new Error("database unavailable");
      return false;
    }, async (assertOwned) => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await assertOwned();
      send();
    });
    const rejected = expect(operation).rejects.toThrow(/lease/i);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap slow renewals or leak a timer after failure", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20_000)));
    const operation = withRenewableTelegramLease(renew, async (assertOwned) => {
      await new Promise((resolve) => setTimeout(resolve, 35_000));
      await assertOwned();
      throw new Error("HTTP failed");
    });
    const rejected = expect(operation).rejects.toThrow("HTTP failed");
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(renew).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
