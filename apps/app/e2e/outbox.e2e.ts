import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 18b: work saved on the device without a connection, and sent when it is back. The mock
// runs the commands with the API's rules (src/mocks/push-data.ts). The garments workspace has five
// customers, C-00001 to C-00005, so a customer added here gets C-00006. Offline is
// context.setOffline, and pages change through the nav, as in sync.e2e.ts.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForCopy(page);
});

// The sidebar line (desktop) or the top bar's (phone): the whole sentence is its name
function syncLink(page: Page, name: string) {
  return page
    .getByRole('navigation')
    .getByRole('link', { name: `Sync: ${name}`, exact: true })
    .filter({ visible: true });
}

// One change on the Sync page, by its first line
function change(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title });
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// A new customer with one billing address, saved on the device
async function addCustomerOffline(page: Page, name: string, code?: string) {
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New customer' })).toBeVisible();
  await expect(
    page.getByText("You're offline. This is saved on this device and sent when the connection"),
  ).toBeVisible();
  // The number is given by the server, when the customer arrives
  await expect(
    page.getByText('Leave empty for the next number. It is given when the customer syncs.'),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (code !== undefined) await page.getByLabel(/^Code/).fill(code);
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page
    .getByRole('group', { name: 'Address 1' })
    .getByLabel('Address', { exact: true })
    .fill('Zindabazar, Sylhet 3100');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
}

// A draft order for that customer, from the main store, with ten T-shirts at the product's price
async function addOrderOffline(page: Page, customer: string) {
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales order' })).toBeVisible();
  await expect(page.getByText('The order is saved on this device as a draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(customer.slice(0, 6));
  await page.getByRole('option', { name: new RegExp(customer) }).click();
  // What the customer owes is the server's (decision 10)
  await expect(page.getByText('Credit left needs a connection.')).toBeVisible();
  await page.getByLabel('Send from').selectOption({ label: 'MAIN · Main store' });

  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The price comes from the device's copy, by the same rule as the server's (decision 9)
  await expect(line(page, 1).getByText('Product price')).toBeVisible();
  await expect(line(page, 1).getByLabel(/^Price/)).toHaveValue('320.00');
  await line(page, 1).getByLabel('Quantity').fill('10');

  // A draft only: confirming needs the server's credit check
  await expect(page.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(page.getByRole('heading', { level: 1, name: 'Sales orders' })).toBeVisible();
}

test('a customer and an order saved offline reach the server when the connection is back', async ({
  page,
  context,
}) => {
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
  await context.setOffline(true);
  await expect(syncLink(page, 'Offline, All changes synced')).toBeVisible();

  await addCustomerOffline(page, 'Sylhet Tea Traders');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Not synced');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('No number yet');
  await expect(syncLink(page, 'Offline, 1 change waiting')).toBeVisible();

  await addOrderOffline(page, 'Sylhet Tea Traders');
  // Above the server's list, which needs the connection
  const unsynced = page
    .getByRole('table', { name: 'On this device · not synced' })
    .or(page.getByRole('list', { name: 'On this device · not synced' }));
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Not synced');
  await expect(unsynced).toBeVisible();
  await expect(page.getByText('The orders on the server need a connection.')).toBeVisible();
  await expect(syncLink(page, 'Offline, 2 changes waiting')).toBeVisible();
  await expectNoSideScroll(page);

  await openFromNav(page, 'Sync');
  await expect(page.getByText('Connect to the internet to sync.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await expect(change(page, 'New customer Sylhet Tea Traders')).toContainText('Waiting');
  // The order needs the customer first (decision 13)
  await expect(change(page, 'Draft order for Sylhet Tea Traders')).toContainText(
    'Waits for Sylhet Tea Traders to sync first',
  );
  await expect(change(page, 'Draft order for Sylhet Tea Traders')).toContainText('1 line · ৳3,680');
  await expectNoSideScroll(page);

  // Back online: the customer goes, then the order that waited for it, in one sync
  await context.setOffline(false);
  await toastShown(page, '2 changes synced');
  await expect(page.getByText('Everything is synced')).toBeVisible();
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();

  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('C-00006');
  await expect(listItem(page, /Sylhet Tea Traders/)).not.toContainText('Not synced');
  await openFromNav(page, 'Sales orders');
  await expect(unsynced).toHaveCount(0);
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Draft');

  // The audit log names the device the change came from
  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /Added a customer/).first()).toContainText(/· from /);
});

test('a refused change waits on the Sync page until it is fixed', async ({ page, context }) => {
  await context.setOffline(true);
  // H&M's code: the device cannot know it is taken
  await addCustomerOffline(page, 'Moulvibazar Garments', 'C-00001');
  await addOrderOffline(page, 'Moulvibazar Garments');

  await context.setOffline(false);
  await toastShown(page, 'Some changes need attention. Open Sync to fix them.');
  await expect(syncLink(page, 'Online, 1 change needs attention')).toBeVisible();
  await openFromNav(page, 'Sync');
  const customer = change(page, 'New customer Moulvibazar Garments');
  await expect(customer).toContainText('Needs attention');
  await expect(customer).toContainText('Another customer has this code.');
  // The order is not refused: it waits for its customer
  await expect(change(page, 'Draft order for Moulvibazar Garments')).toContainText(
    'Waits for Moulvibazar Garments to sync first',
  );

  // Discard says that the order goes with it; not now
  await customer.getByRole('button', { name: 'Discard' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard this change?' });
  await expect(dialog).toContainText('The 1 change that needs it is discarded too.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Edit opens the form with the refusal under the box. Online, a customer with a change on the
  // device is still saved on the device, after it (decision 2).
  await customer.getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByText('Another customer has this code.')).toBeVisible();
  await page.getByLabel(/^Code/).fill('');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, '2 changes synced');
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Moulvibazar Garments/)).toContainText('C-00006');
});

test('discarding a new customer discards the order that needs it', async ({ page, context }) => {
  await context.setOffline(true);
  await addCustomerOffline(page, 'Habiganj Knit Ltd.');
  await addOrderOffline(page, 'Habiganj Knit Ltd.');

  await openFromNav(page, 'Sync');
  await change(page, 'New customer Habiganj Knit Ltd.')
    .getByRole('button', { name: 'Discard' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Discard this change?' });
  await dialog.getByRole('button', { name: 'Discard change' }).click();
  await toastShown(page, 'Change discarded');
  await expect(page.getByText('Everything is synced')).toBeVisible();
  await expect(syncLink(page, 'Offline, All changes synced')).toBeVisible();

  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Habiganj Knit/)).toHaveCount(0);
});

test('a change to a customer made offline syncs, field by field', async ({ page, context }) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /Aarong/).click();
  await expect(page.getByRole('heading', { level: 1, name: /Aarong/ })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Edit C-/ })).toBeVisible();

  // The form opens again from the device's copy
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save on this device' })).toBeVisible();
  await page.getByLabel('Phone (optional)', { exact: true }).fill('+880 1711-202020');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(listItem(page, /Aarong/)).toContainText('Not synced');

  await openFromNav(page, 'Sync');
  await expect(change(page, 'Changes to Aarong')).toContainText('Changed: Phone');

  await context.setOffline(false);
  await toastShown(page, '1 change synced');
  await openFromNav(page, 'Customers');
  await listItem(page, /Aarong/).click();
  await expect(page.getByText('+880 1711-202020').first()).toBeVisible();
});

test('signing out with changes on the device asks first', async ({ page, context }) => {
  await context.setOffline(true);
  await addCustomerOffline(page, 'Sunamganj Traders');

  const signOut = async () => {
    await page
      .getByRole('button', { name: /Farhana Rahman/ })
      .or(page.getByRole('button', { name: 'Account' }))
      .filter({ visible: true })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
  };
  await signOut();
  const dialog = page.getByRole('dialog', { name: 'Sign out and lose the changes?' });
  await expect(dialog).toContainText(
    '1 change on this device has not synced. Signing out removes it for good.',
  );
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toBeHidden();
  await expect(listItem(page, /Sunamganj Traders/)).toBeVisible();

  await signOut();
  await dialog.getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
