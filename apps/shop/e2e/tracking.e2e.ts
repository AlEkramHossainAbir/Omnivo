import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll, newVisitor } from './helpers.js';

// Step 26e: the tracking link (/t/<token>) and the /track form. The orders are the mock's three
// demo orders, whose links never change (src/data/mock/demo-orders.ts, decision 18)
const DELIVERED = { orderNo: 'W-000121', phone: '01711284519', token: 'MGhXyBcrs_PytWRCRPw-6w' };
const ON_HOLD = { orderNo: 'W-000123', phone: '01786120356', token: 'C2etI9zQb8E5ZugpwzVWyA' };

test.describe('a tracking link', () => {
  test('shows the order, then its parcels newest first, and names no one', async ({ page }) => {
    const response = await page.goto(`/t/${DELIVERED.token}`);
    expect(response?.status()).toBe(200);
    // The token is in the address (decision 24)
    expect(response?.headers()).toMatchObject({
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
    });
    await expect(page).toHaveTitle(`Order ${DELIVERED.orderNo} | Omnivo`);

    const main = page.getByRole('main');
    await expect(main).toContainText(DELIVERED.orderNo);
    await expect(main).toContainText('Paid with Mobile Banking.');
    // The order's road reads top to bottom, oldest first; a parcel's events newest first
    // (decision 23), and the parcel that delivered comes before the cancelled booking
    const timeline = page.getByRole('list', { name: 'Order status' }).getByRole('listitem');
    await expect(timeline.first()).toContainText('Order placed');
    await expect(timeline.last()).toContainText('Delivered');
    const parcel = page.getByRole('region', { name: 'Parcel', exact: true });
    await expect(parcel).toContainText('Pathao · DH0811259QKP7');
    await expect(parcel.getByRole('listitem').first()).toContainText('Delivered');
    await expect(parcel.getByRole('listitem').last()).toContainText('Booked with the courier');
    const earlier = page.getByRole('region', { name: 'Earlier parcel' });
    await expect(earlier).toContainText('RedX · RX2611080317');
    await expect(earlier.getByRole('listitem').first()).toContainText('Cancelled by merchant');

    // A link gets forwarded (decision 12): the page has the order's phone and the buyer's name
    // nowhere, in either way they are written
    await expect(main).not.toContainText('01711');
    await expect(main).not.toContainText('Nusrat');
    await expectNoSideScroll(page);
  });

  test('says what the cash is for and links to the courier without the address', async ({
    page,
  }) => {
    await page.goto(`/t/${ON_HOLD.token}`);
    const main = page.getByRole('main');
    await expect(main).toContainText('Keep ৳578 ready in cash for the rider.');
    const parcel = page.getByRole('region', { name: 'Parcel', exact: true });
    // The courier's own note, as it came (decision 11)
    await expect(parcel.getByRole('listitem').first()).toContainText(
      'Could not deliver: they will try again',
    );
    await expect(parcel.getByRole('listitem').first()).toContainText('Customer not reachable');
    const courier = page.getByRole('link', { name: 'See it on the Steadfast site' });
    await expect(courier).toHaveAttribute('href', 'https://steadfast.com.bd/t/SFR2611120042');
    await expect(courier).toHaveAttribute('rel', /\bnoreferrer\b/);
  });

  test('a broken link says so with status 404 and leads to the form', async ({ page }) => {
    // Cut short (the wrong shape, answered before the source) and one character changed (the
    // right shape, but no order has it): the same page for both (decision 16)
    for (const token of [DELIVERED.token.slice(0, -1), `${DELIVERED.token.slice(0, -1)}x`]) {
      const response = await page.goto(`/t/${token}`);
      expect(response?.status()).toBe(404);
      // Not "404 OK": the page sets the status text as well (26e.6)
      expect(response?.statusText()).toBe('Not Found');
      await expect(
        page.getByRole('heading', { level: 1, name: 'This tracking link does not work' }),
      ).toBeVisible();
    }
    await page.getByRole('link', { name: 'Track with the number' }).click();
    await expect(page).toHaveURL('/track');
  });
});

test.describe('the /track form', () => {
  // Each test is its own visitor, so the limit test's misses stop no one else (helpers.ts)
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders(newVisitor());
  });

  async function track(page: Page, phone: string, orderNo: string): Promise<number | undefined> {
    await page.getByRole('textbox', { name: 'Mobile Number' }).fill(phone);
    await page.getByRole('textbox', { name: 'Order Number' }).fill(orderNo);
    // The form POSTs to /track and the page draws the answer: its status tells "not found" from
    // "too many" for the limit test
    const answer = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/track'),
    );
    await page.getByRole('button', { name: 'Track Order' }).click();
    const status = (await answer).status();
    await page.waitForLoadState();
    return status;
  }

  test('finds an order however its number is typed, and keeps the phone out of the address', async ({
    page,
  }) => {
    await page.goto('/track');
    // A space in the phone, lower case and no dash in the number (decision 10)
    expect(await track(page, '01786 120356', 'w 000123')).toBe(200);
    const main = page.getByRole('main');
    await expect(main).toContainText(ON_HOLD.orderNo);
    await expect(main).toContainText('Keep ৳578 ready in cash for the rider.');
    await expect(page).toHaveURL('/track');
    await expect(page).toHaveTitle(`Order ${ON_HOLD.orderNo} | Omnivo`);
    await expectNoSideScroll(page);

    await page.getByRole('link', { name: 'Track another order' }).click();
    await expect(page.getByRole('textbox', { name: 'Mobile Number' })).toHaveValue('');
  });

  test('says what to fix in each box and keeps what was typed', async ({ page }) => {
    await page.goto('/track');
    expect(await track(page, '0178', 'SO-1')).toBe(200);
    const phone = page.getByRole('textbox', { name: 'Mobile Number' });
    const orderNo = page.getByRole('textbox', { name: 'Order Number' });
    await expect(phone).toHaveAccessibleDescription(
      'Type a Bangladeshi mobile number, like 01786 120356.',
    );
    await expect(orderNo).toHaveAccessibleDescription(
      'Type the order number from the SMS, like W-000123.',
    );
    // The first box to fix has the focus, and nothing typed is lost
    await expect(phone).toBeFocused();
    await expect(phone).toHaveValue('0178');
    await expect(orderNo).toHaveValue('SO-1');
  });

  test('stops a visitor after ten misses, and only that visitor', async ({ page, context }) => {
    await page.goto('/track');
    for (let miss = 1; miss <= 10; miss += 1) {
      expect(await track(page, ON_HOLD.phone, 'W-000999')).toBe(200);
      await expect(page.getByRole('alert')).toHaveText(
        'No order has this number and mobile number. Check both, then try again.',
      );
    }
    // Now even the right pair waits: a guesser cannot tell a hit from a miss any more
    expect(await track(page, ON_HOLD.phone, ON_HOLD.orderNo)).toBe(429);
    await expect(page.getByRole('alert')).toHaveText(
      'Too many tries. Wait 15 minutes, then try again.',
    );
    // The refusal took the focus, so a screen reader reads it first
    await expect(page.getByRole('alert')).toBeFocused();

    // Someone else on the same server is not stopped
    await context.setExtraHTTPHeaders(newVisitor());
    expect(await track(page, ON_HOLD.phone, ON_HOLD.orderNo)).toBe(200);
    await expect(page.getByRole('main')).toContainText('Keep ৳578 ready in cash for the rider.');
  });

  test('offers the test shop’s demo orders and their links', async ({ page }) => {
    await page.goto('/track');
    await expect(
      page.getByText('Test shop: no SMS is sent. Try one of these orders.'),
    ).toBeVisible();
    await page.getByRole('link', { name: `Tracking link of ${DELIVERED.orderNo}` }).click();
    await expect(page).toHaveURL(`/t/${DELIVERED.token}`);
    await expect(page.getByRole('main')).toContainText('Paid with Mobile Banking.');
  });
});
