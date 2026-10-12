import { Bot } from "grammy";
import type { AbortSignal } from "abort-controller";
import { Prisma, prisma, type TelegramNotificationStatus } from "@amb/db";
import { telegramListingKeyboard } from "@amb/shared";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { redisConnection } from "../lib/queues.js";
import { TelegramSendGate, telegramRateGateKey } from "./telegram-send-gate.js";
import { withRenewableTelegramLease } from "./telegram-send-lease.js";
import {
  clampTelegramCaption,
  clampTelegramText,
  describeTelegramSend,
  enrichedMessageText,
  initialMessageText,
  isTelegramAlbumMessage,
  primaryTelegramMessageId,
  splitTelegramMessageIds,
  type TelegramListingSnapshot,
} from "./telegram-listing-format.js";
import { telegramFlashBundleText } from "./telegram-flash-format.js";
import { ensureListingSellerPhone } from "./seller-phone.js";

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
/** Gate waits above this are worth a warning (burst pressure signal). */
export const TELEGRAM_GATE_SLOW_WAIT_MS = 3_000;
const TELEGRAM_DELIVERY_BACKOFF_BASE_MS = 5_000;
const TELEGRAM_DELIVERY_BACKOFF_CAP_MS = 30 * 60 * 1_000;

/**
 * Attempt ceiling for definitively-undelivered cards. Past ~11h of capped
 * 30-minute retries the cause is structural (dead chat, hopeless payload),
 * not transient — parking beats burning API calls forever. AMBIGUOUS is
 * deliberately excluded: an uncertain delivery must keep retrying, because a
 * duplicate card is always better than a missed listing.
 */
export const TELEGRAM_MAX_DELIVERY_ATTEMPTS = 30;

const QUARANTINABLE_STATUSES = new Set(["TRANSIENT", "FAILED", "RETRY_PENDING"]);

export function shouldQuarantineDelivery(status: string, attemptCount: number): boolean {
  return attemptCount >= TELEGRAM_MAX_DELIVERY_ATTEMPTS && QUARANTINABLE_STATUSES.has(status);
}

export type TelegramDeliveryFailureState = "TRANSIENT" | "AMBIGUOUS" | "PERMANENT";

export function telegramDeliveryRetryDelayMs(
  attemptCount: number,
  retryAfterSeconds?: number,
  random = Math.random,
): number {
  const exponent = Math.min(10, Math.max(0, Math.trunc(attemptCount) - 1));
  const exponential = Math.min(
    TELEGRAM_DELIVERY_BACKOFF_CAP_MS,
    TELEGRAM_DELIVERY_BACKOFF_BASE_MS * 2 ** exponent,
  );
  const jittered = Math.min(
    TELEGRAM_DELIVERY_BACKOFF_CAP_MS,
    Math.round(exponential * (0.8 + Math.max(0, Math.min(1, random())) * 0.4)),
  );
  return Math.max(jittered, Math.max(0, retryAfterSeconds ?? 0) * 1_000);
}

export function classifyTelegramDeliveryFailure(input: {
  message: string;
  requestStarted: boolean;
  acceptancePersisted: boolean;
  retryAfterSeconds?: number;
}): TelegramDeliveryFailureState {
  if (isPermanentTelegramChatError(input.message)) return "PERMANENT";
  if (input.retryAfterSeconds) return "TRANSIENT";
  // Once the HTTP request began, absence of a durably stored Bot API receipt
  // cannot distinguish a rejected request from an accepted response lost on
  // the network or during local persistence. Preserve that uncertainty.
  if (input.requestStarted && !input.acceptancePersisted) return "AMBIGUOUS";
  return "TRANSIENT";
}

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
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/**
 * The configured chat remains the owner's backward-compatible recipient.
 * Every active /start subscriber is then added independently, so one blocked
 * chat cannot suppress delivery or acknowledgement for the others.
 */
async function activeRecipientChatIds(): Promise<string[]> {
  // Isolated legacy test stands deliberately expose only the old delegate set.
  // Runtime uses generated Prisma with telegramSubscriber after the migration.
  const subscriberStore = (prisma as typeof prisma & {
    telegramSubscriber?: typeof prisma.telegramSubscriber;
  }).telegramSubscriber;
  if (!subscriberStore) return env.TELEGRAM_CHAT_ID ? [env.TELEGRAM_CHAT_ID] : [];
  const subscribers = await subscriberStore.findMany({
    where: { active: true },
    select: { chatId: true },
  });
  return [...new Set([
    ...(env.TELEGRAM_CHAT_ID ? [env.TELEGRAM_CHAT_ID] : []),
    ...subscribers.map((subscriber) => subscriber.chatId),
  ])];
}

async function ensureRecipientReceipts(listingId: string): Promise<string[]> {
  const chatIds = await activeRecipientChatIds();
  if (chatIds.length === 0) return [];
  const subscriberStore = (prisma as typeof prisma & {
    telegramSubscriber?: typeof prisma.telegramSubscriber;
  }).telegramSubscriber;
  // The legacy owner receipt is written atomically with the listing. Only
  // extra public subscribers need receipts created here.
  if (!subscriberStore) return chatIds;
  const subscribers = await subscriberStore.findMany({ where: { active: true }, select: { chatId: true } });
  if (subscribers.length === 0) return chatIds;
  await prisma.telegramNotification.createMany({
    data: subscribers.map((subscriber) => ({ listingId, chatId: subscriber.chatId, status: "PENDING" as const })),
    skipDuplicates: true,
  });
  return chatIds;
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
  messageId: string | null;
  listingId: string;
  url: string;
  retainUntil?: Date | null;
  sellerPhone?: string | null;
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
  // Photo albums store comma-joined ids and expose no keyboard to refresh.
  if (isTelegramAlbumMessage(input.messageId)) return { outcome: "UPDATED" };
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
        input.sellerPhone ?? null,
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
  options: { signal?: AbortSignal; chatId?: string } = {},
): Promise<void> {
  const chatIds = options.chatId ? [options.chatId] : await ensureRecipientReceipts(listingId);
  for (const chatId of chatIds) {
    await sendListingLinkToChat(listingId, snapshot, { ...options, chatId });
  }
}

async function sendListingLinkToChat(
  listingId: string,
  snapshot: TelegramListingSnapshot | undefined,
  options: { signal?: AbortSignal; chatId: string },
): Promise<void> {
  const listing = snapshot ?? (await loadListingForTelegram(listingId));
  if (!listing) throw new Error(`Listing not found: ${listingId}`);

  if (listing.notificationMode === "SHADOW") return;

  const text = initialMessageText(listing);
  const reservation = await reserveTelegramNotification(listingId, options.chatId, text);

  if (reservation.kind === "already-sent") {
    if (reservation.acceptedAt) await syncAcceptedListing(listingId, reservation.acceptedAt);
    return;
  }
  if (reservation.kind === "locked") return;

  const telegramBot = getBot();
  const chatId = options.chatId;

  if (!telegramBot) {
    const nextAttemptAt = new Date(Date.now() + telegramDeliveryRetryDelayMs(reservation.attemptCount));
    await prisma.telegramNotification.update({
      where: { id: reservation.notificationId },
      data: {
        chatId,
        status: "TRANSIENT",
        nextAttemptAt,
        lastText: text,
        leaseExpiresAt: null,
        lastErrorCode: "TELEGRAM_NOT_CONFIGURED",
        lastErrorMessage: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
      },
    });
    await log.warn("telegram", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, message not sent", listing.url);
    return;
  }

  let requestStarted = false;
  let acceptancePersisted = false;
  try {
    await withRenewableTelegramLease(async () => {
      const now = new Date();
      const renewed = await prisma.telegramNotification.updateMany({
        where: {
          id: reservation.notificationId, attemptCount: reservation.attemptCount,
          status: "SENDING", messageId: null, leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt: new Date(now.getTime() + TELEGRAM_SEND_LEASE_MS) },
      });
      return renewed.count === 1;
    }, async (assertOwned) => {
      const gateWaitMs = await listingSendGate.waitForSlot(
        listingTelegramPriority(listing.discoveryLane),
        listingTelegramFreshnessRank(listing),
      );
      // Observability for the single global throttle on the send path: a
      // binding gate shows up here before anyone tunes the interval.
      if (gateWaitMs > TELEGRAM_GATE_SLOW_WAIT_MS) {
        await log.warn(
          "telegram",
          `send gate wait ${gateWaitMs}ms for listing ${listingId}`,
        ).catch(() => undefined);
      }
      await prisma.sourceSeenListing.updateMany({
        where: { listingId, telegramRequestedAt: null },
        data: { telegramRequestedAt: new Date() },
      });
      await assertOwned();
      requestStarted = true;
      const receipt = await sendListingCard(telegramBot, chatId, listing, text, options.signal);

      // A resolved send call is Telegram Bot API acceptance. Keep this
      // separate from queue reservation and later local persistence.
      const acceptedAt = new Date();
      const sentAt = acceptedAt;
      const firstAcceptedAt = reservation.acceptedAt ?? acceptedAt;

      await prisma.telegramNotification.update({
        where: { id: reservation.notificationId },
        data: {
          chatId,
          messageId: receipt.messageIds,
          status: "DELIVERED",
          lastText: text,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          sentAt,
          acceptedAt: firstAcceptedAt,
          nextAttemptAt: null,
          deleteAfter: new Date(sentAt.getTime() + env.LISTING_RETENTION_HOURS * 60 * 60 * 1000),
          favoritedAt: null,
          retainUntil: null,
          retentionPolicyAppliedAt: sentAt,
          cleanupAttemptedAt: null,
        },
      });
      acceptancePersisted = true;

      await syncAcceptedListing(listingId, firstAcceptedAt);
    });
  } catch (err) {
    await deferGlobalTelegramGate(err);
    const message = err instanceof Error ? err.message : String(err);
    const retryAfterSeconds = telegramRetryAfterSeconds(err);
    const aborted = options.signal?.aborted === true;
    const failureState = classifyTelegramDeliveryFailure({
      message,
      requestStarted,
      acceptancePersisted,
      retryAfterSeconds,
    });
    const nextAttemptAt = failureState === "PERMANENT"
      ? null
      : new Date(Date.now() + telegramDeliveryRetryDelayMs(reservation.attemptCount, retryAfterSeconds));
    await prisma.telegramNotification.updateMany({
      // A journal transaction can fail after the acceptance receipt committed.
      // Never erase SENT / messageId or let a losing sender reopen that receipt.
      where: { id: reservation.notificationId, attemptCount: reservation.attemptCount, status: "SENDING", messageId: null },
      data: {
        status: failureState,
        nextAttemptAt,
        leaseExpiresAt: null,
        lastErrorCode: aborted
          ? "TELEGRAM_INLINE_DEADLINE"
          : retryAfterSeconds
            ? "TELEGRAM_RATE_LIMITED"
            : failureState === "AMBIGUOUS"
              ? "TELEGRAM_ACCEPTANCE_AMBIGUOUS"
              : failureState === "PERMANENT"
                ? "TELEGRAM_PERMANENT"
                : "TELEGRAM_SEND_FAILED",
        lastErrorMessage: message,
      },
    });
    if (failureState === "PERMANENT") {
      // Verification failure must stay visible: a swallowed error leaves the
      // chat unsuppressed and the card retrying forever (see attempt ceiling).
      await verifyAndSuppressBlockedChat(chatId, message).catch((verifyError) => {
        void log.warn(
          "telegram",
          "block verification failed, chat not suppressed",
          verifyError instanceof Error ? verifyError.message : String(verifyError),
        ).catch(() => undefined);
      });
    }
    await log.error("telegram", aborted ? "send deadline exceeded" : "card send failed", message);
    if (retryAfterSeconds) throw new TelegramRateLimitError(message, retryAfterSeconds);
    throw err;
  }
}

/**
 * Sends one listing card: a photo album (2-10 photos) with the card as the
 * caption, a single photo with caption and buttons, or plain text with
 * buttons. Bot API albums cannot carry an inline keyboard, so the link and
 * the phone stay tappable plain text in the caption there. Rejected media
 * (dead CDN links) falls back down the chain; anything else rethrows into
 * the regular retry/ambiguity handling so a half-sent card is never doubled.
 */
async function sendListingCard(
  telegramBot: NonNullable<ReturnType<typeof getBot>>,
  chatId: string,
  listing: TelegramListingSnapshot,
  text: string,
  signal?: AbortSignal,
): Promise<{ messageIds: string }> {
  const keyboard = () => telegramListingKeyboard(
    listing.url,
    listing.id,
    null,
    env.LISTING_FAVORITE_RETENTION_DAYS,
    listing.sellerPhone ?? null,
  );
  const { kind, photos } = describeTelegramSend(listing.photoUrls);
  if (kind === "TEXT") {
    const sent = await telegramBot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard(),
    }, signal);
    return { messageIds: String(sent.message_id) };
  }
  const caption = clampTelegramCaption(text);
  const sendSingle = async () => {
    const sent = await telegramBot.api.sendPhoto(chatId, photos[0]!, { caption, reply_markup: keyboard() }, signal);
    return { messageIds: String(sent.message_id) };
  };
  const sendText = async () => {
    const sent = await telegramBot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard(),
    }, signal);
    return { messageIds: String(sent.message_id) };
  };
  if (kind === "PHOTO") {
    try {
      return await sendSingle();
    } catch (error) {
      if (!isTelegramMediaRejected(error) || telegramRetryAfterSeconds(error)) throw error;
      return sendText();
    }
  }
  try {
    const sent = await telegramBot.api.sendMediaGroup(chatId, [
      { type: "photo" as const, media: photos[0]!, caption },
      ...photos.slice(1).map((media) => ({ type: "photo" as const, media })),
    ], undefined, signal);
    return { messageIds: sent.map((message) => String(message.message_id)).join(",") };
  } catch (error) {
    if (!isTelegramMediaRejected(error) || telegramRetryAfterSeconds(error)) throw error;
    try {
      return await sendSingle();
    } catch (nested) {
      if (!isTelegramMediaRejected(nested) || telegramRetryAfterSeconds(nested)) throw nested;
      return sendText();
    }
  }
}

/** Dead CDN links and invalid media payloads are safe to downgrade to text. */
export function isTelegramMediaRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:wrong file|failed to get http url content|wrong type of the web page|can't download|webpage_curl_failed|media[_\s]?(?:empty|invalid)|photo[_\s]?(?:invalid|dimensions)|empty url|file identifier)/iu.test(message);
}

/**
 * Edits a card in place, crossing between caption and text when the stored
 * message turns out to be the other kind (pre-photo legacy text cards).
 * "Not modified" is a successful no-op, anything else propagates.
 */
async function editCardText(
  telegramBot: NonNullable<ReturnType<typeof getBot>>,
  chatId: string,
  messageId: number,
  input: {
    text: string;
    caption: string;
    isCaption: boolean;
    replyMarkup?: ReturnType<typeof telegramListingKeyboard>;
  },
): Promise<void> {
  const markup = input.replyMarkup ? { reply_markup: input.replyMarkup } : {};
  try {
    if (input.isCaption) {
      await telegramBot.api.editMessageCaption(chatId, messageId, { caption: input.caption, ...markup });
    } else {
      await telegramBot.api.editMessageText(chatId, messageId, input.text, {
        link_preview_options: { is_disabled: true },
        ...markup,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/message is not modified/iu.test(message)) return;
    if (input.isCaption && /no caption/iu.test(message)) {
      await telegramBot.api.editMessageText(chatId, messageId, input.text, {
        link_preview_options: { is_disabled: true },
        ...markup,
      });
      return;
    }
    if (!input.isCaption && /no text in the message/iu.test(message)) {
      await telegramBot.api.editMessageCaption(chatId, messageId, { caption: input.caption });
      return;
    }
    throw error;
  }
}

export async function stageListingForFlash(
  listingId: string,
  flashBundleId: string,
  snapshot?: TelegramListingSnapshot,
): Promise<boolean> {
  const listing = snapshot ?? (await loadListingForTelegram(listingId));
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  if (listing.notificationMode === "SHADOW") return false;
  const chatId = env.TELEGRAM_CHAT_ID || "not-configured";
  const text = initialMessageText(listing);
  const now = new Date();
  const existing = await prisma.telegramNotification.findFirst({ where: { listingId, chatId } });
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
    where: { id: { in: uniqueIds }, notificationMode: "LIVE" },
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
  if (existing.messageId && existing.acceptedAt) {
    await syncAcceptedFlashBundle(
      flashBundleId,
      existing.listingIds,
      existing.acceptedAt,
      existing.lastAttemptAt ?? existing.processingStartedAt ?? existing.acceptedAt,
    );
    return existing.listingIds;
  }
  if (["PROCESSING", "SENDING"].includes(existing.status) && existing.leaseExpiresAt && existing.leaseExpiresAt > now) return [];

  if (shouldQuarantineDelivery(existing.status, existing.attemptCount)) {
    const parked = await prisma.telegramFlashBundle.updateMany({
      where: { id: flashBundleId, attemptCount: existing.attemptCount, status: existing.status },
      data: {
        status: "QUARANTINED",
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastErrorCode: "TELEGRAM_FLASH_QUARANTINED",
        lastErrorMessage: `Parked after ${existing.attemptCount} attempts. Re-arm: UPDATE telegram_flash_bundles SET status='RETRY_PENDING', "nextAttemptAt"=NOW() WHERE id='${flashBundleId}'.`,
      },
    });
    if (parked.count === 1) {
      const text = [
        "Карантин доставки: flash-дайджест не доставлен за 30 попыток и поставлен на паузу.",
        `Бандл: ${flashBundleId}, объявлений: ${existing.listingIds.length}, попыток: ${existing.attemptCount}`,
        "Данные целы, ретраи остановлены. Для повторной отправки переведите строку в RETRY_PENDING.",
      ].join("\n");
      try {
        await sendSystemAlert(text);
      } catch (error) {
        await log.warn(
          "telegram",
          "quarantine alert failed",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      }
      await log.error("telegram", "flash bundle quarantined after attempt ceiling", flashBundleId);
    }
    return [];
  }

  // A persisted bundle may predate the shadow guard. Never trust cached text
  // containing suppressed links; release eligible items as individual cards.
  const eligibleRows = await prisma.listing.findMany({
    where: { id: { in: existing.listingIds }, notificationMode: "LIVE" }, select: { id: true },
  });
  const eligibleIds = new Set(eligibleRows.map((row) => row.id));
  if (eligibleIds.size !== existing.listingIds.length) {
    const liveIds = existing.listingIds.filter((id) => eligibleIds.has(id));
    await prisma.telegramFlashBundle.update({ where: { id: flashBundleId }, data: {
      status: "PERMANENT", leaseExpiresAt: null, nextAttemptAt: null,
      lastErrorCode: "SHADOW_SUPPRESSED", lastErrorMessage: "Suppressed entries removed; live items released to individual cards",
    } });
    await releaseFlashListingsToCards(flashBundleId, liveIds);
    return liveIds;
  }

  const reserved = await prisma.telegramFlashBundle.updateMany({
    where: {
      id: flashBundleId,
      attemptCount: existing.attemptCount,
      messageId: null,
      status: { notIn: ["SENT", "DELIVERED", "PERMANENT", "QUARANTINED"] },
      OR: [
        { status: { notIn: ["PROCESSING", "SENDING"] } },
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "SENDING",
      attemptCount: { increment: 1 },
      processingStartedAt: now,
      lastAttemptAt: now,
      leaseExpiresAt,
      nextAttemptAt: null,
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
        status: "TRANSIENT",
        nextAttemptAt: new Date(Date.now() + telegramDeliveryRetryDelayMs(existing.attemptCount + 1)),
        leaseExpiresAt: null,
        lastErrorCode: "TELEGRAM_NOT_CONFIGURED",
        lastErrorMessage: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
      },
    });
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured");
  }

  let requestStarted = false;
  let acceptancePersisted = false;
  try {
    return await withRenewableTelegramLease(async () => {
      const now = new Date();
      const renewed = await prisma.telegramFlashBundle.updateMany({
        where: {
          id: flashBundleId, attemptCount: existing.attemptCount + 1,
          status: "SENDING", messageId: null, leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt: new Date(now.getTime() + TELEGRAM_FLASH_SEND_LEASE_MS) },
      });
      return renewed.count === 1;
    }, async (assertOwned) => {
      const gateWaitMs = await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.FLASH, Number.NEGATIVE_INFINITY);
      if (gateWaitMs > TELEGRAM_GATE_SLOW_WAIT_MS) {
        await log.warn(
          "telegram",
          `send gate wait ${gateWaitMs}ms for flash bundle ${flashBundleId}`,
        ).catch(() => undefined);
      }
      await assertOwned();
      requestStarted = true;
      const telegramRequestedAt = new Date();
      const sent = await telegramBot.api.sendMessage(chatId, existing.lastText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      const acceptedAt = new Date();
      const sentAt = acceptedAt;
      // Commit the Telegram receipt separately before updating local projections.
      // Retrying a projection after a DB fault must never resend the flash.
      await prisma.telegramFlashBundle.update({
        where: { id: flashBundleId },
        data: {
          chatId,
          messageId: String(sent.message_id),
          status: "DELIVERED",
          sentAt,
          acceptedAt,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      acceptancePersisted = true;
      await syncAcceptedFlashBundle(flashBundleId, existing.listingIds, acceptedAt, telegramRequestedAt);
      return existing.listingIds;
    });
  } catch (error) {
    await deferGlobalTelegramGate(error);
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterSeconds = telegramRetryAfterSeconds(error);
    const failureState = classifyTelegramDeliveryFailure({
      message,
      requestStarted,
      acceptancePersisted,
      retryAfterSeconds,
    });
    const nextAttemptAt = failureState === "PERMANENT"
      ? null
      : new Date(Date.now() + telegramDeliveryRetryDelayMs(existing.attemptCount + 1, retryAfterSeconds));
    await prisma.telegramFlashBundle.updateMany({
      where: { id: flashBundleId, attemptCount: existing.attemptCount + 1, status: "SENDING", messageId: null },
      data: {
        status: failureState,
        nextAttemptAt,
        leaseExpiresAt: null,
        lastErrorCode: retryAfterSeconds
          ? "TELEGRAM_RATE_LIMITED"
          : failureState === "AMBIGUOUS"
            ? "TELEGRAM_FLASH_ACCEPTANCE_AMBIGUOUS"
            : failureState === "PERMANENT"
              ? "TELEGRAM_FLASH_PERMANENT"
              : "TELEGRAM_FLASH_SEND_FAILED",
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
  // Enrichment is best-effort; first delivery is already durable per chat.
  // The owner's card remains the canonical card for the legacy flash/update UI.
  const notification = await prisma.telegramNotification.findFirst({
    where: { listingId, chatId: env.TELEGRAM_CHAT_ID || "not-configured" },
  });
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

  if (!listing) return;
  // Background phone resolution is best-effort and cached: listings that went
  // out before this feature (or whose number hides behind "show phone") get
  // the number into the same card edit as market/vehicle enrichment.
  // The load above may have raced the persist, so patch the snapshot in memory.
  let snapshot: TelegramListingSnapshot = listing;
  try {
    const phones = await ensureListingSellerPhone(listingId);
    if (phones.length > 0 && !listing.sellerPhone) {
      snapshot = { ...listing, sellerPhone: phones.join(", ") };
    }
  } catch {
    // Phone lookup must never block the market/vehicle card update.
  }

  if (!check && !market && !snapshot.sellerPhone) return;

  const text = enrichedMessageText(snapshot);

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

  // The compact card no longer renders market/vehicle details, so an update
  // whose text already matches the sent message is a no-op: skip the API call.
  if (notification.lastText === text) return;

  try {
    await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.UPDATE);
    const primaryId = Number(primaryTelegramMessageId(notification.messageId));
    // Albums were sent without a keyboard and carry the card in the caption;
    // legacy text messages with photos fall back to a text edit inside.
    const album = isTelegramAlbumMessage(notification.messageId)
      || describeTelegramSend(snapshot.photoUrls).kind === "ALBUM";
    await editCardText(telegramBot, notification.chatId, primaryId, {
      text,
      caption: clampTelegramCaption(text),
      isCaption: album || describeTelegramSend(snapshot.photoUrls).kind === "PHOTO",
      // Albums cannot carry a keyboard at all; single-photo and text cards
      // refresh it so the copy-phone and favorite buttons stay current.
      replyMarkup: album ? undefined : telegramListingKeyboard(
        snapshot.url,
        snapshot.id,
        notification.retainUntil,
        env.LISTING_FAVORITE_RETENTION_DAYS,
        snapshot.sellerPhone ?? null,
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
    // Albums have no keyboard to reconcile.
    const currentRetention = await prisma.telegramNotification.findUnique({
      where: { id: notification.id },
      select: { retainUntil: true },
    });
    if (!album && currentRetention?.retainUntil?.getTime() !== notification.retainUntil?.getTime()) {
      await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.UPDATE);
      await telegramBot.api.editMessageReplyMarkup(notification.chatId, Number(notification.messageId), {
        reply_markup: telegramListingKeyboard(
          snapshot.url,
          snapshot.id,
          currentRetention?.retainUntil ?? null,
          env.LISTING_FAVORITE_RETENTION_DAYS,
          snapshot.sellerPhone ?? null,
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

  const messageIds = splitTelegramMessageIds(input.messageId);
  if (messageIds.length === 0) {
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

  // Album children are deleted one by one; an already-gone sibling never
  // fails the whole cleanup. Messages past the 48h delete window are
  // collected for the tombstone pass below.
  const remaining: number[] = [];
  for (const rawId of messageIds) {
    try {
      await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
      await telegramBot.api.deleteMessage(input.chatId, Number(rawId));
    } catch (error) {
      await deferGlobalTelegramGate(error);
      const message = error instanceof Error ? error.message : String(error);
      if (isTelegramMessageGoneError(message) || isPermanentTelegramChatError(message)) {
        continue;
      }
      if (!isTelegramDeleteTooOldError(message)) {
        return {
          outcome: "RETRY",
          errorCode: telegramRetryAfterSeconds(error) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_DELETE_FAILED",
          errorMessage: message,
        };
      }
      remaining.push(Number(rawId));
    }
  }
  if (remaining.length === 0) return { outcome: "CLEARED" };

  // Bot API cannot physically delete normal messages after 48 hours. Bot-owned
  // messages can still be edited, so remove the listing content and buttons
  // from every remaining message (photo captions and plain text alike).
  const tombstoneText = input.favoriteExpired
    ? `🗑 Сохранённое объявление удалено из проекта после ${env.LISTING_FAVORITE_RETENTION_DAYS} дней.`
    : "🗑 Объявление удалено из проекта по истечении срока хранения.";
  for (const tombstoneId of remaining) {
    try {
      await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
      await telegramBot.api.editMessageText(input.chatId, tombstoneId, tombstoneText, {
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      await deferGlobalTelegramGate(error);
      const message = error instanceof Error ? error.message : String(error);
      if (/no text in the message/iu.test(message)) {
        try {
          await listingSendGate.waitForSlot(TELEGRAM_GATE_PRIORITY.RETENTION);
          await telegramBot.api.editMessageCaption(input.chatId, tombstoneId, { caption: tombstoneText });
          continue;
        } catch (nested) {
          await deferGlobalTelegramGate(nested);
          const nestedMessage = nested instanceof Error ? nested.message : String(nested);
          if (
            /message is not modified/iu.test(nestedMessage) ||
            isTelegramMessageGoneError(nestedMessage) ||
            isPermanentTelegramChatError(nestedMessage) ||
            isPermanentTelegramEditError(nestedMessage)
          ) {
            continue;
          }
          return {
            outcome: "RETRY",
            errorCode: telegramRetryAfterSeconds(nested) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_CLEAR_FAILED",
            errorMessage: nestedMessage,
          };
        }
      }
      if (
        /message is not modified/iu.test(message) ||
        isTelegramMessageGoneError(message) ||
        isPermanentTelegramChatError(message) ||
        isPermanentTelegramEditError(message)
      ) {
        continue;
      }
      return {
        outcome: "RETRY",
        errorCode: telegramRetryAfterSeconds(error) ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_CLEAR_FAILED",
        errorMessage: message,
      };
    }
  }
  return { outcome: "CLEARED", detail: "Telegram message content cleared" };
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

/**
 * Parks a hopeless card after the attempt ceiling: the row stays durable
 * (nothing is ever deleted), retries stop, and the operator gets one alert
 * with the exact re-arm statement. The CAS guard makes the transition — and
 * the alert — happen exactly once under concurrent reservers.
 */
async function quarantineTelegramNotification(
  notificationId: string,
  attemptCount: number,
  status: TelegramNotificationStatus,
  context: { listingId: string; chatId: string; attemptCount: number; lastError: string },
): Promise<void> {
  const parked = await prisma.telegramNotification.updateMany({
    where: { id: notificationId, attemptCount, status },
    data: {
      status: "QUARANTINED",
      nextAttemptAt: null,
      leaseExpiresAt: null,
      lastErrorCode: "TELEGRAM_QUARANTINED",
      lastErrorMessage: `Parked after ${attemptCount} attempts (${context.lastError}). Re-arm: UPDATE telegram_notifications SET status='RETRY_PENDING', "nextAttemptAt"=NOW() WHERE id='${notificationId}'.`,
    },
  });
  if (parked.count !== 1) return;
  let url = context.listingId;
  try {
    const row = await prisma.listing.findUnique({ where: { id: context.listingId }, select: { url: true } });
    if (row?.url) url = row.url;
  } catch {
    // Best-effort enrichment only.
  }
  const text = [
    "Карантин доставки: карточка не доставлена за 30 попыток и поставлена на паузу.",
    `Объявление: ${url}`,
    `Чат: ${context.chatId}, попыток: ${context.attemptCount}, последняя ошибка: ${context.lastError}`,
    "Данные целы, ретраи остановлены. Для повторной отправки переведите строку в RETRY_PENDING.",
  ].join("\n");
  try {
    await sendSystemAlert(text);
  } catch (error) {
    await log.warn(
      "telegram",
      "quarantine alert failed",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
  }
  await log.error("telegram", "card quarantined after attempt ceiling", `${context.listingId} ${context.chatId}`);
}

async function reserveTelegramNotification(
  listingId: string,
  chatId: string,
  text: string,
): Promise<
  | { kind: "reserved"; notificationId: string; acceptedAt: Date | null; attemptCount: number }
  | { kind: "already-sent"; acceptedAt: Date | null }
  | { kind: "locked" }
> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + TELEGRAM_SEND_LEASE_MS);
  const existing = await prisma.telegramNotification.findUnique({ where: { listingId_chatId: { listingId, chatId } } });

  if (existing?.messageId) {
    return { kind: "already-sent", acceptedAt: existing.acceptedAt ?? existing.sentAt };
  }
  if ((existing?.status === "SENDING" || existing?.status === "PROCESSING") && existing.leaseExpiresAt && existing.leaseExpiresAt > now) {
    return { kind: "locked" };
  }
  if (existing && shouldQuarantineDelivery(existing.status, existing.attemptCount)) {
    await quarantineTelegramNotification(existing.id, existing.attemptCount, existing.status, {
      listingId,
      chatId,
      attemptCount: existing.attemptCount,
      lastError: existing.lastErrorMessage ?? existing.lastErrorCode ?? "unknown",
    });
    return { kind: "locked" };
  }

  try {
    if (existing) {
      const reserved = await prisma.telegramNotification.updateMany({
        where: {
          id: existing.id,
          attemptCount: existing.attemptCount,
          messageId: null,
          status: { notIn: ["SENT", "UPDATED", "DELIVERED", "PERMANENT", "QUARANTINED"] },
          OR: [
            { status: { notIn: ["SENDING", "PROCESSING"] } },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          chatId,
          status: "SENDING",
          lastText: text,
          attemptCount: { increment: 1 },
          processingStartedAt: now,
          lastAttemptAt: now,
          leaseExpiresAt,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (reserved.count !== 1) return { kind: "locked" };
      return { kind: "reserved", notificationId: existing.id, acceptedAt: existing.acceptedAt, attemptCount: existing.attemptCount + 1 };
    }

    const created = await prisma.telegramNotification.create({
      data: {
        listingId,
        chatId,
        status: "SENDING",
        lastText: text,
        attemptCount: 1,
        processingStartedAt: now,
        lastAttemptAt: now,
        leaseExpiresAt,
      },
    });
    return { kind: "reserved", notificationId: created.id, acceptedAt: created.acceptedAt, attemptCount: created.attemptCount };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { kind: "locked" };
    throw err;
  }
}

async function syncAcceptedListing(listingId: string, acceptedAt: Date): Promise<void> {
  await prisma.$transaction([
    prisma.listing.updateMany({
      where: { id: listingId, status: { in: ["NEW", "MATCHED"] } },
      data: { status: "SENT" },
    }),
    prisma.sourceSeenListing.updateMany({ where: { listingId }, data: { decision: "NOTIFIED" } }),
    prisma.sourceSeenListing.updateMany({ where: { listingId, notifiedAt: null }, data: { notifiedAt: acceptedAt } }),
    prisma.sourceSeenListing.updateMany({ where: { listingId, telegramAcceptedAt: null }, data: { telegramAcceptedAt: acceptedAt } }),
  ]);
}

async function syncAcceptedFlashBundle(
  flashBundleId: string,
  listingIds: string[],
  acceptedAt: Date,
  requestedAt: Date,
): Promise<void> {
  await prisma.$transaction([
    prisma.telegramNotification.updateMany({ where: { flashBundleId, status: "FLASH_PENDING" }, data: { status: "PENDING", acceptedAt } }),
    prisma.listing.updateMany({
      where: { id: { in: listingIds }, status: { in: ["NEW", "MATCHED"] } },
      data: { status: "SENT" },
    }),
    prisma.sourceSeenListing.updateMany({ where: { listingId: { in: listingIds } }, data: { decision: "NOTIFIED" } }),
    prisma.sourceSeenListing.updateMany({ where: { listingId: { in: listingIds }, notifiedAt: null }, data: { notifiedAt: acceptedAt } }),
    prisma.sourceSeenListing.updateMany({ where: { listingId: { in: listingIds }, telegramRequestedAt: null }, data: { telegramRequestedAt: requestedAt } }),
    prisma.sourceSeenListing.updateMany({ where: { listingId: { in: listingIds }, telegramAcceptedAt: null }, data: { telegramAcceptedAt: acceptedAt } }),
  ]);
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

/**
 * Verified block suppression.
 *
 * A single PERMANENT send failure ("bot was blocked by the user", deactivated
 * user, missing chat) is not trusted blindly: the number is re-probed with a
 * cheap `sendChatAction("typing")` that delivers nothing. Only a repeated
 * platform verdict deactivates the subscriber, so flukes and migrated chats
 * keep receiving. The owner chat (TELEGRAM_CHAT_ID) is never auto-suppressed:
 * its failure is a configuration problem and stays loudly visible.
 * A later manual /start reactivates the subscriber via the normal upsert.
 */
export async function verifyAndSuppressBlockedChat(chatId: string, sendError: string): Promise<boolean> {
  if (!env.TELEGRAM_BLOCK_SUPPRESS_ENABLED || !chatId) return false;
  if (chatId === env.TELEGRAM_CHAT_ID) {
    await log.error(
      "telegram",
      "Owner chat delivery failed permanently — check TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, auto-suppress refused",
      sendError,
    ).catch(() => undefined);
    return false;
  }
  const telegramBot = getBot();
  if (!telegramBot) return false;
  let confirmed = false;
  try {
    await telegramBot.api.sendChatAction(chatId, "typing");
  } catch (probeError) {
    const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
    confirmed = isPermanentTelegramChatError(probeMessage);
    if (!confirmed) {
      await log.warn(
        "telegram",
        "Block probe inconclusive, subscriber stays active",
        `${chatId}: ${probeMessage}`,
      ).catch(() => undefined);
      return false;
    }
  }
  if (!confirmed) return false;
  try {
    const updated = await prisma.telegramSubscriber.updateMany({
      where: { chatId, active: true },
      data: { active: false, blockedAt: new Date() },
    });
    if (updated.count > 0) {
      await log.warn(
        "telegram",
        `Subscriber ${chatId} auto-suppressed after verified block; future sends skipped`,
        sendError,
      ).catch(() => undefined);
      return true;
    }
    return false;
  } catch (error) {
    await log.warn(
      "telegram",
      "Block suppression persist failed, subscriber stays active",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    return false;
  }
}
