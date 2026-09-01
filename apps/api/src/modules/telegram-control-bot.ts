import {
  acquireTelegramRetentionLock,
  prisma,
} from "@amb/db";
import {
  getCityById,
  getRegionById,
  QUEUE_NAMES,
  TELEGRAM_FAVORITE_CALLBACK_PREFIX,
  telegramListingKeyboard,
  telegramRetentionClaimIsActive,
} from "@amb/shared";
import { logError, logInfo, logWarn } from "../lib/error-log.js";
import { telegramPollingFailurePolicy } from "../lib/telegram-polling-policy.js";
import { env } from "../env.js";
import { checkActiveSourcesNow, disableBulkRealSources, enableBulkRealSources } from "./sources/control.js";
import {
  startLiveMonitoring,
  startMonitoring,
  startStandardMonitoring,
  stopMonitoring,
} from "./monitoring/control.js";
import { enqueue } from "../lib/queues.js";
import {
  errorMessage,
  formatList,
  shorten,
  sourceLabel,
  translateApiError,
} from "./telegram-control-format.js";
import {
  addAutoRiaToCompatibleFilters,
  cancelKeyboard,
  clearPendingAction,
  createFilterFromTelegram,
  deleteFilterById,
  filterDetailsKeyboard,
  filtersKeyboard,
  formatFilterDetails,
  formatFiltersPanel,
  geoCitiesKeyboard,
  geoPrompt,
  geoRegionsKeyboard,
  getPendingAction,
  newFilterPrompt,
  runFilterTextCommand,
  runPendingAction,
  setFilterAllSources,
  setFilterGeoByIds,
  setPendingAction,
  toggleFilterById,
  type ReplyMarkup,
} from "./telegram-control-filters.js";
import {
  abortActiveTelegramRequests,
  answerTelegramCallback as answerCallback,
  editTelegramMessage as editMessage,
  editTelegramReplyMarkup as editMessageReplyMarkup,
  isAllowedTelegramChat as isAllowedChat,
  sendTelegramMessage as sendMessage,
  telegramApi,
} from "./telegram-control-client.js";
import {
  formatCompletenessText,
  formatPanelText,
} from "./telegram-control-status.js";

export { geoCitiesKeyboard, geoRegionsKeyboard } from "./telegram-control-filters.js";

type ControlCommand = "panel" | "status" | "live" | "start" | "standard" | "stop" | "scan" | "sources_on" | "sources_off";

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: {
    id: number | string;
  };
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};

const CONTROL_PREFIX = "amb:";
const POLLING_TIMEOUT_SECONDS = 25;
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_MAX_DELAY_MS = 60_000;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

const PANEL_KEYBOARD: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "Пуск", callback_data: `${CONTROL_PREFIX}start` },
      { text: "Стоп", callback_data: `${CONTROL_PREFIX}stop` },
      { text: "Скан", callback_data: `${CONTROL_PREFIX}scan` },
    ],
    [
      { text: "Боевой", callback_data: `${CONTROL_PREFIX}live` },
      { text: "Обычный", callback_data: `${CONTROL_PREFIX}standard` },
    ],
    [
      { text: "Фильтры", callback_data: `${CONTROL_PREFIX}filters` },
      { text: "Гео", callback_data: `${CONTROL_PREFIX}filter_geo_menu` },
      { text: "Статус", callback_data: `${CONTROL_PREFIX}status` },
    ],
    [
      { text: "Источники: вкл", callback_data: `${CONTROL_PREFIX}sources_on` },
      { text: "Источники: выкл", callback_data: `${CONTROL_PREFIX}sources_off` },
    ],
    [
      { text: "Полнота", callback_data: `${CONTROL_PREFIX}completeness` },
      { text: "Проверить пропуски", callback_data: `${CONTROL_PREFIX}replay` },
    ],
  ],
};

let stopRequested = false;
let pollingPromise: Promise<void> | null = null;

export function startTelegramControlBot(): void {
  if (!env.TELEGRAM_CONTROL_BOT_ENABLED) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (pollingPromise) return;

  stopRequested = false;
  pollingPromise = pollingLoop().finally(() => {
    pollingPromise = null;
  });

  if (env.TELEGRAM_CONTROL_NOTIFY_ON_START) {
    void sendPanel("Автомонитор запущен на ноутбуке.\nУправление доступно с этой панели.").catch((err) =>
      logError("telegram-control", "Failed to send startup panel", errorMessage(err)),
    );
  }
}

export function stopTelegramControlBot(): void {
  stopRequested = true;
  abortActiveTelegramRequests();
}

async function pollingLoop(): Promise<void> {
  let offset = 0;
  let consecutiveFailures = 0;
  let lastFailureLogAt = 0;
  await logInfo("telegram-control", "Telegram control bot started");

  try {
    await telegramApi<boolean>("deleteWebhook", { drop_pending_updates: false });
    offset = await latestOffset();
  } catch (err) {
    await logError("telegram-control", "Telegram control initialization failed", errorMessage(err));
  }

  while (!stopRequested) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout: POLLING_TIMEOUT_SECONDS,
          allowed_updates: ["message", "callback_query"],
        },
        (POLLING_TIMEOUT_SECONDS + 15) * 1000,
      );

      if (consecutiveFailures > 0) {
        await logInfo("telegram-control", `Telegram control polling recovered after ${consecutiveFailures} failure(s)`);
        consecutiveFailures = 0;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (err) {
      if (stopRequested) break;
      consecutiveFailures += 1;
      const policy = telegramPollingFailurePolicy(
        err,
        consecutiveFailures,
        RETRY_BASE_DELAY_MS,
        RETRY_MAX_DELAY_MS,
      );
      const now = Date.now();
      if (consecutiveFailures === 1 || now - lastFailureLogAt >= 5 * 60 * 1000) {
        const message = policy.timedOut
          ? `Telegram control polling timed out (${consecutiveFailures} consecutive timeout(s))`
          : `Telegram control polling failed (${consecutiveFailures} consecutive failure(s))`;
        if (policy.severity === "WARN") {
          await logWarn("telegram-control", message, errorMessage(err));
        } else {
          await logError("telegram-control", message, errorMessage(err));
        }
        lastFailureLogAt = now;
      }
      await sleep(
        policy.retryDelayMs +
          Math.floor(Math.random() * Math.max(1, Math.round(policy.retryDelayMs * 0.25))),
      );
    }
  }

  await logInfo("telegram-control", "Telegram control bot stopped");
}

async function latestOffset(): Promise<number> {
  const updates = await telegramApi<TelegramUpdate[]>(
    "getUpdates",
    {
      timeout: 0,
      limit: 100,
      allowed_updates: ["message", "callback_query"],
    },
    10000,
  );
  return updates.reduce((max, update) => Math.max(max, update.update_id + 1), 0);
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  if (update.message?.text) {
    await handleMessage(update.message);
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!isAllowedChat(message.chat.id)) return;
  const text = message.text ?? "";
  const chatId = message.chat.id;

  if (isCancelCommand(text)) {
    clearPendingAction(chatId);
    await sendPanel(await formatPanelText());
    return;
  }

  const pending = getPendingAction(chatId);
  if (pending && !text.trim().startsWith("/")) {
    const result = await runPendingAction(pending, text);
    clearPendingAction(chatId);
    await sendFiltersPanel(result);
    return;
  }

  if (isFiltersCommand(text)) {
    await sendFiltersPanel(await formatFiltersPanel());
    return;
  }

  if (isFilterCreateCommand(text)) {
    await sendFiltersPanel(await createFilterFromTelegram(text));
    return;
  }

  const filterCommandResult = await runFilterTextCommand(text);
  if (filterCommandResult) {
    await sendFiltersPanel(filterCommandResult);
    return;
  }

  const command = parseTextCommand(text);
  if (!command) return;

  const responseText = command === "panel" ? await formatPanelText() : await runControlCommand(command);
  await sendPanel(responseText);
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  if (!chatId || !isAllowedChat(chatId)) {
    await answerCallback(callback.id, "Нет доступа");
    return;
  }

  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  if (data.startsWith(TELEGRAM_FAVORITE_CALLBACK_PREFIX)) {
    await handleListingFavoriteCallback(callback.id, chatId, messageId, data);
    return;
  }

  if (data === `${CONTROL_PREFIX}filters`) {
    await answerCallback(callback.id, "Открываю фильтры");
    await respondToCallback(chatId, messageId, await formatFiltersPanel(), await filtersKeyboard());
    return;
  }

  if (data === `${CONTROL_PREFIX}completeness`) {
    await answerCallback(callback.id, "Проверяю полноту");
    await respondToCallback(chatId, messageId, await formatCompletenessText(), PANEL_KEYBOARD);
    return;
  }

  if (data === `${CONTROL_PREFIX}replay`) {
    await enqueue(
      QUEUE_NAMES.OBSERVATION_REPLAY,
      "replay",
      { trigger: "MANUAL", lookbackHours: 48, limit: 1_000 },
      { jobId: `telegram-observation-replay-${Date.now()}` },
    );
    await answerCallback(callback.id, "Сверка запущена");
    await respondToCallback(
      chatId,
      messageId,
      "Повторная проверка объявлений за 48 часов поставлена в очередь. Уже отправленные карточки повторно не придут.",
      PANEL_KEYBOARD,
    );
    return;
  }

  if (data === `${CONTROL_PREFIX}filter_geo_menu`) {
    await answerCallback(callback.id, "Гео фильтров");
    await respondToCallback(chatId, messageId, "Выбери фильтр и нажми «Гео».", await filtersKeyboard());
    return;
  }

  if (data === `${CONTROL_PREFIX}filter_new`) {
    setPendingAction(chatId, { type: "create_filter", expiresAt: Date.now() + PENDING_ACTION_TTL_MS });
    await answerCallback(callback.id, "Жду строку фильтра");
    await respondToCallback(chatId, messageId, newFilterPrompt(), cancelKeyboard());
    return;
  }

  if (data === `${CONTROL_PREFIX}filter_help`) {
    await answerCallback(callback.id, "Подсказка");
    setPendingAction(chatId, { type: "create_filter", expiresAt: Date.now() + PENDING_ACTION_TTL_MS });
    await respondToCallback(chatId, messageId, newFilterPrompt(), cancelKeyboard());
    return;
  }

  if (data === `${CONTROL_PREFIX}filter_auto_ria`) {
    await answerCallback(callback.id, "Обновляю фильтры");
    await respondToCallback(chatId, messageId, await addAutoRiaToCompatibleFilters(), await filtersKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_toggle:`)) {
    await answerCallback(callback.id, "Переключаю фильтр");
    const id = data.slice(`${CONTROL_PREFIX}filter_toggle:`.length);
    await toggleFilterById(id);
    await respondToCallback(chatId, messageId, await formatFiltersPanel(), await filtersKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_sources_all:`)) {
    await answerCallback(callback.id, "Обновляю источники");
    const id = data.slice(`${CONTROL_PREFIX}filter_sources_all:`.length);
    const text = await setFilterAllSources(id);
    await respondToCallback(chatId, messageId, `${text}\n\n${await formatFiltersPanel()}`, await filtersKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_open:`)) {
    const id = data.slice(`${CONTROL_PREFIX}filter_open:`.length);
    const view = await formatFilterDetails(id);
    await answerCallback(callback.id, view ? "Фильтр открыт" : "Фильтр не найден");
    await respondToCallback(chatId, messageId, view ?? (await formatFiltersPanel()), view ? filterDetailsKeyboard(id) : await filtersKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_geo:`)) {
    const id = data.slice(`${CONTROL_PREFIX}filter_geo:`.length);
    const filter = await prisma.filter.findUnique({ where: { id }, select: { name: true } });
    if (!filter) {
      await answerCallback(callback.id, "Фильтр не найден");
      await respondToCallback(chatId, messageId, await formatFiltersPanel(), await filtersKeyboard());
      return;
    }
    await answerCallback(callback.id, "Выбери область");
    await respondToCallback(chatId, messageId, `География: ${shorten(filter.name, 60)}\nВыбери область.`, geoRegionsKeyboard(id, 0));
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}gr:`)) {
    const payload = data.slice(`${CONTROL_PREFIX}gr:`.length).split(":");
    const id = payload[0] ?? "";
    const page = Number(payload[1] ?? 0);
    await answerCallback(callback.id, "Области");
    await respondToCallback(chatId, messageId, "Выбери область для поиска.", geoRegionsKeyboard(id, page));
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}grr:`)) {
    const payload = data.slice(`${CONTROL_PREFIX}grr:`.length).split(":");
    const id = payload[0] ?? "";
    const regionId = payload[1] ?? "";
    const region = getRegionById(regionId);
    if (!region) {
      await answerCallback(callback.id, "Область не найдена");
      return;
    }
    await answerCallback(callback.id, region.nameRu);
    await respondToCallback(
      chatId,
      messageId,
      `${region.nameRu}\nВыбери конкретный город или всю область.`,
      geoCitiesKeyboard(id, regionId, 0),
    );
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}gc:`)) {
    const payload = data.slice(`${CONTROL_PREFIX}gc:`.length).split(":");
    const id = payload[0] ?? "";
    const regionId = payload[1] ?? "";
    const page = Number(payload[2] ?? 0);
    const region = getRegionById(regionId);
    await answerCallback(callback.id, "Города");
    await respondToCallback(
      chatId,
      messageId,
      region ? `${region.nameRu}\nВыбери город.` : "Выбери город.",
      geoCitiesKeyboard(id, regionId, page),
    );
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}gw:`)) {
    const payload = data.slice(`${CONTROL_PREFIX}gw:`.length).split(":");
    const id = payload[0] ?? "";
    const regionId = payload[1] ?? "";
    const text = await setFilterGeoByIds(id, [regionId], []);
    await answerCallback(callback.id, "Выбрана вся область");
    await respondToCallback(chatId, messageId, text, filterDetailsKeyboard(id));
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}g:`)) {
    const payload = data.slice(`${CONTROL_PREFIX}g:`.length).split(":");
    const id = payload[0] ?? "";
    const cityId = payload[1] ?? "";
    const city = getCityById(cityId);
    if (!city) {
      await answerCallback(callback.id, "Город не найден");
      return;
    }
    const text = await setFilterGeoByIds(id, [city.regionId], [city.id]);
    await answerCallback(callback.id, city.nameRu);
    await respondToCallback(chatId, messageId, text, filterDetailsKeyboard(id));
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}gt:`)) {
    const id = data.slice(`${CONTROL_PREFIX}gt:`.length);
    const filter = await prisma.filter.findUnique({ where: { id }, select: { name: true } });
    if (!filter) {
      await answerCallback(callback.id, "Фильтр не найден");
      return;
    }
    setPendingAction(chatId, { type: "set_geo", filterId: id, expiresAt: Date.now() + PENDING_ACTION_TTL_MS });
    await answerCallback(callback.id, "Жду название");
    await respondToCallback(chatId, messageId, geoPrompt(filter.name), cancelKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_geo_all:`)) {
    const id = data.slice(`${CONTROL_PREFIX}filter_geo_all:`.length);
    const text = await setFilterGeoByIds(id, [], []);
    await answerCallback(callback.id, "Гео сброшено");
    await respondToCallback(chatId, messageId, `${text}\n\n${await formatFiltersPanel()}`, await filtersKeyboard());
    return;
  }

  if (data.startsWith(`${CONTROL_PREFIX}filter_delete:`)) {
    const id = data.slice(`${CONTROL_PREFIX}filter_delete:`.length);
    const deleted = await deleteFilterById(id);
    await answerCallback(callback.id, deleted ? "Фильтр удален" : "Фильтр не найден");
    await respondToCallback(chatId, messageId, await formatFiltersPanel(), await filtersKeyboard());
    return;
  }

  const command = parseCallbackCommand(data);
  if (!command) {
    await answerCallback(callback.id, "Неизвестная команда");
    return;
  }

  await answerCallback(callback.id, "Выполняю");
  const responseText = command === "panel" ? await formatPanelText() : await runControlCommand(command);
  await respondToCallback(chatId, messageId, responseText, PANEL_KEYBOARD);
}

async function handleListingFavoriteCallback(
  callbackId: string,
  chatId: number | string,
  messageId: number | undefined,
  data: string,
): Promise<void> {
  const listingId = data.slice(TELEGRAM_FAVORITE_CALLBACK_PREFIX.length);
  if (!messageId || !/^[a-zA-Z0-9_-]{1,48}$/u.test(listingId)) {
    await answerCallback(callbackId, "Карточка устарела");
    return;
  }

  const toggle = await prisma.$transaction(async (tx) => {
    await acquireTelegramRetentionLock(tx, listingId);
    const notification = await tx.telegramNotification.findUnique({
      where: { listingId },
      include: { listing: { select: { url: true } } },
    });
    if (
      !notification
      || notification.messageId !== String(messageId)
      || notification.chatId !== String(chatId)
    ) {
      return null;
    }

    const now = new Date();
    if (telegramRetentionClaimIsActive(notification.cleanupAttemptedAt, now)) {
      return { kind: "cleanup-in-progress" as const };
    }
    const currentlyFavorite = Boolean(
      notification.favoritedAt && notification.retainUntil && notification.retainUntil > now,
    );
    const favoriting = !currentlyFavorite;
    const retainUntil = favoriting
      ? new Date(now.getTime() + env.LISTING_FAVORITE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      : null;
    const sentAt = notification.sentAt ?? now;
    const deleteAfter = favoriting
      ? null
      : new Date(sentAt.getTime() + env.LISTING_RETENTION_HOURS * 60 * 60 * 1000);

    const updated = await tx.telegramNotification.update({
      where: { id: notification.id },
      data: {
        favoritedAt: favoriting ? now : null,
        retainUntil,
        deleteAfter,
        retentionPolicyAppliedAt: notification.retentionPolicyAppliedAt ?? now,
        cleanupAttemptedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      select: { retainUntil: true },
    });
    return { kind: "updated" as const, notification, updated, favoriting };
  }, { maxWait: 5_000, timeout: 30_000 });

  if (!toggle) {
    await answerCallback(callbackId, "Карточка уже удалена");
    return;
  }
  if (toggle.kind === "cleanup-in-progress") {
    await answerCallback(callbackId, "Срок карточки уже истёк, выполняется очистка");
    return;
  }

  await answerCallback(
    callbackId,
    toggle.favoriting
      ? `Сохранено на ${env.LISTING_FAVORITE_RETENTION_DAYS} дней`
      : "Снято с сохранения",
  );
  await editMessageReplyMarkup(
    chatId,
    messageId,
    telegramListingKeyboard(
      toggle.notification.listing.url,
      listingId,
      toggle.updated.retainUntil,
      env.LISTING_FAVORITE_RETENTION_DAYS,
    ),
  ).catch((error) =>
    logError(
      "telegram-favorite",
      "Не удалось обновить кнопку сохранения",
      error instanceof Error ? error.message : String(error),
    ),
  );
}

async function respondToCallback(chatId: number | string, messageId: number | undefined, text: string, replyMarkup: ReplyMarkup): Promise<void> {
  if (messageId) {
    await editMessage(chatId, messageId, text, replyMarkup).catch(() => sendMessage(text, replyMarkup));
    return;
  }
  await sendMessage(text, replyMarkup);
}

async function runControlCommand(command: ControlCommand): Promise<string> {
  switch (command) {
    case "live":
      await startLiveMonitoring();
      return `Боевой мониторинг включен.\n\n${await formatPanelText()}`;
    case "start":
      await startMonitoring();
      return `Мониторинг запущен.\n\n${await formatPanelText()}`;
    case "standard":
      await startStandardMonitoring();
      return `Обычный мониторинг включен.\n\n${await formatPanelText()}`;
    case "stop":
      await stopMonitoring();
      return `Мониторинг остановлен.\n\n${await formatPanelText()}`;
    case "scan": {
      const result = await checkActiveSourcesNow();
      if (!result.ok) return `${translateApiError(result.body.error)}\n\n${await formatPanelText()}`;
      return `Скан запущен: ${result.count} источников.\nВ очереди: ${formatList(result.queued.map(sourceLabel))}\nПовторы: ${formatList(result.deduplicated.map(sourceLabel))}\n\n${await formatPanelText()}`;
    }
    case "sources_on": {
      const result = await enableBulkRealSources();
      return `Источники включены: ${result.updated}\n${formatList(result.sources.map(sourceLabel))}\n\n${await formatPanelText()}`;
    }
    case "sources_off": {
      const result = await disableBulkRealSources();
      return `Источники выключены: ${result.updated}\n${formatList(result.sources.map(sourceLabel))}\n\n${await formatPanelText()}`;
    }
    case "status":
    case "panel":
      return formatPanelText();
  }
}


function sendPanel(text: string): Promise<void> {
  return sendMessage(text, PANEL_KEYBOARD);
}

async function sendFiltersPanel(text: string): Promise<void> {
  await sendMessage(text, await filtersKeyboard());
}


function parseTextCommand(text: string | undefined): ControlCommand | null {
  const normalized = (text ?? "").trim().toLowerCase();
  if (normalized === "/start" || normalized === "/panel" || normalized === "панель") return "panel";
  if (normalized === "/status" || normalized === "статус") return "status";
  if (normalized === "/live" || normalized === "/боевой" || normalized === "боевой") return "live";
  if (normalized === "/start_monitoring" || normalized === "/run" || normalized === "/пуск" || normalized === "старт") return "start";
  if (normalized === "/standard" || normalized === "/обычный" || normalized === "обычный") return "standard";
  if (normalized === "/stop" || normalized === "/стоп" || normalized === "стоп") return "stop";
  if (normalized === "/scan" || normalized === "/скан" || normalized === "скан") return "scan";
  if (normalized === "/sources_on" || normalized === "/источники_вкл") return "sources_on";
  if (normalized === "/sources_off" || normalized === "/источники_выкл") return "sources_off";
  return null;
}

function isCancelCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "/cancel" || normalized === "отмена" || normalized === "скасувати";
}

function parseCallbackCommand(value: string | undefined): ControlCommand | null {
  if (!value?.startsWith(CONTROL_PREFIX)) return null;
  const command = value.slice(CONTROL_PREFIX.length);
  if (
    command === "panel" ||
    command === "status" ||
    command === "live" ||
    command === "start" ||
    command === "standard" ||
    command === "stop" ||
    command === "scan" ||
    command === "sources_on" ||
    command === "sources_off"
  ) {
    return command;
  }
  return null;
}

function isFiltersCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "/filters" || normalized === "/фильтры" || normalized === "фильтры";
}

function isFilterCreateCommand(text: string): boolean {
  return /^\/?(filter|фильтр)\s+/iu.test(text.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
