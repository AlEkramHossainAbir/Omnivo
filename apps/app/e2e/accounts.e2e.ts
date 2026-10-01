import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Chart of accounts');
});

const tree = (page: Page) => page.getByRole('list', { name: 'Chart of accounts' });

// An account's row: its name is a button (it opens the edit dialog)
const account = (page: Page, name: string) => tree(page).getByRole('button', { name, exact: true });

// Everything under a group: the group's list item holds its own row and the nested list. Every
// list item above it contains the name too; the group's own item is the innermost, which comes
// last in page order. `has` is searched inside each item, so it starts from `page`, not the tree.
const group = (page: Page, name: string) =>
  tree(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name, exact: true }) })
    .last();

test('adds an account from its group, with a code suggested and a taken code refused', async ({
  page,
}) => {
  await group(page, 'Bank accounts')
    .getByRole('button', { name: 'Add an account to Bank accounts' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Add account' });
  // After 1121 and 1122 in the group
  await expect(dialog.getByLabel('Code')).toHaveValue('1123');
  await expect(dialog.getByText('Asset · grows with a debit')).toBeVisible();

  await dialog.getByLabel('Code').fill('1110');
  await dialog.getByLabel('Name').fill('BRAC Bank CD A/C 5678');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog.getByText('Another account already uses this code.')).toBeVisible();

  await dialog.getByLabel('Code').fill('1123');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('BRAC Bank CD A/C 5678 added')).toBeVisible();
  await expect(group(page, 'Bank accounts').getByText('BRAC Bank CD A/C 5678')).toBeVisible();
  await expectNoSideScroll(page);
});

test('moves an account to another group of its type', async ({ page }) => {
  await account(page, 'Dutch-Bangla Bank CD A/C 1234').click();
  const dialog = page.getByRole('dialog', { name: 'Edit 1121' });
  // The select offers only asset groups, indented by depth (two em spaces = third level)
  await dialog
    .getByLabel('Group')
    .selectOption({ label: '  1130 · Mobile wallets (bKash, Nagad)' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    group(page, 'Mobile wallets (bKash, Nagad)').getByText('Dutch-Bangla Bank CD A/C 1234'),
  ).toBeVisible();
  await expect(
    group(page, 'Bank accounts').getByText('Dutch-Bangla Bank CD A/C 1234'),
  ).toBeHidden();
});

test('searches inside the groups, shows archived accounts and folds the tree', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search accounts' });
  await search.fill('vat');
  await expect(account(page, 'Input VAT')).toBeVisible();
  await expect(account(page, 'Output VAT')).toBeVisible();
  // Its group stays, so you still see where it sits; unrelated accounts go
  await expect(account(page, 'Current assets')).toBeVisible();
  await expect(account(page, 'Cash in hand')).toBeHidden();

  await search.fill('lc margin');
  await expect(page.getByText('No account matches "lc margin"')).toBeVisible();
  await search.fill('');

  await expect(account(page, 'Sonali Bank CD A/C 0071')).toBeHidden();
  await page.getByText('Show archived').click();
  await expect(
    tree(page)
      .getByRole('listitem')
      .filter({ hasText: 'Sonali Bank CD A/C 0071' })
      .getByText('Archived'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(account(page, 'Current assets')).toBeHidden();
  await page.getByRole('button', { name: 'Show the accounts in Assets' }).click();
  await expect(account(page, 'Current assets')).toBeVisible();
  await expect(account(page, 'Cash in hand')).toBeHidden();
});

test('protects system accounts, archives only empty groups and deletes in two clicks', async ({
  page,
}) => {
  await account(page, 'Accounts receivable').click();
  const system = page.getByRole('dialog', { name: 'Edit 1140' });
  await expect(system.getByText('Omnivo posts what customers owe to this account')).toBeVisible();
  await expect(system.getByRole('button', { name: 'Archive' })).toBeHidden();
  await system.getByRole('button', { name: 'Cancel' }).click();

  await account(page, 'Fixed assets').click();
  const fixed = page.getByRole('dialog', { name: 'Edit 1200' });
  await fixed.getByRole('button', { name: 'Archive' }).click();
  await expect(fixed.getByRole('alert')).toHaveText(/Archive the accounts under this group first/);
  await fixed.getByRole('button', { name: 'Cancel' }).click();

  await account(page, 'Accumulated depreciation').click();
  const depreciation = page.getByRole('dialog', { name: 'Edit 1290' });
  await depreciation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(depreciation.getByText('This cannot be undone.')).toBeVisible();
  await depreciation.getByRole('button', { name: 'Delete 1290' }).click();
  await expect(page.getByText('Accumulated depreciation deleted')).toBeVisible();
  await expect(account(page, 'Accumulated depreciation')).toBeHidden();
});
