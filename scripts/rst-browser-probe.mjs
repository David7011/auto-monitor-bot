// Manual, bounded transport qualification. Does not enable a source or write listings.
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRstCards } from './rst-browser-probe-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, '.runtime/playwright-browsers');
const { chromium } = await import('@playwright/test');
const profile = resolve(root, '.runtime/rst-browser-profile');
await mkdir(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: false,
  timeout: 30_000,
});
const deadline = Date.now() + 180_000;
try {
  const page = context.pages()[0] ?? await context.newPage();
  console.log(JSON.stringify({ status: 'WAITING_FOR_MANUAL_VERIFICATION', timeoutSeconds: 180,
    writesDatabase: false, sendsTelegram: false }));
  await page.goto('https://rst.ua/ukr/oldcars/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => console.log(JSON.stringify({ status: 'NAVIGATION_NOT_CONFIRMED' })));
  let qualified = false;
  while (Date.now() < deadline && !page.isClosed()) {
    const url = new URL(page.url());
    if (url.origin === 'https://rst.ua' && url.pathname === '/ukr/oldcars/') {
      const sample = await readRstCards(page);
      if (sample.length > 0) {
        console.log(JSON.stringify({ status: 'BROWSER_TRANSPORT_VERIFIED', observedAt: new Date().toISOString(),
          count: sample.length, examples: sample.slice(0, 3), productionReady: false,
          reason: 'Single page only; unattended restart, freshness and delivery not qualified' }));
        qualified = true;
        break;
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  }
  if (!qualified) {
    console.log(JSON.stringify({ status: 'NOT_QUALIFIED', reason: 'No valid RST cards within manual verification window' }));
    process.exitCode = 2;
  }
} finally {
  await context.close();
}
