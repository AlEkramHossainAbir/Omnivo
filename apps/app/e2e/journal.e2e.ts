import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// The mock garments workspace has six posted entries this year (JV-…-0001 to 0006) and one draft,
// then the two its stock posted (step 14: the opening stock is JV-…-0007, the truck on its way to
// the Chattogram depot JV-…-0008); last year's are numbered in last year's series
test('writes an entry and posts it only once the debits and credits are equal', async ({
  page,
}) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New journal entry' })).toBeVisible();

  await page.getByLabel('Narration').fill('Courier charges for buyer samples');
  await line(page, 1).getByLabel('Account').selectOption({ label: '5220 · Office rent' });
  await line(page, 1).getByLabel('Debit').fill('25000');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('20000');

  const post = page.getByRole('button', { name: 'Post entry' });
  await expect(page.getByText('Out by ৳5,000.00')).toBeVisible();
  await expect(post).toBeDisabled();

  await line(page, 2).getByLabel('Credit').fill('25000');
  await expect(page.getByText('Balanced')).toBeVisible();
  await expectNoSideScroll(page);
  await post.click();

  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0009$/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '1110 Cash in hand' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('finishes a waiting draft, and deletes a new one in two clicks', async ({ page }) => {
  await openFromNav(page, 'Journal');
  // The segmented control's radio sits under its label; the label is what a person clicks
  await page.getByText('Drafts', { exact: true }).click();
  await listItem(page, /LC opening charges/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();

  await page.getByRole('link', { name: 'Back to the journal' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Narration').fill('Half-written');
  await line(page, 1).getByLabel('Account').selectOption({ label: '5410 · Bank charges' });
  await line(page, 1).getByLabel('Debit').fill('500');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('500');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
  // On a phone the toast sits over "Delete draft", and the pointer that just clicked "Save draft"
  // rests on it — and a toast does not close while the pointer is over it. Move away and let it go.
  await page.mouse.move(0, 0);
  await expect(page.getByText('Draft saved')).toBeHidden();

  await page.getByRole('button', { name: 'Delete draft' }).click();
  await expect(page.getByText('This cannot be undone.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete this draft' }).click();
  await expect(page.getByText('Draft deleted')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journal' })).toBeVisible();
});

test('reverses a posted entry once, and links the two', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await listItem(page, /Office rent for the Banani head office/).click();
  const original = page.getByRole('heading', { level: 1, name: /^JV-/ });
  const number = (await original.textContent()) ?? '';

  await page.getByRole('button', { name: 'Reverse' }).click();
  const dialog = page.getByRole('dialog', { name: `Reverse ${number}` });
  await dialog.getByRole('button', { name: 'Reverse entry' }).click();
  await expect(page.getByText(new RegExp(`reverses ${number}$`))).toBeVisible();
  await expect(page.getByText('Reversal', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: `Reverses ${number}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Reversed by JV-/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse' })).toBeHidden();
});

test("shows an account's ledger with the running balance", async ({ page }) => {
  await openFromNav(page, 'Ledger');
  await expect(page.getByText(/^Choose an account above to see its entries/)).toBeVisible();
  // A combobox: the user menu's button is called "Account" too
  await page
    .getByRole('combobox', { name: 'Account' })
    .selectOption({ label: '1110 · Cash in hand' });
  // 50,000 petty cash in, 18,450.50 paid for electricity
  await expect(page.getByText('৳31,549.50 Dr').first()).toBeVisible();
  await expect(page.getByText('DESCO electricity bill, Gazipur factory')).toBeVisible();
  await expectNoSideScroll(page);
});

test('posts the opening balances, with the difference in opening balance equity', async ({
  page,
}) => {
  await openFromNav(page, 'Opening balances');
  await page.getByRole('button', { name: 'First day on Omnivo' }).click();
  await page.locator('td[data-today] button').click();
  await page.getByLabel('Debit, 1121').fill('1842600.50');
  await page.getByLabel('Credit, 2110').fill('412000');
  // What the books are out by, on the side that closes the gap
  await expect(page.getByText('৳14,30,600.50')).toBeVisible();
  // …and with it both totals are the larger side
  await expect(page.getByText('৳18,42,600.50')).toHaveCount(2);
  await page.getByRole('button', { name: 'Post opening balances' }).click();
  await expect(page.getByText(/^Opening balances posted as JV-/)).toBeVisible();
  await expect(page.getByRole('link', { name: /^Posted as JV-/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('closes the books up to today, and then refuses to post into it', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'Lock date' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock date' });
  await dialog.getByRole('button', { name: 'Books closed up to' }).click();
  await page.locator('td[data-today] button').click();
  await dialog.getByRole('button', { name: 'Save lock date' }).click();
  await expect(page.getByText(/^Books closed up to /)).toBeVisible();

  await page.getByRole('button', { name: 'New entry' }).click();
  await line(page, 1).getByLabel('Account').selectOption({ label: '5220 · Office rent' });
  await line(page, 1).getByLabel('Debit').fill('100');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('100');
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(
    page.getByText('The books are closed for this date. Pick a date after the lock date.'),
  ).toBeVisible();
});

// Step 15a: the receivable is kept per customer. The API answers a line without one per row.
test('asks for the customer on a receivable line, and the customer then owes it', async ({
  page,
}) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Narration').fill('Sample yardage sold to Aarong');
  await line(page, 1).getByLabel('Account').selectOption({ label: '1140 · Accounts receivable' });
  await line(page, 1).getByLabel('Debit').fill('42000');
  await line(page, 2).getByLabel('Account').selectOption({ label: '4110 · Export sales' });
  await line(page, 2).getByLabel('Credit').fill('42000');
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(line(page, 1).getByText('Pick the customer this amount belongs to.')).toBeVisible();

  await line(page, 1).getByLabel('Customer').click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
  await page.getByRole('option', { name: /Aarong/ }).click();
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();
  await expect(page.getByText('Aarong').first()).toBeVisible();

  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Aarong/)).toContainText('৳42,000');
  await expectNoSideScroll(page);
});

test('splits the opening receivable by customer', async ({ page }) => {
  await openFromNav(page, 'Opening balances');
  await page.getByRole('button', { name: 'First day on Omnivo' }).click();
  await page.locator('td[data-today] button').click();
  await page.getByLabel('Debit, 1140: line 1').fill('150000');
  await page.getByRole('button', { name: 'Post opening balances' }).click();
  // Without a customer the amount belongs to nobody: the row says so
  await expect(
    page
      .getByRole('group', { name: '1140: line 1' })
      .getByText('Pick the customer this amount belongs to.'),
  ).toBeVisible();

  await page.getByLabel('Customer, 1140: line 1').click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('C-00003');
  await page.getByRole('option', { name: /Aarong/ }).click();
  await page.getByRole('button', { name: 'Add a customer' }).click();
  await page.getByLabel('Customer, 1140: line 2').click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('bengal');
  await page.getByRole('option', { name: /Bengal Buying House/ }).click();
  await page.getByLabel('Debit, 1140: line 2').fill('60000');
  // The account's total is the customers' lines together
  await expect(page.getByText('৳2,10,000.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Post opening balances' }).click();
  await expect(page.getByText(/^Opening balances posted as JV-/)).toBeVisible();
  await expectNoSideScroll(page);
});
