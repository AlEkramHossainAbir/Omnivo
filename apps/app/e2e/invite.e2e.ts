import { expect, test } from '@playwright/test';

// mocks/people-data.ts-এর DEMO_TOKENS — ইমেইল ছাড়াই join পেজ
test('joins with a new account from the email link', async ({ page }) => {
  await page.goto('/invite#mock-new-account-invitation-token-0001');
  await expect(page.getByRole('heading', { name: 'Join Rahman Garments Ltd.' })).toBeVisible();
  await page.getByLabel('Full name').fill('Tanvir Hossain');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await page.getByLabel('Password').fill('Konabari-cut-2026');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('asks an existing account only for its password', async ({ page }) => {
  await page.goto('/invite#mock-existing-account-invitation-token-01');
  await expect(page.getByLabel('Full name')).toBeHidden();
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByRole('alert')).toHaveText(/Email or password is incorrect/);
});

test('explains an expired or made-up link', async ({ page }) => {
  await page.goto('/invite#this-link-was-never-sent-by-anyone-at-all');
  await expect(
    page.getByRole('heading', { name: 'This invitation link has expired' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
});
