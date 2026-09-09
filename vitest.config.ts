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
        statements: 25,
        branches: 70,
        functions: 40,
        lines: 25,
      },
    },
  },
});
