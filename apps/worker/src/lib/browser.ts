import { accessSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single indirection over the browser automation driver. Production code
// imports the driver through this module so tests can substitute it by
// relative path (the bare "playwright-core" specifier does not resolve from
// tests/ because pnpm does not hoist the worker dependency to the root).
export { chromium, type BrowserContext, type Page } from "playwright-core";

function existsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the project-bundled Chromium without relying on
 * PLAYWRIGHT_BROWSERS_PATH (playwright-core snapshots that variable at
 * import time, so assigning it later from worker code has no effect).
 * Scans <project>/.runtime/playwright-browsers for the newest chromium-*
 * build and returns its Windows executable, or undefined when nothing is
 * found (the caller then falls back to Playwright defaults).
 */
export function resolveBundledChromiumExecutable(): string | undefined {
  try {
    const browsersRoot = path.resolve(projectRootDir(), ".runtime", "playwright-browsers");
    const builds = readdirSync(browsersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const build of builds) {
      const candidate = path.join(browsersRoot, build, "chrome-win64", "chrome.exe");
      if (existsExecutable(candidate)) return candidate;
    }
  } catch {
    // No bundled browsers (dev checkout without `playwright install`).
  }
  return undefined;
}

/** Project root derived from this file's location (dist/lib or src/lib). */
export function projectRootDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}
