import { Worker } from "bullmq";
import { prisma } from "@amb/db";
import { QUEUE_NAMES } from "@amb/shared";
import { bullConnection, closeQueues, enqueue } from "./lib/queues.js";
import { log } from "./lib/log.js";
import { processCollectorRun, type CollectorRunJob } from "./processors/collector-run.js";
import { processListingDetected, type ListingDetectedJob } from "./processors/listing-detected.js";
import { processListingEnrich, type ListingEnrichJob } from "./processors/listing-enrich.js";
import { processVehicleCheck, type VehicleCheckJob } from "./processors/vehicle-check.js";
import {
  processTelegramSend,
  processTelegramUpdate,
  type TelegramSendJob,
  type TelegramUpdateJob,
} from "./processors/telegram.js";
import { isTelegramConfigured } from "./modules/telegram-service.js";
import { env } from "./env.js";
import { closePhotoOcrWorker } from "./modules/photo-identifier-ocr.js";
import { closeSourceHttpClient } from "./collectors/source-http-client.js";
import {
  processObservationReplay,
  type ObservationReplayJob,
} from "./processors/observation-replay.js";
import { runRetentionMaintenance } from "./modules/retention.js";
import { refreshUsdExchangeRate } from "./modules/exchange-rate.js";

const workers: Worker[] = [];
const timers: NodeJS.Timeout[] = [];
const STALE_COLLECTOR_RUN_MS = 10 * 60 * 1000;
const workerStartedAt = new Date();

await closeStaleCollectorRuns(workerStartedAt, "Worker restarted before this collector run finished");
await recoverInterruptedPipeline();
await refreshUsdExchangeRate();

function createWorker<T>(queueName: string, processor: (data: T) => Promise<unknown>, concurrency = 2): void {
  const worker = new Worker(
    queueName,
    async (job) => {
      await processor(job.data as T);
    },
    { connection: bullConnection, concurrency },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] ${queueName} job ${job?.id} failed:`, err.message);
    void log.error("worker", `${queueName} job failed`, err.message);
  });

  workers.push(worker);
  console.log(`[worker] listening on queue: ${queueName}`);
}

createWorker<TelegramSendJob>(QUEUE_NAMES.TELEGRAM_SEND, processTelegramSend, env.WORKER_CONCURRENCY_TELEGRAM_SEND);
createWorker<TelegramUpdateJob>(QUEUE_NAMES.TELEGRAM_UPDATE, processTelegramUpdate, env.WORKER_CONCURRENCY_TELEGRAM_UPDATE);
createWorker<ListingDetectedJob>(QUEUE_NAMES.LISTING_DETECTED, processListingDetected, env.WORKER_CONCURRENCY_LISTING_DETECTED);
createWorker<ListingEnrichJob>(QUEUE_NAMES.LISTING_ENRICH, processListingEnrich, env.WORKER_CONCURRENCY_LISTING_ENRICH);
createWorker<VehicleCheckJob>(QUEUE_NAMES.VEHICLE_CHECK, processVehicleCheck, env.WORKER_CONCURRENCY_VEHICLE_CHECK);
createWorker<CollectorRunJob>(QUEUE_NAMES.COLLECTOR_RUN, processCollectorRun, env.WORKER_CONCURRENCY_COLLECTOR_RUN);
createWorker<CollectorRunJob>(
  QUEUE_NAMES.COLLECTOR_BACKFILL,
  processCollectorRun,
  env.WORKER_CONCURRENCY_COLLECTOR_BACKFILL,
);
createWorker<ObservationReplayJob>(
  QUEUE_NAMES.OBSERVATION_REPLAY,
  processObservationReplay,
  env.WORKER_CONCURRENCY_OBSERVATION_REPLAY,
);

await scheduleObservationReplay("STARTUP");
timers.push(setInterval(() => {
  void scheduleObservationReplay("PERIODIC").catch((error) => {
    void log.warn("completeness", "Failed to schedule observation replay", error instanceof Error ? error.message : String(error));
  });
}, Math.max(5_000, env.OBSERVATION_REPLAY_INTERVAL_MS)));

let recoveryRunning = false;
timers.push(setInterval(() => {
  if (recoveryRunning) return;
  recoveryRunning = true;
  void recoverInterruptedPipeline()
    .catch((error) => log.warn("worker", "Periodic pipeline recovery failed", error instanceof Error ? error.message : String(error)))
    .finally(() => {
      recoveryRunning = false;
    });
}, env.PIPELINE_RECOVERY_INTERVAL_MS));

timers.push(setTimeout(() => {
  void runRetentionMaintenance().catch((error) => {
    void log.warn("retention", "Retention maintenance failed", error instanceof Error ? error.message : String(error));
  });
}, 60_000));
timers.push(setInterval(() => {
  void runRetentionMaintenance().catch((error) => {
    void log.warn("retention", "Retention maintenance failed", error instanceof Error ? error.message : String(error));
  });
}, Math.max(60 * 60 * 1000, env.RETENTION_INTERVAL_MS)));
timers.push(setInterval(() => {
  void refreshUsdExchangeRate();
}, 6 * 60 * 60 * 1000));

console.log(
  `[worker] started. Telegram: ${isTelegramConfigured() ? "configured" : "NOT configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`,
);

async function closeStaleCollectorRuns(
  staleStartedBefore = new Date(Date.now() - STALE_COLLECTOR_RUN_MS),
  errorMessage = "Collector run exceeded the worker liveness threshold",
): Promise<void> {
  const result = await prisma.collectorRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: staleStartedBefore },
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage,
    },
  });

  if (result.count > 0) {
    await log.warn("worker", `Closed ${result.count} interrupted or stale collector run(s)`);
  }
}

async function recoverInterruptedPipeline(): Promise<void> {
  const now = new Date();
  await closeStaleCollectorRuns();
  await prisma.telegramNotification.updateMany({
    where: {
      status: "PROCESSING",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      status: "RETRY_PENDING",
      leaseExpiresAt: null,
      lastErrorCode: "WORKER_RECOVERY",
      lastErrorMessage: "Отправка восстановлена после перезапуска worker",
    },
  });

  const pendingNotifications = await prisma.telegramNotification.findMany({
    where: {
      status: { in: ["PENDING", "RETRY_PENDING", "FAILED"] },
      attemptCount: { lt: 10 },
    },
    select: { listingId: true },
    orderBy: { createdAt: "asc" },
    take: env.STARTUP_RECOVERY_LIMIT,
  });
  for (const notification of pendingNotifications) {
    await enqueue(
      QUEUE_NAMES.TELEGRAM_SEND,
      "send",
      { listingId: notification.listingId },
      { jobId: `telegram-recovery-${notification.listingId}-${Date.now()}` },
    );
  }

  const incompleteEnrichment = await prisma.listing.findMany({
    where: {
      telegramNotifications: {
        some: {
          status: { in: ["SENT", "UPDATED"] },
          chatId: env.TELEGRAM_CHAT_ID,
        },
      },
      OR: [{ marketPriceEstimate: null }, { vehicleChecks: { none: {} } }],
    },
    select: { id: true },
    orderBy: { firstSeenAt: "desc" },
    take: env.STARTUP_RECOVERY_LIMIT,
  });
  for (const listing of incompleteEnrichment) {
    await enqueue(
      QUEUE_NAMES.LISTING_ENRICH,
      "enrich",
      { listingId: listing.id },
      { jobId: `enrichment-recovery-${listing.id}-${Date.now()}` },
    );
  }

  if (pendingNotifications.length || incompleteEnrichment.length) {
    await log.info(
      "worker",
      `Startup recovery queued ${pendingNotifications.length} Telegram send(s) and ${incompleteEnrichment.length} enrichment job(s)`,
    );
  }
}

async function scheduleObservationReplay(trigger: ObservationReplayJob["trigger"]): Promise<void> {
  const interval = Math.max(5_000, env.OBSERVATION_REPLAY_INTERVAL_MS);
  const bucket = Math.floor(Date.now() / interval);
  await enqueue(
    QUEUE_NAMES.OBSERVATION_REPLAY,
    "replay",
    {
      trigger,
      lookbackHours: env.OBSERVATION_REPLAY_LOOKBACK_HOURS,
      limit: env.OBSERVATION_REPLAY_LIMIT,
    } satisfies ObservationReplayJob,
    { jobId: `observation-replay-${trigger}-${bucket}` },
  );
}

async function shutdown(): Promise<void> {
  console.log("[worker] shutting down...");
  for (const timer of timers) clearInterval(timer);
  for (const worker of workers) {
    await worker.close();
  }
  await closePhotoOcrWorker();
  await closeSourceHttpClient();
  await closeQueues();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
