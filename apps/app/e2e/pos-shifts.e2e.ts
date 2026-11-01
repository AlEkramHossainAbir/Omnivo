import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 20b: shifts at the counter. The garments workspace's POS1 Showroom counter never had a
// shift, so its first one asks where the cash came from (decision 12). POS2, held by Abdul Karim's
// Store office PC, has a shift open since this morning with ৳5,000 (src/mocks/pos-shift-data.ts →
// seedPosShifts). The reasons: Float from the owner and Change from the bank in; Cash to the bank
// and Tea for the staff out; Staff lunch archived. Every counter's difference goes to 5340 Cash
// over and short, and rings the bell over ৳500. A crew-neck T-shirt is ৳368 with VAT.

const PIN = '480915';

// A whole shift with a sale, a pay out, two held bills and two counts, while the mock copies
// 10,000 styles: 30 seconds is too tight on a busy machine
test.describe.configure({ timeout: 90_000 });

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The receipt prints by itself after a sale: a counter instead of the print dialog
    window.print = () => undefined;
  });
  await page.goto('/');
  await waitForCopy(page);
}

async function openPos(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
}

async function takePos1(page: Page): Promise<void> {
  await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, 'This device is POS1 now. The next receipt is POS1-000001.');
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
}

async function countAsTotal(scope: Page | ReturnType<Page['getByRole']>, total: string) {
  await scope.getByText('As a total').click();
  await scope.getByLabel('Cash in the drawer').fill(total);
}

function shiftMenu(page: Page, number: string) {
  return page.getByRole('button', { name: `Shift ${number} menu` });
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

test('opens a shift, sells, pays out, holds a bill and closes short', async ({ page }) => {
  await start(page);
  await openPos(page);
  await takePos1(page);

  // The first shift: counted by notes (2 × ৳1,000), and the float came from the owner
  await expect(page.getByText('This is the first shift of POS1.')).toBeVisible();
  await page.getByLabel('How many ৳1,000').fill('2');
  await expect(page.getByText('= ৳2,000')).toBeVisible();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(
    page.getByText('This is the register’s first shift. Pick where the cash comes from'),
  ).toBeVisible();
  await page.getByLabel('Brought in as').selectOption({ label: 'Float from the owner' });
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');

  // A bill held with F8, then resumed with F9: its prices stay
  await scanTshirt(page);
  await page.keyboard.press('F8');
  const hold = page.getByRole('dialog', { name: 'Hold this bill' });
  await hold.getByLabel('Name').fill('Customer in the blue shirt');
  await hold.getByRole('button', { name: 'Hold bill' }).click();
  await toastShown(page, 'Bill held');
  await expect(payButton(page, '৳368')).toBeHidden();
  await page.keyboard.press('F9');
  const held = page.getByRole('dialog', { name: 'Held bills' });
  await expect(held).toContainText('Customer in the blue shirt');
  await held.getByRole('button', { name: 'Resume' }).click();
  await expect(held).toBeHidden();

  // Sold for the exact amount in cash
  await payButton(page, '৳368').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('No change to give');
  await done.getByRole('button', { name: 'New sale' }).click();

  // Tea for the staff, out of the drawer: the cashier picks the reason, never an account
  await shiftMenu(page, 'POS1-S0001').click();
  await page.getByRole('menuitem', { name: 'Pay out' }).click();
  const payOut = page.getByRole('dialog', { name: 'Pay out' });
  await expect(payOut.getByLabel('Reason').getByRole('option')).toContainText([
    'Pick a reason',
    'Cash to the bank',
    'Tea for the staff',
  ]);
  await payOut.getByLabel('Reason').selectOption({ label: 'Tea for the staff' });
  await payOut.getByLabel('Amount').fill('120');
  await payOut.getByLabel('Note').fill('Tea and biscuits for the cutting floor');
  await payOut.getByRole('button', { name: 'Pay out ৳120' }).click();
  await toastShown(page, '৳120 paid out for Tea for the staff');

  // One more bill held, and left: the close drops it
  await scanTshirt(page);
  await page.keyboard.press('F8');
  await page
    .getByRole('dialog', { name: 'Hold this bill' })
    .getByRole('button', { name: 'Hold bill' })
    .click();
  await toastShown(page, 'Bill held');

  // The blind count: what the drawer should hold shows only after the close
  await shiftMenu(page, 'POS1-S0001').click();
  await page.getByRole('menuitem', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await expect(close).toContainText('1 held bill is dropped when the shift closes.');
  await expect(close).not.toContainText('2,248');
  await countAsTotal(close, '1500');
  await close.getByRole('button', { name: 'Close the shift' }).click();

  // ৳2,000 + ৳368 − ৳120 = ৳2,248 expected, ৳1,500 counted
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  await expect(result).toContainText('Counted৳1,500');
  await expect(result).toContainText('Expected৳2,248');
  await expect(result).toContainText('৳748 short');
  await expect(result).toContainText('The drawer has ৳748 less than expected.');
  await result.getByRole('button', { name: 'Open the next shift' }).click();

  // The next shift goes on from this device's own count, before the server answers
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
  await expect(page.getByLabel('Brought in as')).toBeHidden();
  await countAsTotal(page, '1500');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'The drawer has what the last shift left: ৳1,500.');
  await expect(shiftMenu(page, 'POS1-S0002')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
  ).toBeVisible();

  // The managers' side: the shift, the books, and the bell over the register's ৳500
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS shifts');
  const row = listItem(page, /POS1-S0001/);
  await expect(row).toContainText('Closed');
  await expect(row).toContainText(/৳748(\.00)? short/);
  await expect(listItem(page, /POS1-S0002/)).toContainText('Open');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
  await expect(page.getByText('Float from the owner')).toBeVisible();
  await expect(page.getByText('Tea and biscuits for the cutting floor')).toBeVisible();
  // The float, the pay out and the closing difference each posted an entry
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toHaveCount(3);
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await page.getByText(/^POS1-S0001 on Showroom counter closed ৳748(\.00)? short\./).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
});

test('sign-out waits for the close, and the register stays held', async ({ page }) => {
  await start(page);
  await openPos(page);
  await takePos1(page);
  await countAsTotal(page, '0');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');

  // The register cannot change while the shift is open
  await page.getByRole('button', { name: 'Change register' }).click();
  await expect(
    page.getByText('Shift POS1-S0001 is open. Close it, then change the register.'),
  ).toBeVisible();

  // Sign-out from the shell leads back to the close (decision 6)
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const gate = page.getByRole('dialog', { name: 'Close the shift first' });
  await expect(gate).toContainText('Shift POS1-S0001 is open on this device.');
  await gate.getByRole('button', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await countAsTotal(close, '0');
  await close.getByRole('button', { name: 'Close the shift' }).click();
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  // Even: the strip says so, and no notice (only a difference needs one)
  await expect(result).toContainText('DifferenceNo difference');
  // Closed, sign-out goes on: the register is let go, then the sign-in page
  await result.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a manager closes a stuck shift without a count', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'POS shifts');
  const row = listItem(page, /POS2-S0001/);
  await expect(row).toContainText('Abdul Karim');
  await expect(row).toContainText('Open');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS2-S0001' })).toBeVisible();
  await expect(page.getByText(/^Open since /)).toBeVisible();

  await page.getByRole('button', { name: 'Close without a count' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close POS2-S0001 without a count?' });
  await dialog.getByLabel('Why').fill('Abdul went home sick; the drawer went to the safe.');
  await dialog.getByRole('button', { name: 'Close without a count' }).click();
  await toastShown(page, 'POS2-S0001 closed without a count');
  await expect(page.getByText('Not counted')).toBeVisible();
  await expect(
    page.getByText(/^Nobody counted this drawer, so no difference was posted\./),
  ).toBeVisible();
  await expect(page.getByText(/^Closed by Farhana Rahman · /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close without a count' })).toBeHidden();
  await expectNoSideScroll(page);
});

test('adds a pay out reason, and keeps names apart', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'POS cash reasons');
  await expect(listItem(page, /Float from the owner/)).toContainText('3100 · Capital');
  await expect(listItem(page, /Tea for the staff/)).toContainText('Pay out');

  await page.getByRole('button', { name: 'Add reason' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a reason' });
  await dialog.getByLabel('Name').fill('Delivery van fuel');
  await dialog.getByLabel('Kind').selectOption({ label: 'Pay out: money goes out of the drawer' });
  await dialog.getByLabel('Account').selectOption({ label: '5290 · Consumables and internal use' });
  await dialog.getByRole('button', { name: 'Add reason' }).click();
  await toastShown(page, 'Delivery van fuel added');
  await expect(listItem(page, /Delivery van fuel/)).toContainText('Pay out');

  // An archived reason keeps its name: restore it instead
  await page.getByRole('button', { name: 'Add reason' }).click();
  await dialog.getByLabel('Name').fill('staff lunch');
  await dialog.getByLabel('Account').selectOption({ label: '5290 · Consumables and internal use' });
  await dialog.getByRole('button', { name: 'Add reason' }).click();
  await expect(
    dialog.getByText(/^Another reason has this name, maybe an archived one\./),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The kind never changes once saved
  await listItem(page, /Tea for the staff/).click();
  const edit = page.getByRole('dialog', { name: 'Edit Tea for the staff' });
  await expect(edit.getByText(/^A reason stays a pay in or a pay out/)).toBeVisible();
  await expect(edit.getByRole('combobox', { name: 'Kind' })).toBeHidden();
  await expectNoSideScroll(page);
});

test.describe('the idle lock', () => {
  // This test sets the device's PIN itself
  test.use({ answerPinDialog: false });

  test('needs a PIN before the shift, then locks the POS when nobody uses it', async ({ page }) => {
    // Fake timers that still run on their own, so the test can jump past the 2 minutes
    await page.clock.install();
    await start(page);
    await page
      .getByRole('dialog', { name: 'Set a PIN for this device' })
      .getByRole('button', { name: 'Not now' })
      .click();

    // POS1 locks after 2 minutes; the device picks the change up with its next sync
    await openFromNav(page, 'POS registers');
    await listItem(page, /POS1/).click();
    const edit = page.getByRole('dialog', { name: 'Edit POS1' });
    await edit.getByLabel('Lock the POS after').selectOption({ label: '2 minutes' });
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await toastShown(page, /saved/);
    await openFromNav(page, /^Sync/);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
    ).toBeVisible();

    // No PIN, no shift (decision 7): the device sets one here
    await openPos(page);
    await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
    await page.getByRole('button', { name: 'Use this register' }).click();
    await expect(
      page.getByText(
        'POS1 locks itself when nobody uses it, so this device needs a PIN before a shift opens.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Set a PIN' }).click();
    const pin = page.getByRole('dialog', { name: 'Set a PIN for this device' });
    await pin.getByLabel('PIN', { exact: true }).fill(PIN);
    await pin.getByLabel('Type the PIN again').fill(PIN);
    await pin.getByRole('button', { name: 'Set PIN' }).click();
    await toastShown(page, 'Device PIN set');

    await countAsTotal(page, '0');
    await page.getByRole('button', { name: 'Open shift' }).click();
    await toastShown(page, 'Shift POS1-S0001 is open');
    await scanTshirt(page);

    // Two minutes and a check later, with nobody at the counter
    await page.clock.fastForward('02:10');
    await expect(page.getByRole('heading', { level: 1, name: 'Omnivo is locked' })).toBeVisible();
    await expect(
      page.getByText('Nobody used the POS for 2 minutes, so it locked itself.', { exact: false }),
    ).toBeVisible();
    await page.getByLabel('PIN', { exact: true }).fill(PIN);
    await page.getByRole('button', { name: 'Unlock' }).click();

    // The same shift, and the cart is where it was
    await expect(shiftMenu(page, 'POS1-S0001')).toBeVisible();
    await expect(payButton(page, '৳368')).toBeEnabled();
  });
});
