/**
 * Dashboard API types come from the same wire contract used by the local API.
 * Keep this compatibility facade so UI imports stay stable.
 */
export type {
  BulkSourceActionResponse,
  ChallengeIncidentRow,
  CollectorRunRow,
  ErrorLogRow,
  FilterHygieneWarning,
  FilterRow,
  ListingRow,
  MarketPriceEstimateRow,
  MetricSummary,
  MetricsResponse,
  MonitoringStateRow,
  MonitoringStatusResponse,
  QueueCounts,
  SearchPlanResponse,
  SearchPlanRow,
  SettingsResponse,
  SourceCapabilities,
  SourceDiscoveryToday,
  SourceKind,
  SourceMode,
  SourceRow,
  SourcesStatusResponse,
  SystemCheckResponse,
  TelegramNotificationRow,
  VehicleCheckRow,
} from "@amb/shared";
