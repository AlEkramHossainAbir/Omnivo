import { syncPullSchema } from '@omnivo/contracts';
import type { Page } from '@playwright/test';

import { OWNER } from '../src/mocks/fixtures.js';
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

// Step 18c: the device lists, rename, branch change, revoke and the time limits. The garments
// workspace has four devices besides this browser (src/mocks/sync-data.ts → seedDevices): the
// owner's Home laptop, Abdul Karim's Store office PC (3 days behind), Kamal Uddin's phone (never
// synced), all in the head office, and Nasrin Karim's Depot counter 1, revoked. This browser is
// the head office's device of the fixture in helpers.ts; its name comes from the browser ("Chrome
// on Linux"), so the tests find its row by the "This device" pill. The device lists have no row
// click, so a row is a readOnlyItem: a table row on a desktop, a list item on a phone.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The first pull registers this browser as a device: before that, it is in no list. A helper, not
// a beforeEach: the limits test installs Playwright's clock first, and timers made before the
// install would keep the real clock.
async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

async function openMyDevices(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'My devices' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My devices' })).toBeVisible();
}

// A row's menu, by the device's name ("Actions for Home laptop"), or this device's
async function openMenu(page: Page, name: string | null): Promise<void> {
  const row = readOnlyItem(page, name ?? /This device/);
  await row
    .getByRole('button', { name: name === null ? /^Actions for / : `Actions for ${name}` })
    .click();
}

// The sidebar line (desktop) or the top bar's (phone), as in outbox.e2e.ts
function syncLink(page: Page, name: string) {
  return page
    .getByRole('navigation')
    .getByRole('link', { name: `Sync: ${name}`, exact: true })
    .filter({ visible: true });
}

// The local databases of this browser profile, as in sync.e2e.ts
function localDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name ?? '')
      .filter((name) => name.startsWith('omnivo-')),
  );
}

// The last page of a full pull: the copy of a new branch is complete. Started before the click
// that causes it, so a fast answer is not missed.
function fullCopy(page: Page) {
  return page.waitForResponse(
    async (response) => {
      if (!response.url().includes('/sync/pull') || !response.ok()) return false;
      const parsed = syncPullSchema
        .pick({ full: true, hasMore: true })
        .safeParse(await response.json());
      return parsed.success && parsed.data.full && !parsed.data.hasMore;
    },
    { timeout: 25_000 },
  );
}

test('lists your own devices, renames this one and revokes another', async ({ page }) => {
  await start(page);
  await openMyDevices(page);
  const here = readOnlyItem(page, /This device/);
  await expect(here).toContainText('Head office');
  await expect(here).toContainText('Active');
  await expect(readOnlyItem(page, /Home laptop/)).toBeVisible();
  // Other people's devices are in Settings → Devices, not here
  await expect(readOnlyItem(page, /Store office PC/)).toHaveCount(0);

  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: /^Rename / });
  await rename.getByLabel('Name').fill('x');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await expect(rename.getByText('Give this device a name, like Counter 1.')).toBeVisible();
  await rename.getByLabel('Name').fill('Cutting floor PC');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await toastShown(page, 'Renamed to Cutting floor PC');
  await expect(here).toContainText('Cutting floor PC');

  await openMenu(page, 'Home laptop');
  // Only this device changes its branch, from itself (decision 2)
  await expect(page.getByRole('menuitem', { name: 'Change branch' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke Home laptop?' });
  await expect(revoke).toContainText('It stops syncing and is signed out at once.');
  await expect(revoke).toContainText('A revoked device cannot be restored.');
  await revoke.getByRole('button', { name: 'Revoke device' }).click();
  await toastShown(page, 'Home laptop revoked');
  // It stays in the list for the audit, with who revoked it, and nothing left to do with it
  const laptop = readOnlyItem(page, /Home laptop/);
  await expect(laptop).toContainText('Revoked by Farhana Rahman');
  await expect(laptop.getByRole('button', { name: 'Actions for Home laptop' })).toHaveCount(0);
  // The laptop had a sign-in of its own: this browser is still signed in
  await expect(here).toContainText('Active');
  await expectNoSideScroll(page);

  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /Revoked a device/).first()).toBeVisible();
  await expect(readOnlyItem(page, /Renamed a device/).first()).toBeVisible();
});

test('revoking this device signs you out, and the next sign-in makes a new device', async ({
  page,
}) => {
  await start(page);
  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  const dialog = page.getByRole('dialog', { name: /^Revoke / });
  await expect(dialog).toContainText(
    'You are signed out here, and the copy of the data on this device is deleted.',
  );
  await dialog.getByRole('button', { name: 'Revoke device' }).click();

  // The revoke ended this browser's sign-in (decision 3): the copy goes, then the sign-in page
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(
    page.getByText('This device was revoked, so its data was deleted and you were signed out.'),
  ).toBeVisible();
  await expect.poll(() => localDatabases(page)).toEqual([]);

  await page.getByLabel('Workspace', { exact: true }).fill('rahman-garments');
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill('Konabari-cut-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // A new device, with a new id: the branch is asked again (decision 4)
  const branch = page.getByRole('dialog', { name: 'Which branch is this device in?' });
  await branch.getByLabel('Branch').selectOption({ label: 'GZP · Gazipur factory' });
  await branch.getByRole('button', { name: 'Use this branch' }).click();
  await toastShown(page, 'This device is set up for Gazipur factory');

  await openMyDevices(page);
  await expect(readOnlyItem(page, /This device/)).toContainText('Gazipur factory');
  // The old one stays as it was, revoked
  await expect(readOnlyItem(page, /Revoked by Farhana Rahman/)).toContainText('Head office');
  await expect(readOnlyItem(page, /Revoked by Farhana Rahman/)).not.toContainText('This device');
});

test("every device of the workspace: search, branch, tabs, and revoking someone else's", async ({
  page,
}) => {
  await start(page);
  await openFromNav(page, 'Devices');
  const store = readOnlyItem(page, /Store office PC/);
  await expect(store).toContainText('Abdul Karim');
  // Three days behind: the warn pill in Active's place (decision 12)
  await expect(store).toContainText('Not synced for 3 days');
  await expect(readOnlyItem(page, /Kamal's phone/)).toContainText('Never synced');
  await expect(readOnlyItem(page, /This device/)).toContainText('Farhana Rahman');
  // Revoked ones have their own tab
  await expect(readOnlyItem(page, /Depot counter 1/)).toHaveCount(0);

  // By the device's name or the person's
  const search = page.getByRole('searchbox', { name: 'Search devices' });
  await search.fill('abdul');
  await expect(store).toBeVisible();
  await expect(readOnlyItem(page, /Kamal's phone/)).toHaveCount(0);
  await search.fill('tablet');
  await expect(page.getByText('No device matches "tablet"')).toBeVisible();
  await search.fill('');

  await page.getByText('Revoked', { exact: true }).click();
  const depot = readOnlyItem(page, /Depot counter 1/);
  await expect(depot).toContainText('Nasrin Karim');
  await expect(depot).toContainText('Revoked by Farhana Rahman');
  const branch = page.getByLabel('Branch', { exact: true });
  await branch.selectOption({ label: 'Head office' });
  await expect(page.getByText('No revoked devices')).toBeVisible();
  await branch.selectOption({ label: 'Chattogram depot' });
  await expect(depot).toBeVisible();
  await branch.selectOption({ label: 'All branches' });
  await page.getByText('Active', { exact: true }).click();

  // Someone else's device, with core.device.manage (the mock's owner has every permission)
  await openMenu(page, 'Store office PC');
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke Store office PC?' })
    .getByRole('button', { name: 'Revoke device' })
    .click();
  await toastShown(page, 'Store office PC revoked');
  await expect(store).toHaveCount(0);
  await page.getByText('Revoked', { exact: true }).click();
  await expect(store).toContainText('Revoked by Farhana Rahman');
  await expectNoSideScroll(page);
});

test('sorts by the last sync, the devices that never synced first', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A phone shows the devices as cards, with no column to sort by');
  await start(page);
  await openFromNav(page, 'Devices');
  const sort = page.getByRole('button', { name: 'Sort by Last synced' });
  const rows = page.getByRole('row');
  await sort.click();
  // Row 0 is the header
  await expect(rows.nth(1)).toContainText("Kamal's phone");
  await expect(rows.nth(2)).toContainText('Store office PC');
  await expect(rows.nth(3)).toContainText('Home laptop');
  await expect(rows.nth(4)).toContainText('This device');
  await sort.click();
  await expect(rows.nth(1)).toContainText('This device');
  await expect(rows.nth(4)).toContainText("Kamal's phone");
});

test('a branch with active devices is not archived', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Branches');
  await listItem(page, /Head office/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit HO' });
  await dialog.getByRole('button', { name: 'Archive' }).click();
  // This browser, the Home laptop, the Store office PC and Kamal's phone (decision 20)
  await expect(dialog.getByRole('alert')).toHaveText(/Active devices in this branch: 4\./);
});

test('changing the branch waits for the outbox, then copies the new branch', async ({
  page,
  context,
}) => {
  await start(page);
  // A change the server refused stays on the device until it is fixed or discarded: H&M's code
  await context.setOffline(true);
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Comilla Fabrics');
  await page.getByLabel(/^Code/).fill('C-00001');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await context.setOffline(false);
  await toastShown(page, 'Some changes need attention. Open Sync to fix them.');

  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Change branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the branch of this device' });
  await expect(dialog).toContainText('Omnivo deletes the copy of Head office on this device');
  await expect(dialog).toContainText('Sync the 1 change on this device first.');
  await expect(dialog.getByRole('button', { name: 'Change branch' })).toBeDisabled();
  await dialog.getByRole('link', { name: 'Sync' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'New customer Comilla Fabrics' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await page
    .getByRole('dialog', { name: 'Discard this change?' })
    .getByRole('button', { name: 'Discard change' })
    .click();
  await toastShown(page, 'Change discarded');

  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Change branch' }).click();
  // The connection drops with the dialog open: the server must answer the move
  await context.setOffline(true);
  await expect(dialog).toContainText('Connect to the internet to change the branch.');
  await context.setOffline(false);
  // Its own branch is not a choice: moving there would change nothing
  const select = dialog.getByLabel('New branch');
  await expect(select.getByRole('option')).toHaveText([
    'Pick a branch',
    'CTG · Chattogram depot',
    'GZP · Gazipur factory',
  ]);
  await select.selectOption({ label: 'CTG · Chattogram depot' });
  const copied = fullCopy(page);
  await dialog.getByRole('button', { name: 'Change branch' }).click();
  await toastShown(page, 'This device is now set up for Chattogram depot');
  await expect(readOnlyItem(page, /This device/)).toContainText('Chattogram depot');
  await copied;

  // The copy is the depot's now: an order saved offline is sent from its warehouse only
  await context.setOffline(true);
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByLabel('Send from').getByRole('option')).toContainText([
    'CTG · Chattogram depot',
  ]);
  await expect(page.getByLabel('Send from').getByRole('option')).not.toContainText([
    'MAIN · Main store',
  ]);
});

test('warns a day after the last sync, and saves nothing new offline after seven', async ({
  page,
  context,
}) => {
  // Playwright's clock: the app's Date, timers and intervals move when the test says. Until then
  // it runs at the real pace, so the first copy is made as usual.
  await page.clock.install();
  await start(page);
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
  // Offline, the engine cannot pull, so the last sync stays where it was
  await context.setOffline(true);
  await page.clock.fastForward(25 * HOUR_MS);
  await expect(syncLink(page, 'Offline, Last synced 1 day ago, All changes synced')).toBeVisible();
  await openFromNav(page, 'Sync');
  await expect(
    page.getByText('Prices, stock and credit limits on this device may be out of date.'),
  ).toBeVisible();

  await page.clock.fastForward(6 * DAY_MS);
  await expect(syncLink(page, 'Offline, Last synced 7 days ago, All changes synced')).toBeVisible();
  await expect(
    page.getByText("This device last synced more than 7 days ago, so it can't save new work"),
  ).toBeVisible();
  // The two forms that save on the device say why, with no button to save
  const blocked = page.getByText('Connect to the internet to save this.');
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(blocked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save on this device' })).toHaveCount(0);
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(blocked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save on this device' })).toHaveCount(0);
  await expectNoSideScroll(page);

  // Back online: a pull, and the limits are gone
  await context.setOffline(false);
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
});
