import type { Page } from '@playwright/test';

import { expect, openFromNav, test, toastShown } from './helpers.js';

// Step 19b: the device PIN in the mock app. The mock's key route answers the same key for a device
// at every reload (sync-data.ts), as the API does, so a reload opens the same copy. These tests
// answer the PIN dialog themselves.
test.use({ answerPinDialog: false });
// Each PIN typed or set takes up to a second on purpose (600,000 PBKDF2 rounds, decision 15), and
// a test types up to seven while the mock copies 10,000 styles: 30 seconds is too tight on a busy
// machine
test.describe.configure({ timeout: 90_000 });

const PIN = '480915';
// The same PIN typed on a Bangla keyboard
const BANGLA_PIN = '৪৮০৯১৫';

function setUpDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Set a PIN for this device' });
}

function lockScreen(page: Page) {
  return page.getByRole('heading', { level: 1, name: 'Omnivo is locked' });
}

// Desktop: the account button at the bottom of the sidebar; phone: the icon in the top bar
async function openAccountMenu(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
}

async function setPinInDialog(page: Page, pin = PIN): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('PIN', { exact: true }).fill(pin);
  await dialog.getByLabel('Type the PIN again').fill(pin);
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await toastShown(page, 'Device PIN set');
}

async function lockNow(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Lock now' }).click();
  await expect(lockScreen(page)).toBeVisible();
}

async function typePin(page: Page, pin: string): Promise<void> {
  await page.getByLabel('PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

// The sign-in page after "Forgot PIN?" or a PIN that stopped working
async function signInWithPassword(page: Page): Promise<void> {
  await page.getByLabel('Workspace').fill('rahman-garments');
  await page.getByLabel('Email').fill('farhana@rahmangarments.com');
  await page.getByLabel('Password', { exact: true }).fill('Gazipur-knit-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// The Sync page's card, once the copy is open (the card shows only then). Its pill is the only
// text on the page that says exactly this.
async function pinCard(page: Page, state: 'No PIN' | 'PIN set'): Promise<void> {
  await openFromNav(page, /^Sync/);
  await expect(page.getByRole('heading', { name: 'Device PIN' })).toBeVisible();
  await expect(page.getByText(state, { exact: true })).toBeVisible();
}

test('asks for a PIN once the device is set up, and “Not now” is the answer for this copy', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = setUpDialog(page);
  // After the key's request and the copy's opening, while other tests pull 10,000 styles
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByText('Without a PIN, the data on this device opens only online.', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();

  // Not asked again after a reload; the card still offers it
  await page.reload();
  await pinCard(page, 'No PIN');
  await expect(setUpDialog(page)).toHaveCount(0);

  // "Lock now" without a PIN opens the dialog instead
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Set a PIN to lock' }).click();
  await expect(setUpDialog(page)).toBeVisible();
});

test('refuses an easy PIN and two different ones, then locks and unlocks with the PIN', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = setUpDialog(page);
  await dialog.getByLabel('PIN', { exact: true }).fill('123456');
  await dialog.getByLabel('Type the PIN again').fill('123456');
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await expect(
    dialog.getByText('Pick a PIN that is harder to guess than 123456 or 000000.'),
  ).toBeVisible();
  await dialog.getByLabel('PIN', { exact: true }).fill(PIN);
  await dialog.getByLabel('Type the PIN again').fill('480916');
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await expect(
    dialog.getByText('The two PINs are different. Type the same 6 digits in both boxes.'),
  ).toBeVisible();
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');

  await lockNow(page);
  // The person, so a shared computer shows whose work is locked
  await expect(page.getByText('farhana@rahmangarments.com')).toBeVisible();
  // The lock survives a reload: the server's key alone does not open a locked copy
  await page.reload();
  await expect(lockScreen(page)).toBeVisible();
  await expect(page.getByText('Type the PIN of this device to open your work.')).toBeVisible();

  await typePin(page, '111111');
  await expect(
    page.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
  ).toBeVisible();
  // The field is empty again for the next try
  await expect(page.getByLabel('PIN', { exact: true })).toHaveValue('');
  // Bangla digits become ASCII ones as they are typed
  await page.getByLabel('PIN', { exact: true }).fill(BANGLA_PIN);
  await expect(page.getByLabel('PIN', { exact: true })).toHaveValue(PIN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  // The page it was locked on (a reload keeps the address)
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();

  // The right PIN ended the lock: the next reload opens the app
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(lockScreen(page)).toHaveCount(0);
});

test('five wrong PINs stop the PIN; the password opens the copy and a new PIN is set', async ({
  page,
}) => {
  await page.goto('/');
  await setPinInDialog(page);
  await lockNow(page);
  for (const left of [4, 3, 2, 1]) {
    await typePin(page, '111111');
    const tries = left === 1 ? 'try' : 'tries';
    await expect(
      page.getByText(`Wrong PIN. ${String(left)} ${tries} left, then the PIN stops working.`),
    ).toBeVisible();
  }
  await typePin(page, '111111');
  await expect(
    page.getByText(
      'The PIN was wrong 5 times, so it stopped working. Sign in with your password to open your work.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('PIN', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign in with your password' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(
    page.getByText(
      'Sign in with your password to open your work on this device. You then set a new PIN.',
    ),
  ).toBeVisible();
  await signInWithPassword(page);

  const dialog = page.getByRole('dialog', { name: 'Set a new PIN' });
  await expect(dialog.getByText('The old PIN no longer works.', { exact: false })).toBeVisible();
  await setPinInDialog(page, '135790');
  await pinCard(page, 'PIN set');
  await lockNow(page);
  await typePin(page, '135790');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
});

test('“Forgot PIN?” signs in with the password, and the copy stays', async ({ page }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await lockNow(page);
  await page.getByRole('button', { name: 'Forgot PIN? Sign in with your password' }).click();
  await expect(
    page.getByText(
      'Sign in with your password to open your work on this device. You then set a new PIN.',
    ),
  ).toBeVisible();
  await signInWithPassword(page);

  // The password ended the lock; the PIN went, so the dialog asks for one
  await expect(setUpDialog(page)).toBeVisible();
  await setPinInDialog(page, '246802');
  await openFromNav(page, 'Customers');
  await expect(page.getByText('H&M Hennes & Mauritz').first()).toBeVisible();
});

test('changes the PIN on the Sync page with the current one', async ({ page }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');
  await page.getByRole('button', { name: 'Change PIN' }).click();

  const dialog = page.getByRole('dialog', { name: 'Change the PIN of this device' });
  await dialog.getByLabel('Current PIN').fill('111111');
  await dialog.getByLabel('New PIN').fill('135790');
  await dialog.getByLabel('Type the PIN again').fill('135790');
  await dialog.getByRole('button', { name: 'Change PIN' }).click();
  await expect(
    dialog.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
  ).toBeVisible();
  await dialog.getByLabel('Current PIN').fill(PIN);
  await dialog.getByRole('button', { name: 'Change PIN' }).click();
  await toastShown(page, 'Device PIN changed');

  await lockNow(page);
  await typePin(page, PIN);
  await expect(page.getByText('Wrong PIN. 4 tries left', { exact: false })).toBeVisible();
  await typePin(page, '135790');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
});

test('“Lock now” in one tab locks the other, and the PIN in one opens both', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await setPinInDialog(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  await lockNow(page);
  await expect(lockScreen(other)).toBeVisible();
  await typePin(page, PIN);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(other.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('locks and unlocks with no connection', async ({ page, context }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');
  await context.setOffline(true);
  await lockNow(page);
  // The password needs the server: offline the screen says what to do instead
  await expect(
    page.getByText('Forgot your PIN? Connect to the internet, then sign in with your password.'),
  ).toBeVisible();
  await typePin(page, PIN);
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible();
});
