import type { SourceKind } from "@/lib/types"

export const SOURCE_LABELS: Record<SourceKind, string> = {
  AUTO_RIA: "AUTO.RIA",
  OLX: "OLX",
  RST: "RST",
  CARS_UA: "Cars.ua",
  AUTOMOTO: "AutoMoto",
  MOCK: "Mock",
}

export function sourceLabel(source: SourceKind | string): string {
  return SOURCE_LABELS[source as SourceKind] ?? source
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(new Date(value))
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "—"
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return "—"
  const diff = Math.max(0, now - then)
  const sec = Math.round(diff / 1000)
  if (sec < 10) return "только что"
  if (sec < 60) return `${sec} с назад`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} мин назад`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} ч назад`
  const days = Math.round(hours / 24)
  return `${days} дн назад`
}

export function formatPrice(value: number | null | undefined, currency: string | null | undefined = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "Цена не указана"
  const symbol = currency === "USD" ? "$" : currency === "UAH" ? "₴" : ""
  const formatted = new Intl.NumberFormat("ru-RU").format(Math.round(value))
  return currency === "USD" ? `${symbol}${formatted}` : `${formatted}${symbol ? ` ${symbol}` : ""}`
}

export function formatMileage(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value >= 1000) return `${new Intl.NumberFormat("ru-RU").format(Math.round(value / 1000))} тыс. км`
  return `${value} км`
}

export function formatMs(value: number | null | undefined): string {
  if (value == null) return "н/д"
  if (value < 1000) return `${Math.round(value)} мс`
  if (value < 60_000) return `${(Math.round(value / 100) / 10).toFixed(1)} с`
  return `${(Math.round(value / 6000) / 10).toFixed(1)} мин`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—"
  if (seconds < 60) return `${Math.round(seconds)} с`
  const min = Math.floor(seconds / 60)
  const sec = Math.round(seconds % 60)
  return sec ? `${min} мин ${sec} с` : `${min} мин`
}
