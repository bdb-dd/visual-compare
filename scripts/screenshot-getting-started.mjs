#!/usr/bin/env node
// Drives the visual-compare web UI through the documented "Getting started"
// flow and writes screenshots into docs/getting-started/screenshots/.
//
// Usage:
//   node scripts/screenshot-getting-started.mjs
//
// Requires the dev servers to be running (mise exec -- pnpm dev). Reuses the
// already-installed Playwright Chromium under packages/api/node_modules.

import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  'packages',
  'api',
  'node_modules',
  'playwright',
));

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT = path.join(ROOT, 'docs', 'getting-started', 'screenshots');
const BASE = 'http://localhost:5173';

// Sessions already present in the dev DB used as backdrops.
const SMALL_SESSION = '1e643e71-2e13-445b-b08d-846b8913dd91'; // altinn-en-about, 6 pairs
const RICH_SESSION  = '33d3ad43-bd08-48fb-830a-45a06674fb03'; // altinn-prod-vs-at22, 5127 pairs, v1 clusters

const VIEWPORT = { width: 1440, height: 900 };
const WIDE     = { width: 1600, height: 1000 };

async function shot(page, file, opts = {}) {
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest, fullPage: false, ...opts });
  console.log('wrote', path.relative(ROOT, dest));
}

async function settle(page, ms = 400) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // 1. Sessions landing page — upload form + existing sessions
  await page.goto(`${BASE}/`);
  await settle(page);
  await shot(page, '01-sessions-page.png');

  // 2. URL pairs verification tab (use small session so the table fits)
  await page.goto(`${BASE}/sessions/${SMALL_SESSION}?mode=config`);
  await settle(page);
  const configNav = page.getByRole('tablist', { name: 'Config section' });
  await configNav.getByRole('tab', { name: /URL pairs/ }).click();
  await settle(page);
  await shot(page, '02-url-pairs-tab.png');

  // 3. Config tab — viewports / equiv level / LM second pass / filter / capture options
  await configNav.getByRole('tab', { name: /^Config$/ }).click();
  await settle(page);
  await shot(page, '03-config-tab.png', { fullPage: true });

  // 4. LM prompts panel — same page, expanded
  const lmSummary = page.locator('summary').filter({ hasText: /^LM prompts/ }).first();
  await lmSummary.click();
  await settle(page);
  await lmSummary.scrollIntoViewIfNeeded();
  await settle(page, 200);
  await shot(page, '04-lm-prompts.png', { fullPage: true });

  // 5. Workflow bar — Evaluate / Stop button up close
  // Use the rich session where evaluation is already complete so the button reads "All cached"
  await page.goto(`${BASE}/sessions/${RICH_SESSION}?mode=clusters`);
  await settle(page);
  const workflowBar = page.locator('.workflow-bar, .session-header, header').first();
  // Try a tighter region first — fall back to a top crop if the selector misses.
  try {
    await workflowBar.scrollIntoViewIfNeeded();
    await shot(page, '05-evaluate-button.png', {
      clip: await workflowBar.boundingBox().then((b) =>
        b ? { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(140, b.height + b.y + 16) } : undefined,
      ),
    });
  } catch {
    await shot(page, '05-evaluate-button.png', {
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: 140 },
    });
  }

  // 6. Clusters page — full mode, with cluster list visible
  await ctx.close();
  const wideCtx = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 2 });
  const widePage = await wideCtx.newPage();
  await widePage.goto(`${BASE}/sessions/${RICH_SESSION}?mode=clusters`);
  await settle(widePage, 800);
  // Click the "Main" cluster category — it has the richest list
  try {
    await widePage.getByRole('tablist', { name: 'Cluster category' })
      .getByRole('tab', { name: /^Main/ })
      .click();
    await settle(widePage, 400);
  } catch {}
  await shot(widePage, '06-clusters-overview.png');

  // 7. Filter strip — open it (it's a <details>) and screenshot the top portion
  try {
    const filterDetails = widePage.locator('details.filter-strip-details');
    await filterDetails.locator('summary').click();
    await settle(widePage, 200);
    await shot(widePage, '07-filter-strip.png', {
      clip: { x: 0, y: 0, width: WIDE.width, height: 360 },
    });
    // Close again to avoid pushing later screenshots down
    await filterDetails.locator('summary').click();
    await settle(widePage, 200);
  } catch (err) {
    console.warn('filter strip open failed:', err.message);
  }

  // 8. Cluster detail — focus a cluster with members
  // Try the first cluster row in the active category; fall back to URL-driven focus.
  try {
    const focusedClusterId = 'e39b7dfe-c25d-4b53-b70f-0e76fba233b7'; // text_changed paragraph (open, 12 pairs)
    await widePage.goto(`${BASE}/sessions/${RICH_SESSION}?mode=clusters&focus=${focusedClusterId}`);
    await settle(widePage, 1200);
    await shot(widePage, '08-cluster-detail.png');
  } catch (err) {
    console.warn('cluster detail failed:', err.message);
  }

  // 9. Shortcuts overlay — press ?
  await widePage.goto(`${BASE}/sessions/${RICH_SESSION}?mode=rows`);
  await settle(widePage, 800);
  // The handler listens for event.key === '?' on document; click into the body
  // first so focus isn't trapped, then dispatch the keydown directly.
  await widePage.locator('body').click({ position: { x: 5, y: 5 } });
  await widePage.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }),
    );
  });
  await settle(widePage, 400);
  await shot(widePage, '09-shortcuts-overlay.png');
  await widePage.keyboard.press('Escape');

  // 10. Anomalies mode
  await widePage.goto(`${BASE}/sessions/${RICH_SESSION}?mode=anomalies`);
  await settle(widePage, 800);
  await shot(widePage, '10-anomalies.png');

  await browser.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
