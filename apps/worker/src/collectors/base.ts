import type { ListingDiscoveryLane, ListingSource, NormalizedListing } from "@amb/shared";

export type CollectorScanOptions = {
  lane: ListingDiscoveryLane;
  maxPages: number;
  maxCandidates: number;
  deadlineAt: Date;
  backfillProfile?: "FULL" | "LIGHT";
  /** Event-driven depth repair; OLX gives these requests priority over routine background work. */
  recovery?: boolean;
  /** Durable low-frequency OLX regional/HTML/private reconciliation only. */
  coverageOnly?: boolean;
  /** Recent OLX protection response: keep page one alive but suppress secondary/depth traffic. */
  olxProtectionCooling?: boolean;
  /** First safe OLX availability probe after a rate-limit/CAPTCHA pause. */
  olxProtectionProbe?: boolean;
  /**
   * Optional fast-path handoff for candidates already returned by a realtime
   * source. Collectors invoke it before slower pages/details/reconciliation so
   * Telegram delivery is not held behind the rest of a scan. The normal result
   * still contains the same listings for durable observation and cursor updates.
   */
  onHotCandidates?: (listings: readonly NormalizedListing[]) => Promise<void>;
};

export function collectorScanOptions(options?: CollectorScanOptions): CollectorScanOptions {
  return options ?? {
    lane: "REALTIME",
    maxPages: 1,
    maxCandidates: 50,
    deadlineAt: new Date(Date.now() + 20_000),
  };
}

export function scanDeadlineReached(options: CollectorScanOptions): boolean {
  return Date.now() >= options.deadlineAt.getTime();
}

export type SourceSearchContext = {
  source: ListingSource;
  fingerprint: string;
  filterIds: string[];
  autoRiaCategoryId?: number;
  autoRiaMarkId?: number;
  autoRiaModelId?: number;
  brand?: string;
  models: string[];
  bodyTypes: string[];
  fuelTypes: string[];
  gearboxes: string[];
  driveTypes: string[];
  colors: string[];
  yearFrom?: number;
  yearTo?: number;
  priceFrom?: number;
  priceTo?: number;
  mileageFrom?: number;
  mileageTo?: number;
  engineVolumeFrom?: number;
  engineVolumeTo?: number;
  enginePowerFrom?: number;
  enginePowerTo?: number;
  doorsFrom?: number;
  doorsTo?: number;
  seatsFrom?: number;
  seatsTo?: number;
  customsCleared?: boolean;
  bargainPossible?: boolean;
  regions: string[];
  cities: string[];
  keywords: string[];
  excludeKeywords: string[];
  freshnessMode: "LAST_HOUR" | "TODAY" | "LAST_24_HOURS" | "LAST_3_DAYS" | "LAST_7_DAYS" | "ALL_TIME";
  publishedAfter?: Date;
  initialWindowBehavior: "SKIP_EXISTING" | "NOTIFY_MATCHING_IN_WINDOW";
  maxInitialWindowNotifications: number;
};

export type SourceSearchState = {
  id: string;
  fingerprint: string;
  initialSyncCompletedAt?: Date;
  lastCursor?: string;
  lastExternalId?: string;
  lastPublishedAt?: Date;
  latestSeenPublishedAt?: Date;
  latestSeenExternalId?: string;
  oldestScannedPublishedAt?: Date;
  lastCompletedCutoff?: Date;
  lastPage?: number;
  newestFirstVerifiedAt?: Date;
  lastSuccessfulScanAt?: Date;
  nextCheckAt?: Date;
  lastRegionalCoverageAt?: Date;
  lastHtmlCoverageAt?: Date;
  htmlCoveragePausedUntil?: Date;
  lastPrivateCoverageAt?: Date;
  knownExternalIds: Set<string>;
  coverageAnchorExternalIds?: Set<string>;
  coverageRecoveryPending?: boolean;
  coverageRecoveryCutoffAt?: Date;
  knownIdsResetAt?: Date;
};

export type CollectorCoverageStateUpdate = {
  lastRegionalCoverageAt?: Date;
  lastHtmlCoverageAt?: Date;
  htmlCoveragePausedUntil?: Date | null;
  lastPrivateCoverageAt?: Date;
};

export type CollectorResult = {
  listings: NormalizedListing[];
  /** IDs safely classified during this scan; incomplete/overflow candidates must not be included. */
  scannedExternalIds?: string[];
  observedCount?: number;
  pageCount?: number;
  requestCount?: number;
  cutoffReached?: boolean;
  semanticWarnings?: string[];
  quotaDeferredSeconds?: number;
  /** Set when the source responded with 403 / 429 / captcha-like content. */
  rateLimited?: boolean;
  captchaDetected?: boolean;
  /** Retry-After hint (seconds) provided by the source alongside a rate limit. */
  retryAfterSeconds?: number;
  limited?: boolean;
  limitedReason?: string;
  detector?: string;
  responseStatus?: number;
  affectedUrl?: string;
  /** Realtime pagination did not overlap the previous cursor; recover immediately. */
  coverageGap?: boolean;
  /** The scan overlapped a durable anchor or reached its continuity cutoff. */
  coverageVerified?: boolean;
  /** Durable evidence used to close a pending offline/overflow recovery window. */
  coverageVerificationMethod?: "KNOWN_TAIL" | "CUTOFF" | "EXHAUSTED";
  /** Per-search-fingerprint low-frequency coverage timestamps to persist atomically with scan success. */
  coverageStateUpdate?: CollectorCoverageStateUpdate;
  /** Bounded structured diagnostics used to prove which discovery lanes ran. */
  coverageMetrics?: Record<string, string | number | boolean | null>;
};

/**
 * Every source is a separate collector module.
 * A collector only fetches fresh listings and normalizes them into
 * NormalizedListing. It never touches Telegram, OCR or vehicle checks.
 */
export interface SourceCollector {
  readonly source: ListingSource;
  readonly supportsNewestFirst?: boolean;
  readonly newestFirstVerified?: boolean;
  /**
   * Fetches the latest listings.
   * `context` carries the source-specific search query built from active
   * filters. `state.knownExternalIds` enables incremental scan per query:
   * the collector may stop paginating after a reliable overlap with the known
   * tail for the same context; one isolated known/promoted card is not enough.
   */
  collect(context: SourceSearchContext, state: SourceSearchState, options?: CollectorScanOptions): Promise<CollectorResult>;
}
