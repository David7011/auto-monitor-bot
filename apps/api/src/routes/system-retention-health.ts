import { prisma } from "@amb/db";
import { env } from "../env.js";

export type CheckStatus = "OK" | "WARN" | "FAIL";
export type HealthStatus = CheckStatus | "NOT_CONFIGURED" | "IDLE";

export type ListingRetentionHealth = {
  status: HealthStatus;
  dueNow: number;
  overdue: number;
  unmanagedFresh: number;
  invalid: number;
  message: string;
};

export async function getListingRetentionHealth(checkedAt: Date): Promise<ListingRetentionHealth> {
  const regularCutoff = new Date(checkedAt.getTime() - env.LISTING_RETENTION_HOURS * 60 * 60 * 1000);
  const graceMs = Math.max(15 * 60 * 1000, env.LISTING_CLEANUP_INTERVAL_MS * 3);
  const overdueCutoff = new Date(checkedAt.getTime() - graceMs);
  const [
    dueRegular,
    dueFavorites,
    overdueRegular,
    overdueFavorites,
    legacyOverdue,
    orphanedOverdue,
    unmanagedFresh,
    favoriteWithoutDeadline,
    deadlineWithoutFavorite,
    favoriteWithRegularDeadline,
    appliedWithoutDeadline,
  ] = await Promise.all([
    prisma.telegramNotification.count({
      where: { favoritedAt: null, retentionPolicyAppliedAt: { not: null }, deleteAfter: { lte: checkedAt } },
    }),
    prisma.telegramNotification.count({
      where: { favoritedAt: { not: null }, retainUntil: { lte: checkedAt } },
    }),
    prisma.telegramNotification.count({
      where: { favoritedAt: null, retentionPolicyAppliedAt: { not: null }, deleteAfter: { lte: overdueCutoff } },
    }),
    prisma.telegramNotification.count({
      where: { favoritedAt: { not: null }, retainUntil: { lte: overdueCutoff } },
    }),
    prisma.telegramNotification.count({
      where: {
        favoritedAt: null,
        retentionPolicyAppliedAt: null,
        OR: [{ sentAt: { lte: regularCutoff } }, { sentAt: null, createdAt: { lte: regularCutoff } }],
      },
    }),
    prisma.listing.count({
      where: { firstSeenAt: { lte: regularCutoff }, telegramNotifications: { none: {} } },
    }),
    prisma.telegramNotification.count({
      where: {
        retentionPolicyAppliedAt: null,
        sentAt: { gte: regularCutoff },
        messageId: { not: null },
      },
    }),
    prisma.telegramNotification.count({ where: { favoritedAt: { not: null }, retainUntil: null } }),
    prisma.telegramNotification.count({ where: { favoritedAt: null, retainUntil: { not: null } } }),
    prisma.telegramNotification.count({ where: { favoritedAt: { not: null }, deleteAfter: { not: null } } }),
    prisma.telegramNotification.count({
      where: {
        retentionPolicyAppliedAt: { not: null },
        favoritedAt: null,
        deleteAfter: null,
      },
    }),
  ]);

  const dueNow = dueRegular + dueFavorites;
  const overdue = overdueRegular + overdueFavorites + legacyOverdue + orphanedOverdue;
  const invalid = favoriteWithoutDeadline
    + deadlineWithoutFavorite
    + favoriteWithRegularDeadline
    + appliedWithoutDeadline;
  const status: HealthStatus = invalid > 0
    ? "FAIL"
    : overdue > 0 || unmanagedFresh > 0
      ? "WARN"
      : "OK";
  const message = status === "OK"
    ? `Политика хранения соблюдается; к ближайшей очистке: ${dueNow}`
    : status === "FAIL"
      ? `Нарушений целостности: ${invalid}; просрочено: ${overdue}; ожидают принятия политики: ${unmanagedFresh}`
      : `Просрочено с учетом ${Math.round(graceMs / 60_000)} мин запаса: ${overdue}; ожидают принятия политики: ${unmanagedFresh}; к ближайшей очистке: ${dueNow}`;

  return { status, dueNow, overdue, unmanagedFresh, invalid, message };
}
