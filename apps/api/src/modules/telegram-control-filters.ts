import {
  prisma,
  type Filter,
  type ListingSource,
} from "@amb/db";
import {
  findExactActiveFilter,
  getRegionById,
  normalizeCityIds,
  normalizeRegionIds,
  normalizeVehicleText,
  UKRAINE_REGIONS,
  type FilterHygieneCandidate,
} from "@amb/shared";
import { env } from "../env.js";
import { compactFilterSearchStates } from "./filter-state-hygiene.js";
import {
  formatGeo,
  formatList,
  formatRange,
  freshnessLabel,
  shorten,
  sourceLabel,
} from "./telegram-control-format.js";
import { extractGeo, parseQuickFilter } from "./telegram-filter-parser.js";
import { getMarks, getModels, type TaxonomyOption } from "./vehicle-taxonomy.js";

export type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>>;
};

export type PendingAction =
  | { type: "create_filter"; expiresAt: number }
  | { type: "set_geo"; filterId: string; expiresAt: number };

const CONTROL_PREFIX = "amb:";
const FILTER_LIST_LIMIT = 8;
const REAL_FILTER_SOURCES: ListingSource[] = ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"];
const pendingActions = new Map<string, PendingAction>();

export async function formatFiltersPanel(): Promise<string> {
  const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" }, take: FILTER_LIST_LIMIT });
  const total = await prisma.filter.count();
  const active = filters.filter((filter) => filter.enabled).length;

  if (total === 0) {
    return "Фильтров пока нет.\nНажми «Новый» и напиши одной строкой: BMW X5 2015-2020 10000-35000 Днепр";
  }

  return trimTelegramMessage([
    `Фильтры: ${active}/${total} активных`,
    "",
    ...filters.map((filter, index) => filterSummaryLine(filter, index + 1)),
    total > filters.length ? `\nПоказано первые ${filters.length}. Остальные есть на сайте.` : "",
  ].join("\n"));
}

export async function filtersKeyboard(): Promise<ReplyMarkup> {
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

export async function createFilterFromTelegram(text: string): Promise<string> {
  const parsed = parseQuickFilter(text);
  if (!parsed.cleanQuery) return newFilterPrompt();

  const taxonomy = await resolveAutoRiaIds(parsed.brand, parsed.model);
  const sources = defaultSourcesForFilter(Boolean(taxonomy.autoRiaMarkId));
  const displayVehicle = [parsed.brand, parsed.model].filter(Boolean).join(" ")
    || parsed.vehicleQuery
    || "Любое авто";

  const createData = {
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
    freshnessMode: "LAST_HOUR" as const,
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
  };
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auto-monitor-bot:filter-mutation'))`;
    const activeFilters = await tx.filter.findMany({ where: { enabled: true } });
    const duplicate = findExactActiveFilter(
      { id: "__telegram_filter__", ...createData } as FilterHygieneCandidate,
      activeFilters,
    );
    if (duplicate) return { duplicate, filter: null };
    const filter = await tx.filter.create({ data: createData });
    return { duplicate: null, filter };
  });

  if (result.duplicate) {
    return `Такой активный фильтр уже существует: «${result.duplicate.name}». Новый дубль не создан.`;
  }
  const filter = result.filter;
  if (!filter) return "Не удалось создать фильтр.";
  await compactFilterSearchStates();

  const autoRiaLine = taxonomy.autoRiaMarkId
    ? `AUTO.RIA подключен: марка ${taxonomy.autoRiaMarkId}${taxonomy.autoRiaModelId ? `, модель ${taxonomy.autoRiaModelId}` : ""}.`
    : env.AUTO_RIA_API_KEY
      ? "AUTO.RIA не добавлен: не удалось точно распознать марку в справочнике."
      : "AUTO.RIA не добавлен: API ключ не настроен.";

  return trimTelegramMessage([
    "Фильтр создан.",
    `Авто: ${[filter.brand, filter.model].filter(Boolean).join(" ") || "по ключевым словам"}`,
    `Годы: ${formatRange(filter.yearFrom, filter.yearTo)}`,
    `Цена: ${formatRange(filter.priceFrom, filter.priceTo, "$")}`,
    `Гео: ${formatGeo(filter)}`,
    `Источники: ${formatList(filter.sources.map(sourceLabel))}`,
    autoRiaLine,
  ].join("\n"));
}

export async function formatFilterDetails(id: string): Promise<string | null> {
  const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" }, take: FILTER_LIST_LIMIT });
  const filter = filters.find((item) => item.id === id) ?? (await prisma.filter.findUnique({ where: { id } }));
  if (!filter) return null;
  const index = filters.findIndex((item) => item.id === filter.id);
  const vehicle = [filter.brand, filter.model].filter(Boolean).join(" ") || "любое авто";

  return trimTelegramMessage([
    `Фильтр${index >= 0 ? ` ${index + 1}` : ""}: ${filter.enabled ? "включен" : "выключен"}`,
    `Авто: ${vehicle}`,
    `Годы: ${formatRange(filter.yearFrom, filter.yearTo)}`,
    `Цена: ${formatRange(filter.priceFrom, filter.priceTo, "$")}`,
    `Гео: ${formatGeo(filter)}`,
    `Источники: ${formatList(filter.sources.map(sourceLabel))}`,
    `Свежесть: ${freshnessLabel(filter.freshnessMode)}`,
  ].join("\n"));
}

export function filterDetailsKeyboard(id: string): ReplyMarkup {
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

export function cancelKeyboard(): ReplyMarkup {
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

export function newFilterPrompt(): string {
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

export function geoPrompt(filterName: string): string {
  return [
    `Гео для: ${shorten(filterName, 60)}`,
    "Напиши город или область:",
    "",
    "Днепр",
    "Днепропетровская область",
    "вся Украина",
  ].join("\n");
}

export async function runFilterTextCommand(text: string): Promise<string | null> {
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

  const deleteIndex = extractIndexCommand(normalized, [
    "/filter_delete",
    "/filter_del",
    "/фильтр_удалить",
  ]);
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
    const result = await updateFilterSources(filter, sources);
    return `${result}\n\n${await formatFiltersPanel()}`;
  }
  return null;
}

export async function toggleFilterById(id: string): Promise<void> {
  const filter = await prisma.filter.findUnique({ where: { id } });
  if (!filter) return;
  await prisma.filter.update({ where: { id }, data: { enabled: !filter.enabled } });
}

export async function deleteFilterById(id: string): Promise<boolean> {
  const filter = await prisma.filter.findUnique({ where: { id }, select: { id: true } });
  if (!filter) return false;
  await prisma.filter.delete({ where: { id } });
  return true;
}

export async function setFilterGeoByIds(
  id: string,
  regions: string[],
  cities: string[],
): Promise<string> {
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

export async function runPendingAction(action: PendingAction, text: string): Promise<string> {
  if (action.type === "create_filter") return createFilterFromTelegram(text);
  return setFilterGeo(action.filterId, text);
}

export function setPendingAction(chatId: number | string, action: PendingAction): void {
  pendingActions.set(String(chatId), action);
}

export function getPendingAction(chatId: number | string): PendingAction | null {
  const key = String(chatId);
  const action = pendingActions.get(key);
  if (!action) return null;
  if (action.expiresAt < Date.now()) {
    pendingActions.delete(key);
    return null;
  }
  return action;
}

export function clearPendingAction(chatId: number | string): void {
  pendingActions.delete(String(chatId));
}

export async function setFilterAllSources(id: string): Promise<string> {
  const filter = await prisma.filter.findUnique({ where: { id } });
  if (!filter) return "Фильтр не найден.";
  return updateFilterSources(filter, ["AUTO_RIA", ...REAL_FILTER_SOURCES]);
}

export async function addAutoRiaToCompatibleFilters(): Promise<string> {
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

function filterSummaryLine(filter: Filter, index: number): string {
  const vehicle = [filter.brand, filter.model].filter(Boolean).join(" ") || "любое авто";
  return `${index}. ${filter.enabled ? "вкл" : "выкл"} | ${vehicle} | ${formatRange(filter.yearFrom, filter.yearTo)} | ${formatRange(filter.priceFrom, filter.priceTo, "$")} | ${formatGeo(filter)}`;
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
    data: { regions: geo.regions, cities: geo.cities },
  });
  return `Гео обновлено: ${formatGeo(updated)}`;
}

function parseGeoSelection(value: string): { regions: string[]; cities: string[] } {
  const geo = extractGeo(value);
  const regions = normalizeRegionIds(geo.regions);
  return { regions, cities: normalizeCityIds(geo.cities, regions) };
}

async function updateFilterSources(
  filter: Filter,
  requestedSources: ListingSource[],
): Promise<string> {
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
      autoRiaCategoryId: nextSources.includes("AUTO_RIA")
        ? filter.autoRiaCategoryId ?? 1
        : filter.autoRiaCategoryId,
      autoRiaMarkId,
      autoRiaModelId,
    },
  });
  if (requestedSources.includes("AUTO_RIA") && !nextSources.includes("AUTO_RIA")) {
    return `Источники обновлены для "${filter.name}", но AUTO.RIA пропущен: нужна точно распознанная марка.`;
  }
  return `Источники обновлены для "${filter.name}": ${formatList(nextSources.map(sourceLabel))}`;
}

async function resolveAutoRiaIds(
  brand: string | null,
  model: string | null,
): Promise<{ autoRiaMarkId: number | null; autoRiaModelId: number | null }> {
  if (!env.AUTO_RIA_API_KEY || !brand) {
    return { autoRiaMarkId: null, autoRiaModelId: null };
  }
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
  return options.find((option) => compactVehicleText(option.name) === expected)
    ?? options.find((option) => compactVehicleText(option.name).includes(expected));
}

function compactVehicleText(value: string): string {
  return normalizeVehicleText(value).replace(/\s+/gu, "");
}

async function filterByIndex(index: number): Promise<Filter | null> {
  if (!Number.isInteger(index) || index < 1) return null;
  const filters = await prisma.filter.findMany({
    orderBy: { createdAt: "desc" },
    skip: index - 1,
    take: 1,
  });
  return filters[0] ?? null;
}

function defaultSourcesForFilter(autoRiaReady: boolean): ListingSource[] {
  return uniqueSources([
    ...(autoRiaReady && env.AUTO_RIA_API_KEY ? (["AUTO_RIA"] as ListingSource[]) : []),
    ...REAL_FILTER_SOURCES,
  ]);
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

function extractIndexCommand(text: string, commands: string[]): number | null {
  for (const command of commands) {
    const match = text.match(new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`, "u"));
    if (match) return Number(match[1]);
  }
  return null;
}

function isAllUkraineGeo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["вся украина", "вся україна", "украина", "україна", "all"].includes(normalized);
}

function trimTelegramMessage(text: string): string {
  return text.length <= 3900 ? text : `${text.slice(0, 3890)}…`;
}
