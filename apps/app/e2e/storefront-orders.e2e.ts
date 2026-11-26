import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  openModule,
  pinAnswered,
  test,
  toastShown,
} from './helpers.js';

// Step 27b: the shop's orders in the ERP, on the mock (mocks/storefront-order-data.ts). Rahman
// Fashion's orders: W-000001 delivered, W-000002 cancelled, W-000003 shipped, W-000004 packed, and
// three new ones: W-000005 (an attar of two lots, a watch by its serial number, two polos),
// W-000006, and W-000007 whose sales order was refused when it was confirmed. They are seeded only
// when a test asks (they make sales orders, challans and customers the other tests would see).
test.use({ shopOrders: true });

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await openFromNav(page, 'Shop orders');
}

// The list's tabs are a segmented control ("Show"): its radios are hidden, their words are the
// labels. Inside the control: "New" is a status pill in the table too
async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openOrder(page: Page, number: string): Promise<void> {
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// A row of the order's Documents card: the kind, then the number as a link (or when it comes)
function documentRow(page: Page, kind: string) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Documents' }) })
    .getByRole('listitem')
    .filter({ hasText: kind });
}

async function backToList(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop orders' })).toBeVisible();
}

test('lists the orders by tab and finds them by number, name or phone', async ({ page }) => {
  await start(page);
  // Three wait to be packed: the sidebar says so
  await expect(
    page.getByRole('navigation').getByRole('link', { name: /Shop orders/ }),
  ).toContainText('3');

  // New first, the newest confirmed on top; the refused one says so
  await expect(listItem(page, /W-00000[567]/)).toHaveCount(3);
  await expect(listItem(page, /W-000007/)).toContainText('Needs attention');
  await expect(listItem(page, /W-000005/)).toContainText('6 items');
  await expectNoSideScroll(page);

  await showTab(page, 'Packed');
  await expect(page).toHaveURL(/view=packed/);
  await expect(listItem(page, /W-00000/)).toHaveCount(1);
  await expect(listItem(page, /W-000004/)).toContainText('Mitu Akter');

  await showTab(page, 'Delivered');
  await expect(listItem(page, /W-000001/)).toContainText('Delivered');

  // The search looks in the tab only, and offers every order
  await page.getByLabel('Search the orders').fill('farhana');
  await expect(listItem(page, /W-00000/)).toHaveCount(1);
  await showTab(page, 'All');
  await expect(listItem(page, /W-00000/)).toHaveCount(2);
  // A phone typed with a space finds the 11 digits the shop keeps
  await page.getByLabel('Search the orders').fill('01711 223344');
  await expect(listItem(page, /W-00000/)).toHaveCount(2);

  await showTab(page, 'New');
  await page.getByLabel('Search the orders').fill('W-000004');
  await expect(page.getByText('No order matches')).toBeVisible();
  await page.getByRole('button', { name: 'Search every order' }).click();
  await expect(listItem(page, /W-000004/)).toBeVisible();

  await page.getByLabel('Search the orders').fill('');
  await showTab(page, 'Cancelled');
  await openOrder(page, 'W-000002');
  // A cancelled order shows what it made, and why it ended; no step is left to press
  await expect(page.getByText('Why: The shopper did not answer the phone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await expect(page.getByText('When it is packed')).toHaveCount(0);
  await expectNoSideScroll(page);
});

test('packs an order by batch and serial number, then ships and delivers it', async ({ page }) => {
  // Four moves and the challan's own page
  test.slow();
  await start(page);
  await openOrder(page, 'W-000005');
  await expect(page.getByText(/^Pack the goods, then mark it packed\./)).toBeVisible();
  // Farhana Islam's second order: the phone found her customer
  await expect(page.getByRole('link', { name: 'Farhana Islam' })).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Mark packed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pack W-000005' });
  await expect(
    dialog.getByText(/^The challan takes these goods out of Main store\./),
  ).toBeVisible();

  // The attar's lots by expiry, not by arrival: AT-2408 came in second but expires first, and
  // holds only 2 of the 3
  const attar = dialog.getByRole('region', { name: /Oud attar 6 ml/ });
  await expect(attar.getByLabel('Batch 1', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2408/,
  );
  await expect(attar.getByLabel('Quantity 1')).toHaveValue('2');
  await expect(attar.getByLabel('Batch 2', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2411/,
  );
  await expect(attar.getByLabel('Quantity 2')).toHaveValue('1');
  await expect(attar.getByText('3 of 3 pcs picked')).toBeVisible();
  const polo = dialog.getByRole('region', { name: /Pique polo shirt · Navy blue · M/ });
  await expect(polo.getByText('No batch or serial number to pick.')).toBeVisible();

  // All 3 from the first lot: the challan's stock check says no, under that batch's quantity
  await attar.getByRole('button', { name: 'Remove batch 2' }).click();
  await attar.getByLabel('Quantity 1').fill('3');
  const watch = dialog.getByRole('region', { name: /Steel analog wristwatch/ });
  await watch.getByLabel('Serial numbers').fill('SW-7782');
  // Step 28a: the dialog starts with the shop's default courier. This order goes by the shop's
  // own rider, moved by hand (storefront-couriers.e2e.ts books one)
  await dialog.getByLabel('Send with').selectOption({ label: 'Don’t book now' });
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  await expect(
    attar.getByText('Not enough stock here. Lower the quantity or pick another batch.'),
  ).toBeVisible();

  await attar.getByLabel('Quantity 1').fill('2');
  await attar.getByRole('button', { name: 'Add another batch' }).click();
  // The options: "Pick a batch", then the lots by expiry. The option's words carry a date that
  // moves with today, so by place: AT-2411 is the second lot
  await attar.getByLabel('Batch 2', { exact: true }).selectOption({ index: 2 });
  await expect(attar.getByLabel('Batch 2', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2411/,
  );
  await attar.getByLabel('Quantity 2').fill('1');
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  await toastShown(page, /^W-000005 packed\. Challan .+ posted\.$/);
  // Step 28a: the shop has couriers, so the line offers one too
  await expect(
    page.getByText('Book a courier, or mark it shipped when the parcel leaves the shop.'),
  ).toBeVisible();

  // The challan is a real one: its lines took the batches and the serial number picked
  const challan = documentRow(page, 'Challan').getByRole('link');
  const challanNumber = (await challan.textContent()) ?? '';
  await challan.click();
  await expect(page.getByRole('heading', { level: 1, name: challanNumber })).toBeVisible();
  await expect(page.getByText('SW-7782', { exact: true })).toBeVisible();
  await expect(page.getByText(/AT-2408/).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000005' })).toBeVisible();

  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000005 shipped');

  // Delivered posts an invoice, so it asks first
  await page.getByRole('button', { name: 'Mark delivered' }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark W-000005 delivered?' });
  await expect(confirm.getByText(/^This posts an invoice for ৳/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Mark delivered' }).click();
  await toastShown(page, /^W-000005 delivered\. Invoice .+ posted\.$/);
  await expect(page.getByText(/^The invoice waits for its money\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Record payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Mark / })).toHaveCount(0);

  // Off the New tab, and the sidebar's count is down by one
  await backToList(page);
  await expect(listItem(page, /W-000005/)).toHaveCount(0);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: /Shop orders/ }),
  ).toContainText('2');
});

test('cancels a new order, and a packed one through a sales return', async ({ page }) => {
  await start(page);
  await openOrder(page, 'W-000006');
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel W-000006?' });
  await expect(dialog.getByText(/^The stock held for it is free again/)).toBeVisible();
  await dialog.getByLabel('Why').fill('Out of stock at the Khulshi courier point');
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000006 cancelled. The shopper gets an SMS.');
  await expect(page.getByText('Why: Out of stock at the Khulshi courier point')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

  await backToList(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const packed = page.getByRole('dialog', { name: 'Cancel W-000004?' });
  await expect(packed.getByText(/^A sales return brings the packed goods back/)).toBeVisible();
  await packed.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000004 cancelled. The shopper gets an SMS.');
  // The goods came back on a sales return, linked beside the challan
  await expect(documentRow(page, 'Sales return').getByRole('link')).toBeVisible();
  await expect(documentRow(page, 'Challan').getByRole('link')).toBeVisible();
});

test('makes the sales order of an order whose first try was refused', async ({ page }) => {
  await start(page);
  await openOrder(page, 'W-000007');
  await expect(
    page.getByText(
      'The sales order could not be made. Pick an active product. This one is archived or was deleted.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Found by the phone with the sales order')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Make the sales order' }).click();
  await toastShown(page, /^Sales order .+ made for W-000007$/);
  await expect(page.getByText(/^Pack the goods, then mark it packed\./)).toBeVisible();
  // A new shopper: the phone made her a customer
  await expect(page.getByRole('link', { name: 'Shirin Sultana' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toBeVisible();

  await backToList(page);
  await expect(listItem(page, /W-000007/)).not.toContainText('Needs attention');
});

test('the bell opens the new order', async ({ page }) => {
  await page.goto('/');
  await pinAnswered(page);
  // The workspace's other notifications are unread too: the count is not this test's
  await page
    .getByRole('button', { name: /^Notifications, \d+ unread$/ })
    .first()
    .click();
  await page.getByRole('button', { name: /New shop order W-000006 for ৳/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000006' })).toBeVisible();
});

test('a reader sees the orders without the buttons', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['storefront.order.read'] });
  await start(page);
  // The Shop menu holds the orders alone; the shop's own pages need storefront.manage
  await openModule(page, 'Shop');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Catalog' })).toHaveCount(0);
  await openOrder(page, 'W-000005');
  await expect(
    page.getByText(
      /^You can view shop orders\. Ask a workspace owner for the storefront\.order\.manage/,
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View shop' })).toHaveCount(0);
});

test('a packer moves orders on without any sales permission', async ({ page }) => {
  await actAs(page, {
    name: 'Packer',
    permissions: ['storefront.order.read', 'storefront.order.manage'],
  });
  await start(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000004 shipped');
  await expect(page.getByText(/^Mark it delivered when the shopper has it\./)).toBeVisible();
});

test('picks the service the delivery charge is billed as', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop settings');
  // The first order with a charge made "Delivery charge"; the select shows it
  const select = page.getByLabel('Delivery charge’s service');
  await expect(select.locator('option:checked')).toHaveText(/^Delivery charge · /);

  // Orders bill it already: it cannot go back to empty
  await select.selectOption({ label: 'Made by the first order with a charge' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText(
      'Orders already use a delivery charge service. Pick one; it can be another service.',
    ),
  ).toBeVisible();

  // Another service is fine: the next orders bill that one
  await select.selectOption({ label: 'Logo embroidery · SVC-EMB' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes not saved yet')).toBeHidden();
  await expect(select.locator('option:checked')).toHaveText('Logo embroidery · SVC-EMB');
});

// Step 27d: the Payments card and the refund notices of the seeded online orders
// (mocks/storefront-order-data.ts → seedTries)
test('shows each online payment, the refund to make, and makes a failed receipt', async ({
  page,
}) => {
  await start(page);
  await showTab(page, 'All');
  await openOrder(page, 'W-000001');
  // How it was paid, in the shopper's card (the list's Payment column is not on a phone's card)
  await expect(page.getByText('Paid online', { exact: true })).toBeVisible();
  const payments = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Payments' }) });
  await expect(payments.getByRole('listitem')).toHaveCount(1);
  await expect(payments).toContainText('BKASH-BKash');
  await expect(payments).toContainText('BK7XQ2M4PL');
  await expect(
    page.getByText('The invoice is paid: it took the online payment’s money receipt.'),
  ).toBeVisible();
  // The timeline says the payment confirmed it, not a phone code
  await expect(page.getByText('Confirmed when the payment arrived')).toBeVisible();
  await expectNoSideScroll(page);

  // Cancelled after it was paid: the money goes back, and the link opens the refund of its receipt
  await backToList(page);
  await showTab(page, 'All');
  await openOrder(page, 'W-000002');
  await expect(payments.getByRole('listitem')).toHaveCount(2);
  await expect(payments.getByRole('listitem').first()).toContainText('Failed');
  await expect(page.getByText(/^The shopper paid ৳[\d,]+ online for this order\./)).toBeVisible();
  await page.getByRole('link', { name: 'Record refund' }).click();
  await expect(page).toHaveURL(/\/refunds\/new\?receiptId=/);

  // Paid twice: the second receipt failed, and "Make the receipt" makes it now
  await page.goto('/');
  await openFromNav(page, 'Shop orders');
  await openOrder(page, 'W-000006');
  await expect(page.getByText(/^The shopper paid online twice, ৳[\d,]+ each time\./)).toBeVisible();
  const second = payments.getByRole('listitem').nth(1);
  await expect(second.getByText(/^The money receipt could not be made\./)).toBeVisible();
  await second.getByRole('button', { name: 'Make the receipt' }).click();
  await toastShown(page, /^Money receipt .+ made$/);
  await expect(second.getByText(/^The money receipt could not be made\./)).toHaveCount(0);

  // Cash on Delivery with a paid try: the rider takes no cash
  await backToList(page);
  await showTab(page, 'All');
  await openOrder(page, 'W-000004');
  await expect(
    page.getByText(/^The shopper paid ৳[\d,]+ online too, then chose cash on delivery\./),
  ).toBeVisible();
  await expect(page.getByText('Confirmed with the phone code')).toBeVisible();
});
