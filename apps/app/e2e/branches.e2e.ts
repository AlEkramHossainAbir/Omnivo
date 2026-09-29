import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Branches');
});

test('adds a branch, refuses a code already in use, then archives it', async ({ page }) => {
  await page.getByRole('button', { name: 'Add branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add branch' });
  // ছোট হাতে লিখলেও GZP — আগে থেকেই আছে, সার্ভারের 409 ঘরের নিচে
  await dialog.getByLabel('Code').fill('gzp');
  await dialog.getByLabel('Name').fill('Second Gazipur unit');
  await dialog.getByRole('button', { name: 'Add branch' }).click();
  await expect(dialog.getByText('Another branch already uses this code.')).toBeVisible();

  await dialog.getByLabel('Code').fill('MYM');
  await dialog.getByLabel('Name').fill('Mymensingh sales office');
  await dialog.getByRole('button', { name: 'Add branch' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Mymensingh sales office added')).toBeVisible();

  await listItem(page, /Mymensingh sales office/).click();
  await page
    .getByRole('dialog', { name: 'Edit MYM' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByText('Mymensingh sales office archived')).toBeVisible();
  await expect(listItem(page, /Mymensingh sales office/)).toBeHidden();

  await page.getByText('Archived', { exact: true }).click();
  await expect(listItem(page, /Mymensingh sales office/)).toBeVisible();
  await expectNoSideScroll(page);
});

test('keeps the last active branch', async ({ page }) => {
  for (const [name, code] of [
    [/Chattogram depot/, 'CTG'],
    [/Gazipur factory/, 'GZP'],
  ] as const) {
    await listItem(page, name).click();
    await page
      .getByRole('dialog', { name: `Edit ${code}` })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await listItem(page, /Head office/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit HO' });
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/Keep at least one branch active/);
});
