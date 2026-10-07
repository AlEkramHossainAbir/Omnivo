import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b in the mock garments workspace: SO-…-0001 is H&M's confirmed export order (5 dozen
// polo shirts in M and in L, nothing delivered yet), and Aarong has a draft order without a
// number. Numbers are given when an order is confirmed.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('lists the orders, and filters them by status and customer', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('H&M Hennes & Mauritz');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('Confirmed');
  await expect(listItem(page, /Aarong/)).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Draft' }).check({ force: true });
  await expect(listItem(page, /Aarong/)).toBeVisible();
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toHaveCount(0);

  await page.getByRole('radio', { name: 'All' }).check({ force: true });
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('h&m');
  await page.getByRole('option', { name: /H&M/ }).click();
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(listItem(page, /Aarong/)).toHaveCount(0);
});

test('confirms a draft, and takes it back to draft with its number', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /Aarong/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft order' })).toBeVisible();

  await page.getByRole('button', { name: 'Confirm order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 confirmed/);
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0002/ })).toBeVisible();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Back to draft' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Take SO-\d{4}-\d{2}-0002 back to draft/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to draft' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 is a draft again/);
  // A numbered draft is not deleted: the customer was given that number
  await expect(page.getByText(/This draft keeps its number SO-\d{4}-\d{2}-0002/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete draft' })).toHaveCount(0);
  await expectNoSideScroll(page);
});

test('cancels a confirmed order that delivered nothing', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('PO-HM-2026-1187')).toBeVisible();
  // Nothing went out yet: "Close" (stop delivering the rest) is for a partly delivered order
  await expect(page.getByRole('button', { name: 'Close order' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The order is called off.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0001 cancelled/);
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'New delivery' })).toHaveCount(0);
});
