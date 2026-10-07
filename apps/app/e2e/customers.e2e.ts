import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 15a in the mock garments workspace: five customers (C-00001 to C-00005, the last one
// archived). H&M owes ৳38,50,000 from last year's export sale, Primark ৳24,50,000 from this
// year's; both are receivable lines in the seeded journal.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const address = (page: Page, number: number) =>
  page.getByRole('group', { name: `Address ${String(number)}` });

test("lists the customers with what they owe, and opens one's statement", async ({ page }) => {
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');
  await expect(listItem(page, /Bengal Buying House/)).toContainText('Cash only');
  await expectNoSideScroll(page);

  await listItem(page, /Primark Stores/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Primark Stores Ltd.' })).toBeVisible();
  await expect(page.getByText('Owes ৳24,50,000')).toBeVisible();
  await expect(page.getByText('120 days').first()).toBeVisible();
  // The statement: this year's sale, with the running balance
  await expect(page.getByText('Export sale to Primark, Dublin')).toBeVisible();
  await expectNoSideScroll(page);
});

test('adds a customer with a billing and a shipping address, and finds it by phone', async ({
  page,
}) => {
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New customer' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Chattogram Fashion House');
  await page.getByLabel('Group').selectOption({ label: 'Local buyers' });
  await page.getByLabel('Phone (optional)', { exact: true }).fill('+880 1811-445566');
  await page.getByLabel('Payment terms').fill('45');
  await page.getByLabel('Credit limit').fill('250000');
  await page.getByLabel('Price list').selectOption({ label: 'Local wholesale' });

  await page.getByRole('button', { name: 'Add an address' }).click();
  await address(page, 1).getByLabel('Address', { exact: true }).fill('42 Agrabad C/A, Chattogram');
  await page.getByRole('button', { name: 'Add an address' }).click();
  // The second address starts as a shipping one. Made a billing one, the form refuses it before
  // saving: the invoice prints one billing address.
  await expect(address(page, 2).getByLabel('Kind')).toHaveValue('shipping');
  await address(page, 2).getByLabel('Address', { exact: true }).fill('Agrabad depot, Chattogram');
  await address(page, 2).getByLabel('Kind').selectOption({ label: 'Billing' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(
    page.getByText('A customer has one billing address. Make this one a shipping address.'),
  ).toBeVisible();
  await address(page, 2).getByLabel('Kind').selectOption({ label: 'Shipping' });
  await address(page, 2).getByLabel('Label (optional)').fill('Agrabad depot');
  await page.getByRole('button', { name: 'Add customer' }).click();

  await expect(page.getByText('Chattogram Fashion House added')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Chattogram Fashion House' }),
  ).toBeVisible();
  // The next number of the series, after the five seeded customers
  await expect(page.getByText('C-00006').first()).toBeVisible();
  await expect(page.getByText('Default for deliveries')).toBeVisible();
  await expect(page.getByText('Nothing owed')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Customers' }).first().click();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('1811');
  await expect(listItem(page, /Chattogram Fashion House/)).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toHaveCount(0);
});

test('archives a customer with entries, and deletes one without', async ({ page }) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /H&M Hennes & Mauritz/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'H&M Hennes & Mauritz GBC AB' }),
  ).toBeVisible();
  // Two clicks: the first asks
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete C-00001' }).click();
  await expect(
    page.getByText('Entries use this customer, so it cannot be deleted. Archive it instead.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('H&M Hennes & Mauritz GBC AB archived')).toBeVisible();
  await expect(page.getByText(/^This customer is archived/)).toBeVisible();
  // Its balance stays: the money is still owed
  await expect(page.getByText('Owes ৳38,50,000')).toBeVisible();

  await page.getByRole('link', { name: 'Customers' }).first().click();
  await listItem(page, /Bengal Buying House/).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete C-00004' }).click();
  await expect(page.getByText('Bengal Buying House Ltd. deleted')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
  await expect(listItem(page, /Bengal Buying House/)).toHaveCount(0);
});

test('keeps a group that holds customers, and deletes an empty one', async ({ page }) => {
  await openFromNav(page, 'Customer groups');
  await expect(listItem(page, /Export buyers/)).toContainText('2 customers');

  await page.getByRole('button', { name: 'Add group' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add group' });
  await dialog.getByLabel('Name').fill('Dealers');
  await dialog.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Dealers added')).toBeVisible();
  await expect(listItem(page, /Dealers/)).toContainText('0 customers');

  await listItem(page, /Export buyers/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Export buyers' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Export buyers' }).click();
  await expect(
    dialog.getByText('Customers are in this group. Move them to another group first.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await listItem(page, /Dealers/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Dealers' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Dealers' }).click();
  await expect(page.getByText('Dealers deleted')).toBeVisible();
  await expect(listItem(page, /Dealers/)).toHaveCount(0);
  await expectNoSideScroll(page);
});
