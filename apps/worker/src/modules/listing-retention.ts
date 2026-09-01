import { acquireTelegramRetentionLock, Prisma, prisma } from "@amb/db";
import type { ListingDiscoveryLane } from "@amb/shared";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import {
  applyListingRetentionKeyboard,
  cleanupListingTelegramMessage,
} from "./telegram-service.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINIMUM_RETRY_DELAY_MS = 15 * 60 * 1000;

export type ListingRetentionSummary = {
  selected: number;
  deletedListings: number;
  detachedObservations: number;
  telegramCleared: number;
  legacyLocalOnly: number;
  deferred: number;
  skipped: number;
};

export function listingRetentionCutoffs(
  now: Date,
  retentionHours = env.LISTING_RETENTION_HOURS,
  favoriteRetentionDays = env.LISTING_FAVORITE_RETENTION_DAYS,
): { regular: Date; favorite: Date } {
  return {
    regular: new Date(now.getTime() - retentionHours * HOUR_MS),
    favorite: new Date(now.getTime() - favoriteRetentionDays * DAY_MS),
  };
}

function cleanupRetryBefore(now: Date): Date {
  return new Date(now.getTime() - Math.max(MINIMUM_RETRY_DELAY_MS, env.LISTING_CLEANUP_INTERVAL_MS));
}

function dueListingWhere(now: Date): Prisma.ListingWhereInput {
  const { regular } = listingRetentionCutoffs(now);
  const retryBefore = cleanupRetryBefore(now);
  const claimAvailable: Prisma.TelegramNotificationWhereInput = {
    OR: [{ cleanupAttemptedAt: null }, { cleanupAttemptedAt: { lte: retryBefore } }],
  };

  return {
    OR: [
      {
        telegramNotifications: {
          some: {
            AND: [
              claimAvailable,
              notificationCleanupEligibility(now, regular),
            ],
          },
        },
      },
    ],
  };
}

function notificationCleanupEligibility(
  now: Date,
  regular: Date,
): Prisma.TelegramNotificationWhereInput {
  return {
    OR: [
      { favoritedAt: { not: null }, retainUntil: { lte: now } },
      {
        favoritedAt: null,
        retentionPolicyAppliedAt: { not: null },
        deleteAfter: { lte: now },
      },
      {
        favoritedAt: null,
        retentionPolicyAppliedAt: null,
        status: { in: ["SENT", "UPDATED"] },
        messageId: { not: null },
        sentAt: { lte: regular },
      },
    ],
  };
}

export async function previewListingRetention(now = new Date()): Promise<{
  due: number;
  expiredFavorites: number;
  legacyLocalOnly: number;
  withoutNotification: number;
}> {
  const { regular } = listingRetentionCutoffs(now);
  const [due, expiredFavorites, legacyLocalOnly, withoutNotification] = await Promise.all([
    prisma.listing.count({ where: dueListingWhere(now) }),
    prisma.listing.count({
      where: { telegramNotifications: { some: { favoritedAt: { not: null }, retainUntil: { lte: now } } } },
    }),
    prisma.listing.count({
      where: {
        telegramNotifications: {
          some: {
            favoritedAt: null,
            retentionPolicyAppliedAt: null,
            OR: [{ sentAt: { lte: regular } }, { sentAt: null, createdAt: { lte: regular } }],
          },
        },
      },
    }),
    prisma.listing.count({
      where: { firstSeenAt: { lte: regular }, telegramNotifications: { none: {} } },
    }),
  ]);
  return { due, expiredFavorites, legacyLocalOnly, withoutNotification };
}

export async function adoptFreshListingNotifications(now = new Date()): Promise<{
  selected: number;
  adopted: number;
  deferred: number;
  permanentFailures: number;
}> {
  const { regular } = listingRetentionCutoffs(now);
  const notifications = await prisma.telegramNotification.findMany({
    where: {
      retentionPolicyAppliedAt: null,
      sentAt: { gte: regular },
      messageId: { not: null },
      favoritedAt: null,
    },
    orderBy: { sentAt: "desc" },
    take: env.LISTING_CLEANUP_BATCH_SIZE,
    select: {
      id: true,
      listingId: true,
      chatId: true,
      messageId: true,
      sentAt: true,
      listing: { select: { url: true } },
    },
  });
  const summary = { selected: notifications.length, adopted: 0, deferred: 0, permanentFailures: 0 };

  for (const notification of notifications) {
    if (!notification.messageId || !notification.sentAt) continue;
    const result = await applyListingRetentionKeyboard({
      chatId: notification.chatId,
      messageId: notification.messageId,
      listingId: notification.listingId,
      url: notification.listing.url,
    });
    if (result.outcome === "RETRY") {
      summary.deferred += 1;
      await prisma.telegramNotification.updateMany({
        where: { id: notification.id, retentionPolicyAppliedAt: null },
        data: { lastErrorCode: result.errorCode, lastErrorMessage: result.errorMessage },
      });
      continue;
    }
    if (result.outcome === "PERMANENT_FAILURE") {
      summary.permanentFailures += 1;
      await prisma.telegramNotification.updateMany({
        where: { id: notification.id, retentionPolicyAppliedAt: null },
        data: { lastErrorCode: "TELEGRAM_MARKUP_PERMANENT", lastErrorMessage: result.errorMessage },
      });
      continue;
    }

    const adopted = await prisma.telegramNotification.updateMany({
      where: { id: notification.id, retentionPolicyAppliedAt: null },
      data: {
        deleteAfter: new Date(notification.sentAt.getTime() + env.LISTING_RETENTION_HOURS * HOUR_MS),
        retentionPolicyAppliedAt: now,
        cleanupAttemptedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    summary.adopted += adopted.count;
  }

  if (summary.selected) {
    await log.info(
      "listing-retention",
      `Adopted ${summary.adopted}/${summary.selected} fresh Telegram messages; deferred ${summary.deferred}, permanent failures ${summary.permanentFailures}`,
    );
  }
  return summary;
}

export async function runListingRetentionMaintenance(
  now = new Date(),
  batchSize = env.LISTING_CLEANUP_BATCH_SIZE,
): Promise<ListingRetentionSummary> {
  const candidates = await prisma.listing.findMany({
    where: dueListingWhere(now),
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    take: Math.max(1, batchSize),
    select: {
      id: true,
      source: true,
      externalId: true,
      url: true,
      canonicalUrl: true,
      firstSeenAt: true,
      discoveryLane: true,
      telegramNotifications: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          status: true,
          sentAt: true,
          deleteAfter: true,
          favoritedAt: true,
          retainUntil: true,
          retentionPolicyAppliedAt: true,
          cleanupAttemptedAt: true,
        },
      },
    },
  });

  const summary: ListingRetentionSummary = {
    selected: candidates.length,
    deletedListings: 0,
    detachedObservations: 0,
    telegramCleared: 0,
    legacyLocalOnly: 0,
    deferred: 0,
    skipped: 0,
  };
  const retryBefore = cleanupRetryBefore(now);
  const { regular } = listingRetentionCutoffs(now);

  for (const candidate of candidates) {
    const notification = candidate.telegramNotifications[0];
    if (!notification) continue;

    const claim = await claimListingRetention(candidate.id, notification.id, now, retryBefore, regular);
    if (!claim) {
      summary.skipped += 1;
      continue;
    }

    const telegramResult = claim.legacyLocalOnly
      ? { outcome: "CLEARED" as const, detail: "Legacy local-only notification" }
      : await cleanupListingTelegramMessage({
          chatId: claim.chatId,
          messageId: claim.messageId,
          favoriteExpired: claim.favoriteExpired,
        });

    if (telegramResult.outcome === "RETRY") {
      await prisma.telegramNotification.updateMany({
        where: { id: claim.id, cleanupAttemptedAt: now },
        data: {
          lastErrorCode: telegramResult.errorCode,
          lastErrorMessage: telegramResult.errorMessage,
        },
      });
      summary.deferred += 1;
      continue;
    }

    const cleanup = await finalizeListingRetention(candidate, claim.id, now, regular, claim.legacyLocalOnly);
    summary.telegramCleared += cleanup.telegramCleared;
    summary.legacyLocalOnly += cleanup.legacyLocalOnly;
    summary.detachedObservations += cleanup.tombstone;
    summary.deletedListings += cleanup.deleted;
    if (cleanup.outcome === "SKIPPED") summary.skipped += 1;
  }

  if (summary.deletedListings || summary.deferred) {
    await log.info(
      "listing-retention",
      `Selected ${summary.selected}; deleted ${summary.deletedListings} listings, cleared ${summary.telegramCleared} Telegram messages, preserved ${summary.detachedObservations} dedupe tombstones, locally purged ${summary.legacyLocalOnly} legacy rows, deferred ${summary.deferred}`,
    );
  }
  return summary;
}

type RetentionCandidate = {
  id: string;
  source: "OLX" | "RST" | "AUTO_RIA" | "CARS_UA" | "AUTOMOTO" | "MOCK";
  externalId: string;
  url: string;
  canonicalUrl: string;
  firstSeenAt: Date;
  discoveryLane: ListingDiscoveryLane;
};

async function claimListingRetention(
  listingId: string,
  notificationId: string,
  now: Date,
  retryBefore: Date,
  regular: Date,
): Promise<{
  id: string;
  chatId: string;
  messageId: string | null;
  favoriteExpired: boolean;
  legacyLocalOnly: boolean;
} | null> {
  return prisma.$transaction(async (tx) => {
    await acquireTelegramRetentionLock(tx, listingId);
    const notification = await tx.telegramNotification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        chatId: true,
        messageId: true,
        status: true,
        sentAt: true,
        deleteAfter: true,
        favoritedAt: true,
        retainUntil: true,
        retentionPolicyAppliedAt: true,
        cleanupAttemptedAt: true,
      },
    });
    if (!notification) return null;
    if (notification.cleanupAttemptedAt && notification.cleanupAttemptedAt > retryBefore) return null;
    if (!notificationCleanupDue(notification, now, regular)) return null;

    await tx.telegramNotification.update({
      where: { id: notification.id },
      data: { cleanupAttemptedAt: now },
    });
    return {
      id: notification.id,
      chatId: notification.chatId,
      messageId: notification.messageId,
      favoriteExpired: Boolean(
        notification.favoritedAt && notification.retainUntil && notification.retainUntil <= now,
      ),
      legacyLocalOnly: !notification.retentionPolicyAppliedAt,
    };
  }, { maxWait: 5_000, timeout: 5_000 });
}

async function finalizeListingRetention(
  candidate: RetentionCandidate,
  notificationId: string,
  now: Date,
  regular: Date,
  legacyLocalOnly: boolean,
) {
  return prisma.$transaction(async (tx) => {
    await acquireTelegramRetentionLock(tx, candidate.id);
    const refreshed = await tx.telegramNotification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        status: true,
        messageId: true,
        sentAt: true,
        deleteAfter: true,
        favoritedAt: true,
        retainUntil: true,
        retentionPolicyAppliedAt: true,
        cleanupAttemptedAt: true,
      },
    });
    const telegramCleared = legacyLocalOnly ? 0 : 1;
    if (!refreshed || !notificationStillDue(refreshed, now, regular)) {
      return { outcome: "SKIPPED", telegramCleared, legacyLocalOnly: 0, tombstone: 0, deleted: 0 } as const;
    }
    if (!refreshed.sentAt || !refreshed.messageId || !["SENT", "UPDATED"].includes(refreshed.status)) {
      return {
        outcome: "SKIPPED",
        telegramCleared,
        legacyLocalOnly: legacyLocalOnly ? 1 : 0,
        tombstone: 0,
        deleted: 0,
      } as const;
    }

    const deleted = await tx.listing.deleteMany({
      where: {
        id: candidate.id,
        telegramNotifications: {
          some: {
            id: refreshed.id,
            cleanupAttemptedAt: now,
            ...notificationCleanupEligibility(now, regular),
          },
        },
      },
    });
    if (deleted.count !== 1) {
      return {
        outcome: "SKIPPED",
        telegramCleared,
        legacyLocalOnly: legacyLocalOnly ? 1 : 0,
        tombstone: 0,
        deleted: 0,
      } as const;
    }
    await tx.sourceSeenListing.upsert({
      where: { source_externalId: { source: candidate.source, externalId: candidate.externalId } },
      create: {
        source: candidate.source,
        externalId: candidate.externalId,
        url: candidate.url,
        canonicalUrl: candidate.canonicalUrl,
        listingId: null,
        normalizedData: Prisma.DbNull,
        decision: "NOTIFIED",
        lastEvaluatedAt: now,
        notifiedAt: refreshed.sentAt,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.firstSeenAt,
        discoveryLane: candidate.discoveryLane,
      },
      update: {
        listingId: null,
        normalizedData: Prisma.DbNull,
        decision: "NOTIFIED",
        lastEvaluatedAt: now,
      },
    });
    return {
      outcome: "DELETED",
      telegramCleared,
      legacyLocalOnly: legacyLocalOnly ? 1 : 0,
      tombstone: 1,
      deleted: deleted.count,
    } as const;
  }, { maxWait: 5_000, timeout: 5_000 });
}

export function notificationCleanupDue(
  notification: {
    favoritedAt: Date | null;
    retainUntil: Date | null;
    retentionPolicyAppliedAt: Date | null;
    deleteAfter: Date | null;
    status: string;
    messageId: string | null;
    sentAt: Date | null;
  },
  now: Date,
  regular: Date,
): boolean {
  if (notification.favoritedAt) return Boolean(notification.retainUntil && notification.retainUntil <= now);
  if (notification.retentionPolicyAppliedAt) return Boolean(notification.deleteAfter && notification.deleteAfter <= now);
  return ["SENT", "UPDATED"].includes(notification.status)
    && Boolean(notification.messageId && notification.sentAt && notification.sentAt <= regular);
}

export function notificationStillDue(
  notification: {
    cleanupAttemptedAt: Date | null;
    favoritedAt: Date | null;
    retainUntil: Date | null;
    retentionPolicyAppliedAt: Date | null;
    deleteAfter: Date | null;
    status: string;
    messageId: string | null;
    sentAt: Date | null;
  },
  now: Date,
  regular: Date,
): boolean {
  if (!notification.cleanupAttemptedAt || notification.cleanupAttemptedAt.getTime() !== now.getTime()) return false;
  return notificationCleanupDue(notification, now, regular);
}
