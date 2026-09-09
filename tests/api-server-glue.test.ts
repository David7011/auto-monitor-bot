import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const mocks = vi.hoisted(() => ({
  env: {
    API_PORT: 4000,
    API_HOST: "127.0.0.1",
    DASHBOARD_ORIGIN: "http://localhost:3001",
    LOCAL_API_TOKEN: "unit-local-token",
    API_REQUIRE_LOCAL_TOKEN_FOR_ALL: true,
  },
  resumeIfRunning: vi.fn(),
  startTelegramControlBot: vi.fn(),
  stopTelegramControlBot: vi.fn(),
  closeQueues: vi.fn(),
}));

vi.mock("../apps/api/src/env.js", () => ({ env: mocks.env }));
vi.mock("../apps/api/src/modules/monitoring/orchestrator.js", () => ({
  orchestrator: { resumeIfRunning: mocks.resumeIfRunning },
}));
vi.mock("../apps/api/src/modules/telegram-control-bot.js", () => ({
  startTelegramControlBot: mocks.startTelegramControlBot,
  stopTelegramControlBot: mocks.stopTelegramControlBot,
}));
vi.mock("../apps/api/src/lib/queues.js", () => ({ closeQueues: mocks.closeQueues }));

vi.mock("../apps/api/src/routes/monitoring.js", () => ({ monitoringRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/sources.js", () => ({ sourcesRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/filters.js", () => ({ filtersRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/listings.js", () => ({ listingsRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/vehicle-taxonomy.js", () => ({ vehicleTaxonomyRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/search-plan.js", () => ({ searchPlanRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/dashboard-auth.js", () => ({ dashboardAuthRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/observations.js", () => ({ observationsRoutes: async () => undefined }));
vi.mock("../apps/api/src/routes/system.js", () => ({
  systemRoutes: async (app: FastifyInstance) => {
    app.get("/health", async () => ({ status: "OK" }));
    app.get("/metrics", async () => ({ metric: 1 }));
    app.get("/settings", async () => ({ setting: 1 }));
    app.patch("/settings", async () => ({ updated: true }));
  },
}));

import { buildApiApp } from "../apps/api/src/server.js";

let activeApp: Awaited<ReturnType<typeof buildApiApp>> | undefined;

afterEach(async () => {
  await activeApp?.close();
  activeApp = undefined;
  mocks.env.LOCAL_API_TOKEN = "unit-local-token";
  mocks.env.API_REQUIRE_LOCAL_TOKEN_FOR_ALL = true;
});

describe("API bootstrap and local authorization glue", () => {
  it("keeps health public but protects metrics with constant-time token validation", async () => {
    activeApp = await buildApiApp({ logger: false });

    expect((await activeApp.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await activeApp.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await activeApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer unit-local-token" },
    })).statusCode).toBe(200);
    expect((await activeApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-local-api-token": "unit-local-token" },
    })).statusCode).toBe(200);
    expect((await activeApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-length" },
    })).statusCode).toBe(401);
  });

  it("fails closed with 503 when a protected route has no configured local token", async () => {
    mocks.env.LOCAL_API_TOKEN = "";
    activeApp = await buildApiApp({ logger: false });
    const response = await activeApp.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "LOCAL_API_TOKEN is not configured" });
  });

  it("protects mutations while allowing ordinary reads in compatibility mode", async () => {
    mocks.env.API_REQUIRE_LOCAL_TOKEN_FOR_ALL = false;
    activeApp = await buildApiApp({ logger: false });

    expect((await activeApp.inject({ method: "GET", url: "/settings" })).statusCode).toBe(200);
    expect((await activeApp.inject({ method: "PATCH", url: "/settings" })).statusCode).toBe(401);
    expect((await activeApp.inject({
      method: "PATCH",
      url: "/settings?from=test",
      headers: { authorization: "Bearer unit-local-token" },
    })).statusCode).toBe(200);
  });

  it("emits CORS credentials only for the configured dashboard origin", async () => {
    activeApp = await buildApiApp({ logger: false });
    const allowed = await activeApp.inject({
      method: "OPTIONS",
      url: "/metrics",
      headers: { origin: "http://localhost:3001", "access-control-request-method": "GET" },
    });
    const denied = await activeApp.inject({
      method: "OPTIONS",
      url: "/metrics",
      headers: { origin: "https://untrusted.example", "access-control-request-method": "GET" },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
