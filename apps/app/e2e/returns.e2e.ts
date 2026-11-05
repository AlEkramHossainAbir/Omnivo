import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 15d: sales returns. Garments: H&M's confirmed order SO-…-0001 asks for 5 dozen polo shirts
// in M and in L (Navy blue) at ৳6,900 a dozen; they leave the Main store at ৳410 a piece. Pharma:
// Lazz Pharma, Napa 500 mg in the Main store (lots NP24090 and NP24117, ৳0.85 a tablet), and an
// empty "Damage and expiry" store for what comes back. The mock posts no return of its own.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// Search the picker, add the item, and close the dialog
async function addItem(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products' }).fill(search);
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

// DC-…-0001: all of H&M's order leaves, and the order is "Delivered"
async function deliverOrder(page: Page) {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
}

// SR-…-0001: one dozen M shirts come back from the challan, before anything was billed
async function takeOneDozenBack(page: Page) {
  await page.getByRole('button', { name: 'Take goods back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales return' })).toBeVisible();
  await line(page, 2).getByRole('button', { name: 'Remove line 2' }).click();
  await line(page, 1).getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /SR-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByRole('heading', { level: 1, name: /SR-\d{4}-\d{2}-0001/ })).toBeVisible();
}

test('takes goods back from a challan, at the cost they left at', async ({ page }) => {
  await deliverOrder(page);
  await page.getByRole('button', { name: 'Take goods back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales return' })).toBeVisible();
  // Every line of the challan, in its own unit, back where it left from
  await expect(line(page, 1).getByText(/From DC-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(line(page, 1).getByText('60 pcs can still come back')).toBeVisible();
  await expect(line(page, 1).getByLabel('Quantity')).toHaveValue('5');
  await expect(page.getByLabel('Back into warehouse').locator('option:checked')).toHaveText(
    'MAIN · Main store',
  );
  await expect(page.getByLabel('Reason').locator('option:checked')).toHaveText('Damaged');
  await expectNoSideScroll(page);
  await line(page, 2).getByRole('button', { name: 'Remove line 2' }).click();
  await line(page, 1).getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /SR-\d{4}-\d{2}-0001 posted/);

  // 12 pieces at the ৳410 each left at; not billed yet, so no credit note is needed
  await expect(page.getByRole('heading', { level: 1, name: /SR-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('৳4,920.00').first()).toBeVisible();
  await expect(page.getByText('Not billed yet: the invoice bills less')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write credit note' })).toHaveCount(0);
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText(/SR-\d{4}-\d{2}-0001/);
  await expect(sheet).toContainText('Sales return');

  // The cost back in the books, and back from the entry to the return
  await page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ }).click();
  await expect(page.getByText('৳4,920.00').first()).toBeVisible();
  await page.getByRole('link', { name: /From SR-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /SR-\d{4}-\d{2}-0001/ })).toBeVisible();

  // The challan says what came back
  await page.getByRole('link', { name: /^DC-\d{4}-\d{2}-0001$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Partly returned').first()).toBeVisible();
  await expect(page.getByText('12 pcs came back')).toBeVisible();
  await expect(page.getByRole('link', { name: /SR-\d{4}-\d{2}-0001/ })).toBeVisible();

  // Not billed: the order can deliver the dozen again, so it is no longer "Delivered"
  await page.getByRole('link', { name: /SO-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Partly delivered').first()).toBeVisible();

  // 120 − 60 + 12 in the Main store, and the stock card links the return
  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('ST-118-M-NAV');
  await expect(listItem(page, /Pique polo shirt/)).toContainText('72 pcs');
  await listItem(page, /Pique polo shirt/).click();
  await listItem(page, /SR-\d{4}-\d{2}-0001 .* Came back/).click();
  await expect(page.getByRole('heading', { level: 1, name: /SR-\d{4}-\d{2}-0001/ })).toBeVisible();
});

test('bills only what is left of a challan line that partly came back', async ({ page }) => {
  await deliverOrder(page);
  await takeOneDozenBack(page);
  await page.getByRole('link', { name: /^DC-\d{4}-\d{2}-0001$/ }).click();
  await page.getByRole('button', { name: 'Make invoice' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  // The M line: 5 dozen left, 1 dozen came back, 4 dozen to bill at the order's ৳6,900 a dozen.
  // What is left is a whole number of dozens, so the line keeps the challan's unit
  await expect(
    line(page, 1).getByText('12 pcs came back before billing: this bills the rest'),
  ).toBeVisible();
  // The challan's own quantity is text, not a box: the invoice bills it whole
  await expect(line(page, 1)).toContainText(/Unit\s*dozen\s*Quantity\s*4/);
  // ৳27,600 for the M shirts + ৳34,500 for the L shirts
  await expect(page.getByText('৳62,100.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  // Nothing is left to bill on the challan (the invoice lists it with its date)
  await page.getByRole('link', { name: /^DC-\d{4}-\d{2}-0001 / }).click();
  await expect(page.getByText('Invoiced', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make invoice' })).toHaveCount(0);
});

test('takes back expired strips with no challan into the damage store', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  await openFromNav(page, 'Sales returns');
  await page.getByRole('button', { name: 'New return' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales return' })).toBeVisible();
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('lazz');
  await page.getByRole('option', { name: /Lazz Pharma/ }).click();
  await page.getByLabel('Back into warehouse').selectOption({ label: 'DMG · Damage and expiry' });
  await page.getByLabel('Reason').selectOption({ label: 'Expired' });

  // Napa has no stock in the damage store: the batch is one of the lots it was sold from
  await addItem(page, 'Napa', 'Napa 500 mg');
  await expect(
    line(page, 1).getByText('Not from a challan: it comes back at the average cost'),
  ).toBeVisible();
  await line(page, 1).getByLabel('Unit').selectOption({ label: 'strip = 10 pcs' });
  await line(page, 1).getByLabel('Quantity').fill('3');
  // The option says the lot and its expiry date, which moves with today: picked by the lot
  const batch = line(page, 1).getByLabel('Batch');
  const lot = await batch.locator('option', { hasText: 'NP24117' }).getAttribute('value');
  await batch.selectOption(lot ?? '');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /SR-\d{4}-\d{2}-0001 posted/);
  // 30 tablets at the ৳0.85 average
  await expect(page.getByText('৳25.50').first()).toBeVisible();
  await expect(page.getByText('NP24117').first()).toBeVisible();
});

test('refuses an item with no cost yet, under the item', async ({ page }) => {
  await openFromNav(page, 'Sales returns');
  await page.getByRole('button', { name: 'New return' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales return' })).toBeVisible();
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
  await page.getByRole('option', { name: /Aarong/ }).click();
  await page.getByLabel('Back into warehouse').selectOption({ label: 'MAIN · Main store' });
  // A style that never had stock: its cost is unknown
  await addItem(page, 'ST-20001', 'ST-20001');
  await line(page, 1).getByLabel('Quantity').fill('2');
  await page.getByRole('button', { name: 'Post return' }).click();
  await expect(
    line(page, 1).getByText(
      'This item has no cost in the books yet, so it cannot come back on its own.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales return' })).toBeVisible();
});
