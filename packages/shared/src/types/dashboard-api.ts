import type { UserFilter } from "./filter.js";
import type {
  ListingDto,
  ListingSource,
  MarketPriceEstimateDto,
  TelegramNotificationDto,
  VehicleCheckDto,
} from "./listing.js";
import type { SourceCapabilities } from "./source-capabilities.js";
import type { JournalLatencySummary, MetricSummary } from "../utils/metrics.js";

/**
 * Wire-level contract shared by the local API and Dashboard.
 * DateValue is Date inside the API and an ISO string after JSON serialization.
 */
export type SourceKind = ListingSource;

export type SourceRow<DateValue = string> = {
  id: string;
  source: SourceKind;
  name: string;
  enabled: boolean;
  status: "ACTIVE" | "PAUSED" | "LIMITED" | "ERROR" | "RATE_LIMITED" | "CAPTCHA_DETECTED" | "DISABLED";
  supportsNewestFirst: boolean;
  newestFirstVerified: boolean;
  newestFirstVerifiedAt: DateValue | null;
  initialSyncCompletedAt: DateValue | null;
  intervalSeconds: number;
  lastCheckedAt: DateValue | null;
  nextCheckAt: DateValue | null;
  consecutiveErrors: number;
  consecutiveEmptyResults: number;
  lastError: string | null;
  pausedUntil: DateValue | null;
  lastSuccessfulAt: DateValue | null;
  lastNonEmptyAt: DateValue | null;
  lastDurationMs: number | null;
  healthScore: number;
  jitterSeconds: number;
  createdAt: DateValue;
  updatedAt: DateValue;
  capabilities?: SourceCapabilities;
};

export type MonitoringStateRow<DateValue = string> = {
  id: string;
  status: "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "ERROR" | "RATE_LIMITED" | "CAPTCHA_DETECTED";
  generation: number;
  intervalSeconds: number;
  jitterSeconds: number;
  startedAt: DateValue | null;
  stoppedAt: DateValue | null;
  lastTickAt: DateValue | null;
  nextTickAt: DateValue | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

export type QueueCounts = Record<string, {
  waiting: number;
  active: number;
  delayed?: number;
  prioritized?: number;
  failed: number;
  failedRecent?: number;
}>;

export type CollectorRunRow<DateValue = string> = {
  id: string;
  source: SourceKind;
  status: string;
  lane: "REALTIME" | "BACKFILL" | "COVERAGE" | "MANUAL";
  trigger: "SCHEDULED" | "MANUAL" | "BACKFILL" | "RECOVERY" | "COVERAGE";
  startedAt: DateValue;
  finishedAt: DateValue | null;
  foundCount: number;
  newCount: number;
  recoveredCount: number;
  pageCount: number;
  requestCount: number;
  observedCount: number;
  semanticWarnings: string[];
  errorMessage: string | null;
  createdAt: DateValue;
};

export type ChallengeIncidentRow<DateValue = string> = {
  id: string;
  sourceId: string;
  detector: string;
  responseStatus: number | null;
  affectedUrlHash: string | null;
  detectedAt: DateValue;
  cooldownUntil: DateValue | null;
  status: "DETECTED" | "COOLDOWN" | "MANUAL_VERIFICATION_REQUIRED" | "PROBE_PENDING" | "RECOVERING" | "RESOLVED" | "REPEATED";
  probeAttempts: number;
  lastProbeAt: DateValue | null;
  recoveredAt: DateValue | null;
  resolution: string | null;
  metadataRedacted: unknown;
  createdAt: DateValue;
  updatedAt: DateValue;
  source?: { source: SourceKind; name: string };
};

export type SourceDiscoveryToday = {
  source: SourceKind;
  count: number;
};

export type SourcesStatusResponse<DateValue = string> = {
  sources: SourceRow<DateValue>[];
  recentRuns: CollectorRunRow<DateValue>[];
  challengeIncidents: ChallengeIncidentRow<DateValue>[];
  discoveredToday: SourceDiscoveryToday[];
  generatedAt: DateValue;
};

export type MonitoringStatusResponse<DateValue = string> = {
  state: MonitoringStateRow<DateValue>;
  sources: SourceRow<DateValue>[];
  mode: "LIVE" | "STANDARD";
  queues: QueueCounts;
  filters: { total: number; active: number; activeReal: number };
  foundToday: number;
  lastRun: CollectorRunRow<DateValue> | null;
  telegramConfigured: boolean;
};

export type FilterRow = UserFilter;
export type VehicleCheckRow = VehicleCheckDto;
export type MarketPriceEstimateRow = MarketPriceEstimateDto;
export type TelegramNotificationRow = TelegramNotificationDto & { createdAt: string };

export type ListingRow = Omit<ListingDto, "vehicleCheck" | "marketPriceEstimate" | "telegramNotification"> & {
  vehicleChecks?: VehicleCheckRow[];
  marketPriceEstimate?: MarketPriceEstimateRow | null;
  telegramNotifications?: TelegramNotificationRow[];
};

export type ErrorLogRow<DateValue = string> = {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  scope: string;
  message: string;
  details: string | null;
  occurrences: number;
  firstSeenAt: DateValue;
  lastSeenAt: DateValue;
  createdAt: DateValue;
};

export type SettingsResponse = {
  intervalSeconds: number;
  jitterSeconds: number;
  telegramChatId: string | null;
  telegramConfigured: boolean;
};

export type SystemCheckResponse = {
  status: "OK" | "WARN" | "FAIL";
  checkedAt: string;
  checks: Array<{ name: string; status: "OK" | "WARN" | "FAIL"; message: string }>;
};

export type BulkSourceActionResponse = {
  ok: boolean;
  updated?: number;
  count?: number;
  sources?: SourceKind[] | readonly SourceKind[];
  queued?: SourceKind[];
  deduplicated?: SourceKind[];
};

export type MetricsResponse<DateValue = string> = {
  generatedAt: string;
  latencyWindow: {
    startedAt: string;
    endedAt: string;
    hours: 24;
    basis: "SourceSeenListing.firstSeenAt";
  };
  sampleSize: {
    collectorRuns: number;
    realtimeObservations: number;
    publicationTimestamps: number;
    telegramNotifications: number;
  };
  collectorDurationMs: MetricSummary;
  publicationTimestampToFirstSeenMs: MetricSummary;
  firstSeenToTelegramMs: MetricSummary;
  publicationTimestampToTelegramMs: MetricSummary;
  requestStartToFirstByteMs: MetricSummary;
  firstByteToHotCandidateMs: MetricSummary;
  hotCandidateToDurableJournalMs: MetricSummary;
  durableJournalToTelegramAcceptanceMs: MetricSummary;
  requestStartToTelegramAcceptanceMs: MetricSummary;
  /** @deprecated Compatibility alias for publicationTimestampToFirstSeenMs. */
  publicationToDetectionMs: MetricSummary;
  /** @deprecated Compatibility alias for firstSeenToTelegramMs. */
  detectionToTelegramMs: MetricSummary;
  /** @deprecated Compatibility alias for publicationTimestampToTelegramMs. */
  totalNotificationLatencyMs: MetricSummary;
  latencyBySource: Array<{
    source: SourceKind;
    collectorDurationMs: MetricSummary;
    publicationTimestampToFirstSeenMs: MetricSummary;
    firstSeenToTelegramMs: MetricSummary;
    publicationTimestampToTelegramMs: MetricSummary;
    requestStartToFirstByteMs: MetricSummary;
    firstByteToHotCandidateMs: MetricSummary;
    hotCandidateToDurableJournalMs: MetricSummary;
    durableJournalToTelegramAcceptanceMs: MetricSummary;
    requestStartToTelegramAcceptanceMs: MetricSummary;
    /** @deprecated Compatibility alias for publicationTimestampToFirstSeenMs. */
    publicationToDetectionMs: MetricSummary;
    /** @deprecated Compatibility alias for firstSeenToTelegramMs. */
    detectionToTelegramMs: MetricSummary;
  }>;
  latencySemantics: {
    publicationTimestampToFirstSeenMs: "SOURCE_REPORTED_PUBLICATION_TO_FIRST_PERSISTED_OBSERVATION";
    firstSeenToTelegramMs: "FIRST_PERSISTED_OBSERVATION_TO_CONFIRMED_TELEGRAM_SEND";
    publicationTimestampToTelegramMs: "SOURCE_REPORTED_PUBLICATION_TO_CONFIRMED_TELEGRAM_SEND";
    requestStartToFirstByteMs: "SOURCE_HTTP_REQUEST_START_TO_RESPONSE_HEADERS";
    firstByteToHotCandidateMs: "SOURCE_RESPONSE_HEADERS_TO_HOT_CANDIDATE";
    hotCandidateToDurableJournalMs: "HOT_CANDIDATE_TO_DURABLE_JOURNAL";
    durableJournalToTelegramAcceptanceMs: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE";
    requestStartToTelegramAcceptanceMs: "SOURCE_HTTP_REQUEST_START_TO_TELEGRAM_ACCEPTANCE";
  };
  currentSession: {
    startedAt: string;
    catchUpUntil: string;
    firstOlxSuccessAt: string | null;
    startupToFirstOlxSuccessMs: number | null;
    catchUp: JournalLatencySummary & { observations: number };
    steadyState: JournalLatencySummary & { observations: number };
  };
  timestampConfidence: { preciseLatencyOnlyFor: string[] };
  coverageToday: {
    realtime: number;
    recovered: number;
    coverage: number;
    manual: number;
    telegramSent: number;
    telegramPending: number;
    telegramFailed: number;
    observations: number;
    observationsRejected: number;
    observationsNotified: number;
    observationsPending: number;
  };
  laneRunsToday: Array<{
    lane: "REALTIME" | "BACKFILL" | "COVERAGE" | "MANUAL";
    runs: number;
    found: number;
    new: number;
    recovered: number;
    pages: number;
    requests: number;
    observed: number;
    matched: number;
    rejected: number;
    duplicates: number;
    dispatched: number;
  }>;
  latestCompletenessAudit: unknown | null;
  slo: {
    collectorP95Under2Seconds: boolean;
    telegramP95Under3Seconds: boolean | null;
    telegramP95Metric: "DURABLE_JOURNAL_TO_TELEGRAM_ACCEPTANCE";
    telegramP95Status: "PASS" | "FAIL" | "LOW_SAMPLE";
    telegramMinimumSampleSize: number;
    unresolvedObservationsToday: number;
  };
  sourceHealth: Array<{
    source: SourceKind;
    name: string;
    status: SourceRow<DateValue>["status"];
    healthScore: number;
    consecutiveErrors: number;
    consecutiveEmptyResults: number;
    lastSuccessfulAt: DateValue | null;
    lastNonEmptyAt: DateValue | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }>;
};

export type SearchPlanResponse<DateValue = string> = {
  generatedAt: string;
  totals: {
    activeFilters: number;
    plannedContexts: number;
    activeSources: number;
    initialSyncPending: number;
    blocked: number;
    warnings: number;
    autoRiaContexts: number;
    autoRiaEstimatedRequestsPerScan: number;
  };
  autoRia: {
    configured: boolean;
    userIdConfigured: boolean;
    totalLimit: number;
    hourlyLimit: number;
    softReserve: number;
    minSearchReserve: number;
    maxInfoPerScan: number;
    totalUsed: number;
    hourlyUsed: number;
    totalRemaining: number;
    hourlyRemaining: number;
    paidMethodsEnabled: boolean;
    vinLookupEnabled: boolean;
    averagePriceEnabled: boolean;
    initialWindowBehavior: "SKIP_EXISTING" | "NOTIFY_MATCHING_IN_WINDOW";
    maxInitialWindowNotifications: number;
    knownListingStopThreshold: number;
  };
  olxDiscovery: {
    windowHours: number;
    channels: Array<{
      channel: string;
      sampleCount: number;
      latencySampleCount: number;
      p50Seconds: number | null;
      p95Seconds: number | null;
      maxSeconds: number | null;
    }>;
  };
  olxCadenceCanary: {
    configured: boolean;
    mode: "BASELINE" | "CANARY" | "PROMOTED" | "ROLLED_BACK" | "DISABLED";
    baseIntervalSeconds: number;
    baseJitterSeconds: number;
    canaryIntervalSeconds: number;
    canaryJitterSeconds: number;
    qualificationRuns: number;
    qualificationRunsRequired: number;
    promotionRuns: number;
    promotionRunsRequired: number;
    qualificationMaximumP95Ms: number;
    rollbackMaximumP95Ms: number;
    baselineP95Ms: number | null;
    currentP95Ms: number | null;
    rollbackReason: string | null;
    qualificationStartedAt: DateValue | null;
    canaryStartedAt: DateValue | null;
    lastTransitionAt: DateValue | null;
  };
  offlineRecovery: {
    status: "NONE" | "PENDING" | "VERIFIED";
    pendingCount: number;
    latest: {
      id: string;
      reason: "OFFLINE_WINDOW" | "REALTIME_OVERFLOW" | "KNOWN_IDS_RESET";
      status: "PENDING" | "VERIFIED";
      persistedBoundaryAt: DateValue;
      requiredCutoffAt: DateValue;
      detectedAt: DateValue;
      latestSeenAt: DateValue | null;
      lastAttemptAt: DateValue | null;
      lastAttemptRunId: string | null;
      verifiedAt: DateValue | null;
      verifiedRunId: string | null;
      verificationMethod: "KNOWN_TAIL" | "CUTOFF" | "EXHAUSTED" | null;
      oldestObservedAt: DateValue | null;
      pageCount: number;
      requestCount: number;
      observedCount: number;
    } | null;
  };
  coverage: {
    intervalSeconds: number;
    initialDelaySeconds: number;
    maxDurationMs: number;
    concurrency: number;
  };
  telegramFlash: {
    enabled: boolean;
    minItems: number;
    maxItems: number;
    concurrency: number;
    sendIntervalMs: number;
  };
  backfill: {
    intervalSeconds: number;
    initialDelaySeconds: number;
    maxPages: number;
    maxCandidates: number;
    maxDurationMs: number;
    concurrency: number;
  };
  plans: SearchPlanRow<DateValue>[];
};

export type SearchPlanRow<DateValue = string> = {
  id: string;
  source: SourceKind;
  sourceEnabled: boolean;
  sourceStatus: SourceRow<DateValue>["status"];
  sourceNextCheckAt: DateValue | null;
  filterId: string;
  filterName: string;
  freshnessMode: FilterRow["freshnessMode"];
  filterSummary: string;
  initialSyncCompletedAt: DateValue | null;
  lastSuccessfulScanAt: DateValue | null;
  lastPublishedAt: DateValue | null;
  latestSeenPublishedAt: DateValue | null;
  latestSeenExternalId: string | null;
  oldestScannedPublishedAt: DateValue | null;
  lastCompletedCutoff: DateValue | null;
  lastPage: number | null;
  newestFirstVerifiedAt: DateValue | null;
  lastRegionalCoverageAt: DateValue | null;
  lastHtmlCoverageAt: DateValue | null;
  htmlCoveragePausedUntil: DateValue | null;
  lastPrivateCoverageAt: DateValue | null;
  lastExternalId: string | null;
  knownExternalIds: number;
  coverageRecoveryPending: boolean;
  coverageRecoveryCutoffAt: DateValue | null;
  fingerprint: string | null;
  estimatedRequestsPerScan: number;
  supported: {
    mode: "api-filtered" | "html-newest" | "html-local-sort" | "html-limited" | "event-filtered";
    apiFields: string[];
    postFilterFields: string[];
  };
  issues: Array<{ level: "ok" | "warning" | "danger"; message: string }>;
  severity: "ok" | "warning" | "danger";
  recentRun: {
    lane: string;
    status: string;
    foundCount: number;
    newCount: number;
    pageCount: number;
    durationMs: number | null;
    errorMessage: string | null;
    finishedAt: DateValue | null;
    coverageMetrics: unknown;
  } | null;
};
