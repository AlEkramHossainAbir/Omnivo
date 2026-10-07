import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b: deliveries (challans) against the seeded confirmed orders. Garments: H&M's
// SO-…-0001, 5 dozen polo shirts in M and in L (Navy blue), from the Main store, which holds 120
// of each. Pharma: Lazz Pharma's SO-…-0001, 40 boxes of Napa (4,000 tablets); the batch that
// expires first, NP24090, holds only 3,000.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

async function deliverOrder(page: Page, number: RegExp) {
  await openFromNav(page, 'Sales orders');
  await listItem(page, number).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New delivery' })).toBeVisible();
}

test('delivers part of an order, books its cost, and closes the rest', async ({ page }) => {
  // Promised, not delivered: shown next to what is on hand, nothing held
  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('ST-118-M-NAV');
  await expect(listItem(page, /Pique polo shirt/)).toContainText('60 pcs');

  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  // The form starts with what is left on the order, from the order's warehouse
  await expect(line(page, 1).getByText('Ordered 5 dozen')).toBeVisible();
  await expect(line(page, 2)).toBeVisible();
  await line(page, 2).getByRole('button', { name: 'Remove line 2' }).click();
  await page.getByLabel('Vehicle and driver (optional)').fill('Chatto Metro-Ta 14-2210, Rahim');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Cost of goods sold at the moving average: 60 pieces at ৳410
  await expect(page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ })).toBeVisible();
  await expect(page.getByText('৳24,600.00').first()).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: /SO-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Partly delivered').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Something went out, so the order is closed, not cancelled
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close order' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0001 closed/);
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();

  // 60 of the 120 left the Main store; the closed rest is no longer on order
  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('ST-118-M-NAV');
  await expect(listItem(page, /Pique polo shirt/)).toContainText('60 pcs');
  await expect(listItem(page, /Pique polo shirt/)).not.toContainText('120 pcs');
  await openFromNav(page, 'Deliveries');
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toContainText('Posted');
});

test('refuses to deliver more than the order has left', async ({ page }) => {
  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  await line(page, 1).getByLabel('Quantity').fill('6');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await expect(
    line(page, 1).getByText('This is more than the order has left to deliver. Lower the quantity.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'New delivery' })).toBeVisible();
});

test('splits a delivery over batches, first expiry first', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  await expect(line(page, 1).getByText('Napa 500 mg')).toBeVisible();
  await line(page, 1).getByRole('button', { name: 'Split by first expiry' }).click();
  // 3,000 tablets from the batch that expires first, the other 1,000 from the next one
  await expect(line(page, 1).getByLabel('Quantity')).toHaveValue('3000');
  await expect(line(page, 2).getByLabel('Quantity')).toHaveValue('1000');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('NP24090').first()).toBeVisible();
  await expect(page.getByText('NP24117').first()).toBeVisible();

  // Everything on the order went out: the delivery finished it
  await openFromNav(page, 'Sales orders');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('Delivered');
});
