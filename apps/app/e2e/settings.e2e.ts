import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

// ১×১ px PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Settings');
});

test('checks the BIN, then saves the company profile', async ({ page }) => {
  const bin = page.getByLabel('BIN');
  await bin.fill('12345');
  await page.getByRole('button', { name: 'Save changes' }).click();
  // ফর্মের নিজের যাচাই (contracts-এর একই schema) — সার্ভারে যাওয়ার আগেই
  await expect(page.getByText('Enter the 13-digit BIN, like 000123456-0101.')).toBeVisible();

  await bin.fill('000123456-0202');
  await page.getByLabel('Legal name').fill('Rahman Knit Garments Limited');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  // সেভের পরে ফর্ম আবার "অপরিবর্তিত" — বাটন বন্ধ, দুবার চাপা যায় না
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expectNoSideScroll(page);
});

test('uploads a logo and refuses an SVG before sending it anywhere', async ({ page }) => {
  const file = page.locator('input[type="file"]');
  await file.setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(page.getByText('Use a PNG, JPG or WebP image.')).toBeVisible();

  await file.setInputFiles({ name: 'rahman-logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Logo updated')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Rahman Garments Ltd. logo' })).toBeVisible();
});

test('shows the regional defaults for Bangladesh', async ({ page }) => {
  await expect(page.getByLabel('Base currency')).toHaveValue('BDT');
  await expect(page.getByLabel('Fiscal year starts in')).toHaveValue('7');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Dhaka');
});

// Step 15a: the VAT rates card. The mock workspace has the six NBR rates, VAT 15% the default.
test('adds a VAT rate, makes it the default, and keeps the default from being archived', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: /^VAT 15%/ })).toContainText('Default');
  await page.getByRole('button', { name: 'Add rate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add VAT rate' });
  await dialog.getByLabel('Name').fill('VAT 2.4%');
  await dialog.getByLabel('Kind').selectOption({ label: 'Reduced' });
  // A reduced rate charges something: 0% would put the sale in the wrong box of the return
  await dialog.getByLabel('Rate', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  await expect(
    dialog.getByText(
      'Standard and reduced rates are above 0%. Zero-rated and exempt rates are 0%.',
    ),
  ).toBeVisible();
  await dialog.getByLabel('Rate', { exact: true }).fill('2.4');
  await dialog.getByText('Use it for products without their own rate').click();
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByText('VAT 2.4% added')).toBeVisible();
  // One default: the new one took it over
  await expect(page.getByRole('button', { name: /^VAT 2\.4%/ })).toContainText('Default');
  await expect(page.getByRole('button', { name: /^VAT 15%/ })).not.toContainText('Default');

  await page.getByRole('button', { name: /^VAT 2\.4%/ }).click();
  const edit = page.getByRole('dialog', { name: 'Edit VAT 2.4%' });
  await expect(
    edit.getByText('This is the default. To change it, make another rate the default.'),
  ).toBeVisible();
  await edit.getByRole('button', { name: 'Archive' }).click();
  await expect(
    edit.getByText('The default rate cannot be archived. Make another rate the default first.'),
  ).toBeVisible();
  await expectNoSideScroll(page);
});

test('says whether the prices include VAT', async ({ page }) => {
  const box = page.getByLabel('Prices include VAT');
  // The garments workspace quotes before VAT
  await expect(box).not.toBeChecked();
  await page.getByText('Prices include VAT', { exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(box).toBeChecked();
});
