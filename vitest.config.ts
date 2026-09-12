import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    // Unit tests import runtime modules which otherwise load the production
    // .env. A missing mock must fail on an unused local port, never write to
    // production PostgreSQL/Redis or send a real Telegram notification.
    env: {
      DATABASE_URL: "postgresql://unit_test:unit_test@127.0.0.1:1/amb_unit_test",
      REDIS_URL: "redis://127.0.0.1:1",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      AUTO_RIA_API_KEY: "",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "apps/api/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "packages/shared/src/**/*.ts",
      ],
      exclude: [
        "**/index.ts",
        "**/env.ts",
        "**/*.generated.ts",
        "**/data/**",
        "**/maintenance/**",
      ],
      thresholds: {
        statements: 40,
        branches: 70,
        functions: 50,
        lines: 40,
        "apps/worker/src/processors/collector-run.ts": {
          statements: 80,
          branches: 80,
          functions: 85,
          lines: 80,
        },
        "apps/worker/src/processors/listing-detected.ts": {
          statements: 70,
          branches: 85,
          functions: 55,
          lines: 70,
        },
        "apps/worker/src/processors/observation-replay.ts": {
          statements: 85,
          branches: 65,
          functions: 90,
          lines: 85,
        },
        "apps/worker/src/processors/listing-enrich.ts": {
          statements: 90,
          branches: 70,
          functions: 100,
          lines: 90,
        },
        "apps/api/src/server.ts": {
          statements: 65,
          branches: 65,
          functions: 60,
          lines: 65,
        },
        "apps/api/src/modules/monitoring/olx-cadence-canary.ts": {
          statements: 85,
          branches: 40,
          functions: 60,
          lines: 85,
        },
      },
    },
  },
});
