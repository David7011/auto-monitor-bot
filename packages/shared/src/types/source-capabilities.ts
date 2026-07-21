import type { ListingSource } from "./listing.js";

export type SourceMode = "OFFICIAL_API" | "PUBLIC_HTTP" | "EVENT" | "MANUAL_ONLY" | "DISCOVERY_AGGREGATOR";

export type RuntimeSourceStatus =
  | "NOT_CONFIGURED"
  | "READY"
  | "ACTIVE"
  | "LIMITED"
  | "BACKOFF"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "PARSER_DEGRADED"
  | "MANUAL_VERIFICATION_REQUIRED"
  | "RECOVERING"
  | "PAUSED"
  | "DISABLED"
  | "ERROR";

export type SourceCapabilities = {
  accessMode: SourceMode;
  supportsEventMode: boolean;
  supportsPolling: boolean;
  supportsNewestFirst: boolean;
  newestFirstVerified: boolean;
  supportsPublishedAt: boolean;
  supportsPagination: boolean;
  supportsIncrementalCursor: boolean;
  supportsImages: boolean;
  supportsStableExternalId: boolean;
  supportsServerSideFiltering: boolean;
  supportsRegionFilter: boolean;
  supportsCityFilter: boolean;
};

export const SOURCE_CAPABILITIES: Record<ListingSource, SourceCapabilities> = {
  AUTO_RIA: {
    accessMode: "OFFICIAL_API",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: true,
    newestFirstVerified: true,
    supportsPublishedAt: true,
    supportsPagination: true,
    supportsIncrementalCursor: true,
    supportsImages: true,
    supportsStableExternalId: true,
    supportsServerSideFiltering: true,
    supportsRegionFilter: true,
    supportsCityFilter: true,
  },
  OLX: {
    accessMode: "PUBLIC_HTTP",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: true,
    newestFirstVerified: true,
    supportsPublishedAt: true,
    supportsPagination: false,
    supportsIncrementalCursor: false,
    supportsImages: true,
    supportsStableExternalId: true,
    supportsServerSideFiltering: false,
    supportsRegionFilter: false,
    supportsCityFilter: false,
  },
  RST: {
    accessMode: "PUBLIC_HTTP",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: false,
    newestFirstVerified: false,
    supportsPublishedAt: false,
    supportsPagination: false,
    supportsIncrementalCursor: false,
    supportsImages: true,
    supportsStableExternalId: true,
    supportsServerSideFiltering: false,
    supportsRegionFilter: false,
    supportsCityFilter: false,
  },
  CARS_UA: {
    accessMode: "PUBLIC_HTTP",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: true,
    newestFirstVerified: false,
    supportsPublishedAt: true,
    supportsPagination: false,
    supportsIncrementalCursor: false,
    supportsImages: true,
    supportsStableExternalId: true,
    supportsServerSideFiltering: false,
    supportsRegionFilter: false,
    supportsCityFilter: false,
  },
  AUTOMOTO: {
    accessMode: "DISCOVERY_AGGREGATOR",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: false,
    newestFirstVerified: false,
    supportsPublishedAt: true,
    supportsPagination: true,
    supportsIncrementalCursor: false,
    supportsImages: true,
    supportsStableExternalId: true,
    supportsServerSideFiltering: false,
    supportsRegionFilter: false,
    supportsCityFilter: false,
  },
  MOCK: {
    accessMode: "MANUAL_ONLY",
    supportsEventMode: false,
    supportsPolling: true,
    supportsNewestFirst: true,
    newestFirstVerified: true,
    supportsPublishedAt: true,
    supportsPagination: false,
    supportsIncrementalCursor: false,
    supportsImages: false,
    supportsStableExternalId: true,
    supportsServerSideFiltering: false,
    supportsRegionFilter: false,
    supportsCityFilter: false,
  },
};
