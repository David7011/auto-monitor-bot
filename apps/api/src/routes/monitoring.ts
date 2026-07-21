import type { FastifyInstance } from "fastify";
import { getMonitoringStatus, startLiveMonitoring, startMonitoring, startStandardMonitoring, stopMonitoring } from "../modules/monitoring/control.js";

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.post("/monitoring/start", async () => {
    return startMonitoring();
  });

  app.post("/monitoring/live/start", async () => {
    return startLiveMonitoring();
  });

  app.post("/monitoring/standard/start", async () => {
    return startStandardMonitoring();
  });

  app.post("/monitoring/stop", async () => {
    return stopMonitoring();
  });

  app.get("/monitoring/status", async () => {
    return getMonitoringStatus();
  });
}
