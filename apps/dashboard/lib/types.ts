export type SourceKind = "AUTO_RIA" | "OLX" | "RST" | "CARS_UA" | "AUTOMOTO" | "MOCK"
export type SourceMode = "OFFICIAL_API" | "PUBLIC_HTTP" | "EVENT" | "MANUAL_ONLY" | "DISCOVERY_AGGREGATOR"

export type SourceCapabilities = {
  accessMode: SourceMode
  supportsEventMode: boolean
  supportsPolling: boolean
  supportsNewestFirst: boolean
  newestFirstVerified: boolean
  supportsPublishedAt: boolean
  supportsPagination: boolean
  supportsIncrementalCursor: boolean
  supportsImages: boolean
  supportsStableExternalId: boolean
  supportsServerSideFiltering: boolean
  supportsRegionFilter: boolean
  supportsCityFilter: boolean
}

export type SourceRow = {
  id: string
  source: SourceKind
  name: string
  enabled: boolean
  status: "ACTIVE" | "PAUSED" | "LIMITED" | "ERROR" | "RATE_LIMITED" | "CAPTCHA_DETECTED" | "DISABLED"
  supportsNewestFirst: boolean
  newestFirstVerified: boolean
  newestFirstVerifiedAt: string | null
  lastRegionalCoverageAt: string | null
  lastHtmlCoverageAt: string | null
  htmlCoveragePausedUntil: string | null
  lastPrivateCoverageAt: string | null
  initialSyncCompletedAt: string | null
  intervalSeconds: number
  lastCheckedAt: string | null
  nextCheckAt: string | null
  consecutiveErrors: number
  consecutiveEmptyResults: number
  lastError: string | null
  pausedUntil: string | null
  lastSuccessfulAt: string | null
  lastNonEmptyAt: string | null
  lastDurationMs: number | null
  healthScore: number
  jitterSeconds: number
  createdAt: string
  updatedAt: string
  capabilities?: SourceCapabilities
}

export type MonitoringStateRow = {
  id: string
  status: "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "ERROR" | "RATE_LIMITED" | "CAPTCHA_DETECTED"
  generation: number
  intervalSeconds: number
  jitterSeconds: number
  startedAt: string | null
  stoppedAt: string | null
  lastTickAt: string | null
  nextTickAt: string | null
  createdAt: string
  updatedAt: string
}

export type QueueCounts = Record<string, { waiting: number; active: number; failed: number }>

export type CollectorRunRow = {
  id: string
  source: SourceKind
  status: string
  lane: "REALTIME" | "BACKFILL" | "MANUAL"
  startedAt: string
  finishedAt: string | null
  foundCount: number
  newCount: number
  recoveredCount: number
  pageCount: number
  requestCount: number
  observedCount: number
  semanticWarnings: string[]
  errorMessage: string | null
  createdAt: string
}

export type ChallengeIncidentRow = {
  id: string
  sourceId: string
  detector: string
  responseStatus: number | null
  affectedUrlHash: string | null
  detectedAt: string
  cooldownUntil: string | null
  status: "DETECTED" | "COOLDOWN" | "MANUAL_VERIFICATION_REQUIRED" | "PROBE_PENDING" | "RECOVERING" | "RESOLVED" | "REPEATED"
  probeAttempts: number
  lastProbeAt: string | null
  recoveredAt: string | null
  resolution: string | null
  metadataRedacted: unknown
  createdAt: string
  updatedAt: string
  source?: {
    source: SourceKind
    name: string
  }
}

export type MonitoringStatusResponse = {
  state: MonitoringStateRow
  sources: SourceRow[]
  mode: "LIVE" | "STANDARD"
  queues: QueueCounts
  filters: {
    total: number
    active: number
    activeReal: number
  }
  foundToday: number
  lastRun: CollectorRunRow | null
  telegramConfigured: boolean
}

export type FilterRow = {
  id: string
  name: string
  enabled: boolean
  sources: SourceKind[]
  autoRiaCategoryId: number | null
  autoRiaMarkId: number | null
  autoRiaModelId: number | null
  brand: string | null
  model: string | null
  modelNames: string[]
  generation: string | null
  bodyTypes: string[]
  fuelTypes: string[]
  gearboxes: string[]
  driveTypes: string[]
  colors: string[]
  engineVolumeFrom: number | null
  engineVolumeTo: number | null
  enginePowerFrom: number | null
  enginePowerTo: number | null
  doorsFrom: number | null
  doorsTo: number | null
  seatsFrom: number | null
  seatsTo: number | null
  conditions: string[]
  customsCleared: boolean | null
  bargainPossible: boolean | null
  freshnessMode: "LAST_HOUR" | "TODAY" | "LAST_24_HOURS" | "LAST_3_DAYS" | "LAST_7_DAYS" | "ALL_TIME"
  yearFrom: number | null
  yearTo: number | null
  priceFrom: number | null
  priceTo: number | null
  mileageFrom: number | null
  mileageTo: number | null
  regions: string[]
  cities: string[]
  keywords: string[]
  excludeKeywords: string[]
  createdAt: string
  updatedAt: string
}

export type VehicleCheckRow = {
  id: string
  listingId: string
  plateRaw: string | null
  plateNormalized: string | null
  vin: string | null
  checkStatus: string
  make: string | null
  model: string | null
  year: number | null
  engineVolume: number | null
  fuelType: string | null
  bodyType: string | null
  driveType: string | null
  color: string | null
  mileage: number | null
  accidents: string | null
  restrictions: string | null
  provider: string | null
  discrepancies: string[]
  createdAt: string
  updatedAt: string
}

export type MarketPriceEstimateRow = {
  id: string
  listingId: string
  status: "READY" | "INSUFFICIENT_DATA" | "FAILED"
  verdict: "UNKNOWN" | "HIGH_RISK_BARGAIN" | "BELOW_MARKET" | "FAIR" | "ABOVE_MARKET"
  targetPrice: number | null
  sampleSize: number
  averagePrice: number | null
  medianPrice: number | null
  q1Price: number | null
  q3Price: number | null
  minPrice: number | null
  maxPrice: number | null
  fairLowPrice: number | null
  fairHighPrice: number | null
  currency: string
  sources: SourceKind[]
  params: unknown
  createdAt: string
  updatedAt: string
}

export type TelegramNotificationRow = {
  id: string
  listingId: string
  chatId: string
  messageId: string | null
  status: string
  lastText: string | null
  attemptCount: number
  processingStartedAt: string | null
  lastAttemptAt: string | null
  leaseExpiresAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  sentAt: string | null
  updatedAt: string
  createdAt: string
}

export type ListingRow = {
  id: string
  source: SourceKind
  discoveryLane: "REALTIME" | "BACKFILL" | "MANUAL"
  externalId: string
  url: string
  canonicalUrl: string
  title: string | null
  brand: string | null
  model: string | null
  bodyType: string | null
  fuelType: string | null
  gearbox: string | null
  driveType: string | null
  color: string | null
  engineVolume: number | null
  enginePower: number | null
  doors: number | null
  seats: number | null
  condition: string | null
  customsCleared: boolean | null
  bargainPossible: boolean | null
  year: number | null
  priceOriginal: number | null
  currencyOriginal: string | null
  priceNormalized: number | null
  exchangeRateUsed: number | null
  exchangeRateDate: string | null
  mileage: number | null
  city: string | null
  region: string | null
  sellerPhone: string | null
  vin: string | null
  plateNormalized: string | null
  description: string | null
  photoUrls: string[]
  publishedAt: string | null
  refreshedAt: string | null
  timestampConfidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"
  skipReason: string | null
  firstSeenAt: string
  lastSeenAt: string
  status: string
  createdAt: string
  updatedAt: string
  vehicleChecks?: VehicleCheckRow[]
  marketPriceEstimate?: MarketPriceEstimateRow | null
  telegramNotifications?: TelegramNotificationRow[]
}

export type ErrorLogRow = {
  id: string
  level: "INFO" | "WARN" | "ERROR"
  scope: string
  message: string
  details: string | null
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
}

export type SettingsResponse = {
  intervalSeconds: number
  jitterSeconds: number
  telegramChatId: string | null
  telegramConfigured: boolean
}

export type SystemCheckResponse = {
  status: "OK" | "WARN" | "FAIL"
  checkedAt: string
  checks: Array<{
    name: string
    status: "OK" | "WARN" | "FAIL"
    message: string
  }>
}

export type BulkSourceActionResponse = {
  ok: boolean
  updated?: number
  count?: number
  sources?: SourceKind[] | readonly SourceKind[]
  queued?: SourceKind[]
  deduplicated?: SourceKind[]
}

export type MetricsResponse = {
  generatedAt: string
  sampleSize: {
    collectorRuns: number
    telegramNotifications: number
  }
  collectorDurationMs: MetricSummary
  publicationToDetectionMs: MetricSummary
  detectionToTelegramMs: MetricSummary
  totalNotificationLatencyMs: MetricSummary
  timestampConfidence: {
    preciseLatencyOnlyFor: string[]
  }
  coverageToday: {
    realtime: number
    recovered: number
    manual: number
    telegramSent: number
    telegramPending: number
    telegramFailed: number
  }
  laneRunsToday: Array<{
    lane: "REALTIME" | "BACKFILL" | "MANUAL"
    runs: number
    found: number
    new: number
    recovered: number
    pages: number
    requests: number
    observed: number
  }>
  sourceHealth: Array<{
    source: SourceKind
    name: string
    status: SourceRow["status"]
    healthScore: number
    consecutiveErrors: number
    consecutiveEmptyResults: number
    lastSuccessfulAt: string | null
    lastNonEmptyAt: string | null
    lastDurationMs: number | null
    lastError: string | null
  }>
}

export type MetricSummary = {
  count: number
  avg: number | null
  min: number | null
  max: number | null
  p50: number | null
  p95: number | null
}

export type SearchPlanResponse = {
  generatedAt: string
  totals: {
    activeFilters: number
    plannedContexts: number
    activeSources: number
    initialSyncPending: number
    blocked: number
    warnings: number
    autoRiaContexts: number
    autoRiaEstimatedRequestsPerScan: number
  }
  autoRia: {
    configured: boolean
    userIdConfigured: boolean
    totalLimit: number
    hourlyLimit: number
    softReserve: number
    minSearchReserve: number
    maxInfoPerScan: number
    totalUsed: number
    hourlyUsed: number
    totalRemaining: number
    hourlyRemaining: number
    paidMethodsEnabled: boolean
    vinLookupEnabled: boolean
    averagePriceEnabled: boolean
    initialWindowBehavior: "SKIP_EXISTING" | "NOTIFY_MATCHING_IN_WINDOW"
    maxInitialWindowNotifications: number
    knownListingStopThreshold: number
  }
  olxDiscovery: {
    windowHours: number
    channels: Array<{
      channel: string
      sampleCount: number
      latencySampleCount: number
      p50Seconds: number | null
      p95Seconds: number | null
      maxSeconds: number | null
    }>
  }
  backfill: {
    intervalSeconds: number
    initialDelaySeconds: number
    maxPages: number
    maxCandidates: number
    maxDurationMs: number
    concurrency: number
  }
  plans: SearchPlanRow[]
}

export type SearchPlanRow = {
  id: string
  source: SourceKind
  sourceEnabled: boolean
  sourceStatus: SourceRow["status"]
  sourceNextCheckAt: string | null
  filterId: string
  filterName: string
  freshnessMode: FilterRow["freshnessMode"]
  filterSummary: string
  initialSyncCompletedAt: string | null
  lastSuccessfulScanAt: string | null
  lastPublishedAt: string | null
  latestSeenPublishedAt: string | null
  latestSeenExternalId: string | null
  oldestScannedPublishedAt: string | null
  lastCompletedCutoff: string | null
  lastPage: number | null
  newestFirstVerifiedAt: string | null
  lastExternalId: string | null
  knownExternalIds: number
  fingerprint: string | null
  estimatedRequestsPerScan: number
  supported: {
    mode: "api-filtered" | "html-newest" | "html-local-sort" | "html-limited" | "event-filtered"
    apiFields: string[]
    postFilterFields: string[]
  }
  issues: Array<{ level: "ok" | "warning" | "danger"; message: string }>
  severity: "ok" | "warning" | "danger"
  recentRun: {
    lane: string
    status: string
    foundCount: number
    newCount: number
    pageCount: number
    durationMs: number | null
    errorMessage: string | null
    finishedAt: string | null
    coverageMetrics: unknown
  } | null
}
