import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const e2eCredentialsConfigured = Boolean(process.env.E2E_DASHBOARD_USERNAME && process.env.E2E_DASHBOARD_PASSWORD);

test.beforeEach(() => {
  test.skip(!e2eCredentialsConfigured, "Set E2E_DASHBOARD_USERNAME and E2E_DASHBOARD_PASSWORD to run dashboard E2E tests");
});

test("dashboard renders without leaking local API token", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  const token = readEnvValue("LOCAL_API_TOKEN");
  if (token) expect(html).not.toContain(token);

  await loginDashboard(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Центр мониторинга/i })).toBeVisible();
});

test("mobile dashboard exposes full navigation and touch actions", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await loginDashboard(page);
  await page.goto("/");

  const mobileNav = page.getByRole("navigation", { name: "Мобильная навигация" });
  await expect(mobileNav).toBeVisible();
  await expect(mobileNav.getByRole("link", { name: /Пульт/i })).toBeVisible();
  await expect(mobileNav.getByRole("link", { name: /Фильтры/i })).toBeVisible();
  await expect(mobileNav.getByRole("link", { name: /Источники/i })).toBeVisible();
  await expect(mobileNav.getByRole("link", { name: /Объявления/i })).toBeVisible();

  await mobileNav.getByRole("button", { name: /Открыть остальные разделы/i }).click();
  const allSections = page.getByRole("dialog", { name: "Все разделы" });
  await expect(allSections).toBeVisible();
  await expect(allSections.getByRole("link", { name: /План поиска/i })).toBeVisible();
  await expect(allSections.getByRole("link", { name: /Логи/i })).toBeVisible();
  await expect(allSections.getByRole("link", { name: /Настройки/i })).toBeVisible();
  await allSections.getByRole("button", { name: /Закрыть меню/i }).last().click();
  await expect(allSections).toBeHidden();

  await expect(page.getByRole("button", { name: /LIVE/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Старт/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Стоп/i })).toBeVisible();

  await mobileNav.getByRole("link", { name: /Фильтры/i }).click();
  await expect(page).toHaveURL(/\/filters$/u);
  await expect(page.getByRole("heading", { name: /Фильтры поиска/i })).toBeVisible();
  const editFilter = page.getByRole("button", { name: /Редактировать/i }).first();
  await expect(editFilter).toBeVisible();
  await editFilter.click();
  await expect(page.getByLabel("Название")).not.toHaveValue("");
  await page.getByRole("button", { name: /Отмена/i }).click();
  await expectNoHorizontalOverflow(page);

  await mobileNav.getByRole("link", { name: /Источники/i }).click();
  await expect(page).toHaveURL(/\/sources$/u);
  await expect(page.getByRole("button", { name: /Проверить активные/i })).toBeVisible();

  await mobileNav.getByRole("link", { name: /Объявления/i }).click();
  await expect(page).toHaveURL(/\/listings$/u);
  await expect(page.getByRole("heading", { name: /Найденные авто/i })).toBeVisible();
});

test("all authenticated screens render on narrow Android and iPhone viewports", async ({ page }) => {
  await loginDashboard(page);

  const screens: Array<{ path: string; heading: RegExp }> = [
    { path: "/", heading: /^Центр мониторинга$/i },
    { path: "/filters", heading: /^Фильтры поиска$/i },
    { path: "/sources", heading: /^Источники$/i },
    { path: "/listings", heading: /^Найденные авто$/i },
    { path: "/logs", heading: /^Журнал системы$/i },
    { path: "/settings", heading: /^Настройки$/i },
    { path: "/planner", heading: /^Планировщик$/i },
  ];

  const viewports = [
    { width: 360, height: 800, name: "android-360" },
    { width: 430, height: 932, name: "iphone-430" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const screen of screens) {
      await page.goto(screen.path);
      await expect(page.getByRole("heading", { name: screen.heading })).toBeVisible();
      await expect(page.getByRole("button", { name: /Открыть остальные разделы/i })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      if (viewport.width === 360 && ["/", "/filters"].includes(screen.path)) {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const filename = screen.path === "/" ? "dashboard" : "filters";
        await page.screenshot({ path: `test-results/${viewport.name}-${filename}.png` });
      }
    }
  }

  await expect(page.getByText(/Глубокая проверка:/i)).toBeVisible();
});

test("dashboard BFF can stop and start monitoring with JSON-safe POST", async ({ page }) => {
  test.skip(
    process.env.E2E_ALLOW_USER_DB !== "true",
    "Mutating dashboard E2E is disabled unless E2E_ALLOW_USER_DB=true",
  );

  await loginDashboard(page);

  const stopResponse = await page.context().request.post("/api/backend/monitoring/stop");
  expect(stopResponse.status()).toBe(200);
  const stopped = (await stopResponse.json()) as MonitoringControlResponse;
  expect(stopped.state.status).toBe("STOPPED");

  const startResponse = await page.context().request.post("/api/backend/monitoring/start");
  expect(startResponse.status()).toBe(200);
  const started = (await startResponse.json()) as MonitoringControlResponse;
  expect(started.state.status).toBe("RUNNING");
  expect(started.state.generation).toBeGreaterThanOrEqual(stopped.state.generation);
});

type MonitoringControlResponse = {
  ok: boolean;
  state: {
    status: "STOPPED" | "RUNNING" | string;
    generation: number;
  };
};

function readEnvValue(key: string): string {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/u)
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/gu, "");
}

async function loginDashboard(page: Page): Promise<void> {
  const username = process.env.E2E_DASHBOARD_USERNAME;
  const password = process.env.E2E_DASHBOARD_PASSWORD;
  if (!username || !password) throw new Error("Dashboard E2E credentials are not configured");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.context().request.post("/api/auth/login", {
        data: { username, password },
      });
      expect(response.status(), await response.text()).toBe(200);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(attempt * 300);
    }
  }
  throw lastError;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}
