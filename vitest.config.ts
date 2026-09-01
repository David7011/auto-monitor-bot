import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
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
