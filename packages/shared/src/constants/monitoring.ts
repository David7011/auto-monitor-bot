export const DEFAULT_INTERVAL_SECONDS = 120;
export const DEFAULT_JITTER_SECONDS = 20;

/** Backoff multipliers applied after consecutive collector errors. */
export const BACKOFF_MULTIPLIERS = [1, 2, 4, 8, 16] as const;

/** Pause duration (seconds) applied when a source returns 403/429/captcha. */
export const RATE_LIMIT_PAUSE_SECONDS = 15 * 60;

export const SOURCE_LABELS: Record<string, string> = {
  AUTO_RIA: "AUTO.RIA",
  OLX: "OLX",
  RST: "RST",
  CARS_UA: "Cars.ua",
  AUTOMOTO: "AutoMoto.ua",
  MOCK: "Mock Source",
};
