import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Roles');
});

test('creates a role and gives it permissions in the grid', async ({ page }) => {
  await page.getByRole('button', { name: 'New role' }).click();
  const dialog = page.getByRole('dialog', { name: 'New role' });
  // নামের বড়-ছোট হাত আলাদা হলেও একই — সার্ভারের 409 ঘরের নিচে
  await dialog.getByLabel('Name').fill('accountant');
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(dialog.getByText('Another role already has this name.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Quality inspector');
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Quality inspector created')).toBeVisible();

  const cell = page.getByRole('checkbox', { name: 'Quality inspector: See the audit log' });
  await cell.click();
  await expect(page.getByText('1 role has unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();
  await expect(cell).toBeChecked();
  await expectNoSideScroll(page);
});

test('keeps the Owner column ticked and locked', async ({ page }) => {
  const cell = page.getByRole('checkbox', { name: 'Owner: Edit company settings and numbering' });
  await expect(cell).toBeChecked();
  await expect(cell).toBeDisabled();
});
