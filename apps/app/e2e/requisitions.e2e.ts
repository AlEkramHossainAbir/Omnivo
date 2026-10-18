import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 17a in the mock garments workspace, where the signed-in person is the Owner. Requisitions
// from ৳20,000 need the Purchase manager (Kamal Uddin), from ৳1,00,000 a Director as well, a role
// nobody holds. Sadia Islam wrote three:
//   PR-…-0001 two sewing machines: Kamal sent it back, so it is a draft with a comment
//   PR-…-0002 mailer bags: approved by Kamal
//   PR-…-0003 jersey and buttons, ৳2,11,240: Kamal approved step 1; step 2 (Director) waits, and
//             the bell told the Owner
// and the Owner's own PR-…-0004 (buttons, ৳1,944) was never submitted. An Owner may decide any
// step, and the Owner's own requisitions are approved when submitted (decision 14).

const PR = (number: number) => new RegExp(`PR-\\d{4}-\\d{2}-${String(number).padStart(4, '0')}`);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav item says "Requisitions"; the page's title is the longer "Purchase requisitions"
async function openRequisitions(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Requisitions' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Purchase requisitions' }),
  ).toBeVisible();
}

async function openRequisition(page: Page, number: number) {
  await openRequisitions(page);
  await listItem(page, PR(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: PR(number) })).toBeVisible();
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

test('lists the requisitions with their status', async ({ page }) => {
  await openRequisitions(page);
  await expect(listItem(page, PR(3))).toContainText('Waiting for approval');
  await expect(listItem(page, PR(3))).toContainText('৳2,11,240');
  await expect(listItem(page, PR(2))).toContainText('Approved');
  await expect(listItem(page, PR(1))).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Approved' }).check({ force: true });
  await expect(listItem(page, PR(2))).toBeVisible();
  await expect(listItem(page, PR(3))).toHaveCount(0);
});

test('approves the requisition waiting for the Owner, from the Approvals list', async ({
  page,
}) => {
  await openFromNav(page, 'Approvals');
  await expect(listItem(page, PR(3))).toContainText('Main store');
  await expect(listItem(page, PR(3))).toContainText('2 of 2');
  await expectNoSideScroll(page);
  // Approve is on the requisition's page only (decision 44): the list takes the person there
  await listItem(page, PR(3)).click();
  await expect(page.getByRole('heading', { level: 1, name: PR(3) })).toBeVisible();
  await expect(page.getByText('Kamal Uddin', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: PR(3) });
  await expect(dialog.getByText('You approve step 2 of 2, as Director.')).toBeVisible();
  await expect(dialog.getByText(/^This is the last step/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await toastShown(page, /^Your approval of PR-\d{4}-\d{2}-0003 is saved$/);
  await expect(page.getByText(/^Approved and locked/)).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeHidden();

  // Nothing waits any more
  await openFromNav(page, 'Approvals');
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
});

test('sends a requisition back with a comment, then changes it and submits it again', async ({
  page,
}) => {
  await openRequisition(page, 3);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: PR(3) });
  // A rejection says why (decision 15): the form's own check
  await dialog.getByRole('button', { name: 'Send back to draft' }).click();
  await expect(dialog.getByText('Say what should change, at least 2 characters.')).toBeVisible();
  await dialog.getByLabel('What should change').fill('Order 300 metres: the October plan changed.');
  await dialog.getByRole('button', { name: 'Send back to draft' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 sent back to draft$/);

  // A warn notice with the comment: the writer has to act
  await expect(
    page.getByText(
      'Farhana Rahman sent it back: "Order 300 metres: the October plan changed." Change it and submit it again.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await line(page, 1).getByLabel('Quantity').fill('300');
  await page.getByRole('button', { name: 'Save requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 saved$/);
  // 300 m × ৳520 + the buttons' ৳3,240
  await expect(page.getByText('৳1,59,240.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 approved$/);
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();
  // The two rounds before it stay in its history (decision 25)
  await page.getByText('Earlier rounds').click();
  await expect(page.getByText('Round 1')).toBeVisible();
  await expectNoSideScroll(page);
});

test('writes a requisition at the average cost, and the Owner submits it', async ({ page }) => {
  await openRequisitions(page);
  await page.getByRole('button', { name: 'New requisition' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New purchase requisition' }),
  ).toBeVisible();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await page.getByLabel(/^Note/).fill('Fabric for the Primark basic tee, 3,000 pieces');

  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: 'Search products and services' }).fill('jersey');
  const row = picker.getByRole('listitem').filter({ hasText: 'Single jersey 180 GSM' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The line comes in the jersey's buying unit, the yard, at the company-wide average cost
  // (decision 20): ৳520 a metre × 0.9144 = ৳475.488 a yard, with the 4 decimals a cost keeps
  await expect(line(page, 1).getByLabel('Cost per yard')).toHaveValue('475.4880');
  await expect(line(page, 1).getByText('From the average cost')).toBeVisible();
  await line(page, 1).getByLabel('Quantity').fill('250');
  await expect(page.getByText('৳1,18,872.00').first()).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0005 saved$/);

  // A draft lists the levels its amount reaches now (decision 44)
  await expect(page.getByRole('heading', { level: 1, name: PR(5) })).toBeVisible();
  await expect(page.getByText('Purchase manager · from ৳20,000')).toBeVisible();
  await expect(page.getByText('Director · from ৳1,00,000')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0005 approved$/);
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();
});

test('cancels an approved requisition, reopens a waiting one, and deletes a draft', async ({
  page,
}) => {
  await openRequisition(page, 2);
  await page.getByRole('button', { name: 'Cancel requisition' }).click();
  let dialog = page.getByRole('dialog', { name: PR(2) });
  await dialog.getByRole('button', { name: 'Cancel requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0002 cancelled$/);
  await expect(page.getByText('Cancelled. It stays here for the record.')).toBeVisible();

  await openRequisition(page, 3);
  await page.getByRole('button', { name: 'Reopen' }).click();
  dialog = page.getByRole('dialog', { name: PR(3) });
  await dialog.getByRole('button', { name: 'Reopen' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 is a draft again$/);
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();

  // Sent back once, so its history stays: it can only be cancelled
  await openRequisition(page, 1);
  await expect(page.getByRole('button', { name: 'Cancel requisition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete requisition' })).toBeHidden();

  // Never submitted: two clicks delete it
  await openRequisition(page, 4);
  await page.getByRole('button', { name: 'Delete requisition' }).click();
  await page.getByRole('button', { name: /^Delete PR-/ }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0004 deleted$/);
  await expect(listItem(page, PR(4))).toHaveCount(0);
});

test('opens the waiting requisition from the bell', async ({ page }) => {
  await page.getByRole('button', { name: 'Notifications, 3 unread' }).click();
  const panel = page.getByRole('dialog');
  await panel
    .getByRole('button', { name: /Requisition PR-\d{4}-\d{2}-0003 is waiting for your approval/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: PR(3) })).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeVisible();
});

test('changes the approval levels, in order of amount', async ({ page }) => {
  await openFromNav(page, 'Approval levels');
  const card = page.getByRole('form', { name: 'Purchase requisitions' });
  const level = (number: number) => card.getByRole('group', { name: `Level ${String(number)}` });
  await expect(level(1).getByLabel('Role')).toHaveValue(/.+/);

  // A new level starts at the amount of the one above it (৳1,00,000)
  await card.getByRole('button', { name: 'Add a level' }).click();
  await level(3).getByLabel('Role').selectOption({ label: 'Accountant' });
  // fill() selects what the box holds and types over it. On focus the grouped "1,00,000" becomes the
  // plain digits, and the box selects them again; without that the new digits would join the old ones
  const from = level(3).getByLabel('From amount');
  await from.fill('50000');
  await card.getByRole('button', { name: 'Save levels' }).click();
  // Each level starts at the amount of the one above it, or higher (decision 13)
  await expect(
    level(3).getByText('Start this level at the amount of the level above it, or higher.'),
  ).toBeVisible();
  // A person tabs into the box (the browser selects all of it) and types the new amount
  await level(3).getByLabel('Role').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(from).toBeFocused();
  await page.keyboard.type('500000');
  await expect(from).toHaveValue('500000');
  await card.getByRole('button', { name: 'Save levels' }).click();
  await toastShown(page, 'Purchase requisitions: levels saved');
  await expectNoSideScroll(page);

  // A role a level uses cannot be deleted, even though nobody holds it (17a.3)
  await openFromNav(page, 'Roles');
  await page.getByRole('button', { name: 'Edit Director' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Director' });
  await dialog.getByRole('button', { name: 'Delete role' }).click();
  await dialog.getByRole('button', { name: 'Delete Director' }).click();
  await expect(dialog.getByText(/an approval level uses it/)).toBeVisible();
});
