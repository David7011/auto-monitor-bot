export type WorkerHealthStatus = "OK" | "WARN" | "FAIL" | "IDLE";

export function workerHealthStatus(input: {
  monitoringRunning: boolean;
  heartbeatStale: boolean;
  hasSuccessfulScan: boolean;
  sourceStatuses: Array<"OK" | "WARN" | "FAIL" | "NOT_CONFIGURED" | "IDLE">;
}): WorkerHealthStatus {
  if (!input.monitoringRunning) return "IDLE";
  if (input.heartbeatStale) return "FAIL";
  // Source availability is reported independently by sourceHealth and
  // /system/check. A remote CAPTCHA, HTTP 403, or stale source must not make
  // the local worker look crashed and trigger a pointless restart loop.
  if (
    !input.hasSuccessfulScan
    || input.sourceStatuses.some((status) => status === "WARN" || status === "FAIL")
  ) {
    return "WARN";
  }
  return "OK";
}
