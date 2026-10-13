import { prisma } from "@amb/db";
import { QUEUE_NAMES, TELEGRAM_SEND_PRIORITY } from "@amb/shared";
import { enqueue } from "../lib/queues.js";

/** /start proves this chat is reachable again. Preserve accepted messages. */
export async function activateTelegramSubscriber(chatId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async tx => {
    await tx.telegramSubscriber.upsert({
      where: { chatId }, create: { chatId, active: true, startedAt: now, lastSeenAt: now },
      update: { active: true, blockedAt: null, lastSeenAt: now },
    });
    await tx.telegramFlashBundle.updateMany({
      where: { chatId, status: "PERMANENT", acceptedAt: null, messageId: null,
        lastErrorCode: "TELEGRAM_FLASH_PERMANENT" },
      data: { status: "PENDING", nextAttemptAt: null, leaseExpiresAt: null,
        processingStartedAt: null, lastErrorCode: null, lastErrorMessage: null },
    });
    await tx.telegramNotification.updateMany({
      where: { chatId, status: "PERMANENT", messageId: null,
        lastErrorCode: { in: ["TELEGRAM_PERMANENT", "TELEGRAM_FLASH_PERMANENT"] },
        listing: { notificationMode: "LIVE", status: { notIn: ["IGNORED", "DUPLICATE"] } } },
      data: { status: "PENDING", nextAttemptAt: null, leaseExpiresAt: null,
        processingStartedAt: null, lastErrorCode: null, lastErrorMessage: null },
    });
  });
  // Include already-pending work so a repeated update repairs a failed Redis handoff.
  const [flashes, cards] = await Promise.all([
    prisma.telegramFlashBundle.findMany({ where: { chatId, status: "PENDING", messageId: null,
      acceptedAt: null, nextAttemptAt: null }, select: { id: true } }),
    prisma.telegramNotification.findMany({ where: { chatId, status: "PENDING", messageId: null,
      nextAttemptAt: null, OR: [{ flashBundleId: null }, { acceptedAt: { not: null } }],
      listing: { notificationMode: "LIVE", status: { notIn: ["IGNORED", "DUPLICATE"] } } },
      select: { listingId: true, acceptedAt: true } }),
  ]);
  // Durable reservations protect against duplicate jobs; do not reuse completed job IDs.
  await Promise.all([
    ...flashes.map(row => enqueue(QUEUE_NAMES.TELEGRAM_FLASH, "subscriber-resume", { flashBundleId: row.id },
      { priority: TELEGRAM_SEND_PRIORITY })),
    ...cards.map(row => enqueue(QUEUE_NAMES.TELEGRAM_SEND, "subscriber-resume",
      { listingId: row.listingId, ...(row.acceptedAt ? { chatId } : {}) },
      { priority: row.acceptedAt ? 12 : TELEGRAM_SEND_PRIORITY })),
  ]);
}
