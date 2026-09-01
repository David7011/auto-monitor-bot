import type { MarketPriceEstimate, VehicleCheck } from "@amb/db";
import type { ListingDiscoveryLane } from "@amb/shared";

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
  discoveryLane: ListingDiscoveryLane;
  vin: string | null;
  plateNormalized: string | null;
  matches?: Array<{ filter: { name: string } }>;
  rawData: unknown;
};

export function initialMessageText(listing: TelegramListingSnapshot): string {
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

export function enrichedMessageText(
  listing: TelegramListingSnapshot,
  check: VehicleCheck | null,
  market: MarketPriceEstimate | null,
): string {
  const lines = [
    messageHeading(listing),
    "",
    ...listingSummaryLines(listing),
    ...marketPriceLines(market),
    ...vehicleCheckLines(check),
  ];
  lines.push("", `Ссылка: ${listing.url}`);
  return clampTelegramText(lines);
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

function messageHeading(listing: TelegramListingSnapshot): string {
  if (listing.discoveryLane === "BACKFILL") return "НАЙДЕНО ПРИ ФОНОВОЙ СВЕРКЕ";
  if (listing.discoveryLane === "COVERAGE") return "НАЙДЕНО ПРИ СВЕРКЕ ИСТОЧНИКА";
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
    case "HIGH_RISK_BARGAIN": return "очень дешево, проверять жестко";
    case "BELOW_MARKET": return "ниже рынка";
    case "FAIR": return "рыночная цена";
    case "ABOVE_MARKET": return "выше рынка";
    default: return "недостаточно данных";
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

export function clampTelegramText(lines: string[]): string {
  const text = lines.join("\n");
  return text.length <= TELEGRAM_MESSAGE_LIMIT ? text : `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 20)}\n...обрезано`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "AUTO_RIA": return "AUTO.RIA";
    case "CARS_UA": return "Cars.ua";
    case "AUTOMOTO": return "AutoMoto.ua";
    case "MOCK": return "Тестовый";
    default: return source;
  }
}

function vehicleStatusLabel(status: VehicleCheck["checkStatus"]): string {
  switch (status) {
    case "NOT_STARTED": return "не начата";
    case "PENDING": return "выполняется";
    case "NO_PLATE_OR_VIN_FOUND": return "номер и VIN не найдены";
    case "PLATE_FOUND": return "найден номер";
    case "VIN_FOUND": return "найден VIN";
    case "CHECK_DONE": return "готова";
    case "CHECK_PARTIAL": return "частично готова";
    case "CHECK_FAILED": return "ошибка проверки";
    default: return status;
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
