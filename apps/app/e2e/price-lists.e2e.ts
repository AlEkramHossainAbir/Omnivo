import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 15a in the mock garments workspace: "Export FOB" (the polo shirt's six versions, per piece
// and per dozen) and "Local wholesale" (the crew-neck T-shirt per piece, poly mailers per carton)

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('adds an item in each of its units, prices it, and takes a price out', async ({ page }) => {
  await openFromNav(page, 'Price lists');
  await listItem(page, /Local wholesale/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Local wholesale' })).toBeVisible();
  // The garments workspace quotes before VAT (Settings → Sales)
  await expect(page.getByText('Prices before VAT')).toBeVisible();

  // One product, two rows: its base unit and its pack (a gross of 144 buttons)
  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog', { name: 'Add items' });
  await picker.getByRole('searchbox', { name: 'Search products' }).fill('P-00003');
  await expect(picker.getByText('Shirt buttons 4-hole 18L')).toBeVisible();
  await picker.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByLabel('Price of Shirt buttons 4-hole 18L per pcs', { exact: true }).fill('0.45');
  await page.getByLabel('Price of Shirt buttons 4-hole 18L per gross', { exact: true }).fill('60');
  await expect(page.getByText('2 prices changed')).toBeVisible();
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await expect(page.getByText(/prices? changed/)).toBeHidden();

  // An empty price takes the item out of the list: it sells at its own sale price again
  await page
    .getByRole('button', { name: 'Remove the price of Basic crew-neck T-shirt per pcs' })
    .click();
  await expect(page.getByText('1 price changed')).toBeVisible();
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search the prices' }).fill('crew-neck');
  await expect(page.getByText('No price matches "crew-neck"')).toBeVisible();
  await expectNoSideScroll(page);
});

test('archives a price list, and its prices can no longer be changed', async ({ page }) => {
  await openFromNav(page, 'Price lists');
  await listItem(page, /Export FOB/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Export FOB' })).toBeVisible();
  await expect(
    page.getByLabel('Price of Pique polo shirt · M / Navy blue per dozen', { exact: true }),
  ).toBeVisible();
  // Archive sits in the edit dialog, with the name and description
  await page.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('dialog', { name: 'Edit Export FOB' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByText('Export FOB archived')).toBeVisible();
  await expect(page.getByText(/^This price list is archived/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add items' })).toHaveCount(0);
  await expect(
    page.getByLabel('Price of Pique polo shirt · M / Navy blue per dozen', { exact: true }),
  ).toBeDisabled();
  await expectNoSideScroll(page);
});
