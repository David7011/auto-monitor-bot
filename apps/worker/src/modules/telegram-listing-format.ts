import { categoryProfile, marketplaceCategoryKey, validateCategoryAttributes, type ListingDiscoveryLane } from "@amb/shared";

const TELEGRAM_MESSAGE_LIMIT = 3900;
const TELEGRAM_CAPTION_LIMIT = 1000;
const TELEGRAM_ALBUM_LIMIT = 10;

export type TelegramListingSnapshot = {
  id: string;
  source: string;
  categoryKey?: string;
  categorySchemaVersion?: number;
  categoryAttributes?: unknown;
  notificationMode?: string;
  provisionalReasons?: string[];
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
  sellerPhone?: string | null;
  photoUrls?: string[] | null;
  matches?: Array<{ filter: { name: string } }>;
  rawData: unknown;
};

export function initialMessageText(listing: TelegramListingSnapshot): string {
  if (marketplaceCategoryKey(listing.categoryKey) !== "vehicle.car") {
    return categoryMessageText(listing);
  }
  return clampTelegramText([...carCardLines(listing), "", `Ссылка: ${listing.url}`]);
}

export function enrichedMessageText(listing: TelegramListingSnapshot): string {
  if (marketplaceCategoryKey(listing.categoryKey) !== "vehicle.car") {
    return categoryMessageText(listing);
  }
  return clampTelegramText([...carCardLines(listing), "", `Ссылка: ${listing.url}`]);
}

function categoryMessageText(listing: TelegramListingSnapshot): string {
  const categoryKey = marketplaceCategoryKey(listing.categoryKey);
  const profile = categoryProfile(categoryKey);
  const attributes = validateCategoryAttributes(categoryKey, listing.categoryAttributes).attributes;
  const title = listing.title ?? ([listing.brand, listing.model].filter(Boolean).join(" ") || profile.label);
  const attributeLines = categoryAttributeLines(attributes);
  return clampTelegramText([
    listing.discoveryLane === "REALTIME" ? `🔥 НОВОЕ — ${profile.telegramLabel} 🔥` : messageHeading(listing),
    ...(listing.provisionalReasons?.length ? ["⚠️ Возможно подходит: часть характеристик ещё не подтверждена.",
      ...listing.provisionalReasons.slice(0, 3).map((reason) => `Уточнить: ${reason}`)] : []),
    "",
    `Источник: ${sourceLabel(listing.source)}`,
    `${profile.label}: ${title}`,
    `Цена: ${formatCategoryPrice(listing)}`,
    `Место: ${[listing.city, listing.region].filter(Boolean).join(", ") || "-"}`,
    ...attributeLines,
    ...sellerPhoneLines(listing),
    "",
    `Ссылка: ${listing.url}`,
  ]);
}

function categoryAttributeLines(attributes: Record<string, string | number | string[]>): string[] {
  const labels: Record<string, string> = {
    cpu: "CPU", gpu: "GPU", ramGb: "RAM", storageGb: "Накопитель", storageType: "Тип накопителя",
    screenInches: "Экран", refreshRateHz: "Частота", batteryHealthPercent: "Батарея", model: "Модель",
    vramGb: "VRAM", platform: "Платформа", powerW: "Мощность", batteryWh: "Батарея",
    rangeKm: "Запас хода", mileageKm: "Пробег", riskKeywords: "Риски", accessories: "Комплект",
  };
  const units: Record<string, string> = {
    ramGb: " ГБ", storageGb: " ГБ", screenInches: "\"", refreshRateHz: " Гц",
    batteryHealthPercent: "%", vramGb: " ГБ", powerW: " Вт", batteryWh: " Вт·ч",
    rangeKm: " км", mileageKm: " км",
  };
  return Object.entries(attributes)
    .filter(([key]) => key !== "brand")
    .slice(0, 8)
    .map(([key, value]) => `${labels[key] ?? key}: ${Array.isArray(value) ? value.join(", ") : value}${units[key] ?? ""}`);
}

function formatCategoryPrice(listing: TelegramListingSnapshot): string {
  if (listing.priceOriginal != null) return `${listing.priceOriginal} ${listing.currencyOriginal ?? ""}`.trim();
  return formatPrice(listing);
}

function carCardLines(listing: TelegramListingSnapshot): string[] {
  const title = listing.title ?? ([listing.brand, listing.model, listing.year].filter(Boolean).join(" ") || "Авто без названия");
  const specs = [
    listing.engineVolume != null ? `${listing.engineVolume} л` : null,
    vehicleAttributeLabel(listing.fuelType),
    vehicleAttributeLabel(listing.gearbox),
    vehicleAttributeLabel(listing.driveType),
    vehicleAttributeLabel(listing.bodyType),
  ].filter(Boolean);
  return [
    messageHeading(listing),
    "",
    `Источник: ${sourceLabel(listing.source)}`,
    `Автомобиль: ${title}`,
    `Цена: ${formatPrice(listing)}`,
    `Год/пробег: ${listing.year ?? "-"} / ${listing.mileage != null ? `${listing.mileage} км` : "-"}`,
    ...(specs.length ? [`Характеристики: ${specs.join(" / ")}`] : []),
    `Место: ${[listing.city, listing.region].filter(Boolean).join(", ") || "-"}`,
    ...sellerPhoneLines(listing),
  ];
}

export function sellerPhoneList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((phone) => phone.trim()).filter(Boolean).slice(0, 3);
}

function sellerPhoneLines(listing: Pick<TelegramListingSnapshot, "sellerPhone">): string[] {
  const phones = sellerPhoneList(listing.sellerPhone);
  return phones.length > 0 ? [`Телефон: ${phones.join(", ")}`] : [];
}

function messageHeading(listing: TelegramListingSnapshot): string {
  if (listing.discoveryLane === "BACKFILL") return "НАЙДЕНО ПРИ ФОНОВОЙ СВЕРКЕ";
  if (listing.discoveryLane === "COVERAGE") return "НАЙДЕНО ПРИ СВЕРКЕ ИСТОЧНИКА";
  if (listing.discoveryLane === "MANUAL") return "НАЙДЕНО ПРИ РУЧНОЙ ПРОВЕРКЕ";
  return "🔥 НОВОЕ ОБЪЯВЛЕНИЕ 🔥";
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

function formatPrice(listing: TelegramListingSnapshot): string {
  if (listing.priceNormalized != null) return `${listing.priceNormalized} $`;
  if (listing.priceOriginal != null) return `${listing.priceOriginal} ${listing.currencyOriginal ?? ""}`.trim();
  return "-";
}

export function clampTelegramText(lines: string[]): string {
  const text = lines.join("\n");
  return text.length <= TELEGRAM_MESSAGE_LIMIT ? text : `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 20)}\n...обрезано`;
}

export function clampTelegramCaption(value: string): string {
  return value.length <= TELEGRAM_CAPTION_LIMIT ? value : `${value.slice(0, TELEGRAM_CAPTION_LIMIT - 20)}\n...обрезано`;
}

export type TelegramSendKind = "TEXT" | "PHOTO" | "ALBUM";

/** Public http(s) photo URLs only; Telegram cannot fetch anything else. */
export function sendablePhotoUrls(value: readonly string[] | string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((url): url is string => typeof url === "string" && /^https:\/\//iu.test(url));
}

export function describeTelegramSend(
  photoUrls: readonly string[] | string[] | null | undefined,
): { kind: TelegramSendKind; photos: string[] } {
  const photos = sendablePhotoUrls(photoUrls).slice(0, TELEGRAM_ALBUM_LIMIT);
  if (photos.length >= 2) return { kind: "ALBUM", photos };
  if (photos.length === 1) return { kind: "PHOTO", photos };
  return { kind: "TEXT", photos: [] };
}

/**
 * Album messages store all ids comma-joined in the single messageId column:
 * "123,124,125". Caption and tombstone edits target the primary (first) id,
 * cleanup deletes every id. Favorite callbacks can only originate from
 * keyboard messages, which always carry a single id.
 */
export function splitTelegramMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((id) => id.trim()).filter((id) => /^\d+$/u.test(id));
}

export function primaryTelegramMessageId(value: string | null | undefined): string | null {
  return splitTelegramMessageIds(value)[0] ?? null;
}

export function isTelegramAlbumMessage(value: string | null | undefined): boolean {
  return splitTelegramMessageIds(value).length > 1;
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
