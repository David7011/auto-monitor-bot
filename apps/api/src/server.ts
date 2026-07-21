import Fastify from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { sourcesRoutes } from "./routes/sources.js";
import { filtersRoutes } from "./routes/filters.js";
import { listingsRoutes } from "./routes/listings.js";
import { vehicleTaxonomyRoutes } from "./routes/vehicle-taxonomy.js";
import { systemRoutes } from "./routes/system.js";
import { searchPlanRoutes } from "./routes/search-plan.js";
import { dashboardAuthRoutes } from "./routes/dashboard-auth.js";
import { observationsRoutes } from "./routes/observations.js";
import { orchestrator } from "./modules/monitoring/orchestrator.js";
import { startTelegramControlBot, stopTelegramControlBot } from "./modules/telegram-control-bot.js";
import { closeQueues } from "./lib/queues.js";

const app = Fastify({ logger: { level: "info" } });

const allowedOrigins = new Set([env.DASHBOARD_ORIGIN]);

await app.register(cors, {
  origin: (origin, callback) => {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  allowedHeaders: ["content-type", "authorization", "x-local-api-token"],
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

app.addHook("preHandler", async (req, reply) => {
  if (!isProtectedLocalRoute(req.method, req.url)) return;
  if (!env.LOCAL_API_TOKEN) {
    return reply.code(503).send({ error: "LOCAL_API_TOKEN is not configured" });
  }
  const token = bearerToken(req.headers.authorization) ?? stringHeader(req.headers["x-local-api-token"]);
  if (!safeEqual(token, env.LOCAL_API_TOKEN)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

await app.register(monitoringRoutes);
await app.register(sourcesRoutes);
await app.register(filtersRoutes);
await app.register(listingsRoutes);
await app.register(vehicleTaxonomyRoutes);
await app.register(systemRoutes);
await app.register(searchPlanRoutes);
await app.register(dashboardAuthRoutes);
await app.register(observationsRoutes);

async function shutdown(): Promise<void> {
  try {
    stopTelegramControlBot();
    await closeQueues();
    await app.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  console.log(`[api] listening on http://${env.API_HOST}:${env.API_PORT}`);
  await orchestrator.resumeIfRunning();
  startTelegramControlBot();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function isProtectedLocalRoute(method: string, url: string): boolean {
  const pathname = url.split("?")[0] ?? url;
  if (method === "OPTIONS") return false;
  if (env.API_REQUIRE_LOCAL_TOKEN_FOR_ALL) {
    if (pathname === "/health") return false;
    return true;
  }
  if (pathname === "/logs") return true;
  if (pathname === "/metrics") return true;
  if (pathname.startsWith("/dashboard-auth")) return true;
  if (method === "PATCH" && pathname === "/settings") return true;
  if (pathname.startsWith("/monitoring") && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) return true;
  if (pathname.startsWith("/filters") && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) return true;
  if (pathname.startsWith("/sources") && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) return true;
  if (pathname.startsWith("/observations") && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) return true;
  return false;
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/iu);
  return match?.[1];
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
