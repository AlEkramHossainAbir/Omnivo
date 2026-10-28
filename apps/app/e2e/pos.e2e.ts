import type { Page, TestInfo } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 20a: the POS. The garments workspace's head office has two counters in its main store
// (src/mocks/pos-data.ts → seedPos): POS1 Showroom counter, free, and POS2 Factory outlet counter,
// held by Abdul Karim's Store office PC. The Chattogram depot has CTG1. This browser's device is in
// the head office (helpers.ts), takes POS1, and its first receipt is POS1-000001. A crew-neck
// T-shirt is ৳320 before VAT at 15% (the garments workspace prices before VAT), so two are ৳736.
//
// The receipt prints with window.print(), which would open the browser's print dialog: each test
// replaces it with a counter on <body> before the app starts, and reads the counter.

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

// "POS" alone: "POS sales" and "POS registers" are links too
async function openPos(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
}

// The register chooser, once per device (decision 14)
async function takeRegister(page: Page, label: string, toast: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Which counter is this?' })).toBeVisible();
  await page.getByLabel('Register').selectOption({ label });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, toast);
  await expect(page.getByRole('searchbox', { name: 'Scan or search' })).toBeFocused();
}

// The Pay button: in the cart on a desktop, in the bar at the bottom on a phone
function payButton(page: Page, amount: string) {
  return page.getByRole('button', { name: `Pay ${amount}` }).filter({ visible: true });
}

// On a phone the cart is a bar until it is opened; a desktop shows it beside the products
async function openCart(page: Page, testInfo: TestInfo, count: string): Promise<void> {
  if (isPhone(testInfo)) await page.getByRole('button', { name: new RegExp(`^${count}`) }).click();
  await expect(page.getByRole('complementary', { name: 'Cart' })).toBeVisible();
}

// Out of the POS (it has no sidebar), then a page of the shell from its nav
async function leavePos(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, name);
}

test('takes a register, sells for cash and prints the receipt', async ({ page }, testInfo) => {
  await openPos(page);
  // POS2 stays in the list with its holder: the claim would say pos_register_in_use
  await expect(page.getByLabel('Register').getByRole('option')).toContainText([
    'Pick a register',
    'POS1 · Showroom counter',
    'POS2 · held by Store office PC',
  ]);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );

  // A scanner types the barcode and Enter; the box empties for the next scan
  const search = page.getByRole('searchbox', { name: 'Scan or search' });
  await search.fill('8941100500118');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(payButton(page, '৳368')).toBeEnabled();
  // A tile adds one more of the same item to its line
  await search.fill('crew-neck');
  await page.getByRole('button', { name: /^Basic crew-neck T-shirt P-/ }).click();
  await expect(payButton(page, '৳736')).toBeEnabled();
  await openCart(page, testInfo, '1 item');
  await expect(page.getByRole('complementary', { name: 'Cart' })).toContainText('Walk-in customer');
  await expectNoSideScroll(page);

  await payButton(page, '৳736').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  // The notes the customer handed over: one tap, and the change shows
  await pay.getByRole('button', { name: '৳1,000' }).click();
  await expect(pay).toContainText('Change৳264');
  await pay.getByRole('button', { name: 'Complete sale' }).click();

  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('Give back ৳264 in cash');
  await expectPrinted(page, 1);
  await done.getByRole('button', { name: 'Print again' }).click();
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();
  // The top bar's next number (a phone's bar has no room for it)
  if (!isPhone(testInfo)) await expect(page.getByText('Next receipt POS1-000002')).toBeVisible();

  // Online, the sale went at once: the server posted it, with its entry
  await leavePos(page, 'POS sales');
  const row = listItem(page, /POS1-000001/);
  await expect(row).toContainText('Walk-in');
  await expect(row).toContainText('৳736');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000001' })).toBeVisible();
  await expect(page.getByText('Basic crew-neck T-shirt')).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toBeVisible();
  // The receipt again, from the sale's page
  await page.getByRole('button', { name: 'Print receipt' }).click();
  await expectPrinted(page, 3);
  await expectNoSideScroll(page);
});

test('sells offline, and lists the serial number that was not in the store', async ({
  page,
}, testInfo) => {
  await openPos(page);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );
  await page.context().setOffline(true);

  // The sewing machine has no price: the cashier types one (not an override). Its line opens at
  // once for the serial numbers; 0199 is not in the main store, so the server lets it leave
  // without its serial number and lists it (decision 15).
  await page.getByRole('searchbox', { name: 'Scan or search' }).fill('Juki');
  const machine = page.getByRole('button', { name: /^Juki DDL-8000A lockstitch machine P-/ });
  await expect(machine).toContainText('3 pcs');
  await machine.click();
  await openCart(page, testInfo, '1 item');
  const cart = page.getByRole('complementary', { name: 'Cart' });
  await cart.getByLabel('Price').fill('85000');
  await cart.getByLabel('Serial numbers').fill('JK8000-24-0117\nJK8000-24-0199');
  // Two machines at ৳85,000 + 15% VAT
  await payButton(page, '৳1,95,500').click();

  // Split: a card for most of it, the rest in cash
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByLabel('Amount').fill('5500');
  await pay.getByRole('button', { name: 'Add another method' }).click();
  await expect(pay.getByLabel('Paid by').nth(1)).toHaveValue('card');
  await expect(pay.getByLabel('Amount').nth(1)).toHaveValue(/1,90,000|190000/);
  await pay.getByLabel('Reference').nth(1).fill('Card ending 4821');
  await pay.getByRole('button', { name: 'Complete sale' }).click();

  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('No change to give');
  await expect(done).toContainText('Saved on this device. It syncs when the connection is back.');
  await expectPrinted(page, 1);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(
    page.getByRole('link', { name: 'Sync: Offline, 1 change waiting', exact: true }),
  ).toBeVisible();
  // The sale is not in the copy's stock yet, but the screen counts it: 1 machine is left, so the
  // last one cannot be sold twice
  await page.getByRole('searchbox', { name: 'Scan or search' }).fill('Juki');
  await expect(machine).toContainText('1 pcs');

  // Back online, the outbox sends it
  await page.context().setOffline(false);
  await expect(
    page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
  ).toBeVisible();

  await leavePos(page, 'POS sales');
  const row = listItem(page, /POS1-000001/);
  await expect(row).toContainText('Sold short');
  await row.click();
  await expect(
    page.getByText(/^Some items were sold without stock at MAIN · Main store\./),
  ).toBeVisible();

  // The bell tells the people who put stock right (decision 30), and opens the list
  await page.getByRole('button', { name: 'Notifications, 4 unread' }).click();
  await page.getByText(/^POS1-000001 sold more than Main store had/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sold short' })).toBeVisible();
  await expect(listItem(page, /Juki DDL-8000A/)).toContainText(
    'Left without a serial number: JK8000-24-0199',
  );
  await expectNoSideScroll(page);
});

test('changes the register only when the server lets it go', async ({ page }) => {
  await openPos(page);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );
  await page.getByRole('button', { name: 'Change register' }).click();
  // Free again: the chooser is back, and POS1 is not held by anyone
  await expect(page.getByRole('heading', { name: 'Which counter is this?' })).toBeVisible();
  await expect(page.getByLabel('Register').getByRole('option')).toContainText([
    'Pick a register',
    'POS1 · Showroom counter',
  ]);
  // Another device's register cannot be taken
  await page.getByLabel('Register').selectOption({ label: 'POS2 · held by Store office PC' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await expect(
    page.getByText('Another device holds this register. Sign out on that device first'),
  ).toBeVisible();
});

test('adds a register, and keeps a held one from being archived', async ({ page }) => {
  await openFromNav(page, 'POS registers');
  await expect(listItem(page, /POS2/)).toContainText('Store office PC · Abdul Karim');
  await expect(listItem(page, /POS1/)).toContainText('Free');
  // The depot's counter, freed by the revoke of its computer, goes on from its last receipt
  await expect(listItem(page, /CTG1/)).toContainText('CTG1-001260');

  await page.getByRole('button', { name: 'Add register' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a register' });
  await dialog.getByLabel('Code').fill('pos3');
  await dialog.getByLabel('Name').fill('Export surplus counter');
  await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
  await dialog.getByRole('button', { name: 'Add register' }).click();
  await toastShown(page, 'Export surplus counter added');
  // The code is upper case, as on every receipt
  await expect(listItem(page, /POS3/)).toContainText('No sale yet');

  // Its code is taken now
  await page.getByRole('button', { name: 'Add register' }).click();
  await dialog.getByLabel('Code').fill('POS3');
  await dialog.getByLabel('Name').fill('Second outlet counter');
  await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
  await dialog.getByRole('button', { name: 'Add register' }).click();
  await expect(dialog.getByText('Another register uses this code.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Decision 33: only the device knows whether a sale of it still waits
  await listItem(page, /POS2/).click();
  const edit = page.getByRole('dialog', { name: 'Edit POS2' });
  await edit.getByRole('button', { name: 'Archive' }).click();
  await expect(edit.getByText('Another device holds this register.')).toBeVisible();
  await expectNoSideScroll(page);
});
