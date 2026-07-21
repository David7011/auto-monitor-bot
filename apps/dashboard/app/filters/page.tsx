"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CarFront, Database, Fuel, Gauge, GitBranch, MapPin, Pencil, Plus, Power, SlidersHorizontal, Trash2, X } from "lucide-react"
import { clientApi as api, dashboardErrorMessage } from "@/lib/client-api"
import type { FilterRow, SourceKind } from "@/lib/types"
import { GlowButton } from "@/components/hud/glow-button"
import { HudPanel } from "@/components/hud/hud-panel"
import { StatusBadge } from "@/components/hud/status-badge"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"

type TaxonomyOption = {
  name: string
  value: number
}

type TaxonomyResponse = {
  options: TaxonomyOption[]
  complete: boolean
  apiConfigured: boolean
  source: "AUTO_RIA_API" | "LOCAL_FALLBACK"
  categoryId: number
  markId?: number
}

type AttributeOption = {
  value: string
  label: string
  aliases: string[]
}

type AttributeGroupsResponse = {
  groups: {
    bodyTypes: AttributeOption[]
    fuelTypes: AttributeOption[]
    gearboxes: AttributeOption[]
    driveTypes: AttributeOption[]
  }
}

type CityOption = {
  id: string
  regionId: string
  nameUk: string
  nameRu: string
  aliases: string[]
  autoRiaCityId?: number
}

type RegionOption = {
  id: string
  nameUk: string
  nameRu: string
  aliases: string[]
  autoRiaStateId?: number
  cities: CityOption[]
}

type RegionsResponse = {
  regions: RegionOption[]
  dataVersion: string
  cityCount: number
}

type FreshnessMode = "LAST_HOUR" | "TODAY" | "LAST_24_HOURS" | "LAST_3_DAYS" | "LAST_7_DAYS" | "ALL_TIME"

const SOURCES: SourceKind[] = ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"]
const SOURCE_LABELS: Record<SourceKind, string> = {
  AUTO_RIA: "AUTO.RIA",
  OLX: "OLX",
  RST: "RST",
  CARS_UA: "Cars.ua",
  AUTOMOTO: "AutoMoto.ua",
  MOCK: "Mock",
}
const FRESHNESS_MODES: Array<{ value: FreshnessMode; label: string }> = [
  { value: "LAST_HOUR", label: "LIVE: последний час" },
  { value: "TODAY", label: "Только сегодня" },
  { value: "LAST_24_HOURS", label: "Последние 24 часа" },
  { value: "LAST_3_DAYS", label: "Последние 3 дня" },
  { value: "LAST_7_DAYS", label: "Последние 7 дней" },
  { value: "ALL_TIME", label: "Все время" },
]

const CATEGORY_ID = 1
const inputClass =
  "h-10 w-full rounded-lg border border-line bg-surface-2/80 px-3 text-sm text-foreground outline-none transition-all placeholder:text-faint focus:border-accent/60 focus:bg-surface-3 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
const labelClass = "text-[11px] font-semibold uppercase tracking-widest text-muted"
const fetcher = <T,>(path: string) => api.get<T>(path)

function toList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function numberOrNull(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function booleanOrNull(value: string) {
  if (value === "true") return true
  if (value === "false") return false
  return null
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function labelsFor(values: string[], options: AttributeOption[] = []) {
  if (values.length === 0) return "не задано"
  return values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ")
}

function rangeText(from: number | null, to: number | null, unit = "") {
  if (from == null && to == null) return "любой"
  if (from != null && to != null) return `${from}${unit} - ${to}${unit}`
  if (from != null) return `от ${from}${unit}`
  return `до ${to}${unit}`
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function geoMatches(query: string, option: { id: string; nameUk: string; nameRu: string; aliases: string[] }) {
  const normalized = normalizeSearch(query)
  if (!normalized) return true
  return [option.id, option.nameUk, option.nameRu, ...option.aliases]
    .map(normalizeSearch)
    .some((value) => value.includes(normalized))
}

function formatGeoSummary(filter: Pick<FilterRow, "regions" | "cities">, regions: RegionOption[]) {
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

export default function FiltersPage() {
  const { data, mutate } = useSWR<{ filters: FilterRow[] }>("/filters", fetcher)
  const { data: marksData } = useSWR<TaxonomyResponse>(`/vehicle-taxonomy/marks?categoryId=${CATEGORY_ID}`, fetcher)
  const { data: attributeData } = useSWR<AttributeGroupsResponse>("/vehicle-taxonomy/options", fetcher)
  const { data: geoData } = useSWR<RegionsResponse>("/vehicle-taxonomy/regions", fetcher)

  const [name, setName] = useState("OLX/RST боевой фильтр")
  const [autoRiaMarkId, setAutoRiaMarkId] = useState("")
  const [autoRiaModelId, setAutoRiaModelId] = useState("")
  const [brand, setBrand] = useState("")
  const [model, setModel] = useState("")
  const [modelNames, setModelNames] = useState("")
  const [generation, setGeneration] = useState("")
  const [yearFrom, setYearFrom] = useState("2015")
  const [yearTo, setYearTo] = useState("")
  const [priceFrom, setPriceFrom] = useState("")
  const [priceTo, setPriceTo] = useState("15000")
  const [mileageFrom, setMileageFrom] = useState("")
  const [mileageTo, setMileageTo] = useState("220000")
  const [engineVolumeFrom, setEngineVolumeFrom] = useState("")
  const [engineVolumeTo, setEngineVolumeTo] = useState("")
  const [enginePowerFrom, setEnginePowerFrom] = useState("")
  const [enginePowerTo, setEnginePowerTo] = useState("")
  const [doorsFrom, setDoorsFrom] = useState("")
  const [doorsTo, setDoorsTo] = useState("")
  const [seatsFrom, setSeatsFrom] = useState("")
  const [seatsTo, setSeatsTo] = useState("")
  const [regions, setRegions] = useState<string[]>([])
  const [cities, setCities] = useState<string[]>([])
  const [regionSearch, setRegionSearch] = useState("")
  const [citySearch, setCitySearch] = useState("")
  const [keywords, setKeywords] = useState("")
  const [excludeKeywords, setExcludeKeywords] = useState("биток, нерастаможен, после ДТП")
  const [colors, setColors] = useState("")
  const [conditions, setConditions] = useState("")
  const [customsCleared, setCustomsCleared] = useState("")
  const [bargainPossible, setBargainPossible] = useState("")
  const [freshnessMode, setFreshnessMode] = useState<FreshnessMode>("TODAY")
  const [bodyTypes, setBodyTypes] = useState<string[]>([])
  const [fuelTypes, setFuelTypes] = useState<string[]>([])
  const [gearboxes, setGearboxes] = useState<string[]>([])
  const [driveTypes, setDriveTypes] = useState<string[]>([])
  const [sources, setSources] = useState<SourceKind[]>(["OLX", "RST", "CARS_UA", "AUTOMOTO"])
  const [editingId, setEditingId] = useState<string | null>(null)
  const { toast } = useToast()

  const filters = data?.filters ?? []
  const marks = marksData?.options ?? []
  const geoRegions = geoData?.regions ?? []
  const modelKey = autoRiaMarkId
    ? `/vehicle-taxonomy/models?categoryId=${CATEGORY_ID}&markId=${autoRiaMarkId}`
    : null
  const { data: modelsData } = useSWR<TaxonomyResponse>(modelKey, fetcher)
  const models = modelsData?.options ?? []

  const groups = attributeData?.groups
  const sourceText = useMemo(() => sources.map((source) => SOURCE_LABELS[source]).join(", "), [sources])
  const availableCities = useMemo(
    () =>
      regions.length === 0
        ? geoRegions.flatMap((region) => region.cities)
        : geoRegions.filter((region) => regions.includes(region.id)).flatMap((region) => region.cities),
    [geoRegions, regions],
  )

  function handleMarkChange(value: string) {
    setAutoRiaMarkId(value)
    setAutoRiaModelId("")
    setModel("")
    setBrand(marks.find((mark) => String(mark.value) === value)?.name ?? "")
  }

  function handleModelChange(value: string) {
    setAutoRiaModelId(value)
    setModel(models.find((item) => String(item.value) === value)?.name ?? "")
  }

  function toggleRegion(regionId: string) {
    const nextRegions = toggleValue(regions, regionId)
    const allowedCityIds = new Set(
      nextRegions.length === 0
        ? geoRegions.flatMap((region) => region.cities.map((city) => city.id))
        : geoRegions
            .filter((region) => nextRegions.includes(region.id))
            .flatMap((region) => region.cities.map((city) => city.id)),
    )
    setRegions(nextRegions)
    setCities((current) => current.filter((cityId) => allowedCityIds.has(cityId)))
  }

  function toggleCity(cityId: string) {
    const city = geoRegions.flatMap((region) => region.cities).find((item) => item.id === cityId)
    if (!cities.includes(cityId) && city) {
      setRegions((current) => (current.includes(city.regionId) ? current : [...current, city.regionId]))
    }
    setCities((current) => toggleValue(current, cityId))
  }

  function useWholeRegion(regionId: string) {
    const cityIds = new Set(geoRegions.find((region) => region.id === regionId)?.cities.map((city) => city.id) ?? [])
    setRegions((current) => (current.includes(regionId) ? current : [...current, regionId]))
    setCities((current) => current.filter((cityId) => !cityIds.has(cityId)))
  }

  function useWholeUkraine() {
    setRegions([])
    setCities([])
    setRegionSearch("")
    setCitySearch("")
  }

  function filterPayload() {
    return {
      name,
      enabled: true,
      sources,
      autoRiaCategoryId: CATEGORY_ID,
      autoRiaMarkId: marksData?.source === "AUTO_RIA_API" ? numberOrNull(autoRiaMarkId) : null,
      autoRiaModelId: modelsData?.source === "AUTO_RIA_API" ? numberOrNull(autoRiaModelId) : null,
      brand: brand || null,
      model: model || null,
      modelNames: toList(modelNames),
      generation: generation || null,
      bodyTypes,
      fuelTypes,
      gearboxes,
      driveTypes,
      colors: toList(colors),
      engineVolumeFrom: numberOrNull(engineVolumeFrom),
      engineVolumeTo: numberOrNull(engineVolumeTo),
      enginePowerFrom: numberOrNull(enginePowerFrom),
      enginePowerTo: numberOrNull(enginePowerTo),
      doorsFrom: numberOrNull(doorsFrom),
      doorsTo: numberOrNull(doorsTo),
      seatsFrom: numberOrNull(seatsFrom),
      seatsTo: numberOrNull(seatsTo),
      conditions: toList(conditions),
      customsCleared: booleanOrNull(customsCleared),
      bargainPossible: booleanOrNull(bargainPossible),
      freshnessMode,
      yearFrom: numberOrNull(yearFrom),
      yearTo: numberOrNull(yearTo),
      priceFrom: numberOrNull(priceFrom),
      priceTo: numberOrNull(priceTo),
      mileageFrom: numberOrNull(mileageFrom),
      mileageTo: numberOrNull(mileageTo),
      regions,
      cities,
      keywords: toList(keywords),
      excludeKeywords: toList(excludeKeywords),
    }
  }

  async function saveFilter() {
    try {
      const payload = filterPayload()
      if (editingId) {
        const { enabled: _enabled, ...patchPayload } = payload
        await api.patch(`/filters/${editingId}`, patchPayload)
      } else {
        await api.post("/filters", payload)
      }
      await mutate()
      const wasEditing = Boolean(editingId)
      resetForm()
      toast({ tone: "success", title: wasEditing ? "Фильтр обновлён" : "Фильтр создан" })
    } catch (err) {
      toast({ tone: "error", title: "Не удалось сохранить фильтр", description: dashboardErrorMessage(err) })
    }
  }

  function editFilter(filter: FilterRow) {
    setEditingId(filter.id)
    setName(filter.name)
    setAutoRiaMarkId(filter.autoRiaMarkId?.toString() ?? "")
    setAutoRiaModelId(filter.autoRiaModelId?.toString() ?? "")
    setBrand(filter.brand ?? "")
    setModel(filter.model ?? "")
    setModelNames((filter.modelNames ?? []).join(", "))
    setGeneration(filter.generation ?? "")
    setYearFrom(filter.yearFrom?.toString() ?? "")
    setYearTo(filter.yearTo?.toString() ?? "")
    setPriceFrom(filter.priceFrom?.toString() ?? "")
    setPriceTo(filter.priceTo?.toString() ?? "")
    setMileageFrom(filter.mileageFrom?.toString() ?? "")
    setMileageTo(filter.mileageTo?.toString() ?? "")
    setEngineVolumeFrom(filter.engineVolumeFrom?.toString() ?? "")
    setEngineVolumeTo(filter.engineVolumeTo?.toString() ?? "")
    setEnginePowerFrom(filter.enginePowerFrom?.toString() ?? "")
    setEnginePowerTo(filter.enginePowerTo?.toString() ?? "")
    setDoorsFrom(filter.doorsFrom?.toString() ?? "")
    setDoorsTo(filter.doorsTo?.toString() ?? "")
    setSeatsFrom(filter.seatsFrom?.toString() ?? "")
    setSeatsTo(filter.seatsTo?.toString() ?? "")
    setRegions(filter.regions)
    setCities(filter.cities)
    setKeywords(filter.keywords.join(", "))
    setExcludeKeywords(filter.excludeKeywords.join(", "))
    setColors((filter.colors ?? []).join(", "))
    setConditions((filter.conditions ?? []).join(", "))
    setCustomsCleared(filter.customsCleared == null ? "" : String(filter.customsCleared))
    setBargainPossible(filter.bargainPossible == null ? "" : String(filter.bargainPossible))
    setFreshnessMode(filter.freshnessMode ?? "TODAY")
    setBodyTypes(filter.bodyTypes)
    setFuelTypes(filter.fuelTypes)
    setGearboxes(filter.gearboxes)
    setDriveTypes(filter.driveTypes)
    setSources(filter.sources)
  }

  function resetForm() {
    setEditingId(null)
    setName("OLX/RST боевой фильтр")
    setAutoRiaMarkId("")
    setAutoRiaModelId("")
    setBrand("")
    setModel("")
    setModelNames("")
    setGeneration("")
    setYearFrom("2015")
    setYearTo("")
    setPriceFrom("")
    setPriceTo("15000")
    setMileageFrom("")
    setMileageTo("220000")
    setEngineVolumeFrom("")
    setEngineVolumeTo("")
    setEnginePowerFrom("")
    setEnginePowerTo("")
    setDoorsFrom("")
    setDoorsTo("")
    setSeatsFrom("")
    setSeatsTo("")
    setRegions([])
    setCities([])
    setRegionSearch("")
    setCitySearch("")
    setKeywords("")
    setExcludeKeywords("биток, нерастаможен, после ДТП")
    setColors("")
    setConditions("")
    setCustomsCleared("")
    setBargainPossible("")
    setFreshnessMode("TODAY")
    setBodyTypes([])
    setFuelTypes([])
    setGearboxes([])
    setDriveTypes([])
    setSources(["OLX", "RST", "CARS_UA", "AUTOMOTO"])
  }

  async function toggle(filter: FilterRow) {
    try {
      await api.patch(`/filters/${filter.id}`, { enabled: !filter.enabled })
      await mutate()
      toast({ tone: filter.enabled ? "warning" : "success", title: `${filter.enabled ? "Пауза" : "Включён"}: ${filter.name}` })
    } catch (err) {
      toast({ tone: "error", title: "Не удалось изменить фильтр", description: dashboardErrorMessage(err) })
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/filters/${id}`)
      await mutate()
      toast({ tone: "info", title: "Фильтр удалён" })
    } catch (err) {
      toast({ tone: "error", title: "Не удалось удалить фильтр", description: dashboardErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative">
          <div className="kicker mb-2">Движок фильтров</div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Фильтры поиска</span></h1>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            Фильтр хранит AUTO.RIA ID марки/модели и одновременно работает по нормализованным названиям для OLX, RST, Cars.ua и AutoMoto.ua.
          </p>
        </div>
      </header>

      <HudPanel kicker="Конструктор" title="Новый фильтр" action={<SlidersHorizontal className="size-4 text-accent-soft" />}>
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Название" className="md:col-span-3">
                <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
              </Field>

              <Field label="Марка">
                <select
                  className={inputClass}
                  value={autoRiaMarkId}
                  onChange={(event) => handleMarkChange(event.target.value)}
                >
                  <option value="">Любая марка</option>
                  {marks.map((mark) => (
                    <option key={mark.value} value={mark.value}>
                      {mark.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Модель">
                <select
                  className={inputClass}
                  value={autoRiaModelId}
                  disabled={!autoRiaMarkId}
                  onChange={(event) => handleModelChange(event.target.value)}
                >
                  <option value="">Любая модель</option>
                  {models.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Ручная модель">
                <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
              </Field>

              <Field label="Несколько моделей">
                <input className={inputClass} value={modelNames} onChange={(event) => setModelNames(event.target.value)} placeholder="A4, A5, Q5" />
              </Field>

              <Field label="Поколение">
                <input className={inputClass} value={generation} onChange={(event) => setGeneration(event.target.value)} placeholder="B8, F30, W204" />
              </Field>

              <Field label="Свежесть">
                <select className={inputClass} value={freshnessMode} onChange={(event) => setFreshnessMode(event.target.value as FreshnessMode)}>
                  {FRESHNESS_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>{mode.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Field label="Год от">
                <input className={inputClass} inputMode="numeric" value={yearFrom} onChange={(event) => setYearFrom(event.target.value)} />
              </Field>
              <Field label="Год до">
                <input className={inputClass} inputMode="numeric" value={yearTo} onChange={(event) => setYearTo(event.target.value)} />
              </Field>
              <Field label="Цена от, $">
                <input className={inputClass} inputMode="numeric" value={priceFrom} onChange={(event) => setPriceFrom(event.target.value)} />
              </Field>
              <Field label="Цена до, $">
                <input className={inputClass} inputMode="numeric" value={priceTo} onChange={(event) => setPriceTo(event.target.value)} />
              </Field>
              <Field label="Пробег от">
                <input className={inputClass} inputMode="numeric" value={mileageFrom} onChange={(event) => setMileageFrom(event.target.value)} />
              </Field>
              <Field label="Пробег до">
                <input className={inputClass} inputMode="numeric" value={mileageTo} onChange={(event) => setMileageTo(event.target.value)} />
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Field label="Объем от, л">
                <input className={inputClass} inputMode="decimal" value={engineVolumeFrom} onChange={(event) => setEngineVolumeFrom(event.target.value)} />
              </Field>
              <Field label="Объем до, л">
                <input className={inputClass} inputMode="decimal" value={engineVolumeTo} onChange={(event) => setEngineVolumeTo(event.target.value)} />
              </Field>
              <Field label="Мощность от">
                <input className={inputClass} inputMode="numeric" value={enginePowerFrom} onChange={(event) => setEnginePowerFrom(event.target.value)} />
              </Field>
              <Field label="Мощность до">
                <input className={inputClass} inputMode="numeric" value={enginePowerTo} onChange={(event) => setEnginePowerTo(event.target.value)} />
              </Field>
              <Field label="Дверей от">
                <input className={inputClass} inputMode="numeric" value={doorsFrom} onChange={(event) => setDoorsFrom(event.target.value)} />
              </Field>
              <Field label="Мест от">
                <input className={inputClass} inputMode="numeric" value={seatsFrom} onChange={(event) => setSeatsFrom(event.target.value)} />
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Field label="Дверей до">
                <input className={inputClass} inputMode="numeric" value={doorsTo} onChange={(event) => setDoorsTo(event.target.value)} />
              </Field>
              <Field label="Мест до">
                <input className={inputClass} inputMode="numeric" value={seatsTo} onChange={(event) => setSeatsTo(event.target.value)} />
              </Field>
              <Field label="Цвета">
                <input className={inputClass} value={colors} onChange={(event) => setColors(event.target.value)} placeholder="черный, белый" />
              </Field>
              <Field label="Состояние">
                <input className={inputClass} value={conditions} onChange={(event) => setConditions(event.target.value)} placeholder="не бит, после ДТП" />
              </Field>
              <Field label="Растаможка">
                <select className={inputClass} value={customsCleared} onChange={(event) => setCustomsCleared(event.target.value)}>
                  <option value="">Не важно</option>
                  <option value="true">Растаможен</option>
                  <option value="false">Не растаможен</option>
                </select>
              </Field>
              <Field label="Торг">
                <select className={inputClass} value={bargainPossible} onChange={(event) => setBargainPossible(event.target.value)}>
                  <option value="">Не важно</option>
                  <option value="true">Возможен</option>
                  <option value="false">Без торга</option>
                </select>
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <GeoSelector
                  regions={geoRegions}
                  availableCities={availableCities}
                  selectedRegions={regions}
                  selectedCities={cities}
                  regionSearch={regionSearch}
                  citySearch={citySearch}
                  dataVersion={geoData?.dataVersion}
                  cityCount={geoData?.cityCount ?? 0}
                  onRegionSearch={setRegionSearch}
                  onCitySearch={setCitySearch}
                  onToggleRegion={toggleRegion}
                  onToggleCity={toggleCity}
                  onUseWholeRegion={useWholeRegion}
                  onAllUkraine={useWholeUkraine}
                  onClearCities={() => setCities([])}
                />
              </div>
              <Field label="Ключевые слова">
                <input className={inputClass} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="individual, official, service" />
              </Field>
              <Field label="Исключить">
                <input className={inputClass} value={excludeKeywords} onChange={(event) => setExcludeKeywords(event.target.value)} />
              </Field>
            </div>
          </div>

          <div className="space-y-4">
            <ToggleGroup icon={<Database />} label="Источники">
              {SOURCES.map((source) => {
                const active = sources.includes(source)
                return (
                  <TogglePill
                    key={source}
                    active={active}
                    label={SOURCE_LABELS[source]}
                    onClick={() => setSources(active ? sources.filter((item) => item !== source) : [...sources, source])}
                  />
                )
              })}
            </ToggleGroup>

            <ToggleGroup icon={<CarFront />} label="Кузов">
              {(groups?.bodyTypes ?? []).map((option) => (
                <TogglePill
                  key={option.value}
                  active={bodyTypes.includes(option.value)}
                  label={option.label}
                  onClick={() => setBodyTypes(toggleValue(bodyTypes, option.value))}
                />
              ))}
            </ToggleGroup>

            <ToggleGroup icon={<Fuel />} label="Топливо">
              {(groups?.fuelTypes ?? []).map((option) => (
                <TogglePill
                  key={option.value}
                  active={fuelTypes.includes(option.value)}
                  label={option.label}
                  onClick={() => setFuelTypes(toggleValue(fuelTypes, option.value))}
                />
              ))}
            </ToggleGroup>

            <ToggleGroup icon={<Gauge />} label="Коробка">
              {(groups?.gearboxes ?? []).map((option) => (
                <TogglePill
                  key={option.value}
                  active={gearboxes.includes(option.value)}
                  label={option.label}
                  onClick={() => setGearboxes(toggleValue(gearboxes, option.value))}
                />
              ))}
            </ToggleGroup>

            <ToggleGroup icon={<GitBranch />} label="Привод">
              {(groups?.driveTypes ?? []).map((option) => (
                <TogglePill
                  key={option.value}
                  active={driveTypes.includes(option.value)}
                  label={option.label}
                  onClick={() => setDriveTypes(toggleValue(driveTypes, option.value))}
                />
              ))}
            </ToggleGroup>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-xs text-muted">
            Марка: <span className="text-foreground">{brand || "любая"}</span> · Модель:{" "}
            <span className="text-foreground">{model || modelNames || "любая"}</span> · Свежесть:{" "}
            <span className="text-foreground">{FRESHNESS_MODES.find((mode) => mode.value === freshnessMode)?.label}</span> · Источники:{" "}
            <span className="text-foreground">{sourceText || "не выбраны"}</span> · Гео:{" "}
            <span className="text-foreground">{formatGeoSummary({ regions, cities }, geoRegions)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {editingId ? (
              <GlowButton tone="danger" onClick={resetForm}>
                <X /> Отмена
              </GlowButton>
            ) : null}
            <GlowButton onClick={saveFilter} disabled={!name.trim() || sources.length === 0}>
              <Plus /> {editingId ? "Сохранить фильтр" : "Создать фильтр"}
            </GlowButton>
          </div>
        </div>
      </HudPanel>

      <HudPanel kicker="Боевой набор" title="Активные фильтры">
        <div className="space-y-3">
          {filters.map((filter) => (
            <div
              key={filter.id}
              className="surface-card flex flex-col justify-between gap-3 rounded-xl p-4 transition-colors hover:border-line-strong lg:flex-row lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{filter.name}</span>
                  <StatusBadge status={filter.enabled ? "ACTIVE" : "DISABLED"} />
                </div>
                <div className="mt-2 grid gap-x-4 gap-y-1 text-sm text-muted md:grid-cols-2 xl:grid-cols-4">
                  <span>{filter.brand ?? "Любая марка"} {filter.model ?? (filter.modelNames ?? []).join(", ")}</span>
                  <span>Свежесть: {FRESHNESS_MODES.find((mode) => mode.value === filter.freshnessMode)?.label ?? filter.freshnessMode}</span>
                  <span>Год: {rangeText(filter.yearFrom, filter.yearTo)}</span>
                  <span>Цена: {rangeText(filter.priceFrom, filter.priceTo, "$")}</span>
                  <span>Пробег: {rangeText(filter.mileageFrom, filter.mileageTo, " км")}</span>
                  <span>Объем: {rangeText(filter.engineVolumeFrom, filter.engineVolumeTo, " л")}</span>
                  <span>Мощность: {rangeText(filter.enginePowerFrom, filter.enginePowerTo, " л.с.")}</span>
                  <span>Кузов: {labelsFor(filter.bodyTypes, groups?.bodyTypes)}</span>
                  <span>Топливо: {labelsFor(filter.fuelTypes, groups?.fuelTypes)}</span>
                  <span>Коробка: {labelsFor(filter.gearboxes, groups?.gearboxes)}</span>
                  <span>Привод: {labelsFor(filter.driveTypes, groups?.driveTypes)}</span>
                  <span>Гео: {formatGeoSummary(filter, geoRegions)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
                  <span>{filter.sources.join(", ") || "все источники"}</span>
                  {filter.sources.includes("AUTO_RIA") ? <AutoRiaFilterBadge filter={filter} /> : null}
                </div>
              </div>
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap lg:shrink-0 lg:justify-end">
                <GlowButton className="col-span-2 w-full sm:w-auto" onClick={() => editFilter(filter)}>
                  <Pencil /> Редактировать
                </GlowButton>
                <GlowButton className="w-full sm:w-auto" tone={filter.enabled ? "danger" : "success"} onClick={() => toggle(filter)}>
                  <Power /> {filter.enabled ? "Пауза" : "Включить"}
                </GlowButton>
                <GlowButton className="w-full sm:w-auto" tone="danger" onClick={() => remove(filter.id)}>
                  <Trash2 /> Удалить
                </GlowButton>
              </div>
            </div>
          ))}
          {!filters.length ? <div className="py-8 text-center text-muted">Фильтров пока нет.</div> : null}
        </div>
      </HudPanel>
    </div>
  )
}

function GeoSelector({
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
        {selectedCities.length > selectedAutoRiaCities ? " Города без AUTO.RIA id будут проверяться локальным post-filter после фильтрации по области." : ""}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <input
            className={inputClass}
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
            className={inputClass}
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
                <span className="px-2 py-1 text-xs text-muted">Выберите область или введите минимум 2 буквы города</span>
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

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn("space-y-1.5", className)}>
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  )
}

function ToggleGroup({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
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

function TogglePill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
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

function AutoRiaFilterBadge({ filter }: { filter: FilterRow }) {
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
