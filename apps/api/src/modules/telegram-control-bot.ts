import { Prisma, prisma, type Filter, type ListingSource } from "@amb/db";
import {
  getCityById,
  getRegionById,
  UKRAINE_REGIONS,
  normalizeCityIds,
  normalizeRegionIds,
  normalizeVehicleText,
  FILTER_REJECTION_LABELS,
  QUEUE_NAMES,
  type FilterRejectionReason,
} from "@amb/shared";
import { logError, logInfo } from "../lib/error-log.js";
import { env } from "../env.js";
import { checkActiveSourcesNow, disableBulkRealSources, enableBulkRealSources } from "./sources/control.js";
import {
  getMonitoringStatus,
  startLiveMonitoring,
  startMonitoring,
  startStandardMonitoring,
  stopMonitoring,
} from "./monitoring/control.js";
import { getMarks, getModels, type TaxonomyOption } from "./vehicle-taxonomy.js";
import { enqueue } from "../lib/queues.js";
import { extractGeo, parseQuickFilter } from "./telegram-filter-parser.js";

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

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

type PendingAction =
  | { type: "create_filter"; expiresAt: number }
  | { type: "set_geo"; filterId: string; expiresAt: number };

const CONTROL_PREFIX = "amb:";
const POLLING_TIMEOUT_SECONDS = 25;
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_MAX_DELAY_MS = 60_000;
const FILTER_LIST_LIMIT = 8;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const REAL_FILTER_SOURCES: ListingSource[] = ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"];

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
let currentAbortController: AbortController | null = null;
const pendingActions = new Map<string, PendingAction>();

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
  currentAbortController?.abort();
  currentAbortController = null;
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
        (POLLING_TIMEOUT_SECONDS + 5) * 1000,
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
      const now = Date.now();
      if (consecutiveFailures === 1 || now - lastFailureLogAt >= 5 * 60 * 1000) {
        await logError(
          "telegram-control",
          `Telegram control polling failed (${consecutiveFailures} consecutive failure(s))`,
          errorMessage(err),
        );
        lastFailureLogAt = now;
      }
      const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(5, consecutiveFailures - 1));
      await sleep(exponential + Math.floor(Math.random() * Math.max(1, Math.round(exponential * 0.25))));
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
    const text = await setFilterGeo(id, "вся Украина");
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

async function formatPanelText(): Promise<string> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [status, observationCounts] = await Promise.all([
    getMonitoringStatus(),
    prisma.sourceSeenListing.groupBy({
      by: ["decision"],
      where: {
        normalizedData: { not: Prisma.JsonNull },
        OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
      },
      _count: { _all: true },
    }),
  ]);
  const queueTotals = Object.values(status.queues).reduce(
    (acc, counts) => ({
      waiting: acc.waiting + counts.waiting,
      active: acc.active + counts.active,
      failed: acc.failed + counts.failed,
    }),
    { waiting: 0, active: 0, failed: 0 },
  );
  const sourceLine = status.sources
    .filter((source) => ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"].includes(source.source) && source.enabled)
    .map((source) => sourceLabel(source.source))
    .join(", ");
  const observed24h = observationCounts.reduce((sum, row) => sum + row._count._all, 0);
  const notified24h = observationCounts.find((row) => row.decision === "NOTIFIED")?._count._all ?? 0;
  const unresolved24h = observationCounts
    .filter((row) => ["PENDING", "MATCHED", "FAILED"].includes(row.decision))
    .reduce((sum, row) => sum + row._count._all, 0);
  return trimTelegramMessage(
    [
      "Автомонитор",
      `Статус: ${monitoringStatusLabel(status.state.status)}`,
      `Режим: ${monitoringModeLabel(status.mode)}`,
      `Сегодня: ${status.foundToday}`,
      `Фильтры: ${status.filters.activeReal}/${status.filters.total}`,
      `Очередь: ${queueTotals.waiting} ждут, ${queueTotals.active} в работе, ${queueTotals.failed} ошибок`,
      `Контроль 24 ч: ${observed24h} увидено, ${notified24h} отправлено, ${unresolved24h} требуют проверки`,
      `Источники: ${sourceLine || "не включены"}`,
    ].join("\n"),
  );
}

async function formatCompletenessText(): Promise<string> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const where = {
    normalizedData: { not: Prisma.JsonNull },
    OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
  } satisfies Prisma.SourceSeenListingWhereInput;
  const [byDecision, bySource, latestAudit, rejected, legacyWithoutSnapshot] = await Promise.all([
    prisma.sourceSeenListing.groupBy({ by: ["decision"], where, _count: { _all: true } }),
    prisma.sourceSeenListing.groupBy({ by: ["source"], where, _count: { _all: true } }),
    prisma.completenessAudit.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.sourceSeenListing.findMany({
      where: { ...where, decision: "REJECTED" },
      select: { rejectionReasons: true },
      take: 2_000,
    }),
    prisma.sourceSeenListing.count({
      where: {
        normalizedData: { equals: Prisma.DbNull },
        OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
      },
    }),
  ]);
  const decisionCount = (decision: string) => byDecision.find((row) => row.decision === decision)?._count._all ?? 0;
  const observed = byDecision.reduce((sum, row) => sum + row._count._all, 0);
  const rejectionCounts = new Map<string, number>();
  for (const row of rejected) {
    for (const reason of row.rejectionReasons) rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
  }
  const topReasons = [...rejectionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([reason, count]) => `${FILTER_REJECTION_LABELS[reason as FilterRejectionReason] ?? reason}: ${count}`);

  return trimTelegramMessage([
    "Полнота мониторинга за 24 часа",
    `Увидено: ${observed}`,
    `Отправлено: ${decisionCount("NOTIFIED")}`,
    `Отсеяно фильтрами: ${decisionCount("REJECTED")}`,
    `Ожидают решения: ${decisionCount("PENDING") + decisionCount("MATCHED") + decisionCount("FAILED")}`,
    `Исторические ID без снимка: ${legacyWithoutSnapshot}`,
    `По источникам: ${bySource.map((row) => `${sourceLabel(row.source)} ${row._count._all}`).join(", ") || "нет данных"}`,
    latestAudit
      ? `Последняя сверка: обработано ${latestAudit.evaluatedCount}, восстановлено ${latestAudit.dispatchedCount}, ошибок ${latestAudit.failedCount}`
      : "Сверка еще не выполнялась",
    ...(topReasons.length > 0 ? ["", "Частые причины отказа:", ...topReasons] : []),
  ].join("\n"));
}

async function formatFiltersPanel(): Promise<string> {
  const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" }, take: FILTER_LIST_LIMIT });
  const total = await prisma.filter.count();
  const active = filters.filter((filter) => filter.enabled).length;

  if (total === 0) {
    return "Фильтров пока нет.\nНажми «Новый» и напиши одной строкой: BMW X5 2015-2020 10000-35000 Днепр";
  }

  const lines = [
    `Фильтры: ${active}/${total} активных`,
    "",
    ...filters.map((filter, index) => filterSummaryLine(filter, index + 1)),
    total > filters.length ? `\nПоказано первые ${filters.length}. Остальные есть на сайте.` : "",
  ];

  return trimTelegramMessage(lines.join("\n"));
}

function filterSummaryLine(filter: Filter, index: number): string {
  const vehicle = [filter.brand, filter.model].filter(Boolean).join(" ") || "любое авто";
  const years = formatRange(filter.yearFrom, filter.yearTo);
  const price = formatRange(filter.priceFrom, filter.priceTo, "$");
  const geo = formatGeo(filter);
  return `${index}. ${filter.enabled ? "вкл" : "выкл"} | ${vehicle} | ${years} | ${price} | ${geo}`;
}

async function filtersKeyboard(): Promise<ReplyMarkup> {
  const filters = await prisma.filter.findMany({
    orderBy: { createdAt: "desc" },
    take: FILTER_LIST_LIMIT,
    select: { id: true, name: true, enabled: true },
  });

  return {
    inline_keyboard: [
      [
        { text: "Новый", callback_data: `${CONTROL_PREFIX}filter_new` },
        { text: "AUTO.RIA в фильтры", callback_data: `${CONTROL_PREFIX}filter_auto_ria` },
      ],
      ...filters.map((filter, index) => [
        {
          text: `${index + 1}. ${shorten(filter.name, 20)}`,
          callback_data: `${CONTROL_PREFIX}filter_open:${filter.id}`,
        },
        {
          text: filter.enabled ? "Выкл" : "Вкл",
          callback_data: `${CONTROL_PREFIX}filter_toggle:${filter.id}`,
        },
        { text: "Гео", callback_data: `${CONTROL_PREFIX}filter_geo:${filter.id}` },
      ]),
      [{ text: "Назад", callback_data: `${CONTROL_PREFIX}panel` }],
    ],
  };
}

function filterHelpText(): string {
  return newFilterPrompt();
}

async function createFilterFromTelegram(text: string): Promise<string> {
  const parsed = parseQuickFilter(text);
  if (!parsed.cleanQuery) return filterHelpText();

  const taxonomy = await resolveAutoRiaIds(parsed.brand, parsed.model);
  const sources = defaultSourcesForFilter(Boolean(taxonomy.autoRiaMarkId));
  const displayVehicle = [parsed.brand, parsed.model].filter(Boolean).join(" ") || parsed.vehicleQuery || "Любое авто";

  const filter = await prisma.filter.create({
    data: {
      name: `ТГ: ${displayVehicle}`.slice(0, 120),
      enabled: true,
      sources,
      autoRiaCategoryId: 1,
      autoRiaMarkId: taxonomy.autoRiaMarkId,
      autoRiaModelId: taxonomy.autoRiaModelId,
      brand: parsed.brand,
      model: parsed.model,
      modelNames: parsed.model ? [parsed.model] : [],
      generation: null,
      bodyTypes: [],
      fuelTypes: [],
      gearboxes: [],
      driveTypes: [],
      colors: [],
      engineVolumeFrom: null,
      engineVolumeTo: null,
      enginePowerFrom: null,
      enginePowerTo: null,
      doorsFrom: null,
      doorsTo: null,
      seatsFrom: null,
      seatsTo: null,
      conditions: [],
      customsCleared: null,
      bargainPossible: null,
      freshnessMode: "LAST_HOUR",
      yearFrom: parsed.yearFrom,
      yearTo: parsed.yearTo,
      priceFrom: parsed.priceFrom,
      priceTo: parsed.priceTo,
      mileageFrom: null,
      mileageTo: null,
      regions: parsed.regions,
      cities: parsed.cities,
      keywords: parsed.brand || parsed.model || !parsed.vehicleQuery ? [] : [parsed.vehicleQuery],
      excludeKeywords: [],
    },
  });

  const autoRiaLine = taxonomy.autoRiaMarkId
    ? `AUTO.RIA подключен: марка ${taxonomy.autoRiaMarkId}${taxonomy.autoRiaModelId ? `, модель ${taxonomy.autoRiaModelId}` : ""}.`
    : env.AUTO_RIA_API_KEY
      ? "AUTO.RIA не добавлен: не удалось точно распознать марку в справочнике."
      : "AUTO.RIA не добавлен: API ключ не настроен.";

  return trimTelegramMessage(
    [
      "Фильтр создан.",
      `Авто: ${[filter.brand, filter.model].filter(Boolean).join(" ") || "по ключевым словам"}`,
      `Годы: ${formatRange(filter.yearFrom, filter.yearTo)}`,
      `Цена: ${formatRange(filter.priceFrom, filter.priceTo, "$")}`,
      `Гео: ${formatGeo(filter)}`,
      `Источники: ${formatList(filter.sources.map(sourceLabel))}`,
      autoRiaLine,
    ].join("\n"),
  );
}

async function formatFilterDetails(id: string): Promise<string | null> {
  const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" }, take: FILTER_LIST_LIMIT });
  const filter = filters.find((item) => item.id === id) ?? (await prisma.filter.findUnique({ where: { id } }));
  if (!filter) return null;
  const index = filters.findIndex((item) => item.id === filter.id);
  const vehicle = [filter.brand, filter.model].filter(Boolean).join(" ") || "любое авто";

  return trimTelegramMessage(
    [
      `Фильтр${index >= 0 ? ` ${index + 1}` : ""}: ${filter.enabled ? "включен" : "выключен"}`,
      `Авто: ${vehicle}`,
      `Годы: ${formatRange(filter.yearFrom, filter.yearTo)}`,
      `Цена: ${formatRange(filter.priceFrom, filter.priceTo, "$")}`,
      `Гео: ${formatGeo(filter)}`,
      `Источники: ${formatList(filter.sources.map(sourceLabel))}`,
      `Свежесть: ${freshnessLabel(filter.freshnessMode)}`,
    ].join("\n"),
  );
}

function filterDetailsKeyboard(id: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Вкл/выкл", callback_data: `${CONTROL_PREFIX}filter_toggle:${id}` },
        { text: "Гео", callback_data: `${CONTROL_PREFIX}filter_geo:${id}` },
      ],
      [
        { text: "Вся Украина", callback_data: `${CONTROL_PREFIX}filter_geo_all:${id}` },
        { text: "Все источники", callback_data: `${CONTROL_PREFIX}filter_sources_all:${id}` },
      ],
      [
        { text: "Удалить", callback_data: `${CONTROL_PREFIX}filter_delete:${id}` },
        { text: "К списку", callback_data: `${CONTROL_PREFIX}filters` },
      ],
    ],
  };
}

function cancelKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [[{ text: "Отмена", callback_data: `${CONTROL_PREFIX}filters` }]],
  };
}

export function geoRegionsKeyboard(filterId: string, requestedPage: number): ReplyMarkup {
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(UKRAINE_REGIONS.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const regions = UKRAINE_REGIONS.slice(page * pageSize, (page + 1) * pageSize);
  const rows: ReplyMarkup["inline_keyboard"] = [];
  for (let index = 0; index < regions.length; index += 2) {
    rows.push(
      regions.slice(index, index + 2).map((region) => ({
        text: region.nameRu,
        callback_data: `${CONTROL_PREFIX}grr:${filterId}:${region.id}`,
      })),
    );
  }
  rows.push([
    { text: "Назад", callback_data: `${CONTROL_PREFIX}gr:${filterId}:${Math.max(0, page - 1)}` },
    { text: `${page + 1}/${pages}`, callback_data: `${CONTROL_PREFIX}gr:${filterId}:${page}` },
    { text: "Дальше", callback_data: `${CONTROL_PREFIX}gr:${filterId}:${Math.min(pages - 1, page + 1)}` },
  ]);
  rows.push([
    { text: "Вся Украина", callback_data: `${CONTROL_PREFIX}filter_geo_all:${filterId}` },
    { text: "Ввести название", callback_data: `${CONTROL_PREFIX}gt:${filterId}` },
  ]);
  rows.push([{ text: "К фильтру", callback_data: `${CONTROL_PREFIX}filter_open:${filterId}` }]);
  return { inline_keyboard: rows };
}

export function geoCitiesKeyboard(filterId: string, regionId: string, requestedPage: number): ReplyMarkup {
  const region = getRegionById(regionId);
  const cities = region?.cities ?? [];
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(cities.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const visibleCities = cities.slice(page * pageSize, (page + 1) * pageSize);
  const rows: ReplyMarkup["inline_keyboard"] = [
    [{ text: "Вся область", callback_data: `${CONTROL_PREFIX}gw:${filterId}:${regionId}` }],
  ];
  for (let index = 0; index < visibleCities.length; index += 2) {
    rows.push(
      visibleCities.slice(index, index + 2).map((city) => ({
        text: city.nameRu,
        callback_data: `${CONTROL_PREFIX}g:${filterId}:${city.id}`,
      })),
    );
  }
  rows.push([
    { text: "Назад", callback_data: `${CONTROL_PREFIX}gc:${filterId}:${regionId}:${Math.max(0, page - 1)}` },
    { text: `${page + 1}/${pages}`, callback_data: `${CONTROL_PREFIX}gc:${filterId}:${regionId}:${page}` },
    { text: "Дальше", callback_data: `${CONTROL_PREFIX}gc:${filterId}:${regionId}:${Math.min(pages - 1, page + 1)}` },
  ]);
  rows.push([{ text: "К областям", callback_data: `${CONTROL_PREFIX}gr:${filterId}:0` }]);
  return { inline_keyboard: rows };
}

function newFilterPrompt(): string {
  return [
    "Новый фильтр",
    "Напиши одной строкой:",
    "",
    "BMW X5 2015-2020 10000-35000 Днепр",
    "",
    "Можно проще: Camry до 18000 Киев",
    "Любая марка: до 50000 долларов Днепр",
  ].join("\n");
}

function geoPrompt(filterName: string): string {
  return [
    `Гео для: ${shorten(filterName, 60)}`,
    "Напиши город или область:",
    "",
    "Днепр",
    "Днепропетровская область",
    "вся Украина",
  ].join("\n");
}

async function runFilterTextCommand(text: string): Promise<string | null> {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const onIndex = extractIndexCommand(normalized, ["/filter_on", "/фильтр_вкл"]);
  if (onIndex != null) {
    const filter = await filterByIndex(onIndex);
    if (!filter) return `Фильтр номер ${onIndex} не найден.\n\n${await formatFiltersPanel()}`;
    await prisma.filter.update({ where: { id: filter.id }, data: { enabled: true } });
    return `Фильтр включен: ${filter.name}\n\n${await formatFiltersPanel()}`;
  }

  const offIndex = extractIndexCommand(normalized, ["/filter_off", "/фильтр_выкл"]);
  if (offIndex != null) {
    const filter = await filterByIndex(offIndex);
    if (!filter) return `Фильтр номер ${offIndex} не найден.\n\n${await formatFiltersPanel()}`;
    await prisma.filter.update({ where: { id: filter.id }, data: { enabled: false } });
    return `Фильтр выключен: ${filter.name}\n\n${await formatFiltersPanel()}`;
  }

  const deleteIndex = extractIndexCommand(normalized, ["/filter_delete", "/filter_del", "/фильтр_удалить"]);
  if (deleteIndex != null) {
    const filter = await filterByIndex(deleteIndex);
    if (!filter) return `Фильтр номер ${deleteIndex} не найден.\n\n${await formatFiltersPanel()}`;
    await prisma.filter.delete({ where: { id: filter.id } });
    return `Фильтр удален: ${filter.name}\n\n${await formatFiltersPanel()}`;
  }

  const sourcesMatch = normalized.match(/^\/(?:filter_sources|фильтр_источники)\s+(\d+)\s+(.+)$/u);
  if (sourcesMatch) {
    const index = Number(sourcesMatch[1]);
    const filter = await filterByIndex(index);
    if (!filter) return `Фильтр номер ${index} не найден.\n\n${await formatFiltersPanel()}`;
    const sources = parseSourceList(sourcesMatch[2] ?? "");
    if (sources.length === 0) return `Не понял источники. Пример: /filter_sources ${index} all`;
    const text = await updateFilterSources(filter, sources);
    return `${text}\n\n${await formatFiltersPanel()}`;
  }

  return null;
}

async function toggleFilterById(id: string): Promise<void> {
  const filter = await prisma.filter.findUnique({ where: { id } });
  if (!filter) return;
  await prisma.filter.update({ where: { id }, data: { enabled: !filter.enabled } });
}

async function deleteFilterById(id: string): Promise<boolean> {
  const filter = await prisma.filter.findUnique({ where: { id }, select: { id: true } });
  if (!filter) return false;
  await prisma.filter.delete({ where: { id } });
  return true;
}

async function setFilterGeo(id: string, value: string): Promise<string> {
  const filter = await prisma.filter.findUnique({ where: { id } });
  if (!filter) return "Фильтр не найден.";

  const reset = isAllUkraineGeo(value);
  const geo = reset ? { regions: [], cities: [] } : parseGeoSelection(value);
  if (!reset && geo.regions.length === 0 && geo.cities.length === 0) {
    return "Гео не понял. Напиши город или область: Днепр, Киевская область, Одесса. Для сброса: вся Украина.";
  }

  const updated = await prisma.filter.update({
    where: { id },
    data: {
      regions: geo.regions,
      cities: geo.cities,
    },
  });

  return `Гео обновлено: ${formatGeo(updated)}`;
}

async function setFilterGeoByIds(id: string, regions: string[], cities: string[]): Promise<string> {
  const filter = await prisma.filter.findUnique({ where: { id }, select: { id: true } });
  if (!filter) return "Фильтр не найден.";
  const normalizedRegions = normalizeRegionIds(regions);
  const normalizedCities = normalizeCityIds(cities, normalizedRegions);
  const updated = await prisma.filter.update({
    where: { id },
    data: { regions: normalizedRegions, cities: normalizedCities },
  });
  return `География обновлена: ${formatGeo(updated)}`;
}

function parseGeoSelection(value: string): { regions: string[]; cities: string[] } {
  const geo = extractGeo(value);
  const regions = normalizeRegionIds(geo.regions);
  return {
    regions,
    cities: normalizeCityIds(geo.cities, regions),
  };
}

async function runPendingAction(action: PendingAction, text: string): Promise<string> {
  if (action.type === "create_filter") return createFilterFromTelegram(text);
  return setFilterGeo(action.filterId, text);
}

function setPendingAction(chatId: number | string, action: PendingAction): void {
  pendingActions.set(String(chatId), action);
}

function getPendingAction(chatId: number | string): PendingAction | null {
  const key = String(chatId);
  const action = pendingActions.get(key);
  if (!action) return null;
  if (action.expiresAt < Date.now()) {
    pendingActions.delete(key);
    return null;
  }
  return action;
}

function clearPendingAction(chatId: number | string): void {
  pendingActions.delete(String(chatId));
}

async function setFilterAllSources(id: string): Promise<string> {
  const filter = await prisma.filter.findUnique({ where: { id } });
  if (!filter) return "Фильтр не найден.";
  return updateFilterSources(filter, ["AUTO_RIA", ...REAL_FILTER_SOURCES]);
}

async function updateFilterSources(filter: Filter, requestedSources: ListingSource[]): Promise<string> {
  let nextSources = uniqueSources(requestedSources);
  let autoRiaMarkId = filter.autoRiaMarkId;
  let autoRiaModelId = filter.autoRiaModelId;

  if (nextSources.includes("AUTO_RIA")) {
    if (!env.AUTO_RIA_API_KEY) {
      nextSources = nextSources.filter((source) => source !== "AUTO_RIA");
    } else if (!autoRiaMarkId) {
      const taxonomy = await resolveAutoRiaIds(filter.brand, filter.model);
      autoRiaMarkId = taxonomy.autoRiaMarkId;
      autoRiaModelId = taxonomy.autoRiaModelId;
      if (!autoRiaMarkId) nextSources = nextSources.filter((source) => source !== "AUTO_RIA");
    }
  }

  await prisma.filter.update({
    where: { id: filter.id },
    data: {
      sources: nextSources,
      autoRiaCategoryId: nextSources.includes("AUTO_RIA") ? filter.autoRiaCategoryId ?? 1 : filter.autoRiaCategoryId,
      autoRiaMarkId,
      autoRiaModelId,
    },
  });

  if (requestedSources.includes("AUTO_RIA") && !nextSources.includes("AUTO_RIA")) {
    return `Источники обновлены для "${filter.name}", но AUTO.RIA пропущен: нужна точно распознанная марка.`;
  }
  return `Источники обновлены для "${filter.name}": ${formatList(nextSources.map(sourceLabel))}`;
}

async function addAutoRiaToCompatibleFilters(): Promise<string> {
  if (!env.AUTO_RIA_API_KEY) return "AUTO.RIA API ключ не настроен.";

  const filters = await prisma.filter.findMany({ where: { enabled: true }, orderBy: { createdAt: "desc" } });
  let updated = 0;
  let skipped = 0;

  for (const filter of filters) {
    if (filter.sources.includes("AUTO_RIA") && filter.autoRiaMarkId) continue;
    const taxonomy = filter.autoRiaMarkId
      ? { autoRiaMarkId: filter.autoRiaMarkId, autoRiaModelId: filter.autoRiaModelId }
      : await resolveAutoRiaIds(filter.brand, filter.model);

    if (!taxonomy.autoRiaMarkId) {
      skipped++;
      continue;
    }

    await prisma.filter.update({
      where: { id: filter.id },
      data: {
        sources: uniqueSources(["AUTO_RIA", ...filter.sources]),
        autoRiaCategoryId: filter.autoRiaCategoryId ?? 1,
        autoRiaMarkId: taxonomy.autoRiaMarkId,
        autoRiaModelId: taxonomy.autoRiaModelId,
      },
    });
    updated++;
  }

  return `AUTO.RIA добавлен в совместимые фильтры: ${updated}. Пропущено без точной марки: ${skipped}.`;
}

async function resolveAutoRiaIds(
  brand: string | null,
  model: string | null,
): Promise<{ autoRiaMarkId: number | null; autoRiaModelId: number | null }> {
  if (!env.AUTO_RIA_API_KEY || !brand) return { autoRiaMarkId: null, autoRiaModelId: null };

  const marks = await getMarks(1);
  const mark = bestTaxonomyMatch(marks.options, brand);
  if (!mark) return { autoRiaMarkId: null, autoRiaModelId: null };

  if (!model) return { autoRiaMarkId: mark.value, autoRiaModelId: null };
  const models = await getModels(1, mark.value);
  const modelMatch = bestTaxonomyMatch(models.options, model);

  return { autoRiaMarkId: mark.value, autoRiaModelId: modelMatch?.value ?? null };
}

function bestTaxonomyMatch(options: TaxonomyOption[], value: string): TaxonomyOption | undefined {
  const expected = compactVehicleText(value);
  return options.find((option) => compactVehicleText(option.name) === expected) ?? options.find((option) => compactVehicleText(option.name).includes(expected));
}

function compactVehicleText(value: string): string {
  return normalizeVehicleText(value).replace(/\s+/gu, "");
}

async function filterByIndex(index: number): Promise<Filter | null> {
  if (!Number.isInteger(index) || index < 1) return null;
  const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" }, skip: index - 1, take: 1 });
  return filters[0] ?? null;
}

function defaultSourcesForFilter(autoRiaReady: boolean): ListingSource[] {
  return uniqueSources([...(autoRiaReady && env.AUTO_RIA_API_KEY ? (["AUTO_RIA"] as ListingSource[]) : []), ...REAL_FILTER_SOURCES]);
}

function parseSourceList(value: string): ListingSource[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "все") return ["AUTO_RIA", ...REAL_FILTER_SOURCES];
  const map: Record<string, ListingSource> = {
    auto: "AUTO_RIA",
    autoria: "AUTO_RIA",
    auto_ria: "AUTO_RIA",
    "auto.ria": "AUTO_RIA",
    ria: "AUTO_RIA",
    olx: "OLX",
    rst: "RST",
    cars: "CARS_UA",
    carsua: "CARS_UA",
    cars_ua: "CARS_UA",
    automoto: "AUTOMOTO",
    auto_moto: "AUTOMOTO",
    риа: "AUTO_RIA",
  };
  return uniqueSources(
    normalized
      .split(/[,\s|]+/u)
      .map((item) => map[item])
      .filter((source): source is ListingSource => Boolean(source)),
  );
}

function uniqueSources(sources: ListingSource[]): ListingSource[] {
  return [...new Set(sources.filter((source) => source !== "MOCK"))];
}

function sendPanel(text: string): Promise<void> {
  return sendMessage(text, PANEL_KEYBOARD);
}

async function sendFiltersPanel(text: string): Promise<void> {
  await sendMessage(text, await filtersKeyboard());
}

async function sendMessage(text: string, replyMarkup: ReplyMarkup): Promise<void> {
  await telegramApi<unknown>("sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: trimTelegramMessage(text),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function editMessage(chatId: number | string, messageId: number, text: string, replyMarkup: ReplyMarkup): Promise<void> {
  await telegramApi<unknown>("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: trimTelegramMessage(text),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  await telegramApi<unknown>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => undefined);
}

async function telegramApi<T>(method: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  currentAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (!response.ok || !body?.ok) {
      const description = body && "description" in body ? body.description : undefined;
      throw new Error(description || `Telegram API ${method} failed with HTTP ${response.status}`);
    }
    return body.result;
  } finally {
    clearTimeout(timeout);
    if (currentAbortController === controller) currentAbortController = null;
  }
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

function isAllUkraineGeo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["вся украина", "вся україна", "украина", "україна", "all", "all ukraine", "везде"].includes(normalized);
}

function extractIndexCommand(text: string, commands: string[]): number | null {
  for (const command of commands) {
    const match = text.match(new RegExp(`^${escapeRegex(command)}\\s+(\\d+)`, "u"));
    if (match) return Number(match[1]);
  }
  return null;
}

function isAllowedChat(chatId: number | string): boolean {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

function trimTelegramMessage(text: string): string {
  return text.length <= 3900 ? text : `${text.slice(0, 3890)}\n...`;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

function formatRange(from: number | null, to: number | null, prefix = ""): string {
  if (from == null && to == null) return "любой";
  if (from != null && to != null && from === to) return `${prefix}${from}`;
  if (from != null && to != null) return `${prefix}${from}-${prefix}${to}`;
  if (from != null) return `от ${prefix}${from}`;
  return `до ${prefix}${to}`;
}

function formatGeo(filter: Pick<Filter, "regions" | "cities">): string {
  const cityNames = filter.cities.map((id) => getCityById(id)?.nameRu ?? id);
  const regionNames = filter.regions.map((id) => getRegionById(id)?.nameRu ?? id);
  const values = [...cityNames, ...regionNames];
  return values.length > 0 ? values.join(", ") : "вся Украина";
}

function sourceLabel(source: string): string {
  switch (source) {
    case "AUTO_RIA":
      return "AUTO.RIA";
    case "OLX":
      return "OLX";
    case "RST":
      return "RST";
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

function monitoringStatusLabel(status: string): string {
  switch (status) {
    case "RUNNING":
      return "работает";
    case "STOPPED":
      return "остановлен";
    case "STARTING":
      return "запускается";
    case "PAUSED":
      return "пауза";
    case "ERROR":
      return "ошибка";
    case "RATE_LIMITED":
      return "лимит";
    case "CAPTCHA_DETECTED":
      return "капча";
    default:
      return status.toLowerCase();
  }
}

function monitoringModeLabel(mode: string): string {
  return mode === "LIVE" ? "боевой" : "обычный";
}

function freshnessLabel(value: string): string {
  switch (value) {
    case "LAST_HOUR":
      return "последний час";
    case "TODAY":
      return "сегодня";
    case "LAST_24_HOURS":
      return "24 часа";
    case "ALL_TIME":
      return "все время";
    default:
      return value.toLowerCase();
  }
}

function translateApiError(value: string): string {
  if (value === "Manual source check is disabled while monitoring is stopped") {
    return "Ручной скан запрещен, пока мониторинг остановлен.";
  }
  return value;
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
