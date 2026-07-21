import type { FastifyInstance } from "fastify";
import { prisma, type Filter, type ListingSource, type Source, type SourceSearchState } from "@amb/db";
import { autoRiaGeoParamsForSelection } from "@amb/shared";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";

const REAL_SOURCES: ListingSource[] = ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"];
const AUTO_RIA_SEARCH_FIELDS = [
  "mark",
  "model",
  "year",
  "price",
  "mileage",
  "engine",
  "power",
  "doors",
  "seats",
  "body",
  "fuel",
  "gearbox",
  "geo",
  "customs",
  "freshness",
] as const;
const FIELD_LABELS: Record<(typeof AUTO_RIA_SEARCH_FIELDS)[number], string> = {
  mark: "марка",
  model: "модель",
  year: "год",
  price: "цена",
  mileage: "пробег",
  engine: "двигатель",
  power: "мощность",
  doors: "двери",
  seats: "места",
  body: "кузов",
  fuel: "топливо",
  gearbox: "коробка",
  geo: "география",
  customs: "растаможка",
  freshness: "свежесть",
};

export async function searchPlanRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search-plan", async () => {
    const now = new Date();
    const [filters, sources, states, recentRuns, quota] = await Promise.all([
      prisma.filter.findMany({ where: { enabled: true }, orderBy: { updatedAt: "desc" } }),
      prisma.source.findMany(),
      prisma.sourceSearchState.findMany({ orderBy: { updatedAt: "desc" } }),
      prisma.collectorRun.findMany({ orderBy: { startedAt: "desc" }, take: 40 }),
      autoRiaQuota(now),
    ]);

    const sourceMap = new Map(sources.map((source) => [source.source, source]));
    const plans = filters.flatMap((filter) =>
      targetSources(filter).map((source) =>
        buildPlanRow({
          filter,
          source,
          sourceRecord: sourceMap.get(source),
          state: states.find((item) => item.source === source && item.filterIds.includes(filter.id)),
          recentRun: recentRuns.find((run) => run.source === source) ?? null,
        }),
      ),
    );

    const totals = {
      activeFilters: filters.length,
      plannedContexts: plans.length,
      activeSources: sources.filter((source) => source.enabled && ["ACTIVE", "LIMITED"].includes(source.status)).length,
      initialSyncPending: plans.filter((plan) => !plan.initialSyncCompletedAt).length,
      blocked: plans.filter((plan) => plan.severity === "danger").length,
      warnings: plans.filter((plan) => plan.severity === "warning").length,
      autoRiaContexts: plans.filter((plan) => plan.source === "AUTO_RIA").length,
      autoRiaEstimatedRequestsPerScan: plans
        .filter((plan) => plan.source === "AUTO_RIA" && plan.sourceEnabled)
        .reduce((sum, plan) => sum + plan.estimatedRequestsPerScan, 0),
    };

    return {
      generatedAt: now.toISOString(),
      totals,
      autoRia: quota,
      backfill: {
        intervalSeconds: env.BACKFILL_INTERVAL_SECONDS,
        initialDelaySeconds: env.BACKFILL_INITIAL_DELAY_SECONDS,
        maxPages: env.BACKFILL_MAX_PAGES,
        maxCandidates: env.BACKFILL_MAX_CANDIDATES,
        maxDurationMs: env.BACKFILL_MAX_DURATION_MS,
        concurrency: env.WORKER_CONCURRENCY_COLLECTOR_BACKFILL,
      },
      plans,
    };
  });
}

function buildPlanRow({
  filter,
  source,
  sourceRecord,
  state,
  recentRun,
}: {
  filter: Filter;
  source: ListingSource;
  sourceRecord: Source | undefined;
  state: SourceSearchState | undefined;
  recentRun: {
    lane: string;
    status: string;
    foundCount: number;
    newCount: number;
    pageCount: number;
    startedAt: Date;
    errorMessage: string | null;
    finishedAt: Date | null;
  } | null;
}) {
  const issues = planIssues(filter, source, sourceRecord, state);
  const supported = sourceSupport(filter, source, sourceRecord);
  const severity = issues.some((issue) => issue.level === "danger")
    ? "danger"
    : issues.some((issue) => issue.level === "warning")
      ? "warning"
      : "ok";

  return {
    id: `${source}:${filter.id}`,
    source,
    sourceEnabled: Boolean(sourceRecord?.enabled),
    sourceStatus: sourceRecord?.status ?? "DISABLED",
    sourceNextCheckAt: sourceRecord?.nextCheckAt?.toISOString() ?? null,
    filterId: filter.id,
    filterName: filter.name,
    freshnessMode: filter.freshnessMode,
    filterSummary: summarizeFilter(filter),
    initialSyncCompletedAt: state?.initialSyncCompletedAt?.toISOString() ?? null,
    lastSuccessfulScanAt: state?.lastSuccessfulScanAt?.toISOString() ?? null,
    lastPublishedAt: state?.lastPublishedAt?.toISOString() ?? null,
    latestSeenPublishedAt: state?.latestSeenPublishedAt?.toISOString() ?? null,
    latestSeenExternalId: state?.latestSeenExternalId ?? null,
    oldestScannedPublishedAt: state?.oldestScannedPublishedAt?.toISOString() ?? null,
    lastCompletedCutoff: state?.lastCompletedCutoff?.toISOString() ?? null,
    lastPage: state?.lastPage ?? null,
    newestFirstVerifiedAt: state?.newestFirstVerifiedAt?.toISOString() ?? sourceRecord?.newestFirstVerifiedAt?.toISOString() ?? null,
    lastExternalId: state?.lastExternalId ?? null,
    knownExternalIds: state?.knownExternalIds.length ?? 0,
    fingerprint: state ? `${state.fingerprint.slice(0, 10)}...` : null,
    estimatedRequestsPerScan: source === "AUTO_RIA" ? 1 + env.AUTO_RIA_MAX_INFO_PER_SCAN : 0,
    supported,
    issues,
    severity,
    recentRun: recentRun
      ? {
          lane: recentRun.lane,
          status: recentRun.status,
          foundCount: recentRun.foundCount,
          newCount: recentRun.newCount,
          pageCount: recentRun.pageCount,
          durationMs: recentRun.finishedAt ? recentRun.finishedAt.getTime() - recentRun.startedAt.getTime() : null,
          errorMessage: recentRun.errorMessage,
          finishedAt: recentRun.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function targetSources(filter: Filter): ListingSource[] {
  const sources = filter.sources.length > 0 ? filter.sources : REAL_SOURCES;
  return sources.filter((source) => REAL_SOURCES.includes(source));
}

function planIssues(filter: Filter, source: ListingSource, sourceRecord: Source | undefined, state: SourceSearchState | undefined) {
  const issues: Array<{ level: "ok" | "warning" | "danger"; message: string }> = [];

  if (!sourceRecord?.enabled) {
    issues.push({ level: "danger", message: "Источник выключен" });
  }
  if (sourceRecord?.status === "RATE_LIMITED" || sourceRecord?.status === "CAPTCHA_DETECTED" || sourceRecord?.status === "ERROR") {
    issues.push({ level: "danger", message: `Источник недоступен: ${sourceRecord.status}` });
  }
  if (filter.freshnessMode === "LAST_24_HOURS" && sourceRecord?.supportsNewestFirst && !sourceRecord.newestFirstVerified) {
    issues.push({ level: "warning", message: "Порядок «сначала новые» не подтвержден; полученная пачка сортируется локально" });
  }
  if (filter.freshnessMode === "LAST_24_HOURS" && sourceRecord && !sourceRecord.supportsNewestFirst) {
    issues.push({ level: "warning", message: "Источник не отдает надежное точное время; часть объявлений подтверждается по первому появлению" });
  }
  if (!state) {
    issues.push({ level: "warning", message: "Контекст поиска еще не запускался" });
  } else if (!state.initialSyncCompletedAt) {
    issues.push({ level: "warning", message: "Первичная синхронизация еще выполняется" });
  }

  if (source === "AUTO_RIA") {
    if (!env.AUTO_RIA_API_KEY) {
      issues.push({ level: "danger", message: "API-ключ AUTO.RIA не настроен" });
    }
    if (!filter.autoRiaMarkId) {
      issues.push({ level: "danger", message: "Не выбран официальный ID марки AUTO.RIA; запрос получился бы слишком широким" });
    }
    if (filter.brand && !filter.autoRiaMarkId) {
      issues.push({ level: "warning", message: "Марка указана текстом, но отсутствует официальный ID марки AUTO.RIA" });
    }
    if (filter.model && filter.autoRiaMarkId && !filter.autoRiaModelId) {
      issues.push({ level: "warning", message: "Модель указана текстом, но отсутствует официальный ID модели AUTO.RIA" });
    }
    if (autoRiaNeedsGeoPostFilter(filter)) {
      issues.push({ level: "warning", message: "Для части городов нет ID AUTO.RIA: область фильтруется в API, город проверяется после загрузки" });
    }
  }

  if (source === "RST") {
    issues.push({ level: "warning", message: "RST не отдает точное время; свежесть определяется менее надежно, чем у AUTO.RIA, OLX и Cars.ua" });
  }
  if (source === "AUTOMOTO") {
    issues.push({ level: "warning", message: "AutoMoto.ua используется как резервный агрегатор и отдает дату без точного времени" });
  }

  return issues;
}

function sourceSupport(filter: Filter, source: ListingSource, sourceRecord: Source | undefined) {
  if (source === "AUTO_RIA") {
    return {
      mode: "api-filtered",
      apiFields: AUTO_RIA_SEARCH_FIELDS.filter((field) => fieldUsed(filter, field)).map((field) => FIELD_LABELS[field]),
      postFilterFields: postFilterFields(filter, source),
    };
  }

  return {
    mode: source === "RST" || source === "AUTOMOTO" ? "html-limited" : sourceRecord?.newestFirstVerified ? "html-newest" : "html-local-sort",
    apiFields: [],
    postFilterFields: postFilterFields(filter, source),
  };
}

function fieldUsed(filter: Filter, field: (typeof AUTO_RIA_SEARCH_FIELDS)[number]): boolean {
  switch (field) {
    case "mark":
      return filter.autoRiaMarkId != null;
    case "model":
      return filter.autoRiaModelId != null;
    case "year":
      return filter.yearFrom != null || filter.yearTo != null;
    case "price":
      return filter.priceFrom != null || filter.priceTo != null;
    case "mileage":
      return filter.mileageFrom != null || filter.mileageTo != null;
    case "engine":
      return filter.engineVolumeFrom != null || filter.engineVolumeTo != null;
    case "power":
      return filter.enginePowerFrom != null || filter.enginePowerTo != null;
    case "doors":
      return filter.doorsFrom != null || filter.doorsTo != null;
    case "seats":
      return filter.seatsFrom != null || filter.seatsTo != null;
    case "body":
      return filter.bodyTypes.length > 0;
    case "fuel":
      return filter.fuelTypes.length > 0;
    case "gearbox":
      return filter.gearboxes.length > 0;
    case "geo":
      return filter.regions.length > 0 || filter.cities.length > 0;
    case "customs":
      return filter.customsCleared != null;
    case "freshness":
      return filter.freshnessMode !== "ALL_TIME";
  }
}

function postFilterFields(filter: Filter, source: ListingSource): string[] {
  const fields: string[] = [];
  if (source !== "AUTO_RIA") fields.push("марка и модель");
  if (source !== "AUTO_RIA" && (filter.yearFrom != null || filter.yearTo != null)) fields.push("год");
  if (source !== "AUTO_RIA" && (filter.priceFrom != null || filter.priceTo != null)) fields.push("цена");
  if (source !== "AUTO_RIA" && (filter.mileageFrom != null || filter.mileageTo != null)) fields.push("пробег");
  if (filter.regions.length > 0 || filter.cities.length > 0) {
    if (source !== "AUTO_RIA" || autoRiaNeedsGeoPostFilter(filter)) fields.push("география");
  }
  if (filter.keywords.length > 0) fields.push("ключевые слова");
  if (filter.excludeKeywords.length > 0) fields.push("исключения");
  if (filter.colors.length > 0) fields.push("цвет");
  if (filter.driveTypes.length > 0) fields.push("привод");
  if (filter.bargainPossible != null) fields.push("торг");
  if (filter.generation) fields.push("поколение");
  return fields;
}

function autoRiaNeedsGeoPostFilter(filter: Filter): boolean {
  if (filter.regions.length === 0 && filter.cities.length === 0) return false;
  if (filter.cities.length === 0) return false;
  const geo = autoRiaGeoParamsForSelection(filter.regions, filter.cities);
  return geo.length === 0 || geo.some((item) => !item.apiCityBacked);
}

function summarizeFilter(filter: Filter): string {
  const title = [filter.brand, filter.model ?? filter.modelNames[0]].filter(Boolean).join(" ") || "Любой автомобиль";
  const year = range(filter.yearFrom, filter.yearTo);
  const price = range(filter.priceFrom, filter.priceTo, "$");
  return `${title} · ${year} · ${price}`;
}

function range(from: number | null, to: number | null, unit = ""): string {
  if (from == null && to == null) return "без ограничений";
  if (from != null && to != null) return `${from}-${to}${unit}`;
  if (from != null) return `от ${from}${unit}`;
  return `до ${to}${unit}`;
}

async function autoRiaQuota(now: Date) {
  const totalKey = `auto-ria:quota:${now.toISOString().slice(0, 7)}:total`;
  const [totalUsed, hourlyUsed] = await Promise.all([
    redisNumber(totalKey),
    redisRollingCount("auto-ria:quota:rolling-hour", now.getTime() - 60 * 60 * 1000),
  ]);
  return {
    configured: Boolean(env.AUTO_RIA_API_KEY),
    userIdConfigured: Boolean(env.AUTO_RIA_USER_ID),
    totalLimit: env.AUTO_RIA_TOTAL_REQUEST_LIMIT,
    hourlyLimit: env.AUTO_RIA_HOURLY_REQUEST_LIMIT,
    softReserve: env.AUTO_RIA_SOFT_RESERVE,
    minSearchReserve: env.AUTO_RIA_MIN_SEARCH_RESERVE,
    maxInfoPerScan: env.AUTO_RIA_MAX_INFO_PER_SCAN,
    totalUsed,
    hourlyUsed,
    totalRemaining: Math.max(0, env.AUTO_RIA_TOTAL_REQUEST_LIMIT - totalUsed),
    hourlyRemaining: Math.max(0, env.AUTO_RIA_HOURLY_REQUEST_LIMIT - hourlyUsed),
    paidMethodsEnabled: env.AUTO_RIA_PAID_ENRICHMENT_ENABLED,
    vinLookupEnabled: env.AUTO_RIA_VIN_LOOKUP_ENABLED,
    averagePriceEnabled: env.AUTO_RIA_AVERAGE_PRICE_ENABLED,
    initialWindowBehavior: env.INITIAL_WINDOW_BEHAVIOR,
    maxInitialWindowNotifications: env.MAX_INITIAL_WINDOW_NOTIFICATIONS,
    knownListingStopThreshold: env.KNOWN_LISTING_STOP_THRESHOLD,
  };
}

async function redisRollingCount(key: string, fromTimestamp: number): Promise<number> {
  try {
    const value = await Promise.race([
      redisConnection.zcount(key, fromTimestamp, "+inf"),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
    ]);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function redisNumber(key: string): Promise<number> {
  try {
    const value = await Promise.race([
      redisConnection.get(key),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}
