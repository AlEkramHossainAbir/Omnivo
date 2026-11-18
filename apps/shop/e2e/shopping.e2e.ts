import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll, newVisitor } from './helpers.js';

// Steps 26b–26c, walked once in a real browser: a product into the cart, the cart drawer, the
// checkout, the phone code, "Order Confirmed" and the order page. Step 26e adds the end: the order
// just placed can be tracked with the /track form. The unit tests check each piece (the quote,
// the order book, the cookies); this checks that the pages hand over to each other

const SHAMPOO = {
  slug: 'himalaya-anti-dandruff-shampoo-180ml',
  name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
};

// The checkout's form is inert until its island runs (26e.4's fix in CheckoutForm.tsx), so a
// shopper's keys do nothing before then. Playwright's fill() is not a key press: it writes the
// value into the box even while the form is inert, and react-hook-form then wipes it as it starts.
// So the tests wait for the island first, as a shopper's keys would
async function waitForCheckout(page: Page): Promise<void> {
  await expect(page.getByRole('main').locator('form')).not.toHaveAttribute('inert');
}

async function fillDetails(page: Page): Promise<void> {
  await waitForCheckout(page);
  await page.getByRole('textbox', { name: 'Full Name' }).fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await page.getByRole('textbox', { name: 'Delivery Address' }).fill('House 12, Road 5, Dhanmondi');
  await page.getByRole('radio', { name: 'Inside Dhaka — ৳80' }).check();
  // The box is sr-only under its icon (CLAUDE.md → Checkout lines), so a click on it is a click on
  // the icon, which Playwright refuses. Space is how a keyboard user ticks it
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
}

test('a Cash on Delivery order, from the product page to tracking it', async ({
  page,
  context,
}) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByRole('button', { name: 'Cart, 1 item' }).click();

  // The drawer: the server's prices (26b), a stepper that changes the line at once
  const drawer = page.getByRole('dialog', { name: 'Your Cart' });
  await expect(drawer).toContainText('Subtotal৳229');
  await drawer.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(drawer.getByRole('textbox', { name: `How many ${SHAMPOO.name}` })).toHaveValue('2');
  await expect(drawer).toContainText('Subtotal৳458');
  await drawer.getByRole('link', { name: 'Checkout' }).click();

  await expect(page).toHaveURL('/checkout');
  await fillDetails(page);
  const main = page.getByRole('main');
  await expect(main).toContainText('Delivery Charge৳80');
  await expect(main).toContainText('Total৳538');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Confirm Order' }).click();

  // Cash on Delivery asks for the phone's code (26c). The test shop prints it
  await expect(page).toHaveURL('/checkout/verify');
  await expect(main).toContainText('We sent a 6-digit code to +880 17•• ••• 356');
  const testLine = await page
    .getByText(/^Test shop: no SMS is sent\. The code is \d{6}\.$/)
    .textContent();
  const code = /\d{6}/.exec(testLine ?? '')?.[0] ?? '';
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Confirm Order' }).click();

  const confirmed = page.getByRole('dialog', { name: 'Order Confirmed' });
  await expect(confirmed).toContainText('We’ll send updates by SMS to 01786 120356.');
  // The safe way on has the focus, and the cart is empty already
  await expect(confirmed.getByRole('link', { name: 'Continue shopping' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Cart, empty' })).toBeAttached();

  const details = confirmed.getByRole('link', { name: 'View Order Details' });
  const orderNo = /W-\d{6}$/.exec((await details.getAttribute('href')) ?? '')?.[0] ?? '';
  expect(orderNo).not.toBe('');
  await details.click();
  await expect(page).toHaveURL(`/order/${orderNo}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Order Details' })).toBeVisible();
  await expect(main).toContainText(orderNo);
  await expect(main).toContainText('2 × ৳229');

  // The mock sends no SMS and gives a new order no link (decision 18), so the form finds it
  await context.setExtraHTTPHeaders(newVisitor());
  await page.goto('/track');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await page.getByRole('textbox', { name: 'Order Number' }).fill(orderNo);
  await page.getByRole('button', { name: 'Track Order' }).click();
  await expect(main).toContainText(orderNo);
  await expect(main).toContainText('Keep ৳538 ready in cash for the rider.');
  await expect(main).toContainText(
    'The shop has not handed the parcel to a courier yet. Its way shows here once it has.',
  );
});

test('the checkout waits for the minimum order and for the terms', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await fillDetails(page);
  const confirm = page.getByRole('button', { name: 'Confirm Order' });
  // ৳229 is under the mock shop's ৳300 (26c). The button is also disabled while a quote loads, so
  // the check waits for the quote with the delivery charge first: else it would pass during that
  // load even if the minimum did not count
  await expect(page.getByRole('main')).toContainText('Total৳309');
  await expect(page.getByText('Orders start at ৳300. Add ৳71 more to order.')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(confirm).toBeEnabled();
  // fillDetails() ticked the terms; without them the button waits again
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
  await expect(confirm).toBeDisabled();
});

// Step 27a: the API's own answers, which the mock never gives in a test's time (an order limit, a
// code past its 10 minutes, a fourth code). The browser gets them as the API's source would hand
// them over: the shop's routes answer with the same problem JSON (server/orders.ts)
function problemBody(status: number, code: string, params?: Record<string, number>): string {
  return JSON.stringify({ title: 'Refused', status, detail: code, code, params });
}

test('the checkout says how long to wait after too many orders', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await fillDetails(page);
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/problem+json',
      body: problemBody(429, 'shop_order_limit', { minutes: 12 }),
    }),
  );
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(
    page.getByText('Too many orders from here. Wait 12 minutes, then try again.'),
  ).toBeVisible();
  await expect(page).toHaveURL('/checkout');
});

test('the code page says when a code expired and when no more codes can come', async ({ page }) => {
  // The page's own clock, so "Resend code" opens without waiting 45 real seconds
  await page.clock.install();
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page).toHaveURL('/checkout/verify');

  // A code past its 10 minutes: no try spent, the digits go and the box keeps the focus
  await page.route('**/api/orders/verify', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/problem+json',
      body: problemBody(422, 'shop_code_expired'),
    }),
  );
  const box = page.getByRole('textbox', { name: '6-digit code' });
  await box.fill('123456');
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page.getByText('This code has expired. Ask for a new code.')).toBeVisible();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();

  // The order has had its three codes: "Resend code" goes, the box stays, and the way back shows
  await page.route('**/api/orders/resend', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/problem+json',
      body: problemBody(422, 'shop_code_sends_used'),
    }),
  );
  await page.clock.fastForward('00:46');
  const resend = page.getByRole('button', { name: 'Resend code' });
  await expect(resend).not.toHaveAttribute('aria-disabled', 'true');
  await resend.click();
  await expect(
    page.getByText('No more codes can be sent for this order. Place the order again.'),
  ).toBeVisible();
  await expect(resend).toBeHidden();
  await expect(box).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to checkout' })).toBeVisible();
});

test('Mobile Banking needs no phone code in the test shop', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await fillDetails(page);
  await page.getByText('Mobile Banking', { exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  // Straight to the dialog, over the checkout page: the mock asks no code for Mobile Banking
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();
  await expect(page).toHaveURL('/checkout');
});

test('nothing typed into the checkout before its script runs is lost', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  // A slow phone: the shop's scripts arrive only when the test lets them. The server's HTML is on
  // screen meanwhile, with every box drawn
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/_astro/*.js', async (route) => {
    await held;
    await route.continue();
  });
  // 'commit': module scripts hold DOMContentLoaded back, and they are the ones being held
  await page.goto('/checkout', { waitUntil: 'commit' });
  const box = page.locator('input[name="name"]');
  await expect(box).toBeAttached();
  // The form is inert until the island runs (26e.4's fix in CheckoutForm.tsx): a tap does not
  // focus the box and a key types nothing. Before the fix, this name was typed, then wiped
  await box.click({ force: true });
  await page.keyboard.type('Nusrat');
  await expect(box).toHaveValue('');

  release();
  // Once the island runs, what the shopper types stays
  await waitForCheckout(page);
  const name = page.getByRole('textbox', { name: 'Full Name' });
  await name.fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await expect(name).toHaveValue('Nusrat Jahan');
});
