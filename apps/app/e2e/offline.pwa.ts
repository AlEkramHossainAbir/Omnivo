import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { newDeviceId, saveDevice } from '@omnivo/sync';
import type { Locator, Page } from '@playwright/test';

import { HEAD_OFFICES, meIn, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';
import { openFromNav } from './helpers.js';
import { expect, OUT_DIR, test } from './pwa-server.js';

// Step 19a: the service worker of the real build, in a real Chromium. The build's API never
// answers (pwa-build.ts), so these pages see the API as an offline device does.

const READY = 'A new version of Omnivo is ready. Save what you are working on, then reload.';
const OTHER_TAB = 'Omnivo was updated in another tab. Reload this tab to keep working.';
// Either notice of app-update.ts
const ANY = /A new version of Omnivo is ready|Omnivo was updated in another tab/;

// clientsClaim in sw.ts: the first install takes the page over without a reload
async function workerInControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
}

function updateNotice(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

// The files the worker keeps, read from the built sw.js (the list vite-plugin-pwa put in it)
function precachedScripts(): string[] {
  const worker = readFileSync(join(OUT_DIR, 'sw.js'), 'utf8');
  return [...worker.matchAll(/"url":"(assets\/[^"]+\.js)"/g)].flatMap((match) =>
    match[1] ? [`/${match[1]}`] : [],
  );
}

test('the build opens with the server gone and no connection', async ({
  page,
  context,
  server,
}) => {
  await page.goto('/login');
  await workerInControl(page);
  const loaded = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname),
  );

  await server.stop();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByText("You're offline. Signing in needs a connection.")).toBeVisible();

  // A link deep into the app: the worker answers every page's address with index.html
  // (the app's own router then sends a signed-out person to the sign-in page)
  await page.goto('/sales-orders');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  // Decision 4: a page that was never opened online still opens offline
  const never = precachedScripts().find((path) => !loaded.includes(path));
  expect(never).toBeDefined();
  const status = await page.evaluate(async (path) => (await fetch(path)).status, never ?? '');
  expect(status).toBe(200);
});

test.describe('a device set up for Farhana Rahman', () => {
  // What an online visit leaves in this browser: the remembered `me` (step 19a) and the device
  // with its branch (step 18a). Only when nothing is there: a reload keeps what the app saved.
  test.beforeEach(async ({ page }) => {
    const [garments] = WORKSPACES;
    const saved = new Map<string, string>();
    saveDevice(
      { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
      garments.tenantId,
      OWNER.id,
      { id: newDeviceId(), branchId: HEAD_OFFICES[garments.slug], later: false },
    );
    const me = meIn(garments, 'Rahman Garments Ltd.', { language: null, theme: 'system' }, 'ready');
    saved.set('omnivo.me', JSON.stringify(me));
    await page.addInitScript(
      (entries) => {
        for (const [key, value] of entries) {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        }
      },
      [...saved],
    );
  });

  test('a reload with no connection opens the app as her', async ({ page, context, server }) => {
    await page.goto('/');
    await workerInControl(page);
    await server.stop();
    await context.setOffline(true);
    await page.reload();

    await expect(
      page
        .getByRole('button', { name: /Farhana Rahman/ })
        .or(page.getByRole('button', { name: 'Account' }))
        .filter({ visible: true }),
    ).toBeVisible();
    await openFromNav(page, /^Sync/);
    await expect(
      page.getByText(
        'Omnivo opened without a connection. Your sign-in is checked once the connection is back.',
      ),
    ).toBeVisible();
  });
});

test('a new version waits for Reload, in every tab', async ({ page, context, server }) => {
  await page.goto('/login');
  await workerInControl(page);
  const other = await context.newPage();
  await other.goto('/login');
  await workerInControl(other);
  // The first install is no update: neither notice
  await expect(updateNotice(page, ANY)).toHaveCount(0);
  await expect(updateNotice(other, ANY)).toHaveCount(0);

  // The app looks for a new version when the connection comes back (and every hour)
  server.publishNewWorker();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(updateNotice(page, READY)).toBeVisible({ timeout: 15_000 });
  await expect(updateNotice(other, READY)).toBeVisible({ timeout: 15_000 });

  // The other tab reloads into the new version; this one is told it still runs the old one
  const reloaded = other.waitForEvent('load');
  await updateNotice(other, READY).getByRole('button', { name: 'Reload' }).click();
  await reloaded;
  await workerInControl(other);
  await expect(updateNotice(other, READY)).toHaveCount(0);
  await expect(updateNotice(page, OTHER_TAB)).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting),
  ).toBeFalsy();

  // Nothing waits any more: this tab's Reload is a plain reload, and the notice goes
  const reloadedToo = page.waitForEvent('load');
  await updateNotice(page, OTHER_TAB).getByRole('button', { name: 'Reload' }).click();
  await reloadedToo;
  await expect(updateNotice(page, ANY)).toHaveCount(0);
});
