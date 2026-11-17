import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  pinAnswered,
  png,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 26g: the Storefront menu on the mock (mocks/storefront-data.ts). The garments workspace has
// an open shop, Rahman Fashion: Men (Polo shirts, T-shirts), Women (empty) and Kids, two navy polo
// shirts and a T-shirt in the shop, a white polo shirt as a draft with no photo, and two kids'
// styles with no stock. The pharma workspace has no shop yet.

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

async function openListing(page: Page, name: string): Promise<void> {
  await openFromNav(page, 'Catalog');
  await listItem(page, new RegExp(name)).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('sets up a shop from nothing, fills it and opens it', async ({ page }) => {
  // Four pages and a photo the job prepares: more than the usual 30 seconds on a busy machine
  test.slow();
  await start(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  // The catalog waits for the settings
  await openFromNav(page, 'Catalog');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await page.getByRole('button', { name: 'Go to shop settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop settings' })).toBeVisible();

  // The form starts from the workspace: its slug and its name
  await expect(page.getByText(/^The shop is not set up yet\./)).toBeVisible();
  await expect(page.getByLabel('Shop address')).toHaveValue('karim-pharma');
  await expect(page.getByLabel('Shop name')).toHaveValue('Karim Pharma');
  await expect(page.getByRole('button', { name: 'Open the shop' })).toBeDisabled();
  await expectNoSideScroll(page);

  await page.getByLabel('Shop address').fill('nirvor');
  await page.getByLabel('Hotline').fill('09612-777888');
  await page.getByLabel('Address', { exact: true }).fill('Tejgaon Industrial Area, Dhaka 1208');
  await page.getByLabel('Warehouse for the shop').selectOption({ label: 'MAIN · Main store' });
  const zone = page.getByRole('group', { name: 'Zone 1' });
  await zone.getByLabel('Zone', { exact: true }).fill('Inside Dhaka');
  await zone.getByLabel('Charge').fill('80');
  await page.getByRole('button', { name: 'Set up the shop' }).click();
  // Another workspace's shop has that address: the API's answer, under the box
  await expect(page.getByText(/^Another shop has this address\./)).toBeVisible();

  await page.getByLabel('Shop address').fill('karim-pharmacy');
  await page.getByRole('button', { name: 'Set up the shop' }).click();
  await toastShown(page, 'Shop set up. Open it when the checklist is done.');
  // Two of three done: a listing in the shop is still missing
  await expect(page.getByText('Not done yet')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open the shop' })).toBeDisabled();

  await openFromNav(page, 'Shop categories');
  await expect(page.getByText('No shop categories yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add category' }).first().click();
  const categoryDialog = page.getByRole('dialog', { name: 'Add a shop category' });
  await categoryDialog.getByLabel('Name', { exact: true }).fill('Pain relief');
  // An empty link name is made from the name
  await expect(categoryDialog.getByText('/c/pain-relief')).toBeVisible();
  await categoryDialog.getByRole('button', { name: 'Add category' }).click();
  await toastShown(page, 'Pain relief added');

  await openFromNav(page, 'Catalog');
  await expect(page.getByText('Nothing in the shop yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add to shop' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Add a product to the shop' });
  await addDialog.getByRole('button', { name: 'Product', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search products' }).fill('napa');
  await page.getByRole('option', { name: /Napa 500 mg/ }).click();
  await addDialog.getByLabel('Shop category').selectOption({ label: 'Pain relief' });
  await addDialog.getByRole('button', { name: 'Add to shop' }).click();
  await toastShown(page, 'Napa 500 mg added as a draft');
  await expect(page.getByRole('heading', { level: 1, name: 'Napa 500 mg' })).toBeVisible();
  await expect(
    page.getByText('This listing is a draft, so the shop does not show it.'),
  ).toBeVisible();
  // No shop price of its own: the product's sale price
  await expect(
    page.getByText('Leave it empty to use the product’s sale price, ৳1.20.'),
  ).toBeVisible();

  // The photo: uploaded, then prepared by the job, then ready to describe
  await page.locator('input[type="file"]').setInputFiles({
    name: 'napa-strip.png',
    mimeType: 'image/png',
    buffer: png(400, 300),
  });
  const photo = page.getByRole('group', { name: 'Photo 1' });
  await expect(photo.getByRole('status')).toBeVisible();
  // Save waits for a photo that is not ready
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expect(photo.getByText('On the shop’s card')).toBeVisible({ timeout: 10_000 });
  await photo.getByLabel('What the photo shows').fill('Napa 500 mg, a strip of 10 tablets');
  // The publish button waits for the form: the server publishes what is saved
  await expect(page.getByRole('button', { name: 'Show in the shop' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to Napa 500 mg saved');

  await page.getByRole('button', { name: 'Show in the shop' }).click();
  await toastShown(page, 'Napa 500 mg is in the shop');
  await expect(page.getByText('In the shop', { exact: true }).first()).toBeVisible();

  await openFromNav(page, 'Shop settings');
  await expect(page.getByText('Not done yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the shop' }).click();
  const openDialog = page.getByRole('dialog', { name: 'Open Karim Pharma?' });
  await expect(
    openDialog.getByText(/^http:\/\/karim-pharmacy\.localhost:4321 starts/),
  ).toBeVisible();
  await openDialog.getByRole('button', { name: 'Open the shop' }).click();
  await toastShown(page, 'Karim Pharma is open');
  await expect(page.getByRole('heading', { name: 'The shop is open' })).toBeVisible();
  await expect(page.getByText(/at http:\/\/karim-pharmacy\.localhost:4321$/)).toBeVisible();
});

test('finds listings by name, status and category', async ({ page, context }) => {
  await start(page);
  await openFromNav(page, 'Catalog');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByLabel('Search the catalog').fill('polo');
  await expect(listItem(page, /Pique polo shirt/)).toHaveCount(3);
  await page.getByText('Drafts', { exact: true }).click();
  await expect(listItem(page, /Pique polo shirt/)).toHaveCount(1);
  await expect(listItem(page, /White · M/)).toContainText('Draft');

  await page.getByLabel('Search the catalog').fill('');
  await page.getByText('All', { exact: true }).click();
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Kids' });
  await expect(listItem(page, /Kids/)).toHaveCount(2);
  await expect(listItem(page, /Kids trouser 20003/)).toContainText('Out of stock');

  await page.getByLabel('Search the catalog').fill('panjabi');
  await expect(page.getByText('No listing matches')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the filters' }).click();
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();

  // A product already in the shop is not offered again
  await page.getByRole('button', { name: 'Add to shop' }).click();
  await page
    .getByRole('dialog', { name: 'Add a product to the shop' })
    .getByRole('button', { name: 'Product', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Search products' }).fill('basic crew');
  await expect(page.getByText(/^No product to add matches\./)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Online only
  await context.setOffline(true);
  await expect(page.getByText(/^The shop’s menu works on the server\./)).toBeVisible();
  await context.setOffline(false);
});

test('prices a listing, checks its sale and publishes only what is saved', async ({ page }) => {
  await start(page);
  await openListing(page, 'Basic crew-neck T-shirt');
  await expectNoSideScroll(page);
  // The card beside the form: what a shopper pays with the form as it is now
  const preview = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'In the shop now' }) });

  await page.getByLabel('Sale', { exact: true }).selectOption({ label: 'Percent off' });
  await page.getByLabel('Percent off (1 to 99)').fill('10');
  await expect(preview).toContainText('৳269.10');
  await expect(preview.locator('s')).toHaveText('৳299');
  await expect(preview).toContainText('10% OFF');
  // A change waits for its save before the listing can leave the shop
  await expect(page.getByRole('button', { name: 'Take out of the shop' })).toBeDisabled();
  await expect(page.getByText('Save your changes first, then show it in the shop.')).toBeVisible();

  // ৳400 off ৳299 takes off everything: the API refuses it on the box
  await page.getByLabel('Sale', { exact: true }).selectOption({ label: 'Taka off' });
  await page.getByLabel('Amount off').fill('400');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText('The sale must take something off the regular price. Lower it.'),
  ).toBeVisible();

  await page.getByLabel('Amount off').fill('50');
  // Another listing's link name
  await page.getByLabel('Link name').fill('pique-polo-navy-m');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/^Something else in the shop has this link name\./)).toBeVisible();

  await page.getByLabel('Link name').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to Basic crew-neck T-shirt saved');
  await expect(preview).toContainText('৳249');
  await expect(preview).toContainText('৳50 OFF');

  await page.getByRole('button', { name: 'Take out of the shop' }).click();
  await toastShown(page, 'Basic crew-neck T-shirt is a draft again');
  await expect(
    page.getByText('This listing is a draft, so the shop does not show it.'),
  ).toBeVisible();
});

test('refuses a photo the shop cannot use, and a listing with no photo', async ({ page }) => {
  await start(page);
  await openListing(page, 'Pique polo shirt · White · M');
  await expect(
    page.getByText('No photo yet. The shop shows a listing only with at least one photo.'),
  ).toBeVisible();

  // Not a photo at all: refused before anything is sent
  const file = page.locator('input[type="file"]');
  await file.setInputFiles({
    name: 'size-chart.pdf',
    mimeType: 'application/pdf',
    buffer: png(1, 1),
  });
  await expect(page.getByRole('group', { name: 'Photo 1' })).toHaveCount(0);

  // A photo the job finds too small: its error in the slot, and a way to remove it
  await file.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png(120, 120) });
  const photo = page.getByRole('group', { name: 'Photo 1' });
  await expect(photo.getByText(/^This photo is too small\./)).toBeVisible({ timeout: 10_000 });
  await photo.getByRole('button', { name: 'Remove it' }).click();
  await expect(photo).toHaveCount(0);

  // A draft with no photo cannot go into the shop
  await page.getByRole('button', { name: 'Show in the shop' }).click();
  await expect(page.getByText('Add at least one photo, then show it in the shop.')).toBeVisible();
});

test('keeps the shop categories in order and deletes only empty ones', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop categories');
  await expectNoSideScroll(page);
  const tree = page.getByRole('list', { name: 'Shop categories' });
  const topLevel = tree.locator(':scope > li');
  await expect(topLevel).toHaveText([/^Men/, /^Women/, /^Kids/]);

  await page.getByRole('button', { name: 'Move Kids up' }).click();
  await expect(topLevel).toHaveText([/^Men/, /^Kids/, /^Women/]);
  // Last among its siblings now
  await expect(page.getByRole('button', { name: 'Move Women down' })).toBeDisabled();

  // Kids holds listings, Men holds categories: both stay
  await page.getByRole('button', { name: 'Actions for Kids' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const kids = page.getByRole('dialog', { name: 'Delete Kids?' });
  await kids.getByRole('button', { name: 'Delete' }).click();
  await expect(kids.getByText(/^Listings are in this category\./)).toBeVisible();
  await kids.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Actions for Women' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Women?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await toastShown(page, 'Women deleted');
  await expect(topLevel).toHaveText([/^Men/, /^Kids/]);

  // A new one inside Men, last in its list. Every group starts open
  await page.getByRole('button', { name: 'Add a category to Men' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a shop category' });
  await expect(dialog.getByLabel('Inside')).toHaveValue(/.+/);
  await dialog.getByLabel('Name', { exact: true }).fill('Panjabi');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await toastShown(page, 'Panjabi added');
  await expect(tree.getByRole('button', { name: 'Panjabi', exact: true })).toBeVisible();
});

test('warns before an open shop moves to a new address', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop settings');
  await expect(page.getByRole('heading', { name: 'The shop is open' })).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByLabel('Shop address').fill('rahman-outlet');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the shop’s address?' });
  await expect(dialog.getByText(/^rahman-fashion\.localhost stops working/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Change the address' }).click();
  await toastShown(page, 'Shop settings saved');
  await expect(page.getByText(/at http:\/\/rahman-outlet\.localhost:4321$/)).toBeVisible();
});

test('hides the Storefront menu from a role without storefront.manage', async ({ page }) => {
  await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
  await start(page);
  await pinAnswered(page);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Shop settings' }),
  ).toHaveCount(0);
});
