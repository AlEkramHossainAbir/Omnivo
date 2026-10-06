import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 14 in the mock garments workspace. Its opening stock was posted with costs (7,200 shirt
// buttons at ৳0.45 = ৳3,240) as JV-…-0007, and the truck to the Chattogram depot as JV-…-0008.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

// Type the code into the picker and press Enter: the only match is added
async function scan(page: Page, code: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill(code);
  await expect(page.getByRole('dialog').getByText(/in stock here/)).toHaveCount(1);
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await page.keyboard.press('Escape');
}

test('posts stock found in a count at its cost, and the journal entry follows it', async ({
  page,
}) => {
  await openPage(page, 'Adjustments', 'Stock adjustments');
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await page.getByLabel('Reason').selectOption({ label: 'Found in a count' });
  await scan(page, 'P-00003');
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('Quantity').fill('800');
  await line.getByLabel('Cost per pcs').fill('0.5');
  await expect(line.getByText('= ৳400.00')).toBeVisible();
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002 posted/)).toBeVisible();

  // The posted adjustment: the line's value, and the entry it made
  await expect(page.getByRole('cell', { name: '৳400.00' }).first()).toBeVisible();
  await page.getByRole('link', { name: /^JV-\d{4}-\d{2}-0009$/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0009$/ }),
  ).toBeVisible();
  await expect(page.getByText('Stock adjustment', { exact: true })).toBeVisible();
  await expect(page.getByText(/A stock document made this entry/)).toBeVisible();
  // Corrected by another stock document, never reversed from the journal
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  await page.getByRole('link', { name: /^From ADJ-/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^ADJ-/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('values the stock, and the books agree with it', async ({ page }) => {
  await openPage(page, 'Valuation', 'Stock valuation');
  await expect(page.getByText('Books agree', { exact: true })).toBeVisible();
  // The list is virtualized on a phone: search, like a person would
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('buttons');
  await expect(listItem(page, /Shirt buttons 4-hole 18L/)).toContainText('৳3,240');
  await listItem(page, /Shirt buttons 4-hole 18L/).click();
  // The stock card: the average cost and the value, and each movement's value
  await expect(
    page.getByRole('heading', { level: 1, name: 'Shirt buttons 4-hole 18L' }),
  ).toBeVisible();
  await expect(page.getByText('Average cost')).toBeVisible();
  await expect(page.getByText('৳0.45').first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('revalues an item, and posts the difference', async ({ page }) => {
  await openPage(page, 'Revaluations', 'Stock revaluations');
  await page.getByRole('button', { name: 'Revalue stock' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revalue stock' })).toBeVisible();
  await scan(page, 'P-00003');
  const line = page.getByRole('group', { name: 'Line 1' });
  // 7,200 buttons worth ৳3,240 now; at ৳0.50 they are worth ৳3,600: ৳360 more
  await line.getByLabel('New cost per pcs').fill('0.5');
  await expect(line.getByText('৳360.00')).toBeVisible();
  await page.getByRole('button', { name: 'Post revaluation' }).click();
  await expect(page.getByText(/REV-\d{4}-\d{2}-0001 posted/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /^REV-/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-0009$/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('chooses where stock documents post', async ({ page }) => {
  await openFromNav(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Stock accounts' })).toBeVisible();
  await page
    .getByLabel('Free samples')
    .selectOption({ label: '5290 · Consumables and internal use' });
  await page.getByRole('button', { name: 'Save stock accounts' }).click();
  await expect(page.getByText('Stock accounts saved')).toBeVisible();
  await expectNoSideScroll(page);
});
