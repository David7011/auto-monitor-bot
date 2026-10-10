import { prisma } from "@amb/db";
import type { OlxRecoveryUnresolvedReason } from "@amb/shared";
import { log } from "../lib/log.js";

/**
 * Deduplicates "historical window cannot be proven" system alerts.
 *
 * OLX pagination is often unstable for hours, and every collector run opens
 * a fresh recovery window that ends UNRESOLVED. Without suppression each of
 * those windows sends an identical Telegram alert (dozens per day) for a
 * chronic, non-actionable condition: realtime keeps working and the window
 * stays queryable in DB and Dashboard.
 *
 * Policy — alert on transitions only, never on repetition:
 * - first unresolved window for a (search state, reason) alerts;
 * - a different reason alerts (different incident);
 * - a VERIFIED window re-arms the policy, so an incident that returns after
 *   recovery alerts immediately;
 * - any further unresolved window for an already-notified (state, reason)
 *   stays silent (local log only, handled by the caller).
 *
 * Call shouldSendRecoveryUnresolvedAlert() first; if it returns true, send
 * the alert and then call markRecoveryUnresolvedAlerted(). The check fails
 * open (true) on transient DB errors so a genuinely new incident is never
 * silently dropped by a hiccup in the alert gate itself.
 */
export async function shouldSendRecoveryUnresolvedAlert(input: {
  sourceSearchStateId: string;
  windowId: string;
  unresolvedReason: OlxRecoveryUnresolvedReason | null;
}): Promise<boolean> {
  if (!input.unresolvedReason) return true;
  const reason: OlxRecoveryUnresolvedReason = input.unresolvedReason;
  try {
    const current = await prisma.coverageRecoveryWindow.findUnique({
      where: { id: input.windowId },
      select: { acknowledgedAt: true },
    });
    if (!current) return true;
    if (current.acknowledgedAt) return false;
    const lastNotified = await prisma.coverageRecoveryWindow.findFirst({
      where: {
        sourceSearchStateId: input.sourceSearchStateId,
        status: "UNRESOLVED",
        unresolvedReason: reason,
        acknowledgedAt: { not: null },
      },
      orderBy: { unresolvedAt: "desc" },
      select: { unresolvedAt: true, acknowledgedAt: true },
    });
    if (!lastNotified) return true;
    const lastNotifiedAt = lastNotified.unresolvedAt ?? lastNotified.acknowledgedAt;
    if (!lastNotifiedAt) return true;
    const recoveredSince = await prisma.coverageRecoveryWindow.findFirst({
      where: {
        sourceSearchStateId: input.sourceSearchStateId,
        status: "VERIFIED",
        verifiedAt: { gt: lastNotifiedAt },
      },
      select: { id: true },
    });
    return Boolean(recoveredSince);
  } catch (error) {
    await log.warn(
      "collector",
      `Recovery unresolved alert gate check failed; alerting to be safe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

export async function markRecoveryUnresolvedAlerted(input: {
  windowId: string;
  unresolvedReason: OlxRecoveryUnresolvedReason | null;
}): Promise<void> {
  try {
    await prisma.coverageRecoveryWindow.update({
      where: { id: input.windowId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: "system-alert",
        acknowledgementNote: input.unresolvedReason ?? "UNKNOWN",
      },
    });
  } catch (error) {
    await log.warn(
      "collector",
      `Recovery unresolved alert acknowledgement failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
