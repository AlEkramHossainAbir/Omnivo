// Step 19b: the key's row is made here, in Node, by @omnivo/sync itself (in memory). First, so
// Dexie finds it when @omnivo/sync loads.
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { databaseName, newDeviceId, openKey, saveDevice, setPin, SyncDatabase } from '@omnivo/sync';
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

const [garments] = WORKSPACES;
const PIN = '480915';
const NO_PIN_NOTICE =
  'This device has no PIN, so its data opens only with a connection. Connect to the internet to sign in.';

// Step 19b: what an online visit with a PIN leaves in the copy: the key's row (keys.ts), made with
// a server key that is never asked for again (offline, the PIN opens it). 1,000 rounds, not
// 600,000: the row keeps its count, and the test types the PIN twice. Plain arrays, because that
// is what page.evaluate() carries; the page turns them back into bytes.
async function pinRow() {
  const db = new SyncDatabase('pwa-e2e-key');
  try {
    const serverKey = new Uint8Array(32).fill(7);
    await openKey(db, { serverKey });
    await setPin(db, { serverKey }, PIN, 1000);
    const row = await db.keys.get('data');
    if (!row?.pin) throw new Error('The PIN was not set');
    return {
      ...row,
      server: [...row.server],
      pin: { ...row.pin, salt: [...row.pin.salt], wrapped: [...row.pin.wrapped] },
    };
  } finally {
    db.close();
  }
}

// Into the copy's database, which the first visit made (offline-session.ts opened it to read the
// PIN). Plain IndexedDB: the built app's Dexie is not reachable from here.
async function putPinRow(page: Page): Promise<void> {
  await page.evaluate(
    async ({ name, row }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('The copy did not open'));
        };
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('keys', 'readwrite');
        transaction.objectStore('keys').put({
          ...row,
          server: new Uint8Array(row.server),
          pin: {
            ...row.pin,
            salt: new Uint8Array(row.pin.salt),
            wrapped: new Uint8Array(row.pin.wrapped),
          },
        });
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          reject(new Error('The key was not saved'));
        };
      });
      db.close();
    },
    { name: databaseName(garments.tenantId, OWNER.id), row: await pinRow() },
  );
}

test.describe('a device set up for Farhana Rahman', () => {
  // What an online visit leaves in this browser: the remembered `me` (step 19a) and the device
  // with its branch (step 18a). Only when nothing is there: a reload keeps what the app saved.
  test.beforeEach(async ({ page }) => {
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

  // Step 19b (decision 5): this build's API never answers, so even the first visit is an opening
  // with no answer, and with no PIN in the copy it is the sign-in page
  test('a reload with no connection on a device without a PIN says why it cannot open', async ({
    page,
    context,
    server,
  }) => {
    await page.goto('/');
    await workerInControl(page);
    // The browser is online here, so the page shows no notice: only a reload offline says why
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await server.stop();
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    // In place of the plain offline notice: it says why
    await expect(page.getByText(NO_PIN_NOTICE)).toBeVisible();
    await expect(page.getByText("You're offline. Signing in needs a connection.")).toHaveCount(0);
  });

  test('a reload with no connection opens the app as her, after the PIN', async ({
    page,
    context,
    server,
  }) => {
    await page.goto('/');
    await workerInControl(page);
    // The sign-in page: offline-session.ts read the copy for its PIN, so the database is there
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await putPinRow(page);
    await server.stop();
    await context.setOffline(true);
    await page.reload();

    await expect(page.getByRole('heading', { level: 1, name: 'Omnivo is locked' })).toBeVisible();
    await expect(
      page.getByText("You're offline, so Omnivo needs this device's PIN to open your work."),
    ).toBeVisible();
    // Offline, "Forgot PIN?" can only say what to do
    await expect(
      page.getByText('Forgot your PIN? Connect to the internet, then sign in with your password.'),
    ).toBeVisible();
    await page.getByLabel('PIN', { exact: true }).fill('111111');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(
      page.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
    ).toBeVisible();
    await page.getByLabel('PIN', { exact: true }).fill(PIN);
    await page.getByRole('button', { name: 'Unlock' }).click();

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
