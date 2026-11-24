import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 27d: paying online in the test shop, whose gateway is the fake one (decision 8): its page is
// the shop's own /checkout/fake-gateway, and its buttons post to the return path as SSLCommerz
// posts. The unit tests check the order book and the routes; this checks that the checkout, the
// gateway's page, /checkout/paid, the verify page and the dialog hand over to each other, and that
// a post from another site reaches the return path with the shopper's order (decision 2).

const SHAMPOO = {
  slug: 'himalaya-anti-dandruff-shampoo-180ml',
  name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
};

// Two shampoos (৳229 each, over the shop's ৳300 minimum) and the checkout filled in for Pay online, as shopping.e2e.ts fills it. Its own
// phone per test: nothing here counts phones, but it keeps each test's orders apart in the book
async function checkoutOnline(page: Page, phone: string): Promise<void> {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(page.getByRole('main').locator('form')).not.toHaveAttribute('inert');
  await page.getByRole('textbox', { name: 'Full Name' }).fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill(phone);
  await page.getByRole('textbox', { name: 'Delivery Address' }).fill('House 12, Road 5, Dhanmondi');
  await page.getByRole('radio', { name: 'Inside Dhaka — ৳80' }).check();
  await page.getByText('Pay online', { exact: true }).click();
  // The hint says where the money is taken, before the button takes the shopper there
  await expect(page.getByText('You pay on SSLCommerz’s page with bKash')).toBeVisible();
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
  await expect(page.getByRole('main')).toContainText('Total৳538');
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?tranId=[A-Z0-9]{20}&amount=538/);
}

test('Pay online: the payment page, then "Order Confirmed" and the order', async ({ page }) => {
  await checkoutOnline(page, '01786120356');
  await expect(page.getByRole('heading', { name: 'Test payment' })).toBeVisible();
  await expect(page.getByText('This is a test page, not SSLCommerz.')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Pay ৳538' }).click();

  // The return path's 303 lands here; the dialog opens over the page, and the cart is empty
  await expect(page).toHaveURL('/checkout/paid');
  const dialog = page.getByRole('dialog', { name: 'Order Confirmed' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('01786 120356');
  await expect(page.getByRole('button', { name: 'Cart, empty' })).toBeAttached();
  await expectNoSideScroll(page);
  await dialog.getByRole('link', { name: 'View Order Details' }).click();
  await expect(page).toHaveURL(/\/order\/W-\d{6}$/);
  await expect(page.getByRole('main')).toContainText('Paid online');

  // The order is done: /checkout/paid has nothing to show this browser any more
  await page.goto('/checkout/paid');
  await expect(page).toHaveURL('/checkout');
});

test('a refused payment, "Try again", then "Pay on delivery" with the phone code', async ({
  page,
}) => {
  await checkoutOnline(page, '01711284519');
  await page.getByRole('button', { name: 'Fail the payment' }).click();
  await expect(page).toHaveURL('/checkout/paid');
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'The payment did not go through' })).toBeVisible();
  await expect(main).toContainText('Your order for ৳538 is still here');
  await expect(main).toContainText('You can try 2 more times.');
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?/);
  await page.getByRole('button', { name: 'Cancel the payment' }).click();
  await expect(page.getByRole('heading', { name: 'The payment was cancelled' })).toBeVisible();
  await expect(main).toContainText('You can try 1 more time.');

  // Back from the third page without pressing anything: "not finished", and no tries left
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?/);
  await page.goBack();
  await page.goto('/checkout/paid');
  await expect(page.getByRole('heading', { name: 'The payment is not finished' })).toBeVisible();
  await expect(main).toContainText('You have used all three tries to pay online.');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Pay on delivery instead' }).click();
  await expect(page).toHaveURL('/checkout/verify');
  await page.getByRole('textbox', { name: '6-digit code' }).fill('123456');
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();
});

test('the gateway’s post from its own site reaches the order, and no other path takes one', async ({
  page,
  baseURL,
}) => {
  await checkoutOnline(page, '01911223344');
  // The fake page's own form, copied onto another site: what SSLCommerz's page does
  const form = page.locator('form');
  const tranId = await form.locator('input[name="tran_id"]').inputValue();
  const valId = await page.getByRole('button', { name: 'Pay ৳538' }).getAttribute('value');
  const gateway = 'http://gateway.test';
  await page.route(`${gateway}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Gateway</title>
        <form method="post" action="${String(baseURL)}/checkout/pay/return">
          <input name="tran_id" value="${tranId}"><input name="val_id" value="${String(valId)}">
          <input name="status" value="VALID"><button>Back to the shop</button>
        </form>
        <form method="post" action="${String(baseURL)}/track">
          <input name="phone" value="01911223344"><button>Post to the shop</button>
        </form>`,
    }),
  );
  await page.goto(`${gateway}/pay`);
  await page.getByRole('button', { name: 'Back to the shop' }).click();
  // The shop's SameSite=Lax cookie is not sent with this cross-site POST, so the return path
  // settles by the transaction id; the 303's GET does bring the cookie
  await expect(page).toHaveURL('/checkout/paid');
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();

  // Any other form from that site is refused, as Astro's own check refused it
  await page.goto(`${gateway}/pay`);
  const [response] = await Promise.all([
    page.waitForResponse(`${String(baseURL)}/track`),
    page.getByRole('button', { name: 'Post to the shop' }).click(),
  ]);
  expect(response.status()).toBe(403);
});

test('the fake gateway’s page needs a try’s address', async ({ page }) => {
  const response = await page.goto('/checkout/fake-gateway?tranId=abc&amount=1');
  expect(response?.status()).toBe(404);
});
