import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15d: credit notes in the mock garments workspace. H&M's order SO-…-0001 bills 10 dozen polo
// shirts at ৳6,900 a dozen, zero-rated (৳69,000). Aarong buys the crew-neck T-shirt at ৳290 a piece
// plus 15% VAT, so 10 of them are a ৳3,335 invoice. The garments chart has no "Sales returns"
// account, so a credit note takes the sale back from Export sales itself.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

// The 1st of the month `months` months back: always before today, whatever day the test runs
async function firstOfMonthsAgo(page: Page, box: string, months: number) {
  await page.getByRole('button', { name: box }).click();
  for (let step = 0; step < months; step += 1) {
    await page.getByRole('button', { name: /previous month/i }).click();
  }
  await page.locator('td[data-day$="-01"]:not([data-outside]) button').click();
}

// An Aarong invoice of 10 T-shirts (৳3,335), delivered by the invoice itself. `months`: dated the
// 1st of a month that many months back.
async function postAarongInvoice(page: Page, number: string, months?: number) {
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
  await line(page, 1).getByLabel('Quantity').fill('10');
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
  if (months !== undefined) await firstOfMonthsAgo(page, 'Invoice date', months);
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, new RegExp(`INV-\\d{4}-\\d{2}-${number} posted`));
}

test('gives the money back for goods that came back after billing', async ({ page }) => {
  // Four documents and more on a phone-sized page: three times the usual 30 seconds, so a busy
  // machine does not fail it half-way
  test.slow();
  // H&M's order is delivered and billed: ৳69,000
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await page.getByRole('button', { name: 'Make invoice' }).click();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  // A dozen M shirts come back after billing
  await page.getByRole('link', { name: /^DC-\d{4}-\d{2}-0001 / }).click();
  await page.getByRole('button', { name: 'Take goods back' }).click();
  await line(page, 2).getByRole('button', { name: 'Remove line 2' }).click();
  await line(page, 1).getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /SR-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText(/Billed on INV-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(
    page.getByText('Some of these goods were billed already. Write a credit note', {
      exact: false,
    }),
  ).toBeVisible();

  // The credit note starts with the returned dozen at the invoice's price
  await page.getByRole('button', { name: 'Write credit note' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New credit note' })).toBeVisible();
  await expect(page.getByLabel('Invoice').locator('option:checked')).toHaveText(
    /INV-\d{4}-\d{2}-0001/,
  );
  await expect(page.getByLabel('Reason').locator('option:checked')).toHaveText('Goods came back');
  await expect(line(page, 1).getByText(/Goods back on SR-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(page.getByText('৳6,900.00').first()).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post credit note' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 posted/);

  // Applied to its own invoice, which still owed all of it
  await expect(page.getByRole('heading', { level: 1, name: /CN-\d{4}-\d{2}-0001/ })).toBeVisible();
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText('Credit note');
  await expect(sheet).toContainText('Original invoice');
  await page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ }).click();
  await expect(page.getByText('৳6,900.00').first()).toBeVisible();
  await page.getByRole('link', { name: /From CN-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /CN-\d{4}-\d{2}-0001/ })).toBeVisible();

  // The invoice: partly credited, and ৳69,000 − ৳6,900 still due
  await page
    .getByRole('link', { name: /^INV-\d{4}-\d{2}-0001/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Partly credited').first()).toBeVisible();
  await expect(page.getByText('৳62,100.00').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /CN-\d{4}-\d{2}-0001/ })).toBeVisible();
});

test('credits a whole invoice in one click', async ({ page }) => {
  await postAarongInvoice(page, '0001');
  await page.getByRole('button', { name: 'Credit whole invoice' }).click();
  await toastShown(page, 'Draft credit note written for every line. Check it, then post it.');
  await expect(page.getByRole('heading', { level: 1, name: 'Draft credit note' })).toBeVisible();
  await expect(page.getByLabel('Reason').locator('option:checked')).toHaveText('Other');
  // The totals' last line: the invoice select says ৳3,335.00 too, in a hidden option
  await expect(
    page.getByRole('region', { name: 'Items' }).getByRole('definition').last(),
  ).toHaveText('৳3,335.00');
  await page.getByRole('button', { name: 'Post credit note' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 posted/);

  // Everything taken back: "Credited" instead of the payment pill, and nothing left to credit
  await page
    .getByRole('link', { name: /^INV-\d{4}-\d{2}-0001/ })
    .first()
    .click();
  await expect(page.getByText('Credited', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Unpaid', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Credit whole invoice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write credit note' })).toHaveCount(0);
  await openFromNav(page, 'Invoices');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Credited');
});

test('warns when the invoice is more than 6 months old, and still posts', async ({ page }) => {
  await postAarongInvoice(page, '0001', 7);
  await page.getByRole('button', { name: 'Write credit note' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New credit note' })).toBeVisible();
  await expect(page.getByLabel('Invoice').locator('option:checked')).toHaveText(
    /INV-\d{4}-\d{2}-0001/,
  );
  await expect(page.getByText(/more than 6 months before this credit note/)).toBeVisible();

  // A price cut of ৳20 a piece on the 10 T-shirts: ৳200 + 15% VAT
  await page.getByRole('button', { name: 'Add invoice lines' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await page.keyboard.press('Escape');
  await line(page, 1).getByLabel('Price before VAT').fill('20');
  await expectNoSideScroll(page);
  // A warning only (you chose this): the credit note posts
  await page.getByRole('button', { name: 'Post credit note' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('৳230.00').first()).toBeVisible();
});

test('applies what a credit note has left to another invoice', async ({ page }) => {
  // Four documents and more on a phone-sized page: three times the usual 30 seconds, so a busy
  // machine does not fail it half-way
  test.slow();
  // INV-…-0001 is paid in full, then credited in full: the credit is Aarong's advance
  await postAarongInvoice(page, '0001');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Received into').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ }).click();
  await page.getByRole('button', { name: 'Credit whole invoice' }).click();
  await page.getByRole('button', { name: 'Post credit note' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText(/৳3,335\.00 is not applied to an invoice yet/)).toBeVisible();

  await postAarongInvoice(page, '0002');
  await openFromNav(page, 'Credit notes');
  await listItem(page, /CN-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'Apply money' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Apply CN-\d{4}-\d{2}-0001/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply oldest first' }).click();
  await expect(dialog.getByLabel(/Amount applied to INV-\d{4}-\d{2}-0002/)).toHaveValue('3,335.00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toastShown(page, /CN-\d{4}-\d{2}-0001 applied/);
  await expect(page.getByText(/is not applied to an invoice yet/)).toHaveCount(0);

  await page.getByRole('link', { name: /INV-\d{4}-\d{2}-0002/ }).click();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
});
