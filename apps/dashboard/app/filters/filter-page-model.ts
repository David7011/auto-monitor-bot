import type { FilterHygieneWarning, FilterRow, SourceKind } from "@/lib/types"
import type { RegionOption } from "./filter-page-components"

export type TaxonomyOption = {
  name: string
  value: number
}

export type TaxonomyResponse = {
  options: TaxonomyOption[]
  complete: boolean
  apiConfigured: boolean
  source: "AUTO_RIA_API" | "LOCAL_FALLBACK"
  categoryId: number
  markId?: number
}

export type AttributeOption = {
  value: string
  label: string
  aliases: string[]
}

export type AttributeGroupsResponse = {
  groups: {
    bodyTypes: AttributeOption[]
    fuelTypes: AttributeOption[]
    gearboxes: AttributeOption[]
    driveTypes: AttributeOption[]
  }
}

export type RegionsResponse = {
  regions: RegionOption[]
  dataVersion: string
  cityCount: number
}

export type FiltersResponse = {
  filters: FilterRow[]
  hygiene?: { warnings: FilterHygieneWarning[] }
}

export type FreshnessMode =
  | "LAST_HOUR"
  | "TODAY"
  | "LAST_24_HOURS"
  | "LAST_3_DAYS"
  | "LAST_7_DAYS"
  | "ALL_TIME"

export const FILTER_SOURCES: SourceKind[] = ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"]

export const SOURCE_LABELS: Record<SourceKind, string> = {
  AUTO_RIA: "AUTO.RIA",
  OLX: "OLX",
  RST: "RST",
  CARS_UA: "Cars.ua",
  AUTOMOTO: "AutoMoto.ua",
  MOCK: "Mock",
}

export const FRESHNESS_MODES: Array<{ value: FreshnessMode; label: string }> = [
  { value: "LAST_HOUR", label: "LIVE: последний час" },
  { value: "TODAY", label: "Только сегодня" },
  { value: "LAST_24_HOURS", label: "Последние 24 часа" },
  { value: "LAST_3_DAYS", label: "Последние 3 дня" },
  { value: "LAST_7_DAYS", label: "Последние 7 дней" },
  { value: "ALL_TIME", label: "Все время" },
]

export const VEHICLE_CATEGORY_ID = 1

export function toList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function numberOrNull(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function booleanOrNull(value: string) {
  if (value === "true") return true
  if (value === "false") return false
  return null
}

export function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

export function labelsFor(values: string[], options: AttributeOption[] = []) {
  if (values.length === 0) return "не задано"
  return values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ")
}

export function rangeText(from: number | null, to: number | null, unit = "") {
  if (from == null && to == null) return "любой"
  if (from != null && to != null) return `${from}${unit} - ${to}${unit}`
  if (from != null) return `от ${from}${unit}`
  return `до ${to}${unit}`
}

export function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

export function formatGeoSummary(
  filter: Pick<FilterRow, "regions" | "cities">,
  regions: RegionOption[],
) {
  if (filter.regions.length === 0 && filter.cities.length === 0) return "Вся Украина"
  const cityMap = new Map(regions.flatMap((region) => region.cities.map((city) => [city.id, city] as const)))
  const regionMap = new Map(regions.map((region) => [region.id, region.nameRu] as const))
  const parts = filter.regions.flatMap((regionId) => {
    const regionCities = filter.cities.filter((cityId) => cityMap.get(cityId)?.regionId === regionId)
    return regionCities.length > 0
      ? regionCities.map((cityId) => cityMap.get(cityId)?.nameRu ?? cityId)
      : [regionMap.get(regionId) ?? regionId]
  })
  const unscopedCities = filter.cities
    .filter((cityId) => !filter.regions.includes(cityMap.get(cityId)?.regionId ?? ""))
    .map((cityId) => cityMap.get(cityId)?.nameRu ?? cityId)
  return [...parts, ...unscopedCities].join(", ")
}
