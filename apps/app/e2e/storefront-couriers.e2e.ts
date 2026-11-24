import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
} from './helpers.js';

// Step 28a: the shop's couriers on the mock (mocks/storefront-shipping-data.ts). Rahman Fashion has
// Steadfast Dhaka (the default, its news arriving), Steadfast Chattogram (no webhook pasted yet,
// and keys the fake courier does not answer, so booking with it fails), Pathao counter (booked by
// hand) and an archived RedX. Steadfast Dhaka carried W-000001 to the door and has W-000003 on its
// way; W-000004 is packed with no parcel (paid online, so the rider collects nothing). A parcel
// booked by API waits in "Booking" for two seconds, then the pretend worker answers like the API's
// FakeCourier. Moving between pages goes through the menu: a reload starts the mock again.
test.use({ shopOrders: true });

async function openCouriers(page: Page): Promise<void> {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
}

async function openOrders(page: Page): Promise<void> {
  await openFromNav(page, 'Shop orders');
}

async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openOrder(page: Page, number: string): Promise<void> {
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// The parcel card (a Card is a <section>): its title is "Parcel", or "Parcel 2" once the order was
// booked again, with the pill in the heading. The last match is the card itself, not a section
// around it
function parcelCard(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: /^Parcel/ }) })
    .last();
}

// An account's row (a card on a phone). Its name starts with the account's: the row's menu button
// ("Actions for Steadfast Dhaka") holds the name too
function accountRow(page: Page, name: string) {
  const start = new RegExp(`^${name}`);
  return page.getByRole('row', { name: start }).or(page.getByRole('button', { name: start }));
}

// The row's menu button. exact: on a phone the row is a card (a button) whose name holds it too
async function rowAction(page: Page, account: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${account}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('adds a Steadfast account, shows its webhook once, picks the default and archives it', async ({
  page,
}) => {
  await openCouriers(page);
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('Books first');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText(/Last arrived/);
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText(/Keys accepted/);
  // No webhook pasted yet: the warn line says what to do, and that the poll stands in meanwhile
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText('None yet');
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText('Not tested');
  await expect(accountRow(page, 'Pathao counter')).toContainText('Moved by hand');
  await expect(accountRow(page, 'RedX')).toHaveCount(0);
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Add courier account' }).click();
  const add = page.getByRole('dialog', { name: 'Add a courier account' });
  await add.getByLabel('Name').fill('Steadfast Sylhet');
  // Both keys on the first save
  await add.getByLabel('API key').fill('sfsylhet01');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(add.getByText('Type both keys from the courier’s panel.')).toBeVisible();
  await add.getByLabel('Secret key').fill(' sfsylhet02 ');
  await add.getByRole('button', { name: 'Add account' }).click();

  // The token is in the answer once: the dialog shows it with the address to paste
  const webhook = page.getByRole('dialog', { name: 'Paste the webhook into Steadfast' });
  await expect(webhook.getByLabel('Callback URL')).toHaveValue(
    /\/public\/v1\/couriers\/steadfast\/[0-9a-f-]{36}$/,
  );
  await expect(webhook.getByLabel('Auth token (Bearer)')).toHaveValue(/^[A-Za-z0-9_-]{22}$/);
  await expect(webhook.getByText(/^Shown only this once\./)).toBeVisible();
  await webhook.getByRole('button', { name: 'Done' }).click();
  await expect(accountRow(page, 'Steadfast Sylhet')).toContainText('None yet');

  // A new token is shown once too, after a question: the old one stops at once
  await rowAction(page, 'Steadfast Sylhet', 'New webhook token');
  const renew = page.getByRole('dialog', {
    name: 'Make a new webhook token for Steadfast Sylhet?',
  });
  await renew.getByRole('button', { name: 'Make new token' }).click();
  await expect(webhook.getByLabel('Auth token (Bearer)')).toHaveValue(/^[A-Za-z0-9_-]{22}$/);
  await webhook.getByRole('button', { name: 'Done' }).click();

  // The Packed dialog's first choice
  const bookWith = page.getByLabel('Book with');
  await bookWith.selectOption({ label: 'Steadfast Sylhet · Steadfast' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await toastShown(page, 'Packed books with Steadfast Sylhet first');
  await expect(accountRow(page, 'Steadfast Sylhet')).toContainText('Books first');
  await expect(accountRow(page, 'Steadfast Dhaka')).not.toContainText('Books first');

  // Archiving the default clears it, and the dialog says so
  await rowAction(page, 'Steadfast Sylhet', 'Archive');
  const archive = page.getByRole('dialog', { name: 'Archive Steadfast Sylhet?' });
  await expect(archive.getByText(/Packed books with no courier first\./)).toBeVisible();
  await archive.getByRole('button', { name: 'Archive account' }).click();
  await toastShown(page, 'Steadfast Sylhet archived');
  await expect(bookWith.locator('option:checked')).toHaveText('Don’t book at Packed');
  await expect(accountRow(page, 'Steadfast Sylhet')).toHaveCount(0);

  await page.getByRole('group', { name: 'Show' }).getByText('Archived', { exact: true }).click();
  // An archived row opens nothing, so on a phone its card is a plain list item
  await expect(readOnlyItem(page, 'Steadfast Sylhet')).toBeVisible();
  await rowAction(page, 'RedX', 'Restore');
  await toastShown(page, 'RedX restored');
  await expect(accountRow(page, 'RedX')).toHaveCount(0);
});

test('tests the keys, keeps them write-only, and adds a courier booked by hand', async ({
  page,
}) => {
  await openCouriers(page);
  // The fake courier does not answer Chattogram's keys
  await rowAction(page, 'Steadfast Chattogram', 'Test connection');
  await toastShown(page, 'Steadfast did not answer. Try again in a few minutes.');
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText(/No answer/);

  // The keys are never shown: the boxes start empty, and an empty box keeps its key
  await rowAction(page, 'Steadfast Dhaka', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Dhaka' });
  await expect(edit.getByLabel('API key')).toHaveValue('');
  await expect(edit.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved');
  await expect(edit.getByText(/^An account’s courier can’t change\./)).toBeVisible();
  await edit.getByLabel('Name').fill('Steadfast Dhaka depot');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');
  // The same keys: the last test still stands
  await expect(accountRow(page, 'Steadfast Dhaka depot')).toContainText(/Keys accepted/);

  await page.getByRole('button', { name: 'Add courier account' }).click();
  const add = page.getByRole('dialog', { name: 'Add a courier account' });
  await add.getByText('Another courier, by hand').click();
  await expect(add.getByLabel('API key')).toHaveCount(0);
  await add.getByLabel('Name').fill('Paperfly Mirpur');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(add.getByText('Pick the courier you book these parcels with.')).toBeVisible();
  await add.getByLabel('Courier', { exact: true }).selectOption({ label: 'Paperfly' });
  await add.getByRole('button', { name: 'Add account' }).click();
  // Nothing to paste for a courier booked by hand
  await toastShown(page, 'Courier account Paperfly Mirpur added');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(accountRow(page, 'Paperfly Mirpur')).toContainText('Paperfly · booked by hand');
  // Only an API account can be the default
  await expect(
    page.getByLabel('Book with').locator('option', { hasText: 'Paperfly Mirpur' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Book with').locator('option', { hasText: 'Steadfast Dhaka depot' }),
  ).toHaveCount(1);
  await expectNoSideScroll(page);
});

test('packs with the default courier; the booked parcel prints its label and cancels with the order', async ({
  page,
}) => {
  test.slow();
  // Count what the browser was asked to print, and keep the label's words at that moment
  await page.addInitScript(() => {
    window.print = () => {
      const sheet = document.querySelector('[data-print-sheet]');
      document.body.setAttribute('data-printed', sheet?.textContent ?? '');
    };
  });
  await page.goto('/');
  await openOrders(page);
  await openOrder(page, 'W-000005');
  await page.getByRole('button', { name: 'Mark packed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pack W-000005' });
  // The default account, with what happens after the challan
  await expect(dialog.getByLabel('Send with').locator('option:checked')).toHaveText(
    'Steadfast Dhaka',
  );
  await expect(
    dialog.getByText('Omnivo books the parcel with Steadfast Dhaka once the challan is posted.'),
  ).toBeVisible();
  await dialog
    .getByRole('region', { name: /Steel analog wristwatch/ })
    .getByLabel('Serial numbers')
    .fill('SW-7781');
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  // Not toastShown: it waits for the toast to close, and the pretend worker answers in 2 seconds
  await expect(
    page.getByText(
      /^W-000005 packed\. Challan .+ posted\. Booking the parcel with Steadfast Dhaka\.$/,
    ),
  ).toBeVisible();

  // Booking now: the page asks again every 3 seconds until the worker answered
  const parcel = parcelCard(page);
  await expect(parcel.getByText('Booking with Steadfast Dhaka…')).toBeVisible();
  await expect(page.getByText('Omnivo is booking the parcel with Steadfast Dhaka.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book courier' })).toHaveCount(0);
  await expect(
    page.getByText(
      'The order moves to Shipped by itself when Steadfast Dhaka’s rider picks the parcel up.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(parcel.getByText(/^FAKE[0-9A-F]{10}$/)).toBeVisible();
  await expect(parcel.getByText('No news from the courier yet.')).toHaveCount(0);
  await expectNoSideScroll(page);

  // The label: the courier's code, the order, the buyer, and what the rider collects
  await parcel.getByRole('button', { name: 'Print label' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-printed', /Steadfast · FAKE/);
  const printed = (await page.locator('body').getAttribute('data-printed')) ?? '';
  expect(printed).toContain('W-000005');
  expect(printed).toContain('Farhana Islam');
  expect(printed).toMatch(/Collect ৳[\d,]+\.\d{2}/);

  // Cancel says the courier's panel must cancel it too; the parcel is cancelled with the order
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel W-000005?' });
  await expect(
    cancel.getByText(/^Its parcel booked with Steadfast Dhaka is cancelled here too\./),
  ).toBeVisible();
  await cancel.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000005 cancelled. The shopper gets an SMS.');
  await expect(parcel.getByText('Cancelled').first()).toBeVisible();
});

test('a booking that fails rings the bell; Book again books it once the keys are fixed', async ({
  page,
}) => {
  test.slow();
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await expect(
    page.getByText('Book a courier, or mark it shipped when the parcel leaves the shop.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  // Paid online (Nagad): the rider collects nothing
  await expect(book.getByText(/The order is paid, so the rider collects nothing\.$/)).toBeVisible();
  await book
    .getByLabel('Courier account')
    .selectOption({ label: 'Steadfast Chattogram · Steadfast' });
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'Booking W-000004’s parcel with Steadfast Chattogram');

  // Five tries got no answer: the crit notice, the Needs attention pill and the bell
  await expect(
    page.getByText(
      'Steadfast Chattogram did not book the parcel. The courier did not answer. Book again in a few minutes.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Needs attention')).toBeVisible();
  await expect(parcelCard(page).getByText('Nothing: paid online')).toBeVisible();
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await expect(
    page.getByText(
      'Steadfast Chattogram did not book the parcel of W-000004. Open the order to book it again.',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Fix the keys on Shop couriers (a new key clears the last test), then come back
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Chattogram', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Chattogram' });
  await edit.getByLabel('API key').fill('sfctg2611ok');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');

  await openOrders(page);
  await showTab(page, 'Packed');
  await expect(listItem(page, /W-000004/)).toContainText('Needs attention');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book again' }).click();
  await toastShown(page, 'Booking W-000004’s parcel again');
  await expect(
    page.getByText(
      'The order moves to Shipped by itself when Steadfast Chattogram’s rider picks the parcel up.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  // The same parcel, booked: no second card, and no attention any more
  await expect(page.getByRole('heading', { level: 3, name: /^Parcel 2/ })).toHaveCount(0);
  await expect(page.getByText('Needs attention')).toHaveCount(0);
  await expect(parcelCard(page).getByText(/^FAKE[0-9A-F]{10}$/)).toBeVisible();
});

test('exports the packed orders, then books one by hand and moves it with the buttons', async ({
  page,
}) => {
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Packed');

  // The file for the courier's bulk upload: W-000004 waits, and the rider collects nothing
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for courier' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^courier-orders-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv).toMatch(/^\uFEFFInvoice,Name,Address,Phone,Amount,Note\r?\n/);
  expect(csv).toContain(
    'W-000004,Mitu Akter,"House 12, Sector 7, Uttara, Dhaka 1230",01552334455,0.00',
  );
  await toastShown(page, '1 packed order in the file');

  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  await book.getByLabel('Courier account').selectOption({ label: 'Pathao counter · Pathao' });
  await book.getByRole('button', { name: 'Book courier' }).click();
  await expect(
    book.getByText('Type the tracking code the courier gave for this parcel.'),
  ).toBeVisible();
  // Typed as it comes; kept in capitals, as the courier shows it
  await book.getByLabel('Tracking code').fill('ptp-2611-77');
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'W-000004 booked with Pathao counter, code PTP-2611-77');

  const parcel = parcelCard(page);
  await expect(parcel.getByText('Booked by hand. Move the order with its buttons.')).toBeVisible();
  await expect(
    page.getByText('Mark it shipped when Pathao counter picks the parcel up.'),
  ).toBeVisible();
  // A parcel on its way: no second booking
  await expect(page.getByRole('button', { name: 'Book courier' })).toHaveCount(0);

  // The order's button moves the parcel too
  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000004 shipped');
  await expect(parcel.getByText('Picked up').first()).toBeVisible();

  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  await showTab(page, 'Packed');
  await page.getByRole('button', { name: 'Export for courier' }).click();
  await toastShown(page, 'No packed order waits for a courier.');
});

test('shows the courier’s news on a shipped order', async ({ page }) => {
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Shipped');
  await openOrder(page, 'W-000003');
  await expect(
    page.getByText(
      'The order moves to Delivered by itself when Steadfast Dhaka delivers it. That posts the invoice.',
    ),
  ).toBeVisible();
  const parcel = parcelCard(page);
  await expect(parcel.getByText('SFR2611210042')).toBeVisible();
  await expect(parcel.getByText('Reached the Chattogram hub')).toBeVisible();
  // Newest first
  await expect(parcel.getByRole('listitem').first()).toContainText('In transit');
  await expectNoSideScroll(page);
});

test('a packer books with the active accounts without the Shop couriers page', async ({ page }) => {
  await actAs(page, {
    name: 'Packer',
    permissions: ['storefront.order.read', 'storefront.order.manage'],
  });
  await page.goto('/');
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Shop couriers' }),
  ).toHaveCount(0);
  await openOrders(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  // Active accounts only: the archived RedX is not offered
  await expect(book.getByLabel('Courier account').locator('option')).toHaveText([
    'Pick an account',
    'Pathao counter · Pathao',
    'Steadfast Chattogram · Steadfast',
    'Steadfast Dhaka · Steadfast',
  ]);
  await book.getByLabel('Courier account').selectOption({ label: 'Steadfast Dhaka · Steadfast' });
  await expect(
    book.getByText(
      'Omnivo books the parcel with Steadfast now, and the courier’s news move the order.',
    ),
  ).toBeVisible();
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'Booking W-000004’s parcel with Steadfast Dhaka');
});
