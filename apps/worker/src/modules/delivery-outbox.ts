import { prisma } from "@amb/db";

/** Repair legacy orphans without reviving shadow, ignored or retained receipts. */
export async function reconcileOrphanDeliveryIntents(chatId: string, limit: number): Promise<number> {
  const take = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  return prisma.$transaction(async (tx) => {
    // These bounds affect this maintenance transaction only, never HTTP or
    // production sessions globally. A failure leaves the orphan eligible.
    await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO telegram_notifications
        (id, "listingId", "chatId", status, "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, listing.id, ${chatId || "not-configured"},
             'PENDING'::"TelegramNotificationStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM listings listing
      WHERE listing."notificationMode" = 'LIVE' AND listing.status = 'MATCHED'
        AND NOT EXISTS (SELECT 1 FROM telegram_notifications notification
                        WHERE notification."listingId" = listing.id)
        AND NOT EXISTS (SELECT 1 FROM source_seen_listings seen
                        WHERE seen."listingId" = listing.id AND
                          (seen.decision = 'NOTIFIED' OR seen."notifiedAt" IS NOT NULL
                           OR seen."telegramAcceptedAt" IS NOT NULL))
      ORDER BY listing."firstSeenAt" ASC, listing.id ASC
      LIMIT ${take}
      ON CONFLICT ("listingId") DO NOTHING
      RETURNING id
    `;
    return inserted.length;
  }, { maxWait: 3_000, timeout: 5_000 });
}

/** The same age-independent selector is used at worker startup and acceptance. */
export async function selectPendingCardDeliveryIntents(
  limit: number,
  now = new Date(),
): Promise<Array<{ listingId: string }>> {
  return prisma.telegramNotification.findMany({
    where: {
      status: { in: ["PENDING", "TRANSIENT", "AMBIGUOUS", "RETRY_PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      listing: { notificationMode: "LIVE", status: { notIn: ["IGNORED", "DUPLICATE"] } },
    },
    select: { listingId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}
