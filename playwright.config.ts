import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(process.cwd(), ".runtime", "playwright-browsers");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3101",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/e2e-web-server.mjs",
    url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3101/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
