import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  pinAnswered,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 27c: Storefront → Shop coupons on the mock (mocks/storefront-coupon-data.ts). Rahman
// Fashion has the mockup's coupons: WELCOME10 (10% off, up to ৳200, once per mobile number, 37 of
// 500 used), FLAT50 (৳50 off from ৳500), WINTER15 (scheduled), DIABETIC-CARE, PUJA20 (ended by its
// last day), FIRST100 (ended by its 100 uses), and BOISHAKH25 and TEST5 archived. Every coupon but
// WINTER15 and TEST5 has had an order, so its code is locked. Karim Pharma has no shop and none.

// The nav item says "Shop coupons" (the phone's nav row has no group labels); the page's title is
// "Coupons", so openFromNav() (link name = heading) does not fit
async function openCoupons(page: Page): Promise<void> {
  await pinAnswered(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Shop coupons' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Coupons' })).toBeVisible();
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
  await openCoupons(page);
}

// The tabs are a segmented control ("Show"): its radios are hidden, their words are the labels.
// Inside the control: "Archived" is a status pill in the table too
async function showTab(page: Page, name: 'Current' | 'Archived'): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

// A coupon's row (a card on a phone), by the code it starts with. listItem(page, /WELCOME10/) would
// also find the row's menu button, "Actions for WELCOME10"
function coupon(page: Page, code: string) {
  const name = new RegExp(`^${code} `);
  return page.getByRole('row', { name }).or(page.getByRole('button', { name }));
}

// `exact`: on a phone the card is a button too, and its name has the menu button's in it
async function rowMenu(page: Page, code: string, item: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${code}`, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('lists the coupons, finds one by its code and adds one', async ({ page }) => {
  await start(page);
  await expectNoSideScroll(page);

  // The nav item sits right after Catalog (decision 29)
  const items = await page.getByRole('navigation').getByRole('link').allTextContents();
  const catalog = items.findIndex((text) => text.startsWith('Catalog'));
  expect(items[catalog + 1]).toBe('Shop coupons');

  // Newest first; each fact in the page's words
  await expect(coupon(page, 'WELCOME10')).toContainText('10% off, up to ৳200');
  await expect(coupon(page, 'WELCOME10')).toContainText('Once per mobile number');
  await expect(coupon(page, 'WELCOME10')).toContainText('37 of 500 used');
  await expect(coupon(page, 'FLAT50')).toContainText('From ৳500');
  await expect(coupon(page, 'WINTER15')).toContainText('Scheduled');
  await expect(coupon(page, 'PUJA20')).toContainText('Ended');
  await expect(coupon(page, 'FIRST100')).toContainText('100 of 100 used');
  await expect(page.getByText('BOISHAKH25')).toHaveCount(0);

  // Part of the code, in small letters too
  const search = page.getByRole('searchbox', { name: 'Search coupons' });
  await search.fill('wel');
  await expect(coupon(page, 'FLAT50')).toHaveCount(0);
  await expect(coupon(page, 'WELCOME10')).toBeVisible();
  await search.fill('EID');
  await expect(page.getByText('No coupon matches')).toBeVisible();
  await search.fill('');

  await page.getByRole('button', { name: 'Add coupon' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a coupon' });
  await expectNoSideScroll(page);
  await dialog.getByRole('textbox', { name: 'Code' }).fill('flat50');
  // Taka off: "Up to" goes away, the value box keeps its number (decision 36)
  await dialog.getByRole('textbox', { name: 'Percent off (1 to 99)' }).fill('25');
  await dialog.getByText('Taka off', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Up to (optional)' })).toHaveCount(0);
  // The money box shows its amount grouped, with 2 decimals, while it has no focus
  await expect(dialog.getByRole('textbox', { name: 'Amount off' })).toHaveValue('25.00');
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  // The code is the shop's own: the API's answer, under the box
  await expect(
    dialog.getByText('Another coupon has this code. Type a different one.'),
  ).toBeVisible();

  // A percent with a cap, from ৳1,000, two orders a number at most once each
  await dialog.getByRole('textbox', { name: 'Code' }).fill('eid25');
  await dialog.getByText('Percent off', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Up to (optional)' }).fill('500');
  await dialog.getByRole('textbox', { name: 'Minimum order (optional)' }).fill('1000');
  await dialog.getByRole('textbox', { name: 'Number of orders (optional)' }).fill('300');
  await dialog.getByRole('checkbox', { name: 'Once per mobile number' }).check();
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  await toastShown(page, 'EID25 added');
  await expect(coupon(page, 'EID25')).toContainText('25% off, up to ৳500');
  await expect(coupon(page, 'EID25')).toContainText('From ৳1,000');
  await expect(coupon(page, 'EID25')).toContainText('0 of 300 used');
  await expect(coupon(page, 'EID25')).toContainText('Active');
});

test('keeps a used code, archives a coupon and restores it', async ({ page }) => {
  await start(page);

  // An order has had WELCOME10: its code is shown, not a box. The rest may change
  await coupon(page, 'WELCOME10').click();
  const edit = page.getByRole('dialog', { name: 'Edit WELCOME10' });
  await expect(edit.getByText('An order has used this code, so it can’t change.')).toBeVisible();
  await expect(edit.getByRole('textbox', { name: 'Code' })).toHaveCount(0);
  await expectNoSideScroll(page);
  await edit.getByRole('textbox', { name: 'Number of orders (optional)' }).fill('600');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to WELCOME10 saved');
  await expect(coupon(page, 'WELCOME10')).toContainText('37 of 600 used');

  // No order has had WINTER15 yet: its code is still a box
  await coupon(page, 'WINTER15').click();
  await expect(
    page.getByRole('dialog', { name: 'Edit WINTER15' }).getByRole('textbox', { name: 'Code' }),
  ).toHaveValue('WINTER15');
  await page.keyboard.press('Escape');

  // The row menu by keyboard opens the menu only, never the row's form
  await page.getByRole('button', { name: 'Actions for PUJA20', exact: true }).press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Archive asks first and says what the shopper sees
  await rowMenu(page, 'FLAT50', 'Archive');
  const ask = page.getByRole('dialog', { name: 'Archive FLAT50?' });
  await expect(ask).toContainText('Orders that have it keep their discount.');
  await ask.getByRole('button', { name: 'Archive' }).click();
  await toastShown(page, 'FLAT50 archived');
  await expect(coupon(page, 'FLAT50')).toHaveCount(0);

  // The Archived tab: no row opens a form, the menu has Restore only (decision 35)
  await showTab(page, 'Archived');
  await expect(page.getByText('BOISHAKH25')).toBeVisible();
  await expect(page.getByText('TEST5')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for FLAT50', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Restore']);
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await toastShown(page, 'FLAT50 restored');
  await expect(page.getByText('FLAT50')).toHaveCount(0);
  await showTab(page, 'Current');
  await expect(coupon(page, 'FLAT50')).toContainText('Active');
});

test('works before the shop is set up', async ({ page }) => {
  await page.goto('/');
  await waitForCopy(page);
  await pinAnswered(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');
  await openCoupons(page);

  // No shop to view yet; a coupon can still be made and waits for the shop (decision 23)
  await expect(page.getByRole('link', { name: 'View shop' })).toHaveCount(0);
  await expect(page.getByText('No coupons yet')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Add coupon' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a coupon' });
  await dialog.getByRole('textbox', { name: 'Code' }).fill('WELCOME10');
  await dialog.getByRole('textbox', { name: 'Percent off (1 to 99)' }).fill('10');
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  await toastShown(page, 'WELCOME10 added');
  await expect(coupon(page, 'WELCOME10')).toContainText('0 used');
});
