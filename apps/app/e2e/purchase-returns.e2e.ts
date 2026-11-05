import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 17d in the mock garments workspace, where the signed-in person is the Owner. 17b's
// PO-…-0001 orders 1,000 gross of shirt buttons from Unitex at ৳62 a gross before VAT (15%);
// nothing came in yet. The Main store holds 7,200 buttons from before Omnivo, at ৳0.45 each.
// Bills below ৳1,00,000 post at once. The mock seeds no return, debit note or refund.
//
// Most tests write three or four documents, more on a phone-sized page: test.slow() gives them
// three times the usual 30 seconds, so a busy machine does not fail them half-way (15d's rule).

const number = (prefix: string) => (value: number) =>
  new RegExp(`${prefix}-\\d{4}-\\d{2}-${String(value).padStart(4, '0')}`);
const BILL = number('BILL');
const DN = number('DN');
const GRN = number('GRN');
const PO = number('PO');
const PRN = number('PRN');
const PV = number('PV');
const SRF = number('SRF');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, value: number) =>
  page.getByRole('group', { name: `Line ${String(value)}` });

async function openOrder(page: Page) {
  await openFromNav(page, 'Purchase orders');
  await listItem(page, PO(1)).click();
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
}

// GRN-…-0001: 600 of PO-…-0001's 1,000 gross, booked at ৳62 a gross (৳37,200)
async function receiveButtons(page: Page) {
  await openOrder(page);
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await line(page, 1).getByLabel('Accepted').fill('600');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);
}

// BILL-…-0002 (the seed's waiting bill is 0001): the receipt billed at the order's price,
// 600 × ৳62 = ৳37,200 + 15% VAT = ৳42,780
async function billTheButtons(page: Page) {
  await receiveButtons(page);
  await page.getByRole('button', { name: 'Make bill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New supplier bill' })).toBeVisible();
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByLabel(/^Supplier’s bill number/).fill('UT-INV-0921');
  await page.getByRole('button', { name: 'Post bill' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0002 posted$/);
  await expect(page.getByRole('heading', { level: 1, name: BILL(2) })).toBeVisible();
}

// PRN-…-0001: 100 gross go back from GRN-…-0001, opened from the receipt's page
async function sendHundredBack(page: Page) {
  await page.getByRole('button', { name: 'Send goods back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New purchase return' })).toBeVisible();
  await line(page, 1).getByLabel('Quantity').fill('100');
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /^PRN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByRole('heading', { level: 1, name: PRN(1) })).toBeVisible();
}

test('sends goods back before the bill, and the bill bills the rest', async ({ page }) => {
  test.slow();
  await receiveButtons(page);
  await page.getByRole('button', { name: 'Send goods back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New purchase return' })).toBeVisible();
  // Every line the receipt kept, from its own warehouse; what is left is in the base unit
  await expect(line(page, 1).getByText(/^From GRN-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(line(page, 1).getByText('86,400 pcs can still go back')).toBeVisible();
  await expectNoSideScroll(page);
  await line(page, 1).getByLabel('Quantity').fill('100');
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /^PRN-\d{4}-\d{2}-0001 posted$/);

  // At the receipt's cost, ৳62 a gross; not billed yet, so no debit note is needed
  await expect(page.getByRole('heading', { level: 1, name: PRN(1) })).toBeVisible();
  await expect(page.getByText('৳6,200.00').first()).toBeVisible();
  await expect(page.getByText('Not billed yet: the bill bills less')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write debit note' })).toHaveCount(0);
  // The goods-out slip is in the page for the browser's Print
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText('Purchase return');
  await expect(sheet).toContainText('Unitex Trims & Accessories');
  await expectNoSideScroll(page);

  // The receipt says what went back, and its bill bills the 500 gross that stayed
  await page
    .getByRole('link', { name: GRN(1) })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: GRN(1) })).toBeVisible();
  await expect(page.getByText('Partly returned').first()).toBeVisible();
  await expect(page.getByRole('link', { name: PRN(1) })).toBeVisible();
  await page.getByRole('button', { name: 'Make bill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New supplier bill' })).toBeVisible();
  // In gross, as it came: 500 is a whole number of them, so the price stays the order's
  await expect(line(page, 1).getByText(/^86,400 pcs went back before billing/)).toBeHidden();
  await expect(line(page, 1).getByText(/^14,400 pcs went back before billing/)).toBeVisible();
  await expect(line(page, 1)).toContainText(/Unit\s*gross\s*Quantity\s*500/);
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByLabel(/^Supplier’s bill number/).fill('UT-INV-0921');
  // 500 × ৳62 = ৳31,000 + 15% VAT = ৳35,650, at the order's price: no difference
  await page.getByRole('button', { name: 'Post bill' }).click();
  await toastShown(page, /^BILL-\d{4}-\d{2}-0002 posted$/);
  await expect(page.getByText('৳35,650.00').first()).toBeVisible();
  await expect(page.getByText(/^The prices differ from the orders/)).toBeHidden();
});

test('debits goods sent back after the bill, and the money comes off it', async ({ page }) => {
  test.slow();
  await billTheButtons(page);
  await page.getByRole('link', { name: GRN(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: GRN(1) })).toBeVisible();
  await sendHundredBack(page);
  // Billed already: a debit note takes the money off
  await expect(page.getByText(/^Billed on BILL-\d{4}-\d{2}-0002/)).toBeVisible();
  await expect(page.getByText(/^Some of these goods were billed already/)).toBeVisible();

  await page.getByRole('button', { name: 'Write debit note' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New debit note' })).toBeVisible();
  await expect(line(page, 1).getByText(/^Goods sent back on PRN-\d{4}-\d{2}-0001/)).toBeVisible();
  await page.getByLabel(/^Supplier’s credit note/).fill('UT-CN-0112');
  await expectNoSideScroll(page);
  // 100 × ৳62 = ৳6,200 + 15% VAT = ৳7,130
  await page.getByRole('button', { name: 'Post debit note' }).click();
  await toastShown(page, /^DN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByRole('heading', { level: 1, name: DN(1) })).toBeVisible();
  await expect(page.getByText('৳7,130.00').first()).toBeVisible();
  await expect(page.getByText('UT-CN-0112').first()).toBeVisible();
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toContainText('Debit note');
  await expect(sheet).toContainText('UT-INV-0921');

  // Dr Accounts payable ৳7,130 / Cr Goods received not billed ৳6,200 / Cr VAT input ৳930
  await page.getByRole('link', { name: /^JV-/ }).click();
  await expect(page.getByText('৳6,200.00').first()).toBeVisible();
  await expect(page.getByText('৳930.00').first()).toBeVisible();

  // The bill: ৳7,130 settled by the debit note, the rest still owed
  await openFromNav(page, 'Supplier bills');
  await listItem(page, BILL(2)).click();
  await expect(page.getByRole('heading', { level: 1, name: BILL(2) })).toBeVisible();
  await expect(page.getByText('Partly debited').first()).toBeVisible();
  await expect(page.getByText('Partly paid').first()).toBeVisible();
  await expect(page.getByRole('link', { name: DN(1) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Debit whole bill' })).toHaveCount(0);
  await expectNoSideScroll(page);
});

test('debits a whole bill in one click', async ({ page }) => {
  test.slow();
  await billTheButtons(page);
  await page.getByRole('button', { name: 'Debit whole bill' }).click();
  await toastShown(page, /^Draft debit note written for every line and expense/);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft debit note' })).toBeVisible();
  await page.getByRole('button', { name: 'Post debit note' }).click();
  await toastShown(page, /^DN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByText('৳42,780.00').first()).toBeVisible();

  // Nothing is owed on it any more, and it says why
  await page
    .getByRole('link', { name: BILL(2) })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: BILL(2) })).toBeVisible();
  await expect(page.getByText('Debited', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay bill' })).toBeHidden();
});

test('records an advance the supplier paid back, and voids it', async ({ page }) => {
  test.slow();
  await openOrder(page);
  await page.getByRole('button', { name: 'Pay advance' }).click();
  await page.getByLabel('Amount', { exact: true }).fill('20000');
  await page.getByLabel('Paid from').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Paid by').selectOption({ label: 'Cash' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Post payment' }).click();
  await toastShown(page, /^PV-\d{4}-\d{2}-0001 posted$/);

  // Unitex cannot make the rest: ৳5,000 of the advance comes back by bank transfer
  await page.getByRole('button', { name: 'Record money back' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Record money a supplier paid back' }),
  ).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('5000');
  await page
    .getByLabel('Received into')
    .selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel('Paid by').selectOption({ label: 'Bank transfer' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save refund' }).click();
  await toastShown(page, /^SRF-\d{4}-\d{2}-0001 saved$/);
  await expect(page.getByRole('heading', { level: 1, name: SRF(1) })).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  await expect(page.locator('[data-print-sheet]')).toContainText('Supplier refund');

  // The payment: ৳15,000 left, and it cannot be voided while the refund stands
  await page.getByRole('link', { name: PV(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: PV(1) })).toBeVisible();
  await expect(page.getByText(/^৳15,000\.00 is not applied to a bill yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Void payment' })).toBeHidden();

  // The transfer bounced: the refund is voided, and the payment may be voided again
  await openFromNav(page, 'Supplier refunds');
  await expect(listItem(page, SRF(1))).toContainText(PV(1));
  await listItem(page, SRF(1)).click();
  await page.getByRole('button', { name: 'Void refund' }).click();
  const dialog = page.getByRole('dialog', { name: SRF(1) });
  await dialog.getByLabel('Reason').fill('Their transfer was returned by the bank');
  await dialog.getByRole('button', { name: 'Void refund' }).click();
  await toastShown(page, /^SRF-\d{4}-\d{2}-0001 voided$/);
  await expect(page.getByText(/^Voided on .*: Their transfer was returned/)).toBeVisible();
  await page.getByRole('link', { name: PV(1) }).click();
  await expect(page.getByText(/^৳20,000\.00 is not applied to a bill yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Void payment' })).toBeVisible();
});

test('sends back stock from before Omnivo, and debits it without a bill', async ({ page }) => {
  test.slow();
  await openFromNav(page, 'Purchase returns');
  await page.getByRole('button', { name: 'New return' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New purchase return' })).toBeVisible();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  await page.getByLabel('Sent from warehouse').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: 'Search products' }).fill('shirt buttons');
  const row = picker.getByRole('listitem').filter({ hasText: 'Shirt buttons 4-hole 18L' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  // No goods receipt: it leaves at the average cost
  await expect(
    line(page, 1).getByText('Not from a goods receipt: it leaves at the average cost'),
  ).toBeVisible();
  await line(page, 1).getByLabel('Unit').selectOption({ label: 'gross = 144 pcs' });
  await line(page, 1).getByLabel('Quantity').fill('10');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post return' }).click();
  await toastShown(page, /^PRN-\d{4}-\d{2}-0001 posted$/);

  // 1,440 buttons at ৳0.45 = ৳648; the debit note has no bill to take it off
  await expect(page.getByText('৳648.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Write debit note' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New debit note' })).toBeVisible();
  await expect(page.getByLabel('Bill').locator('option:checked')).toHaveText(
    'No bill: goods that came from no goods receipt',
  );
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  // The supplier's credit note says ৳60 a gross, 15% VAT
  await expect(line(page, 1).getByText(/^Goods sent back on PRN-\d{4}-\d{2}-0001/)).toBeVisible();
  await line(page, 1).getByLabel('Price before VAT').fill('60');
  await line(page, 1).getByLabel('VAT rate').selectOption({ label: 'VAT 15% · 15%' });
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post debit note' }).click();
  await toastShown(page, /^DN-\d{4}-\d{2}-0001 posted$/);

  // ৳600 + ৳90 VAT, owed back by the supplier: no bill took it
  await expect(page.getByRole('heading', { level: 1, name: DN(1) })).toBeVisible();
  await expect(page.getByText('৳690.00').first()).toBeVisible();
  await expect(page.getByText(/^৳690\.00 is not applied to a bill yet/)).toBeVisible();
  // Dr Accounts payable ৳690 / Cr Goods received not billed ৳648 / Dr price difference ৳48 /
  // Cr VAT input ৳90
  await page.getByRole('link', { name: /^JV-/ }).click();
  await expect(page.getByText('৳648.00').first()).toBeVisible();
  await expect(page.getByText('৳48.00').first()).toBeVisible();
});
