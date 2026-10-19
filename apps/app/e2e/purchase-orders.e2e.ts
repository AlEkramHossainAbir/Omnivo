import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 17b in the mock garments workspace, where the signed-in person is the Owner. Orders from
// ৳50,000 with VAT need the Purchase manager (Kamal Uddin), and an Owner's own orders are approved
// when submitted (17a, decision 14). The seed:
//   PO-…-0001 1,000 gross of shirt buttons from Unitex Trims & Accessories (৳71,300 with VAT),
//             approved by Kamal, two days late, nothing received yet. Unitex reads Bangla.
//   a draft   the Owner's, 500 m of jersey from Meghna Spinning Mills, never submitted
// and 17a's PR-…-0002: 20 cartons of mailer bags, approved, not ordered yet.

const PO = (number: number) => new RegExp(`PO-\\d{4}-\\d{2}-${String(number).padStart(4, '0')}`);
const PR_2 = /PR-\d{4}-\d{2}-0002/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function openOrder(page: Page, name: RegExp) {
  await openFromNav(page, 'Purchase orders');
  await listItem(page, name).click();
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

test('lists the orders: late, waiting for goods, and a draft', async ({ page }) => {
  await openFromNav(page, 'Purchase orders');
  await expect(listItem(page, PO(1))).toContainText('Approved');
  await expect(listItem(page, PO(1))).toContainText('Late');
  await expect(listItem(page, PO(1))).toContainText('৳71,300');
  await expect(listItem(page, /Meghna Spinning Mills/)).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'To receive' }).check({ force: true });
  await expect(listItem(page, PO(1))).toBeVisible();
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

// "Make purchase order" on PR-…-0002, for Gazipur Carton Industries, with its one line
async function orderMailers(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Requisitions' }).click();
  await listItem(page, PR_2).click();
  await expect(page.getByRole('heading', { level: 1, name: PR_2 })).toBeVisible();
  await page.getByRole('button', { name: 'Make purchase order' }).click();

  // The lines still to order open at once, narrowed to this requisition (decision 45); what is
  // left is counted in the base unit, 20 cartons of 500
  let picker = page.getByRole('dialog', { name: 'Lines still to order' });
  await expect(picker.getByText('10,000 pcs left to order')).toBeVisible();
  // The supplier first, so the line starts at that supplier's price
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'New purchase order' })).toBeVisible();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('carton');
  await page.getByRole('option', { name: /Gazipur Carton Industries/ }).click();

  await page.getByRole('button', { name: 'Add lines still to order' }).click();
  picker = page.getByRole('dialog', { name: 'Lines still to order' });
  const row = picker.getByRole('listitem').filter({ hasText: 'Poly mailer bag 10x14' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

test('makes a purchase order from an approved requisition, and the requisition shows it ordered', async ({
  page,
}) => {
  await orderMailers(page);
  // Nobody bought mailers yet, so the price starts at the average cost: ৳6.50 × 500 a carton
  await expect(line(page, 1).getByLabel('Quantity')).toHaveValue('20');
  await expect(line(page, 1).getByText('From the average cost')).toBeVisible();
  await expect(line(page, 1).getByText(/^For PR-\d{4}-\d{2}-0002$/)).toBeVisible();
  // ৳65,000 + 15% VAT
  await expect(page.getByText('৳74,750.00').first()).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');

  await expect(page.getByRole('heading', { level: 1, name: 'Draft purchase order' })).toBeVisible();
  await expect(page.getByText('Purchase manager · from ৳50,000')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0002 approved$/);
  await expect(page.getByRole('heading', { level: 1, name: PO(2) })).toBeVisible();
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();

  // The order names its requisition, and the requisition its order
  await page.getByRole('link', { name: PR_2 }).click();
  await expect(page.getByRole('heading', { level: 1, name: PR_2 })).toBeVisible();
  await expect(page.getByText('Ordered', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: PO(2) })).toBeVisible();
  // An order buys for it, so it is closed, no longer cancelled or reopened (decision 27)
  await expect(page.getByRole('button', { name: 'Close requisition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel requisition' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();
  await expectNoSideScroll(page);
});

test('orders part of a requisition, then closes the rest', async ({ page }) => {
  await orderMailers(page);
  // 12 of the 20 cartons: ৳39,000 + 15% VAT, below every level
  await line(page, 1).getByLabel('Quantity').fill('12');
  await expect(page.getByText('৳44,850.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0002 approved$/);

  await page.getByRole('link', { name: PR_2 }).click();
  await expect(page.getByText('Partly ordered', { exact: true }).first()).toBeVisible();
  // The other 8 cartons will not be bought
  await page.getByRole('button', { name: 'Close requisition' }).click();
  const dialog = page.getByRole('dialog', { name: PR_2 });
  await dialog.getByRole('button', { name: 'Close requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0002 closed$/);
  await expect(page.getByText('Closed. What was not ordered will not be.')).toBeVisible();

  // Its rest is no longer offered to an order, and no other requisition for the Main store is
  // approved
  await openFromNav(page, 'Purchase orders');
  await page.getByRole('button', { name: 'New purchase order' }).click();
  await page.getByLabel('Deliver to').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Add lines still to order' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Lines still to order' })
      .getByText('Nothing is left to order for this warehouse.'),
  ).toBeVisible();
});

test('receives part of an order with a rejection, posts it, and closes the rest', async ({
  page,
}) => {
  await openOrder(page, PO(1));
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New goods receipt' })).toBeVisible();

  // The order's rest comes in by itself; more than the order allows is refused (0% in Settings)
  await expect(line(page, 1).getByLabel('Accepted')).toHaveValue('1000');
  await line(page, 1).getByLabel('Accepted').fill('1100');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await expect(line(page, 1).getByText(/^This is more than the order allows/)).toBeVisible();

  // 600 gross were good, 20 gross were cracked: a rejection says why
  await line(page, 1).getByLabel('Accepted').fill('600');
  await line(page, 1).getByLabel('Rejected').fill('20');
  await expect(line(page, 1).getByText('620 gross came', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await expect(
    line(page, 1).getByText('Say why the goods were rejected, like "wet" or "wrong shade".'),
  ).toBeVisible();
  await line(page, 1).getByLabel('Why it was rejected').fill('Cracked in transit');
  await page.getByLabel(/^Supplier’s challan/).fill('CH-UT-0788');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);

  // At the order's price: 600 of 1,000 gross worth ৳62,000 = ৳37,200, booked in the journal
  await expect(page.getByRole('heading', { level: 1, name: /GRN-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('৳37,200.00').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  await expectNoSideScroll(page);

  // The order counts it, in pieces: 600 × 144 accepted, 20 × 144 turned back
  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await expect(page.getByText('Partly received').first()).toBeVisible();
  await expect(page.getByText('86,400 pcs').first()).toBeVisible();
  await expect(page.getByText('2,880 pcs').first()).toBeVisible();
  // Goods came in, so it is closed, not reopened
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();
  await page.getByRole('button', { name: 'Close order' }).click();
  const dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Close order' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 closed$/);
  await expect(page.getByText('Closed. What did not come in was dropped.')).toBeVisible();
});

test('writes a goods receipt from its own page, keeps it a draft, and posts it later', async ({
  page,
}) => {
  await openFromNav(page, 'Goods receipts');
  // No receipt yet: the empty state offers the same button as the page header
  await expect(page.getByText('No goods receipts yet')).toBeVisible();
  await page.getByRole('button', { name: 'New goods receipt' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New goods receipt' })).toBeVisible();
  // The supplier narrows the order box to its approved orders with goods to come
  await expect(page.getByLabel('Purchase order')).toBeDisabled();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  await page.getByLabel('Purchase order').selectOption({ index: 1 });
  await expect(line(page, 1).getByLabel('Accepted')).toHaveValue('1000');
  await line(page, 1).getByLabel('Accepted').fill('400');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');
  await expect(page.getByRole('heading', { level: 1, name: 'Draft goods receipt' })).toBeVisible();

  // A draft receipt holds the order: it can no longer go back to draft
  await openOrder(page, PO(1));
  // Its receipts card lists the draft (no number yet), with its date and pill
  await expect(page.getByRole('link', { name: /^Draft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();

  await openFromNav(page, 'Goods receipts');
  await expect(listItem(page, /Unitex Trims/)).toContainText('Draft');
  await listItem(page, /Unitex Trims/).click();
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByText('৳24,800.00').first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('the over-receipt percent in Settings lets a little more in', async ({ page }) => {
  await openFromNav(page, 'Settings');
  await page.getByLabel('Receive over the order').fill('5');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Settings saved');

  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Receive goods' }).click();
  // 1,000 gross + 5%, in pieces: 1,050 × 144
  await expect(line(page, 1).getByText(/Up to 1,51,200 pcs may come/)).toBeVisible();
  await line(page, 1).getByLabel('Accepted').fill('1040');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);

  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByText('Everything on the order came in.')).toBeVisible();
  await expect(page.getByText('Received', { exact: true }).first()).toBeVisible();
});

test('reopens an approved order, changes it and submits it again, then cancels it', async ({
  page,
}) => {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Reopen' }).click();
  let dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Reopen' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 is a draft again$/);
  await expect(
    page.getByText(/^This draft keeps its number PO-\d{4}-\d{2}-0001\./).first(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  // The supplier stays: the number was given to Unitex
  await expect(page.getByRole('button', { name: 'Supplier', exact: true })).toBeDisabled();
  await line(page, 1).getByLabel('Quantity').fill('800');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 saved$/);
  // 800 × ৳62 + 15% VAT
  await expect(page.getByText('৳57,040.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 approved$/);
  // Kamal's round stays in its history
  await page.getByText('Earlier rounds').click();
  await expect(page.getByText('Round 1')).toBeVisible();
  await expect(page.getByText('Same price as the last order', { exact: false })).toBeVisible();

  // Nothing came in yet, so it can still be called off
  await page.getByRole('button', { name: 'Cancel order' }).click();
  dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 cancelled$/);
  await expect(page.getByText('Cancelled. It stays here for the record.')).toBeVisible();
  await expectNoSideScroll(page);
});

test('deletes a draft that was never submitted', async ({ page }) => {
  await openOrder(page, /Meghna Spinning Mills/);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft purchase order' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await page.getByRole('button', { name: 'Delete this draft' }).click();
  await toastShown(page, 'Draft deleted');
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

test("emails an order to its supplier in the supplier's language", async ({ page }) => {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Email', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Email PO-\d{4}-\d{2}-0001/ });
  // Unitex reads Bangla, and has no email address yet
  await expect(dialog.getByLabel('Language')).toHaveValue('bn');
  await expect(dialog.getByLabel('Subject')).toHaveValue(
    /^Rahman Garments Ltd\. থেকে পারচেজ অর্ডার PO-\d{4}-\d{2}-0001$/,
  );
  await expect(
    dialog.getByText('This supplier has no email address.', { exact: false }),
  ).toBeVisible();
  await dialog.getByLabel('To', { exact: true }).fill('orders@unitextrims.com');
  await dialog.getByRole('button', { name: 'Send email' }).click();
  await toastShown(page, 'Sending to orders@unitextrims.com');
  await expectNoSideScroll(page);
});
