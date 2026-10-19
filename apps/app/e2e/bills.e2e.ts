import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 17c in the mock garments workspace, where the signed-in person is the Owner. Bills from
// ৳1,00,000 with VAT need the Purchase manager, payments from ৳2,00,000 a Director, and an Owner's
// own bills and payments are posted when submitted (decision 7). The seed:
//   BILL-…-0001 Gazipur Carton's bill GCI-2026-0318: 40 cartons of mailer bags with no order and a
//               truck (৳1,41,450 with VAT), submitted by Abdul Karim, waiting for the Purchase
//               manager
// and 17b's PO-…-0001: 1,000 gross of shirt buttons from Unitex at ৳62 a gross, nothing received.

const number = (prefix: string) => (value: number) =>
  new RegExp(`${prefix}-\\d{4}-\\d{2}-${String(value).padStart(4, '0')}`);
const BILL = number('BILL');
const GRN = number('GRN');
const PO = number('PO');
const PV = number('PV');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, value: number) =>
  page.getByRole('group', { name: `Line ${String(value)}` });

async function openOrder(page: Page, name: RegExp) {
  await openFromNav(page, 'Purchase orders');
  await listItem(page, name).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

// GRN-…-0001: 600 of PO-…-0001's 1,000 gross, booked at the order's ৳62 a gross (৳37,200), then
// "Make bill" from the receipt's page
async function billTheButtons(page: Page) {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New goods receipt' })).toBeVisible();
  await line(page, 1).getByLabel('Accepted').fill('600');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByText('Not billed').first()).toBeVisible();
  await page.getByRole('button', { name: 'Make bill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New supplier bill' })).toBeVisible();
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
}

test('approves the waiting bill, which posts it and receives its cartons', async ({ page }) => {
  await openFromNav(page, 'Approvals');
  await expect(listItem(page, BILL(1))).toContainText('Gazipur Carton Industries');
  await listItem(page, BILL(1)).click();
  await expect(page.getByRole('heading', { level: 1, name: BILL(1) })).toBeVisible();
  await expect(
    page.getByText('Waiting for approval. The last approval posts it.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Step 1 waits for you.')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: BILL(1) });
  await expect(dialog.getByText('You approve step 1 of 1, as Purchase manager.')).toBeVisible();
  await expect(dialog.getByText(/is posted in the books when you do\.$/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await toastShown(page, /^Your approval of BILL-\d{4}-\d{2}-0001 is saved$/);

  // Posted: booked, owed in full, and its cartons came in on a goods receipt of its own
  await expect(page.getByText('Unpaid').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  await page.getByRole('link', { name: GRN(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: GRN(1) })).toBeVisible();
  await expect(
    page.getByText(/^Supplier bill BILL-\d{4}-\d{2}-0001 received these goods/),
  ).toBeVisible();
  // Exact: "Not billed" holds the word too
  await expect(page.getByText('Billed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not billed')).toBeHidden();
  await expectNoSideScroll(page);

  // It waits no more; the seed's requisition still does
  await openFromNav(page, 'Approvals');
  await expect(listItem(page, /PR-\d{4}-\d{2}-0003/)).toBeVisible();
  await expect(listItem(page, BILL(1))).toBeHidden();
});

test('sends the waiting bill back, cancels it, and its number is free again', async ({ page }) => {
  await openFromNav(page, 'Approvals');
  await listItem(page, BILL(1)).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: BILL(1) });
  await dialog.getByLabel('What should change').fill('They billed 40 cartons; the gate took 38.');
  await dialog.getByRole('button', { name: 'Send back to draft' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0001 sent back to draft$/);
  // A draft again, with its number and the approver's comment
  await expect(
    page.getByText(/sent it back: "They billed 40 cartons; the gate took 38\."/),
  ).toBeVisible();

  // The supplier sends a new bill instead: this one is cancelled, never deleted (it has a number)
  await page.getByRole('button', { name: 'Cancel bill' }).click();
  const cancel = page.getByRole('dialog', { name: BILL(1) });
  await cancel.getByRole('button', { name: 'Cancel bill' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0001 cancelled$/);
  await expect(page.getByText('Cancelled. It stays here for the record.')).toBeVisible();

  // Its supplier's bill number is free for the right bill
  await openFromNav(page, 'Supplier bills');
  await page.getByRole('button', { name: 'New bill' }).first().click();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('gazipur');
  await page.getByRole('option', { name: /Gazipur Carton/ }).click();
  await page.getByLabel(/^Supplier’s bill number/).fill('GCI-2026-0318');
  await page.getByLabel('Branch').selectOption({ label: 'Gazipur factory' });
  await page.getByRole('button', { name: 'Add expense' }).click();
  const expense = page.getByRole('group', { name: 'Expense 1' });
  await expense.getByLabel('Account').selectOption({ label: '5170 · Purchased services' });
  await expense.getByLabel('Description').fill('Carton printing plates');
  await expense.getByLabel('Amount').fill('8500');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');
  await expect(page.getByRole('heading', { level: 1, name: 'Draft bill' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('bills a goods receipt above the order’s price, and the difference shows', async ({
  page,
}) => {
  await billTheButtons(page);
  // The receipt's line, at the order's price: no difference yet
  await expect(line(page, 1).getByText(/From GRN-/)).toBeVisible();
  // The item, unit and quantity are the receipt's: text, not boxes
  await expect(line(page, 1)).toContainText(/Unit\s*gross\s*Quantity\s*600/);
  await line(page, 1).getByLabel('Price before VAT').fill('63');
  await expect(line(page, 1).getByText('৳600.00 over the order')).toBeVisible();
  await expect(
    page.getByText(/^The prices differ from the orders by ৳600\.00 in all/),
  ).toBeVisible();

  await page.getByLabel(/^Supplier’s bill number/).fill('UT-INV-0921');
  await expectNoSideScroll(page);
  // 600 × ৳63 = ৳37,800 + 15% VAT = ৳43,470: below every level, so it posts at once
  await page.getByRole('button', { name: 'Post bill' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0002 posted$/);
  await expect(page.getByRole('heading', { level: 1, name: BILL(2) })).toBeVisible();
  await expect(page.getByText('৳43,470.00').first()).toBeVisible();
  await expect(page.getByText(/^The prices differ from the orders by ৳600\.00/)).toBeVisible();
  await expect(
    page.getByText('No level applied, so it was posted when it was submitted.'),
  ).toBeVisible();

  // The receipt is billed, and the order counts what was billed
  await page.getByRole('link', { name: GRN(1) }).click();
  // Exact: "Not billed" holds the word too
  await expect(page.getByText('Billed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not billed')).toBeHidden();
  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await expect(page.getByRole('link', { name: BILL(2) })).toBeVisible();

  // A second bill with the same supplier's number is refused
  await openFromNav(page, 'Supplier bills');
  await page.getByRole('button', { name: 'New bill' }).first().click();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  // The same number, typed in lower case with a space after it
  await page.getByLabel(/^Supplier’s bill number/).fill('ut-inv-0921 ');
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Add expense' }).click();
  const expense = page.getByRole('group', { name: 'Expense 1' });
  await expense.getByLabel('Account').selectOption({ label: '5170 · Purchased services' });
  await expense.getByLabel('Description').fill('Courier for the button samples');
  await expense.getByLabel('Amount').fill('450');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    page.getByText('This supplier already has a bill with this number.', { exact: false }),
  ).toBeVisible();
});

test('pays the bill oldest first, prints the voucher, and voids it', async ({ page }) => {
  await billTheButtons(page);
  await page.getByLabel(/^Supplier’s bill number/).fill('UT-INV-0921');
  await page.getByRole('button', { name: 'Post bill' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0002 posted$/);

  // ৳37,200 + 15% = ৳42,780, paid from the bank by transfer
  await page.getByRole('button', { name: 'Pay bill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pay a supplier' })).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('50000');
  await page
    .getByLabel('Paid from')
    .selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Apply oldest first' }).click();
  await expect(page.getByLabel(/^Amount paid on BILL-/)).toHaveValue(/42,?780/);
  await expect(page.getByText('Left as advance')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post payment' }).click();
  await toastShown(page, /^PV-\d{4}-\d{2}-0001 posted$/);

  await expect(page.getByRole('heading', { level: 1, name: PV(1) })).toBeVisible();
  await expect(page.getByText(/^৳7,220\.00 is not applied to a bill yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  // The voucher is in the page, hidden until the browser prints it
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toContainText('Payment voucher');
  await expect(sheet).toContainText('Unitex Trims & Accessories');
  await expect(sheet).toContainText('UT-INV-0921');
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // The bill is paid
  await page.getByRole('link', { name: BILL(2) }).click();
  await expect(page.getByRole('heading', { level: 1, name: BILL(2) })).toBeVisible();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay bill' })).toBeHidden();

  // A stopped cheque: void it, and the bill owes again
  await page.getByRole('link', { name: PV(1) }).click();
  await page.getByRole('button', { name: 'Void payment' }).click();
  const dialog = page.getByRole('dialog', { name: PV(1) });
  await dialog.getByLabel('Reason').fill('Transfer returned: wrong account number');
  await dialog.getByRole('button', { name: 'Void payment' }).click();
  await toastShown(page, /^PV-\d{4}-\d{2}-0001 voided$/);
  await expect(page.getByText(/^Voided on .*: Transfer returned/)).toBeVisible();
  await openFromNav(page, 'Supplier bills');
  await expect(listItem(page, BILL(2))).toContainText('Unpaid');
});

test('pays an advance against an order, and the order shows it', async ({ page }) => {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Pay advance' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pay a supplier' })).toBeVisible();
  await expect(page.getByText('This supplier has no unpaid bill.', { exact: false })).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('20000');
  await page.getByLabel('Paid from').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Paid by').selectOption({ label: 'Cash' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Post payment' }).click();
  await toastShown(page, /^PV-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByText(/^৳20,000\.00 is not applied to a bill yet/)).toBeVisible();

  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await expect(page.getByRole('link', { name: PV(1) })).toBeVisible();
  await expectNoSideScroll(page);
});

test('chooses the purchase accounts in Settings', async ({ page }) => {
  await openFromNav(page, 'Settings');
  // The template's two accounts, chosen when the workspace was set up
  const difference = page.getByLabel('Purchase price difference', { exact: true });
  await expect(difference).toHaveValue(/.+/);
  await expect(page.getByLabel('Purchased services', { exact: true })).toHaveValue(/.+/);
  // None: a price difference goes to Cost of goods sold
  await difference.selectOption({ label: 'None: post it to Cost of goods sold' });
  await page.getByRole('button', { name: 'Save accounts' }).click();
  await toastShown(page, 'Purchase accounts saved');
  await expect(difference).toHaveValue('');
  await expectNoSideScroll(page);
});
