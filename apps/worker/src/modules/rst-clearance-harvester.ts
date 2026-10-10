import path from "node:path";
import { chromium, projectRootDir, resolveBundledChromiumExecutable, type BrowserContext, type Page } from "../lib/browser.js";
import { prisma } from "@amb/db";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { redisConnection } from "../lib/queues.js";
import { fetchHtml } from "../collectors/html-utils.js";
import {
  normalizeClearanceCookie,
  RST_CLEARANCE_REDIS_KEY,
  RST_OPERA_USER_AGENT,
} from "../collectors/rst-clearance.js";

export const RST_HARVEST_LAST_ATTEMPT_KEY = "rst:harvest:last_attempt_at";
export const RST_HARVEST_LAST_SUCCESS_KEY = "rst:harvest:last_success_at";
export const RST_SEARCH_PAGE = "https://rst.ua/ukr/oldcars/";

export type RstHarvestOutcome =
  | { ok: true; cookieNames: string[] }
  | { ok: false; reason: string };

const HUMAN_EVASION_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'languages', { get: () => ['uk-UA', 'uk', 'ru-UA', 'ru', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [
  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
  { name: 'Native Client', filename: 'internal-nacl-plugin' },
]});
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = {};
`;

/**
 * Best-effort unattended Cloudflare clearance harvester for rst.ua.
 *
 * Bots are held in an endless verification loop; only a trusted, human-like
 * session passes. This agent keeps a persistent profile (reputation accrues
 * across attempts), patches automation artifacts, behaves like a reader
 * (mouse, scroll, realistic timing) and clicks the human-verification
 * checkbox when Cloudflare serves one. A harvested clearance is validated
 * through the exact production fetch path before it is stored.
 *
 * This is intentionally best-effort: every success saves a manual captcha
 * pass, every failure falls back to the existing manual flow (pause +
 * single Telegram hint). Attempts are gated by RST_HARVEST_MIN_INTERVAL_HOURS
 * on top of the escalating source-protection pauses, so a struggling agent
 * cannot burn the egress reputation with aggressive retries.
 */
export async function shouldAttemptRstHarvest(now: Date = new Date()): Promise<boolean> {
  if (!env.RST_HARVEST_ENABLED) return false;
  try {
    const last = await redisConnection.get(RST_HARVEST_LAST_ATTEMPT_KEY);
    if (!last) return true;
    const elapsedMs = now.getTime() - new Date(last).getTime();
    if (Number.isNaN(elapsedMs)) return true;
    return elapsedMs >= env.RST_HARVEST_MIN_INTERVAL_HOURS * 3_600_000;
  } catch (error) {
    await log.warn(
      "collector",
      `RST harvest gate check failed, skipping attempt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ).catch(() => undefined);
    return false;
  }
}

export function extractClearanceCookie(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): string | null {
  const clearance = cookies.find((cookie) => cookie.name === "cf_clearance");
  if (!clearance) return null;
  return normalizeClearanceCookie(`cf_clearance=${clearance.value}`);
}

/** Fire-and-forget entry point for the protection handler. Never throws. */
export function kickOffRstHarvest(reason: string): void {
  void attemptRstHarvest()
    .then((outcome) => {
      if (!outcome.ok) {
        void log.warn("collector", `RST clearance harvest failed (${reason}): ${outcome.reason}`).catch(() => undefined);
      }
    })
    .catch((error) => {
      void log.warn(
        "collector",
        `RST clearance harvest crashed (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
    });
}

export async function attemptRstHarvest(): Promise<RstHarvestOutcome> {
  if (!(await shouldAttemptRstHarvest())) {
    return { ok: false, reason: "harvest gated by min interval or disabled" };
  }
  try {
    await redisConnection.set(RST_HARVEST_LAST_ATTEMPT_KEY, new Date().toISOString());
  } catch {
    // Attempt timestamp is best-effort; the run itself still validates.
  }
  const startedAt = Date.now();
  const timeoutMs = env.RST_HARVEST_TIMEOUT_MS;
  const executablePath = env.RST_HARVEST_EXECUTABLE_PATH.trim() || resolveBundledChromiumExecutable();
  if (!executablePath) {
    return { ok: false, reason: "no bundled chromium found and RST_HARVEST_EXECUTABLE_PATH is empty" };
  }
  const profileDir = env.RST_HARVEST_PROFILE_DIR.trim()
    || path.resolve(projectRootDir(), ".runtime", "rst-harvester-profile");
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: { width: 1920, height: 1080 },
      locale: "uk-UA",
      timezoneId: "Europe/Kyiv",
      userAgent: env.RST_USER_AGENT || RST_OPERA_USER_AGENT,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1920,1080",
        "--disable-blink-features=AutomationControlled",
      ],
      timeout: 60_000,
    });
    await context.addInitScript(HUMAN_EVASION_SCRIPT);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(RST_SEARCH_PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await behaveLikeReader(page);
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      if (await pageHasListings(page)) {
        return harvestFromContext(context, "listings visible");
      }
      if (await clickVerificationCheckbox(page)) {
        await page.waitForTimeout(8_000).catch(() => undefined);
        if (await pageHasListings(page)) {
          return harvestFromContext(context, "checkbox solved");
        }
      }
      await behaveLikeReader(page);
      await page.waitForTimeout(5_000).catch(() => undefined);
    }
    // Last chance: clearance cookies may exist even while the page keeps
    // looping. They are still validated through the production fetch path:
    // only a token the collector can actually use is worth storing.
    const fallback = await harvestFromContext(context, "timeout harvest");
    if (fallback.ok) return fallback;
    return { ok: false, reason: "challenge loop did not clear within timeout" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function behaveLikeReader(page: Page): Promise<void> {
  try {
    await page.mouse.move(300 + Math.random() * 900, 200 + Math.random() * 500, { steps: 10 + Math.floor(Math.random() * 10) });
    await page.waitForTimeout(800 + Math.random() * 1200);
    await page.mouse.wheel(0, 150 + Math.floor(Math.random() * 300));
  } catch {
    // A closed page ends the attempt; the loop exits on the next check.
  }
}

async function pageHasListings(page: Page): Promise<boolean> {
  try {
    const count = await page.$$eval("article[id^='i-']", (els) => els.length);
    return typeof count === "number" && count > 0;
  } catch {
    return false;
  }
}

async function clickVerificationCheckbox(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
    const box = frame.locator('input[type="checkbox"], .cb-lb, .ctp-checkbox-label');
    if ((await box.count()) === 0) return false;
    const rect = await box.boundingBox();
    if (!rect) return false;
    const x = rect.x + rect.width / 2 + (Math.random() * 8 - 4);
    const y = rect.y + rect.height / 2 + (Math.random() * 8 - 4);
    await page.mouse.move(x, y, { steps: 12 + Math.floor(Math.random() * 8) });
    await page.waitForTimeout(400 + Math.random() * 600);
    await page.mouse.click(x, y);
    return true;
  } catch {
    return false;
  }
}

async function harvestFromContext(
  context: { cookies: () => Promise<Array<{ name: string; value: string }>> },
  via: string,
): Promise<RstHarvestOutcome> {
  const cookie = extractClearanceCookie(await context.cookies().catch(() => []));
  if (!cookie) return { ok: false, reason: `no cf_clearance cookie (${via})` };
  const probe = await fetchHtml(RST_SEARCH_PAGE, {
    source: "RST",
    encoding: "windows-1251",
    headers: { Cookie: cookie, "user-agent": env.RST_USER_AGENT || RST_OPERA_USER_AGENT },
  }).catch(() => null);
  const body = probe?.body ?? "";
  const usable = probe !== null && probe.status === 200 && !/Performing security verification|Трохи зачекайте/.test(body);
  if (!usable) return { ok: false, reason: `harvested clearance rejected by origin (${via})` };
  try {
    await redisConnection.set(RST_CLEARANCE_REDIS_KEY, cookie);
    await redisConnection.set(RST_HARVEST_LAST_SUCCESS_KEY, new Date().toISOString());
    await prisma.source.update({
      where: { source: "RST" },
      data: { pausedUntil: null, consecutiveErrors: 0 },
    }).catch(() => undefined);
  } catch {
    // Redis/DB write failed; the cookie itself is still returned below.
  }
  await log.info("collector", `RST clearance harvested (${via}); monitoring resumes`).catch(() => undefined);
  return { ok: true, cookieNames: ["cf_clearance"] };
}
