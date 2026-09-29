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
