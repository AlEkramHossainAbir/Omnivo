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

// Step 26h: Shop appearance and Shop pages on the mock (mocks/storefront-appearance-data.ts).
// Rahman Fashion has a drawn logo and the default colors, an Eid hero that links to Polo shirts,
// and under the product grid: Hot & Trending Right Now (three listings, all in the shop), the
// winter sale picture banner, For the kids (two listings) and Coming soon (only the draft, so the
// shop hides it). Terms & Condition and About Us are written. Karim Pharma has no shop.

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

// The Home page card's rows, top to bottom, by their first line
function homeRows(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Home page' }) })
    .getByRole('listitem');
}

test('keeps the two colors readable together and saves them', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await expectNoSideScroll(page);
  await expect(page.getByRole('img', { name: 'Rahman Fashion logo' })).toBeVisible();
  await expect(page.getByText('4 of 12 blocks')).toBeVisible();

  // A light brand color: names on cream would be hard to read, and the accent is too close to it.
  // The lines say so as it is typed, and the save is refused on both boxes
  await page.getByLabel('Brand color', { exact: true }).fill('#9ad0c2');
  await expect(page.getByText('Too low')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await expect(page.getByText(/^Names and titles in this color are hard to read/)).toBeVisible();
  await expect(page.getByText(/^This color is too close to the brand color\./)).toBeVisible();

  // Back to the Figma pair, then a warmer accent that still keeps 4.5:1 with it
  await page.getByRole('button', { name: 'Use the default colors' }).click();
  await expect(page.getByLabel('Brand color', { exact: true })).toHaveValue('#005859');
  await expect(page.getByText('Too low')).toHaveCount(0);
  await page.getByLabel('Accent color', { exact: true }).fill('#FFD166');
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await toastShown(page, 'Logo and colors saved');

  // The colors share the settings row's version: Shop settings saves after it without a conflict
  await openFromNav(page, 'Shop settings');
  await page.getByLabel('Hotline').fill('09612-345679');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Shop settings saved');
  await openFromNav(page, 'Shop appearance');
  await expect(page.getByLabel('Accent color', { exact: true })).toHaveValue('#ffd166');
});

test('changes the hero, refuses words that would be hard to read, and deletes it', async ({
  page,
}) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await page.getByRole('link', { name: 'Edit hero banner' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit the hero banner' })).toBeVisible();
  await expectNoSideScroll(page);
  await expect(page.getByText('Goes to /c/polo-shirts')).toBeVisible();

  // The button's words the color of the button: the contrast line and the save both say so
  await page.getByLabel('Button’s words', { exact: true }).fill('#e7d1b2');
  await expect(page.getByText('Too low')).toHaveCount(1);
  await page.getByLabel('Headline', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/^The button’s words are hard to read on it\./)).toBeVisible();
  await expect(page.getByText('Fill in this field.')).toBeVisible();

  await page.getByLabel('Button’s words', { exact: true }).fill('#8b471f');
  await page.getByLabel('Headline', { exact: true }).fill('Winter polo shirts, 20% off');
  await page.getByLabel('Links to').selectOption({ label: 'All products' });
  await expect(page.getByText('Goes to /c/all')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Hero banner saved');

  await page.getByRole('link', { name: 'Shop appearance' }).first().click();
  await expect(page.getByText(/^Winter polo shirts, 20% off\s*Goes to \/c\/all$/)).toBeVisible();

  await page.getByRole('link', { name: 'Edit hero banner' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete hero banner' }).click();
  await page
    .getByRole('dialog', { name: 'Delete the hero banner?' })
    .getByRole('button', { name: 'Delete hero banner' })
    .click();
  await toastShown(page, 'Hero banner deleted');
  await expect(page.getByRole('heading', { level: 1, name: 'Shop appearance' })).toBeVisible();
  await expect(
    page.getByText('No hero banner. The home page starts with its products.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add hero banner' })).toBeVisible();
});

test('adds a picture banner at the end, moves it up and deletes a collection', async ({ page }) => {
  // Two pictures the pretend job prepares
  test.slow();
  await start(page);
  await openFromNav(page, 'Shop appearance');
  const rows = homeRows(page);
  await expect(rows).toHaveText([
    /^Hot & Trending Right Now/,
    /^Picture banner: Winter sale/,
    /^For the kids/,
    /^Coming soon/,
  ]);
  // The row with only the draft: the shop hides it, and the card says why
  await expect(rows.nth(3)).toContainText('None in the shop now, so the row is hidden');

  await page.getByRole('button', { name: 'Add picture banner' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a picture banner' });
  // Nothing uploaded: both boxes ask for a picture
  await dialog.getByRole('button', { name: 'Add banner' }).click();
  await expect(dialog.getByText('Upload a picture.')).toHaveCount(2);

  for (const [name, width, height, alt] of [
    ['Picture for computers', 1280, 280, 'Pohela Boishakh sale, 25% off panjabi'],
    ['Picture for phones', 540, 210, 'Pohela Boishakh sale, 25% off panjabi'],
  ] as const) {
    const box = dialog.getByRole('group', { name });
    await box.locator('input[type="file"]').setInputFiles({
      name: 'boishakh.png',
      mimeType: 'image/png',
      buffer: png(width, height),
    });
    // Uploaded, then prepared: the alt box stays, the status line goes
    await expect(box.getByRole('button', { name: 'Replace picture' })).toBeVisible({
      timeout: 10_000,
    });
    await box.getByLabel('What the picture shows').fill(alt);
  }
  await dialog.getByLabel('Links to').selectOption({ label: 'Products on offer' });
  await expect(dialog.getByText('Goes to /c/all?offer=1')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add banner' }).click();
  await toastShown(page, 'Picture banner added at the end of the home page');
  await expect(page.getByText('5 of 12 blocks')).toBeVisible();
  await expect(rows.last()).toContainText('Picture banner: Pohela Boishakh sale');

  await page
    .getByRole('button', { name: 'Move Picture banner: Pohela Boishakh sale, 25% off panjabi up' })
    .click();
  await expect(rows).toHaveText([
    /^Hot & Trending Right Now/,
    /^Picture banner: Winter sale/,
    /^For the kids/,
    /^Picture banner: Pohela Boishakh sale/,
    /^Coming soon/,
  ]);
  // The first block cannot go higher
  await expect(
    page.getByRole('button', { name: 'Move Hot & Trending Right Now up' }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Actions for Coming soon' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Coming soon?' })
    .getByRole('button', { name: 'Delete collection' })
    .click();
  await toastShown(page, 'Coming soon deleted');
  await expect(page.getByText('4 of 12 blocks')).toBeVisible();
  await expect(rows.last()).toContainText('Picture banner: Pohela Boishakh sale');
  await expectNoSideScroll(page);
});

test('makes a collection from the catalog, in the order picked', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await page.getByRole('link', { name: 'Add collection' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New collection' })).toBeVisible();
  await expectNoSideScroll(page);

  // Empty: a title and a product are both needed
  await page.getByRole('button', { name: 'Add collection' }).click();
  await expect(page.getByText('Fill in this field.')).toBeVisible();
  await expect(page.getByText('Add at least one product to the collection.')).toBeVisible();

  await page.getByRole('textbox', { name: 'Title' }).fill('Eid picks');
  await page.getByLabel('Show a flame after the title').check();
  for (const [search, option] of [
    ['white', /^Pique polo shirt · White · M/],
    ['crew', /^Basic crew-neck T-shirt/],
  ] as const) {
    await page.getByRole('button', { name: 'Product to add' }).click();
    await page.getByRole('combobox', { name: 'Search the catalog' }).fill(search);
    await page.getByRole('option', { name: option }).click();
  }
  await expect(page.getByText('2 of 24')).toBeVisible();
  await expect(
    page.getByText('Drafts stay here and show in the row once they are in the shop.'),
  ).toBeVisible();
  // The T-shirt first: the row shows them in this order
  await page.getByRole('button', { name: 'Move Basic crew-neck T-shirt up' }).click();
  await page.getByRole('button', { name: 'Add collection' }).click();
  await toastShown(page, 'Eid picks added at the end of the home page');

  await page.getByRole('link', { name: 'Shop appearance' }).first().click();
  const last = homeRows(page).last();
  await expect(last).toContainText('Eid picks');
  // One of the two is a draft
  await expect(last).toContainText('1 of 2 in the shop');
  await last.getByRole('link', { name: 'Eid picks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eid picks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Basic crew-neck T-shirt' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Move Basic crew-neck T-shirt up' }),
  ).toBeDisabled();
});

test('writes a text page into the footer and deletes another', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop pages');
  await expectNoSideScroll(page);
  // A table row on a computer, a card on a phone
  const row = (name: string) => listItem(page, new RegExp(`^${name}`));
  await expect(row('Privacy Policy')).toContainText('Not written');
  await expect(row('Terms & Condition')).toContainText('2 sections');

  await row('Privacy Policy').getByRole('link', { name: 'Write' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  await expect(page.getByText(/^This page is not written yet\./)).toBeVisible();
  await page.getByRole('button', { name: 'Add section' }).click();
  const section = page.getByRole('group', { name: 'Section 1' });
  await section.getByLabel('Heading').fill('What we keep');
  await section
    .getByLabel('Text')
    .fill('Your name, phone and address, **only** to deliver the order.');
  await section.getByRole('button', { name: 'Preview' }).click();
  // The shop's own HTML: the stars became bold
  await expect(section.locator('strong')).toHaveText('only');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Privacy Policy is in the shop');
  await expect(page.getByText(/^This page is not written yet\./)).toHaveCount(0);

  await page.getByRole('link', { name: 'Shop pages' }).first().click();
  await expect(row('Privacy Policy')).toContainText('In the footer');
  await expect(row('Privacy Policy')).toContainText('1 section');

  await row('About Us').getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await page
    .getByRole('dialog', { name: 'Delete About Us?' })
    .getByRole('button', { name: 'Delete page' })
    .click();
  await toastShown(page, 'About Us deleted');
  await expect(row('About Us')).toContainText('Not written');
});

test('asks a workspace with no shop to set it up first', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');
  await openFromNav(page, 'Shop appearance');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await openFromNav(page, 'Shop pages');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await page.getByRole('button', { name: 'Go to shop settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop settings' })).toBeVisible();
});

test('hides Shop appearance and Shop pages from a role without the permission', async ({
  page,
}) => {
  await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
  await start(page);
  await pinAnswered(page);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Shop appearance' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Shop pages' })).toHaveCount(0);
});
