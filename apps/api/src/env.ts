import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", ".env");
config({ path: rootEnvPath });

function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative finite number`);
  return parsed;
}

function booleanEnv(key: string, fallback = false): boolean {
  const value = process.env[key];
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${key} must be true/false or 1/0`);
}

function enumEnv<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const value = process.env[key] as T | undefined;
  if (!value || value.trim() === "") return fallback;
  if (!values.includes(value)) throw new Error(`${key} must be one of: ${values.join(", ")}`);
  return value;
}

export const env = {
  API_PORT: numberEnv("API_PORT", 4000),
  API_HOST: process.env.API_HOST ?? "127.0.0.1",
  DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN ?? "http://localhost:3001",
  LOCAL_API_TOKEN: process.env.LOCAL_API_TOKEN ?? "",
  API_REQUIRE_LOCAL_TOKEN_FOR_ALL: booleanEnv("API_REQUIRE_LOCAL_TOKEN_FOR_ALL", true),
  REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  TELEGRAM_CONTROL_BOT_ENABLED: booleanEnv("TELEGRAM_CONTROL_BOT_ENABLED", true),
  TELEGRAM_CONTROL_NOTIFY_ON_START: booleanEnv("TELEGRAM_CONTROL_NOTIFY_ON_START", true),
  AUTO_RIA_API_KEY: process.env.AUTO_RIA_API_KEY ?? "",
  AUTO_RIA_USER_ID: process.env.AUTO_RIA_USER_ID ?? "",
  AUTO_RIA_TOTAL_REQUEST_LIMIT: numberEnv("AUTO_RIA_TOTAL_REQUEST_LIMIT", 1000),
  AUTO_RIA_HOURLY_REQUEST_LIMIT: numberEnv("AUTO_RIA_HOURLY_REQUEST_LIMIT", 30),
  AUTO_RIA_SOFT_RESERVE: numberEnv("AUTO_RIA_SOFT_RESERVE", 100),
  AUTO_RIA_MIN_SEARCH_RESERVE: numberEnv("AUTO_RIA_MIN_SEARCH_RESERVE", 50),
  AUTO_RIA_MAX_INFO_PER_SCAN: numberEnv("AUTO_RIA_MAX_INFO_PER_SCAN", 10),
  AUTO_RIA_PAID_ENRICHMENT_ENABLED: booleanEnv("AUTO_RIA_PAID_ENRICHMENT_ENABLED", false),
  AUTO_RIA_VIN_LOOKUP_ENABLED: booleanEnv("AUTO_RIA_VIN_LOOKUP_ENABLED", false),
  AUTO_RIA_AVERAGE_PRICE_ENABLED: booleanEnv("AUTO_RIA_AVERAGE_PRICE_ENABLED", false),
  MOCK_SOURCE_ENABLED: booleanEnv("MOCK_SOURCE_ENABLED", false),
  MONITOR_INTERVAL_SECONDS: numberEnv("MONITOR_INTERVAL_SECONDS", 120),
  MONITOR_JITTER_SECONDS: numberEnv("MONITOR_JITTER_SECONDS", 20),
  SCHEDULER_MIN_SLEEP_MS: numberEnv("SCHEDULER_MIN_SLEEP_MS", 100),
  SCHEDULER_MAX_SLEEP_MS: numberEnv("SCHEDULER_MAX_SLEEP_MS", 1_000),
  BACKFILL_INTERVAL_SECONDS: numberEnv("BACKFILL_INTERVAL_SECONDS", 120),
  BACKFILL_INITIAL_DELAY_SECONDS: numberEnv("BACKFILL_INITIAL_DELAY_SECONDS", 15),
  BACKFILL_MAX_PAGES: numberEnv("BACKFILL_MAX_PAGES", 4),
  BACKFILL_MAX_CANDIDATES: numberEnv("BACKFILL_MAX_CANDIDATES", 800),
  BACKFILL_MAX_DURATION_MS: numberEnv("BACKFILL_MAX_DURATION_MS", 60_000),
  WORKER_CONCURRENCY_COLLECTOR_BACKFILL: numberEnv("WORKER_CONCURRENCY_COLLECTOR_BACKFILL", 1),
  WORKER_HEARTBEAT_STALE_SECONDS: numberEnv("WORKER_HEARTBEAT_STALE_SECONDS", 10 * 60),
  LIVE_OLX_INTERVAL_SECONDS: numberEnv("LIVE_OLX_INTERVAL_SECONDS", 5),
  LIVE_OLX_JITTER_SECONDS: numberEnv("LIVE_OLX_JITTER_SECONDS", 0),
  OLX_HTML_COVERAGE_INTERVAL_SECONDS: numberEnv("OLX_HTML_COVERAGE_INTERVAL_SECONDS", 60),
  OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS: numberEnv("OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS", 90),
  LIVE_CARS_UA_INTERVAL_SECONDS: numberEnv("LIVE_CARS_UA_INTERVAL_SECONDS", 6),
  LIVE_CARS_UA_JITTER_SECONDS: numberEnv("LIVE_CARS_UA_JITTER_SECONDS", 1),
  LIVE_AUTOMOTO_INTERVAL_SECONDS: numberEnv("LIVE_AUTOMOTO_INTERVAL_SECONDS", 60),
  LIVE_AUTOMOTO_JITTER_SECONDS: numberEnv("LIVE_AUTOMOTO_JITTER_SECONDS", 10),
  LIVE_RST_INTERVAL_SECONDS: numberEnv("LIVE_RST_INTERVAL_SECONDS", 12),
  LIVE_RST_JITTER_SECONDS: numberEnv("LIVE_RST_JITTER_SECONDS", 1),
  LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS: numberEnv("LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS", 90),
  LIVE_AUTO_RIA_JITTER_SECONDS: numberEnv("LIVE_AUTO_RIA_JITTER_SECONDS", 10),
  AUTO_RIA_SEARCH_REQUESTS_PER_HOUR: numberEnv("AUTO_RIA_SEARCH_REQUESTS_PER_HOUR", 20),
  ALLOW_MANUAL_CHECK_WHEN_STOPPED: booleanEnv("ALLOW_MANUAL_CHECK_WHEN_STOPPED", false),
  MANUAL_CHECK_DEDUP_SECONDS: numberEnv("MANUAL_CHECK_DEDUP_SECONDS", 30),
  INITIAL_WINDOW_BEHAVIOR: enumEnv("INITIAL_WINDOW_BEHAVIOR", ["SKIP_EXISTING", "NOTIFY_MATCHING_IN_WINDOW"] as const, "SKIP_EXISTING"),
  MAX_INITIAL_WINDOW_NOTIFICATIONS: numberEnv("MAX_INITIAL_WINDOW_NOTIFICATIONS", 50),
  KNOWN_LISTING_STOP_THRESHOLD: numberEnv("KNOWN_LISTING_STOP_THRESHOLD", 10),
} as const;

function assertIntegerRange(key: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
}

assertIntegerRange("API_PORT", env.API_PORT, 1, 65_535);
assertIntegerRange("MONITOR_INTERVAL_SECONDS", env.MONITOR_INTERVAL_SECONDS, 1, 86_400);
assertIntegerRange("SCHEDULER_MIN_SLEEP_MS", env.SCHEDULER_MIN_SLEEP_MS, 25, 60_000);
assertIntegerRange("SCHEDULER_MAX_SLEEP_MS", env.SCHEDULER_MAX_SLEEP_MS, 25, 60_000);
if (env.SCHEDULER_MAX_SLEEP_MS < env.SCHEDULER_MIN_SLEEP_MS) {
  throw new Error("SCHEDULER_MAX_SLEEP_MS must be greater than or equal to SCHEDULER_MIN_SLEEP_MS");
}
assertIntegerRange("BACKFILL_INTERVAL_SECONDS", env.BACKFILL_INTERVAL_SECONDS, 10, 86_400);
assertIntegerRange("BACKFILL_MAX_PAGES", env.BACKFILL_MAX_PAGES, 1, 100);
assertIntegerRange("BACKFILL_MAX_CANDIDATES", env.BACKFILL_MAX_CANDIDATES, 1, 10_000);
assertIntegerRange("WORKER_CONCURRENCY_COLLECTOR_BACKFILL", env.WORKER_CONCURRENCY_COLLECTOR_BACKFILL, 1, 16);
