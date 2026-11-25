import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
} from './helpers.js';

// Step 28c: Shop payouts on the mock (mocks/storefront-payout-data.ts). Steadfast Dhaka's last week
// (storefront-order-data.ts → seedPayoutWeek): W-000008 to W-000011, one Oud attar each (৳650),
// Cash on Delivery, delivered 6 to 2 days ago, each with its COD receipt into 1191 Cash with
// Steadfast. Inside Dhaka the shopper paid ৳730 and Steadfast charges ৳60; W-000010 went to
// Chattogram (৳770, ৳130). W-000008 is paid out already on CPO-…-0001 (Steadfast's SFC-23618228).
// Steadfast has not said W-000011's charge. W-000001 was paid online, so its ৳60 is a charge-only
// line; W-000003 is still on its way. Moving between pages goes through the menu: a reload starts
// the mock again.
test.use({ shopOrders: true, shopPayouts: true });

// A row's name starts with the number (the rest of the row follows it), a heading's is the number
const CPO = (n: number) => new RegExp(`^CPO-\\d{4}-\\d{2}-${String(n).padStart(4, '0')}\\b`);

// The account select, the Record payout page's first box
function accountSelect(page: Page) {
  return page.getByLabel('Courier account', { exact: true });
}

// A parcel's row (a card on a phone): a group named by its invoice
function parcel(page: Page, invoice: string) {
  return page.getByRole('group', { name: invoice, exact: true });
}

async function tick(page: Page, invoice: string): Promise<void> {
  await page.getByRole('checkbox', { name: `Pay out ${invoice}`, exact: true }).check();
}

function totals(page: Page) {
  return page.locator('dl').filter({ hasText: 'To the bank' }).last();
}

async function newPayout(page: Page): Promise<void> {
  await openFromNav(page, 'Shop payouts');
  await page.getByRole('button', { name: 'Record payout' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Record a courier payout' }),
  ).toBeVisible();
}

// The browser reads the file; the dialog posts its text to the match route
async function chooseFile(page: Page, name: string, csv: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Match the courier’s payout file' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose CSV file' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
}

test('lists the payouts, with the filters in the address', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop payouts');
  const first = listItem(page, CPO(1));
  await expect(first).toContainText('Steadfast Dhaka');
  await expect(first).toContainText('৳670');
  await expect(first).toContainText('Posted');
  await expectNoSideScroll(page);

  // Voided: none yet, and the address keeps the filter
  await page.getByRole('group', { name: 'Show' }).getByText('Voided', { exact: true }).click();
  await expect(page).toHaveURL(/status=voided/);
  await expect(page.getByText('No payout matches')).toBeVisible();
  await page.getByRole('button', { name: 'Show every payout' }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(first).toBeVisible();

  // The payout's page: its parcel, its receipt and its entry; the voucher waits for the print
  await first.click();
  await expect(page.getByRole('heading', { level: 1, name: CPO(1) })).toBeVisible();
  await expect(page.getByText('SFC-23618228').first()).toBeVisible();
  await expect(page.getByText('1121 · Dutch-Bangla Bank CD A/C 1234').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'W-000008' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toContainText('Courier payout');
  await expect(sheet).toContainText('SFC-23618228');
  await expect(page.getByRole('button', { name: 'Print voucher' })).toBeVisible();
  await expectNoSideScroll(page);

  // Its COD receipt can't be voided while the payout stands (receipt_paid_out)
  await page.getByRole('link', { name: /^MR-/ }).click();
  await page.getByRole('button', { name: 'Void receipt' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Typed twice');
  await dialog.getByRole('button', { name: 'Void receipt' }).click();
  await expect(
    dialog.getByText(/^A courier payout paid this COD money out to the bank\./),
  ).toBeVisible();
});

test('records a payout from the courier’s row menu, then voids it', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
  // What it holds: the three receipts no payout took (৳730 + ৳770 + ৳730)
  await expect(listItem(page, /^Steadfast Dhaka/)).toContainText('৳2,230 · 3 parcels');
  await page.getByRole('button', { name: 'Actions for Steadfast Dhaka', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Record payout' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Record a courier payout' }),
  ).toBeVisible();
  await expect(accountSelect(page).locator('option:checked')).toHaveText(
    'Steadfast Dhaka · holds ৳2,230 in 3 parcels',
  );
  // An account with no COD account is shown, not offered
  await expect(
    accountSelect(page).locator('option', { hasText: 'Pathao counter · no COD account' }),
  ).toBeDisabled();

  // Oldest receipt first, the charge-only line last; W-000008 is paid out, W-000003 on its way
  await expect(page.getByRole('group', { name: /^W-0000/ })).toHaveCount(4);
  await expect(parcel(page, 'W-000001')).toContainText('Charge only: no cash came');
  await expect(parcel(page, 'W-000011')).toContainText('Steadfast has not said its charge');
  await expect(parcel(page, 'W-000008')).toHaveCount(0);
  await expectNoSideScroll(page);

  await page
    .getByLabel('Paid into')
    .selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel(/^Courier’s reference/).fill('SFC-23640011');
  await tick(page, 'W-000009');
  await tick(page, 'W-000001');
  await tick(page, 'W-000011');
  await expect(page.getByText('3 parcels ticked')).toBeVisible();
  // W-000011's box is empty: nobody typed its charge
  await page.getByRole('button', { name: 'Record payout' }).click();
  await expect(parcel(page, 'W-000011')).toContainText('Type the courier’s charge for this parcel');
  await page.getByLabel('Charge for W-000011').fill('60');
  // ৳730 + ৳730 collected, ৳60 × 3 charges
  await expect(totals(page)).toContainText('৳1,460.00');
  await expect(totals(page)).toContainText('৳180.00');
  await expect(totals(page)).toContainText('৳1,280.00');

  await page.getByRole('button', { name: 'Record payout' }).click();
  await toastShown(page, /^CPO-\d{4}-\d{2}-0002 recorded$/);
  await expect(page.getByRole('heading', { level: 1, name: CPO(2) })).toBeVisible();
  await expect(page.getByText('Charge only: no cash came')).toBeVisible();
  const total = page.getByRole('row', { name: /^Total/ });
  await expect(total).toContainText('৳1,460.00');
  await expect(total).toContainText('৳1,280.00');

  // The parcel card says which payout took the money
  await page.getByRole('link', { name: 'W-000009' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000009' })).toBeVisible();
  await expect(page.getByText('Paid out on')).toBeVisible();
  await page.getByRole('link', { name: CPO(2) }).click();

  // Voided: the entry reversed, the parcels free again for the next payout
  await page.getByRole('button', { name: 'Void payout' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Recorded the wrong transfer');
  await dialog.getByRole('button', { name: 'Void payout' }).click();
  await toastShown(page, /^CPO-\d{4}-\d{2}-0002 voided$/);
  await expect(
    page.getByText(
      /^Voided on .+: Recorded the wrong transfer\. Its parcels can be paid out again\./,
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Void payout' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print voucher' })).toHaveCount(0);

  await newPayout(page);
  await accountSelect(page).selectOption({ label: 'Steadfast Dhaka · holds ৳2,230 in 3 parcels' });
  await expect(page.getByRole('group', { name: /^W-0000/ })).toHaveCount(4);
});

test('matches the courier’s payout file, with the preset and with picked columns', async ({
  page,
}) => {
  await page.goto('/');
  await newPayout(page);
  await accountSelect(page).selectOption({ label: 'Steadfast Dhaka · holds ৳2,230 in 3 parcels' });
  await page.getByRole('button', { name: 'Match a payout file' }).click();

  // Steadfast's preset columns: one row of each outcome
  await chooseFile(
    page,
    'steadfast-payout.csv',
    [
      'Invoice,Tracking Code,COD Amount,Delivery Charge',
      'W-000009,SFR2611210019,730,60',
      'W-000010,SFR2611220031,"1,000",130',
      'W-000008,SFR2611190008,730,60',
      'W-000003,SFR2611210042,0,130',
      'W-000099,SFR0000000000,500,60',
      'W-000009,SFR2611210019,730,60',
      'W-000011,SFR2611230044,N/A,60',
    ].join('\n'),
  );
  const dialog = page.getByRole('dialog', { name: 'Match the courier’s payout file' });
  for (const pill of [
    'Found: 1',
    'Other amount: 1',
    'Not found: 1',
    'Can’t be read: 1',
    'Twice in the file: 1',
    'Already paid out: 1',
    'Not ready: 1',
  ]) {
    await expect(dialog.getByText(pill, { exact: true })).toBeVisible();
  }
  await expect(
    dialog.getByText(/^The file says ৳1,000\.00 collected, the money receipt ৳770\.00\./),
  ).toBeVisible();
  await expect(dialog.getByText(/^Paid out on CPO-\d{4}-\d{2}-0001\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Tick 2 parcels' }).click();
  await toastShown(page, '2 parcels ticked from the file');
  // The file says ৳1,540 reached the bank; the receipts say ৳1,310
  await expect(totals(page)).toContainText('The file says ৳1,540.00 reached the bank');
  await expect(totals(page)).toContainText('Out by ৳230.00');

  // Another courier's export: other names, so the columns are picked once
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Match a payout file' }).click();
  await chooseFile(
    page,
    'bank-sheet.csv',
    ['Consignment,Paid,Fee', '148920688,730,60', '148920802,730,60', ''].join('\r\n'),
  );
  await expect(dialog.getByRole('heading', { name: 'Which column is which?' })).toBeVisible();
  await expect(dialog.getByText(/^Not in the file: /)).toBeVisible();
  await dialog.getByLabel('Parcels are named by').selectOption({ label: 'Courier’s ID' });
  await dialog.getByLabel('Its column').selectOption('Consignment');
  await dialog.getByLabel('Collected column').selectOption('Paid');
  await dialog.getByLabel('Charge column').selectOption('Fee');
  await dialog.getByRole('button', { name: 'Match the file' }).click();
  await expect(dialog.getByText('Found: 2', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Tick 2 parcels' }).click();
  await toastShown(page, '2 parcels ticked from the file');
  await expect(page.getByLabel('Charge for W-000011')).toHaveValue('60.00');
  await expect(totals(page)).toContainText('Agrees');
  await expectNoSideScroll(page);

  // The picked columns are kept: the same file again goes straight to the result
  await page.getByRole('button', { name: 'Match a payout file' }).click();
  await chooseFile(page, 'bank-sheet.csv', ['Consignment,Paid,Fee', '148920688,730,60'].join('\n'));
  await expect(dialog.getByText('Already paid out: 1', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Found: 1', { exact: true })).toBeVisible();
});

test('an accountant who only records payouts sees Shop payouts alone', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['storefront.payout.manage'] });
  await page.goto('/');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Shop orders' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Shop couriers' })).toHaveCount(0);
  await openFromNav(page, 'Shop payouts');
  await listItem(page, CPO(1)).click();
  await expect(page.getByRole('heading', { level: 1, name: CPO(1) })).toBeVisible();
  // The shop's order would be refused: the invoice is text, not a link
  await expect(page.getByText('W-000008', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'W-000008' })).toHaveCount(0);
});
