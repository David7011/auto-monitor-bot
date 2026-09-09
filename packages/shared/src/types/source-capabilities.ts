import type { ListingSource } from "./listing.js";
import { MARKETPLACE_CATEGORY_KEYS, type MarketplaceCategoryKey } from "./category.js";

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
  supportedCategories: readonly MarketplaceCategoryKey[];
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
    supportedCategories: ["vehicle.car"],
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
    supportedCategories: MARKETPLACE_CATEGORY_KEYS,
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
    supportedCategories: ["vehicle.car"],
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
    supportedCategories: ["vehicle.car"],
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
    supportedCategories: ["vehicle.car"],
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
    supportedCategories: MARKETPLACE_CATEGORY_KEYS,
  },
};
