import type { Locator, Page } from '@playwright/test';

import { expect, openFromNav, test, toastShown, waitForCopy } from './helpers.js';

// Step 19a: the parts of the installed app that the mock app can show. The service worker itself
// is not here: `pnpm dev:mock` never registers it (MSW's worker needs the same scope), so the
// worker, the offline reload and the update notice are tested on the real build in offline.pwa.ts.

// What the page told the browser, read back by the test
declare global {
  interface Window {
    pwaSpy?: { badges: number[]; persistCalls: number; prompted: number };
  }
}

// Runs in the page before the app (addInitScript), on every load. The badge calls do nothing in a
// browser tab, and the storage answers depend on the browser and the machine: the spy records the
// first and gives fixed answers for the second. keep = how the browser answers persist().
function spyOnBrowser(options: { keep: boolean }): void {
  const spy = { badges: [] as number[], persistCalls: 0, prompted: 0 };
  window.pwaSpy = spy;
  Object.defineProperty(navigator, 'setAppBadge', {
    configurable: true,
    value: (count?: number) => {
      spy.badges.push(count ?? 0);
      return Promise.resolve();
    },
  });
  Object.defineProperty(navigator, 'clearAppBadge', {
    configurable: true,
    value: () => {
      spy.badges.push(0);
      return Promise.resolve();
    },
  });
  let kept = false;
  navigator.storage.persisted = () => Promise.resolve(kept);
  navigator.storage.persist = () => {
    spy.persistCalls += 1;
    kept = options.keep;
    return Promise.resolve(kept);
  };
  navigator.storage.estimate = () => Promise.resolve({ usage: 24_500_000, quota: 1_234_000_000 });
}

async function openAccountMenu(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
}

async function start(page: Page, options = { keep: true }): Promise<void> {
  await page.addInitScript(spyOnBrowser, options);
  await page.goto('/');
  await waitForCopy(page);
}

test('the mock app has no service worker of its own (decision 11)', async ({ page }) => {
  await start(page);
  const workers = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(
      (registration) => registration.active?.scriptURL ?? '',
    ),
  );
  expect(workers.map((url) => new URL(url).pathname)).toEqual(['/mockServiceWorker.js']);
});

test('Install app shows the browser’s own prompt, once', async ({ page }) => {
  await start(page);
  // Chromium sends its prompt only to a site it finds installable; a test browser never does
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'My devices' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Install app' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const prevented = await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        if (window.pwaSpy) window.pwaSpy.prompted += 1;
        return Promise.resolve();
      },
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  // Kept for the menu: no install bar of Chrome's own over the page's buttons
  expect(prevented).toBe(true);
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Install app' }).click();
  expect(await page.evaluate(() => window.pwaSpy?.prompted)).toBe(1);

  // A prompt can be shown once: the item hides until the browser sends a new one
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'My devices' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Install app' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await toastShown(page, 'Omnivo is installed');
});

test.describe('Safari on a Mac', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  });

  test('Install app says where Safari’s own command is', async ({ page }) => {
    await start(page);
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Install app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Omnivo' });
    await expect(dialog.getByRole('heading', { name: 'In Safari on a Mac' })).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([
      'Choose File, then Add to Dock.',
      'Click Add.',
    ]);
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('an iPhone', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('Install app gives the Add to Home Screen steps', async ({ page }) => {
    await start(page);
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Install app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Omnivo' });
    await expect(dialog.getByRole('heading', { name: 'On an iPhone or iPad' })).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([
      'Tap Share in the toolbar.',
      'Tap Add to Home Screen.',
      'Tap Add.',
    ]);
  });
});

test('the app icon counts the changes waiting on the device', async ({ page, context }) => {
  await start(page);
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(0);

  await context.setOffline(true);
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Sylhet Pharmacy');
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page
    .getByRole('group', { name: 'Address 1' })
    .getByLabel('Address', { exact: true })
    .fill('Zindabazar, Sylhet 3100');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(1);

  // Synced: the count goes from the icon
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(0);
});

function storageCard(page: Page): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Storage on this device' }) });
}

test('the Sync page says whether the browser keeps the copy, and asks', async ({ page }) => {
  await start(page);
  await openFromNav(page, /^Sync/);
  const card = storageCard(page);
  await expect(card.getByText('May be cleared')).toBeVisible();
  await expect(card.getByText('24.5 MB used. The browser allows up to 1.2 GB.')).toBeVisible();

  await card.getByRole('button', { name: 'Ask to keep it' }).click();
  await expect(card.getByText('Kept', { exact: true })).toBeVisible();
  await expect(
    card.getByText('The browser keeps this copy, even when the device runs low on space.'),
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ask to keep it' })).toHaveCount(0);
});

test('a browser that says no is told to install the app', async ({ page }) => {
  await start(page, { keep: false });
  await openFromNav(page, /^Sync/);
  const card = storageCard(page);
  await card.getByRole('button', { name: 'Ask to keep it' }).click();
  await expect(
    card.getByText(
      'The browser said no. Install the app: browsers keep the data of an installed app.',
    ),
  ).toBeVisible();
  await expect(card.getByText('May be cleared')).toBeVisible();
});

test.describe('a new device', () => {
  test.use({ seedDevice: false });

  test('asks the browser to keep the copy once the branch is chosen', async ({ page }) => {
    await page.addInitScript(spyOnBrowser, { keep: true });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Which branch is this device in?' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => window.pwaSpy?.persistCalls)).toBe(0);
    await dialog.getByRole('combobox').selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await expect.poll(() => page.evaluate(() => window.pwaSpy?.persistCalls)).toBe(1);
  });
});
