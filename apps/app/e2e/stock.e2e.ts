import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav says "Adjustments"; the page says more in its heading
async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

async function newAdjustment(page: Page) {
  await openPage(page, 'Adjustments', 'Stock adjustments');
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New stock adjustment' })).toBeVisible();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
}

// Scan (type) into the picker and press Enter: the only match is added, the dialog stays open
async function scan(page: Page, code: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill(code);
  await expect(page.getByRole('dialog').getByText(/in stock here/)).toHaveCount(1);
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await page.keyboard.press('Escape');
}

test('posts opening stock found in a count, and the stock goes up', async ({ page }) => {
  await newAdjustment(page);
  await page.getByLabel('Reason').selectOption({ label: 'Found in a count' });
  await scan(page, '8941100500118');
  const line = page.getByRole('group', { name: 'Line 1' });
  await expect(line.getByText('Basic crew-neck T-shirt')).toBeVisible();
  await line.getByLabel('Quantity').fill('20');
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002 posted/)).toBeVisible();

  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('crew-neck');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toContainText('452 pcs');
  await listItem(page, /Basic crew-neck T-shirt/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Basic crew-neck T-shirt' }),
  ).toBeVisible();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002/).first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('refuses to take out more than the warehouse holds', async ({ page }) => {
  await newAdjustment(page);
  await page.getByRole('radio', { name: 'Stock out' }).check({ force: true });
  await expect(page.getByLabel('Reason')).toHaveValue('damaged');
  await scan(page, 'P-00004');
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('5000');
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(
    page.getByText('Not enough stock here. Lower the quantity or pick another batch.'),
  ).toBeVisible();
});

test('receives a transfer short, and keeps the shortage on it', async ({ page }) => {
  await openPage(page, 'Transfers', 'Stock transfers');
  await listItem(page, /TRF-/).first().click();
  await expect(
    page.getByRole('heading', { name: 'Receive at CTG · Chattogram depot' }),
  ).toBeVisible();
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Arrived').fill('40');
  await page.getByRole('button', { name: 'Receive transfer' }).click();
  await expect(page.getByText(/TRF-\d{4}-\d{2}-0001 received/)).toBeVisible();
  await expect(page.getByText('Short by 8 pcs')).toBeVisible();
  await expect(page.getByText('Short', { exact: true })).toBeVisible();
  await expectNoSideScroll(page);
});

test('lists what fell to its reorder level, and sets a new level', async ({ page }) => {
  await openFromNav(page, 'Reorder');
  await expect(listItem(page, /Poly mailer bag 10x14/)).toContainText('3,000 pcs');

  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('crew-neck');
  await listItem(page, /Basic crew-neck T-shirt/).click();
  await page.getByRole('button', { name: 'Set the reorder level at MAIN · Main store' }).click();
  await page.getByLabel('Reorder when stock falls to').fill('500');
  await page.getByLabel('Order quantity').fill('1200');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Reorder level saved')).toBeVisible();
  await expect(page.getByText('At 500 pcs · Order 1,200 pcs')).toBeVisible();

  await openFromNav(page, 'Reorder');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
});
