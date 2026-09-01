import { Bot } from "grammy";
import type { AbortSignal } from "abort-controller";
import { Prisma, prisma } from "@amb/db";
import { telegramListingKeyboard } from "@amb/shared";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { redisConnection } from "../lib/queues.js";
import { TelegramSendGate, telegramRateGateKey } from "./telegram-send-gate.js";
import {
  clampTelegramText,
  enrichedMessageText,
  initialMessageText,
  type TelegramListingSnapshot,
} from "./telegram-listing-format.js";
import { telegramFlashBundleText } from "./telegram-flash-format.js";

export type { TelegramListingSnapshot } from "./telegram-listing-format.js";

let bot: Bot | null = null;
let integrationTestApiRoot: string | null = null;
export const TELEGRAM_SEND_LEASE_MS = 60_000;
const listingSendGate = new TelegramSendGate(env.TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS, {
  redis: redisConnection,
  key: telegramRateGateKey(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID),
});
const TELEGRAM_GATE_PRIORITY = {
  FLASH: -10,
  REALTIME: 0,
  MANUAL: 1,
  SYSTEM: 2,
  BACKFILL: 10,
  UPDATE: 20,
  RETENTION: 30,
} as const;

export const TELEGRAM_FLASH_SEND_LEASE_MS = 60_000;

function getBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  if (!bot) {
    bot = new Bot(
      env.TELEGRAM_BOT_TOKEN,
      integrationTestApiRoot ? { client: { apiRoot: integrationTestApiRoot } } : undefined,
    );
  }
  return bot;
}

/**
 * Routes Telegram traffic to the loopback fake used by the isolated pipeline
 * acceptance stand. This cannot be enabled by normal runtime configuration.
 */
export function configureTelegramApiRootForIntegrationTest(value: string): void {
  if (process.env.AMB_PIPELINE_INTEGRATION_TEST !== "1") {
    throw new Error("Telegram API override is available only in the pipeline integration stand");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Pipeline Telegram API override must use a loopback HTTP address");
  }
  integrationTestApiRoot = url.toString().replace(/\/$/u, "");
  bot = null;
}

export function isTelegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

export async function sendSystemAlert(text: string): Promise<void> {
  const telegramBot = getBot();
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!telegramBot || !chatId) return;

  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.SYSTEM);
    await telegramBot.api.sendMessage(chatId, clampTelegramText([text]), {
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await deferGlobalTelegramGate(error);
    await log.warn("telegram", "Не удалось отправить системное уведомление", error instanceof Error ? error.message : String(error));
  }
}

export type TelegramListingKeyboardResult =
  | { outcome: "UPDATED" }
  | { outcome: "PERMANENT_FAILURE"; errorMessage: string }
  | { outcome: "RETRY"; errorCode: string; errorMessage: string };

export async function applyListingRetentionKeyboard(input: {
  chatId: string;
  messageId: string;
  listingId: string;
  url: string;
  retainUntil?: Date | null;
}): Promise<TelegramListingKeyboardResult> {
  const telegramBot = getBot();
  if (!telegramBot) {
    return {
      outcome: "RETRY",
      errorCode: "TELEGRAM_NOT_CONFIGURED",
      errorMessage: "TELEGRAM_BOT_TOKEN is not configured",
    };
  }
  const messageId = Number(input.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return { outcome: "PERMANENT_FAILURE", errorMessage: "Invalid Telegram message ID" };
  }
  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
    await telegramBot.api.editMessageReplyMarkup(input.chatId, messageId, {
      reply_markup: telegramListingKeyboard(
        input.url,
        input.listingId,
        input.retainUntil ?? null,
        env.LISTING_FAVORITE_RETENTION_DAYS,
      ),
    });
    return { outcome: "UPDATED" };
  } catch (error) {
    await deferGlobalTelegramGate(error);
    const message = error instanceof Error ? error.message : String(error);
    if (/message is not modified/iu.test(message) || isTelegramMessageGoneError(message)) {
      return { outcome: "UPDATED" };
    }
    if (isPermanentTelegramChatError(message) || isPermanentTelegramEditError(message)) {
      return { outcome: "PERMANENT_FAILURE", errorMessage: message };
    }
    return {
      outcome: "RETRY",
      errorCode: telegramRetryAfterSeconds(error) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_MARKUP_FAILED",
      errorMessage: message,
    };
  }
}

/**
 * Sends the first Telegram message with a compact lead card.
 * A short DB lease prevents duplicate sends when several workers touch the
 * same listing at the same time.
 */
export async function sendListingLink(
  listingId: string,
  snapshot?: TelegramListingSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const listing = snapshot ?? (await loadListingForTelegram(listingId));
  if (!listing) throw new Error(`Listing not found: ${listingId}`);

  const text = initialMessageText(listing);
  const reservation = await reserveTelegramNotification(listingId, env.TELEGRAM_CHAT_ID || "not-configured", text);

  if (reservation.kind === "already-sent") {
    return;
  }
  if (reservation.kind === "locked") return;

  const telegramBot = getBot();
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!telegramBot || !chatId) {
    await prisma.telegramNotification.update({
      where: { id: reservation.notificationId },
      data: {
        chatId: chatId || "not-configured",
        status: "FAILED",
        lastText: text,
        leaseExpiresAt: null,
        lastErrorCode: "TELEGRAM_NOT_CONFIGURED",
        lastErrorMessage: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
      },
    });
    await log.warn("telegram", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, message not sent", listing.url);
    return;
  }

  try {
    await listingSendGate.waitForSlot(
      listingTelegramPriority(listing.discoveryLane),
      listingTelegramFreshnessRank(listing),
    );
    const sent = await telegramBot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: telegramListingKeyboard(
        listing.url,
        listing.id,
        null,
        env.LISTING_FAVORITE_RETENTION_DAYS,
      ),
    }, options.signal);

    // A resolved sendMessage call is Telegram Bot API acceptance. Keep this
    // separate from queue reservation and later local persistence.
    const acceptedAt = new Date();
    const sentAt = acceptedAt;
    const firstAcceptedAt = reservation.acceptedAt ?? acceptedAt;

    await prisma.telegramNotification.update({
      where: { id: reservation.notificationId },
      data: {
        chatId,
        messageId: String(sent.message_id),
        status: "SENT",
        lastText: text,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        sentAt,
        acceptedAt: firstAcceptedAt,
        deleteAfter: new Date(sentAt.getTime() + env.LISTING_RETENTION_HOURS * 60 * 60 * 1000),
        favoritedAt: null,
        retainUntil: null,
        retentionPolicyAppliedAt: sentAt,
        cleanupAttemptedAt: null,
      },
    });

    await prisma.$transaction([
      prisma.listing.update({ where: { id: listingId }, data: { status: "SENT" } }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId },
        data: { decision: "NOTIFIED" },
      }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId, notifiedAt: null },
        data: { notifiedAt: acceptedAt },
      }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId, telegramAcceptedAt: null },
        data: { telegramAcceptedAt: acceptedAt },
      }),
    ]);
  } catch (err) {
    await deferGlobalTelegramGate(err);
    const message = err instanceof Error ? err.message : String(err);
    const retryAfterSeconds = telegramRetryAfterSeconds(err);
    const aborted = options.signal?.aborted === true;
    await prisma.telegramNotification.update({
      where: { id: reservation.notificationId },
      data: {
        status: "RETRY_PENDING",
        leaseExpiresAt: null,
        lastErrorCode: aborted
          ? "TELEGRAM_INLINE_DEADLINE"
          : retryAfterSeconds
            ? "TELEGRAM_RATE_LIMITED"
            : "TELEGRAM_SEND_FAILED",
        lastErrorMessage: message,
      },
    });
    await log.error("telegram", aborted ? "sendMessage deadline exceeded" : "sendMessage failed", message);
    if (retryAfterSeconds) throw new TelegramRateLimitError(message, retryAfterSeconds);
    throw err;
  }
}

export async function stageListingForFlash(
  listingId: string,
  flashBundleId: string,
  snapshot?: TelegramListingSnapshot,
): Promise<boolean> {
  const listing = snapshot ?? (await loadListingForTelegram(listingId));
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  const chatId = env.TELEGRAM_CHAT_ID || "not-configured";
  const text = initialMessageText(listing);
  const now = new Date();
  const existing = await prisma.telegramNotification.findUnique({ where: { listingId } });
  if ((existing?.status === "SENT" || existing?.status === "UPDATED") && existing.messageId) return false;
  if (existing?.status === "PROCESSING" && existing.leaseExpiresAt && existing.leaseExpiresAt > now) return false;

  try {
    if (existing) {
      const updated = await prisma.telegramNotification.updateMany({
        where: {
          id: existing.id,
          OR: [
            { status: { not: "PROCESSING" } },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          chatId,
          status: "FLASH_PENDING",
          flashBundleId,
          lastText: text,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      return updated.count === 1;
    }
    await prisma.telegramNotification.create({
      data: {
        listingId,
        chatId,
        status: "FLASH_PENDING",
        flashBundleId,
        lastText: text,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

export async function createTelegramFlashBundle(
  flashBundleId: string,
  listingIds: readonly string[],
): Promise<boolean> {
  const uniqueIds = [...new Set(listingIds)];
  if (uniqueIds.length < 2) return false;
  const rows = await prisma.listing.findMany({
    where: { id: { in: uniqueIds } },
    include: { matches: { include: { filter: { select: { name: true } } } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = uniqueIds.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (ordered.length < 2) return false;
  const text = telegramFlashBundleText(ordered);
  await prisma.telegramFlashBundle.upsert({
    where: { id: flashBundleId },
    create: {
      id: flashBundleId,
      chatId: env.TELEGRAM_CHAT_ID || "not-configured",
      listingIds: ordered.map((row) => row.id),
      lastText: text,
    },
    update: {},
  });
  return true;
}

export async function releaseFlashListingsToCards(
  flashBundleId: string,
  listingIds?: readonly string[],
): Promise<string[]> {
  const rows = listingIds
    ? [...new Set(listingIds)]
    : (await prisma.telegramNotification.findMany({
        where: { flashBundleId, status: "FLASH_PENDING" },
        select: { listingId: true },
      })).map((row) => row.listingId);
  if (rows.length === 0) return [];
  await prisma.telegramNotification.updateMany({
    where: { flashBundleId, listingId: { in: rows }, status: "FLASH_PENDING" },
    data: { status: "PENDING" },
  });
  return rows;
}

export async function sendTelegramFlashBundle(flashBundleId: string): Promise<string[]> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + TELEGRAM_FLASH_SEND_LEASE_MS);
  const existing = await prisma.telegramFlashBundle.findUnique({ where: { id: flashBundleId } });
  if (!existing) throw new Error(`Telegram flash bundle not found: ${flashBundleId}`);
  if (existing.status === "SENT" && existing.messageId) return existing.listingIds;
  if (existing.status === "PROCESSING" && existing.leaseExpiresAt && existing.leaseExpiresAt > now) return [];

  const reserved = await prisma.telegramFlashBundle.updateMany({
    where: {
      id: flashBundleId,
      OR: [
        { status: { not: "PROCESSING" } },
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      processingStartedAt: now,
      lastAttemptAt: now,
      leaseExpiresAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  if (reserved.count !== 1) return [];

  const telegramBot = getBot();
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!telegramBot || !chatId) {
    await prisma.telegramFlashBundle.update({
      where: { id: flashBundleId },
      data: {
        status: "FAILED",
        leaseExpiresAt: null,
        lastErrorCode: "TELEGRAM_NOT_CONFIGURED",
        lastErrorMessage: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
      },
    });
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured");
  }

  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.FLASH, Number.NEGATIVE_INFINITY);
    const sent = await telegramBot.api.sendMessage(chatId, existing.lastText, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    const acceptedAt = new Date();
    const sentAt = acceptedAt;
    await prisma.$transaction([
      prisma.telegramFlashBundle.update({
        where: { id: flashBundleId },
        data: {
          chatId,
          messageId: String(sent.message_id),
          status: "SENT",
          sentAt,
          acceptedAt,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
      prisma.telegramNotification.updateMany({
        where: { flashBundleId, status: "FLASH_PENDING" },
        data: { status: "PENDING", acceptedAt },
      }),
      prisma.listing.updateMany({
        where: { id: { in: existing.listingIds } },
        data: { status: "SENT" },
      }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId: { in: existing.listingIds } },
        data: { decision: "NOTIFIED" },
      }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId: { in: existing.listingIds }, notifiedAt: null },
        data: { notifiedAt: acceptedAt },
      }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId: { in: existing.listingIds }, telegramAcceptedAt: null },
        data: { telegramAcceptedAt: acceptedAt },
      }),
    ]);
    return existing.listingIds;
  } catch (error) {
    await deferGlobalTelegramGate(error);
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterSeconds = telegramRetryAfterSeconds(error);
    await prisma.telegramFlashBundle.update({
      where: { id: flashBundleId },
      data: {
        status: "RETRY_PENDING",
        leaseExpiresAt: null,
        lastErrorCode: retryAfterSeconds ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_FLASH_SEND_FAILED",
        lastErrorMessage: message,
      },
    });
    if (retryAfterSeconds) throw new TelegramRateLimitError(message, retryAfterSeconds);
    throw error;
  }
}

/**
 * Edits the same already-sent message via editMessageText.
 * Never sends a second message.
 */
export async function updateListingMessage(listingId: string): Promise<void> {
  const notification = await prisma.telegramNotification.findUnique({ where: { listingId } });
  if (notification && env.TELEGRAM_CHAT_ID && notification.chatId !== env.TELEGRAM_CHAT_ID) {
    await prisma.telegramNotification.update({
      where: { id: notification.id },
      data: {
        lastErrorCode: "LEGACY_TELEGRAM_CHAT",
        lastErrorMessage: "Сообщение принадлежит прежнему Telegram-аккаунту и не может быть отредактировано в новом чате",
      },
    });
    return;
  }
  const [listing, check, market] = await Promise.all([
    loadListingForTelegram(listingId),
    prisma.vehicleCheck.findFirst({ where: { listingId }, orderBy: { createdAt: "desc" } }),
    prisma.marketPriceEstimate.findUnique({ where: { listingId } }),
  ]);

  if (!listing || (!check && !market)) return;

  const text = enrichedMessageText(listing, check, market);

  const telegramBot = getBot();
  if (!telegramBot || !notification?.messageId) {
    if (notification) {
      await prisma.telegramNotification.update({
        where: { id: notification.id },
        data: { lastText: text },
      });
    }
    return;
  }

  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.UPDATE);
    await telegramBot.api.editMessageText(notification.chatId, Number(notification.messageId), text, {
      link_preview_options: { is_disabled: true },
      reply_markup: telegramListingKeyboard(
        listing.url,
        listing.id,
        notification.retainUntil,
        env.LISTING_FAVORITE_RETENTION_DAYS,
      ),
    });
    await prisma.telegramNotification.update({
      where: { id: notification.id },
      data: {
        status: "UPDATED",
        lastText: text,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    // A favorite callback can race with enrichment. Reconcile only the markup
    // after editing the text so a stale worker snapshot never removes a heart.
    const currentRetention = await prisma.telegramNotification.findUnique({
      where: { id: notification.id },
      select: { retainUntil: true },
    });
    if (currentRetention?.retainUntil?.getTime() !== notification.retainUntil?.getTime()) {
      await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.UPDATE);
      await telegramBot.api.editMessageReplyMarkup(notification.chatId, Number(notification.messageId), {
        reply_markup: telegramListingKeyboard(
          listing.url,
          listing.id,
          currentRetention?.retainUntil ?? null,
          env.LISTING_FAVORITE_RETENTION_DAYS,
        ),
      });
    }
  } catch (err) {
    await deferGlobalTelegramGate(err);
    const message = err instanceof Error ? err.message : String(err);
    // "message is not modified" is safe to ignore.
    if (!message.includes("message is not modified")) {
      await prisma.telegramNotification.update({
        where: { id: notification.id },
        data: {
          lastErrorCode: "TELEGRAM_UPDATE_FAILED",
          lastErrorMessage: message,
        },
      });
      await log.error("telegram", "editMessageText failed", message);
      if (isPermanentTelegramChatError(message)) return;
      const retryAfterSeconds = telegramRetryAfterSeconds(err);
      if (retryAfterSeconds) throw new TelegramRateLimitError(message, retryAfterSeconds);
      throw err;
    }
  }
}

export type TelegramListingCleanupResult =
  | { outcome: "CLEARED"; detail?: string }
  | { outcome: "RETRY"; errorCode: string; errorMessage: string };

export async function cleanupListingTelegramMessage(input: {
  chatId: string;
  messageId: string | null;
  favoriteExpired: boolean;
}): Promise<TelegramListingCleanupResult> {
  if (!input.messageId) return { outcome: "CLEARED", detail: "No Telegram message ID" };

  const messageId = Number(input.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return { outcome: "CLEARED", detail: "Invalid Telegram message ID" };
  }

  const telegramBot = getBot();
  if (!telegramBot) {
    return {
      outcome: "RETRY",
      errorCode: "TELEGRAM_NOT_CONFIGURED",
      errorMessage: "TELEGRAM_BOT_TOKEN is not configured",
    };
  }

  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
    await telegramBot.api.deleteMessage(input.chatId, messageId);
    return { outcome: "CLEARED" };
  } catch (error) {
    await deferGlobalTelegramGate(error);
    const message = error instanceof Error ? error.message : String(error);
    if (isTelegramMessageGoneError(message) || isPermanentTelegramChatError(message)) {
      return { outcome: "CLEARED", detail: message };
    }
    if (!isTelegramDeleteTooOldError(message)) {
      return {
        outcome: "RETRY",
        errorCode: telegramRetryAfterSeconds(error) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_DELETE_FAILED",
        errorMessage: message,
      };
    }
  }

  // Bot API cannot physically delete normal messages after 48 hours. Bot-owned
  // messages can still be edited, so remove the listing content and buttons.
  const tombstoneText = input.favoriteExpired
    ? `🗑 Сохранённое объявление удалено из проекта после ${env.LISTING_FAVORITE_RETENTION_DAYS} дней.`
    : "🗑 Объявление удалено из проекта по истечении срока хранения.";
  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
    await telegramBot.api.editMessageText(input.chatId, messageId, tombstoneText, {
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
    return { outcome: "CLEARED", detail: "Telegram message content cleared" };
  } catch (error) {
    await deferGlobalTelegramGate(error);
    const message = error instanceof Error ? error.message : String(error);
    if (
      /message is not modified/iu.test(message) ||
      isTelegramMessageGoneError(message) ||
      isPermanentTelegramChatError(message) ||
      isPermanentTelegramEditError(message)
    ) {
      return { outcome: "CLEARED", detail: message };
    }
    return {
      outcome: "RETRY",
      errorCode: telegramRetryAfterSeconds(error) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_CLEAR_FAILED",
      errorMessage: message,
    };
  }
}

export function isTelegramDeleteTooOldError(message: string): boolean {
  return /(?:message (?:can'?t|cannot|can not) be deleted|message is too old|delete messages? only.*48)/iu.test(message);
}

export function isTelegramMessageGoneError(message: string): boolean {
  return /(?:message to delete not found|message not found|message identifier is not specified)/iu.test(message);
}

function isPermanentTelegramEditError(message: string): boolean {
  return /(?:message (?:can'?t|cannot|can not) be edited|message is not editable)/iu.test(message);
}

function isPermanentTelegramChatError(message: string): boolean {
  return /(?:user is deactivated|bot was blocked by the user|chat not found|user not found)/iu.test(message);
}

function listingTelegramPriority(
  lane: TelegramListingSnapshot["discoveryLane"],
): number {
  if (lane === "REALTIME") return TELEGRAM_GATE_PRIORITY.REALTIME;
  if (lane === "MANUAL") return TELEGRAM_GATE_PRIORITY.MANUAL;
  return TELEGRAM_GATE_PRIORITY.BACKFILL;
}

export function listingTelegramFreshnessRank(
  listing: Pick<TelegramListingSnapshot, "publishedAt" | "firstSeenAt">,
): number {
  const timestamp = listing.publishedAt?.getTime() ?? listing.firstSeenAt.getTime();
  return Number.isFinite(timestamp) ? -timestamp : 0;
}

async function reserveTelegramNotification(
  listingId: string,
  chatId: string,
  text: string,
): Promise<
  | { kind: "reserved"; notificationId: string; acceptedAt: Date | null }
  | { kind: "already-sent" }
  | { kind: "locked" }
> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + TELEGRAM_SEND_LEASE_MS);
  const existing = await prisma.telegramNotification.findUnique({ where: { listingId } });

  if ((existing?.status === "SENT" || existing?.status === "UPDATED") && existing.messageId) {
    return { kind: "already-sent" };
  }
  if (existing?.status === "PROCESSING" && existing.leaseExpiresAt && existing.leaseExpiresAt > now) {
    return { kind: "locked" };
  }

  try {
    if (existing) {
      const reserved = await prisma.telegramNotification.updateMany({
        where: {
          id: existing.id,
          OR: [
            { status: { not: "PROCESSING" } },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          chatId,
          status: "PROCESSING",
          lastText: text,
          attemptCount: { increment: 1 },
          processingStartedAt: now,
          lastAttemptAt: now,
          leaseExpiresAt,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (reserved.count !== 1) return { kind: "locked" };
      return { kind: "reserved", notificationId: existing.id, acceptedAt: existing.acceptedAt };
    }

    const created = await prisma.telegramNotification.create({
      data: {
        listingId,
        chatId,
        status: "PROCESSING",
        lastText: text,
        attemptCount: 1,
        processingStartedAt: now,
        lastAttemptAt: now,
        leaseExpiresAt,
      },
    });
    return { kind: "reserved", notificationId: created.id, acceptedAt: created.acceptedAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { kind: "locked" };
    throw err;
  }
}

async function loadListingForTelegram(listingId: string): Promise<TelegramListingSnapshot | null> {
  return prisma.listing.findUnique({
    where: { id: listingId },
    include: { matches: { include: { filter: { select: { name: true } } } } },
  });
}

export class TelegramRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "TelegramRateLimitError";
  }
}

function telegramRetryAfterSeconds(error: unknown): number | undefined {
  const candidate = error as {
    parameters?: { retry_after?: number };
    error?: { parameters?: { retry_after?: number } };
    response?: { parameters?: { retry_after?: number } };
  };
  const value = candidate?.parameters?.retry_after
    ?? candidate?.error?.parameters?.retry_after
    ?? candidate?.response?.parameters?.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

async function deferGlobalTelegramGate(error: unknown): Promise<void> {
  const retryAfterSeconds = telegramRetryAfterSeconds(error);
  if (!retryAfterSeconds) return;
  await listingSendGate.deferFor(retryAfterSeconds * 1_000).catch(() => undefined);
}
