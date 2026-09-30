import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Team');
});

test('invites someone, refuses a second invitation, then cancels it', async ({ page }) => {
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite people' });
  await dialog.getByLabel('Email').fill('Tanvir@RahmanGarments.com');
  // রোল না বেছে পাঠানো — ফর্মের নিজের যাচাই, সার্ভারে যায় না
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog.getByText('Pick at least one role.')).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Accountant/ }).click();
  // Owner বাক্স owner-এর জন্য খোলা (mock-এ আমি owner)
  await expect(dialog.getByRole('checkbox', { name: /Owner/ })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Invitation sent to tanvir@rahmangarments.com')).toBeVisible();

  await page.getByRole('button', { name: 'Invite people' }).click();
  await dialog.getByLabel('Email').fill('tanvir@rahmangarments.com');
  await dialog.getByRole('checkbox', { name: /Merchandiser/ }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog.getByText(/already has an open invitation/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await listItem(page, /tanvir@rahmangarments.com/).click();
  await page.getByRole('button', { name: 'Cancel invitation' }).click();
  await expect(page.getByText('Invitation to tanvir@rahmangarments.com cancelled')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open invitations' })).toBeHidden();
  await expectNoSideScroll(page);
});

test("changes a member's roles", async ({ page }) => {
  // নামের ক্রমে প্রথম জন — ২৪১ জনের তালিকা virtualized, ফোনে নিচের কার্ড DOM-এই থাকে না
  await listItem(page, /abdul\.akter8@/).click();
  const dialog = page.getByRole('dialog', { name: 'Abdul Akter' });
  await dialog.getByRole('checkbox', { name: /Merchandiser/ }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Roles of Abdul Akter saved')).toBeVisible();
  await expect(listItem(page, /abdul\.akter8@.*Merchandiser/)).toBeVisible();
});
