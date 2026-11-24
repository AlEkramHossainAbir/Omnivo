import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 28b: the courier's COD money on the mock (mocks/storefront-order-data.ts → settleCod).
// Rahman Fashion's two Steadfast accounts pay the riders' cash into 1191 Cash with Steadfast, and
// their charges go to 5420 Courier charges; Pathao counter has no COD account yet. W-000003 is on
// its way to Chattogram with Steadfast Dhaka (consignment 148920331), Cash on Delivery. The
// courier's news are sent to the mock's Steadfast webhook the way Steadfast sends them, with the
// token the "New webhook token" dialog shows once. Moving between pages goes through the menu: a
// reload starts the mock again.
test.use({ shopOrders: true });

const W3_CONSIGNMENT = '148920331';

interface Hook {
  url: string;
  token: string;
}

// An account's row (a card on a phone), as in storefront-couriers.e2e.ts
function accountRow(page: Page, name: string) {
  const start = new RegExp(`^${name}`);
  return page.getByRole('row', { name: start }).or(page.getByRole('button', { name: start }));
}

async function rowAction(page: Page, account: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${account}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

// Steadfast Dhaka's webhook address and a new token, read from the dialog that shows them once
async function steadfastHook(page: Page): Promise<Hook> {
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Dhaka', 'New webhook token');
  await page
    .getByRole('dialog', { name: 'Make a new webhook token for Steadfast Dhaka?' })
    .getByRole('button', { name: 'Make new token' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Paste the webhook into Steadfast' });
  const url = await dialog.getByLabel('Callback URL').inputValue();
  const token = await dialog.getByLabel('Auth token (Bearer)').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return { url, token };
}

// One delivery_status notice, as Steadfast posts it (its documented body), from the page so the
// mock's worker answers it. Returns the HTTP status
async function courierSays(
  page: Page,
  hook: Hook,
  notice: Record<string, string | number>,
  token: string = hook.token,
): Promise<number> {
  return page.evaluate(
    async ({ url, token: bearer, body }) => {
      const answer = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return answer.status;
    },
    {
      url: hook.url,
      token,
      body: {
        notification_type: 'delivery_status',
        consignment_id: Number(W3_CONSIGNMENT),
        invoice: 'W-000003',
        updated_at: '2026-11-24 15:40:00',
        ...notice,
      },
    },
  );
}

async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openShipped(page: Page, number: string): Promise<void> {
  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

function parcelCard(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: /^Parcel/ }) })
    .last();
}

// The page header's buttons: the primary one is the last (approved with the mockup)
function headerButtons(page: Page) {
  return page.locator('header').getByRole('button', {
    name: /^(Record what came back|Receive the return|Mark delivered)$/,
  });
}

test('a courier account keeps where the rider’s cash goes, and shows what it holds', async ({
  page,
}) => {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('Nothing yet');
  await expect(accountRow(page, 'Pathao counter')).toContainText('No COD account');
  await expectNoSideScroll(page);

  await rowAction(page, 'Pathao counter', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Pathao counter' });
  const cod = edit.getByLabel('COD account');
  await expect(cod.locator('option:checked')).toHaveText('None: record the rider’s cash by hand');
  // Only accounts that hold money; the charges only expense accounts
  await expect(cod.locator('option', { hasText: 'Courier charges' })).toHaveCount(0);
  await cod.selectOption({ label: '1192 · Cash with Pathao' });
  await edit
    .getByLabel('Courier charges account')
    .selectOption({ label: '5420 · Courier charges' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');
  await expect(accountRow(page, 'Pathao counter')).toContainText('Nothing yet');

  // Saved: the form opens with them, and says a change counts for the next receipts only
  await rowAction(page, 'Pathao counter', 'Edit');
  await expect(edit.getByLabel('COD account').locator('option:checked')).toHaveText(
    '1192 · Cash with Pathao',
  );
  await expect(edit.getByText(/^A change counts for the next receipts only\./)).toBeVisible();
});

test('Mark delivered asks what the rider collected and posts the COD receipt', async ({ page }) => {
  await page.goto('/');
  await openShipped(page, 'W-000003');
  // A parcel on its way: Mark delivered is the primary, the other two are there too
  await expect(headerButtons(page)).toHaveText([
    'Record what came back',
    'Receive the return',
    'Mark delivered',
  ]);
  await expect(parcelCard(page).getByText('Courier’s charge')).toBeVisible();

  await page.getByRole('button', { name: 'Mark delivered' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark W-000003 delivered?' });
  await expect(
    dialog.getByText(/and a money receipt into Steadfast Dhaka’s COD account/),
  ).toBeVisible();
  const box = dialog.getByLabel('What the rider collected');
  // It starts with what the rider was to collect (the courier has not said), grouped until focused
  await expect(box).toHaveValue(/^[\d,]+\.00$/);
  await box.fill('99999');
  await dialog.getByRole('button', { name: 'Mark delivered' }).click();
  await expect(
    dialog.getByText(/^The rider collects at most ৳[\d,]+ for this parcel\./),
  ).toBeVisible();

  await box.fill('500');
  await dialog.getByRole('button', { name: 'Mark delivered' }).click();
  await toastShown(page, /^W-000003 delivered\. Invoice .+ and money receipt .+ posted\.$/);
  await expect(
    page.getByText(
      /^The rider’s cash came in on money receipt .+, into Steadfast Dhaka’s COD account\./,
    ),
  ).toBeVisible();
  const parcel = parcelCard(page);
  await expect(parcel.getByText('৳500', { exact: true })).toBeVisible();
  await expect(parcel.getByText('Delivered').first()).toBeVisible();
  const receipt = parcel.getByRole('link', { name: /^MR-/ });
  await expect(receipt).toBeVisible();
  await expectNoSideScroll(page);

  // The courier holds it until its payout (step 28c)
  await openFromNav(page, 'Shop couriers');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('৳500 · 1 parcel');
});

test('the courier says part came back; Record what came back bills the rest', async ({ page }) => {
  await page.goto('/');
  const hook = await steadfastHook(page);
  // A wrong token is refused, and changes nothing
  expect(await courierSays(page, hook, { status: 'partial_delivered' }, 'wrongtoken')).toBe(401);
  expect(
    await courierSays(page, hook, {
      status: 'partial_delivered',
      cod_amount: 300,
      delivery_charge: 130,
    }),
  ).toBe(200);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await expect(listItem(page, /W-000003/)).toContainText('Partly delivered');
  await listItem(page, /W-000003/).click();
  await expect(headerButtons(page).last()).toHaveText('Record what came back');
  await expect(page.getByText(/^Steadfast Dhaka delivered part of the parcel\./)).toBeVisible();

  await page.getByRole('button', { name: 'Record what came back' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record what came back of W-000003' });
  await expect(dialog.getByText('Steadfast Dhaka says the rider collected ৳300.')).toBeVisible();
  await expect(dialog.getByLabel('What the rider collected')).toHaveValue('300.00');
  // Nothing ticked is Mark delivered
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await expect(dialog.getByText(/^Tick what came back\./)).toBeVisible();

  await dialog.getByRole('checkbox', { name: /^Came back: .*T-shirt/i }).check();
  await dialog.getByLabel('Why it came back').fill('The shopper kept one T-shirt');
  // More than the whole parcel's COD amount is refused, with the amount in the words
  await dialog.getByLabel('What the rider collected').fill('99999');
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await expect(
    dialog.getByText(/^The rider collects at most ৳[\d,]+ for this parcel\./),
  ).toBeVisible();
  await dialog.getByLabel('What the rider collected').fill('300');
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await toastShown(
    page,
    /^W-000003 partly delivered\. Sales return .+, invoice .+ and money receipt .+ posted\.$/,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'W-000003' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^SR-/ })).toBeVisible();
  await expect(parcelCard(page).getByText('৳300', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record what came back' })).toHaveCount(0);
});

test('the courier is bringing it back; Receive the return puts it in Returned', async ({
  page,
}) => {
  await page.goto('/');
  const hook = await steadfastHook(page);
  // Cancelled after the rider picked it up: the parcel is coming back
  expect(await courierSays(page, hook, { status: 'cancelled' })).toBe(200);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await expect(listItem(page, /W-000003/)).toContainText('Coming back');
  await listItem(page, /W-000003/).click();
  await expect(headerButtons(page).last()).toHaveText('Receive the return');
  await expect(page.getByText(/^Steadfast Dhaka is bringing the parcel back\./)).toBeVisible();

  await page.getByRole('button', { name: 'Receive the return' }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive W-000003 back?' });
  await expect(
    dialog.getByText('Do this once the parcel is on your shelf, not on the courier’s word alone.'),
  ).toBeVisible();
  await dialog.getByLabel('Why it came back').fill('The shopper did not answer the phone');
  await dialog.getByRole('button', { name: 'Receive the return' }).click();
  await toastShown(
    page,
    /^W-000003 returned\. Sales return .+ posted\. The shopper gets an SMS\.$/,
  );
  await expect(parcelCard(page).getByText('Returned').first()).toBeVisible();
  await expect(headerButtons(page)).toHaveCount(0);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Returned');
  await expect(listItem(page, /W-000003/)).toBeVisible();
  await expectNoSideScroll(page);
});

test('a COD receipt the books refuse waits for Make the receipt, and the bell says so', async ({
  page,
}) => {
  await page.goto('/');
  // The COD account is archived for a moment. First, so Shop couriers reads the chart after it
  // (its list stays 30 seconds in the app's cache)
  await openFromNav(page, 'Chart of accounts');
  await page
    .getByRole('list', { name: 'Chart of accounts' })
    .getByRole('button', { name: 'Cash with Steadfast', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Edit 1191' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const hook = await steadfastHook(page);

  // Steadfast delivers it with nobody watching: the order is Delivered, its receipt is not
  expect(await courierSays(page, hook, { status: 'delivered', cod_amount: 900 })).toBe(200);
  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Delivered');
  await expect(listItem(page, /W-000003/)).toContainText('Needs attention');
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await expect(
    page.getByText(
      'W-000003 was delivered by Steadfast Dhaka, but its COD receipt could not be made. Open the order to make it.',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await listItem(page, /W-000003/).click();
  await expect(page.getByText(/^The COD receipt could not be made\./).first()).toBeVisible();

  // Point the courier at another account; the saved one is archived, so the form says so
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Dhaka', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Dhaka' });
  await expect(
    edit.getByText('Pick an active account that holds money, like Cash with Steadfast, or none.'),
  ).toBeVisible();
  await edit.getByLabel('COD account').selectOption({ label: '1192 · Cash with Pathao' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Delivered');
  await listItem(page, /W-000003/).click();
  await page.getByRole('button', { name: 'Make the receipt' }).click();
  await toastShown(page, /^Money receipt .+ made$/);
  await expect(page.getByText(/^The COD receipt could not be made\./)).toHaveCount(0);
  await expect(page.getByText('Needs attention')).toHaveCount(0);
  // The courier's 900 was cut to what the rider was to collect
  await expect(parcelCard(page).getByRole('link', { name: /^MR-/ })).toBeVisible();
});
