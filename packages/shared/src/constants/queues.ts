export const QUEUE_NAMES = {
  LISTING_DETECTED: "listing.detected",
  TELEGRAM_SEND: "telegram.send",
  TELEGRAM_FLASH: "telegram.flash",
  LISTING_ENRICH: "listing.enrich",
  VEHICLE_CHECK: "vehicle.check",
  TELEGRAM_UPDATE: "telegram.update",
  COLLECTOR_RUN: "collector.run",
  COLLECTOR_COVERAGE: "collector.coverage",
  COLLECTOR_BACKFILL: "collector.backfill",
  OBSERVATION_REPLAY: "observation.replay",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const WORKER_HEARTBEAT_KEY = "amb:worker:heartbeat";
export const BACKGROUND_WORKER_HEARTBEAT_KEY = "amb:worker:heartbeat:background";
export const HOT_WORKER_LEADER_KEY = "amb:worker:leader:hot:v1";
export const HOT_WORKER_REPLICA_HEARTBEAT_KEYS = {
  a: "amb:worker:heartbeat:hot:a",
  b: "amb:worker:heartbeat:hot:b",
} as const;
export type HotWorkerInstance = keyof typeof HOT_WORKER_REPLICA_HEARTBEAT_KEYS;
// Hot work is asynchronous and its event loop is isolated from CPU-heavy
// maintenance. A 5s lease renewed every second gives fast local failover while
// tolerating several missed renewals; every OLX request is fenced separately.
export const HOT_WORKER_LEASE_TTL_MS = 5_000;
export const HOT_WORKER_LEASE_RENEW_INTERVAL_MS = 1_000;
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_TTL_MS = 15_000;

export const REALTIME_LISTING_PRIORITY = 1;
export const TELEGRAM_SEND_PRIORITY = 1;
export const CURRENT_PAGE_PRIORITY = 2;
export const LAST_24_HOURS_BACKFILL_PRIORITY = 10;
export const BACKFILL_TELEGRAM_PRIORITY = 8;
export const ENRICHMENT_PRIORITY = 20;
export const METRICS_PRIORITY = 50;

export const QUEUE_PRIORITIES: Record<QueueName, number> = {
  [QUEUE_NAMES.TELEGRAM_SEND]: TELEGRAM_SEND_PRIORITY,
  [QUEUE_NAMES.TELEGRAM_FLASH]: TELEGRAM_SEND_PRIORITY,
  [QUEUE_NAMES.LISTING_DETECTED]: REALTIME_LISTING_PRIORITY,
  [QUEUE_NAMES.TELEGRAM_UPDATE]: 4,
  [QUEUE_NAMES.LISTING_ENRICH]: ENRICHMENT_PRIORITY,
  [QUEUE_NAMES.VEHICLE_CHECK]: ENRICHMENT_PRIORITY,
  [QUEUE_NAMES.COLLECTOR_RUN]: 8,
  [QUEUE_NAMES.COLLECTOR_COVERAGE]: LAST_24_HOURS_BACKFILL_PRIORITY,
  [QUEUE_NAMES.COLLECTOR_BACKFILL]: LAST_24_HOURS_BACKFILL_PRIORITY,
  [QUEUE_NAMES.OBSERVATION_REPLAY]: 6,
};
