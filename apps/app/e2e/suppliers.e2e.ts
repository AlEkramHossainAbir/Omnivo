import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';

// Step 17a in the mock garments workspace: three suppliers, S-00001 to S-00003. The company owes
// Meghna Spinning Mills ৳21,00,000 from last year's yarn (a payable line of the seeded journal).
// Gazipur Carton Industries is paid on receipt. Bengal Buying House (C-00004) is a customer with
// no entries.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const bankAccount = (page: Page, number: number) =>
  page.getByRole('group', { name: `Bank account ${String(number)}` });

test("lists the suppliers with what is owed, and opens one's bank account", async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await expect(listItem(page, /Meghna Spinning Mills/)).toContainText('৳21,00,000');
  await expect(listItem(page, /Gazipur Carton Industries/)).toContainText('On receipt');
  await expectNoSideScroll(page);

  await listItem(page, /Meghna Spinning Mills/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Meghna Spinning Mills Ltd.' }),
  ).toBeVisible();
  // The API sends debit − credit (negative while owed); the page says it the way people do
  await expect(page.getByText('You owe ৳21,00,000')).toBeVisible();
  await expect(page.getByText('60 days').first()).toBeVisible();
  await expect(page.getByText('Dutch-Bangla Bank, Narayanganj')).toBeVisible();
  await expect(page.getByText('1071100023456')).toBeVisible();
  await expect(page.getByText('Routing 090670725')).toBeVisible();
  await expectNoSideScroll(page);
});

test('adds a supplier with a bank account, and checks the account number', async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New supplier' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Padma Poly Packaging');
  await page.getByLabel('Group').selectOption({ label: 'Packaging' });
  await page.getByLabel('Payment terms').fill('30');
  await page.getByRole('button', { name: 'Add a bank account' }).click();
  await bankAccount(page, 1).getByLabel('Bank', { exact: true }).fill('BRAC Bank');
  await bankAccount(page, 1).getByLabel('Account name').fill('Padma Poly Packaging');
  await bankAccount(page, 1).getByLabel('Account number').fill('15-01');
  await bankAccount(page, 1)
    .getByLabel(/^Routing number/)
    .fill('0605');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  // The form's own check, before anything is sent
  await expect(page.getByText('Enter the account number: 6 to 20 digits.')).toBeVisible();
  await expect(
    page.getByText('Enter the 9-digit routing number, or leave it empty.'),
  ).toBeVisible();

  // Spaces and dashes are taken out: what is kept is the digits a bank's app wants
  await bankAccount(page, 1).getByLabel('Account number').fill('1501 2040 5567 001');
  await bankAccount(page, 1)
    .getByLabel(/^Routing number/)
    .fill('060-261-726');
  await page.getByRole('button', { name: 'Add supplier' }).click();

  await expect(page.getByText('Padma Poly Packaging added')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Padma Poly Packaging' })).toBeVisible();
  // The next number of the supplier series, after the three seeded ones
  await expect(page.getByText('S-00004').first()).toBeVisible();
  await expect(page.getByText('150120405567001')).toBeVisible();
  await expect(page.getByText('Routing 060261726')).toBeVisible();
  await expect(page.getByText('Nothing owed')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Suppliers' }).first().click();
  await page.getByRole('searchbox', { name: 'Search suppliers' }).fill('padma');
  await expect(listItem(page, /Padma Poly Packaging/)).toBeVisible();
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

test('makes a customer a supplier too, and then deletes only the supplier side', async ({
  page,
}) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /Bengal Buying House/).click();
  await page.getByRole('button', { name: 'Make supplier too' }).click();
  // The supplier's page, with its own fields at their defaults (decision 37)
  await expect(page.getByText('Bengal Buying House Ltd. is a supplier too')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Bengal Buying House Ltd.' }),
  ).toBeVisible();
  await expect(page.getByText('Also a customer')).toBeVisible();
  // One party, one code: the customer's
  await expect(page.getByText('C-00004').first()).toBeVisible();
  await expect(page.getByText('House 9, Road 4, Gulshan 1, Dhaka 1212')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/^Bengal Buying House Ltd\. is also a customer/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete C-00004' }).click();
  await expect(page.getByText('Bengal Buying House Ltd. is no longer a supplier')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible();
  await expect(listItem(page, /Bengal Buying House/)).toHaveCount(0);

  // The customer stays, and could be made a supplier again
  await openFromNav(page, 'Customers');
  await listItem(page, /Bengal Buying House/).click();
  await expect(page.getByRole('button', { name: 'Make supplier too' })).toBeVisible();
});

test('refuses to delete a supplier the books name, and archives it instead', async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await listItem(page, /Meghna Spinning Mills/).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete S-00001' }).click();
  await expect(
    page.getByText(
      'Entries or purchase documents use this supplier, so it cannot be deleted. Archive it instead.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('Meghna Spinning Mills Ltd. archived')).toBeVisible();
  await expect(page.getByText(/^This supplier is archived/)).toBeVisible();
  // What is owed stays: the money is still owed
  await expect(page.getByText('You owe ৳21,00,000')).toBeVisible();
});

test('names the supplier on a payable line, and the supplier is then owed it', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Narration').fill('Trims for the Primark samples, billed later');
  const line = (number: number) => page.getByRole('group', { name: `Line ${String(number)}` });
  await line(1).getByLabel('Account').selectOption({ label: '5110 · Cost of goods sold' });
  await line(1).getByLabel('Debit').fill('12500');
  await line(2).getByLabel('Account').selectOption({ label: '2110 · Accounts payable' });
  await line(2).getByLabel('Credit').fill('12500');
  await page.getByRole('button', { name: 'Post entry' }).click();
  // The payable is kept per supplier (decision 11), like the receivable per customer
  await expect(line(2).getByText(/^Pick who this amount belongs to/)).toBeVisible();

  await line(2).getByLabel('Supplier').click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();

  await openFromNav(page, 'Suppliers');
  await expect(listItem(page, /Unitex Trims/)).toContainText('৳12,500');
  await listItem(page, /Unitex Trims/).click();
  await expect(page.getByText('You owe ৳12,500')).toBeVisible();
  // The statement: this year's entry, with what is owed after it
  await expect(page.getByText('Trims for the Primark samples, billed later')).toBeVisible();
  await expectNoSideScroll(page);
});

test('keeps a supplier group that holds suppliers, and deletes an empty one', async ({ page }) => {
  await openFromNav(page, 'Supplier groups');
  await expect(listItem(page, /Yarn and fabric/)).toContainText('1 supplier');

  await page.getByRole('button', { name: 'Add group' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add group' });
  await dialog.getByLabel('Name').fill('Dyes and chemicals');
  await dialog.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Dyes and chemicals added')).toBeVisible();
  await expect(listItem(page, /Dyes and chemicals/)).toContainText('0 suppliers');

  await listItem(page, /Yarn and fabric/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Yarn and fabric' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Yarn and fabric' }).click();
  await expect(dialog.getByText(/^Suppliers are in this group/)).toBeVisible();
  await page.keyboard.press('Escape');

  await listItem(page, /Dyes and chemicals/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Dyes and chemicals' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Dyes and chemicals' }).click();
  await expect(page.getByText('Dyes and chemicals deleted')).toBeVisible();
  await expect(listItem(page, /Dyes and chemicals/)).toHaveCount(0);
  await expectNoSideScroll(page);
});
