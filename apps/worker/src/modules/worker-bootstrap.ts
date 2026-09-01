export const WORKER_STARTUP_MAINTENANCE_DELAY_MS = 1_000;

export type WorkerBootstrapDependencies = {
  prewarmDatabase: () => Promise<void>;
  createQueueWorkers: () => void;
  waitForQueueWorkers: () => Promise<void>;
  writeHeartbeat: () => Promise<void>;
  deferStartupMaintenance: () => void;
};

/**
 * Makes every queue consumer ready before recovery, replay, or enrichment can
 * compete with the first realtime collector job.
 */
export async function bootstrapWorkerRuntime(
  dependencies: WorkerBootstrapDependencies,
): Promise<void> {
  await dependencies.prewarmDatabase();
  dependencies.createQueueWorkers();
  await dependencies.waitForQueueWorkers();
  await dependencies.writeHeartbeat();
  dependencies.deferStartupMaintenance();
}
