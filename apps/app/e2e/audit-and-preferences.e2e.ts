import { expect, type Page, test } from '@playwright/test';

import { listItem, openFromNav, readOnlyItem } from './helpers.js';

// ডেস্কটপে সাইডবারের নিচে নিজের নাম, ফোনে টপ বারের "Account" আইকন — একই মেনু। কোনটা, সেটা
// viewport-এর চওড়া দেখে (৮৬০px-এর নিচে ফোনের layout), isVisible() দিয়ে না: পেজ আঁকা শেষ হওয়ার আগে
// সেটা false দেয়, আর টেস্ট ভুল বাটনে অপেক্ষা করে আটকে থাকত (যাচাইয়ের সময় ঠিক এটাই হয়েছিল)
async function openUserMenu(page: Page): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 1280) < 860;
  await page.getByRole('button', { name: phone ? 'Account' : /Farhana Rahman/ }).click();
}

test('records a branch change in the audit log, with who and what changed', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Branches');
  await listItem(page, /Chattogram depot/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit CTG' });
  await dialog.getByLabel('Name').fill('Chattogram port depot');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();

  await openFromNav(page, 'Audit log');
  const entry = readOnlyItem(page, 'Edited a branch');
  await expect(entry).toContainText('Farhana Rahman');
  await expect(entry).toContainText('Chattogram depot → Chattogram port depot');
});

test('switches to the dark theme and to Bangla from the user menu', async ({ page }) => {
  await page.goto('/');
  await openUserMenu(page);
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await openUserMenu(page);
  await page.getByRole('menuitemradio', { name: 'বাংলা' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'সারসংক্ষেপ' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
});
