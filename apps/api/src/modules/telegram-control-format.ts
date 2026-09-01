import type { Filter } from "@amb/db";
import { getCityById, getRegionById } from "@amb/shared";

export function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

export function formatRange(from: number | null, to: number | null, prefix = ""): string {
  if (from == null && to == null) return "любой";
  if (from != null && to != null && from === to) return `${prefix}${from}`;
  if (from != null && to != null) return `${prefix}${from}-${prefix}${to}`;
  if (from != null) return `от ${prefix}${from}`;
  return `до ${prefix}${to}`;
}

export function formatGeo(filter: Pick<Filter, "regions" | "cities">): string {
  const cityNames = filter.cities.map((id) => getCityById(id)?.nameRu ?? id);
  const regionNames = filter.regions.map((id) => getRegionById(id)?.nameRu ?? id);
  const values = [...cityNames, ...regionNames];
  return values.length > 0 ? values.join(", ") : "вся Украина";
}

export function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    AUTO_RIA: "AUTO.RIA",
    OLX: "OLX",
    RST: "RST",
    CARS_UA: "Cars.ua",
    AUTOMOTO: "AutoMoto.ua",
    MOCK: "Тестовый",
  };
  return labels[source] ?? source;
}

export function formatSourceHealthLine(
  source: {
    source: string;
    status: string;
    lastSuccessfulAt: Date | null;
    pausedUntil: Date | null;
  },
  now = new Date(),
): string {
  const icon = source.status === "ACTIVE"
    ? "✅"
    : source.status === "ERROR"
      ? "❌"
      : ["RATE_LIMITED", "CAPTCHA_DETECTED"].includes(source.status)
        ? "⛔"
        : "⚠️";
  const details = [sourceStatusLabel(source.status)];
  if (source.lastSuccessfulAt) {
    details.push(`успех ${relativeAge(now.getTime() - source.lastSuccessfulAt.getTime())} назад`);
  } else {
    details.push("успешных проверок нет");
  }
  if (source.pausedUntil && source.pausedUntil > now) {
    details.push(`повтор ${formatKyivShort(source.pausedUntil)}`);
  }
  return `${icon} ${sourceLabel(source.source)} — ${details.join(", ")}`;
}

function sourceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "работает",
    LIMITED: "ограничен",
    RATE_LIMITED: "HTTP-ограничение",
    CAPTCHA_DETECTED: "защитная страница",
    ERROR: "ошибка",
    PAUSED: "пауза",
    DISABLED: "выключен",
  };
  return labels[status] ?? status.toLowerCase();
}

function relativeAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч.`;
  return `${Math.floor(hours / 24)} дн.`;
}

function formatKyivShort(value: Date): string {
  return new Intl.DateTimeFormat("ru-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value).replace(",", "");
}

export function monitoringStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    RUNNING: "работает",
    STOPPED: "остановлен",
    STARTING: "запускается",
    PAUSED: "пауза",
    ERROR: "ошибка",
    RATE_LIMITED: "лимит",
    CAPTCHA_DETECTED: "капча",
  };
  return labels[status] ?? status.toLowerCase();
}

export function monitoringModeLabel(mode: string): string {
  return mode === "LIVE" ? "боевой" : "обычный";
}

export function freshnessLabel(value: string): string {
  const labels: Record<string, string> = {
    LAST_HOUR: "последний час",
    TODAY: "сегодня",
    LAST_24_HOURS: "24 часа",
    ALL_TIME: "все время",
  };
  return labels[value] ?? value.toLowerCase();
}

export function translateApiError(value: string): string {
  return value === "Manual source check is disabled while monitoring is stopped"
    ? "Ручной скан запрещен, пока мониторинг остановлен."
    : value;
}

export function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
