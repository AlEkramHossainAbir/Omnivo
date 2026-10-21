import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 15c: money receipts in the mock garments workspace. Aarong buys the crew-neck T-shirt at
// ৳290 a piece plus 15% VAT, so 10 of them are a ৳3,335 invoice. The chart's money accounts are
// 1110 Cash in hand and everything inside the groups 1120 Bank accounts and 1130 Mobile wallets.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

// INV-…-0001 for Aarong: 10 T-shirts, delivered by the invoice itself from the Main store
async function postAarongInvoice(page: Page) {
  await openFromNav(page, 'Invoices');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('10');
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
}

test('takes a payment from the invoice, and voids it when the cheque bounces', async ({ page }) => {
  await postAarongInvoice(page);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Record a payment' })).toBeVisible();
  // What the invoice still owes, applied to it
  await expect(page.getByLabel(/Amount applied to INV-\d{4}-\d{2}-0001/)).toHaveValue('3,335.00');

  // Only money accounts: cash, and the bank account inside the "Bank accounts" group
  const account = page.getByLabel('Received into');
  await expect(
    account.getByRole('option', { name: '1121 · Dutch-Bangla Bank CD A/C 1234' }),
  ).toHaveCount(1);
  await expect(account.getByRole('option', { name: /Accounts receivable/ })).toHaveCount(0);
  await account.selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel('Paid by').selectOption({ label: 'Cheque' });
  await page.getByLabel('Reference (optional)').fill('Cheque 0045123, Sonali Bank Motijheel');
  // Three active branches: none is picked for the person
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await expect(page.getByRole('heading', { level: 1, name: /MR-\d{4}-\d{2}-0001/ })).toBeVisible();

  await page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: /MR-\d{4}-\d{2}-0001/ }).click();

  await page.getByRole('button', { name: 'Void receipt' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Cheque bounced: not enough funds');
  await dialog.getByRole('button', { name: 'Void receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 voided/);
  await expect(page.getByText('Voided', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Voided on .+: Cheque bounced: not enough funds/)).toBeVisible();
  await expect(page.getByText('Not applied to any invoice.')).toBeVisible();

  // The money came off the invoice again
  await openFromNav(page, 'Invoices');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Unpaid');
});

test('keeps an advance, and applies it to a later invoice', async ({ page }) => {
  await openFromNav(page, 'Money receipts');
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  // The list has a "Customer" filter too: wait for the form before picking
  await expect(page.getByRole('heading', { level: 1, name: 'Record a payment' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await expect(
    page.getByText('This customer has no unpaid invoice. The whole amount stays as an advance.'),
  ).toBeVisible();
  await page.getByLabel('Amount').fill('5000');
  await page.getByLabel('Received into').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await expect(page.getByText(/৳5,000\.00 is not applied to an invoice yet/)).toBeVisible();

  await postAarongInvoice(page);
  await openFromNav(page, 'Money receipts');
  await listItem(page, /MR-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'Apply money' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Apply oldest first' }).click();
  await expect(dialog.getByLabel(/Amount applied to INV-\d{4}-\d{2}-0001/)).toHaveValue('3,335.00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 applied/);
  // ৳5,000 − ৳3,335 = ৳1,665 still waits for an invoice
  await expect(page.getByText(/৳1,665\.00 is not applied to an invoice yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expectNoSideScroll(page);
});
