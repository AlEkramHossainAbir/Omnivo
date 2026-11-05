import type { Page, TestInfo } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  pinAnswered,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 20c: taking goods back at the counter. The garments workspace's POS1 Showroom counter
// takes goods back for 7 days and makes exchanges through 2190 POS exchange clearing
// (src/mocks/pos-data.ts → seedPos). Each test opens POS1's first shift with ৳2,000 and sells
// first, so the receipt it takes back is its own. A crew-neck T-shirt is ৳368 with VAT.
//
// The receipt, the return slip and the X and Z reports print with window.print(): a counter on
// <body> instead of the print dialog, like pos.e2e.ts.

// Two sales, a return and a close each, while the mock copies 10,000 styles: 30 seconds is too
// tight on a busy machine
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {
      document.body.dataset.printed = String(Number(document.body.dataset.printed ?? '0') + 1);
    };
  });
  await page.goto('/');
  await waitForCopy(page);
});

function isPhone(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'phone';
}

async function expectPrinted(page: Page, times: number): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-printed', String(times));
}

// POS1, then its first shift: ৳2,000 from the owner
async function openShift(page: Page): Promise<void> {
  await pinAnswered(page);
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
  await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, 'This device is POS1 now. The next receipt is POS1-000001.');
  await page.getByText('As a total').click();
  await page.getByLabel('Cash in the drawer').fill('2000');
  await page.getByLabel('Brought in as').selectOption({ label: 'Float from the owner' });
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');
}

async function scanTshirt(page: Page): Promise<void> {
  const search = page.getByRole('searchbox', { name: 'Scan or search' });
  await search.fill('8941100500118');
  await search.press('Enter');
  await expect(search).toHaveValue('');
}

function payButton(page: Page, amount: string) {
  return page.getByRole('button', { name: `Pay ${amount}` }).filter({ visible: true });
}

// T-shirts for the exact amount in cash, then the next sale
async function sell(page: Page, count: number, amount: string, number: string): Promise<void> {
  for (let scanned = 0; scanned < count; scanned += 1) await scanTshirt(page);
  await payButton(page, amount).click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: `${number} is done` });
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();
}

// F6, the receipt's number (in any case, like a scanner may send it), and the shirt ticked: the
// first tick takes one back
async function findAndTick(page: Page, number: string): Promise<void> {
  await page.keyboard.press('F6');
  const find = page.getByRole('dialog', { name: 'Take goods back' });
  await find.getByLabel('Receipt number').fill(number.toLowerCase());
  await find.getByRole('button', { name: 'Find the sale' }).click();
  const lines = page.getByRole('dialog', { name: `Return from ${number}` });
  await expect(lines).toContainText('Goods can come back until');
  await lines.getByRole('checkbox', { name: /^Take back Basic crew-neck T-shirt/ }).check();
}

function shiftMenu(page: Page) {
  return page.getByRole('button', { name: 'Shift POS1-S0001 menu' });
}

test('takes a shirt back for cash, prints the slip and the X and Z reports', async ({ page }) => {
  await openShift(page);
  await sell(page, 2, '৳736', 'POS1-000001');
  await expectPrinted(page, 1);

  // One of the two comes back: the line says what is left of it
  await findAndTick(page, 'POS1-000001');
  const lines = page.getByRole('dialog', { name: 'Return from POS1-000001' });
  await expect(lines).toContainText('2 of 2 pcs left to return');
  await lines.getByLabel('Why it came back').fill('Wrong size');
  await lines.getByRole('button', { name: 'Pay back ৳368' }).click();

  // The money goes back in cash, the whole of it
  const refund = page.getByRole('dialog', { name: 'Pay the money back' });
  await expect(refund).toContainText('Given back৳368');
  await refund.getByRole('button', { name: 'Complete return' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-R000001 is done' });
  await expect(done).toContainText('Give back ৳368 in cash');
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();

  // The same receipt again: one shirt is left of it
  await findAndTick(page, 'POS1-000001');
  await expect(page.getByRole('dialog', { name: 'Return from POS1-000001' })).toContainText(
    '1 of 2 pcs left to return',
  );
  await page.keyboard.press('Escape');

  // The X report, from the shift menu: blind, so no drawer total
  await shiftMenu(page).click();
  await page.getByRole('menuitem', { name: 'Print X report' }).click();
  await expectPrinted(page, 3);

  // ৳2,000 + ৳736 − ৳368 = ৳2,368, counted as it is; the Z report from the result
  await shiftMenu(page).click();
  await page.getByRole('menuitem', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await close.getByText('As a total').click();
  await close.getByLabel('Cash in the drawer').fill('2368');
  await close.getByRole('button', { name: 'Close the shift' }).click();
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  await expect(result).toContainText('DifferenceNo difference');
  await result.getByRole('button', { name: 'Print Z report' }).click();
  await expectPrinted(page, 4);
  await page.keyboard.press('Escape');

  // The managers' side: the return, its sale, and the shift's returns
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  const row = listItem(page, /POS1-R000001/);
  await expect(row).toContainText('POS1-000001');
  await expect(row).toContainText('৳368');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-R000001' })).toBeVisible();
  await expect(page.getByText('Wrong size')).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('link', { name: 'POS1-000001' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000001' })).toBeVisible();
  await expect(page.getByText('1 pcs came back')).toBeVisible();
  await expect(page.getByRole('link', { name: 'POS1-R000001' })).toBeVisible();

  await openFromNav(page, 'POS shifts');
  await listItem(page, /POS1-S0001/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
  await page.getByRole('link', { name: 'See the returns' }).click();
  await expect(page.getByText('The returns of shift POS1-S0001')).toBeVisible();
  await expect(listItem(page, /POS1-R000001/)).toBeVisible();
});

test('an exchange pays for a bigger sale, and dropping it asks first', async ({
  page,
}, testInfo) => {
  await openShift(page);
  await sell(page, 1, '৳368', 'POS1-000001');

  await findAndTick(page, 'POS1-000001');
  await page
    .getByRole('dialog', { name: 'Return from POS1-000001' })
    .getByRole('button', { name: 'Pay back ৳368' })
    .click();
  const refund = page.getByRole('dialog', { name: 'Pay the money back' });
  await refund.getByRole('button', { name: /^Exchange: use on a new sale/ }).click();
  await expect(refund).toBeHidden();

  // The cart starts with the return's money; on a phone it is a bar until opened
  if (isPhone(testInfo)) await page.getByRole('button', { name: /^0 items/ }).click();
  const cart = page.getByRole('complementary', { name: 'Cart' });
  await expect(cart).toContainText('Exchange from POS1-R000001');
  await expect(cart).toContainText('৳368 to spend on this sale');

  // Drop asks first; keeping it changes nothing
  await cart.getByRole('button', { name: 'Drop the exchange' }).click();
  const drop = page.getByRole('dialog', { name: 'Drop the exchange?' });
  await drop.getByRole('button', { name: 'Keep the exchange' }).click();
  await expect(cart).toContainText('Exchange from POS1-R000001');
  if (isPhone(testInfo)) await page.keyboard.press('Escape');

  // Two shirts for one: the return pays ৳368, cash the rest
  await scanTshirt(page);
  await scanTshirt(page);
  await payButton(page, '৳736').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await expect(pay).toContainText('From return POS1-R000001');
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await expect(pay).toContainText('Paid৳736');
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-000002 is done' });
  await expect(done).toContainText('No change to give');
  // One print, both slips: the return's and the sale's (decision 76)
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(
    page
      .getByRole('link', { name: 'Sync: Online, All changes synced', exact: true })
      .filter({ visible: true }),
  ).toBeVisible();

  // The server has both, linked
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  await expect(listItem(page, /POS1-R000001/)).toContainText('Exchanged for POS1-000002');
  await openFromNav(page, 'POS sales');
  await listItem(page, /POS1-000002/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000002' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'From return POS1-R000001' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('takes back offline a sale made offline, and both sync later', async ({ page, context }) => {
  await openShift(page);
  await context.setOffline(true);
  await expect(
    page.getByRole('link', { name: /^Sync: Offline/ }).filter({ visible: true }),
  ).toBeVisible();

  // The sale is still in the outbox: the return finds it on the device
  await sell(page, 1, '৳368', 'POS1-000001');
  await findAndTick(page, 'POS1-000001');
  await page
    .getByRole('dialog', { name: 'Return from POS1-000001' })
    .getByRole('button', { name: 'Pay back ৳368' })
    .click();
  await page
    .getByRole('dialog', { name: 'Pay the money back' })
    .getByRole('button', { name: 'Complete return' })
    .click();
  const done = page.getByRole('dialog', { name: 'POS1-R000001 is done' });
  await expect(done).toContainText('Give back ৳368 in cash');
  await expect(done).toContainText('Saved on this device');
  await done.getByRole('button', { name: 'New sale' }).click();

  // Back online, the sale goes first, then its return
  await context.setOffline(false);
  await expect(
    page
      .getByRole('link', { name: 'Sync: Online, All changes synced', exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  await expect(listItem(page, /POS1-R000001/)).toContainText('POS1-000001');
});

test('a register takes goods back for its own days, with or without exchanges', async ({
  page,
}) => {
  await openFromNav(page, 'POS registers');
  await listItem(page, /POS1/).click();
  const edit = page.getByRole('dialog', { name: 'Edit POS1' });
  await expect(edit.getByLabel('Returns allowed for (days)')).toHaveValue('7');
  await expect(edit.getByLabel('Exchange account')).toHaveValue(/.+/);

  // Whole days only
  await edit.getByLabel('Returns allowed for (days)').fill('7.5');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    edit.getByText('Type whole days from 0 to 365, like 7. 0 means the same day only.'),
  ).toBeVisible();

  // 14 days, and no exchanges: refunds only
  await edit.getByLabel('Returns allowed for (days)').fill('14');
  await edit.getByLabel('Exchange account').selectOption({ label: 'No exchanges: refunds only' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, /saved/);
  await listItem(page, /POS1/).click();
  await expect(edit.getByLabel('Returns allowed for (days)')).toHaveValue('14');
  await expect(edit.getByLabel('Exchange account')).toHaveValue('');
  await expectNoSideScroll(page);
});
