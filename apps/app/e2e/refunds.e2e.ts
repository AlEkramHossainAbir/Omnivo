import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 15d: refunds, and the sales returns account. Garments: Aarong pays ৳5,000 for an order that
// is then cancelled, or is billed 10 T-shirts (৳3,335) that are paid and then credited in full;
// either way the money is Aarong's advance, and it is paid back in cash. Pharma: the chart has
// "4120 Sales returns", chosen for credit notes when the workspace was set up.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

test('pays an advance back from its receipt, and voids the refund', async ({ page }) => {
  await openFromNav(page, 'Money receipts');
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Record a payment' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByLabel('Amount').fill('5000');
  await page.getByLabel('Received into').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);

  // The form starts from the receipt: its money left, and its branch
  await page.getByRole('button', { name: 'Pay back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pay money back' })).toBeVisible();
  await expect(page.getByLabel('Pay back from').locator('option:checked')).toHaveText(
    /Money receipt MR-\d{4}-\d{2}-0001 · ৳5,000\.00 left/,
  );
  await expect(page.getByLabel('Amount')).toHaveValue('5,000.00');
  await expect(page.getByLabel('Branch').locator('option:checked')).toHaveText('Head office');
  await page.getByLabel('Paid from').selectOption({ label: '1110 · Cash in hand' });
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save refund' }).click();
  await toastShown(page, /RF-\d{4}-\d{2}-0001 saved/);
  await expect(page.getByRole('heading', { level: 1, name: /RF-\d{4}-\d{2}-0001/ })).toBeVisible();
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText('Refund');
  await expect(sheet).toContainText('Amount paid back');

  // The money out in the books, and back from the entry to the refund
  await page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ }).click();
  await page.getByRole('link', { name: /From RF-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /RF-\d{4}-\d{2}-0001/ })).toBeVisible();

  // The receipt's money was paid back: it cannot be voided before the refund
  await page.getByRole('link', { name: /MR-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /MR-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay back' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Void receipt' }).click();
  const receiptDialog = page.getByRole('dialog');
  await receiptDialog.getByLabel('Reason').fill('Cheque bounced: not enough funds');
  await receiptDialog.getByRole('button', { name: 'Void receipt' }).click();
  await expect(
    receiptDialog.getByText(
      'Some of this money was paid back to the customer. Void the refund first',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The cash never reached Aarong: void the refund, and the advance is back
  // Exact: "Supplier refunds" (step 17d) holds the word too
  await openFromNav(page, /^Refunds$/);
  await listItem(page, /RF-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'Void refund' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Void RF-\d{4}-\d{2}-0001/ })).toBeVisible();
  await dialog.getByLabel('Reason').fill('The shop owner was not at the counter');
  await dialog.getByRole('button', { name: 'Void refund' }).click();
  await toastShown(page, /RF-\d{4}-\d{2}-0001 voided/);
  await expect(page.getByText(/Voided on .+: The shop owner was not at the counter/)).toBeVisible();
  await expect(page.locator('[data-print-sheet]')).toHaveCount(0);

  await page.getByRole('link', { name: /MR-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByText(/৳5,000\.00 is not applied to an invoice yet/)).toBeVisible();
});

test('pays back what a credit note left as an advance', async ({ page }) => {
  // Four documents and more on a phone-sized page: three times the usual 30 seconds, so a busy
  // machine does not fail it half-way
  test.slow();
  // INV-…-0001 for 10 T-shirts, paid, then credited in full
  await openFromNav(page, 'Invoices');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
  const row = picker.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('10');
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Received into').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ }).click();
  await page.getByRole('button', { name: 'Credit whole invoice' }).click();
  await page.getByRole('button', { name: 'Post credit note' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 posted/);

  await page.getByRole('button', { name: 'Pay back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pay money back' })).toBeVisible();
  await expect(page.getByLabel('Pay back from').locator('option:checked')).toHaveText(
    /Credit note CN-\d{4}-\d{2}-0001 · ৳3,335\.00 left/,
  );
  await expect(page.getByLabel('Amount')).toHaveValue('3,335.00');
  await page.getByLabel('Paid from').selectOption({ label: '1110 · Cash in hand' });
  await page.getByRole('button', { name: 'Save refund' }).click();
  await toastShown(page, /RF-\d{4}-\d{2}-0001 saved/);

  // Nothing is left on the credit note to pay back
  await page.getByRole('link', { name: /CN-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /CN-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Paid back')).toBeVisible();
  await expect(page.getByText(/is not applied to an invoice yet/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pay back' })).toHaveCount(0);
});

test('keeps the sales returns account, and protects it on the chart', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  // Chosen when the pharmacy's chart was set up
  await openFromNav(page, 'Settings');
  const select = page.getByLabel('Sales returns account');
  await expect(select.locator('option:checked')).toHaveText('4120 · Sales returns');

  // Credit notes post to it: it cannot be archived while it is chosen
  await openFromNav(page, 'Chart of accounts');
  await page
    .getByRole('list', { name: 'Chart of accounts' })
    .getByRole('button', { name: 'Sales returns', exact: true })
    .click();
  const edit = page.getByRole('dialog', { name: 'Edit 4120' });
  await edit.getByRole('button', { name: 'Archive' }).click();
  await expect(edit.getByRole('alert')).toHaveText(/Credit notes post to this account/);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toBeHidden();

  // Back to taking sales back from the Sales account itself
  await openFromNav(page, 'Settings');
  await select.selectOption({ label: 'None: take it off the Sales account itself' });
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await toastShown(page, 'Sales returns account saved');
  await expect(select.locator('option:checked')).toHaveText(
    'None: take it off the Sales account itself',
  );
});
