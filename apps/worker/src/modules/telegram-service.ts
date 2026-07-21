import { Bot } from "grammy";
import { Prisma, prisma, type MarketPriceEstimate, type VehicleCheck } from "@amb/db";
import { env } from "../env.js";
import { log } from "../lib/log.js";

let bot: Bot | null = null;
const TELEGRAM_SEND_LEASE_MS = 60_000;
const TELEGRAM_MESSAGE_LIMIT = 3900;

export type TelegramListingSnapshot = {
  id: string;
  source: string;
  url: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  bodyType: string | null;
  fuelType: string | null;
  gearbox: string | null;
  driveType: string | null;
  engineVolume: number | null;
  year: number | null;
  priceNormalized: number | null;
  priceOriginal: number | null;
  currencyOriginal: string | null;
  mileage: number | null;
  city: string | null;
  region: string | null;
  publishedAt: Date | null;
  firstSeenAt: Date;
  timestampConfidence: string;
  discoveryLane: "REALTIME" | "BACKFILL" | "MANUAL";
  vin: string | null;
  plateNormalized: string | null;
  matches?: Array<{ filter: { name: string } }>;
  rawData: unknown;
};

function getBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  if (!bot) bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return bot;
}

export function isTelegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

export async function sendSystemAlert(text: string): Promise<void> {
  const telegramBot = getBot();
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!telegramBot || !chatId) return;

  try {
    await telegramBot.api.sendMessage(chatId, clampTelegramText([text]), {
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await log.warn("telegram", "Не удалось отправить системное уведомление", error instanceof Error ? error.message : String(error));
  }
}

function initialMessageText(listing: TelegramListingSnapshot): string {
  return clampTelegramText([
    messageHeading(listing),
    "",
    ...listingSummaryLines(listing),
    "Рынок: рассчитываю среднюю цену",
    "Проверка авто: выполняется",
    "",
    `Ссылка: ${listing.url}`,
  ]);
}

function enrichedMessageText(
  listing: TelegramListingSnapshot,
  check: VehicleCheck | null,
  market: MarketPriceEstimate | null,
): string {
  const lines = [messageHeading(listing), "", ...listingSummaryLines(listing), ...marketPriceLines(market), ...vehicleCheckLines(check)];

  lines.push("", `Ссылка: ${listing.url}`);
  return clampTelegramText(lines);
}

/**
 * Sends the first Telegram message with a compact lead card.
 * A short DB lease prevents duplicate sends when several workers touch the
 * same listing at the same time.
 */
export async function sendListingLink(listingId: string, snapshot?: TelegramListingSnapshot): Promise<void> {
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
    const sent = await telegramBot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: listingButton(listing.url),
    });

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
        sentAt: new Date(),
      },
    });

    const notifiedAt = new Date();
    await prisma.$transaction([
      prisma.listing.update({ where: { id: listingId }, data: { status: "SENT" } }),
      prisma.sourceSeenListing.updateMany({
        where: { listingId },
        data: { decision: "NOTIFIED", notifiedAt },
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryAfterSeconds = telegramRetryAfterSeconds(err);
    await prisma.telegramNotification.update({
      where: { id: reservation.notificationId },
      data: {
        status: "RETRY_PENDING",
        leaseExpiresAt: null,
        lastErrorCode: retryAfterSeconds ? "TELEGRAM_RATE_LIMITED" : "TELEGRAM_SEND_FAILED",
        lastErrorMessage: message,
      },
    });
    await log.error("telegram", "sendMessage failed", message);
    if (retryAfterSeconds) throw new TelegramRateLimitError(message, retryAfterSeconds);
    throw err;
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
    await telegramBot.api.editMessageText(notification.chatId, Number(notification.messageId), text, {
      link_preview_options: { is_disabled: true },
      reply_markup: listingButton(listing.url),
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
  } catch (err) {
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

function isPermanentTelegramChatError(message: string): boolean {
  return /(?:user is deactivated|bot was blocked by the user|chat not found|user not found)/iu.test(message);
}

async function reserveTelegramNotification(
  listingId: string,
  chatId: string,
  text: string,
): Promise<{ kind: "reserved"; notificationId: string } | { kind: "already-sent" } | { kind: "locked" }> {
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
      return { kind: "reserved", notificationId: existing.id };
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
    return { kind: "reserved", notificationId: created.id };
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

function listingSummaryLines(listing: TelegramListingSnapshot): string[] {
  const title = listing.title ?? ([listing.brand, listing.model, listing.year].filter(Boolean).join(" ") || "Авто без названия");
  const filters = listing.matches?.map((match) => match.filter.name).filter(Boolean).slice(0, 3) ?? [];
  const specs = [
    listing.engineVolume != null ? `${listing.engineVolume} л` : null,
    vehicleAttributeLabel(listing.fuelType),
    vehicleAttributeLabel(listing.gearbox),
    vehicleAttributeLabel(listing.driveType),
    vehicleAttributeLabel(listing.bodyType),
  ].filter(Boolean);
  const latency = discoveryLatencyLine(listing);
  return [
    `Источник: ${sourceLabel(listing.source)}`,
    `Автомобиль: ${title}`,
    `Цена: ${formatPrice(listing)}`,
    `Год/пробег: ${listing.year ?? "-"} / ${listing.mileage != null ? `${listing.mileage} км` : "-"}`,
    ...(specs.length ? [`Характеристики: ${specs.join(" / ")}`] : []),
    `Место: ${[listing.city, listing.region].filter(Boolean).join(", ") || "-"}`,
    `Опубликовано: ${formatDate(listing.publishedAt)}`,
    `Обнаружено: ${formatDate(listing.firstSeenAt)}`,
    ...(latency ? [latency] : []),
    `Фильтры: ${filters.length ? filters.join(", ") : "-"}`,
    `Номер/VIN: ${listing.plateNormalized ?? "-"} / ${listing.vin ?? "-"}`,
  ];
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

function messageHeading(listing: TelegramListingSnapshot): string {
  if (listing.discoveryLane === "BACKFILL") return "НАЙДЕНО ПРИ ФОНОВОЙ СВЕРКЕ";
  if (listing.discoveryLane === "MANUAL") return "НАЙДЕНО ПРИ РУЧНОЙ ПРОВЕРКЕ";
  return "НОВОЕ ОБЪЯВЛЕНИЕ";
}

function vehicleAttributeLabel(value: string | null): string | null {
  if (!value) return null;
  const labels: Record<string, string> = {
    gasoline: "бензин",
    petrol: "бензин",
    diesel: "дизель",
    gas: "газ",
    hybrid: "гибрид",
    electric: "электро",
    manual: "механика",
    automatic: "автомат",
    robot: "робот",
    variator: "вариатор",
    fwd: "передний привод",
    rwd: "задний привод",
    awd: "полный привод",
    "4wd": "полный привод",
    sedan: "седан",
    hatchback: "хэтчбек",
    wagon: "универсал",
    coupe: "купе",
    convertible: "кабриолет",
    minivan: "минивэн",
    van: "фургон",
    pickup: "пикап",
    suv: "внедорожник",
    crossover: "кроссовер",
  };
  return labels[value.toLowerCase()] ?? value;
}

function marketPriceLines(market: MarketPriceEstimate | null): string[] {
  if (!market) return ["Рынок: считаю среднюю цену"];
  const research = marketResearchLines(market);
  if (market.status !== "READY") return [`Рынок: мало похожих объявлений (${market.sampleSize})`, ...research];

  return [
    `Рынок: ${marketVerdictLabel(market.verdict)} (${market.sampleSize} похожих)`,
    `Медиана/средняя: ${formatUsd(market.medianPrice)} / ${formatUsd(market.averagePrice)}`,
    `Нормальный коридор: ${formatUsd(market.fairLowPrice)} - ${formatUsd(market.fairHighPrice)}`,
    `Разброс выборки: ${formatUsd(market.minPrice)} - ${formatUsd(market.maxPrice)}`,
    ...research,
  ];
}

function marketResearchLines(market: MarketPriceEstimate): string[] {
  const params = asJsonObject(market.params);
  if (!params) return [];
  const breakdown = asJsonObject(params.sourceBreakdown);
  const sourceParts = breakdown
    ? Object.entries(breakdown)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
        .map(([source, count]) => `${sourceLabel(source)}: ${count}`)
    : [];
  const active = numberValue(params.activeSampleSize);
  const database = numberValue(params.databaseSampleSize);
  const lines: string[] = [];
  if (sourceParts.length > 0) lines.push(`Источники цен: ${sourceParts.join(", ")}`);
  if (active != null || database != null) {
    lines.push(`Проверка рынка: свежая выдача ${active ?? 0}, база проекта ${database ?? 0}`);
  }
  return lines;
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function vehicleCheckLines(check: VehicleCheck | null): string[] {
  if (!check) return ["Проверка авто: выполняется"];
  if (!check.plateNormalized && !check.vin) {
    return ["Проверка авто: выполнена", "Номер/VIN: не найдено в объявлении"];
  }

  const vinData = [
    check.make,
    check.model,
    check.year,
    check.engineVolume != null ? `${check.engineVolume} л` : null,
    check.fuelType,
  ].filter(Boolean);
  const discrepancies = check.discrepancies.length ? check.discrepancies.slice(0, 3).join(" | ") : "нет";
  const extra = [check.accidents, check.restrictions].filter(Boolean);

  return [
    `Проверка авто: ${vehicleStatusLabel(check.checkStatus)}${check.provider ? ` через ${providerLabel(check.provider)}` : ""}`,
    `Номер: ${check.plateNormalized ?? "-"}`,
    `VIN: ${check.vin ?? "-"}`,
    `Данные VIN: ${vinData.length ? vinData.join(" / ") : "-"}`,
    `Риски: ${extra.length ? extra.join(" | ") : "-"}`,
    `Несовпадения: ${discrepancies}`,
  ];
}

function marketVerdictLabel(verdict: MarketPriceEstimate["verdict"]): string {
  switch (verdict) {
    case "HIGH_RISK_BARGAIN":
      return "очень дешево, проверять жестко";
    case "BELOW_MARKET":
      return "ниже рынка";
    case "FAIR":
      return "рыночная цена";
    case "ABOVE_MARKET":
      return "выше рынка";
    default:
      return "недостаточно данных";
  }
}

function formatPrice(listing: TelegramListingSnapshot): string {
  if (listing.priceNormalized != null) return `${listing.priceNormalized} $`;
  if (listing.priceOriginal != null) return `${listing.priceOriginal} ${listing.currencyOriginal ?? ""}`.trim();
  return "-";
}

function formatUsd(value: number | null): string {
  return value == null ? "-" : `${value} $`;
}

function formatDate(value: Date | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function discoveryLatencyLine(listing: TelegramListingSnapshot): string | null {
  if (!listing.publishedAt || !["HIGH", "MEDIUM"].includes(listing.timestampConfidence)) return null;
  const latencyMs = listing.firstSeenAt.getTime() - listing.publishedAt.getTime();
  if (latencyMs < 0) return null;
  return `Скорость обнаружения: ${formatDuration(latencyMs)}`;
}

function formatDuration(valueMs: number): string {
  const seconds = Math.max(0, Math.round(valueMs / 1000));
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} мин ${rest} сек` : `${minutes} мин`;
}

function listingButton(url: string) {
  return { inline_keyboard: [[{ text: "Открыть объявление", url }]] };
}

function clampTelegramText(lines: string[]): string {
  const text = lines.join("\n");
  return text.length <= TELEGRAM_MESSAGE_LIMIT ? text : `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 20)}\n...обрезано`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "AUTO_RIA":
      return "AUTO.RIA";
    case "CARS_UA":
      return "Cars.ua";
    case "AUTOMOTO":
      return "AutoMoto.ua";
    case "MOCK":
      return "Тестовый";
    default:
      return source;
  }
}

function vehicleStatusLabel(status: VehicleCheck["checkStatus"]): string {
  switch (status) {
    case "NOT_STARTED":
      return "не начата";
    case "PENDING":
      return "выполняется";
    case "NO_PLATE_OR_VIN_FOUND":
      return "номер и VIN не найдены";
    case "PLATE_FOUND":
      return "найден номер";
    case "VIN_FOUND":
      return "найден VIN";
    case "CHECK_DONE":
      return "готова";
    case "CHECK_PARTIAL":
      return "частично готова";
    case "CHECK_FAILED":
      return "ошибка проверки";
    default:
      return status;
  }
}

function providerLabel(provider: string): string {
  return provider
    .replace("listing_text", "текст объявления")
    .replace("nhtsa_vpic", "NHTSA VIN")
    .replace("nhtsa_recalls", "NHTSA отзывы")
    .replace("data_gov_ua_stolen", "розыск МВД/Нацполиция")
    .replace("cache", "кэш предыдущей проверки")
    .replace(/\+/gu, " + ");
}
