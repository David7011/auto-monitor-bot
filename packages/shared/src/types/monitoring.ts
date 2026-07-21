import type { ListingSource } from "./listing.js";

export type MonitoringStatus =
  | "STOPPED"
  | "STARTING"
  | "RUNNING"
  | "PAUSED"
  | "ERROR"
  | "RATE_LIMITED"
  | "CAPTCHA_DETECTED";

export type SourceStatus =
  | "ACTIVE"
  | "PAUSED"
  | "LIMITED"
  | "ERROR"
  | "RATE_LIMITED"
  | "CAPTCHA_DETECTED"
  | "DISABLED";

export type MonitoringStateDto = {
  id: string;
  status: MonitoringStatus;
  generation: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  intervalSeconds: number;
  jitterSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type SourceDto = {
  id: string;
  source: ListingSource;
  name: string;
  status: SourceStatus;
  enabled: boolean;
  supportsNewestFirst: boolean;
  newestFirstVerified: boolean;
  newestFirstVerifiedAt: string | null;
  initialSyncCompletedAt: string | null;
  intervalSeconds: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  pausedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CollectorRunStatus =
  | "RUNNING"
  | "SUCCESS"
  | "LIMITED"
  | "SKIPPED"
  | "CANCELLED_BY_USER"
  | "FAILED"
  | "RATE_LIMITED"
  | "CAPTCHA_DETECTED";

export type CollectorRunDto = {
  id: string;
  source: ListingSource;
  status: CollectorRunStatus;
  startedAt: string;
  finishedAt: string | null;
  foundCount: number;
  newCount: number;
  errorMessage: string | null;
  createdAt: string;
};

export type ErrorLogLevel = "INFO" | "WARN" | "ERROR";

export type ErrorLogDto = {
  id: string;
  level: ErrorLogLevel;
  scope: string;
  message: string;
  details: string | null;
  createdAt: string;
};

export type SettingsDto = {
  intervalSeconds: number;
  jitterSeconds: number;
  telegramChatId: string | null;
  telegramConfigured: boolean;
};
