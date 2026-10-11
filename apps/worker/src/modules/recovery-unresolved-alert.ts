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
 * - a sustained quiet period (no unresolved window for the same key) means
 *   the incident is over, so the next failure alerts as a new incident.
 * A lone VERIFIED window amid ongoing failures must NOT re-arm: fluke
 * verifications happen inside chronic episodes and would re-open the spam.
 *
 * Call shouldSendRecoveryUnresolvedAlert() first; if it returns true, send
 * the alert and then call markRecoveryUnresolvedAlerted(). The check fails
 * open (true) on transient DB errors so a genuinely new incident is never
 * silently dropped by a hiccup in the alert gate itself.
 */
export const RECOVERY_QUIET_HOURS = 12;

export async function shouldSendRecoveryUnresolvedAlert(input: {
  sourceSearchStateId: string;
  windowId: string;
  unresolvedReason: OlxRecoveryUnresolvedReason | null;
}): Promise<boolean> {
  if (!input.unresolvedReason) return true;
  const reason: OlxRecoveryUnresolvedReason = input.unresolvedReason;
  const now = new Date();
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
    const quietSince = new Date(now.getTime() - RECOVERY_QUIET_HOURS * 3_600_000);
    const recentUnresolved = await prisma.coverageRecoveryWindow.findFirst({
      where: {
        sourceSearchStateId: input.sourceSearchStateId,
        status: "UNRESOLVED",
        unresolvedReason: reason,
        unresolvedAt: { gte: quietSince },
        NOT: { id: input.windowId },
      },
      select: { id: true },
    });
    return !recentUnresolved;
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
