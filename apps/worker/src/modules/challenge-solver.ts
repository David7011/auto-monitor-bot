import path from "node:path";
import { prisma, type ListingSource } from "@amb/db";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { redisConnection } from "../lib/queues.js";
import { chromium, projectRootDir, resolveBundledChromiumExecutable, type BrowserContext, type Page } from "../lib/browser.js";
import { fetchHtml } from "../collectors/html-utils.js";
import { storeSourceSessionCookie } from "../collectors/source-sessions.js";

export type ChallengeKind =
  | "CLOUDFLARE_INTERSTITIAL"
  | "CLOUDFLARE_CHECKBOX"
  | "TURNSTILE"
  | "PX_PRESS_HOLD"
  | "RECAPTCHA"
  | "CLEAN";

export type ChallengeSolveOutcome =
  | { ok: true; via: string; cookieNames: string[] }
  | { ok: false; reason: string };

export const CHALLENGE_LAST_ATTEMPT_PREFIX = "challenge:harvest:";
export const CHALLENGE_LAST_SUCCESS_PREFIX = "challenge:success:";

// PerimeterX/HUMAN press-and-hold: a SHA-256 hashcash proof-of-work runs in a
// Web Worker while the sensor VM scores hold biomechanics. Genuine
// mouseDown → hold → mouseUp through the input layer (which Playwright's
// mouse uses) lets both complete. Synthesized JS clicks do not.
export const PRESS_HOLD_MIN_MS = 8_500;
export const PRESS_HOLD_MAX_MS = 11_000;

export type ChallengeSnapshot = {
  title: string;
  bodyExcerpt: string;
  frameSrcs: string[];
};

export function detectChallengeKind(snapshot: ChallengeSnapshot): ChallengeKind {
  const hay = `${snapshot.title}\n${snapshot.bodyExcerpt}`.toLowerCase();
  const frames = snapshot.frameSrcs.join("\n").toLowerCase();
  if (/just a moment|performing security verification|verifying you are (a )?human|трохи зачекайте|challenge-platform/.test(hay)) {
    if (/checkbox|click to verify|я не робот|i'm not a robot/.test(hay)) return "CLOUDFLARE_CHECKBOX";
    return "CLOUDFLARE_INTERSTITIAL";
  }
  if (/challenges\.cloudflare\.com/.test(frames) || /turnstile/.test(hay + "\n" + frames)) return "TURNSTILE";
  if (/press (&|and) hold|press_and_hold|px-captcha|captcha\.js|_pxappid|perimeterx|human challenge/.test(hay + "\n" + frames)) {
    return "PX_PRESS_HOLD";
  }
  if (/g-recaptcha|recaptcha\/api\.js|i.m not a robot/.test(hay + "\n" + frames)) return "RECAPTCHA";
  return "CLEAN";
}

/** Human hold duration with jitter; the PoW worker needs the full window. */
export function pressHoldDurationMs(random: () => number = Math.random): number {
  return Math.floor(PRESS_HOLD_MIN_MS + random() * (PRESS_HOLD_MAX_MS - PRESS_HOLD_MIN_MS));
}

export function challengeAttemptKey(source: ListingSource): string {
  return `${CHALLENGE_LAST_ATTEMPT_PREFIX}${source}:last_attempt_at`;
}

export function challengeSuccessKey(source: ListingSource): string {
  return `${CHALLENGE_LAST_SUCCESS_PREFIX}${source}:last_success_at`;
}

export async function shouldAttemptChallengeSolve(source: ListingSource, now: Date = new Date()): Promise<boolean> {
  if (!env.CHALLENGE_SOLVER_ENABLED) return false;
  try {
    const last = await redisConnection.get(challengeAttemptKey(source));
    if (!last) return true;
    const elapsedMs = now.getTime() - new Date(last).getTime();
    if (Number.isNaN(elapsedMs)) return true;
    return elapsedMs >= env.CHALLENGE_SOLVER_MIN_INTERVAL_HOURS * 3_600_000;
  } catch (error) {
    await log.warn(
      "collector",
      `Challenge solver gate check failed for ${source}, skipping attempt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ).catch(() => undefined);
    return false;
  }
}

/** Fire-and-forget entry point for the protection handler. Never throws. */
export function kickOffChallengeSolve(source: ListingSource, reason: string): void {
  void attemptChallengeSolve(source)
    .then((outcome) => {
      if (!outcome.ok) {
        void log.warn("collector", `Challenge solve failed for ${source} (${reason}): ${outcome.reason}`).catch(() => undefined);
      }
    })
    .catch((error) => {
      void log.warn(
        "collector",
        `Challenge solve crashed for ${source} (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
    });
}

export async function attemptChallengeSolve(
  source: ListingSource,
  startUrl?: string,
): Promise<ChallengeSolveOutcome> {
  if (!(await shouldAttemptChallengeSolve(source))) {
    return { ok: false, reason: "solve gated by min interval or disabled" };
  }
  try {
    await redisConnection.set(challengeAttemptKey(source), new Date().toISOString());
  } catch {
    // Attempt timestamp is best-effort.
  }
  const startedAt = Date.now();
  const timeoutMs = env.CHALLENGE_SOLVER_TIMEOUT_MS;
  const executablePath = env.RST_HARVEST_EXECUTABLE_PATH.trim() || resolveBundledChromiumExecutable();
  if (!executablePath) {
    return { ok: false, reason: "no bundled chromium found and RST_HARVEST_EXECUTABLE_PATH is empty" };
  }
  const profileDir = path.resolve(projectRootDir(), ".runtime", `challenge-${source.toLowerCase()}-profile`);
  const targetUrl = startUrl ?? challengeStartUrl(source);
  if (!targetUrl) return { ok: false, reason: `no start URL configured for ${source}` };
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: { width: 1920, height: 1080 },
      locale: "uk-UA",
      timezoneId: "Europe/Kyiv",
      // Deliberately NO JS-evasion patches: injected shims are themselves a
      // fingerprint ("stealth plugins become the fingerprint"). Trust comes
      // from the persistent profile, genuine input-layer behavior and pacing.
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1920,1080",
      ],
      timeout: 60_000,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await behaveLikeReader(page);
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      const kind = await detectChallengeKindOnPage(page);
      if (kind === "CLEAN") {
        return harvestSessionFromContext(source, context, targetUrl, "no challenge presented");
      }
      if (kind === "RECAPTCHA") {
        return { ok: false, reason: "visual recaptcha requires manual or paid solving" };
      }
      const solved = await solveChallengeKind(page, kind);
      if (!solved) {
        await behaveLikeReader(page);
        await page.waitForTimeout(5_000).catch(() => undefined);
        continue;
      }
      await page.waitForTimeout(6_000).catch(() => undefined);
      if ((await detectChallengeKindOnPage(page)) === "CLEAN") {
        return harvestSessionFromContext(source, context, targetUrl, "solved " + kind);
      }
      await behaveLikeReader(page);
      await page.waitForTimeout(5_000).catch(() => undefined);
    }
    const fallback = await harvestSessionFromContext(source, context, targetUrl, "timeout harvest");
    if (fallback.ok) return fallback;
    return { ok: false, reason: "challenge loop did not clear within timeout" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function challengeStartUrl(source: ListingSource): string | null {
  if (source === "OLX") return "https://www.olx.ua/uk/";
  if (source === "AUTO_RIA") return "https://auto.ria.com/uk/search/?abroad=0&category=1&order=7";
  if (source === "RST") return "https://rst.ua/ukr/oldcars/";
  return null;
}

async function detectChallengeKindOnPage(page: Page): Promise<ChallengeKind> {
  try {
    const title = await page.title().catch(() => "");
    // Raw HTML is enough: every challenge marker below also appears in markup
    // (scripts, iframes, headings). No DOM typing needed in Node runtime.
    const html = await page.content().catch(() => "");
    const frameSrcs = page.frames().map((frame) => {
      try {
        return frame.url();
      } catch {
        return "";
      }
    });
    return detectChallengeKind({ title, bodyExcerpt: html.slice(0, 8000), frameSrcs });
  } catch {
    return "CLEAN";
  }
}

async function solveChallengeKind(page: Page, kind: ChallengeKind): Promise<boolean> {
  switch (kind) {
    case "CLOUDFLARE_INTERSTITIAL":
      return true;
    case "CLOUDFLARE_CHECKBOX":
    case "TURNSTILE":
      return clickVerificationControl(page);
    case "PX_PRESS_HOLD":
      return pressAndHold(page);
    default:
      return false;
  }
}

async function humanMove(page: Page, x: number, y: number): Promise<void> {
  const steps = 12 + Math.floor(Math.random() * 10);
  await page.mouse.move(x, y, { steps }).catch(() => undefined);
}

async function behaveLikeReader(page: Page): Promise<void> {
  try {
    await humanMove(page, 300 + Math.random() * 900, 200 + Math.random() * 500);
    await page.waitForTimeout(800 + Math.random() * 1200).catch(() => undefined);
    await page.mouse.wheel(0, 150 + Math.floor(Math.random() * 300)).catch(() => undefined);
  } catch {
    // A closed page ends the attempt; the loop exits on the next check.
  }
}

async function clickVerificationControl(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="captcha"]');
    const box = frame.locator('input[type="checkbox"], .cb-lb, .ctp-checkbox-label, div[role="checkbox"]');
    if ((await box.count()) === 0) return false;
    const rect = await box.boundingBox();
    if (!rect) return false;
    const x = rect.x + rect.width / 2 + (Math.random() * 8 - 4);
    const y = rect.y + rect.height / 2 + (Math.random() * 8 - 4);
    await humanMove(page, x, y);
    await page.waitForTimeout(400 + Math.random() * 600).catch(() => undefined);
    await page.mouse.click(x, y).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function pressAndHold(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="captcha"], iframe[src*="perimeterx"], iframe[src*="px-captcha"]');
    const box = frame.locator('div:has-text("Press & Hold"), div:has-text("Press and Hold"), #px-captcha');
    if ((await box.count()) === 0) {
      const direct = page.locator('div:has-text("Press & Hold"), div:has-text("Press and Hold")');
      if ((await direct.count()) === 0) return false;
      const rect = await direct.boundingBox();
      if (!rect) return false;
      return holdAt(page, rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
    const rect = await box.boundingBox();
    if (!rect) return false;
    return holdAt(page, rect.x + rect.width / 2, rect.y + rect.height / 2);
  } catch {
    return false;
  }
}

async function holdAt(page: Page, x: number, y: number): Promise<boolean> {
  try {
    await humanMove(page, x, y);
    await page.waitForTimeout(500 + Math.random() * 800).catch(() => undefined);
    await page.mouse.move(x, y).catch(() => undefined);
    await page.mouse.down().catch(() => undefined);
    const holdMs = pressHoldDurationMs();
    const startedAt = Date.now();
    // Keep the hold alive: micro-moves feed the sensor VM real biomechanics
    // while the proof-of-work worker finishes. A frozen hold reads as a bot.
    while (Date.now() - startedAt < holdMs) {
      await page.waitForTimeout(800 + Math.random() * 400).catch(() => undefined);
      await page.mouse.move(x + (Math.random() * 4 - 2), y + (Math.random() * 4 - 2), { steps: 2 }).catch(() => undefined);
    }
    await page.mouse.up().catch(() => undefined);
    return true;
  } catch {
    try {
      await page.mouse.up().catch(() => undefined);
    } catch {
      // Best effort release; the attempt continues to verification.
    }
    return false;
  }
}

async function harvestSessionFromContext(
  source: ListingSource,
  context: { cookies: () => Promise<Array<{ name: string; value: string }>> },
  probeUrl: string,
  via: string,
): Promise<ChallengeSolveOutcome> {
  const jar = (await context.cookies().catch(() => []))
    .filter((cookie) => cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  if (!jar) return { ok: false, reason: `no cookies harvested (${via})` };
  const probe = await fetchHtml(probeUrl, {
    source,
    encoding: "utf8",
    headers: { Cookie: jar },
  }).catch(() => null);
  const body = probe?.body ?? "";
  const usable = probe !== null && probe.status === 200
    && !/Performing security verification|Трохи зачекайте|Just a moment|Press (&|and) Hold|Доступ .* (заборонено|обмежено)/iu.test(body);
  if (!usable) return { ok: false, reason: `harvested session rejected by origin (${via})` };
  const stored = await storeSourceSessionCookie(source, jar);
  if (!stored) return { ok: false, reason: "session store failed" };
  try {
    await redisConnection.set(challengeSuccessKey(source), new Date().toISOString());
    await prisma.source.update({
      where: { source },
      data: { pausedUntil: null, consecutiveErrors: 0 },
    }).catch(() => undefined);
  } catch {
    // Bookkeeping is best-effort; the stored session is what matters.
  }
  await log.info("collector", `Challenge session harvested for ${source} (${via})`).catch(() => undefined);
  return { ok: true, via, cookieNames: jar.split(";").map((part) => part.split("=")[0] ?? "?") };
}
