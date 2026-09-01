import { AbortController, type AbortSignal } from "abort-controller";
import {
  BACKFILL_TELEGRAM_PRIORITY,
  TELEGRAM_SEND_PRIORITY,
  isBackgroundDiscoveryLane,
  type ListingDiscoveryLane,
} from "@amb/shared";

export type FirstNotificationDispatchDependencies = {
  sendInline: (signal: AbortSignal) => Promise<void>;
  enqueueEnrichment: () => Promise<void>;
  enqueueTelegram: (priority: number, delayMs?: number) => Promise<void>;
  warnInlineFailure: (error: unknown) => Promise<void>;
  warnEnrichmentFailure: (error: unknown) => Promise<void>;
};

export class InlineTelegramDeadlineError extends Error {
  constructor(readonly deadlineMs: number, options: { cause?: unknown } = {}) {
    super(`Inline Telegram send exceeded ${deadlineMs}ms`, options);
    this.name = "InlineTelegramDeadlineError";
  }
}

/**
 * Keeps the first notification on the shortest safe path. A failed inline send
 * is converted into a durable queue handoff. An ambiguous slow request remains
 * in flight and gets a lease-delayed fallback; backfill never competes with a
 * realtime notification for the inline Telegram slot.
 */
export async function dispatchFirstNotification(
  input: {
    discoveryLane: ListingDiscoveryLane;
    inlineEnabled: boolean;
    inlineDeadlineMs: number;
    ambiguousRetryDelayMs: number;
  },
  dependencies: FirstNotificationDispatchDependencies,
): Promise<"INLINE" | "IN_FLIGHT" | "QUEUED"> {
  if (!isBackgroundDiscoveryLane(input.discoveryLane) && input.inlineEnabled) {
    const inline = await sendInlineWithinDeadline(dependencies.sendInline, input.inlineDeadlineMs);
    if (inline.kind === "FAILED") {
      await dependencies.warnInlineFailure(inline.error);
      await dependencies.enqueueTelegram(TELEGRAM_SEND_PRIORITY);
      return "QUEUED";
    }
    if (inline.kind === "IN_FLIGHT") {
      await dependencies.warnInlineFailure(new InlineTelegramDeadlineError(input.inlineDeadlineMs));
      // Telegram sendMessage has no idempotency key. Do not abort and
      // immediately repeat an ambiguous request: let it finish, while a
      // durable fallback waits until the notification DB lease expires.
      await dependencies.enqueueTelegram(
        TELEGRAM_SEND_PRIORITY,
        Math.max(1, Math.trunc(input.ambiguousRetryDelayMs)),
      );
      void inline.promise.then(async () => {
        try {
          await dependencies.enqueueEnrichment();
        } catch (error) {
          await dependencies.warnEnrichmentFailure(error);
        }
      }).catch(async (error) => {
        await dependencies.warnInlineFailure(error);
      });
      return "IN_FLIGHT";
    }

    try {
      await dependencies.enqueueEnrichment();
    } catch (error) {
      // Telegram is already confirmed. Enrichment recovery must not turn this
      // into a second send attempt.
      await dependencies.warnEnrichmentFailure(error);
    }
    return "INLINE";
  }

  await dependencies.enqueueTelegram(
    isBackgroundDiscoveryLane(input.discoveryLane) ? BACKFILL_TELEGRAM_PRIORITY : TELEGRAM_SEND_PRIORITY,
  );
  return "QUEUED";
}

type InlineDeadlineResult =
  | { kind: "SENT" }
  | { kind: "FAILED"; error: unknown }
  | { kind: "IN_FLIGHT"; promise: Promise<void> };

async function sendInlineWithinDeadline(
  sendInline: (signal: AbortSignal) => Promise<void>,
  deadlineMs: number,
): Promise<InlineDeadlineResult> {
  const boundedDeadlineMs = Math.max(1, Math.trunc(deadlineMs));
  const controller = new AbortController();
  const promise = sendInline(controller.signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<InlineDeadlineResult>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "IN_FLIGHT", promise }), boundedDeadlineMs);
    timeout.unref?.();
  });
  const settled: Promise<InlineDeadlineResult> = promise.then(
    (): InlineDeadlineResult => ({ kind: "SENT" }),
    (error): InlineDeadlineResult => ({ kind: "FAILED", error }),
  );
  const result = await Promise.race([settled, deadline]);
  if (result.kind !== "IN_FLIGHT" && timeout) clearTimeout(timeout);
  return result;
}
