"use client"

import type { ReactNode } from "react"
import { MapPin } from "lucide-react"
import { GlowButton } from "@/components/hud/glow-button"
import type { FilterRow } from "@/lib/types"
import { cn } from "@/lib/utils"

export type CityOption = {
  id: string
  regionId: string
  nameUk: string
  nameRu: string
  aliases: string[]
  autoRiaCityId?: number
}

export type RegionOption = {
  id: string
  nameUk: string
  nameRu: string
  aliases: string[]
  autoRiaStateId?: number
  cities: CityOption[]
}

export const filterInputClass =
  "h-10 w-full rounded-lg border border-line bg-surface-2/80 px-3 text-sm text-foreground outline-none transition-all placeholder:text-faint focus:border-accent/60 focus:bg-surface-3 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"

const labelClass = "text-[11px] font-semibold uppercase tracking-widest text-muted"

export function GeoSelector({
  regions,
  availableCities,
  selectedRegions,
  selectedCities,
  regionSearch,
  citySearch,
  dataVersion,
  cityCount,
  onRegionSearch,
  onCitySearch,
  onToggleRegion,
  onToggleCity,
  onUseWholeRegion,
  onAllUkraine,
  onClearCities,
}: {
  regions: RegionOption[]
  availableCities: CityOption[]
  selectedRegions: string[]
  selectedCities: string[]
  regionSearch: string
  citySearch: string
  dataVersion?: string
  cityCount: number
  onRegionSearch: (value: string) => void
  onCitySearch: (value: string) => void
  onToggleRegion: (value: string) => void
  onToggleCity: (value: string) => void
  onUseWholeRegion: (value: string) => void
  onAllUkraine: () => void
  onClearCities: () => void
}) {
  const visibleRegions = regions.filter((region) => geoMatches(regionSearch, region))
  const cityQuery = normalizeSearch(citySearch)
  const visibleCities = (selectedRegions.length > 0 || cityQuery.length >= 2
    ? availableCities.filter((city) => geoMatches(citySearch, city))
    : []
  ).slice(0, 200)
  const regionMap = new Map(regions.map((region) => [region.id, region] as const))
  const cityMap = new Map(regions.flatMap((region) => region.cities.map((city) => [city.id, city] as const)))
  const selectedAutoRiaRegions = selectedRegions.filter((regionId) => regionMap.get(regionId)?.autoRiaStateId).length
  const selectedAutoRiaCities = selectedCities.filter((cityId) => cityMap.get(cityId)?.autoRiaCityId).length

  return (
    <div className="space-y-3 rounded-lg border border-border bg-panel-alt/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <MapPin className="size-4" />
          География
        </div>
        <div className="flex flex-wrap gap-2">
          <GlowButton onClick={onAllUkraine}>Вся Украина</GlowButton>
          <GlowButton tone="danger" onClick={onClearCities} disabled={selectedCities.length === 0}>
            Очистить города
          </GlowButton>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background/40 px-3 py-2 font-mono text-xs text-muted">
        {dataVersion ?? "КАТОТТГ"}: {cityCount} городов. AUTO.RIA API: {selectedAutoRiaRegions}/{selectedRegions.length} областей, {selectedAutoRiaCities}/{selectedCities.length} городов.
        {selectedCities.length > selectedAutoRiaCities
          ? " Города без AUTO.RIA id будут проверяться локальным post-filter после фильтрации по области."
          : ""}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <input
            className={filterInputClass}
            value={regionSearch}
            onChange={(event) => onRegionSearch(event.target.value)}
            placeholder="Поиск области"
          />
          <div className="max-h-48 overflow-auto rounded-lg border border-border bg-background/40 p-2">
            <div className="flex flex-wrap gap-2">
              {visibleRegions.map((region) => (
                <TogglePill
                  key={region.id}
                  active={selectedRegions.includes(region.id)}
                  label={`${region.nameRu}${region.autoRiaStateId ? ` · RIA ${region.autoRiaStateId}` : ""}`}
                  onClick={() => onToggleRegion(region.id)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <input
            className={filterInputClass}
            value={citySearch}
            onChange={(event) => onCitySearch(event.target.value)}
            placeholder={selectedRegions.length ? "Поиск города в выбранных областях" : "Поиск города по Украине"}
          />
          <div className="max-h-48 overflow-auto rounded-lg border border-border bg-background/40 p-2">
            <div className="flex flex-wrap gap-2">
              {visibleCities.map((city) => (
                <TogglePill
                  key={city.id}
                  active={selectedCities.includes(city.id)}
                  label={`${city.nameRu} · ${regionMap.get(city.regionId)?.nameRu ?? city.regionId}${city.autoRiaCityId ? ` · RIA ${city.autoRiaCityId}` : ""}`}
                  onClick={() => onToggleCity(city.id)}
                />
              ))}
              {visibleCities.length === 0 ? (
                <span className="px-2 py-1 text-xs text-muted">
                  Выберите область или введите минимум 2 буквы города
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {selectedRegions.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {selectedRegions.map((regionId) => {
            const region = regionMap.get(regionId)
            const regionCities = selectedCities.filter((cityId) => cityMap.get(cityId)?.regionId === regionId)
            return (
              <div key={regionId} className="flex items-center justify-between gap-3 border-t border-border px-1 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{region?.nameRu ?? regionId}</div>
                  <div className="truncate text-xs text-muted">
                    {regionCities.length === 0
                      ? "Вся область"
                      : regionCities.map((cityId) => cityMap.get(cityId)?.nameRu ?? cityId).join(", ")}
                  </div>
                </div>
                <GlowButton onClick={() => onUseWholeRegion(regionId)} disabled={regionCities.length === 0}>
                  Вся область
                </GlowButton>
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 text-xs">
        {selectedRegions.length === 0 && selectedCities.length === 0 ? (
          <span className="rounded-md border border-border bg-background/50 px-2 py-1 text-muted">Вся Украина</span>
        ) : null}
        {selectedRegions.map((regionId) => (
          <button
            key={regionId}
            type="button"
            className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-accent-soft"
            onClick={() => onToggleRegion(regionId)}
          >
            {regionMap.get(regionId)?.nameRu ?? regionId} ×
          </button>
        ))}
        {selectedCities.map((cityId) => (
          <button
            key={cityId}
            type="button"
            className="rounded-md border border-success/40 bg-success/10 px-2 py-1 text-success"
            onClick={() => onToggleCity(cityId)}
          >
            {cityMap.get(cityId)?.nameRu ?? cityId} ×
          </button>
        ))}
      </div>
    </div>
  )
}

export function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <label className={cn("space-y-1.5", className)}>
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  )
}

export function ToggleGroup({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <span className="[&_svg]:size-4">{icon}</span>
        {label}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

export function TogglePill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "min-h-9 max-w-full break-words whitespace-normal rounded-lg border px-3 py-2 text-left text-sm leading-snug transition-all active:scale-[0.97]",
        active
          ? "border-accent/50 bg-accent/12 text-accent-soft shadow-[0_0_16px_-8px_rgba(242,106,31,0.6)]"
          : "border-line bg-surface-2/70 text-muted hover:border-line-strong hover:bg-surface-3 hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

export function AutoRiaFilterBadge({ filter }: { filter: FilterRow }) {
  if (!filter.autoRiaMarkId) {
    return (
      <span className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-danger">
        AUTO.RIA широкий поиск
      </span>
    )
  }
  return (
    <span className="rounded-md border border-success/30 bg-success/10 px-2 py-1 text-success">
      AUTO.RIA марка #{filter.autoRiaMarkId}{filter.autoRiaModelId ? ` / модель #${filter.autoRiaModelId}` : ""}
    </span>
  )
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function geoMatches(
  query: string,
  option: { id: string; nameUk: string; nameRu: string; aliases: string[] },
) {
  const normalized = normalizeSearch(query)
  if (!normalized) return true
  return [option.id, option.nameUk, option.nameRu, ...option.aliases]
    .some((value) => normalizeSearch(value).includes(normalized))
}
