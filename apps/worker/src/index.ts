import { Worker } from "bullmq";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@amb/db";
import {
  QUEUE_NAMES,
  HOT_WORKER_REPLICA_HEARTBEAT_KEYS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_MS,
  type HotWorkerInstance,
  type QueueName,
} from "@amb/shared";
import { bullConnection, closeQueues, enqueue, redisConnection } from "./lib/queues.js";
import { log } from "./lib/log.js";
import { processCollectorRun, type CollectorRunJob } from "./processors/collector-run.js";
import { processListingDetected, type ListingDetectedJob } from "./processors/listing-detected.js";
import { processListingEnrich, type ListingEnrichJob } from "./processors/listing-enrich.js";
import { processVehicleCheck, type VehicleCheckJob } from "./processors/vehicle-check.js";
import {
  processTelegramSend,
  processTelegramFlash,
  processTelegramUpdate,
  type TelegramSendJob,
  type TelegramFlashJob,
  type TelegramUpdateJob,
} from "./processors/telegram.js";
import {
  createTelegramFlashBundle,
  isTelegramConfigured,
  releaseFlashListingsToCards,
} from "./modules/telegram-service.js";
import { env } from "./env.js";
import { closePhotoOcrWorker } from "./modules/photo-identifier-ocr.js";
import { closeSourceHttpClient } from "./collectors/source-http-client.js";
import {
  processObservationReplay,
  type ObservationReplayJob,
} from "./processors/observation-replay.js";
import { runRetentionMaintenance } from "./modules/retention.js";
import {
  adoptFreshListingNotifications,
  runListingRetentionMaintenance,
} from "./modules/listing-retention.js";
import { refreshUsdExchangeRate } from "./modules/exchange-rate.js";
import {
  bootstrapWorkerRuntime,
  WORKER_STARTUP_MAINTENANCE_DELAY_MS,
} from "./modules/worker-bootstrap.js";
import {
  heartbeatKeyForWorkerRole,
  heartbeatKeyForHotWorkerReplica,
  heartbeatRolesForWorker,
  resolveHotWorkerInstance,
  resolveWorkerRole,
  workerRoleConsumesQueue,
  workerRoleRunsMaintenance,
} from "./modules/worker-roles.js";
import {
  removeWorkerHeartbeatFile,
  removeHotWorkerReplicaHeartbeatFile,
  WorkerHeartbeatTelemetry,
  writeHotWorkerReplicaHeartbeatFile,
  writeWorkerHeartbeatFile,
} from "./modules/worker-heartbeat.js";
import { HotWorkerLeadership } from "./modules/hot-worker-leadership.js";
import { setOlxRequestLeadershipGuard } from "./modules/olx-request-coordinator.js";

const workers: Worker[] = [];
const timers: NodeJS.Timeout[] = [];
const STALE_COLLECTOR_RUN_MS = 10 * 60 * 1000;
const workerStartedAt = new Date();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workerRole = resolveWorkerRole(process.argv.slice(2));
const hotWorkerInstance = resolveHotWorkerInstance(process.argv.slice(2), workerRole);
const workerHeartbeatRoles = heartbeatRolesForWorker(workerRole);
const heartbeatTelemetry = new WorkerHeartbeatTelemetry();
let recoveryRunning = false;
let hotLeadership: HotWorkerLeadership | null = null;
let shutdownRunning = false;

const HOT_JOB_LOCK_DURATION_MS = 10_000;
const HOT_JOB_STALLED_INTERVAL_MS = 2_000;

function createWorker<T>(queueName: QueueName, processor: (data: T) => Promise<unknown>, concurrency = 2): void {
  const worker = new Worker(
    queueName,
    async (job) => {
      await processor(job.data as T);
    },
    {
      connection: bullConnection,
      concurrency,
      ...(workerRole === "hot"
        ? {
          lockDuration: HOT_JOB_LOCK_DURATION_MS,
          stalledInterval: HOT_JOB_STALLED_INTERVAL_MS,
          maxStalledCount: 2,
        }
        : {}),
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker:${workerRole}] ${queueName} job ${job?.id} failed:`, err.message);
    void log.error(`worker-${workerRole}`, `${queueName} job failed`, err.message);
  });

  worker.on("stalled", (jobId) => {
    console.error(`[worker:${workerRole}] ${queueName} job ${jobId} stalled`);
    void log.error(`worker-${workerRole}`, `${queueName} job stalled`, String(jobId));
  });

  workers.push(worker);
  console.log(`[worker:${workerRole}] listening on queue: ${queueName}`);
}

if (workerRole === "hot") {
  if (!hotWorkerInstance) throw new Error("A dedicated hot worker requires an instance id");
  hotLeadership = new HotWorkerLeadership({
    redis: redisConnection,
    instanceId: hotWorkerInstance,
    onPromoted: async () => {
      // Validate or recreate the standby's retained PostgreSQL connection
      // before any realtime queue can deliver its first job.
      await prewarmWorkerDatabase();
      createQueueWorkers();
      try {
        await Promise.all(workers.map((worker) => worker.waitUntilReady()));
        await writeWorkerHeartbeat();
        console.log(`[worker:hot:${hotWorkerInstance}] promoted to leader`);
      } catch (error) {
        await closeQueueWorkers(true);
        throw error;
      }
    },
    onDemoted: async (reason) => {
      console.warn(`[worker:hot:${hotWorkerInstance}] demoted (${reason})`);
      await closeQueueWorkers(reason !== "shutdown");
    },
  });
  setOlxRequestLeadershipGuard(() => hotLeadership!.assertOwnership());
  // Warm both replicas, not only today's leader. A failover must not pay a
  // Windows PostgreSQL backend creation + TLS/authentication penalty.
  await prewarmWorkerDatabase();
  await writeWorkerHeartbeat();
  await hotLeadership.start();
} else {
  await bootstrapWorkerRuntime({
    prewarmDatabase: prewarmWorkerDatabase,
    createQueueWorkers,
    waitForQueueWorkers: async () => {
      await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    },
    writeHeartbeat: writeWorkerHeartbeat,
    deferStartupMaintenance,
  });
}

async function prewarmWorkerDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
timers.push(setInterval(() => {
  void writeWorkerHeartbeat().catch((error) => {
    void log.warn("worker-heartbeat", "Failed to refresh worker heartbeat", error instanceof Error ? error.message : String(error));
  });
}, WORKER_HEARTBEAT_INTERVAL_MS));

if (workerRoleRunsMaintenance(workerRole)) {
  timers.push(setInterval(() => {
    void scheduleObservationReplay("PERIODIC").catch((error) => {
      void log.warn("completeness", "Failed to schedule observation replay", error instanceof Error ? error.message : String(error));
    });
  }, Math.max(5_000, env.OBSERVATION_REPLAY_INTERVAL_MS)));

  timers.push(setInterval(() => {
    triggerPipelineRecovery("periodic");
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
  let listingRetentionRunning = false;
  const runListingRetention = (): void => {
    if (listingRetentionRunning) return;
    listingRetentionRunning = true;
    void adoptFreshListingNotifications()
      .then(() => runListingRetentionMaintenance())
      .catch((error) => {
        void log.warn(
          "listing-retention",
          "Listing retention maintenance failed",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        listingRetentionRunning = false;
      });
  };
  timers.push(setTimeout(runListingRetention, 45_000));
  timers.push(setInterval(runListingRetention, Math.max(60_000, env.LISTING_CLEANUP_INTERVAL_MS)));
  timers.push(setInterval(() => {
    void refreshUsdExchangeRate();
  }, 6 * 60 * 60 * 1000));
}

console.log(
  `[worker:${workerRole}${hotWorkerInstance ? `:${hotWorkerInstance}` : ""}] started. Telegram: ${isTelegramConfigured() ? "configured" : "NOT configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`,
);

function deferStartupMaintenance(): void {
  if (!workerRoleRunsMaintenance(workerRole)) return;
  timers.push(setTimeout(() => {
    triggerPipelineRecovery("startup");
    void refreshUsdExchangeRate().catch((error) => {
      void log.warn(
        "exchange-rate",
        "Startup exchange-rate refresh failed",
        error instanceof Error ? error.message : String(error),
      );
    });
    void scheduleObservationReplay("STARTUP").catch((error) => {
      void log.warn(
        "completeness",
        "Failed to schedule startup observation replay",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, WORKER_STARTUP_MAINTENANCE_DELAY_MS));
}

function createQueueWorkers(): void {
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.TELEGRAM_FLASH)) {
    createWorker<TelegramFlashJob>(
      QUEUE_NAMES.TELEGRAM_FLASH,
      processTelegramFlash,
      env.WORKER_CONCURRENCY_TELEGRAM_FLASH,
    );
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.TELEGRAM_SEND)) {
    createWorker<TelegramSendJob>(QUEUE_NAMES.TELEGRAM_SEND, processTelegramSend, env.WORKER_CONCURRENCY_TELEGRAM_SEND);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.TELEGRAM_UPDATE)) {
    createWorker<TelegramUpdateJob>(QUEUE_NAMES.TELEGRAM_UPDATE, processTelegramUpdate, env.WORKER_CONCURRENCY_TELEGRAM_UPDATE);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.LISTING_DETECTED)) {
    createWorker<ListingDetectedJob>(QUEUE_NAMES.LISTING_DETECTED, processListingDetected, env.WORKER_CONCURRENCY_LISTING_DETECTED);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.LISTING_ENRICH)) {
    createWorker<ListingEnrichJob>(QUEUE_NAMES.LISTING_ENRICH, processListingEnrich, env.WORKER_CONCURRENCY_LISTING_ENRICH);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.VEHICLE_CHECK)) {
    createWorker<VehicleCheckJob>(QUEUE_NAMES.VEHICLE_CHECK, processVehicleCheck, env.WORKER_CONCURRENCY_VEHICLE_CHECK);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.COLLECTOR_RUN)) {
    createWorker<CollectorRunJob>(QUEUE_NAMES.COLLECTOR_RUN, processCollectorRun, env.WORKER_CONCURRENCY_COLLECTOR_RUN);
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.COLLECTOR_BACKFILL)) {
    createWorker<CollectorRunJob>(
      QUEUE_NAMES.COLLECTOR_BACKFILL,
      processCollectorRun,
      env.WORKER_CONCURRENCY_COLLECTOR_BACKFILL,
    );
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.COLLECTOR_COVERAGE)) {
    createWorker<CollectorRunJob>(
      QUEUE_NAMES.COLLECTOR_COVERAGE,
      processCollectorRun,
      env.WORKER_CONCURRENCY_COLLECTOR_COVERAGE,
    );
  }
  if (workerRoleConsumesQueue(workerRole, QUEUE_NAMES.OBSERVATION_REPLAY)) {
    createWorker<ObservationReplayJob>(
      QUEUE_NAMES.OBSERVATION_REPLAY,
      processObservationReplay,
      env.WORKER_CONCURRENCY_OBSERVATION_REPLAY,
    );
  }
}

async function writeWorkerHeartbeat(): Promise<void> {
  if (workerRole === "hot" && hotWorkerInstance) {
    const payload = heartbeatTelemetry.sample("hot", workerStartedAt, {
      instanceId: hotWorkerInstance,
      leadership: hotLeadership?.isLeader ? "leader" : "standby",
    });
    const writes: Promise<unknown>[] = [
      redisConnection.set(
        heartbeatKeyForHotWorkerReplica(hotWorkerInstance),
        JSON.stringify(payload),
        "PX",
        WORKER_HEARTBEAT_TTL_MS,
      ),
      writeHotWorkerReplicaHeartbeatFile(projectRoot, payload as typeof payload & { instanceId: HotWorkerInstance }),
    ];
    if (hotLeadership?.isLeader) {
      writes.push(
        redisConnection.set(
          heartbeatKeyForWorkerRole("hot"),
          JSON.stringify(payload),
          "PX",
          WORKER_HEARTBEAT_TTL_MS,
        ),
        writeWorkerHeartbeatFile(projectRoot, payload),
      );
    }
    await Promise.all(writes);
    return;
  }
  await Promise.all(workerHeartbeatRoles.map(async (role) => {
    const payload = heartbeatTelemetry.sample(role, workerStartedAt);
    await Promise.all([
      redisConnection.set(
        heartbeatKeyForWorkerRole(role),
        JSON.stringify(payload),
        "PX",
        WORKER_HEARTBEAT_TTL_MS,
      ),
      writeWorkerHeartbeatFile(projectRoot, payload),
    ]);
  }));
}

async function closeQueueWorkers(force: boolean): Promise<void> {
  const closing = workers.splice(0, workers.length);
  await Promise.all(closing.map((worker) => worker.close(force).catch((error) => {
    void log.warn(
      "hot-worker-leadership",
      "Failed to close a queue consumer during leadership transition",
      error instanceof Error ? error.message : String(error),
    );
  })));
}

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

function triggerPipelineRecovery(trigger: "startup" | "periodic"): void {
  if (recoveryRunning) return;
  recoveryRunning = true;
  const recovery = trigger === "startup"
    ? recoverStartupPipeline()
    : recoverInterruptedPipeline();
  void recovery
    .catch((error) => log.warn(
      "worker",
      `${trigger === "startup" ? "Startup" : "Periodic"} pipeline recovery failed`,
      error instanceof Error ? error.message : String(error),
    ))
    .finally(() => {
      recoveryRunning = false;
    });
}

async function recoverStartupPipeline(): Promise<void> {
  // The hot worker starts independently and may already be collecting while
  // the background worker boots. Only close runs that are objectively stale;
  // using this process' start time would incorrectly fail healthy hot work.
  await recoverInterruptedPipeline(true);
}

async function recoverInterruptedPipeline(closeStaleRuns = true): Promise<void> {
  const now = new Date();
  if (closeStaleRuns) await closeStaleCollectorRuns();
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
  await prisma.telegramFlashBundle.updateMany({
    where: {
      status: "PROCESSING",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      status: "RETRY_PENDING",
      leaseExpiresAt: null,
      lastErrorCode: "WORKER_RECOVERY",
      lastErrorMessage: "Flash bundle восстановлен после перезапуска worker",
    },
  });

  const stagedFlashNotifications = await prisma.telegramNotification.findMany({
    where: { status: "FLASH_PENDING", flashBundleId: { not: null } },
    select: { listingId: true, flashBundleId: true },
    orderBy: { createdAt: "asc" },
    take: env.STARTUP_RECOVERY_LIMIT,
  });
  const stagedByBundle = new Map<string, string[]>();
  for (const notification of stagedFlashNotifications) {
    if (!notification.flashBundleId) continue;
    const listingIds = stagedByBundle.get(notification.flashBundleId) ?? [];
    listingIds.push(notification.listingId);
    stagedByBundle.set(notification.flashBundleId, listingIds);
  }
  for (const [flashBundleId, listingIds] of stagedByBundle) {
    if (listingIds.length >= env.TELEGRAM_FLASH_BUNDLE_MIN_ITEMS) {
      await createTelegramFlashBundle(flashBundleId, listingIds);
    } else {
      await releaseFlashListingsToCards(flashBundleId, listingIds);
    }
  }

  const pendingFlashBundles = await prisma.telegramFlashBundle.findMany({
    where: {
      status: { in: ["PENDING", "RETRY_PENDING", "FAILED"] },
      attemptCount: { lt: 10 },
    },
    select: { id: true, attemptCount: true },
    orderBy: { createdAt: "asc" },
    take: env.STARTUP_RECOVERY_LIMIT,
  });
  for (const bundle of pendingFlashBundles) {
    await enqueue(
      QUEUE_NAMES.TELEGRAM_FLASH,
      "flash",
      { flashBundleId: bundle.id },
      { jobId: `telegram-flash-recovery-${bundle.id}-${bundle.attemptCount}-${Date.now()}` },
    );
  }

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

  if (pendingNotifications.length || pendingFlashBundles.length || incompleteEnrichment.length) {
    await log.info(
      "worker",
      `Pipeline recovery queued ${pendingFlashBundles.length} flash bundle(s), ${pendingNotifications.length} Telegram send(s), and ${incompleteEnrichment.length} enrichment job(s)`,
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
  if (shutdownRunning) return;
  shutdownRunning = true;
  console.log(`[worker:${workerRole}] shutting down...`);
  for (const timer of timers) clearInterval(timer);
  if (hotLeadership) await hotLeadership.stop();
  else await closeQueueWorkers(false);
  await closePhotoOcrWorker();
  await closeSourceHttpClient();
  heartbeatTelemetry.close();
  await Promise.all(workerHeartbeatRoles.map(async (role) => {
    if (role === "hot" && hotWorkerInstance) return;
    await Promise.all([
      redisConnection.del(heartbeatKeyForWorkerRole(role)).catch(() => undefined),
      removeWorkerHeartbeatFile(projectRoot, role),
    ]);
  }));
  if (hotWorkerInstance) {
    await Promise.all([
      redisConnection.del(HOT_WORKER_REPLICA_HEARTBEAT_KEYS[hotWorkerInstance]).catch(() => undefined),
      removeHotWorkerReplicaHeartbeatFile(projectRoot, hotWorkerInstance),
    ]);
  }
  await closeQueues();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
