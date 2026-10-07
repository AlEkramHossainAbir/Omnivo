import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b in the mock garments workspace: three quotations. QT-…-0001 (H&M) was declined,
// QT-…-0002 (Primark) is open but its date has passed, QT-…-0003 (Aarong) is open. Aarong buys
// on the "Local wholesale" price list: the T-shirt at ৳290 a piece, the mailer bags at ৳2,750 a
// carton. The workspace quotes before VAT.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// Search the picker, add the product, and close the dialog. The row is found by its name: the
// list shows other products until the search has settled.
async function addItem(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill(search);
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

test('lists the quotations with their status, and filters them', async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toContainText('Aarong');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toContainText('Open');
  // Open, but its "valid until" date has passed: worked out by the page
  await expect(listItem(page, /QT-\d{4}-\d{2}-0002/)).toContainText('Expired');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0001/)).toContainText('Declined');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Declined' }).check({ force: true });
  await expect(listItem(page, /QT-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toHaveCount(0);
});

test("writes a quotation at the customer's prices, and makes it an order", async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await page.getByRole('button', { name: 'New quotation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New quotation' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);

  await addItem(page, 'crew-neck', 'Basic crew-neck T-shirt');
  await expect(line(page, 1).getByLabel('Price before VAT')).toHaveValue('290.00');
  await expect(line(page, 1).getByText('From their price list')).toBeVisible();
  await line(page, 1).getByLabel('Quantity').fill('100');

  // The mailer bags are sold by the piece at the product's price; in cartons the list has them
  await addItem(page, 'mailer', 'Poly mailer bag 10x14');
  await expect(line(page, 2).getByText('Product price')).toBeVisible();
  await line(page, 2).getByLabel('Unit').selectOption({ label: 'carton = 500 pcs' });
  await expect(line(page, 2).getByLabel('Price before VAT')).toHaveValue('2,750.00');
  await line(page, 2).getByLabel('Quantity').fill('2');
  await line(page, 2).getByLabel('Discount', { exact: true }).fill('5');

  // 100 × 290 + 2 × 2,750 − 5% = 34,225 before VAT; 15% VAT = 5,133.75
  await expect(page.getByText('৳34,225.00')).toBeVisible();
  await expect(page.getByText('৳5,133.75')).toBeVisible();
  await expect(page.getByText('৳39,358.75')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Save quotation' }).click();
  await toastShown(page, /QT-\d{4}-\d{2}-0004 saved/);
  await expect(page.getByRole('heading', { level: 1, name: /QT-\d{4}-\d{2}-0004/ })).toBeVisible();

  await page.getByRole('button', { name: 'Make order' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales order' })).toBeVisible();
  await expect(line(page, 2).getByLabel('Quantity')).toHaveValue('2');
  // The quotation's customer stays: the order accepts that customer's offer
  await expect(page.getByRole('button', { name: 'Customer', exact: true })).toBeDisabled();
  await page.getByLabel('Send from').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText(/SO-\d{4}-\d{2}-0002 confirmed/)).toBeVisible();

  await openFromNav(page, 'Quotations');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0004/)).toContainText('Accepted');
});

test('marks an open quotation declined, and opens it again', async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await listItem(page, /QT-\d{4}-\d{2}-0003/).click();
  await expect(page.getByRole('heading', { level: 1, name: /QT-\d{4}-\d{2}-0003/ })).toBeVisible();

  await page.getByRole('button', { name: 'Mark declined' }).click();
  await toastShown(page, /QT-\d{4}-\d{2}-0003 marked declined/);
  await expect(
    page.getByText('The customer said no. Open it again if they change their mind.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make order' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open again' }).click();
  await expect(page.getByText(/QT-\d{4}-\d{2}-0003 is open again/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make order' })).toBeVisible();
});
