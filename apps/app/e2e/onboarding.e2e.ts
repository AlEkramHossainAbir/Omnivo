import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// The mock starts signed in (as the Rahman Garments owner). Sign out through the menu — client-side,
// so the mock keeps its state — then create a new workspace from the sign-up page.
async function signUpNewWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  // Desktop: the account button at the bottom of the sidebar; phone: the icon in the top bar.
  // Only one of them is visible at a time.
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Create a workspace' }).click();

  await page.getByLabel('Company name').fill('Karim Knitwear Ltd.');
  await page.getByLabel('Full name').fill('Karim Uddin');
  await page.getByLabel('Work email').fill('karim@karimknitwear.com');
  await page.getByLabel('Password').fill('Ashulia-knit-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
}

test('a new workspace goes through the setup wizard', async ({ page }) => {
  await signUpNewWorkspace(page);

  // 1) Business type — the router sent us here, not to the dashboard
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'What does Karim Knitwear Ltd. do?' }),
  ).toBeVisible();
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  // A wrong pick first. Click the card, as a person would: the radio inside is visually hidden (sr-only)
  await page.getByText('Pharmaceuticals').click();
  await expect(page.getByRole('radio', { name: /Pharmaceuticals/ })).toBeChecked();
  await expectNoSideScroll(page);
  await next.click();

  // Back from the company step: nothing was sent yet, so the pick is still there and can change
  await expect(page.getByRole('heading', { level: 1, name: 'Company details' })).toBeVisible();
  await expect(page.getByText('The business type is fixed after this step')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Pharmaceuticals/ })).toBeChecked();
  await page.getByText('Garments & textiles').click();
  await expect(page.getByRole('radio', { name: /Garments & textiles/ })).toBeChecked();
  await next.click();

  // 2) Company details — the form's own check, then skip (this sends the business type)
  await expect(page.getByRole('heading', { level: 1, name: 'Company details' })).toBeVisible();
  await page.getByLabel('BIN').fill('12345');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter the 13-digit BIN')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // 3) Invite team — waits for the background job, then offers its roles. Not asserting the
  // short "Preparing the roles…" state: on a slow machine the 2-second job is done before we look
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
  // The second pick is the one that was sent: garments roles, not pharma ones — and the chart
  // came with them (the mock's garments chart has 47 accounts: 41, and step 14's six for stock)
  await expect(page.getByRole('status')).toHaveText(
    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 47 accounts\./,
  );

  // Back from here reaches the company details, but no further: the business type is sent
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Company details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeHidden();
  await expect(page.getByText('The business type is fixed after this step')).toBeHidden();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();

  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite people' });
  await dialog.getByLabel('Email').fill('nasrin@karimknitwear.com');
  await dialog.getByRole('checkbox', { name: /Accountant/ }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog).toBeHidden();
  // In the page's "Invited" list — the toast is a list item too, outside <main>
  await expect(
    page.getByRole('main').getByRole('listitem').filter({ hasText: 'nasrin@karimknitwear.com' }),
  ).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  // The bell has the job's "workspace is set up" notification
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
});
