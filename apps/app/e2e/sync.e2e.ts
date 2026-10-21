import type { Page } from '@playwright/test';

import { expect, listItem, openFromNav, test, toastShown, waitForCopy } from './helpers.js';

// Step 18a: the products and customers pages read the copy on this device, which the mock fills
// from its own data (src/mocks/sync-data.ts). The garments workspace has three active branches and
// an archived one, so a new device asks which branch it is in; the other tests start with a device
// of the head office (the fixture in helpers.ts). Offline is Playwright's context.setOffline: the mock then fails every
// request like a dead network (the first handler in handlers.ts). Pages change through the nav,
// never with a reload: an offline reload needs the service worker of step 19.

// The local databases of this browser profile: one per person and workspace (decision 41)
function localDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name ?? '')
      .filter((name) => name.startsWith('omnivo-')),
  );
}

test.describe('a device without a branch', () => {
  test.use({ seedDevice: false });

  test('asks which branch it is in, and offers it again where the copy is needed', async ({
    page,
  }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Which branch is this device in?' });
    // Only the active branches: the Narayanganj dyeing unit is archived
    await expect(dialog.getByLabel('Branch').getByRole('option')).toHaveText([
      'Pick a branch',
      'CTG · Chattogram depot',
      'GZP · Gazipur factory',
      'HO · Head office',
    ]);
    // Nothing picked: no quick click sets a shop's device up for the head office
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await expect(dialog.getByText('Pick an active branch.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();

    // "Not now": the pages that read the copy say why they are empty, with the way out
    await openFromNav(page, 'Products');
    await expect(page.getByText('This device is not set up yet')).toBeVisible();
    await page.getByRole('button', { name: 'Choose the branch' }).click();
    await dialog.getByLabel('Branch').selectOption({ label: 'CTG · Chattogram depot' });
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await toastShown(page, 'This device is set up for Chattogram depot');
    await waitForCopy(page);

    await page.getByRole('searchbox', { name: 'Search products' }).fill('pique');
    await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
    await openFromNav(page, 'Customers');
    await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeVisible();
  });
});

test('keeps the products and customers working when the connection drops', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('pique');
  await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');

  await context.setOffline(true);
  // A balance needs the server (decision 10): a dash, never the last one seen, which may be wrong
  // by now
  await expect(page.getByText('Balances need a connection').first()).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).not.toContainText('৳38,50,000');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('primark');
  await expect(listItem(page, /Primark Stores/)).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeHidden();

  // Search and a scanned barcode run on the device
  await openFromNav(page, 'Products');
  await search.fill('8941100500118');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  // Archived products are not on the device (decision 11)
  await page.getByText('Archived', { exact: true }).click();
  await expect(page.getByText('Needs a connection')).toBeVisible();
  await expect(
    page.getByText('Archived products are not kept on this device. Connect to the internet'),
  ).toBeVisible();

  // Back online: the server's archived list, and the balances again
  await context.setOffline(false);
  await expect(page.getByText('Needs a connection')).toBeHidden();
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');
  await expect(page.getByText('Balances need a connection')).toBeHidden();
});

test('a change saved here reaches the copy, and an archived product leaves it', async ({
  page,
}) => {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('mailer');
  await listItem(page, /Poly mailer bag 10x14/).click();
  await page.getByLabel('Name').fill('Poly mailer bag 12x16');
  await page.getByRole('button', { name: 'Save product' }).click();
  await toastShown(page, 'Poly mailer bag 12x16 saved');
  // The save asks for a pull (api.ts → onApiWrite): the list shows the copy's new row
  await openFromNav(page, 'Products');
  await search.fill('mailer');
  await expect(listItem(page, /Poly mailer bag 12x16/)).toBeVisible();
  await expect(listItem(page, /Poly mailer bag 10x14/)).toBeHidden();

  await listItem(page, /Poly mailer bag 12x16/).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await toastShown(page, 'Poly mailer bag 12x16 archived');
  await openFromNav(page, 'Products');
  await search.fill('mailer');
  await expect(page.getByText('No product matches "mailer"')).toBeVisible();
  // The server's archived list has it
  await page.getByText('Archived', { exact: true }).click();
  await expect(listItem(page, /Poly mailer bag 12x16/)).toBeVisible();
});

test('signing out deletes the copy on this device', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeVisible();
  await expect.poll(() => localDatabases(page)).toHaveLength(1);

  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // The next person at a shop's computer cannot read it (decision 41)
  await expect.poll(() => localDatabases(page)).toEqual([]);
});
