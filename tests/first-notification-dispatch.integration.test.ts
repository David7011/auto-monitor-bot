import { describe, expect, it, vi } from "vitest";
import type { AbortSignal } from "abort-controller";
import {
  BACKFILL_TELEGRAM_PRIORITY,
  TELEGRAM_SEND_PRIORITY,
} from "../packages/shared/src/constants/queues.js";
import { dispatchFirstNotification } from "../apps/worker/src/modules/first-notification-dispatch.js";

function dependencies() {
  return {
    sendInline: vi.fn(async (_signal: AbortSignal) => undefined),
    enqueueEnrichment: vi.fn(async () => undefined),
    enqueueTelegram: vi.fn(async (_priority: number, _delayMs?: number) => undefined),
    warnInlineFailure: vi.fn(async (_error: unknown) => undefined),
    warnEnrichmentFailure: vi.fn(async (_error: unknown) => undefined),
  };
}

const realtimeInput = {
  discoveryLane: "REALTIME" as const,
  inlineEnabled: true,
  inlineDeadlineMs: 2_500,
  ambiguousRetryDelayMs: 60_250,
};

describe("first notification dispatch integration", () => {
  it("sends realtime inline and enriches only after the first send succeeds", async () => {
    const deps = dependencies();
    const result = await dispatchFirstNotification(
      realtimeInput,
      deps,
    );

    expect(result).toBe("INLINE");
    expect(deps.sendInline).toHaveBeenCalledOnce();
    expect(deps.enqueueEnrichment).toHaveBeenCalledOnce();
    expect(deps.enqueueTelegram).not.toHaveBeenCalled();
  });

  it("durably queues realtime when the inline network call fails", async () => {
    const deps = dependencies();
    deps.sendInline.mockRejectedValueOnce(new Error("telegram unavailable"));
    const result = await dispatchFirstNotification(
      realtimeInput,
      deps,
    );

    expect(result).toBe("QUEUED");
    expect(deps.warnInlineFailure).toHaveBeenCalledOnce();
    expect(deps.enqueueEnrichment).not.toHaveBeenCalled();
    expect(deps.enqueueTelegram).toHaveBeenCalledWith(TELEGRAM_SEND_PRIORITY);
  });

  it("keeps catch-up backfill off the inline slot and uses lower priority", async () => {
    const deps = dependencies();
    const result = await dispatchFirstNotification(
      {
        discoveryLane: "BACKFILL",
        inlineEnabled: true,
        inlineDeadlineMs: 2_500,
        ambiguousRetryDelayMs: 60_250,
      },
      deps,
    );

    expect(result).toBe("QUEUED");
    expect(deps.sendInline).not.toHaveBeenCalled();
    expect(deps.enqueueTelegram).toHaveBeenCalledWith(BACKFILL_TELEGRAM_PRIORITY);
  });

  it("keeps coverage reconciliation off the inline slot and behind realtime", async () => {
    const deps = dependencies();
    const result = await dispatchFirstNotification(
      {
        discoveryLane: "COVERAGE",
        inlineEnabled: true,
        inlineDeadlineMs: 2_500,
        ambiguousRetryDelayMs: 60_250,
      },
      deps,
    );

    expect(result).toBe("QUEUED");
    expect(deps.sendInline).not.toHaveBeenCalled();
    expect(deps.enqueueTelegram).toHaveBeenCalledWith(BACKFILL_TELEGRAM_PRIORITY);
  });

  it("does not retry Telegram when only enrichment enqueue fails", async () => {
    const deps = dependencies();
    deps.enqueueEnrichment.mockRejectedValueOnce(new Error("redis unavailable"));
    const result = await dispatchFirstNotification(realtimeInput, deps);

    expect(result).toBe("INLINE");
    expect(deps.sendInline).toHaveBeenCalledOnce();
    expect(deps.warnEnrichmentFailure).toHaveBeenCalledOnce();
    expect(deps.warnInlineFailure).not.toHaveBeenCalled();
    expect(deps.enqueueTelegram).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous slow send alive and delays fallback until its lease expires", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      let finishInline: (() => void) | undefined;
      deps.sendInline.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishInline = resolve;
      }));

      const pending = dispatchFirstNotification(
        { ...realtimeInput, inlineDeadlineMs: 25 },
        deps,
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBe("IN_FLIGHT");

      const signal = deps.sendInline.mock.calls[0]?.[0];
      expect(signal?.aborted).toBe(false);
      expect(deps.warnInlineFailure).toHaveBeenCalledOnce();
      expect(deps.enqueueTelegram).toHaveBeenCalledWith(TELEGRAM_SEND_PRIORITY, 60_250);
      expect(deps.enqueueEnrichment).not.toHaveBeenCalled();

      finishInline?.();
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(deps.enqueueEnrichment).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
