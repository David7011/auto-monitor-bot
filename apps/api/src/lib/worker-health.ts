export type WorkerHealthStatus = "OK" | "WARN" | "FAIL" | "IDLE";

export function workerHealthStatus(input: {
  monitoringRunning: boolean;
  heartbeatStale: boolean;
  hasSuccessfulScan: boolean;
  sourceStatuses: Array<"OK" | "WARN" | "FAIL" | "NOT_CONFIGURED" | "IDLE">;
}): WorkerHealthStatus {
  if (!input.monitoringRunning) return "IDLE";
  if (input.heartbeatStale) return "FAIL";
  if (!input.hasSuccessfulScan || input.sourceStatuses.some((status) => status === "WARN" || status === "FAIL")) {
    return "WARN";
  }
  return "OK";
}
