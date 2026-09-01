import type { FastifyInstance } from "fastify";
import { systemAdminRoutes } from "./system-admin-routes.js";
import { systemHealthRoutes } from "./system-health-routes.js";
import { systemMetricsRoute } from "./system-metrics-route.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  await systemHealthRoutes(app);
  await systemAdminRoutes(app);
  await systemMetricsRoute(app);
}
