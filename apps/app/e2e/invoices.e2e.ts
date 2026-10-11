import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, readOnlyItem, toastShown } from './helpers.js';

// Step 15c in the mock garments workspace. H&M's confirmed order SO-…-0001 asks for 5 dozen polo
// shirts in M and in L at ৳6,900 a dozen, zero-rated (an export). Aarong buys the crew-neck
// T-shirt at ৳290 a piece from the "Local wholesale" list, VAT 15% on top; it has a ৳5,00,000
// credit limit and 30 days to pay. Bengal Buying House buys for cash only (a ৳0 limit). The mock
// posts no invoice of its own: every invoice here is the test's.

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

// Search the picker, add the product, and close the dialog (as in quotations.e2e.ts)
async function addItem(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill(search);
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

// A counter sale with no order: the invoice delivers its own goods from the Main store
async function newDirectInvoice(page: Page, search: string, customer: RegExp, quantity: string) {
  await openFromNav(page, 'Invoices');
  // The page header's button; the empty list has one too
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, search, customer);
  await addItem(page, 'crew-neck', 'Basic crew-neck T-shirt');
  await line(page, 1).getByLabel('Quantity').fill(quantity);
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
}

test('bills a challan at the order’s prices, and the challan shows it billed', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('Not invoiced').first()).toBeVisible();

  await page.getByRole('button', { name: 'Make invoice' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  // Both challan lines, priced from the order: 10 dozen at ৳6,900, zero-rated
  await expect(line(page, 1).getByText(/From DC-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(line(page, 2).getByText(/From DC-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(page.getByText('৳69,000.00').first()).toBeVisible();
  // The challan's warehouse belongs to the head office: whose sale it is
  await expect(page.getByLabel('Branch')).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Unpaid', { exact: true }).first()).toBeVisible();
  await expectNoSideScroll(page);

  // The printed page is in the document, hidden until the browser prints it
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText(/INV-\d{4}-\d{2}-0001/);
  await expect(sheet).toContainText('Rahman Garments Ltd.');

  // The sale in the books, and back from the entry to the invoice
  await page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ }).click();
  await expect(page.getByText('৳69,000.00').first()).toBeVisible();
  await page.getByRole('link', { name: /From INV-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();

  await page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Invoiced', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make invoice' })).toHaveCount(0);

  // Billed in full: gone from "To invoice", listed under "Invoiced"
  await openFromNav(page, 'Deliveries');
  await page.getByRole('radio', { name: 'To invoice' }).check({ force: true });
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toHaveCount(0);
  await page.getByRole('radio', { name: 'Invoiced' }).check({ force: true });
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toBeVisible();
});

test('writes an invoice that delivers its own goods', async ({ page }) => {
  await newDirectInvoice(page, 'aarong', /Aarong/, '10');
  // The customer's credit: nothing owed or on order yet
  await expect(page.getByText('Credit left: ৳5,00,000 of ৳5,00,000')).toBeVisible();
  await expect(line(page, 1).getByText('Delivered by this invoice')).toBeVisible();
  // 10 at ৳290 = ৳2,900, plus 15% VAT = ৳3,335
  await expect(page.getByText('৳3,335.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  // Posting made the challan that took the goods out: listed under "Challans"
  await page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Its note names the invoice (the printed challan says it too)
  await expect(page.getByText(/Invoice INV-\d{4}-\d{2}-0001/).first()).toBeVisible();
  await expect(page.getByText('Invoiced', { exact: true }).first()).toBeVisible();

  await openFromNav(page, 'Invoices');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Aarong');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Unpaid');
  await expectNoSideScroll(page);
});

// The 1st of last month in the calendar of a date box: always before today, whatever today is
async function firstOfLastMonth(page: Page, box: string | RegExp) {
  await page.getByRole('button', { name: box }).click();
  await page.getByRole('button', { name: /previous month/i }).click();
  await page.locator('td[data-day$="-01"]:not([data-outside]) button').click();
}

test('shows an invoice past its due date as overdue', async ({ page }) => {
  await newDirectInvoice(page, 'aarong', /Aarong/, '1');
  await firstOfLastMonth(page, 'Invoice date');
  await firstOfLastMonth(page, /^Due date/);
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('Overdue', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This invoice was due on .+ days late\./)).toBeVisible();

  await openFromNav(page, 'Invoices');
  await page.getByRole('radio', { name: 'Overdue' }).check({ force: true });
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Overdue');
  await page.getByRole('radio', { name: 'Paid', exact: true }).check({ force: true });
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toHaveCount(0);
});

test('bills a service straight from its order', async ({ page }) => {
  // Aarong's draft order gets an embroidery charge, and is confirmed
  await openFromNav(page, 'Sales orders');
  await listItem(page, /Aarong/).click();
  await addItem(page, 'embroidery', 'Logo embroidery');
  await line(page, 2).getByLabel('Quantity').fill('100');
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 confirmed/);

  await openFromNav(page, 'Invoices');
  // The page header's button; the empty list has one too
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByRole('button', { name: 'Add order charges' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('listitem')
    .filter({ hasText: /SO-\d{4}-\d{2}-0002/ })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  await page.keyboard.press('Escape');
  // Only the service: the T-shirts are billed from their challan once they leave
  await expect(line(page, 1).getByText(/Service on SO-\d{4}-\d{2}-0002/)).toBeVisible();
  await expect(line(page, 2)).toHaveCount(0);
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  // 100 at ৳18 = ৳1,800, plus 15% VAT = ৳2,070
  await expect(page.getByText('৳2,070.00').first()).toBeVisible();

  // Billed: the order can no longer be taken back to draft
  await page
    .getByRole('link', { name: /SO-\d{4}-\d{2}-0002/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0002/ })).toBeVisible();
  await page.getByRole('button', { name: 'Back to draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Back to draft' }).click();
  await expect(page.getByText(/Invoices bill this order/)).toBeVisible();
});

test('asks before going over a credit limit, and records the override', async ({ page }) => {
  await newDirectInvoice(page, 'bengal', /Bengal Buying House/, '2');
  await expect(page.getByText('Cash only: no credit')).toBeVisible();
  await page.getByRole('button', { name: 'Post invoice' }).click();

  const dialog = page.getByRole('dialog', { name: 'Over the credit limit' });
  await expect(dialog).toContainText(/to ৳\S+, over their credit limit of ৳0\.00/);
  await dialog.getByRole('button', { name: 'Post anyway' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /credit limit/i).first()).toBeVisible();
});
