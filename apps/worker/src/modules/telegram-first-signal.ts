import { createHash } from "node:crypto";
import { prisma } from "@amb/db";
import { BACKFILL_TELEGRAM_PRIORITY, isBackgroundDiscoveryLane, QUEUE_NAMES, TELEGRAM_SEND_PRIORITY } from "@amb/shared";
import { env } from "../env.js";
import { enqueue } from "../lib/queues.js";
import { telegramFlashBundleText } from "./telegram-flash-format.js";
import type { TelegramListingSnapshot } from "./telegram-listing-format.js";

export const TELEGRAM_DETAIL_PRIORITY = 12;

/** Split by the rendered message budget as well as count; never discard a tail. */
export function splitFirstSignalListings<T extends TelegramListingSnapshot>(rows: readonly T[], maxItems = 20): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  for (const row of rows) {
    let fits = group.length < Math.max(1, maxItems);
    if (fits) {
      try { telegramFlashBundleText([...group, row]); } catch { fits = false; }
    }
    if (!fits && group.length) { groups.push(group); group = []; }
    // Validate a single oversized item too: keep its receipt retryable instead of truncating its link.
    telegramFlashBundleText([row]);
    group.push(row);
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Commit every recipient before queue handoff. Ordered advisory locks serialize overlapping admissions. */
export async function queueTelegramFirstSignals(listingIds: readonly string[], batchId: string): Promise<boolean> {
  const ids = [...new Set(listingIds)].sort();
  if (!ids.length) return false;
  const subscribers = await prisma.telegramSubscriber.findMany({ where: { active: true }, select: { chatId: true } });
  const chats = [...new Set([...(env.TELEGRAM_CHAT_ID ? [env.TELEGRAM_CHAT_ID] : []), ...subscribers.map(r => r.chatId)])];
  if (!chats.length) throw new Error("No Telegram recipients configured");
  const work = await prisma.$transaction(async tx => {
    // Do not hold listing row locks: acceptance updates receipts then listing projections.
    // A separate admission lock avoids reversing that lock order during a concurrent retry.
    for (const id of ids) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('telegram-first-signal'), hashtext(${id}))`;
    const listings = await tx.listing.findMany({ where: { id: { in: ids }, notificationMode: "LIVE", status: { notIn: ["IGNORED", "DUPLICATE"] } } });
    const byId = new Map(listings.map(row => [row.id, row]));
    const ordered = [...new Set(listingIds)].map(id => byId.get(id)).filter((row): row is NonNullable<typeof row> => !!row);
    const bundles = new Set<string>();
    const details: Array<{ listingId: string; chatId: string }> = [];
    for (const chatId of chats) {
      await tx.telegramNotification.createMany({ data: ordered.map(row => ({ listingId: row.id, chatId, status: "PENDING" as const })), skipDuplicates: true });
      const receipts = await tx.telegramNotification.findMany({ where: { listingId: { in: ids }, chatId } });
      const fresh: typeof ordered = [];
      for (const row of ordered) {
        const receipt = receipts.find(r => r.listingId === row.id)!;
        if (receipt.messageId || ["PERMANENT", "QUARANTINED", "DELIVERED", "SENT", "UPDATED"].includes(receipt.status)) continue;
        if (receipt.acceptedAt) { details.push({ listingId: row.id, chatId }); continue; }
        if (["SENDING", "PROCESSING"].includes(receipt.status)) continue;
        if (receipt.nextAttemptAt && receipt.nextAttemptAt > new Date()) continue;
        if (receipt.flashBundleId) {
          const existing = await tx.telegramFlashBundle.findUnique({ where: { id: receipt.flashBundleId } });
          if (existing) {
            if (!["PERMANENT", "QUARANTINED"].includes(existing.status)) bundles.add(existing.id);
            continue;
          }
        }
        fresh.push(row);
      }
      for (const [index, group] of splitFirstSignalListings(fresh, env.TELEGRAM_FLASH_BUNDLE_MAX_ITEMS).entries()) {
        const id = `${batchId}-${createHash("sha256").update(JSON.stringify([chatId, group.map(row => row.id)])).digest("hex").slice(0, 24)}-${index}`;
        await tx.telegramFlashBundle.upsert({ where: { id }, create: { id, chatId, listingIds: group.map(row => row.id), lastText: telegramFlashBundleText(group) }, update: {} });
        await tx.telegramNotification.updateMany({ where: { listingId: { in: group.map(row => row.id) }, chatId, messageId: null, acceptedAt: null }, data: { status: "FLASH_PENDING", flashBundleId: id } });
        bundles.add(id);
      }
    }
    return { bundles: [...bundles], details, eligible: ordered.length > 0,
      priority: ordered.every(row => isBackgroundDiscoveryLane(row.discoveryLane)) ? BACKFILL_TELEGRAM_PRIORITY : TELEGRAM_SEND_PRIORITY };
  }, { maxWait: 5_000, timeout: 15_000 });
  // All recipients are durable even when one enqueue fails. Recovery uses the same per-recipient records.
  const queued = await Promise.allSettled([
    ...work.bundles.map(flashBundleId => enqueue(QUEUE_NAMES.TELEGRAM_FLASH, "flash", { flashBundleId }, { priority: work.priority, deduplicationId: `flash-${flashBundleId}` })),
    ...work.details.map(data => enqueue(QUEUE_NAMES.TELEGRAM_SEND, "details", data, { priority: TELEGRAM_DETAIL_PRIORITY, deduplicationId: `details-${data.listingId}-${data.chatId}` })),
  ]);
  const failed = queued.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return work.eligible;
}
